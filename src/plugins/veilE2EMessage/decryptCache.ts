/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Per-message decryption state.
 *
 * The Flux mutation path swaps `message.content` to the decrypted text
 * and replaces `message.attachments[i].url` with blob: URLs once decrypt
 * resolves, but those mutations alone don't tell the receiver "this was
 * a Veil message and the flair pill should render". This cache is the
 * sidebar of truth: keyed by Discord message id, it records whether the
 * decrypt succeeded, failed, or is locked out, and tracks any blob URLs
 * we minted so we can revoke them when the message scrolls out.
 *
 * The cache is process-wide (module scope). The badge accessory and the
 * Flux post-processor both subscribe to `change` events.
 */

export type DecryptState = "loading" | "decrypted" | "locked-out" | "failed" | "vault-locked";

export interface DecryptedAttachmentMeta {
    blobUrl: string;
    name: string;
    mime: string;
    size: number;
    spoiler: boolean;
    width?: number;
    height?: number;
}

export interface DecryptionEntry {
    state: DecryptState;
    /** Decrypted plaintext text. Only set when state === "decrypted". */
    plaintext?: string;
    /** Owned blob URLs we created for this message. Set when state === "decrypted". */
    attachments?: DecryptedAttachmentMeta[];
}

const cache = new Map<string, DecryptionEntry>();
const bus = new EventTarget();

export function setEntry(messageId: string, entry: DecryptionEntry): void {
    const prev = cache.get(messageId);
    cache.set(messageId, entry);
    if (prev?.attachments && prev.attachments !== entry.attachments) {
        for (const a of prev.attachments) {
            try { URL.revokeObjectURL(a.blobUrl); } catch { /* ignore */ }
        }
    }
    bus.dispatchEvent(new CustomEvent("change", { detail: messageId }));
}

export function getEntry(messageId: string): DecryptionEntry | undefined {
    return cache.get(messageId);
}

export function clearEntry(messageId: string): void {
    const prev = cache.get(messageId);
    if (!prev) return;
    if (prev.attachments) {
        for (const a of prev.attachments) {
            try { URL.revokeObjectURL(a.blobUrl); } catch { /* ignore */ }
        }
    }
    cache.delete(messageId);
    bus.dispatchEvent(new CustomEvent("change", { detail: messageId }));
}

export function clearAll(): void {
    for (const id of Array.from(cache.keys())) clearEntry(id);
}

/**
 * Subscribe to entry changes. Listener gets the messageId that changed.
 */
export function subscribe(listener: (messageId: string) => void): () => void {
    const fn = (e: Event) => {
        const id = (e as CustomEvent).detail;
        if (typeof id === "string") listener(id);
    };
    bus.addEventListener("change", fn);
    return () => bus.removeEventListener("change", fn);
}
