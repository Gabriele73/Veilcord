/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Canonical signed-message body.
 *
 * v1 (text-only): the signed body is exactly the user's typed message,
 * no separators. This matches what older clients shipped and what the
 * Veil backend stores in its `message` field for v2/v3 records that
 * predate attachment binding.
 *
 * v2 (text + attachments): the signed body is
 *
 *     <text>\n\n[veil:atts:v1]\n<sha256_hex_attachment_0>\n<sha256_hex_attachment_1>\n...
 *
 * The attachment hashes are SHA-256 of the raw file bytes the sender
 * uploaded (NOT of any Discord re-encoded thumbnail), in the same order
 * as `message.attachments` on the receiver. The header tag is escaped
 * (we strip any literal occurrence from the user text via canonicalize)
 * so a user can never craft a body that imitates a v2 attachment block.
 *
 * Both sender and verifier MUST produce the same string from the same
 * inputs, so this module is the single source of truth.
 */

const ATT_HEADER = "[veil:atts:v1]";
const ATT_BLOCK_START = `\n\n${ATT_HEADER}\n`;

export interface CanonicalAttachment {
    sha256Hex: string;
}

/**
 * Strip any literal occurrence of the attachment header from the user
 * text so a malicious sender can't put `[veil:atts:v1]` in their message
 * and have a verifier without attachments interpret a forged block as
 * legitimate. We just refuse to canonicalize text containing the tag.
 */
function assertNoCollision(text: string): void {
    if (text.includes(ATT_HEADER)) {
        throw new Error("Message text contains a reserved Veil tag");
    }
}

/**
 * Build the canonical signed body for a message with no attachments.
 * Equivalent to v1 (legacy text-only body).
 */
export function canonicalTextBody(text: string): string {
    assertNoCollision(text);
    return text;
}

/**
 * Build the canonical signed body for a message that has attachments.
 */
export function canonicalBodyWithAttachments(text: string, attachments: CanonicalAttachment[]): string {
    assertNoCollision(text);
    if (attachments.length === 0) return text;
    const lines = attachments.map(a => a.sha256Hex.toLowerCase());
    return text + ATT_BLOCK_START + lines.join("\n");
}

/**
 * Pick the right canonical encoding given an attachment count. Exposed
 * so callers don't have to remember which variant to use.
 */
export function buildCanonicalSignedBody(text: string, attachments: CanonicalAttachment[]): string {
    return attachments.length === 0
        ? canonicalTextBody(text)
        : canonicalBodyWithAttachments(text, attachments);
}

/**
 * True if the text contains the v2 attachment header. Lets the verifier
 * skip the (sometimes-expensive) attachment hashing pass when it knows
 * the sender used the legacy v1 canonicalization.
 *
 * NOTE: this looks at the *signed body*, not the raw Discord content.
 * The verifier already strips the ZWC trailer before passing it here.
 */
export function bodyHasAttachmentBlock(body: string): boolean {
    return body.includes(ATT_HEADER);
}

/**
 * Strip the trailing v2 attachment block from a canonical body so
 * callers (e.g. the verify modal) can display just the user's typed
 * text. Returns the input unchanged if no attachment block is present.
 */
export function stripAttachmentBlock(body: string): string {
    const idx = body.indexOf(ATT_BLOCK_START);
    if (idx < 0) return body;
    return body.slice(0, idx);
}
