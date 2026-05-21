/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByCodeLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

import { listServerMembers } from "./api/members";
import { getServerDetail, VeilChannelRecord, VeilServerSummary } from "./api/servers";
import { buildChannelPayload } from "./records/buildGuildPayload";
import {
    registerVeilGuild,
    setVeilGuildChannels,
    setVeilGuildMembers,
    unregisterVeilGuild
} from "./storePatches";
import { attachServer, detachAll as detachAllSockets } from "./wsBridge";

/**
 * Discord's ChannelStore expects real Channel records, not plain objects.
 * Run our raw payloads through the same factory Discord uses on gateway
 * frames so the resulting instances have the full prototype chain
 * (`isPrivate`, `accessPermissions` getter, etc.).
 */
const createChannelRecordFromServer: any = findByCodeLazy(".GUILD_TEXT]", "fromServer)");

const installedGuildIds = new Set<string>();
const installedChannelsByGuild = new Map<string, Set<string>>();
const detailLoadInFlight = new Map<string, Promise<void>>();

function dispatchChannelCreate(rawChannel: any): any {
    const record = createChannelRecordFromServer(rawChannel);
    try {
        FluxDispatcher.dispatch({ type: "CHANNEL_CREATE", channel: record });
    } catch (err) {
        console.warn("[VeilFlux] CHANNEL_CREATE dispatch threw", err);
    }
    return record;
}

function rememberChannel(guildId: string, channelId: string) {
    let set = installedChannelsByGuild.get(guildId);
    if (!set) {
        set = new Set();
        installedChannelsByGuild.set(guildId, set);
    }
    set.add(channelId);
}

/**
 * Register a Veil server with the in-memory store-patch layer. Replaces
 * the old GUILD_CREATE dispatch path: rather than pushing a synthesised
 * payload through Discord's FluxDispatcher (which fights ReadStateStore
 * / GuildRoleStore / billing internals), we hold the data in our own
 * map and the patches in `storePatches.ts` short-circuit reads against
 * it. Idempotent.
 */
export function installGuild(summary: VeilServerSummary): string {
    const syntheticId = registerVeilGuild(summary);
    installedGuildIds.add(syntheticId);
    return syntheticId;
}

/**
 * Reconcile the registered Veil guild list against a fresh `/me/servers`
 * snapshot. Servers that disappeared get unregistered so the sidebar +
 * patched store reads drop them on the next render.
 */
export function reconcileGuilds(summaries: VeilServerSummary[]): void {
    const stillPresent = new Set<string>();
    for (const s of summaries) {
        const synth = installGuild(s);
        stillPresent.add(synth);
    }
    for (const installed of Array.from(installedGuildIds)) {
        if (!stillPresent.has(installed)) {
            unregisterVeilGuild(installed);
            installedGuildIds.delete(installed);
            installedChannelsByGuild.delete(installed);
        }
    }
}

/**
 * Lazily fetch channels + members for a Veil server. First call hits
 * `/server/{id}` and `GET /server/{id}/members`; subsequent calls
 * short-circuit on the in-memory channel set.
 *
 * Channels go through Discord's CHANNEL_CREATE dispatch so ChannelStore
 * sees them; the same records are also stashed on our patch map so
 * GuildChannelStore.getChannels(syntheticGuildId) returns them.
 *
 * Members go through `setVeilGuildMembers` only — no GUILD_MEMBERS_CHUNK
 * dispatch, since that fights GuildMemberStore's own bookkeeping.
 */
export async function ensureGuildDetail(serverId: number, syntheticGuildId: string): Promise<void> {
    if (installedChannelsByGuild.has(syntheticGuildId)) return;
    const inFlight = detailLoadInFlight.get(syntheticGuildId);
    if (inFlight) return inFlight;

    const promise = (async () => {
        try {
            const detail = await getServerDetail(serverId);
            const channels: VeilChannelRecord[] = Array.isArray(detail?.channels) ? detail.channels : [];
            const channelRecordsByDbId = new Map<number, any>();
            for (const c of channels) {
                const raw = buildChannelPayload(c, syntheticGuildId);
                const record = dispatchChannelCreate(raw);
                rememberChannel(syntheticGuildId, raw.id);
                channelRecordsByDbId.set(c.id, record);
            }
            if (!installedChannelsByGuild.has(syntheticGuildId)) {
                installedChannelsByGuild.set(syntheticGuildId, new Set());
            }
            // Wire the channel records into the patched GuildChannelStore.
            setVeilGuildChannels(syntheticGuildId, channels, channelRecordsByDbId);

            // Open the per-server WebSocket and subscribe to every channel
            // the server reported visible. Authoritative perm gating lives
            // server-side in canMemberViewChannelByUuid; this client-side
            // subscribe list is the visible-to-us subset reflected back
            // verbatim, never an inflation.
            const summary: VeilServerSummary = {
                id: detail.server.id,
                uuid: detail.server.uuid,
                name: detail.server.name,
                icon: detail.server.icon ?? null,
                description: detail.server.description ?? null,
                ownerPubkey: detail.server.ownerPubkey,
                flags: detail.server.flags,
                roles: detail.server.memberRoles ?? 0,
                nickname: null,
                memberCount: detail.memberCount
            };
            // Refresh the registered guild record with the latest summary
            // so name/icon/memberCount reflect server state, not stale
            // /me/servers row.
            registerVeilGuild(summary);
            attachServer(summary, channels, syntheticGuildId);

            try {
                const members = await listServerMembers(serverId);
                setVeilGuildMembers(syntheticGuildId, members);
            } catch (err) {
                console.warn("[VeilFlux] failed to load members for guild", syntheticGuildId, err);
            }
        } catch (err) {
            console.warn("[VeilFlux] failed to load channels for guild", syntheticGuildId, err);
        } finally {
            detailLoadInFlight.delete(syntheticGuildId);
        }
    })();
    detailLoadInFlight.set(syntheticGuildId, promise);
    return promise;
}

/**
 * Reset every Veil guild we registered. Store patches stay installed
 * (they're idempotent and the empty data map makes them no-ops); the
 * actual restore of original methods happens via removeStorePatches in
 * the plugin lifecycle.
 */
export function uninstallAll(): void {
    detachAllSockets();
    for (const id of Array.from(installedGuildIds)) {
        unregisterVeilGuild(id);
    }
    installedGuildIds.clear();
    installedChannelsByGuild.clear();
    detailLoadInFlight.clear();
}

export function isVeilGuildInstalled(syntheticId: string): boolean {
    return installedGuildIds.has(syntheticId);
}

export function getInstalledChannelIds(syntheticGuildId: string): ReadonlySet<string> {
    return installedChannelsByGuild.get(syntheticGuildId) ?? new Set();
}
