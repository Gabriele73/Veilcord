/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { veilApiBase } from "@plugins/veilCrypto";

import type { VeilChannelRecord, VeilServerSummary } from "../api/servers";
import { registerEntity } from "../idMap";

/**
 * Stable synthetic Discord-snowflake-shaped ids for the synthetic Veil
 * owner / system role / @everyone. Reuses the same "9999..." high-range
 * prefix that veilSystemDM uses so backend / fixture tooling can spot
 * Veil-originated ids on sight.
 *
 * Discord's BigInt parsers accept anything below 2^63; these all sit
 * comfortably under that ceiling.
 */
const VEIL_SYNTH_OWNER_PREFIX = "9999990000000000";
const VEIL_DISCORD_EPOCH_MS = 1420070400000;

function syntheticOwnerId(serverId: number): string {
    // Pad server id into the trailing 4 digits for stability per server.
    const tail = String(serverId % 10000).padStart(4, "0");
    return VEIL_SYNTH_OWNER_PREFIX.slice(0, VEIL_SYNTH_OWNER_PREFIX.length - tail.length) + tail;
}

function joinedAtFromServerId(serverId: number): string {
    // Veil server ids are bigserial; we don't have a creation timestamp on
    // the membership summary. Fall back to "now" so Discord's "joined"
    // pill renders without throwing on an undefined date.
    void serverId;
    return new Date().toISOString();
}

function resolveIcon(icon: string | null, uuid: string): string | null {
    if (typeof icon === "string" && icon.trim().length > 0) {
        const t = icon.trim();
        if (/^https?:\/\//i.test(t)) return t;
        if (t.startsWith("/")) return veilApiBase() + t;
        return t;
    }
    void uuid;
    return null;
}

/**
 * Build the raw payload Discord's GUILD_CREATE handler ingests. Field
 * names mirror Discord's gateway shape — snake_case where Discord uses
 * snake_case, camelCase where Discord uses camelCase. Don't "tidy" this
 * up.
 */
export function buildGuildPayload(
    summary: VeilServerSummary,
    channels: VeilChannelRecord[],
    syntheticGuildId: string
): any {
    const ownerId = syntheticOwnerId(summary.id);

    // Discord requires an `@everyone` role with id === guild_id, otherwise
    // PermissionStore.computeBasePermissions throws and the guild header
    // refuses to render.
    const everyoneRole = {
        id: syntheticGuildId,
        name: "@everyone",
        color: 0,
        hoist: false,
        position: 0,
        permissions: "0",
        managed: false,
        mentionable: false,
        flags: 0,
        unicode_emoji: null,
        icon: null
    };

    const channelPayloads = channels.map(c => buildChannelPayload(c, syntheticGuildId));

    // Modern Discord splits GUILD_CREATE into top-level lifecycle fields
    // (channels, members, presences, joined_at, ...) and a nested
    // `properties` block holding the immutable guild metadata. The
    // GuildStore data record is built from `properties`; without it the
    // store logs "Guild data was missing from store, but hash was still
    // available" and the sidebar refuses to render the tile.
    const properties = {
        id: syntheticGuildId,
        name: summary.name,
        icon: resolveIcon(summary.icon, summary.uuid),
        description: summary.description ?? null,
        splash: null,
        discovery_splash: null,
        banner: null,
        home_header: null,
        owner_id: ownerId,
        application_id: null,
        region: null,
        afk_channel_id: null,
        afk_timeout: 60,
        system_channel_id: null,
        system_channel_flags: 0,
        widget_enabled: false,
        widget_channel_id: null,
        verification_level: 0,
        roles: [everyoneRole],
        default_message_notifications: 1,
        mfa_level: 0,
        explicit_content_filter: 0,
        max_presences: null,
        max_members: 500000,
        max_stage_video_channel_users: 0,
        max_video_channel_users: 0,
        vanity_url_code: null,
        premium_tier: 0,
        premium_subscription_count: 0,
        preferred_locale: "en-US",
        rules_channel_id: null,
        public_updates_channel_id: null,
        safety_alerts_channel_id: null,
        nsfw_level: 0,
        nsfw: false,
        premium_progress_bar_enabled: false,
        features: [],
        hub_type: null,
        latest_onboarding_question_id: null,
        incidents_data: null,
        inventory_settings: null,
        clan: null,
        version: 1
    };

    return {
        ...properties,
        properties,
        emojis: [],
        stickers: [],
        joined_at: joinedAtFromServerId(summary.id),
        large: false,
        lazy: true,
        unavailable: false,
        geo_restricted: false,
        member_count: Math.max(summary.memberCount ?? 1, 1),
        voice_states: [],
        members: [],
        channels: channelPayloads,
        threads: [],
        presences: [],
        stage_instances: [],
        guild_scheduled_events: [],
        embedded_activities: [],
        soundboard_sounds: [],
        application_command_counts: {},
        data_mode: "full"
    };
}

/**
 * Build the raw payload Discord's CHANNEL_CREATE handler / Channel record
 * factory ingests. Veil channels reuse Discord's ChannelType enum: 0
 * (text), 4 (category) are the two we render in Phase 2.
 */
export function buildChannelPayload(channel: VeilChannelRecord, syntheticGuildId: string): any {
    const syntheticChannelId = registerEntity("channel", channel.id, channel.uuid);

    const veilType = Number.isFinite(channel.type) ? channel.type : 0;
    // Coerce anything we don't recognise yet to GUILD_TEXT so Discord
    // keeps rendering it. Voice / forum / stage all get added later.
    const discordType = (veilType === 4) ? 4 : 0;

    return {
        id: syntheticChannelId,
        type: discordType,
        guild_id: syntheticGuildId,
        name: channel.name,
        topic: channel.topic ?? null,
        position: channel.position ?? 0,
        parent_id: channel.parentId != null ? registerEntity("channel", channel.parentId) : null,
        nsfw: false,
        rate_limit_per_user: 0,
        flags: channel.flags ?? 0,
        permission_overwrites: [],
        last_message_id: null,
        last_pin_timestamp: null
    };
}

/**
 * Convert a millisecond timestamp into a Discord-shaped snowflake id.
 * Used by the Phase 3 message-fetch / send path; lifted here so the
 * dispatch layer can reuse the same conversion when building synthetic
 * `last_message_id` snapshots.
 */
export function makeSnowflake(timestampMs: number, increment = 0): string {
    const safe = Math.max(timestampMs, VEIL_DISCORD_EPOCH_MS + 1);
    const tsBits = BigInt(safe - VEIL_DISCORD_EPOCH_MS) << 22n;
    const workerBits = 30n << 17n; // distinct from veilSystemDM's 31n
    const processBits = 30n << 12n;
    const inc = BigInt(increment & 0xFFF);
    return (tsBits | workerBits | processBits | inc).toString();
}
