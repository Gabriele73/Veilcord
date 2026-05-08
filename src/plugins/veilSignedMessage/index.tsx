/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { addMessagePreEditListener, addMessagePreSendListener, MessageEditListener, MessageSendListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher, MessageStore, showToast, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import { CanonicalAttachment, cryptoService, veilApiBase, VeilSignedBody, VeilZwc } from "@plugins/veilCrypto";
import { SignIcon } from "./SignIcon";

// veil v0.0.2

const BUTTON_ID = "veil-sign";

let lastEnabled = false;

interface Pending {
    /** Final Discord content (visible body + ZWC marker) — used to match the MESSAGE_CREATE event. */
    matchContent: string;
    /**
     * For text-only messages we sign in pre-send and ship the canonical
     * body + signature here. For messages with attachments we can't sign
     * yet because Discord may re-encode images (PNG → WebP) inside its
     * CloudUpload pipeline and `upload.item.file` is never mutated, so
     * any hash we compute pre-send won't match what the CDN serves. In
     * that case we leave these null and let `onMessageCreate` reach
     * across to the live `message.attachments[].url`, hash the served
     * bytes, build the canonical body, sign, and register.
     */
    signedBody: string | null;
    publicKey: string;
    signature: string | null;
    /** Plain text the user typed, with no ZWC marker. Required for late binding. */
    plainText: string;
    /** True iff this message had attachments at send-time and needs late hashing. */
    needsAttachmentBinding: boolean;
    expiresAt: number;
}

const PENDING_TTL_MS = 30_000;
const pendingByChannel = new Map<string, Pending[]>();

function pushPending(channelId: string, entry: Pending) {
    const queue = pendingByChannel.get(channelId) ?? [];
    const fresh = queue.filter(e => e.expiresAt > Date.now());
    fresh.push(entry);
    pendingByChannel.set(channelId, fresh);
}

function takeMatchingPending(channelId: string, content: string): Pending | null {
    const queue = pendingByChannel.get(channelId);
    if (!queue?.length) return null;
    const now = Date.now();
    for (let i = 0; i < queue.length; i++) {
        const entry = queue[i];
        if (entry.expiresAt <= now) continue;
        if (entry.matchContent === content) {
            queue.splice(i, 1);
            if (queue.length === 0) pendingByChannel.delete(channelId);
            return entry;
        }
    }
    return null;
}

async function registerOnBackend(discordMessageId: string, signedBody: string, publicKey: string, signature: string) {
    const body = {
        message: signedBody,
        discordMessageId,
        publicKey,
        signature,
        v: VeilZwc.SIGNED_MESSAGE_VERSION,
        nonce: typeof crypto?.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: Math.floor(Date.now() / 1000)
    };
    const canonical = JSON.stringify(body);
    const requestSignature = await cryptoService.sign(canonical);

    const res = await fetch(`${veilApiBase()}/veilcord/signed-message`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Public-Key": publicKey,
            "X-Signature": requestSignature
        },
        body: canonical
    });

    if (!res.ok) {
        let reason = `HTTP ${res.status}`;
        try {
            const payload: any = await res.json();
            if (payload && typeof payload.error === "string") reason = payload.error;
        } catch { /* ignore */ }
        throw new Error(reason);
    }
}

function onMessageCreate(event: any) {
    if (!event || event.optimistic) return;
    const message = event.message;
    if (!message || typeof message.id !== "string" || typeof message.content !== "string") return;
    const channelId = event.channelId ?? message.channel_id;
    if (typeof channelId !== "string") return;

    const me = UserStore.getCurrentUser?.();
    if (!me || message.author?.id !== me.id) return;

    const pending = takeMatchingPending(channelId, message.content);
    if (!pending) return;

    void finalizeAndRegister(message, pending).catch(err => {
        showToast(`Veil: couldn't register signature (${err?.message || err}).`, Toasts.Type.FAILURE);
    });
}

/**
 * Hash served attachment bytes from the CDN URLs Discord just published.
 * This is the only point at which the sender can see the exact bytes the
 * verifier will see, since Discord's CloudUpload may have re-encoded
 * images on the way out (PNG → WebP) without telling us.
 */
async function hashAttachmentsFromMessage(message: any): Promise<CanonicalAttachment[]> {
    const atts = Array.isArray(message?.attachments) ? message.attachments : [];
    const out: CanonicalAttachment[] = [];
    for (const att of atts) {
        const url = typeof att?.url === "string" ? att.url : null;
        if (!url) throw new Error("attachment missing url");
        const res = await fetch(url);
        if (!res.ok) throw new Error(`attachment HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        out.push({ sha256Hex: await cryptoService.sha256Hex(bytes) });
    }
    return out;
}

async function finalizeAndRegister(message: any, pending: Pending): Promise<void> {
    let signedBody = pending.signedBody;
    let signature = pending.signature;
    const publicKey = pending.publicKey;

    if (pending.needsAttachmentBinding || !signedBody || !signature) {
        const hashes = await hashAttachmentsFromMessage(message);
        signedBody = VeilSignedBody.buildCanonicalSignedBody(pending.plainText, hashes);
        signature = await cryptoService.sign(signedBody);
    }

    await registerOnBackend(message.id, signedBody!, publicKey, signature!);

    try {
        window.dispatchEvent(new CustomEvent("veil:signed-message:registered", {
            detail: { discordMessageId: message.id }
        }));
    } catch { /* ignore */ }
}

const sendListener: MessageSendListener = async (channelId, messageObj, options) => {
    if (!lastEnabled) return;
    if (!messageObj) return;

    const text = typeof messageObj.content === "string" ? messageObj.content : "";
    const uploads: any[] = (options as any)?.uploads ?? [];
    if (text.length === 0 && uploads.length === 0) return;

    try {
        if (!await cryptoService.hasStoredKey()) {
            lastEnabled = false;
            showToast("Sign mode off: link a Veil key first.", Toasts.Type.FAILURE);
            return { cancel: true };
        }

        const publicKey = await cryptoService.getPublicKey();
        const marker = VeilZwc.encodeMarker();
        // Insert a single regular space between the user's text and the
        // ZWC marker. Discord's server-side URL extractor uses `\S+`, so
        // a URL at the very end of the message would otherwise consume
        // every zero-width marker char into the URL token and the embed
        // pipeline would silently drop it. A trailing space terminates
        // the URL match cleanly, and chat rendering hides it.
        //
        // Both visible body and canonical body include this space so
        // the receiver's `stripZwc` (which only removes ZWC chars,
        // not whitespace) gives back the same string the sender signed.
        const visibleBody = text + " ";
        const finalContent = visibleBody + marker;

        if (finalContent.length > 2000) {
            showToast(`Sign mode: message is too long by ${finalContent.length - 2000} chars.`, Toasts.Type.FAILURE);
            return { cancel: true };
        }

        messageObj.content = finalContent;

        // Text-only messages: sign now and ship the canonical body in
        // the pending entry. Messages with attachments: defer signing
        // to MESSAGE_CREATE, where we can hash the bytes Discord
        // actually published to the CDN (which may differ from the
        // bytes on disk if Discord re-encoded a PNG to WebP inside
        // its CloudUpload pipeline).
        let signedBody: string | null = null;
        let signature: string | null = null;
        if (uploads.length === 0) {
            signedBody = VeilSignedBody.buildCanonicalSignedBody(visibleBody, []);
            signature = await cryptoService.sign(signedBody);
        }

        pushPending(channelId, {
            matchContent: finalContent,
            signedBody,
            publicKey,
            signature,
            plainText: visibleBody,
            needsAttachmentBinding: uploads.length > 0,
            expiresAt: Date.now() + PENDING_TTL_MS
        });
    } catch (e: any) {
        showToast(`Sign mode failed: ${e?.message || e}`, Toasts.Type.FAILURE);
        return { cancel: true };
    }
};

/*
 * Block edits on signed messages. Discord's edit flow re-sends the
 * new content as the new body — without our ZWC marker and without
 * touching the backend signature record. The receiver would still
 * have a marker-less edited body matched against an old signature
 * that doesn't cover it, so the badge would flip to "Invalid" the
 * moment the edit lands. Force the user to delete + resend instead.
 */
const editListener: MessageEditListener = async (channelId, messageId) => {
    const original = MessageStore.getMessage?.(channelId, messageId);
    const content = typeof original?.content === "string" ? original.content : "";
    if (!VeilZwc.hasSignedMessageRef(content)) return;
    showToast("Signed Veil messages can't be edited. Delete and resend.", Toasts.Type.FAILURE);
    return { cancel: true };
};

/*
 * Sign mode and E2E mode are mutually exclusive: signing wraps the
 * plaintext in a backend record keyed by the Discord message id, while
 * E2E replaces the body with an opaque envelope the backend can't sign
 * over. Letting both fire on the same message just produces a noisy
 * invalid-signature trail. We sync state via window events so neither
 * plugin has to import the other.
 */
const MODE_SIGN_ON_EVENT = "veil-mode:sign-on";
const MODE_E2E_ON_EVENT = "veil-mode:e2e-on";
const SIGN_LOCAL_TOGGLE_EVENT = "veil-sign:toggle";

function broadcastSignOn() {
    try { window.dispatchEvent(new CustomEvent(MODE_SIGN_ON_EVENT)); } catch { /* ignore */ }
}

function disableSignMode() {
    if (!lastEnabled) return;
    lastEnabled = false;
    try { window.dispatchEvent(new CustomEvent(SIGN_LOCAL_TOGGLE_EVENT, { detail: { enabled: false } })); } catch { /* ignore */ }
}

const VeilSignButton: ChatBarButtonFactory = ({ isMainChat }) => {
    const [enabled, setEnabled] = useState(lastEnabled);

    useEffect(() => {
        lastEnabled = enabled;
    }, [enabled]);

    useEffect(() => {
        const onLocalToggle = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || typeof detail.enabled !== "boolean") return;
            setEnabled(detail.enabled);
        };
        window.addEventListener(SIGN_LOCAL_TOGGLE_EVENT, onLocalToggle as EventListener);
        return () => window.removeEventListener(SIGN_LOCAL_TOGGLE_EVENT, onLocalToggle as EventListener);
    }, []);

    if (!isMainChat) return null;

    const tooltip = enabled
        ? "Veil sign mode is on. Click to turn off."
        : "Sign messages with your Veil key.";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => {
                setEnabled(prev => {
                    const next = !prev;
                    if (next) broadcastSignOn();
                    return next;
                });
            }}
            buttonProps={{ "aria-pressed": enabled } as any}
        >
            <span
                style={{
                    color: enabled
                        ? "var(--text-link, #00a8fc)"
                        : "var(--interactive-normal, #b5bac1)",
                    display: "inline-flex"
                }}
            >
                <SignIcon height={20} width={20} />
            </span>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "VeilSignedMessage",
    description: "Adds a chatbar toggle that signs every outgoing message with your Veil Ed25519 key. The signature lands on the Veil backend, keyed by the Discord message id.",
    authors: [Devs.gabriele],
    dependencies: ["ChatInputButtonAPI", "MessageEventsAPI", "VeilCrypto", "VeilLinkKey"],
    required: true,

    start() {
        addChatBarButton(BUTTON_ID, VeilSignButton, SignIcon);
        addMessagePreSendListener(sendListener);
        addMessagePreEditListener(editListener);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        window.addEventListener(MODE_E2E_ON_EVENT, disableSignMode);
    },

    stop() {
        removeChatBarButton(BUTTON_ID);
        removeMessagePreSendListener(sendListener);
        removeMessagePreEditListener(editListener);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        window.removeEventListener(MODE_E2E_ON_EVENT, disableSignMode);
        pendingByChannel.clear();
        lastEnabled = false;
    }
});
