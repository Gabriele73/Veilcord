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

// Generous permission bag for veil guilds + channels: every perm bit set
// up to 53 (safe BigInt). Prevents PermissionStore.can from gating menu
// items on the synthetic guild while keeping real Discord guilds 100%
// untouched.
const ALL_PERMS = (1n << 53n) - 1n;

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
        permissions: String(ALL_PERMS),
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
    const ownerId = syntheticOwnerId(summary.id);
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

const originals: Record<string, any> = {};
let installed = false;

function patch(target: any, key: string, replacement: (...args: any[]) => any) {
    if (typeof target?.[key] !== "function") return;
    const original = target[key].bind(target);
    originals[`${target?.constructor?.name ?? ""}.${key}.${Math.random()}`] = { target, key, original };
    target[key] = function (this: any, ...args: any[]) {
        return replacement.apply(this, [original, ...args]);
    };
}

export function installStorePatches(): void {
    if (installed) return;
    installed = true;

    // ---- GuildStore ----
    patch(GuildStore as any, "getGuild", (orig, id: string) => {
        if (isVeilGuildId(id)) return guildDataMap.get(id)?.record ?? null;
        return orig(id);
    });

    patch(GuildStore as any, "getGuilds", (orig) => {
        const real = orig() ?? {};
        if (guildDataMap.size === 0) return real;
        const merged = { ...real };
        for (const [id, data] of guildDataMap) merged[id] = data.record;
        return merged;
    });

    patch(GuildStore as any, "getGuildCount", (orig) => {
        return (orig() ?? 0) + guildDataMap.size;
    });

    patch(GuildStore as any, "getGuildIds", (orig) => {
        const real = orig() ?? [];
        return [...real, ...guildDataMap.keys()];
    });

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

    // ---- GuildMemberStore ----
    patch(GuildMemberStore as any, "getMember", (orig, guildId: string, userId: string) => {
        if (isVeilGuildId(guildId)) {
            const self = UserStore.getCurrentUser?.();
            if (userId === self?.id) {
                return {
                    userId,
                    guildId,
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
            return null;
        }
        return orig(guildId, userId);
    });

    patch(GuildMemberStore as any, "isMember", (orig, guildId: string, userId: string) => {
        if (isVeilGuildId(guildId)) {
            const self = UserStore.getCurrentUser?.();
            return userId === self?.id;
        }
        return orig(guildId, userId);
    });

    patch(GuildMemberStore as any, "getMemberIds", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const self = UserStore.getCurrentUser?.();
            return self ? [self.id] : [];
        }
        return orig(guildId);
    });

    // ---- GuildRoleStore ----
    patch(GuildRoleStore as any, "getRoles", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            return data ? { [data.syntheticId]: data.everyoneRole } : {};
        }
        return orig(guildId);
    });

    patch(GuildRoleStore as any, "getRole", (orig, guildId: string, roleId: string) => {
        if (isVeilGuildId(guildId)) {
            const data = guildDataMap.get(guildId);
            return data?.everyoneRole ?? null;
        }
        return orig(guildId, roleId);
    });

    // ---- PermissionStore ----
    // Grant everything for veil guild + channel ids. Real Discord guilds
    // and channels keep their original gating untouched.
    patch(PermissionStore as any, "can", (orig, _perm: any, context: any) => {
        const id = context?.guild_id ?? context?.guildId ?? context?.id;
        if (isVeilGuildId(id) || isVeilChannelId(id)) return true;
        return orig(_perm, context);
    });

    patch(PermissionStore as any, "canAccessGuild", (orig, guild: any) => {
        if (isVeilGuildId(guild?.id)) return true;
        return orig(guild);
    });

    patch(PermissionStore as any, "canManageUser", (orig, ...args: any[]) => {
        return orig(...args);
    });

    patch(PermissionStore as any, "getGuildPermissions", (orig, guildId: string) => {
        if (isVeilGuildId(guildId)) return ALL_PERMS;
        return orig(guildId);
    });

    patch(PermissionStore as any, "getChannelPermissions", (orig, channelId: string) => {
        if (isVeilChannelId(channelId)) return ALL_PERMS;
        return orig(channelId);
    });

    patch(PermissionStore as any, "computeBasePermissions", (orig, target: any) => {
        const id = target?.id ?? target;
        if (isVeilGuildId(id)) return ALL_PERMS;
        return orig(target);
    });

    patch(PermissionStore as any, "computePermissions", (orig, target: any) => {
        const id = target?.id ?? target?.guild_id ?? target?.guildId ?? target;
        if (isVeilGuildId(id) || isVeilChannelId(id)) return ALL_PERMS;
        return orig(target);
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
}

export function removeStorePatches(): void {
    if (!installed) return;
    for (const key of Object.keys(originals)) {
        const { target, key: methodKey, original } = originals[key];
        try { target[methodKey] = original; } catch { /* ignore */ }
    }
    for (const key of Object.keys(originals)) delete originals[key];
    guildDataMap.clear();
    installed = false;
}
