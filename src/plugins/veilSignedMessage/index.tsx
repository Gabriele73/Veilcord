/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { addMessagePreEditListener, addMessagePreSendListener, MessageEditListener, MessageSendListener, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import definePlugin, { PluginNative } from "@utils/types";
import { FluxDispatcher, MessageStore, showToast, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import { CanonicalAttachment, cryptoService, getActiveBindingForUid, veilApiBase, VeilSignedBody, VeilZwc } from "@plugins/veilCrypto";
import VeilLinkKeyPlugin from "@plugins/veilLinkKey";
import { SignIcon } from "./SignIcon";

const Native = VencordNative.pluginHelpers.VeilSignedMessage as PluginNative<typeof import("./native")>;

// veil v0.0.2

const BUTTON_ID = "veil-sign";

let lastEnabled = false;

interface Pending {
    /** Visible Discord content used to match the MESSAGE_CREATE event. */
    matchContent: string;
    publicKey: string;
    /** Plain text the user typed. Bound into the v4 canonical body. */
    plainText: string;
    /** True iff this message had attachments at send-time and needs late hashing. */
    needsAttachmentBinding: boolean;
    expiresAt: number;
}

const PENDING_TTL_MS = 30_000;
const pendingByChannel = new Map<string, Pending[]>();

/**
 * Discord message ids this client signed during the current session.
 * Used by the edit-blocker to refuse edits on freshly-signed messages
 * even though they no longer carry a ZWC marker. Legacy ZWC-marked
 * messages still hit the blocker via `VeilZwc.hasSignedMessageRef`.
 */
const signedThisSession = new Set<string>();

/**
 * v4 signed records are only accepted by the backend, and only render
 * a badge on other people's clients, when the signing pubkey is OAuth
 * bound to the canonical sender uid. So we refuse to sign at all
 * unless the user's current active key is bound to their current
 * Discord account.
 */
async function hasActiveBindingForCurrentKey(): Promise<boolean> {
    try {
        const me = UserStore.getCurrentUser?.();
        const uid = me?.id;
        if (!uid) return false;
        if (!(await cryptoService.hasStoredKey())) return false;
        const ourPub = (await cryptoService.getPublicKey()).toLowerCase();
        const binding = await getActiveBindingForUid(uid);
        if (!binding?.publicKey) return false;
        return binding.publicKey.toLowerCase() === ourPub;
    } catch {
        return false;
    }
}

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
        const fetched = await Native.fetchAttachmentBytes(url);
        if (!fetched.ok) throw new Error(`attachment fetch failed: ${fetched.error}`);
        const bytes = fetched.bytes instanceof Uint8Array
            ? fetched.bytes
            : new Uint8Array(fetched.bytes as any);
        out.push({ sha256Hex: await cryptoService.sha256Hex(bytes) });
    }
    return out;
}

async function finalizeAndRegister(message: any, pending: Pending): Promise<void> {
    const me = UserStore.getCurrentUser?.();
    const senderUid = message?.author?.id ?? me?.id;
    const channelId = message?.channel_id;
    const discordMessageId = message?.id;
    if (!senderUid || !channelId || !discordMessageId) {
        throw new Error("missing context for v4 canonical body");
    }

    const hashes = pending.needsAttachmentBinding
        ? await hashAttachmentsFromMessage(message)
        : [];
    const ctx = { discordMessageId, channelId, senderUid };
    const signedBody = VeilSignedBody.buildCanonicalSignedBodyV4(pending.plainText, hashes, ctx);
    const signature = await cryptoService.sign(signedBody);

    await registerOnBackend(discordMessageId, signedBody, pending.publicKey, signature);

    signedThisSession.add(discordMessageId);

    try {
        window.dispatchEvent(new CustomEvent("veil:signed-message:registered", {
            detail: { discordMessageId }
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
            try { window.dispatchEvent(new CustomEvent(SIGN_LOCAL_TOGGLE_EVENT, { detail: { enabled: false } })); } catch { /* ignore */ }
            showToast("Sign mode off. Set up a Veil key first.", Toasts.Type.FAILURE);
            try { VeilLinkKeyPlugin.openLinkKeyModal(); } catch { /* ignore */ }
            return { cancel: true };
        }

        if (!(await hasActiveBindingForCurrentKey())) {
            lastEnabled = false;
            try { window.dispatchEvent(new CustomEvent(SIGN_LOCAL_TOGGLE_EVENT, { detail: { enabled: false } })); } catch { /* ignore */ }
            showToast("Link this key to your Discord account to sign messages.", Toasts.Type.FAILURE);
            try { VeilLinkKeyPlugin.openLinkKeyModal(); } catch { /* ignore */ }
            return { cancel: true };
        }

        const publicKey = await cryptoService.getPublicKey();

        // No ZWC marker is appended to the outgoing body — the
        // verifier discovers signed messages via the per-channel
        // signed-record pre-fetch and the live MESSAGE_CREATE lookup,
        // not via an inline stego trailer. The visible content is
        // exactly what the user typed.

        // v4 canonical bodies bind the Discord message id, channel id
        // and sender uid into the signed bytes. The message id only
        // exists after Discord assigns one, so we always defer signing
        // to MESSAGE_CREATE — for both text-only and attachment-bearing
        // messages.
        pushPending(channelId, {
            matchContent: text,
            publicKey,
            plainText: text,
            needsAttachmentBinding: uploads.length > 0,
            expiresAt: Date.now() + PENDING_TTL_MS
        });
    } catch (e: any) {
        showToast(`Sign mode failed: ${e?.message || e}`, Toasts.Type.FAILURE);
        return { cancel: true };
    }
};

/*
 * Block edits on signed messages. Discord's edit flow re-sends the new
 * content as the new body without touching the backend signature
 * record. The verifier would rebuild the canonical body from the new
 * content and flip the badge to "Invalid" the moment the edit lands.
 * Force the user to delete + resend instead.
 *
 * Detection sources:
 *   - `signedThisSession`: messages this client signed since launch.
 *     Covers the common case where the sender edits right after sending.
 *   - `VeilZwc.hasSignedMessageRef`: legacy v3/v4 ZWC-marked messages
 *     already in history that predate the no-marker rollout.
 */
const editListener: MessageEditListener = async (channelId, messageId) => {
    if (!signedThisSession.has(messageId)) {
        const original = MessageStore.getMessage?.(channelId, messageId);
        const content = typeof original?.content === "string" ? original.content : "";
        if (!VeilZwc.hasSignedMessageRef(content)) return;
    }
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
            onClick={async () => {
                const next = !enabled;
                if (next) {
                    const allowed = await hasActiveBindingForCurrentKey();
                    if (!allowed) {
                        showToast(
                            "Link this key to your Discord account first.",
                            Toasts.Type.FAILURE
                        );
                        try { VeilLinkKeyPlugin.openLinkKeyModal(); } catch { /* ignore */ }
                        return;
                    }
                    broadcastSignOn();
                }
                setEnabled(next);
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

/*
 * Mode-picker bridge.
 *
 * `VeilModePicker` owns the unified chatbar UI. When the user picks
 * "signed" we receive `veil-mode:request-sign` with `{ enabled }`,
 * preflight the binding (and surface the link modal if missing), then
 * apply the toggle the same way the legacy chatbar button did.
 */
async function onModeRequestSign(event: Event) {
    const detail = (event as CustomEvent).detail;
    if (!detail) return;
    const next = Boolean(detail.enabled);
    if (next) {
        const allowed = await hasActiveBindingForCurrentKey();
        if (!allowed) {
            showToast("Link this key to your Discord account first.", Toasts.Type.FAILURE);
            try { VeilLinkKeyPlugin.openLinkKeyModal(); } catch { /* ignore */ }
            try { window.dispatchEvent(new CustomEvent(SIGN_LOCAL_TOGGLE_EVENT, { detail: { enabled: false } })); } catch { /* ignore */ }
            return;
        }
        broadcastSignOn();
    }
    lastEnabled = next;
    try { window.dispatchEvent(new CustomEvent(SIGN_LOCAL_TOGGLE_EVENT, { detail: { enabled: next } })); } catch { /* ignore */ }
}

export default definePlugin({
    name: "VeilSignedMessage",
    description: "Adds a chatbar toggle that signs every outgoing message with your Veil Ed25519 key. The signature lands on the Veil backend, keyed by the Discord message id.",
    authors: [Devs.gabriele],
    dependencies: ["ChatInputButtonAPI", "MessageEventsAPI", "VeilCrypto", "VeilLinkKey"],
    required: true,

    start() {
        addMessagePreSendListener(sendListener);
        addMessagePreEditListener(editListener);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        window.addEventListener(MODE_E2E_ON_EVENT, disableSignMode);
        window.addEventListener("veil-mode:request-sign", onModeRequestSign as EventListener);
    },

    stop() {
        removeMessagePreSendListener(sendListener);
        removeMessagePreEditListener(editListener);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        window.removeEventListener(MODE_E2E_ON_EVENT, disableSignMode);
        window.removeEventListener("veil-mode:request-sign", onModeRequestSign as EventListener);
        pendingByChannel.clear();
        signedThisSession.clear();
        lastEnabled = false;
    }
});
