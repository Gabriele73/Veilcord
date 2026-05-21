/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher } from "@webpack/common";

import type { VeilMember } from "../api/members";
import { ensureAuthorInjected } from "../messages/buildMessagePayload";

/**
 * Convert Veil server members into Discord's GUILD_MEMBERS_CHUNK shape so
 * the right rail renders with native components (avatar, presence dot,
 * role-coloured names).
 *
 * Members carry a synthetic Discord uid derived from the Veil pubkey via
 * `veilPubkeyToSyntheticUid` (idempotent + deterministic). The member's
 * own user record is pushed into UserStore via `ensureAuthorInjected`
 * before the chunk dispatch so GuildMemberStore has a hydrated user to
 * reference.
 */

function veilStatusToDiscord(status: string | undefined): string {
    switch ((status || "").toLowerCase()) {
        case "online": return "online";
        case "idle": return "idle";
        case "dnd": case "do_not_disturb": return "dnd";
        default: return "offline";
    }
}

function buildMemberRecord(member: VeilMember, syntheticGuildId: string): any {
    const userId = ensureAuthorInjected({
        pubkey: member.pubkey,
        username: member.serverNickname || member.username,
        avatar: member.avatar,
        badges: member.badges
    });
    return {
        guild_id: syntheticGuildId,
        user: {
            id: userId,
            username: member.username,
            global_name: member.username,
            discriminator: "0000",
            avatar: null,
            bot: false,
            // Shadow fields for our avatar patch + future profile lookups.
            veilAvatarUrl: member.avatar || null,
            veilPubkey: (member.pubkey || "").toLowerCase(),
            veilBadges: Number(member.badges) || 0
        },
        nick: member.serverNickname || null,
        avatar: null,
        roles: [],
        joined_at: new Date(Number(member.joinedAt) || Date.now()).toISOString(),
        premium_since: null,
        deaf: false,
        mute: false,
        flags: 0,
        pending: false,
        // Stash for downstream presence resolution / debugging.
        veilPubkey: (member.pubkey || "").toLowerCase(),
        veilRoles: Number(member.roles) || 0
    };
}

function buildPresence(member: VeilMember, userId: string, syntheticGuildId: string): any {
    const status = veilStatusToDiscord(member.status);
    return {
        user: { id: userId },
        guild_id: syntheticGuildId,
        status,
        client_status: status === "offline" ? {} : { web: status },
        activities: [],
        last_modified: Number(member.lastSeen) || Date.now()
    };
}

/**
 * Dispatch members + presences for a guild. Idempotent on the dispatcher
 * side: a duplicate chunk just refreshes the records with current data.
 */
export function dispatchMemberChunk(syntheticGuildId: string, members: VeilMember[]): void {
    if (!Array.isArray(members) || members.length === 0) return;

    const memberRecords: any[] = [];
    const presences: any[] = [];
    for (const m of members) {
        const record = buildMemberRecord(m, syntheticGuildId);
        memberRecords.push(record);
        presences.push(buildPresence(m, record.user.id, syntheticGuildId));
    }

    FluxDispatcher.dispatch({
        type: "GUILD_MEMBERS_CHUNK",
        guildId: syntheticGuildId,
        members: memberRecords,
        presences,
        notFound: [],
        chunkIndex: 0,
        chunkCount: 1,
        nonce: null
    });
}
