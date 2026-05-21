/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService, VeilServerSocket, VeilWsEvent } from "@plugins/veilCrypto";
import { FluxDispatcher } from "@webpack/common";

import type { VeilChannelRecord, VeilServerSummary } from "./api/servers";
import { isVeilGuildId, registerEntity } from "./idMap";
import { toMessageRecord } from "./messages/buildMessagePayload";

/**
 * One Veil WebSocket per Veil server. The bridge owns connection
 * lifecycle and routes inbound MESSAGE_CREATE / TYPING_* / MEMBER_*
 * events into Discord's FluxDispatcher so the chat shell renders them
 * natively.
 *
 * Security model — defence-in-depth around the server's own gating:
 *
 *   - Backend `/ws/server/{serverId}` already verifies pubkey signature
 *     on connect, checks server membership before accepting the socket,
 *     and re-verifies channel-level visibility before pushing every
 *     broadcast (`broadcastToServerChannel` calls
 *     `resolveViewableMemberPubkeysForChannelUuidCached` and unsubscribes
 *     sessions that have lost access).
 *   - This bridge mirrors that contract on the receive side: only
 *     subscribe to channel uuids that the server-detail fetch returned
 *     for the current pubkey (i.e. visible to us when we asked), only
 *     dispatch MESSAGE_CREATE for events whose `channelId` resolves to
 *     a Veil channel we already registered with Discord's stores via
 *     ensureGuildDetail, and never trust a payload's claimed channel
 *     identity beyond what idMap recorded for our own pubkey.
 *   - The server is the sole gatekeeper. We do not derive "I have
 *     access" from cached client state; we re-fetch server detail on
 *     reconnect so a permission revocation between sessions causes the
 *     server to drop subscriptions we previously held.
 *   - Self-authored messages from the WS broadcast are deduped by
 *     pubkey-equality against our own active pubkey to avoid the WS
 *     echo doubling up the optimistic record `sendInterceptor`
 *     dispatched.
 */

interface ServerBinding {
    socket: VeilServerSocket;
    /** channelUuid → channel db id, derived from getServerDetail */
    channelDbIdByUuid: Map<string, number>;
    /** channel db id → channelUuid, reverse for inbound events */
    uuidByChannelDbId: Map<number, string>;
    /** synthetic guild id stored on idMap for cheap lookup */
    syntheticGuildId: string;
    /** event listener teardown */
    unsubListener: () => void;
}

const bindingsByServerId = new Map<number, ServerBinding>();
let cachedSelfPubkey: string | null = null;

async function getSelfPubkey(): Promise<string | null> {
    if (cachedSelfPubkey) return cachedSelfPubkey;
    try {
        cachedSelfPubkey = (await cryptoService.getPublicKey()).toLowerCase();
    } catch {
        cachedSelfPubkey = null;
    }
    return cachedSelfPubkey;
}

function clearSelfPubkeyCache() {
    cachedSelfPubkey = null;
}

/**
 * Open or refresh the WS connection for a Veil server, and subscribe to
 * every channel the server-detail fetch reported as visible. Idempotent
 * — calling repeatedly on the same server short-circuits to the existing
 * binding and only re-subscribes channels that aren't already known.
 */
export function attachServer(
    summary: VeilServerSummary,
    channels: VeilChannelRecord[],
    syntheticGuildId: string
): void {
    let binding = bindingsByServerId.get(summary.id);

    if (!binding) {
        const socket = new VeilServerSocket(summary.id);
        const channelDbIdByUuid = new Map<string, number>();
        const uuidByChannelDbId = new Map<number, string>();
        const handleEvent = (event: VeilWsEvent) => {
            handleServerEvent(event, summary.id, syntheticGuildId, channelDbIdByUuid, uuidByChannelDbId);
        };
        const unsubListener = socket.onEvent(handleEvent);
        binding = { socket, channelDbIdByUuid, uuidByChannelDbId, syntheticGuildId, unsubListener };
        bindingsByServerId.set(summary.id, binding);
        socket.connect();
    }

    for (const channel of channels) {
        if (!channel.uuid) continue;
        binding.channelDbIdByUuid.set(channel.uuid, channel.id);
        binding.uuidByChannelDbId.set(channel.id, channel.uuid);
        binding.socket.subscribeChannel(channel.uuid);
    }
}

/**
 * Tear down a single server binding. Called when the user leaves a Veil
 * server (server disappears from `/me/servers`) or when the plugin is
 * stopped.
 */
export function detachServer(serverId: number): void {
    const binding = bindingsByServerId.get(serverId);
    if (!binding) return;
    bindingsByServerId.delete(serverId);
    try { binding.unsubListener(); } catch { /* ignore */ }
    try { binding.socket.close(); } catch { /* ignore */ }
}

/**
 * Reconcile bridge state with the latest /me/servers result. Servers
 * we no longer belong to get their socket closed; new servers are
 * connected lazily on first ensureGuildDetail call.
 */
export function reconcileBridge(currentSummaries: VeilServerSummary[]): void {
    const stillPresent = new Set(currentSummaries.map(s => s.id));
    for (const id of Array.from(bindingsByServerId.keys())) {
        if (!stillPresent.has(id)) detachServer(id);
    }
}

/**
 * Close every socket and forget every binding. Used by VeilFlux.stop()
 * so disabling the plugin leaves no Veil-originated WS state behind.
 */
export function detachAll(): void {
    for (const id of Array.from(bindingsByServerId.keys())) {
        detachServer(id);
    }
    clearSelfPubkeyCache();
}

async function handleServerEvent(
    event: VeilWsEvent,
    serverId: number,
    syntheticGuildId: string,
    _channelDbIdByUuid: Map<string, number>,
    uuidByChannelDbId: Map<number, string>
): Promise<void> {
    const type = String(event?.type ?? "");
    if (type !== "MESSAGE_CREATE") {
        // TODO Phase 5: route TYPING_START/STOP, MEMBER_*, ROLE_UPDATE,
        // PRESENCE_UPDATE through Discord's typing / member / presence
        // stores. Phase 4 only carries chat traffic.
        return;
    }

    const payload = (event as any).payload ?? event;
    const channelDbId = Number(payload?.channelId);
    const message = payload?.message;
    if (!Number.isFinite(channelDbId) || !message || typeof message !== "object") return;

    // Server-trusted channel id → synthetic id. We require the channel to
    // already be known to us (registered when ensureGuildDetail ran). If
    // the bridge sees a channel id we never registered, drop the event:
    // it means either the server pushed something we shouldn't see (and
    // server-side perm checks will already have prevented this) or the
    // channel was created after our last detail fetch (Phase 5 will
    // refetch on CHANNEL_CREATE events).
    const channelUuid = uuidByChannelDbId.get(channelDbId);
    if (!channelUuid) return;
    const syntheticChannelId = registerEntity("channel", channelDbId, channelUuid);

    // Defence-in-depth: if Discord's GuildStore doesn't know the guild we
    // claim ownership of (e.g. plugin disabled mid-event), drop.
    if (!isVeilGuildId(syntheticGuildId)) return;
    void serverId;

    // Skip self-authored messages: sendInterceptor already dispatched an
    // optimistic MESSAGE_CREATE and reconciled it with MESSAGE_UPDATE on
    // REST ack. Honouring the WS echo here would render two rows.
    const selfPubkey = await getSelfPubkey();
    const authorPubkey = String(message?.author?.pubkey ?? "").toLowerCase();
    if (selfPubkey && authorPubkey === selfPubkey) return;

    try {
        const record = toMessageRecord(syntheticChannelId, {
            id: String(message.id ?? ""),
            content: String(message.content ?? ""),
            timestamp: Number(message.timestamp ?? Date.now()),
            signature: String(message.signature ?? ""),
            nonce: String(message.nonce ?? ""),
            author: {
                pubkey: String(message.author?.pubkey ?? ""),
                username: String(message.author?.username ?? "Veil user"),
                avatar: String(message.author?.avatar ?? ""),
                badges: Number(message.author?.badges) || 0
            }
        });
        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId: syntheticChannelId,
            message: record,
            optimistic: false
        });
    } catch (err) {
        console.warn("[VeilFlux] WS MESSAGE_CREATE dispatch failed", err);
    }
}

export function getBridgeStateForDebug() {
    return {
        servers: Array.from(bindingsByServerId.entries()).map(([id, b]) => ({
            serverId: id,
            authed: b.socket.isAuthed(),
            channels: Array.from(b.channelDbIdByUuid.keys())
        }))
    };
}
