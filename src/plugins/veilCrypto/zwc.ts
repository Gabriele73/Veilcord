/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Zero-width Unicode steganography for Veil signed messages.
 *
 * v4 (current senders): [magic 2B] [version 1B] = 3 bytes -> 12 zero-width chars.
 *     The signature record is looked up by the Discord message id of the message
 *     itself, and the canonical body the sender signed binds discordMessageId,
 *     channelId and senderUid (see `signedBody.ts`).
 *
 * v3 (legacy, read-only): same wire shape as v4. Verifiers still accept v3
 *     markers and verify against the v1 legacy canonical body so already-shipped
 *     signed messages keep their badges. New senders only emit v4.
 *
 * v2 (retired): had an embedded 8-byte backend lookup id. Discontinued because
 *     v2 records could be copy-pasted onto any other Discord message and still
 *     produced a misleading "Signed" badge with the original canonical body.
 *
 * Each payload byte is encoded as 4 zero-width characters (2 bits each), trailing
 * the visible message body. The alphabet deliberately avoids U+200D (ZWJ) so emoji
 * ZWJ sequences in the visible message are not corrupted.
 */

const ALPHABET = ["​", "‌", "⁠", "⁣"]; // ZWSP, ZWNJ, WJ, INVISIBLE SEPARATOR
const ALPHABET_SET = new Set(ALPHABET);
const CHAR_TO_BITS = new Map<string, number>(ALPHABET.map((c, i) => [c, i]));

const MAGIC = new Uint8Array([0x56, 0xE1]);
const VERSION_V3 = 3;
const VERSION_V4 = 4;

const PAYLOAD_BYTES = MAGIC.length + 1;
const OVERHEAD_CHARS = PAYLOAD_BYTES * 4;

/** Char count appended by the current sender. */
export const ZWC_OVERHEAD_CHARS = OVERHEAD_CHARS;
/** Version the current sender stamps into the trailer. */
export const SIGNED_MESSAGE_VERSION = VERSION_V4;

export interface DecodedSignedMessageRef {
    /** Visible message body, with the ZWC trailer stripped. */
    message: string;
    /** Encoded payload version (3 = legacy, 4 = current). */
    v: number;
}

/** Encode the current "this message is signed" marker (v4). */
export function encodeMarker(): string {
    const buf = new Uint8Array(PAYLOAD_BYTES);
    buf.set(MAGIC, 0);
    buf[MAGIC.length] = VERSION_V4;
    return bytesToZwc(buf);
}

/** Decode a v3 or v4 signed-message reference from a Discord message body. */
export function decodeRef(content: string): DecodedSignedMessageRef | null {
    if (typeof content !== "string" || content.length === 0) return null;

    let end = content.length;
    while (end > 0 && ALPHABET_SET.has(content[end - 1])) end--;
    const suffixLen = content.length - end;
    if (suffixLen < OVERHEAD_CHARS) return null;

    const run = content.slice(content.length - OVERHEAD_CHARS);
    const bytes = zwcToBytes(run);
    if (!bytes) return null;
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return null;
    const version = bytes[2];
    if (version !== VERSION_V3 && version !== VERSION_V4) return null;

    let bodyEnd = content.length - OVERHEAD_CHARS;
    while (bodyEnd > 0 && ALPHABET_SET.has(content[bodyEnd - 1])) bodyEnd--;
    const message = content.slice(0, bodyEnd);
    return { message, v: version };
}

export function hasSignedMessageRef(content: unknown): boolean {
    return typeof content === "string" && decodeRef(content) !== null;
}

function bytesToZwc(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += ALPHABET[(b >> 6) & 0x3];
        out += ALPHABET[(b >> 4) & 0x3];
        out += ALPHABET[(b >> 2) & 0x3];
        out += ALPHABET[b & 0x3];
    }
    return out;
}

function zwcToBytes(zwc: string): Uint8Array | null {
    if (zwc.length % 4 !== 0) return null;
    const bytes = new Uint8Array(zwc.length / 4);
    for (let i = 0; i < bytes.length; i++) {
        let b = 0;
        for (let j = 0; j < 4; j++) {
            const v = CHAR_TO_BITS.get(zwc[i * 4 + j]);
            if (v === undefined) return null;
            b = (b << 2) | v;
        }
        bytes[i] = b;
    }
    return bytes;
}
