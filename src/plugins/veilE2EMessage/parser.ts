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

/*
 * Manifest sentinel.
 *
 * Envelopes that carry attachments wrap the user's text plus per-file
 * crypto material in a JSON object. A literal sentinel prefix
 * disambiguates a manifest from a legacy raw-text envelope where the
 * user just happened to start their message with `{`.
 */
const MANIFEST_SENTINEL = "veilm1";

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

export interface ManifestAttachment {
    /** Original filename the sender uploaded (so we can present it back). */
    name: string;
    /** Original MIME type, used to render in the right element. */
    mime: string;
    /** Original size before we re-wrapped it as ciphertext. */
    size: number;
    /** AES-GCM-256 key for this file's ciphertext, base64. */
    key: string;
    /** AES-GCM IV, base64. */
    iv: string;
    /** Optional spoiler hint so we keep the spoiler overlay across decrypt. */
    spoiler?: boolean;
    /** Optional original width / height for images and videos so the layout
     * doesn't reflow once the decrypted blob loads. */
    width?: number;
    height?: number;
}

export interface VeilManifest {
    v: 1;
    text: string;
    attachments: ManifestAttachment[];
}

/**
 * Wrap a plaintext + attachment manifest into the string we hand to the
 * envelope encryptor. The sentinel prefix lets the receiver tell a v1
 * structured payload apart from a legacy raw-text payload.
 */
export function encodeManifestPayload(manifest: VeilManifest): string {
    return MANIFEST_SENTINEL + "\n" + JSON.stringify(manifest);
}

/**
 * Parse the envelope plaintext. Returns the structured manifest if the
 * sender sent one, otherwise treats the whole string as legacy raw text
 * with no attachments. Never throws on bad JSON; falls back to raw text.
 */
export function decodeManifestPayload(plaintext: string): VeilManifest {
    const sentinel = MANIFEST_SENTINEL + "\n";
    if (!plaintext.startsWith(sentinel)) {
        return { v: 1, text: plaintext, attachments: [] };
    }
    const body = plaintext.slice(sentinel.length);
    try {
        const parsed = JSON.parse(body);
        if (
            parsed &&
            typeof parsed === "object" &&
            parsed.v === 1 &&
            typeof parsed.text === "string" &&
            Array.isArray(parsed.attachments)
        ) {
            const attachments: ManifestAttachment[] = [];
            for (const att of parsed.attachments) {
                if (
                    !att ||
                    typeof att.name !== "string" ||
                    typeof att.mime !== "string" ||
                    typeof att.size !== "number" ||
                    typeof att.key !== "string" ||
                    typeof att.iv !== "string"
                ) continue;
                attachments.push({
                    name: att.name,
                    mime: att.mime,
                    size: att.size,
                    key: att.key,
                    iv: att.iv,
                    spoiler: typeof att.spoiler === "boolean" ? att.spoiler : undefined,
                    width: typeof att.width === "number" ? att.width : undefined,
                    height: typeof att.height === "number" ? att.height : undefined
                });
            }
            return { v: 1, text: parsed.text, attachments };
        }
    } catch {
        /* fall through to raw text */
    }
    return { v: 1, text: plaintext, attachments: [] };
}

/** Filename suffix used for the ciphertext blobs that get uploaded. */
export const CIPHERTEXT_FILENAME_SUFFIX = ".veilbin";
/** Marker MIME we set on uploaded ciphertext so receivers can spot a Veil attachment. */
export const CIPHERTEXT_MIME = "application/x-veil-encrypted";
