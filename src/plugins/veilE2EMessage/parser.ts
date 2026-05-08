/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const ENCRYPTED_FOOTER_LINE = "This message was encrypted with Veilcord";
export const ENCRYPTED_PREFIX = "🔒 ";

const BODY_REGEX = /^🔒 ([A-Za-z0-9_-]+)\nThis message was encrypted with Veilcord\s*$/;

const E2E_ENVELOPE_MAGIC_0 = 0x56;
const E2E_ENVELOPE_MAGIC_1 = 0xE2;
const E2E_ENVELOPE_VERSION = 0x02;

// Minimum v2 envelope = header (48) + one slot (48) + payload tag (16).
// Anything shorter is definitely not a valid envelope, so we cheaply
// reject before handing off to the service for the real parse.
const E2E_MIN_ENVELOPE_BYTES = 1 + 2 + 32 + 12 + 1 + 48 + 16;

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64: string): Uint8Array | null {
    try {
        const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

export function encodeEnvelopeBody(envelope: Uint8Array): string {
    const b64 = bytesToBase64Url(envelope);
    return `${ENCRYPTED_PREFIX}${b64}\n${ENCRYPTED_FOOTER_LINE}`;
}

export interface ParsedEnvelopeBody {
    envelope: Uint8Array;
    base64: string;
}

export function decodeEnvelopeBody(content: unknown): ParsedEnvelopeBody | null {
    if (typeof content !== "string" || content.length === 0) return null;
    const match = BODY_REGEX.exec(content);
    if (!match) return null;
    const envelope = base64UrlToBytes(match[1]);
    if (!envelope || envelope.length < E2E_MIN_ENVELOPE_BYTES) return null;
    if (envelope[0] !== E2E_ENVELOPE_VERSION) return null;
    if (envelope[1] !== E2E_ENVELOPE_MAGIC_0) return null;
    if (envelope[2] !== E2E_ENVELOPE_MAGIC_1) return null;
    return { envelope, base64: match[1] };
}

export function hasE2eEnvelope(content: unknown): boolean {
    return decodeEnvelopeBody(content) !== null;
}
