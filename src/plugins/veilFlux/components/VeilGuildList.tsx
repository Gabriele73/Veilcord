/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService } from "@plugins/veilCrypto";
import { NavigationRouter, useEffect, useState } from "@webpack/common";

import type { VeilServerSummary } from "../api/servers";
import { ensureGuildDetail } from "../dispatcher";
import { getState, refreshMyServers, selectServer, subscribe } from "../stores/veilGuildStore";
import { openVeilJoinModal } from "./VeilJoinModal";
import { VeilGuildTile } from "./VeilGuildTile";

/**
 * Stack of Veil guild tiles injected via `Vencord.Api.ServerList` above
 * the native Discord guild list. Refreshes on mount and whenever the
 * cryptoService emits a state change (link / unlink / passkey unlock).
 *
 * On click we hand off to Discord's own NavigationRouter: the server
 * has already been pushed into GuildStore via reconcileGuilds, so
 * transitionToGuild navigates straight into Discord's native chat
 * shell with the Veil server's name / icon / channel list rendered by
 * the regular guild header and sidebar.
 */
export function VeilGuildList() {
    const [snapshot, setSnapshot] = useState(getState());

    useEffect(() => {
        const unsub = subscribe(() => setSnapshot(getState()));
        const onKeyChange = () => { void refreshMyServers(); };

        // Kick off the first load. The cryptoService initialises async; if
        // the key isn't ready yet, refresh becomes a no-op and we'll try
        // again when veilcrypto:state-change fires.
        void refreshMyServers();

        try {
            globalThis.addEventListener?.("veilcrypto:state-change", onKeyChange as EventListener);
        } catch { /* ignore */ }

        return () => {
            unsub();
            try {
                globalThis.removeEventListener?.("veilcrypto:state-change", onKeyChange as EventListener);
            } catch { /* ignore */ }
        };
    }, []);

    if (snapshot.servers.length === 0) {
        return (
            <div className="vc-veil-guild-stack" data-veil-guild-stack="">
                <div className="vc-veil-guild-section-label" aria-hidden="true">VEIL</div>
                <button
                    type="button"
                    className="vc-veil-guild-add"
                    aria-label="Join or create a Veil server"
                    title="Join or create a Veil server"
                    onClick={() => openVeilJoinModal()}
                >+</button>
                <div className="vc-veil-guild-divider" role="separator" aria-hidden="true" />
            </div>
        );
    }

    const onSelect = (server: VeilServerSummary) => {
        const synth = `99${String(server.id).padStart(16, "0")}`;
        selectServer(synth);
        // Eagerly fetch channel detail so Discord's channel sidebar has
        // something to render the moment the route changes; the dispatch
        // is idempotent and short-circuits on cached results.
        void ensureGuildDetail(server.id, synth);
        try {
            (NavigationRouter as any)?.transitionToGuild?.(synth);
        } catch (err) {
            // Discord refused the route — usually means GuildStore hasn't
            // ingested the GUILD_CREATE yet on this build. Log and let the
            // next refresh + click retry.
            console.warn("[VeilFlux] transitionToGuild failed", err);
        }
    };

    return (
        <div className="vc-veil-guild-stack" data-veil-guild-stack="">
            <div className="vc-veil-guild-section-label" aria-hidden="true">VEIL</div>
            {snapshot.servers.map(server => (
                <VeilGuildTile
                    key={server.uuid || server.id}
                    server={server}
                    selected={snapshot.selectedSyntheticId === `99${String(server.id).padStart(16, "0")}`}
                    onSelect={onSelect}
                />
            ))}
            <button
                type="button"
                className="vc-veil-guild-add"
                aria-label="Join or create a Veil server"
                title="Join or create a Veil server"
                onClick={() => openVeilJoinModal()}
            >+</button>
            <div className="vc-veil-guild-divider" role="separator" aria-hidden="true" />
        </div>
    );
}

// Touch import to keep the dependency edge visible to bundlers when this
// file is the only entry point that imports cryptoService transitively.
void cryptoService;
