/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Canonical signed-message body.
 *
 * v4 (current): the signed body binds the Discord message id, channel
 * id, and sender Discord uid alongside the user's text and attachment
 * hashes. The verifier rebuilds this canonical from the live message's
 * own fields, so a captured signature cannot be reused against any
 * other (message id, channel, sender) triple. Layout:
 *
 *     veil/v4
 *     mid=<discord message id>
 *     cid=<channel id>
 *     uid=<sender discord uid>
 *     n=<attachment count>
 *     <sha256_hex_attachment_0>
 *     ...
 *     <sha256_hex_attachment_{N-1}>
 *     text:
 *     <user text>
 *
 * User text is the last field, so any byte inside it (newlines, the
 * v1 `[veil:atts:v1]` tag, anything) is unambiguous: the verifier
 * never parses user text — it reconstructs the canonical from known
 * live-message fields and compares signatures.
 *
 * v1 (legacy, text-only): the signed body is exactly the user's typed
 * message, no separators. This is what older clients shipped and what
 * the Veil backend stores in its `message` field for legacy v3
 * records that predate v4. Kept for backwards reads.
 *
 * v1-with-attachments (legacy): the signed body is
 *
 *     <text>\n\n[veil:atts:v1]\n<sha256_hex_attachment_0>\n<sha256_hex_attachment_1>\n...
 *
 * Both sender and verifier MUST produce the same string from the same
 * inputs, so this module is the single source of truth.
 */

const ATT_HEADER = "[veil:atts:v1]";
const ATT_BLOCK_START = `\n\n${ATT_HEADER}\n`;

export interface CanonicalAttachment {
    sha256Hex: string;
}

export interface CanonicalContext {
    /** Discord message id of the message being signed. */
    discordMessageId: string;
    /** Discord channel id the message lives in. */
    channelId: string;
    /** Discord uid of the sender (message.author.id at sign time). */
    senderUid: string;
}

/**
 * Strip any literal occurrence of the attachment header from the user
 * text so a malicious sender can't put `[veil:atts:v1]` in their message
 * and have a verifier without attachments interpret a forged block as
 * legitimate. v4 doesn't need this guard (user text is fenced after
 * `text:`), only the legacy v1 helpers do.
 */
function assertNoCollision(text: string): void {
    if (text.includes(ATT_HEADER)) {
        throw new Error("Message text contains a reserved Veil tag");
    }
}

/**
 * Build the canonical v4 signed body. Binds discordMessageId, channelId
 * and senderUid into the bytes Ed25519 signs over, so the same signature
 * cannot be reused against any other Discord message.
 */
export function buildCanonicalSignedBodyV4(
    text: string,
    attachments: CanonicalAttachment[],
    ctx: CanonicalContext
): string {
    if (!ctx.discordMessageId || !ctx.channelId || !ctx.senderUid) {
        throw new Error("v4 canonical body requires discordMessageId, channelId and senderUid");
    }
    const lines: string[] = [
        "veil/v4",
        `mid=${ctx.discordMessageId}`,
        `cid=${ctx.channelId}`,
        `uid=${ctx.senderUid}`,
        `n=${attachments.length}`
    ];
    for (const a of attachments) lines.push(a.sha256Hex.toLowerCase());
    lines.push("text:");
    return lines.join("\n") + "\n" + text;
}

/**
 * Legacy v1: signed body for a message with no attachments.
 */
export function canonicalTextBody(text: string): string {
    assertNoCollision(text);
    return text;
}

/**
 * Legacy v1: signed body for a message that has attachments.
 */
export function canonicalBodyWithAttachments(text: string, attachments: CanonicalAttachment[]): string {
    assertNoCollision(text);
    if (attachments.length === 0) return text;
    const lines = attachments.map(a => a.sha256Hex.toLowerCase());
    return text + ATT_BLOCK_START + lines.join("\n");
}

/**
 * Legacy v1: pick the right encoding given an attachment count.
 */
export function buildCanonicalSignedBody(text: string, attachments: CanonicalAttachment[]): string {
    return attachments.length === 0
        ? canonicalTextBody(text)
        : canonicalBodyWithAttachments(text, attachments);
}

/**
 * True if the text contains the v1 attachment header. Lets a verifier
 * skip the attachment-hashing pass when it knows the sender used the
 * legacy text-only canonicalization.
 */
export function bodyHasAttachmentBlock(body: string): boolean {
    return body.includes(ATT_HEADER);
}

/**
 * Strip the trailing v1 attachment block from a canonical body so
 * callers (e.g. the verify modal) can display just the user's typed
 * text. Returns the input unchanged if no attachment block is present.
 */
export function stripAttachmentBlock(body: string): string {
    const idx = body.indexOf(ATT_BLOCK_START);
    if (idx < 0) return body;
    return body.slice(0, idx);
}

