/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService } from "./service";
import { veilApiBase } from "./settings";

/**
 * Client for Veil's per-server WebSocket. One socket per Veil server.
 * Protocol pinned to `veil-backend/.../Application.kt:543` (the
 * `/ws/server/{serverId}` route):
 *
 *   1. Connect to `wss://<apiBase>/ws/server/<serverId>`.
 *   2. Send the auth frame as the first text frame:
 *        { pubkey, signature, timestamp }
 *      where signature is ed25519 over `ws_auth:<serverId>:<timestamp>`.
 *   3. Server replies with `{ type: "AUTH_SUCCESS", ... }` on success
 *      or closes with a 4xxx reason on failure.
 *   4. Subscribe per channel:
 *        { action: "subscribe_channel", channelUuid: "<uuid>" }
 *      Server re-verifies channel visibility via
 *      canMemberViewChannelByUuid before adding the subscription.
 *   5. Server pushes events like
 *        { type: "MESSAGE_CREATE", payload: { channelId, message: {...} } }
 *      ONLY to sessions still authorised at broadcast time (server
 *      cross-checks resolveViewableMemberPubkeysForChannelUuidCached
 *      on every push and drops subscriptions that have lost access).
 *
 * Security invariants — enforced server-side, mirrored client-side as
 * a defence-in-depth check:
 *
 *   - Auth signature is required and bound to `ws_auth:<serverId>:<ts>`
 *     so the same handshake can't be replayed against a different server.
 *   - Channel subscription requests are gated by server-side permission
 *     lookup. The client never trusts its own subscribe-success; if the
 *     server pushes an `ERROR/channel_forbidden` we drop the pending
 *     subscription locally.
 *   - The client never deduces "I can see channel X" from a stale local
 *     state — every fresh socket re-subscribes from scratch so a role
 *     change between sessions causes the server to refuse subscriptions
 *     the client was previously allowed.
 *   - Inbound MESSAGE_CREATE events are tagged with the server-trusted
 *     `channelUuid` field; the bridge maps that back to a synthetic
 *     channel id and never trusts client-derived ids.
 */

export type VeilWsEvent =
    | { type: "AUTH_SUCCESS"; serverId: number; }
    | { type: "AUTH_FAILED"; reason?: string; }
    | { type: "SUBSCRIBED"; channelUuid: string; }
    | { type: "ERROR"; code: string; }
    | { type: "MESSAGE_CREATE"; payload: any; }
    | { type: "CLOSED"; clean: boolean; }
    | { type: string; payload?: any; [k: string]: any; };

export type VeilWsListener = (event: VeilWsEvent) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 25000;

function wsBaseFromApiBase(): string {
    const base = veilApiBase();
    if (base.startsWith("https://")) return "wss://" + base.slice("https://".length);
    if (base.startsWith("http://")) return "ws://" + base.slice("http://".length);
    return base;
}

export class VeilServerSocket {
    private socket: WebSocket | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private closedByUser = false;
    private authed = false;
    private pendingSubs = new Set<string>();
    private confirmedSubs = new Set<string>();
    private listeners = new Set<VeilWsListener>();

    constructor(public readonly serverId: number) { }

    onEvent(listener: VeilWsListener): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private emit(event: VeilWsEvent) {
        for (const l of Array.from(this.listeners)) {
            try { l(event); } catch (err) { console.warn("[VeilWS] listener threw", err); }
        }
    }

    isAuthed(): boolean {
        return this.authed && this.socket?.readyState === WebSocket.OPEN;
    }

    /**
     * Open the socket (if not already) and start the auth handshake.
     * Safe to call repeatedly; second + later calls are no-ops while a
     * connection is in flight or already open.
     */
    connect(): void {
        if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }
        this.closedByUser = false;
        this.openSocket();
    }

    private openSocket(): void {
        const url = `${wsBaseFromApiBase()}/ws/server/${this.serverId}`;
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch (err) {
            console.warn("[VeilWS] WebSocket open failed", err);
            this.scheduleReconnect();
            return;
        }
        this.socket = ws;
        this.authed = false;

        ws.addEventListener("open", () => { void this.sendAuth(); });
        ws.addEventListener("message", e => this.onSocketMessage(e));
        ws.addEventListener("close", e => this.onSocketClose(e));
        ws.addEventListener("error", e => {
            // Errors here are usually followed by close; let onSocketClose
            // drive reconnect to avoid double-scheduling.
            console.warn("[VeilWS] socket error", e);
        });
    }

    private async sendAuth(): Promise<void> {
        try {
            const pubkey = (await cryptoService.getPublicKey()).toLowerCase();
            const timestamp = Date.now();
            const canonical = `ws_auth:${this.serverId}:${timestamp}`;
            const signature = await cryptoService.sign(canonical);
            const payload = JSON.stringify({ pubkey, signature, timestamp });
            this.socket?.send(payload);
        } catch (err) {
            console.warn("[VeilWS] auth send failed", err);
            try { this.socket?.close(4001, "auth failed"); } catch { /* ignore */ }
        }
    }

    private onSocketMessage(e: MessageEvent) {
        if (typeof e.data !== "string") return;
        let json: any;
        try { json = JSON.parse(e.data); } catch { return; }

        const type = String(json?.type ?? "");
        if (type === "AUTH_SUCCESS") {
            this.authed = true;
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            this.flushPendingSubscriptions();
            this.emit({ type: "AUTH_SUCCESS", serverId: this.serverId });
            return;
        }
        if (type === "SUBSCRIBED") {
            const channelUuid = String(json.channelUuid ?? "");
            this.confirmedSubs.add(channelUuid);
            this.pendingSubs.delete(channelUuid);
            this.emit({ type: "SUBSCRIBED", channelUuid });
            return;
        }
        if (type === "ERROR") {
            const code = String(json.code ?? "");
            // Server-rejected subscription means we DON'T have access. Drop
            // it locally so we don't keep retrying nor mis-render messages
            // that arrive on a topic we were never allowed to hear.
            this.pendingSubs.clear();
            this.emit({ type: "ERROR", code });
            return;
        }
        if (type === "pong") return; // heartbeat ack

        // Pass everything else (MESSAGE_CREATE, TYPING_START, PING_CREATE,
        // ROLE_UPDATE, MEMBER_*, etc.) through to listeners. Each event
        // carries server-trusted fields; the bridge handles routing.
        this.emit(json as VeilWsEvent);
    }

    private onSocketClose(e: CloseEvent) {
        this.stopHeartbeat();
        const wasAuthed = this.authed;
        this.authed = false;
        this.socket = null;
        this.confirmedSubs.clear();
        this.emit({ type: "CLOSED", clean: e.wasClean });

        if (this.closedByUser) return;

        // Server signals 4xxx codes for security failures (bad sig, not a
        // member, banned). Don't loop on those — let the bridge decide
        // whether to retry after key change.
        if (e.code === 4001 || e.code === 4003 || e.code === 4400 || e.code === 4401) {
            console.warn("[VeilWS] socket closed by server with code", e.code, e.reason);
            return;
        }

        void wasAuthed; // currently unused, reserved for distinct backoff
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.closedByUser) return;
        this.reconnectAttempts++;
        const delay = Math.min(RECONNECT_BASE_MS * (2 ** Math.min(this.reconnectAttempts, 6)), RECONNECT_MAX_MS);
        const jitter = Math.floor(Math.random() * 250);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openSocket();
        }, delay + jitter);
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.isAuthed()) return;
            try { this.socket?.send(JSON.stringify({ action: "ping" })); } catch { /* ignore */ }
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Queue a channel subscription. If the socket isn't authenticated
     * yet, the request waits in `pendingSubs` until AUTH_SUCCESS.
     *
     * IMPORTANT: confirmation must arrive as a SUBSCRIBED frame from the
     * server. The client never assumes its own subscribe succeeded; if
     * the server returns ERROR/channel_forbidden we strip the request
     * here and let consumers re-fetch via REST instead.
     */
    subscribeChannel(channelUuid: string): void {
        const uuid = String(channelUuid || "").trim();
        if (!uuid) return;
        if (this.confirmedSubs.has(uuid)) return;
        if (!this.isAuthed()) {
            this.pendingSubs.add(uuid);
            return;
        }
        try {
            this.socket?.send(JSON.stringify({ action: "subscribe_channel", channelUuid: uuid }));
            this.pendingSubs.add(uuid);
        } catch (err) {
            console.warn("[VeilWS] subscribe send failed", err);
        }
    }

    unsubscribeChannel(channelUuid: string): void {
        const uuid = String(channelUuid || "").trim();
        if (!uuid) return;
        this.pendingSubs.delete(uuid);
        this.confirmedSubs.delete(uuid);
        if (!this.isAuthed()) return;
        try {
            this.socket?.send(JSON.stringify({ action: "unsubscribe_channel", channelUuid: uuid }));
        } catch (err) {
            console.warn("[VeilWS] unsubscribe send failed", err);
        }
    }

    private flushPendingSubscriptions(): void {
        for (const uuid of Array.from(this.pendingSubs)) {
            try {
                this.socket?.send(JSON.stringify({ action: "subscribe_channel", channelUuid: uuid }));
            } catch (err) {
                console.warn("[VeilWS] flush sub send failed", err);
            }
        }
    }

    close(): void {
        this.closedByUser = true;
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.confirmedSubs.clear();
        this.pendingSubs.clear();
        this.listeners.clear();
        try { this.socket?.close(1000, "client close"); } catch { /* ignore */ }
        this.socket = null;
    }
}
