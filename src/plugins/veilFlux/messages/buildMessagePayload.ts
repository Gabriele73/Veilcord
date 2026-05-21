/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { findByCodeLazy } from "@webpack";
import { FluxDispatcher, UserStore } from "@webpack/common";

import type { VeilMessage, VeilMessageAuthor } from "../api/messages";
import { makeSnowflake } from "../records/buildGuildPayload";

/**
 * Convert Veil author records into Discord-shaped User / Message records
 * so the chat shell renders them through the regular component tree
 * (avatar, name, markdown, mention rendering, copy-link, all of it).
 *
 * Pubkeys → synthetic Discord user ids via a deterministic 14-hex-prefix
 * BigInt cast. Stable per-pubkey across sessions; lives in the
 * `9991<14 decimal>` namespace so it never collides with a real Discord
 * id and signals "Veil-originated user" to backend / fixture tooling.
 */

const createMessageRecord: any = findByCodeLazy(
    ".createFromServer(",
    ".isBlockedForMessage",
    "messageReference:"
);

/**
 * Discord's UserRecord constructor isn't on @webpack/common; pull it off
 * the live currentUser instance the same way veilSystemDM/api.ts does.
 */
const UserRecord: any = proxyLazy(() => (UserStore.getCurrentUser() as any).constructor);

const VEIL_USER_NAMESPACE_PREFIX = "9991";
const VEIL_USER_DECIMAL_DIGITS = 14;

const seenSyntheticAuthors = new Set<string>();

export function veilPubkeyToSyntheticUid(pubkey: string): string {
    const head = (pubkey || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 14);
    if (head.length === 0) {
        return VEIL_USER_NAMESPACE_PREFIX + "0".repeat(VEIL_USER_DECIMAL_DIGITS);
    }
    let big = BigInt("0x" + head);
    // Cap into ~46 bits to keep total length predictable; collisions still
    // require ~33 million distinct pubkeys to hit a 50% birthday bound.
    big = big % (1n << 46n);
    const decimal = big.toString().padStart(VEIL_USER_DECIMAL_DIGITS, "0").slice(0, VEIL_USER_DECIMAL_DIGITS);
    return VEIL_USER_NAMESPACE_PREFIX + decimal;
}

/**
 * Build a User-like raw object Discord's UserRecord constructor accepts.
 * Pulls nickname / avatar / badges from the Veil author payload.
 */
function buildAuthorRaw(author: VeilMessageAuthor): any {
    const id = veilPubkeyToSyntheticUid(author.pubkey);
    return {
        id,
        username: String(author.username || "Veil user"),
        globalName: String(author.username || "Veil user"),
        global_name: String(author.username || "Veil user"),
        discriminator: "0000",
        avatar: null,
        bot: false,
        system: false,
        flags: 0,
        publicFlags: 0,
        public_flags: 0,
        accentColor: null,
        banner: null,
        // Custom field stash so downstream UI plumbing can read avatar URLs
        // and pubkey provenance without going through getAvatarURL().
        veilAvatarUrl: author.avatar || null,
        veilPubkey: (author.pubkey || "").toLowerCase(),
        veilBadges: Number(author.badges) || 0
    };
}

/**
 * Push a Veil author into UserStore so PrivateChannel / MessageHeader
 * components can render avatar + name without falling through to "?".
 * Idempotent on the synthetic uid set.
 */
export function ensureAuthorInjected(author: VeilMessageAuthor): string {
    const raw = buildAuthorRaw(author);
    if (seenSyntheticAuthors.has(raw.id)) return raw.id;
    try {
        const user = new UserRecord(raw);
        FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
        seenSyntheticAuthors.add(raw.id);
    } catch (err) {
        console.warn("[VeilFlux] failed to inject author user record", err);
    }
    return raw.id;
}

/**
 * Build the raw message payload Discord's createMessageRecord factory
 * accepts. Mirrors the gateway MESSAGE_CREATE shape. The id we emit is
 * a Discord-shaped snowflake derived from the message's server timestamp
 * so chat ordering uses the real send time, not the order we received
 * fetch results in.
 *
 * The snowflake is salted with a 12-bit increment derived from a hash
 * of the Veil message uuid so two messages produced in the same
 * millisecond don't collide.
 */
export function buildRawMessage(
    channelId: string,
    msg: VeilMessage,
    authorRaw: any
): any {
    const inc = veilUuidIncrement(msg.id);
    const snowflake = makeSnowflake(msg.timestamp, inc);
    const isoTs = new Date(msg.timestamp).toISOString();
    return {
        id: snowflake,
        type: 0,
        channel_id: channelId,
        author: authorRaw,
        content: String(msg.content ?? ""),
        timestamp: isoTs,
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        reactions: [],
        pinned: false,
        flags: 0,
        // Stash the canonical Veil ids so future code can map back without
        // re-deriving from the snowflake.
        veilMessageId: msg.id,
        veilSignature: msg.signature,
        veilNonce: msg.nonce,
        veilAuthorPubkey: (msg.author?.pubkey || "").toLowerCase()
    };
}

function veilUuidIncrement(uuid: string): number {
    // Deterministic 12-bit increment from a Veil message uuid so messages
    // sharing a millisecond timestamp produce distinct snowflakes.
    let hash = 0;
    const s = String(uuid || "");
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) & 0xfff;
}

/**
 * Convenience: fully prepare a Veil message for dispatch. Injects the
 * author into UserStore, builds the raw payload, and runs it through
 * Discord's MessageRecord factory.
 */
export function toMessageRecord(channelId: string, msg: VeilMessage): any {
    const authorRaw = buildAuthorRaw(msg.author);
    if (!seenSyntheticAuthors.has(authorRaw.id)) {
        try {
            const user = new UserRecord(authorRaw);
            FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
            seenSyntheticAuthors.add(authorRaw.id);
        } catch (err) {
            console.warn("[VeilFlux] failed to inject author user record", err);
        }
    }
    const raw = buildRawMessage(channelId, msg, authorRaw);
    try {
        return createMessageRecord(raw);
    } catch (err) {
        console.warn("[VeilFlux] createMessageRecord failed; returning raw", err);
        return raw;
    }
}
