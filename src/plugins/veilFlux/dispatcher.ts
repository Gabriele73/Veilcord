/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByCodeLazy } from "@webpack";
import { FluxDispatcher, GuildStore } from "@webpack/common";

import { listServerMembers } from "./api/members";
import { getServerDetail, VeilChannelRecord, VeilServerSummary } from "./api/servers";
import { registerEntity } from "./idMap";
import { dispatchMemberChunk } from "./members/buildMemberPayload";
import { buildChannelPayload, buildGuildPayload } from "./records/buildGuildPayload";
import { attachServer, detachAll as detachAllSockets } from "./wsBridge";

/**
 * Discord's stores expect real Channel / Guild records, not plain objects.
 * Run our raw payloads through the same factories Discord uses on
 * gateway frames so the resulting instances have the full prototype
 * chain (`isPrivate`, `accessPermissions` getter, etc.).
 *
 * Mirror of the pattern in veilSystemDM/api.ts.
 */
const createChannelRecordFromServer: any = findByCodeLazy(".GUILD_TEXT]", "fromServer)");

/**
 * Tracks which Veil guild ids we've registered with Flux. We dispatch
 * GUILD_DELETE on uninstall and on memberships dropping out of the
 * `/me/servers` listing.
 *
 * Channel detail loads lazily on first selection; this map keeps the
 * synthetic channel ids we've already pushed so reselecting a guild
 * re-emits them as no-ops on the store.
 */
const installedGuildIds = new Set<string>();
const installedChannelsByGuild = new Map<string, Set<string>>();
const detailLoadInFlight = new Map<string, Promise<void>>();

function dispatchGuildCreate(payload: any) {
    FluxDispatcher.dispatch({ type: "GUILD_CREATE", guild: payload });
}

function dispatchGuildDelete(guildId: string) {
    FluxDispatcher.dispatch({ type: "GUILD_DELETE", guild: { id: guildId, unavailable: false } });
}

function dispatchChannelCreate(rawChannel: any) {
    const record = createChannelRecordFromServer(rawChannel);
    FluxDispatcher.dispatch({ type: "CHANNEL_CREATE", channel: record });
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
 * Push a Veil server into Discord's GuildStore as a real Guild record.
 * Idempotent: a duplicate dispatch with no channel changes is a no-op
 * on the store. Channels load lazily via `ensureGuildDetail`.
 */
export function installGuild(summary: VeilServerSummary): string {
    const syntheticId = registerEntity("server", summary.id, summary.uuid);
    if (GuildStore.getGuild?.(syntheticId)) {
        installedGuildIds.add(syntheticId);
        return syntheticId;
    }
    const payload = buildGuildPayload(summary, [], syntheticId);
    dispatchGuildCreate(payload);
    installedGuildIds.add(syntheticId);
    return syntheticId;
}

/**
 * Reconcile the registered Veil guild list against a fresh server list.
 * Servers that disappeared trigger GUILD_DELETE so the sidebar drops
 * them on the next render.
 */
export function reconcileGuilds(summaries: VeilServerSummary[]): void {
    const stillPresent = new Set<string>();
    for (const s of summaries) {
        const synth = installGuild(s);
        stillPresent.add(synth);
    }
    for (const installed of Array.from(installedGuildIds)) {
        if (!stillPresent.has(installed)) {
            dispatchGuildDelete(installed);
            installedGuildIds.delete(installed);
            installedChannelsByGuild.delete(installed);
        }
    }
}

/**
 * Lazily fetch and dispatch channels for a Veil server. First call hits
 * `/server/{id}` and dispatches CHANNEL_CREATE per channel; subsequent
 * calls deduplicate on the in-memory channel id set and resolve cheaply.
 */
export async function ensureGuildDetail(serverId: number, syntheticGuildId: string): Promise<void> {
    if (installedChannelsByGuild.has(syntheticGuildId)) return;
    const inFlight = detailLoadInFlight.get(syntheticGuildId);
    if (inFlight) return inFlight;

    const promise = (async () => {
        try {
            const detail = await getServerDetail(serverId);
            const channels: VeilChannelRecord[] = Array.isArray(detail?.channels) ? detail.channels : [];
            for (const c of channels) {
                const raw = buildChannelPayload(c, syntheticGuildId);
                dispatchChannelCreate(raw);
                rememberChannel(syntheticGuildId, raw.id);
            }
            // Mark the guild as loaded even when there are no channels yet
            // so we don't refetch on every selection.
            if (!installedChannelsByGuild.has(syntheticGuildId)) {
                installedChannelsByGuild.set(syntheticGuildId, new Set());
            }

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
            attachServer(summary, channels, syntheticGuildId);

            // Fetch + dispatch members so the right rail renders. Backend
            // gates `/server/{id}/members` on server membership, so a
            // non-member pubkey can't pull this list. Failure is non-fatal
            // — the channel view still works without a populated rail.
            try {
                const members = await listServerMembers(serverId);
                dispatchMemberChunk(syntheticGuildId, members);
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
 * Reset Flux state for every Veil guild we registered. Called on plugin
 * stop so disabling VeilFlux leaves Discord state in the same shape it
 * had on launch.
 */
export function uninstallAll(): void {
    detachAllSockets();
    for (const id of Array.from(installedGuildIds)) {
        dispatchGuildDelete(id);
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
