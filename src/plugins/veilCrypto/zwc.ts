/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Zero-width Unicode steganography for Veil signed messages.
 *
 * Two payload layouts coexist:
 *
 *   v3 (current senders): [magic 2B] [version 1B] = 3 bytes -> 12 zero-width chars.
 *       No backend id is embedded — verifiers look up the signature record by the
 *       Discord message id of the message itself.
 *
 *   v2 (legacy, read-only):  [magic 2B] [version 1B] [id 8B] = 11 bytes -> 44 chars.
 *       The trailing 8 bytes encode a backend lookup id. We still decode v2
 *       records so already-shipped signed messages keep verifying.
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
const VERSION_V2 = 2;

const V3_PAYLOAD_BYTES = MAGIC.length + 1;
const V2_ID_BYTES = 8;
const V2_PAYLOAD_BYTES = MAGIC.length + 1 + V2_ID_BYTES;

const V3_OVERHEAD_CHARS = V3_PAYLOAD_BYTES * 4;
const V2_OVERHEAD_CHARS = V2_PAYLOAD_BYTES * 4;

/** Char count appended by the current sender (v3). */
export const ZWC_OVERHEAD_CHARS = V3_OVERHEAD_CHARS;
export const SIGNED_MESSAGE_VERSION = VERSION_V3;
export const SIGNED_MESSAGE_ID_HEX_LEN = V2_ID_BYTES * 2;

export interface DecodedSignedMessageRef {
    /** Visible message body, with the ZWC trailer stripped. */
    message: string;
    /** Encoded payload version. */
    v: number;
    /** Lowercase hex backend id. Present only on v2 records; v3 looks up by Discord message id. */
    id?: string;
}

/** Encode the v3 "this message is signed" marker. */
export function encodeMarker(): string {
    const buf = new Uint8Array(V3_PAYLOAD_BYTES);
    buf.set(MAGIC, 0);
    buf[MAGIC.length] = VERSION_V3;
    return bytesToZwc(buf);
}

/** Decode any supported (v2 or v3) signed-message reference from a Discord message body. */
export function decodeRef(content: string): DecodedSignedMessageRef | null {
    if (typeof content !== "string" || content.length === 0) return null;

    let end = content.length;
    while (end > 0 && ALPHABET_SET.has(content[end - 1])) end--;
    const suffixLen = content.length - end;
    if (suffixLen < V3_OVERHEAD_CHARS) return null;

    if (suffixLen >= V2_OVERHEAD_CHARS) {
        const v2 = tryDecodeV2(content);
        if (v2) return v2;
    }

    return tryDecodeV3(content);
}

export function hasSignedMessageRef(content: unknown): boolean {
    return typeof content === "string" && decodeRef(content) !== null;
}

function tryDecodeV3(content: string): DecodedSignedMessageRef | null {
    const run = content.slice(content.length - V3_OVERHEAD_CHARS);
    const bytes = zwcToBytes(run);
    if (!bytes) return null;
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return null;
    if (bytes[2] !== VERSION_V3) return null;

    let end = content.length - V3_OVERHEAD_CHARS;
    while (end > 0 && ALPHABET_SET.has(content[end - 1])) end--;
    const message = content.slice(0, end);
    return { message, v: VERSION_V3 };
}

function tryDecodeV2(content: string): DecodedSignedMessageRef | null {
    const run = content.slice(content.length - V2_OVERHEAD_CHARS);
    const bytes = zwcToBytes(run);
    if (!bytes) return null;
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return null;
    if (bytes[2] !== VERSION_V2) return null;

    const id = bytesToHex(bytes.slice(MAGIC.length + 1));
    let end = content.length - V2_OVERHEAD_CHARS;
    while (end > 0 && ALPHABET_SET.has(content[end - 1])) end--;
    const message = content.slice(0, end);
    return { message, v: VERSION_V2, id };
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

function bytesToHex(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i++) {
        s += b[i].toString(16).padStart(2, "0");
    }
    return s;
}
