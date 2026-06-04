/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByProps } from "@webpack";
import {
    ChannelStore,
    GuildChannelStore,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    PermissionStore,
    UserStore
} from "@webpack/common";

import type { VeilMember } from "./api/members";
import type { VeilChannelRecord, VeilServerSummary } from "./api/servers";
import { isVeilChannelId, isVeilGuildId, registerEntity } from "./idMap";
import { veilPubkeyToSyntheticUid } from "./messages/buildMessagePayload";

/**
 * Store-level shim layer for Veil guilds. Replaces the Phase 2 approach
 * of dispatching GUILD_CREATE through Discord's FluxDispatcher, which
 * fights an ever-shifting set of internal stores (GuildRoleStore,
 * ReadStateStore, billing, lazy-guild requests over the gateway, ...).
 *
 * Instead we monkey-patch the read methods of the stores Discord's chat
 * shell consults at render time and short-circuit any veil-id lookup to
 * the data we hold in-memory. Real Discord ids fall through to the
 * original implementation untouched. On `stop()` every patched method is
 * restored exactly so disabling VeilFlux leaves Discord in a clean
 * state.
 */

const VEIL_SYNTH_OWNER_PREFIX = "9999990000000000";

interface VeilGuildData {
    summary: VeilServerSummary;
    syntheticId: string;
    everyoneRole: any;
    record: any;
    /** synthetic channel id → real Discord channel record (from CHANNEL_CREATE factory) */
    channelRecords: Map<string, any>;
    members: VeilMember[];
}

const guildDataMap = new Map<string, VeilGuildData>();

function syntheticOwnerId(serverId: number): string {
    const tail = String(serverId % 10000).padStart(4, "0");
    return VEIL_SYNTH_OWNER_PREFIX.slice(0, VEIL_SYNTH_OWNER_PREFIX.length - tail.length) + tail;
}

function buildEveryoneRole(syntheticGuildId: string): any {
    return {
        id: syntheticGuildId,
        name: "@everyone",
        // Discord normally parses role.permissions from a string to BigInt
        // on GUILD_CREATE. We bypass GUILD_CREATE (store-patches path),
        // so we must hand Discord's internal computeBasePermissions a
        // BigInt directly. A string here makes `acc | role.permissions`
        // throw "Cannot mix BigInt and other types".
        permissions: 0n,
        position: 0,
        color: 0,
        hoist: false,
        managed: false,
        mentionable: false,
        flags: 0,
        unicode_emoji: null,
        icon: null,
        tags: {}
    };
}

function buildGuildRecordObject(summary: VeilServerSummary, syntheticId: string, everyoneRole: any): any {
    // Owner-shortcut: pin ownerId to the *current* Discord user. Discord's
    // permission code paths short-circuit on owner — they skip role math,
    // skip the BigInt arithmetic in computeBasePermissions / computePermissions,
    // and grant everything. This avoids the "Cannot mix BigInt and other types"
    // crash that fires when our patched PermissionStore returns BigInt and
    // some caller mixes it with Number. Falls back to a synthetic id only
    // if UserStore isn't ready yet.
    const self = UserStore?.getCurrentUser?.();
    const ownerId = self?.id ?? syntheticOwnerId(summary.id);
    const joinedAt = new Date();
    return {
        id: syntheticId,
        name: summary.name,
        icon: summary.icon ?? null,
        description: summary.description ?? null,
        ownerId,
        owner_id: ownerId,
        roles: { [syntheticId]: everyoneRole },
        emojis: [],
        stickers: [],
        features: new Set<string>(),
        memberCount: Math.max(summary.memberCount ?? 1, 1),
        verificationLevel: 0,
        defaultMessageNotifications: 1,
        explicitContentFilter: 0,
        mfaLevel: 0,
        nsfwLevel: 0,
        premiumTier: 0,
        premiumSubscriptionCount: 0,
        joinedAt,
        applicationId: null,
        afkChannelId: null,
        afkTimeout: 60,
        systemChannelId: null,
        systemChannelFlags: 0,
        rulesChannelId: null,
        publicUpdatesChannelId: null,
        safetyAlertsChannelId: null,
        preferredLocale: "en-US",
        vanityURLCode: null,
        banner: null,
        splash: null,
        discoverySplash: null,
        homeHeader: null,
        nsfw: false,
        unavailable: false,
        large: false,
        premiumProgressBarEnabled: false,
        // Methods Discord's components occasionally call on Guild records.
        // Stub each to a sensible default for the synthetic guild.
        getEveryoneRoleId: () => syntheticId,
        getEveryoneRole: () => everyoneRole,
        getRole: (roleId: string) => roleId === syntheticId ? everyoneRole : null,
        getApplicationId: () => null,
        getMaxEmojiSlots: () => 50,
        getMaxRoleSubscriptionEmojiSlots: () => 0,
        getIconURL: () => null,
        getIconSource: () => null,
        getBannerURL: () => null,
        hasFeature: () => false,
        isCommunity: () => false,
        isHub: () => false,
        isOwner: (user: any) => user?.id === ownerId,
        isOwnerWithRequiredMfaLevel: () => false,
        canHaveRaidActivityAlerts: () => false
    };
}

export function registerVeilGuild(summary: VeilServerSummary): string {
    const syntheticId = registerEntity("server", summary.id, summary.uuid);
    const existing = guildDataMap.get(syntheticId);
    if (existing) {
        // Refresh metadata in place so name/icon/memberCount changes show up.
        existing.summary = summary;
        Object.assign(existing.record, {
            name: summary.name,
            icon: summary.icon ?? null,
            description: summary.description ?? null,
            memberCount: Math.max(summary.memberCount ?? 1, 1)
        });
        return syntheticId;
    }
    const everyoneRole = buildEveryoneRole(syntheticId);
    const record = buildGuildRecordObject(summary, syntheticId, everyoneRole);
    guildDataMap.set(syntheticId, {
        summary,
        syntheticId,
        everyoneRole,
        record,
        channelRecords: new Map(),
        members: []
    });
    return syntheticId;
}

export function unregisterVeilGuild(syntheticId: string): void {
    guildDataMap.delete(syntheticId);
}

export function unregisterAllVeilGuilds(): void {
    guildDataMap.clear();
}

export function getVeilGuildData(syntheticId: string): VeilGuildData | null {
    return guildDataMap.get(syntheticId) ?? null;
}

export function getAllVeilGuildIds(): string[] {
    return Array.from(guildDataMap.keys());
}

export function setVeilGuildChannels(
    syntheticGuildId: string,
    rawChannels: VeilChannelRecord[],
    channelRecordsByChannelDbId: Map<number, any>
): void {
    const data = guildDataMap.get(syntheticGuildId);
    if (!data) return;
    data.channelRecords.clear();
    for (const c of rawChannels) {
        const synth = registerEntity("channel", c.id, c.uuid);
        const record = channelRecordsByChannelDbId.get(c.id);
        if (record) data.channelRecords.set(synth, record);
    }
}

export function setVeilGuildMembers(syntheticGuildId: string, members: VeilMember[]): void {
    const data = guildDataMap.get(syntheticGuildId);
    if (!data) return;
    data.members = members;
}

function findVeilMemberByUserId(syntheticGuildId: string, userId: string): VeilMember | null {
    const data = guildDataMap.get(syntheticGuildId);
    if (!data) return null;
    return data.members.find(member => veilPubkeyToSyntheticUid(member.pubkey) === userId) ?? null;
}

function buildVeilGuildMemberRecord(syntheticGuildId: string, member: VeilMember): any {
    return {
        userId: veilPubkeyToSyntheticUid(member.pubkey),
        guildId: syntheticGuildId,
        nick: member.serverNickname || null,
        roles: [],
        joinedAt: new Date(Number(member.joinedAt) || Date.now()).toISOString(),
        deaf: false,
        mute: false,
        pending: false,
        flags: 0,
        avatar: null,
        premiumSince: null,
        communicationDisabledUntil: null,
        veilPubkey: (member.pubkey || "").toLowerCase(),
        veilRoles: Number(member.roles) || 0
    };
}

// Self-member record built from the real Discord user id. getSelfMember must
// return the current user's own Discord id as userId — Discord's permission
// and navigation paths call getMember(guildId, currentUser.id) with the real
// Discord snowflake, which never matches veilPubkeyToSyntheticUid() outputs.
function buildSelfMemberRecord(syntheticGuildId: string, userId: string): any {
    return {
        userId,
        guildId: syntheticGuildId,
        nick: null,
        roles: [],
        joinedAt: new Date().toISOString(),
        deaf: false,
        mute: false,
        pending: false,
        flags: 0,
        avatar: null,
        premiumSince: null,
        communicationDisabledUntil: null
    };
}

/**
 * Verbose per-call tracing of every veil-id store read. OFF by default:
 * zero console spam and zero per-call overhead in normal use. Flip to true
 * only while diagnosing a new synthetic-guild render crash, then ship it
 * back to false. The PermissionStore safety net runs regardless of this
 * flag; this only controls the console.warn logging.
 */
const TRACE_VEIL_CALLS = false;

/**
 * Shape Discord's PermissionStore.getGuildPermissionProps returns. Synthetic
 * guilds deny every management capability (no settings gear, no moderation
 * UI) and expose the guild record. The field set is the UNION of current and
 * historical Discord builds so a consumer reading any known key gets `false`,
 * never `undefined`. `permissions` is a BigInt mask (0n), never Number 0.
 */
function denyAllGuildPermissionProps(guild: any): any {
    return {
        canManageGuild: false,
        canManageRoles: false,
        canManageChannels: false,
        canManageEmojisAndStickers: false,
        canManageGuildExpressions: false,
        canManageEvents: false,
        canManageWebhooks: false,
        canKickMembers: false,
        canBanMembers: false,
        canManageBans: false,
        canCreateInvite: false,
        canViewAuditLog: false,
        canViewAuditLogV2: false,
        canViewGuildInsights: false,
        canViewGuildAnalytics: false,
        canAccessMembersPage: false,
        canChangeNickname: false,
        canManageNicknames: false,
        canManageMessages: false,
        canManageThreads: false,
        canModerateMembers: false,
        canMentionEveryone: false,
        isGuildAdmin: false,
        isOwner: false,
        isOwnerWithRequiredMfaLevel: false,
        permissions: 0n,
        guild: guild ?? null
    };
}

const patchedTargets: Array<{ target: any; key: string; original: any; }> = [];
let installed = false;

function patch(target: any, key: string, replacement: (...args: any[]) => any) {
    if (!target) return;
    const original = typeof target[key] === "function" ? target[key].bind(target) : null;
    const wrapper = function (this: any, ...args: any[]) {
        if (!original) {
            return replacement.apply(this, [() => undefined, ...args]);
        }
        return replacement.apply(this, [original, ...args]);
    };
    try {
        Object.defineProperty(target, key, {
            value: wrapper,
            writable: true,
            configurable: true,
            enumerable: true
        });
        patchedTargets.push({ target, key, original: original ?? undefined });
    } catch (err) {
        // Some store properties are getters with non-configurable
        // descriptors. Fall back to direct assignment; if that also
        // fails the patch silently no-ops and the original method runs.
        try {
            target[key] = wrapper;
            patchedTargets.push({ target, key, original: original ?? undefined });
        } catch {
            console.warn(`[VeilFlux] could not patch ${key} on store`, err);
        }
    }
}

export function installStorePatches(): void {
    if (installed) return;
    installed = true;

    // ---- GuildStore ----
    patch(GuildStore as any, "getGuild", (orig, id: string) => {
        if (isVeilGuildId(id)) return guildDataMap.get(id)?.record ?? null;
        return orig(id);
    });

    // Intentionally NOT patching getGuilds / getGuildIds / getGuildCount.
    // Those feed Discord's "iterate every guild" paths (notification
    // badges, billing offers, voice presence rollups, ...). Injecting
    // synthetic veil ids there triggers a long tail of background work
    // that crashes on synthetic state. The sidebar tile is rendered by
    // VeilGuildList directly, route resolution + chat shell only touch
    // getGuild(id), so per-id lookup is enough.

    // ---- GuildChannelStore ----
    patch(GuildChannelStore as any, "getChannels", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            const records = data ? Array.from(data.channelRecords.values()) : [];
            const text = records.filter(c => c.type === 0).map(c => ({ channel: c, comparator: c.position ?? 0 }));
            text.sort((a, b) => a.comparator - b.comparator);
            return {
                count: records.length,
                SELECTABLE: text,
                VOCAL: [],
                DIRECTORY: [],
                CATEGORY: [],
                [0]: text,
                [2]: [],
                [4]: [],
                [13]: [],
                [15]: [],
                id: guildId
            };
        }
        return orig(guildId);
    });

    patch(GuildChannelStore as any, "getDefaultChannel", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            if (!data) return null;
            const records = Array.from(data.channelRecords.values());
            const sorted = records.filter(c => c.type === 0).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            return sorted[0] ?? null;
        }
        return orig(guildId);
    });

    patch(GuildChannelStore as any, "getSelectableChannelIds", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            if (!data) return [];
            return Array.from(data.channelRecords.values())
                .filter(c => c.type === 0)
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                .map(c => c.id);
        }
        return orig(guildId);
    });

    // ---- GuildMemberStore ----
    patch(GuildMemberStore as any, "getMember", (orig, guildId: string, userId: string) => {
        if (isVeilGuildId(guildId)) {
            // Discord calls getMember(guildId, currentUser.id) with the real
            // Discord snowflake for permission and nav checks. That id never
            // matches veilPubkeyToSyntheticUid outputs, so handle it first.
            const self = UserStore.getCurrentUser?.();
            if (self && userId === self.id) return buildSelfMemberRecord(guildId, self.id);
            const member = findVeilMemberByUserId(guildId, userId);
            return member ? buildVeilGuildMemberRecord(guildId, member) : null;
        }
        return orig(guildId, userId);
    });

    patch(GuildMemberStore as any, "getSelfMember", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const self = UserStore.getCurrentUser?.();
            if (!self) return null;
            // Must use the real Discord user id: Discord's nav and permission
            // paths verify getSelfMember().userId === currentUser.id.
            return buildSelfMemberRecord(guildId, self.id);
        }
        return orig(guildId);
    });

    patch(GuildMemberStore as any, "getSelfMemberJoinedAt", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const self = (GuildMemberStore as any).getSelfMember?.(guildId);
            const raw = self?.joinedAt;
            return raw ? new Date(raw) : new Date();
        }
        return orig(guildId);
    });

    patch(GuildMemberStore as any, "isMember", (orig, guildId: string, userId: string) => {
        if (isVeilGuildId(guildId)) {
            // Real Discord user id always counts as a member of their own Veil guild.
            const self = UserStore.getCurrentUser?.();
            if (self && userId === self.id) return true;
            return findVeilMemberByUserId(guildId, userId) != null;
        }
        return orig(guildId, userId);
    });

    patch(GuildMemberStore as any, "getMemberIds", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            if (!data) return [];
            return data.members.map(member => veilPubkeyToSyntheticUid(member.pubkey));
        }
        return orig(guildId);
    });

    patch(GuildMemberStore as any, "memberOf", (orig, userId: string) => {
        // Real Discord user id: return every installed Veil guild.
        const self = UserStore.getCurrentUser?.();
        if (self && userId === self.id) {
            const ids = Array.from(guildDataMap.keys());
            if (ids.length) return ids;
        }
        const veilGuildIds = Array.from(guildDataMap.entries())
            .filter(([, data]) => data.members.some(member => veilPubkeyToSyntheticUid(member.pubkey) === userId))
            .map(([guildId]) => guildId);
        if (veilGuildIds.length) {
            return veilGuildIds;
        }
        return orig(userId);
    });

    patch(GuildMemberStore as any, "isCurrentUserGuest", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) return false;
        return orig(guildId);
    });

    patch(GuildMemberStore as any, "isGuestOrLurker", (orig, guildId: string, userId: string) => {
        if (isVeilGuildId(guildId)) return false;
        return orig(guildId, userId);
    });

    // ---- GuildRoleStore ----
    patch(GuildRoleStore as any, "getRoles", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            return data ? { [data.syntheticId]: data.everyoneRole } : {};
        }
        return orig(guildId);
    });

    // Snapshot variant used by some chat-shell selectors. Native returns
    // an empty {} for the synthetic guild, which leaves downstream
    // permission accumulators with a BigInt 0n that gets ANDed against a
    // Number flag elsewhere -> "Cannot mix BigInt and other types".
    patch(GuildRoleStore as any, "getRolesSnapshot", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            return data ? { [data.syntheticId]: data.everyoneRole } : {};
        }
        return orig(guildId);
    });

    // Discord's internal computeBasePermissions / computePermissions read
    // the raw role map via getUnsafeMutableRoles(guildId) (closure-captured,
    // so our getRoles patch doesn't intercept). Without this patch the
    // synthetic guild's role map is the empty {} Discord defaulted to,
    // `roles[guild.id]` is undefined, and `undefined.permissions | 0n`
    // crashes with "Cannot mix BigInt and other types".
    patch(GuildRoleStore as any, "getUnsafeMutableRoles", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            return data ? { [data.syntheticId]: data.everyoneRole } : {};
        }
        return orig(guildId);
    });

    // Same family. Some Discord builds also ship getMutableAllGuildsRoles()
    // (no args, returns the full {guildId: {roleId: role}} map). If the
    // method exists, splice the veil entries in.
    patch(GuildRoleStore as any, "getMutableAllGuildsRoles", (orig) => {
        const real = typeof orig === "function" ? orig() : {};
        const merged = { ...(real || {}) };
        for (const [gid, data] of guildDataMap) {
            merged[gid] = { [data.syntheticId]: data.everyoneRole };
        }
        return merged;
    });

    patch(GuildRoleStore as any, "getRole", (orig, guildId: string, roleId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            return data?.everyoneRole ?? null;
        }
        return orig(guildId, roleId);
    });

    patch(GuildRoleStore as any, "getEveryoneRole", (orig, guildIdOrGuild: any) => {
        if (guildIdOrGuild == null) return null;
        const id = typeof guildIdOrGuild === "string" ? guildIdOrGuild : guildIdOrGuild.id;
        if (isVeilGuildId(id)) {
            const data = guildDataMap.get(id);
            if (data) return data.everyoneRole;
            // Last-resort synthetic fallback: a render fired before
            // registerVeilGuild ran. Return a permissive @everyone role
            // shaped like Discord's so PermissionStore.computeBasePermissions
            // doesn't throw "Guild does not have an @everyone role".
            return {
                id,
                name: "@everyone",
                permissions: 0n,
                position: 0,
                color: 0,
                hoist: false,
                managed: false,
                mentionable: false,
                flags: 0,
                unicode_emoji: null,
                icon: null,
                tags: {}
            };
        }
        return orig(guildIdOrGuild);
    });

    patch(GuildRoleStore as any, "getNumRoles", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) return 1;
        return orig(guildId);
    });

    patch(GuildRoleStore as any, "getSortedRoles", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            return data ? [data.everyoneRole] : [];
        }
        return orig(guildId);
    });

    patch(GuildRoleStore as any, "getRoleColorString", (orig, guildId: string, roleId: string) => {
        if (isVeilGuildId(guildId)) return null;
        return orig(guildId, roleId);
    });

    // ---- PermissionStore ----
    // Grant everything for veil guild + channel ids. Real Discord guilds
    // and channels keep their original gating untouched.
    //
    // We deliberately only patch the *boolean* surface (can / canAccessGuild)
    // and let Discord's compute* / get*Permissions paths run untouched.
    // Reason: the synthetic guild record pins ownerId to the current user
    // (see buildGuildRecordObject), and Discord's permission math has an
    // owner short-circuit that returns full perms without doing any BigInt
    // arithmetic. Short-circuiting compute* ourselves with a raw BigInt
    // return value crashed downstream callers with
    // "Cannot mix BigInt and other types, use explicit conversions" when
    // they ANDed the result against a Number-typed permission bit.
    patch(PermissionStore as any, "can", (orig, _perm: any, context: any) => {
        if (context == null) return false;
        const id = context.guild_id ?? context.guildId ?? context.id;
        if (isVeilGuildId(id) || isVeilChannelId(id)) return true;
        try { return orig(_perm, context); } catch { return false; }
    });

    patch(PermissionStore as any, "canAccessGuild", (orig, guild: any) => {
        if (guild == null) return false;
        if (isVeilGuildId(guild.id)) return true;
        try { return orig(guild); } catch { return false; }
    });

    patch(PermissionStore as any, "canBasicChannel", (orig, _perm: any, channel: any, guildId?: string) => {
        if (channel == null) return false;
        const cid = channel.id ?? channel.channel_id ?? channel.channelId;
        const gid = guildId ?? channel.guild_id ?? channel.guildId ?? channel.guild?.id;
        if (isVeilChannelId(cid) || isVeilGuildId(gid)) return true;
        try { return orig(_perm, channel, guildId); } catch { return false; }
    });

    patch(PermissionStore as any, "canViewChannel", (orig, channel: any, guildId?: string) => {
        if (channel == null) return false;
        const cid = channel.id ?? channel.channel_id ?? channel.channelId;
        const gid = guildId ?? channel.guild_id ?? channel.guildId ?? channel.guild?.id;
        if (isVeilChannelId(cid) || isVeilGuildId(gid)) return true;
        try { return orig(channel, guildId); } catch { return false; }
    });

    patch(PermissionStore as any, "canWithPartialContext", (orig, context: any) => {
        if (context == null) return false;
        const gid = context.guild?.id ?? context.guildId ?? context.guild_id;
        const cid = context.channel?.id ?? context.channelId ?? context.channel_id;
        if (isVeilGuildId(gid) || isVeilChannelId(cid)) return true;
        try { return orig(context); } catch { return false; }
    });

    // Native Discord's getGuildPermissions hits the owner-shortcut for our
    // synthetic guild (we pin ownerId to the current user) and returns
    // ALL_PERMS as a BigInt (e.g. 17873661021126655n). At least one
    // downstream consumer in the guild-render path then ANDs that BigInt
    // against a Number-typed permission flag and throws
    // "Cannot mix BigInt and other types, use explicit conversions",
    // tearing down the chat shell with a React error boundary. Short-
    // circuit veil ids to BigInt 0n so the value is type-safe regardless
    // of which side of the bitwise op the caller treats as authoritative;
    // veil channels grant their own perms via the boolean `can` patch
    // above, so a zero-perm guild role-mask is fine.
    patch(PermissionStore as any, "getGuildPermissions", (orig, context: any) => {
        // Permission masks are BigInt in modern Discord. Consumers do
        // `getGuildPermissions(x) & PermissionsBits.FOO` where FOO is a
        // BigInt, so a Number 0 here throws "Cannot mix BigInt and other
        // types". Return 0n (no perms); veil channel access comes from the
        // boolean `can*` patches above.
        if (context == null) return 0n;
        const id = typeof context === "string" ? context : context.id ?? context.guildId ?? context.guild_id;
        if (isVeilGuildId(id)) return 0n;
        try { return orig(context); } catch { return 0n; }
    });

    patch(PermissionStore as any, "getGuildPermissionProps", (orig, guild: any) => {
        if (guild == null) return denyAllGuildPermissionProps(null);
        const id = typeof guild === "string" ? guild : guild.id;
        if (isVeilGuildId(id)) {
            const data = guildDataMap.get(id);
            const rec = data?.record ?? (typeof guild === "object" ? guild : null);
            return denyAllGuildPermissionProps(rec);
        }
        return orig(guild);
    });

    // All four perm-compute methods below return a BigInt mask natively
    // (computeBasicPermissions is typed `number` in our stale d.ts, but
    // Discord ANDs it against BigInt PermissionsBits, so it is BigInt too).
    // Return 0n, never Number 0, or downstream `mask & bigintFlag` throws.
    patch(PermissionStore as any, "computeBasePermissions", (orig, ...args: any[]) => {
        if (args[0] == null) return 0n;
        const id = typeof args[0] === "string" ? args[0] : args[0]?.id ?? args[1]?.id;
        if (isVeilGuildId(id)) return 0n;
        try { return orig(...args); } catch { return 0n; }
    });

    patch(PermissionStore as any, "computePermissions", (orig, context: any) => {
        if (context == null) return 0n;
        const gid = context.guild?.id ?? context.guildId ?? context.guild_id;
        const cid = context.channel?.id ?? context.channelId ?? context.channel_id;
        if (isVeilGuildId(gid) || isVeilChannelId(cid)) return 0n;
        try { return orig(context); } catch { return 0n; }
    });

    patch(PermissionStore as any, "computeBasicPermissions", (orig, channel: any) => {
        if (channel == null) return 0n;
        const cid = channel.id ?? channel.channel_id ?? channel.channelId;
        const gid = channel.guild_id ?? channel.guildId ?? channel.guild?.id;
        if (isVeilChannelId(cid) || isVeilGuildId(gid)) return 0n;
        try { return orig(channel); } catch { return 0n; }
    });

    patch(PermissionStore as any, "getChannelPermissions", (orig, channel: any) => {
        if (channel == null) return 0n;
        const cid = channel.id ?? channel.channel_id ?? channel.channelId;
        const gid = channel.guild_id ?? channel.guildId ?? channel.guild?.id;
        if (isVeilChannelId(cid) || isVeilGuildId(gid)) return 0n;
        try { return orig(channel); } catch { return 0n; }
    });

    // Remaining PermissionStore surface. These return booleans / a Role, not
    // masks, so they don't crash on the BigInt/Number mix — but their native
    // impls walk role + member state that doesn't exist for a synthetic
    // guild. Answer veil ids explicitly (deny management, expose the single
    // @everyone role) instead of letting native traversal run on partial
    // state. Real-guild ids fall through untouched.
    patch(PermissionStore as any, "canManageUser", (orig, _perm: any, _user: any, guild: any) => {
        const id = typeof guild === "string" ? guild : guild?.id;
        if (isVeilGuildId(id)) return false;
        try { return orig(_perm, _user, guild); } catch { return false; }
    });

    patch(PermissionStore as any, "canAccessGuildSettings", (orig, guild: any) => {
        const id = typeof guild === "string" ? guild : guild?.id;
        if (isVeilGuildId(id)) return false;
        try { return orig(guild); } catch { return false; }
    });

    patch(PermissionStore as any, "canAccessMemberSafetyPage", (orig, guild: any) => {
        const id = typeof guild === "string" ? guild : guild?.id;
        if (isVeilGuildId(id)) return false;
        try { return orig(guild); } catch { return false; }
    });

    patch(PermissionStore as any, "canImpersonateRole", (orig, guild: any, role: any) => {
        const id = typeof guild === "string" ? guild : guild?.id;
        if (isVeilGuildId(id)) return false;
        try { return orig(guild, role); } catch { return false; }
    });

    patch(PermissionStore as any, "getHighestRole", (orig, guild: any) => {
        const id = typeof guild === "string" ? guild : guild?.id;
        if (isVeilGuildId(id)) {
            const data = guildDataMap.get(id);
            return data?.everyoneRole ?? null;
        }
        try { return orig(guild); } catch { return null; }
    });

    patch(PermissionStore as any, "isRoleHigher", (orig, guild: any, firstRole: any, secondRole: any) => {
        const id = typeof guild === "string" ? guild : guild?.id;
        if (isVeilGuildId(id)) return false;
        try { return orig(guild, firstRole, secondRole); } catch { return false; }
    });

    // ---- ChannelStore safety net ----
    // CHANNEL_CREATE dispatches still drive ChannelStore for veil channels;
    // this fallback covers the edge case where a channel is queried before
    // ensureGuildDetail finishes dispatching.
    patch(ChannelStore as any, "getChannel", (orig, channelId: string) => {
        const real = orig(channelId);
        if (real) return real;
        if (!isVeilChannelId(channelId)) return real;
        for (const data of guildDataMap.values()) {
            const c = data.channelRecords.get(channelId);
            if (c) return c;
        }
        return real;
    });

    // ---- Safety net + optional tracing ----
    // Always-on net for PermissionStore: any method we DIDN'T explicitly
    // patch above still gets its veil-id BigInt masks coerced to 0n, so a
    // future Discord build that adds a perm method can't reintroduce the
    // "Cannot mix BigInt and other types" crash. Real-guild calls pass
    // through untouched (the net never swallows Discord's own errors).
    netVeilPermissionStore(PermissionStore);

    // Verbose tracing of the other perm-related stores. Off by default; the
    // PermissionStore net handles its own logging when TRACE is on, so it is
    // not listed here.
    if (TRACE_VEIL_CALLS) {
        traceVeilStore("GuildRoleStore", GuildRoleStore);
        traceVeilStore("GuildMemberStore", GuildMemberStore);
        traceVeilStore("GuildChannelStore", GuildChannelStore);
        traceVeilStore("GuildStore", GuildStore);
    }

    // ---- Guild subscription sender ----
    // Discord sends OP 14 (GUILD_SUBSCRIPTION_UPDATE) when it lazy-loads a
    // guild after navigation. The gateway has no record of our synthetic
    // guild ids and responds with 4000 Unknown Error, crashing the connection.
    // We patch the function that sends this message (before ETF encoding)
    // so Veil guild ids are silently skipped. Property names vary by Discord
    // build; we try each known name in order and patch the first one found.
    {
        const subscriptionPropNames = [
            "subscribeGuild",
            "updateGuildSubscriptions",
            "sendGuildSubscriptions",
            "lazyLoadGuild",
        ];
        for (const propName of subscriptionPropNames) {
            try {
                const mod = findByProps(propName);
                if (mod && typeof mod[propName] === "function") {
                    patch(mod, propName, (orig, guildId: any, ...rest: any[]) => {
                        if (typeof guildId === "string" && isVeilGuildId(guildId)) return;
                        return orig(guildId, ...rest);
                    });
                    break;
                }
            } catch { /* try next name */ }
        }
    }
}

function looksVeil(v: any): boolean {
    if (typeof v === "string") return isVeilGuildId(v) || isVeilChannelId(v);
    if (v && typeof v === "object") {
        const id = v.id ?? v.guild_id ?? v.guildId ?? v.channel_id ?? v.channelId;
        if (typeof id === "string" && (isVeilGuildId(id) || isVeilChannelId(id))) return true;
    }
    return false;
}

/**
 * Iterate every own/proto method of `store` that we did NOT already patch
 * explicitly, and replace it with the wrapper `make(key, orig)` returns.
 * Returning null from `make` leaves the method untouched. Wrapped methods
 * are recorded so removeStorePatches() restores them exactly.
 */
function eachUnpatchedMethod(
    store: any,
    make: (key: string, orig: (...a: any[]) => any) => ((...a: any[]) => any) | null
) {
    if (!store) return;
    const proto = Object.getPrototypeOf(store);
    const keys = new Set<string>([
        ...Object.getOwnPropertyNames(store),
        ...(proto ? Object.getOwnPropertyNames(proto) : [])
    ]);
    for (const key of keys) {
        if (key === "constructor" || key.startsWith("_") || key === "addChangeListener" ||
            key === "removeChangeListener" || key === "emitChange" || key === "getDispatchToken") continue;
        let fn: any;
        try { fn = store[key]; } catch { continue; }
        if (typeof fn !== "function") continue;
        if (patchedTargets.some(e => e.target === store && e.key === key)) continue;
        const orig = fn.bind(store);
        const wrapper = make(key, orig);
        if (!wrapper) continue;
        try {
            Object.defineProperty(store, key, {
                value: wrapper,
                writable: true,
                configurable: true,
                enumerable: true
            });
            patchedTargets.push({ target: store, key, original: orig });
        } catch { /* ignore */ }
    }
}

/**
 * Always-on safety net for the PermissionStore methods we don't shim by
 * hand. For veil-id args only: coerce a BigInt mask result to 0n (type
 * defense for any future perm method) and fall back to 0n if the native
 * impl throws on synthetic state. Real-guild calls run untouched — we never
 * hide Discord's own results or errors, the prior bug. Logs only when
 * TRACE_VEIL_CALLS is on.
 */
function netVeilPermissionStore(store: any) {
    eachUnpatchedMethod(store, (key, orig) => function (this: any, ...args: any[]) {
        if (!args.some(looksVeil)) return orig(...args);
        let result: any;
        try {
            result = orig(...args);
        } catch {
            return 0n;
        }
        if (TRACE_VEIL_CALLS) {
            try { console.warn(`[VeilFlux/trace] PermissionStore.${key}`, args, "→", result); } catch { /* ignore */ }
        }
        return typeof result === "bigint" ? 0n : result;
    });
}

/**
 * Debug-only tracer for the non-permission stores. Log-only: never reshapes
 * results, never swallows errors (a native throw propagates with its real
 * stack, exactly what you want while diagnosing). Installed only when
 * TRACE_VEIL_CALLS is on.
 */
function traceVeilStore(name: string, store: any) {
    eachUnpatchedMethod(store, (key, orig) => function (this: any, ...args: any[]) {
        const result = orig(...args);
        if (args.some(looksVeil)) {
            try { console.warn(`[VeilFlux/trace] ${name}.${key}`, args, "→", result); } catch { /* ignore */ }
        }
        return result;
    });
}

export function removeStorePatches(): void {
    if (!installed) return;
    for (const entry of patchedTargets) {
        try {
            if (entry.original) {
                Object.defineProperty(entry.target, entry.key, {
                    value: entry.original,
                    writable: true,
                    configurable: true,
                    enumerable: true
                });
            } else {
                delete entry.target[entry.key];
            }
        } catch { /* ignore */ }
    }
    patchedTargets.length = 0;
    guildDataMap.clear();
    installed = false;
}
