/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, MessageActions } from "@webpack/common";

import { fetchVeilMessages } from "./api/messages";
import { getEntity, isVeilChannelId } from "./idMap";
import { toMessageRecord } from "./messages/buildMessagePayload";

/**
 * MessageActions.fetchMessages on a Veil channel id can't go to Discord's
 * REST endpoint, so we monkey-patch it. The Veil branch:
 *
 *   1. Resolves the synthetic channel id back to a real Veil channel
 *      id via the in-memory idMap.
 *   2. Calls the signed `/channel/{id}/messages` endpoint.
 *   3. Runs each Veil message through `toMessageRecord`, which injects
 *      the author into UserStore and builds a real Discord MessageRecord.
 *   4. Dispatches LOAD_MESSAGES_SUCCESS so MessageStore renders the
 *      backlog through the regular chat shell.
 *
 * Errors fall through to an empty backlog so the chat area renders an
 * empty state instead of perma-loading.
 */

let originalFetchMessages: ((args: any) => Promise<unknown>) | null = null;
const fetchInFlight = new Map<string, Promise<void>>();

function emitLoad(channelId: string, messages: any[], hasMoreBefore: boolean) {
    FluxDispatcher.dispatch({
        type: "LOAD_MESSAGES_SUCCESS",
        channelId,
        messages,
        isBefore: false,
        isAfter: false,
        hasMoreBefore,
        hasMoreAfter: false
    });
}

async function loadVeilChannel(channelId: string, args: any): Promise<void> {
    const inFlight = fetchInFlight.get(channelId);
    if (inFlight) return inFlight;

    const entity = getEntity(channelId);
    if (!entity || entity.kind !== "channel") {
        emitLoad(channelId, [], false);
        return;
    }

    const before = Number(args?.before);
    const limit = Number(args?.limit) || 30;

    const promise = (async () => {
        try {
            const data = await fetchVeilMessages(entity.dbId, {
                before: Number.isFinite(before) && before > 0 ? before : undefined,
                limit
            });
            // Backend returns messages newest-first; Discord's MessageStore
            // expects them in the same orientation when isBefore=false /
            // isAfter=false (initial load).
            const records = data.messages.map(m => toMessageRecord(channelId, m));
            emitLoad(channelId, records, data.hasMore);
        } catch (err) {
            console.warn("[VeilFlux] fetchVeilMessages failed for", channelId, err);
            emitLoad(channelId, [], false);
        } finally {
            fetchInFlight.delete(channelId);
        }
    })();
    fetchInFlight.set(channelId, promise);
    return promise;
}

export function installMessageInterceptor(): void {
    if (originalFetchMessages) return;
    const fetcher: any = (MessageActions as any).fetchMessages;
    if (typeof fetcher !== "function") return;
    const bound = fetcher.bind(MessageActions);
    originalFetchMessages = bound;

    (MessageActions as any).fetchMessages = function (args: any) {
        const channelId = args?.channelId;
        if (isVeilChannelId(channelId)) {
            void loadVeilChannel(channelId, args);
            return Promise.resolve();
        }
        return bound(args);
    };
}

export function removeMessageInterceptor(): void {
    if (!originalFetchMessages) return;
    (MessageActions as any).fetchMessages = originalFetchMessages;
    originalFetchMessages = null;
    fetchInFlight.clear();
}
