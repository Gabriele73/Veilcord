/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { settings } from "./settings";
import { cryptoService, CryptoService } from "./service";

// veil v0.0.1

export { cryptoService, CryptoService } from "./service";
export type { VeilE2eContext } from "./service";
export { veilApiBase } from "./settings";
export {
    veilApi,
    signedBodyRequest,
    signedHeaderRequest,
    publicGet,
    VeilApiError
} from "./veilApi";
export type { VeilFetchOptions } from "./veilApi";
export { VeilServerSocket } from "./veilWs";
export type { VeilWsEvent, VeilWsListener } from "./veilWs";
export * as VeilCryptoUtils from "./utils";
export * as VeilEd25519 from "./ed25519";
export * as VeilSignedBody from "./signedBody";
export type { CanonicalAttachment } from "./signedBody";
export * as VeilX25519 from "./x25519";
export * as VeilZwc from "./zwc";
export {
    linkPubkeyToDiscord,
    unlinkPubkeyFromDiscord,
    fetchBindingsByDiscordUid,
    fetchDiscordUidByPubkey,
    isBindingActiveAt,
    getActiveBindingForUid
} from "./pubkeyBinding";
export type { BindingRow, BindingsByUid, LinkResult } from "./pubkeyBinding";

export default definePlugin({
    name: "VeilCrypto",
    description: "Shared Ed25519 / vault / passkey crypto service for Veil plugins. Exposes cryptoService for other Veil plugins to import.",
    authors: [Devs.gabriele],
    required: true,

    settings,
    cryptoService,

    start() {
        // Touch the singleton so init kicks off as soon as the plugin manager runs.
        void cryptoService.hasStoredKey().catch(() => { /* ignore */ });
    }
});
