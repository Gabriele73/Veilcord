/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher, showToast, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import { CanonicalAttachment, cryptoService, veilApiBase, VeilSignedBody, VeilZwc } from "@plugins/veilCrypto";
import { SignIcon } from "./SignIcon";

// veil v0.0.2

const BUTTON_ID = "veil-sign";

let lastEnabled = false;

interface Pending {
    /** Final Discord content (visible body + ZWC marker) — used to match the MESSAGE_CREATE event. */
    matchContent: string;
    /** Canonical body the signature was computed over. Includes attachment hashes when present. */
    signedBody: string;
    publicKey: string;
    signature: string;
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

    void registerOnBackend(message.id, pending.signedBody, pending.publicKey, pending.signature)
        .then(() => {
            try {
                window.dispatchEvent(new CustomEvent("veil:signed-message:registered", {
                    detail: { discordMessageId: message.id }
                }));
            } catch { /* ignore */ }
        })
        .catch(err => {
            showToast(`Veil: couldn't register signature (${err?.message || err}).`, Toasts.Type.FAILURE);
        });
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

        // Hash every attachment's plaintext bytes so the signature
        // binds the file content the sender saw, not what the CDN
        // happens to serve later. Order matches `options.uploads`,
        // which Discord forwards as `message.attachments` in the same
        // order at MESSAGE_CREATE time on the receiver.
        //
        // Discord re-encodes some images (PNG, JPEG) to WebP inside
        // CloudUpload.upload() via `maybeConvertToWebP`, which mutates
        // `upload.item.file` to point at the converted bytes. We have
        // to force that conversion to happen *before* we hash, or the
        // CDN will serve different bytes than the ones we signed and
        // every verifier will compute a mismatching digest. The method
        // is idempotent, so calling it here is safe even when the
        // upload pipeline runs it again later.
        const attachmentHashes: CanonicalAttachment[] = [];
        for (const upload of uploads) {
            try { await upload?.maybeConvertToWebP?.(); } catch { /* fall through to hash whatever's there */ }
            const file: File | undefined = upload?.item?.file;
            if (!file) {
                showToast("Sign mode: couldn't read an attachment to hash it.", Toasts.Type.FAILURE);
                return { cancel: true };
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            const sha256Hex = await cryptoService.sha256Hex(bytes);
            attachmentHashes.push({ sha256Hex });
        }

        const publicKey = await cryptoService.getPublicKey();
        const canonicalBody = VeilSignedBody.buildCanonicalSignedBody(text, attachmentHashes);
        const signature = await cryptoService.sign(canonicalBody);
        const marker = VeilZwc.encodeMarker();
        const finalContent = text + marker;

        if (finalContent.length > 2000) {
            showToast(`Sign mode: message is too long by ${finalContent.length - 2000} chars.`, Toasts.Type.FAILURE);
            return { cancel: true };
        }

        messageObj.content = finalContent;

        pushPending(channelId, {
            matchContent: finalContent,
            signedBody: canonicalBody,
            publicKey,
            signature,
            expiresAt: Date.now() + PENDING_TTL_MS
        });
    } catch (e: any) {
        showToast(`Sign mode failed: ${e?.message || e}`, Toasts.Type.FAILURE);
        return { cancel: true };
    }
};

const VeilSignButton: ChatBarButtonFactory = ({ isMainChat }) => {
    const [enabled, setEnabled] = useState(lastEnabled);

    useEffect(() => {
        lastEnabled = enabled;
    }, [enabled]);

    if (!isMainChat) return null;

    const tooltip = enabled
        ? "Veil sign mode is on. Click to turn off."
        : "Sign messages with your Veil key.";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => setEnabled(prev => !prev)}
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
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    },

    stop() {
        removeChatBarButton(BUTTON_ID);
        removeMessagePreSendListener(sendListener);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        pendingByChannel.clear();
        lastEnabled = false;
    }
});
