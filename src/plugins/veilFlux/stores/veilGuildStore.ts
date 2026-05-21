/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService } from "@plugins/veilCrypto";

import { listMyServers, VeilServerSummary } from "../api/servers";
import { reconcileGuilds, uninstallAll } from "../dispatcher";
import { registerEntity } from "../idMap";
import { reconcileBridge } from "../wsBridge";

/**
 * Lightweight reactive store of "my Veil servers". Not a Flux store yet —
 * Phase 1 only needs sidebar rendering and a click target. When Phase 2
 * patches `GuildStore.getGuild`, this store becomes the data source for
 * the routing patches and graduates to a real FluxStore registration.
 */

type Listener = () => void;

interface State {
    loading: boolean;
    error: string | null;
    servers: VeilServerSummary[];
    /** synthetic id (string) → server summary */
    bySyntheticId: Map<string, VeilServerSummary>;
    /** synthetic id of the most recently selected Veil server, if any */
    selectedSyntheticId: string | null;
}

const listeners = new Set<Listener>();
let state: State = {
    loading: false,
    error: null,
    servers: [],
    bySyntheticId: new Map(),
    selectedSyntheticId: null
};

function emit() {
    for (const l of Array.from(listeners)) {
        try { l(); } catch (e) { console.warn("[VeilFlux] listener threw", e); }
    }
}

function setState(patch: Partial<State>) {
    state = { ...state, ...patch };
    emit();
}

export function getState(): State {
    return state;
}

export function subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

export function selectServer(syntheticId: string | null) {
    setState({ selectedSyntheticId: syntheticId });
}

export async function refreshMyServers(): Promise<void> {
    if (!(await cryptoService.hasStoredKey())) {
        setState({ loading: false, error: null, servers: [], bySyntheticId: new Map() });
        // No active key → nothing to mirror into Flux. Drop any guilds we
        // had pushed earlier in this session so the sidebar stays clean
        // after a sign-out or key clear.
        uninstallAll();
        return;
    }

    setState({ loading: true, error: null });
    try {
        const servers = await listMyServers();
        const bySyntheticId = new Map<string, VeilServerSummary>();
        for (const s of servers) {
            const synth = registerEntity("server", s.id, s.uuid);
            bySyntheticId.set(synth, s);
        }
        // Reconcile mirror state with Discord's GuildStore: GUILD_CREATE
        // for new servers, GUILD_DELETE for servers we no longer belong to.
        reconcileGuilds(servers);
        // Reconcile WS sockets: drop sockets for servers that disappeared.
        // New sockets open lazily inside ensureGuildDetail.
        reconcileBridge(servers);
        setState({ loading: false, servers, bySyntheticId, error: null });
    } catch (err: any) {
        setState({
            loading: false,
            error: err?.message || "Couldn't load Veil servers",
            servers: [],
            bySyntheticId: new Map()
        });
    }
}

export function getServerBySyntheticId(syntheticId: string): VeilServerSummary | null {
    return state.bySyntheticId.get(syntheticId) ?? null;
}

export function getSyntheticIdForServer(serverId: number): string {
    return registerEntity("server", serverId);
}
