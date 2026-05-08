/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { updateMessage } from "@api/MessageUpdater";
import { cryptoService, getActiveBindingForUid, VeilCryptoUtils, VeilX25519 } from "@plugins/veilCrypto";
import { Devs } from "@utils/constants";
import definePlugin, { PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, showToast, Toasts, useEffect, UserStore, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.VeilE2EMessage as PluginNative<typeof import("./native")>;

import { E2eBadge } from "./Badge";
import { clearAll, clearEntry, DecryptionEntry, getEntry, ownsBlobUrl, setEntry } from "./decryptCache";
import { LockIcon } from "./LockIcon";
import {
    CIPHERTEXT_FILENAME_SUFFIX,
    CIPHERTEXT_MIME,
    decodeEnvelopeBody,
    decodeManifestPayload,
    encodeEnvelopeBody,
    encodeManifestPayload,
    ManifestAttachment,
    VeilManifest
} from "./parser";
import managedStyle from "./style.css?managed";

// veil v0.0.2

const BUTTON_ID = "veil-e2e";
const ACCESSORY_ID = "veil-e2e-accessory";

const PLACEHOLDER_DECRYPTING = "🔒 Decrypting Veil message…";
const PLACEHOLDER_VAULT_LOCKED = "🔒 Encrypted with Veil. Unlock your key to read this.";
const PLACEHOLDER_LOCKED_OUT = "🔒 Encrypted to a different Veil key.";
const PLACEHOLDER_FAILED = "🔒 Couldn't decrypt this Veil message.";

const enabledByChannel = new Map<string, boolean>();

function setEnabled(channelId: string, value: boolean) {
    if (value) enabledByChannel.set(channelId, true);
    else enabledByChannel.delete(channelId);
    try {
        window.dispatchEvent(new CustomEvent("veil-e2e:toggle", { detail: { channelId, enabled: value } }));
    } catch { /* ignore */ }
}

function isEnabled(channelId: string): boolean {
    return enabledByChannel.get(channelId) === true;
}

/*
 * Sign mode and E2E mode are mutually exclusive: signing wraps the
 * plaintext in a backend record keyed by Discord message id, while
 * E2E replaces the body with an opaque envelope that has no plaintext
 * for the backend to sign over. Letting both run on the same message
 * just produces a noisy invalid-signature trail. We sync state via
 * window events so neither plugin has to import the other.
 */
const MODE_SIGN_ON_EVENT = "veil-mode:sign-on";
const MODE_E2E_ON_EVENT = "veil-mode:e2e-on";

function broadcastE2eOn() {
    try { window.dispatchEvent(new CustomEvent(MODE_E2E_ON_EVENT)); } catch { /* ignore */ }
}

function disableAllE2eChannels() {
    const channelIds = Array.from(enabledByChannel.keys());
    for (const cid of channelIds) setEnabled(cid, false);
}

/*
 * Download-click interceptor.
 *
 * Discord renders attachment cards (zips, pdfs, audio, anything that
 * isn't an inline image) with a download icon, and image lightboxes
 * with a "Download" link. Both end up routing the URL through Electron's
 * native downloader on desktop, which runs in the main process and
 * cannot resolve renderer-scoped `blob:` URLs. The result: the user
 * sees an empty / failed download dialog for every Veil-decrypted
 * attachment, even though the renderer can display the same blob URL
 * just fine inline.
 *
 * Solution: catch the click before Discord's listener fires, look up
 * the cached blob via `ownsBlobUrl`, and trigger the download ourselves
 * by programmatically clicking a fresh `<a download>` element. That
 * path goes through Chromium's renderer-scope download handler which
 * does understand blob: URLs, so the file actually saves with the
 * right filename + bytes.
 *
 * We ONLY take over anchors that carry an explicit `download` attribute.
 * Discord wraps inline images in `<a href="<original-url>">` whose
 * click opens the lightbox and whose right-click feeds the native
 * "Save Image As" / "Copy Image" context menu. Those anchors don't set
 * `download`, so this filter leaves expand-on-click and the context
 * menu untouched while still catching every Discord download button.
 */
function findEnclosingDownloadAnchor(start: Element | null): HTMLAnchorElement | null {
    let el: Element | null = start;
    while (el && el !== document.body) {
        if (el instanceof HTMLAnchorElement && el.hasAttribute("download")) {
            const href = el.getAttribute("href") || el.href || "";
            if (href.startsWith("blob:")) return el;
        }
        el = el.parentElement;
    }
    return null;
}

function triggerBlobDownload(href: string, filename: string): void {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    requestAnimationFrame(() => {
        try { a.remove(); } catch { /* ignore */ }
    });
}

function onAttachmentDownloadClick(e: MouseEvent): void {
    if (e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const anchor = findEnclosingDownloadAnchor(target);
    if (!anchor) return;
    const href = anchor.getAttribute("href") || anchor.href || "";
    const meta = ownsBlobUrl(href);
    if (!meta) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    triggerBlobDownload(meta.blobUrl, anchor.getAttribute("download") || meta.name || "download");
}

/*
 * Side cache populated by the synchronous patch hook so the async
 * decrypt task can find the original envelope after the Flux store has
 * already overwritten `message.content` with our placeholder.
 */
interface PendingEnvelope {
    envelope: Uint8Array;
    base64: string;
    channelId: string;
    /** Snapshot of attachment URLs in the original message, in order. */
    attachmentUrls: string[];
    authorId: string | null;
}

const pendingByMessageId = new Map<string, PendingEnvelope>();

/*
 * Sender's own-message short-circuit cache.
 *
 * When we encrypt and send a message we already know the plaintext
 * locally; there's no reason to round-trip through Discord's CDN to
 * re-decrypt it on the optimistic echo. Keyed by the envelope's
 * base64-url body (the same form `decodeEnvelopeBody` returns), so
 * `preprocessMessage` can look up the entry the moment Discord fires
 * MESSAGE_CREATE for our own send and substitute plaintext + locally
 * minted attachment blob URLs synchronously, no flash.
 *
 * Discord typically fires MESSAGE_CREATE twice for own sends — once
 * optimistically with a nonce-based id, once real with the server id —
 * so each entry holds the underlying Blob (not just a URL). Every
 * promotion mints a fresh blob URL owned by that messageId-keyed cache
 * entry. The recent-sends entry expires by TTL.
 */
interface RecentSendAttachment {
    blob: Blob;
    name: string;
    mime: string;
    size: number;
    spoiler: boolean;
    width?: number;
    height?: number;
}

interface RecentSend {
    plaintext: string;
    attachments: RecentSendAttachment[];
    expiresAt: number;
}

const RECENT_SEND_TTL_MS = 60_000;
const recentSendsByEnvelopeB64 = new Map<string, RecentSend>();

function reapRecentSends(): void {
    const now = Date.now();
    for (const [k, v] of Array.from(recentSendsByEnvelopeB64.entries())) {
        if (v.expiresAt <= now) {
            recentSendsByEnvelopeB64.delete(k);
        }
    }
}

function mintAttachmentsFromRecentSend(recent: RecentSend) {
    return recent.attachments.map(a => ({
        blobUrl: URL.createObjectURL(a.blob),
        name: a.name,
        mime: a.mime,
        size: a.size,
        spoiler: a.spoiler,
        width: a.width,
        height: a.height
    }));
}

function placeholderForState(state: DecryptionEntry["state"]): string {
    switch (state) {
        case "vault-locked": return PLACEHOLDER_VAULT_LOCKED;
        case "locked-out": return PLACEHOLDER_LOCKED_OUT;
        case "failed": return PLACEHOLDER_FAILED;
        default: return PLACEHOLDER_DECRYPTING;
    }
}

/* ---------------- Send path ---------------- */

/**
 * Symbol-keyed markers we attach to a CloudUpload after encrypting it.
 * Discord doesn't enumerate symbol-keyed properties, so they don't
 * leak into anything serialized.
 *
 *  - VEIL_CIPHERTEXT_FILE: the new File the upload should send
 *  - VEIL_LOCAL_BLOB: original plaintext Blob (for sender-side echo
 *    rendering)
 *  - VEIL_MANIFEST_ENTRY: the per-file manifest entry the send-listener
 *    needs to bake into the encrypted message envelope
 */
const VEIL_CIPHERTEXT_FILE = Symbol.for("VeilCipherFile");
const VEIL_LOCAL_BLOB = Symbol.for("VeilLocalBlob");
const VEIL_MANIFEST_ENTRY = Symbol.for("VeilManifestEntry");

function randomCipherName(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return `veil_${s}${CIPHERTEXT_FILENAME_SUFFIX}`;
}

async function readImageDimensions(file: File): Promise<{ width?: number; height?: number; }> {
    if (!file.type.startsWith("image/")) return {};
    if (typeof createImageBitmap !== "function") return {};
    try {
        const bmp = await createImageBitmap(file);
        const w = bmp.width;
        const h = bmp.height;
        bmp.close?.();
        return { width: w, height: h };
    } catch {
        return {};
    }
}

/**
 * Encrypt a CloudUpload in place, before its bytes go on the wire.
 * Called from the patched `CloudUpload.prototype.upload` so the
 * encryption happens *inside* the upload pipeline rather than at
 * pre-send time. This avoids the cancel-and-retry path Discord's
 * pipeline can't recover from.
 *
 * Idempotent: skips if the upload already carries our markers.
 * Also skips when E2E isn't enabled for the upload's channel,
 * so non-Veil channels are unaffected.
 */
async function encryptCloudUploadIfNeeded(upload: any): Promise<void> {
    if (!upload || (upload as any)[VEIL_MANIFEST_ENTRY]) return;
    const channelId: string | undefined = upload?.channelId;
    if (!channelId || !isEnabled(channelId)) return;

    try {
        const file: File | undefined = upload?.item?.file;
        if (!file) return;

        const bytes = new Uint8Array(await file.arrayBuffer());
        const dims = await readImageDimensions(file);
        const { ciphertext, key, iv } = await cryptoService.encryptAttachmentBytes(bytes);

        const newName = randomCipherName();
        const newFile = new File([ciphertext], newName, { type: CIPHERTEXT_MIME });
        const localBlob = new Blob([bytes], { type: file.type || "application/octet-stream" });

        // Mutate the upload in place so anything that captured a
        // reference to upload.item still sees the new file. Replacing
        // the whole `item` object would leak a stale plaintext
        // reference, which is the bug we're fixing.
        if (upload.item) {
            upload.item.file = newFile;
        } else {
            upload.item = { file: newFile, platform: 0, origin: "" };
        }
        upload.filename = newName;
        upload.mimeType = CIPHERTEXT_MIME;
        upload.preCompressionSize = ciphertext.byteLength;
        upload.postCompressionSize = ciphertext.byteLength;
        upload.currentSize = ciphertext.byteLength;
        upload.isImage = false;
        upload.isVideo = false;
        upload.isThumbnail = false;
        upload.spoiler = false;
        upload.classification = "veil_encrypted";
        upload.sensitive = false;
        upload.waveform = undefined;
        upload.durationSecs = undefined;

        (upload as any)[VEIL_CIPHERTEXT_FILE] = newFile;
        (upload as any)[VEIL_LOCAL_BLOB] = localBlob;
        (upload as any)[VEIL_MANIFEST_ENTRY] = {
            name: file.name,
            mime: file.type || "application/octet-stream",
            size: bytes.byteLength,
            key: VeilCryptoUtils.bytesToBase64(key),
            iv: VeilCryptoUtils.bytesToBase64(iv),
            spoiler: false,
            width: dims.width,
            height: dims.height
        } satisfies ManifestAttachment;
    } catch (e) {
        console.warn("[VeilE2E] CloudUpload encrypt failed", e);
    }
}

const sendListener: MessageSendListener = async (channelId, messageObj, options) => {
    const uploads: any[] = (options as any)?.uploads ?? [];
    const stickers: string[] = (options as any)?.stickers ?? [];
    const text = typeof messageObj.content === "string" ? messageObj.content : "";

    // If any upload was already encrypted by the CloudUpload patch
    // (because E2E was on at paste time), force E2E for this send even
    // if the user toggled E2E off in the meantime — we can't undo a
    // ciphertext upload, and shipping it with plaintext content would
    // leak the keys / leave the recipient with a `.veilbin`.
    const anyEncrypted = uploads.some(u => (u as any)[VEIL_MANIFEST_ENTRY]);
    const e2eOn = isEnabled(channelId) || anyEncrypted;
    if (!e2eOn) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel || !channel.isDM() || channel.isGroupDM()) {
        showToast("Veil E2E only works in 1:1 DMs.", Toasts.Type.FAILURE);
        setEnabled(channelId, false);
        return { cancel: true };
    }

    if (text.length === 0 && uploads.length === 0 && stickers.length === 0) return;

    if (stickers.length > 0) {
        showToast("Stickers can't be sent end-to-end.", Toasts.Type.FAILURE);
        return { cancel: true };
    }

    try {
        if (!(await VeilX25519.isAvailable())) {
            showToast("This Discord build doesn't support X25519, so E2E isn't available.", Toasts.Type.FAILURE);
            setEnabled(channelId, false);
            return { cancel: true };
        }

        if (!(await cryptoService.hasStoredKey())) {
            showToast("Link a Veil key to send encrypted messages.", Toasts.Type.FAILURE);
            setEnabled(channelId, false);
            return { cancel: true };
        }

        const me = UserStore.getCurrentUser?.();
        const recipientUid = channel.getRecipientId?.();
        if (!me || !recipientUid) {
            showToast("Couldn't find the recipient for this DM.", Toasts.Type.FAILURE);
            return { cancel: true };
        }

        const binding = await getActiveBindingForUid(recipientUid);
        if (!binding) {
            showToast("This user doesn't have a Veil key linked anymore.", Toasts.Type.FAILURE);
            setEnabled(channelId, false);
            return { cancel: true };
        }

        const ourPub = await cryptoService.getPublicKey();

        // Make sure every upload is encrypted before send. The
        // CloudUpload patch normally handles this when E2E is on at
        // paste/drag time, but if the user toggled E2E on after
        // already attaching files, encrypt them now — but only if
        // they haven't started uploading yet. Mid-flight cancel and
        // restart breaks Discord's pipeline irrecoverably.
        for (const upload of uploads) {
            if ((upload as any)[VEIL_MANIFEST_ENTRY]) continue;
            const status: string | undefined = upload?.status;
            if (status && status !== "NOT_STARTED") {
                showToast(
                    "Re-attach this file to send it encrypted (it already started uploading).",
                    Toasts.Type.FAILURE
                );
                return { cancel: true };
            }
            await encryptCloudUploadIfNeeded(upload);
            if (!(upload as any)[VEIL_MANIFEST_ENTRY]) {
                showToast("Couldn't encrypt an attachment.", Toasts.Type.FAILURE);
                return { cancel: true };
            }
        }

        const manifestAttachments: ManifestAttachment[] = uploads.map(
            u => (u as any)[VEIL_MANIFEST_ENTRY] as ManifestAttachment
        );
        const localPreviews: RecentSendAttachment[] = uploads.map(u => {
            const m = (u as any)[VEIL_MANIFEST_ENTRY] as ManifestAttachment;
            const blob = (u as any)[VEIL_LOCAL_BLOB] as Blob;
            return {
                blob,
                name: m.name,
                mime: m.mime,
                size: m.size,
                spoiler: !!m.spoiler,
                width: m.width,
                height: m.height
            };
        });

        const manifest: VeilManifest = { v: 1, text, attachments: manifestAttachments };
        const plaintextPayload = manifestAttachments.length === 0
            ? text
            : encodeManifestPayload(manifest);

        const envelope = await cryptoService.encryptForRecipients(
            [binding.publicKey, ourPub],
            plaintextPayload,
            { senderUid: me.id, recipientUid, channelId }
        );
        const finalContent = encodeEnvelopeBody(envelope);

        if (finalContent.length > 2000) {
            showToast(
                `Encrypted message is too long by ${finalContent.length - 2000} chars. Split it up.`,
                Toasts.Type.FAILURE
            );
            return { cancel: true };
        }

        // Stash plaintext + local attachment blobs keyed by the envelope
        // base64 so when MESSAGE_CREATE fires for our own send, the
        // receive-path patch substitutes plaintext synchronously without
        // doing a redundant round-trip decrypt + CDN fetch. The entry
        // stays alive (TTL-based) so both the optimistic and real
        // MESSAGE_CREATE events see it.
        const decoded = decodeEnvelopeBody(finalContent);
        if (decoded) {
            reapRecentSends();
            recentSendsByEnvelopeB64.set(decoded.base64, {
                plaintext: text,
                attachments: localPreviews,
                expiresAt: Date.now() + RECENT_SEND_TTL_MS
            });
        }

        messageObj.content = finalContent;
    } catch (e: any) {
        showToast(`E2E failed: ${e?.message || e}`, Toasts.Type.FAILURE);
        return { cancel: true };
    }
};

/* ---------------- Receive path ---------------- */

/**
 * Replace the attachment array on `message` (mutating in-place) with
 * decrypted blob entries from the cached decrypt result. Used both
 * from `preprocessMessage` (synchronous re-render of an already
 * decrypted message) and conceptually mirrored in `decryptAndCommit`
 * via `updateMessage`.
 */
function applyCachedAttachmentsInPlace(message: any, messageId: string, cached: NonNullable<ReturnType<typeof getEntry>>): void {
    if (!cached.attachments || !Array.isArray(message.attachments)) return;
    if (message.attachments.length !== cached.attachments.length) return;
    for (let i = 0; i < message.attachments.length; i++) {
        const a = cached.attachments[i];
        if (!a) continue;
        message.attachments[i] = {
            ...message.attachments[i],
            id: `veil_${messageId}_${i}`,
            filename: a.name,
            size: a.size,
            // `proxy_url` is what Discord runs through its image resizer
            // and appends `?format=webp&width=…&height=…` to. The "#"
            // turns that query into a fragment so the blob URL still
            // resolves. `url` is what `<a href download>`, "open
            // original", and Electron's downloader use as-is — leave
            // it clean so saving the file actually works.
            url: a.blobUrl,
            proxy_url: a.blobUrl + "#",
            content_type: a.mime,
            spoiler: a.spoiler,
            width: a.width,
            height: a.height
        };
    }
}

/**
 * Synchronous hook called from inside the patched MessageStore action
 * handlers (and from the Flux subscriber fallback). For an envelope
 * we've already decrypted, restores the cached plaintext synchronously.
 * Otherwise, swaps the envelope body to a friendly placeholder before
 * the store commits and schedules an async decrypt.
 */
function preprocessMessage(message: any, channelIdHint: string | null): void {
    if (!message || typeof message !== "object") return;
    if (typeof message.content !== "string") return;

    const decoded = decodeEnvelopeBody(message.content);
    if (!decoded) return;

    const channelId = channelIdHint
        ?? (typeof message.channel_id === "string" ? message.channel_id : null);
    if (!channelId) return;
    const messageId: string | null = typeof message.id === "string" ? message.id : null;
    if (!messageId) return;

    const authorId: string | null = typeof message.author?.id === "string" ? message.author.id : null;

    // Fast path for messages whose decrypt already resolved (re-render
    // on scrollback, re-fetch, embed-only MESSAGE_UPDATE that re-pulls
    // the encrypted body, etc). Use the cached plaintext directly so
    // we never flash "Decrypting…" on top of plaintext we already have.
    const cachedExisting = getEntry(messageId);
    if (cachedExisting?.state === "decrypted" && cachedExisting.plaintext != null) {
        message.content = cachedExisting.plaintext;
        applyCachedAttachmentsInPlace(message, messageId, cachedExisting);
        return;
    }
    if (cachedExisting && cachedExisting.state !== "loading") {
        // We've already resolved a non-success terminal state for this
        // envelope (vault-locked, locked-out, failed). Show that
        // message instead of the generic "Decrypting…".
        message.content = placeholderForState(cachedExisting.state);
        return;
    }

    // Sender's own-message echo: we already know plaintext + locally
    // stored attachment blobs, so promote the entry to `decrypted`
    // synchronously. No async round-trip, no flash, no "Decrypting…".
    // Don't delete the entry so both the optimistic and real
    // MESSAGE_CREATE events benefit; TTL handles cleanup.
    const recent = recentSendsByEnvelopeB64.get(decoded.base64);
    if (recent) {
        message.content = recent.plaintext;
        const attachments = mintAttachmentsFromRecentSend(recent);
        const entry: DecryptionEntry = {
            state: "decrypted",
            plaintext: recent.plaintext,
            attachments
        };
        setEntry(messageId, entry);
        applyCachedAttachmentsInPlace(message, messageId, entry);
        return;
    }

    const attachmentUrls: string[] = Array.isArray(message.attachments)
        ? message.attachments.map((a: any) => (typeof a?.url === "string" ? a.url : ""))
        : [];

    const previous = pendingByMessageId.get(messageId);
    const sameEnvelope = previous && previous.base64 === decoded.base64;

    if (!sameEnvelope) {
        pendingByMessageId.set(messageId, {
            envelope: decoded.envelope,
            base64: decoded.base64,
            channelId,
            attachmentUrls,
            authorId
        });
        setEntry(messageId, { state: "loading" });
    }

    message.content = placeholderForState("loading");

    if (!sameEnvelope) {
        Promise.resolve().then(() => decryptAndCommitSafe(messageId));
    }
}

function preprocessMessages(messages: any, channelIdHint: string | null): void {
    if (!Array.isArray(messages)) return;
    for (const m of messages) preprocessMessage(m, channelIdHint);
}

/** Wrapper around `decryptAndCommit` that swallows errors so a stuck
 * promise rejection never leaves a message frozen on "Decrypting…". */
async function decryptAndCommitSafe(messageId: string): Promise<void> {
    try {
        await decryptAndCommit(messageId);
    } catch (e) {
        console.warn("[VeilE2E] decrypt failed", messageId, e);
        const pending = pendingByMessageId.get(messageId);
        if (pending) {
            await commitPlaceholder(pending.channelId, messageId, "failed");
        } else {
            setEntry(messageId, { state: "failed" });
        }
    }
}

async function decryptAndCommit(messageId: string): Promise<void> {
    const pending = pendingByMessageId.get(messageId);
    if (!pending) return;

    const { envelope, channelId, attachmentUrls, authorId } = pending;

    const me = UserStore.getCurrentUser?.();
    if (!me) {
        await commitPlaceholder(channelId, messageId, "vault-locked");
        return;
    }
    if (!(await cryptoService.hasStoredKey())) {
        await commitPlaceholder(channelId, messageId, "vault-locked");
        return;
    }

    const addressed = await cryptoService.isEnvelopeAddressedToUs(envelope);
    if (!addressed) {
        await commitPlaceholder(channelId, messageId, "locked-out");
        return;
    }

    const channel = ChannelStore.getChannel(channelId);
    const recipientUid = authorId === me.id
        ? channel?.getRecipientId?.()
        : me.id;
    const senderUid = authorId ?? null;
    if (!recipientUid || !senderUid) {
        await commitPlaceholder(channelId, messageId, "failed");
        return;
    }

    const plaintext = await cryptoService.tryDecryptFromSender(envelope, {
        senderUid,
        recipientUid,
        channelId
    });
    if (plaintext == null) {
        await commitPlaceholder(channelId, messageId, "failed");
        return;
    }

    const manifest = decodeManifestPayload(plaintext);

    const decryptedAttachments: { blobUrl: string; meta: ManifestAttachment; }[] = [];
    const newAttachments: any[] = [];
    let attachmentsFailed = false;

    for (let i = 0; i < manifest.attachments.length; i++) {
        const meta = manifest.attachments[i];
        const url = attachmentUrls[i];
        if (!url) {
            console.warn("[VeilE2E] no attachment url for manifest entry", i, "of message", messageId);
            attachmentsFailed = true;
            continue;
        }
        try {
            // Fetch ciphertext via the main process to bypass the
            // renderer's same-origin / CORS rules — Discord CDN doesn't
            // send Access-Control-Allow-Origin for our binary mime.
            const fetched = await Native.fetchAttachmentBytes(url);
            if (!fetched.ok) throw new Error(fetched.error);
            const ciphertext = fetched.bytes instanceof Uint8Array
                ? fetched.bytes
                : new Uint8Array(fetched.bytes as any);
            const keyBytes = VeilCryptoUtils.base64ToBytes(meta.key);
            const ivBytes = VeilCryptoUtils.base64ToBytes(meta.iv);
            const plain = await cryptoService.decryptAttachmentBytes(ciphertext, keyBytes, ivBytes);
            const blob = new Blob([plain], { type: meta.mime });
            const blobUrl = URL.createObjectURL(blob);
            decryptedAttachments.push({ blobUrl, meta });
            newAttachments.push({
                id: `veil_${messageId}_${i}`,
                filename: meta.name,
                size: meta.size,
                // See applyCachedAttachmentsInPlace: `proxy_url` carries
                // the "#" so Discord's appended format query becomes a
                // fragment; `url` stays clean so downloads work.
                url: blobUrl,
                proxy_url: blobUrl + "#",
                content_type: meta.mime,
                spoiler: !!meta.spoiler,
                width: meta.width,
                height: meta.height
            });
        } catch (e) {
            console.warn("[VeilE2E] attachment decrypt failed", { messageId, index: i, url, manifestSize: meta.size, mime: meta.mime, error: e });
            attachmentsFailed = true;
        }
    }

    if (attachmentsFailed && manifest.attachments.length > 0) {
        for (const a of decryptedAttachments) {
            try { URL.revokeObjectURL(a.blobUrl); } catch { /* ignore */ }
        }
        await commitPlaceholder(channelId, messageId, "failed");
        return;
    }

    const updateFields: Record<string, any> = { content: manifest.text };
    if (manifest.attachments.length > 0) updateFields.attachments = newAttachments;
    try {
        updateMessage(channelId, messageId, updateFields as any);
    } catch { /* ignore — message may have been deleted in flight */ }

    setEntry(messageId, {
        state: "decrypted",
        plaintext: manifest.text,
        attachments: decryptedAttachments.map(a => ({
            blobUrl: a.blobUrl,
            name: a.meta.name,
            mime: a.meta.mime,
            size: a.meta.size,
            spoiler: !!a.meta.spoiler,
            width: a.meta.width,
            height: a.meta.height
        }))
    });
}

async function commitPlaceholder(
    channelId: string,
    messageId: string,
    state: "vault-locked" | "locked-out" | "failed"
): Promise<void> {
    setEntry(messageId, { state });
    try {
        updateMessage(channelId, messageId, { content: placeholderForState(state) } as any);
    } catch { /* ignore */ }
}

function onVaultStateChange() {
    for (const messageId of Array.from(pendingByMessageId.keys())) {
        const entry = getEntry(messageId);
        if (entry?.state === "decrypted") continue;
        void decryptAndCommitSafe(messageId);
    }
}

function onMessageDelete(event: any) {
    const id = event?.id ?? event?.message?.id;
    if (typeof id === "string") {
        pendingByMessageId.delete(id);
        clearEntry(id);
    }
    const ids: any[] = event?.ids;
    if (Array.isArray(ids)) {
        for (const i of ids) {
            if (typeof i === "string") {
                pendingByMessageId.delete(i);
                clearEntry(i);
            }
        }
    }
}

/*
 * Flux-subscriber fallback for the receive path.
 *
 * The webpack patches above are best-effort: they run before the store
 * commits, so on the lucky path the user never sees a raw envelope at
 * all. If the regex misses on a future Discord build the message still
 * lands in the store with the encrypted body, which would otherwise
 * render as visible base64. These subscribers run *after* the store
 * handler so we use `updateMessage` to flip the content out, accepting
 * up to one frame of flash as the cost of keeping decrypt working
 * regardless of patch breakage.
 *
 * If the patch DID fire, by the time we look the content has already
 * been swapped to a placeholder so `decodeEnvelopeBody` returns null
 * and we no-op.
 */
function processIncomingPostStore(message: any, channelIdHint: string | null): void {
    if (!message || typeof message !== "object") return;
    if (typeof message.content !== "string") return;

    const decoded = decodeEnvelopeBody(message.content);
    if (!decoded) return;

    const channelId = channelIdHint
        ?? (typeof message.channel_id === "string" ? message.channel_id : null);
    if (!channelId) return;
    const messageId: string | null = typeof message.id === "string" ? message.id : null;
    if (!messageId) return;

    const authorId: string | null = typeof message.author?.id === "string" ? message.author.id : null;

    // Sender's own-message echo via the fallback. Same short-circuit as
    // preprocessMessage but committed via updateMessage since the store
    // already has the encrypted version at this point.
    const recent = recentSendsByEnvelopeB64.get(decoded.base64);
    if (recent) {
        const attachments = mintAttachmentsFromRecentSend(recent);
        const entry: DecryptionEntry = {
            state: "decrypted",
            plaintext: recent.plaintext,
            attachments
        };
        setEntry(messageId, entry);
        const newAttachments = buildDecryptedAttachmentList(message.attachments, messageId, attachments);
        const fields: Record<string, any> = { content: recent.plaintext };
        if (newAttachments) fields.attachments = newAttachments;
        try { updateMessage(channelId, messageId, fields as any); } catch { /* ignore */ }
        return;
    }

    const cached = getEntry(messageId);
    if (cached?.state === "decrypted" && cached.plaintext != null) {
        const newAttachments = cached.attachments
            ? buildDecryptedAttachmentList(message.attachments, messageId, cached.attachments)
            : null;
        const fields: Record<string, any> = { content: cached.plaintext };
        if (newAttachments) fields.attachments = newAttachments;
        try { updateMessage(channelId, messageId, fields as any); } catch { /* ignore */ }
        return;
    }

    const attachmentUrls: string[] = Array.isArray(message.attachments)
        ? message.attachments.map((a: any) => (typeof a?.url === "string" ? a.url : ""))
        : [];

    const previous = pendingByMessageId.get(messageId);
    const sameEnvelope = previous && previous.base64 === decoded.base64;
    if (!sameEnvelope) {
        pendingByMessageId.set(messageId, {
            envelope: decoded.envelope,
            base64: decoded.base64,
            channelId,
            attachmentUrls,
            authorId
        });
        setEntry(messageId, { state: "loading" });
    }

    const placeholder = placeholderForState(cached?.state ?? "loading");
    try { updateMessage(channelId, messageId, { content: placeholder } as any); } catch { /* ignore */ }

    if (!sameEnvelope) {
        Promise.resolve().then(() => decryptAndCommitSafe(messageId));
    }
}

function buildDecryptedAttachmentList(
    storeAttachments: any,
    messageId: string,
    cached: NonNullable<DecryptionEntry["attachments"]>
): any[] | null {
    if (!Array.isArray(storeAttachments)) return null;
    if (storeAttachments.length !== cached.length) return null;
    return storeAttachments.map((a, i) => ({
        ...a,
        id: `veil_${messageId}_${i}`,
        filename: cached[i].name,
        size: cached[i].size,
        // `proxy_url` carries the "#" to absorb Discord's appended
        // `?format=webp&width=…&height=…` thumbnail query. `url` stays
        // clean so downloads and "open original" work.
        url: cached[i].blobUrl,
        proxy_url: cached[i].blobUrl + "#",
        content_type: cached[i].mime,
        spoiler: cached[i].spoiler,
        width: cached[i].width,
        height: cached[i].height
    }));
}

function onFluxMessageCreate(event: any) {
    processIncomingPostStore(event?.message, event?.channelId ?? null);
}

function onFluxMessageUpdate(event: any) {
    const m = event?.message;
    processIncomingPostStore(m, m?.channel_id ?? null);
}

function onFluxLoadMessagesSuccess(event: any) {
    const messages = event?.messages;
    if (!Array.isArray(messages)) return;
    for (const m of messages) processIncomingPostStore(m, event?.channelId ?? null);
}

/* ---------------- Chatbar button ---------------- */

const VeilE2EButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const [enabled, setEnabledLocal] = useState(channel ? isEnabled(channel.id) : false);
    const [eligible, setEligible] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const channelId = channel?.id;
        setEnabledLocal(channelId ? isEnabled(channelId) : false);
        setEligible(false);

        if (!channel || !channel.isDM() || channel.isGroupDM()) return;
        const recipientUid = channel.getRecipientId?.();
        if (!recipientUid) return;

        void (async () => {
            try {
                const [available, binding] = await Promise.all([
                    VeilX25519.isAvailable(),
                    getActiveBindingForUid(recipientUid)
                ]);
                if (cancelled) return;
                setEligible(Boolean(available && binding));
            } catch {
                if (!cancelled) setEligible(false);
            }
        })();

        const onToggle = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || detail.channelId !== channelId) return;
            setEnabledLocal(Boolean(detail.enabled));
        };
        window.addEventListener("veil-e2e:toggle", onToggle as EventListener);

        return () => {
            cancelled = true;
            window.removeEventListener("veil-e2e:toggle", onToggle as EventListener);
        };
    }, [channel?.id]);

    if (!isMainChat || !channel) return null;
    if (!channel.isDM() || channel.isGroupDM()) return null;
    if (!eligible) return null;

    const tooltip = enabled
        ? "E2E mode is on. Click to turn off."
        : "Encrypt this DM end-to-end with this user's Veil key.";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => {
                const next = !enabled;
                setEnabled(channel.id, next);
                setEnabledLocal(next);
                if (next) broadcastE2eOn();
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
                <LockIcon height={20} width={20} locked={!enabled} />
            </span>
        </ChatBarButton>
    );
};

/* ---------------- Accessory: inline badge ---------------- */

function E2eAccessoryHost(props: any) {
    const message = props?.message;
    const id = typeof message?.id === "string" ? message.id : null;
    if (!id) return null;
    if (!getEntry(id)) return null;
    return <E2eBadge messageId={id} />;
}

/* ---------------- Plugin ---------------- */

export default definePlugin({
    name: "VeilE2EMessage",
    description: "End-to-end encrypts 1:1 DM text and attachments to the recipient's linked Veil key, and decrypts incoming envelopes in place at the message store level.",
    authors: [Devs.gabriele],
    dependencies: ["ChatInputButtonAPI", "MessageEventsAPI", "MessageAccessoriesAPI", "VeilCrypto", "VeilLinkKey"],
    required: true,

    managedStyle,

    /*
     * Patches:
     *
     * - MessageStore: substitute the raw "🔒 <base64> …" body with a
     *   placeholder synchronously, before the cache commits and React
     *   renders. Kills the per-decrypt reflow.
     *
     * - CloudUpload.prototype.upload: encrypt attachments inside the
     *   upload pipeline, right before bytes go on the wire. Doing this
     *   here (rather than in pre-send) avoids cancelling an already-
     *   in-flight upload, which Discord's pipeline can't recover from.
     */
    patches: [
        {
            find: '"MessageStore"',
            replacement: [
                {
                    match: /(?<=MESSAGE_CREATE:function\((\i)\){)/,
                    replace: (_: string, e: string) => `$self.preprocessMessage(${e}.message,${e}.channelId);`
                },
                {
                    match: /(?<=MESSAGE_UPDATE:function\((\i)\){)/,
                    replace: (_: string, e: string) => `$self.preprocessMessage(${e}.message,${e}.message&&${e}.message.channel_id);`
                },
                {
                    match: /(?<=LOAD_MESSAGES_SUCCESS:function\((\i)\){)/,
                    replace: (_: string, e: string) => `$self.preprocessMessages(${e}.messages,${e}.channelId);`
                }
            ]
        },
        {
            find: "webp conversion skipped",
            replacement: [
                {
                    match: /(?<=async upload\(\){)/,
                    replace: "await $self.encryptCloudUploadIfNeeded(this);"
                }
            ]
        }
    ],

    preprocessMessage,
    preprocessMessages,
    encryptCloudUploadIfNeeded,

    start() {
        addChatBarButton(BUTTON_ID, VeilE2EButton, LockIcon);
        addMessagePreSendListener(sendListener);
        addMessageAccessory(ACCESSORY_ID, E2eAccessoryHost, -1);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onFluxMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onFluxMessageUpdate);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onFluxLoadMessagesSuccess);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS_CACHED", onFluxLoadMessagesSuccess);
        FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete);
        FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDelete);
        window.addEventListener("veilcrypto:state-change", onVaultStateChange);
        window.addEventListener(MODE_SIGN_ON_EVENT, disableAllE2eChannels);
        document.addEventListener("click", onAttachmentDownloadClick, true);
    },

    stop() {
        removeChatBarButton(BUTTON_ID);
        removeMessagePreSendListener(sendListener);
        removeMessageAccessory(ACCESSORY_ID);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onFluxMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onFluxMessageUpdate);
        FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onFluxLoadMessagesSuccess);
        FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS_CACHED", onFluxLoadMessagesSuccess);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE", onMessageDelete);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", onMessageDelete);
        window.removeEventListener("veilcrypto:state-change", onVaultStateChange);
        window.removeEventListener(MODE_SIGN_ON_EVENT, disableAllE2eChannels);
        document.removeEventListener("click", onAttachmentDownloadClick, true);
        enabledByChannel.clear();
        pendingByMessageId.clear();
        recentSendsByEnvelopeB64.clear();
        clearAll();
    }
});
