/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { addServerListElement, removeServerListElement, ServerListRenderPosition } from "@api/ServerList";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { VeilGuildList } from "./components/VeilGuildList";
import { uninstallAll } from "./dispatcher";
import { installAvatarPatch, removeAvatarPatch } from "./avatarPatch";
import { installFetchSuppressor, removeFetchSuppressor } from "./fetchSuppressor";
import { installMessageInterceptor, removeMessageInterceptor } from "./messageInterceptor";
import { installSendInterceptor, removeSendInterceptor } from "./sendInterceptor";
import { installStorePatches, removeStorePatches } from "./storePatches";
import { refreshMyServers } from "./stores/veilGuildStore";

const WrappedVeilGuildList = ErrorBoundary.wrap(VeilGuildList, { noop: true });

/**
 * VeilFlux — Phase 3.
 *
 * Phase 1 shipped sidebar + modal. Phase 2 promoted Veil servers to
 * native Discord guilds via GUILD_CREATE / CHANNEL_CREATE. Phase 3
 * wires real message I/O through Discord's composer + chat shell:
 *
 *   - MessageActions.fetchMessages routes Veil channel ids to
 *     `signedHeaderRequest GET /channel/{id}/messages`, runs results
 *     through Discord's MessageRecord factory, and dispatches
 *     LOAD_MESSAGES_SUCCESS so the chat shell renders backlog with
 *     native markdown / mention / avatar rendering.
 *   - MessageActions.sendMessage routes Veil channel ids to
 *     `signedBodyRequest POST /channel/{id}/message` with optimistic
 *     MESSAGE_CREATE → MESSAGE_UPDATE on ack / MESSAGE_DELETE on
 *     failure.
 *   - Author records (synthetic Discord uids in the 9991<14 decimal>
 *     namespace, derived deterministically from the sender pubkey) are
 *     pushed into UserStore so message headers render correctly.
 *
 * Realtime echo via WebSocket lands in Phase 4. For now, sending a
 * message updates only the sender's chat; other clients see the new
 * message on their next channel open / re-fetch.
 *
 * Disabling this plugin removes every Veil server surface from
 * Discord and restores the original `MessageActions.fetchMessages` /
 * `sendMessage` references.
 */
export default definePlugin({
    name: "VeilFlux",
    description: "Veil servers, rooms, and group chats surfaced inside Discord as native guilds, with native chat send + receive.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto", "ServerListAPI"],

    start() {
        installFetchSuppressor();
        installStorePatches();
        installAvatarPatch();
        installMessageInterceptor();
        installSendInterceptor();
        addServerListElement(ServerListRenderPosition.Above, WrappedVeilGuildList);
        void refreshMyServers();
    },

    stop() {
        removeServerListElement(ServerListRenderPosition.Above, WrappedVeilGuildList);
        removeSendInterceptor();
        removeMessageInterceptor();
        removeAvatarPatch();
        removeStorePatches();
        removeFetchSuppressor();
        uninstallAll();
    }
});
