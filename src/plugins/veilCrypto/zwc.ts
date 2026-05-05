/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Zero-width Unicode steganography for Veil signed messages.
 *
 * Layout (binary, before ZWC encoding):
 *     [magic 2B] [version 1B] [pubkey 32B] [signature 64B] = 99 bytes
 *
 * Each byte is encoded as 4 zero-width characters (2 bits each), so the
 * full payload occupies 396 invisible chars. The payload is appended at the
 * end of the visible message; receivers strip any trailing ZWC alphabet
 * characters and decode the last 396.
 *
 * Alphabet deliberately avoids U+200D (ZWJ) so emoji ZWJ sequences in the
 * visible message are not corrupted.
 */

const ALPHABET = ["\u200B", "\u200C", "\u2060", "\u2063"]; // ZWSP, ZWNJ, WJ, INVISIBLE SEPARATOR
const ALPHABET_SET = new Set(ALPHABET);
const CHAR_TO_BITS = new Map<string, number>(ALPHABET.map((c, i) => [c, i]));

const MAGIC = new Uint8Array([0x56, 0xE1]);
const VERSION = 1;
const PUB_BYTES = 32;
const SIG_BYTES = 64;
const PAYLOAD_BYTES = MAGIC.length + 1 + PUB_BYTES + SIG_BYTES;

export const ZWC_OVERHEAD_CHARS = PAYLOAD_BYTES * 4;

export interface DecodedSignature {
    message: string;
    publicKey: string;
    signature: string;
    v: number;
}

export function encodeSignature(publicKeyHex: string, signatureHex: string): string {
    if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
        throw new Error("Invalid public key (must be 64 hex chars)");
    }
    if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) {
        throw new Error("Invalid signature (must be 128 hex chars)");
    }

    const buf = new Uint8Array(PAYLOAD_BYTES);
    let off = 0;
    buf.set(MAGIC, off); off += MAGIC.length;
    buf[off++] = VERSION;
    buf.set(hexToBytes(publicKeyHex), off); off += PUB_BYTES;
    buf.set(hexToBytes(signatureHex), off);
    return bytesToZwc(buf);
}

export function decodeSignature(content: string): DecodedSignature | null {
    if (typeof content !== "string" || content.length === 0) return null;

    let end = content.length;
    while (end > 0 && ALPHABET_SET.has(content[end - 1])) end--;
    const suffixLen = content.length - end;
    if (suffixLen < ZWC_OVERHEAD_CHARS) return null;

    const run = content.slice(content.length - ZWC_OVERHEAD_CHARS);
    const bytes = zwcToBytes(run);
    if (!bytes) return null;
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return null;

    const v = bytes[2];
    if (v !== VERSION) return null;

    const pubStart = MAGIC.length + 1;
    const sigStart = pubStart + PUB_BYTES;
    const publicKey = bytesToHex(bytes.slice(pubStart, sigStart));
    const signature = bytesToHex(bytes.slice(sigStart, sigStart + SIG_BYTES));

    const message = content.slice(0, content.length - suffixLen);

    return { message, publicKey, signature, v };
}

export function hasSignature(content: unknown): boolean {
    return typeof content === "string" && decodeSignature(content) !== null;
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

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

function bytesToHex(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i++) {
        s += b[i].toString(16).padStart(2, "0");
    }
    return s;
}
