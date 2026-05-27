/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
            const member = findVeilMemberByUserId(guildId, userId);
            return member ? buildVeilGuildMemberRecord(guildId, member) : null;
        }
        return orig(guildId, userId);
    });

    patch(GuildMemberStore as any, "getSelfMember", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const self = UserStore.getCurrentUser?.();
            if (!self) return null;
            const member = findVeilMemberByUserId(guildId, self.id);
            return member ? buildVeilGuildMemberRecord(guildId, member) : null;
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
        if (context == null) return 0;
        const id = typeof context === "string" ? context : context.id ?? context.guildId ?? context.guild_id;
        if (isVeilGuildId(id)) return 0;
        try { return orig(context); } catch { return 0; }
    });

    patch(PermissionStore as any, "getGuildPermissionProps", (orig, guild: any) => {
        if (guild == null) {
            return {
                canManageGuild: false,
                canManageRoles: false,
                canManageChannels: false,
                canManageEmojisAndStickers: false,
                canManageEvents: false,
                canManageWebhooks: false,
                canKickMembers: false,
                canBanMembers: false,
                canCreateInvite: false,
                canViewAuditLog: false,
                canViewGuildInsights: false,
                canChangeNickname: false,
                canManageNicknames: false,
                canManageMessages: false,
                canManageThreads: false,
                canModerateMembers: false,
                canMentionEveryone: false,
                permissions: 0
            };
        }
        const id = typeof guild === "string" ? guild : guild.id;
        if (isVeilGuildId(id)) {
            return {
                canManageGuild: false,
                canManageRoles: false,
                canManageChannels: false,
                canManageEmojisAndStickers: false,
                canManageEvents: false,
                canManageWebhooks: false,
                canKickMembers: false,
                canBanMembers: false,
                canCreateInvite: false,
                canViewAuditLog: false,
                canViewGuildInsights: false,
                canChangeNickname: false,
                canManageNicknames: false,
                canManageMessages: false,
                canManageThreads: false,
                canModerateMembers: false,
                canMentionEveryone: false,
                permissions: 0
            };
        }
        return orig(guild);
    });

    patch(PermissionStore as any, "computeBasePermissions", (orig, ...args: any[]) => {
        if (args[0] == null) return 0;
        const id = typeof args[0] === "string" ? args[0] : args[0]?.id ?? args[1]?.id;
        if (isVeilGuildId(id)) return 0;
        try { return orig(...args); } catch { return 0; }
    });

    patch(PermissionStore as any, "computePermissions", (orig, context: any) => {
        if (context == null) return 0;
        const gid = context.guild?.id ?? context.guildId ?? context.guild_id;
        const cid = context.channel?.id ?? context.channelId ?? context.channel_id;
        if (isVeilGuildId(gid) || isVeilChannelId(cid)) return 0;
        try { return orig(context); } catch { return 0; }
    });

    patch(PermissionStore as any, "computeBasicPermissions", (orig, channel: any) => {
        if (channel == null) return 0;
        const cid = channel.id ?? channel.channel_id ?? channel.channelId;
        const gid = channel.guild_id ?? channel.guildId ?? channel.guild?.id;
        if (isVeilChannelId(cid) || isVeilGuildId(gid)) return 0;
        try { return orig(channel); } catch { return 0; }
    });

    patch(PermissionStore as any, "getChannelPermissions", (orig, channel: any) => {
        if (channel == null) return 0;
        const cid = channel.id ?? channel.channel_id ?? channel.channelId;
        const gid = channel.guild_id ?? channel.guildId ?? channel.guild?.id;
        if (isVeilChannelId(cid) || isVeilGuildId(gid)) return 0;
        try { return orig(channel); } catch { return 0; }
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

    // ---- Diagnostic instrumentation ----
    // Wrap every method on the perm-related stores so any call with a veil
    // guild/channel/role id logs "[VeilFlux/trace] StoreName.method veil-id".
    // Finds the unpatched method that triggers
    // "Cannot mix BigInt and other types".
    instrumentVeilCalls("PermissionStore", PermissionStore);
    instrumentVeilCalls("GuildRoleStore", GuildRoleStore);
    instrumentVeilCalls("GuildMemberStore", GuildMemberStore);
    instrumentVeilCalls("GuildChannelStore", GuildChannelStore);
    instrumentVeilCalls("GuildStore", GuildStore);
}

function looksVeil(v: any): boolean {
    if (typeof v === "string") return isVeilGuildId(v) || isVeilChannelId(v);
    if (v && typeof v === "object") {
        const id = v.id ?? v.guild_id ?? v.guildId ?? v.channel_id ?? v.channelId;
        if (typeof id === "string" && (isVeilGuildId(id) || isVeilChannelId(id))) return true;
    }
    return false;
}

function instrumentVeilCalls(name: string, store: any) {
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
        // Skip if we already patched it above (those wrappers already log
        // implicitly by handling the veil path).
        if (patchedTargets.some(e => e.target === store && e.key === key)) continue;
        const orig = fn.bind(store);
        const wrapper = function (this: any, ...args: any[]) {
            let result: any;
            try {
                result = orig(...args);
            } catch {
                return undefined;
            }
            const hasVeilArgs = args.some(looksVeil);
            if (hasVeilArgs) {
                try {
                    console.warn(`[VeilFlux/trace] ${name}.${key}`, args, "→", result);
                } catch { /* ignore */ }
            }
            if (hasVeilArgs && name === "PermissionStore" && typeof result === "bigint") {
                return 0;
            }
            return result;
        };
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
