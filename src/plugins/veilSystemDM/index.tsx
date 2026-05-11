/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    addMessagePreEditListener,
    addMessagePreSendListener,
    MessageEditListener,
    MessageSendListener,
    removeMessagePreEditListener,
    removeMessagePreSendListener
} from "@api/MessageEvents";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher, MessageActions, showToast, Toasts } from "@webpack/common";

import {
    isVeilSystemChannel,
    postVeilSystemMessage,
    reinject,
    seedMessages,
    VEIL_SYSTEM_CHANNEL_ID
} from "./api";

export {
    clearVeilSystemHistory,
    isVeilSystemChannel,
    postVeilSystemMessage,
    VEIL_SYSTEM_CHANNEL_ID,
    VEIL_SYSTEM_USER_ID
} from "./api";

/*
 * Discord's gateway re-syncs DM lists on CONNECTION_OPEN and rebuilds
 * ChannelStore from scratch. Our synthetic channel does not exist on
 * the server side, so it disappears every time the gateway reconnects.
 * Re-inject after a short delay so we run after Discord's own store
 * writes settle.
 */
function onConnectionOpen() {
    setTimeout(() => { void reinject(); }, 1200);
}

/*
 * When the user opens the synthetic channel, Discord fires a REST
 * fetch to /channels/.../messages that 404s. Pre-seeding MessageStore
 * on CHANNEL_SELECT for our channel makes the rendered scrollback
 * come from local storage instead, before the failing fetch lands.
 */
function onChannelSelect(event: any) {
    if (!isVeilSystemChannel(event?.channelId)) return;
    void seedMessages();
}

const blockSend: MessageSendListener = async channelId => {
    if (!isVeilSystemChannel(channelId)) return;
    showToast("This is a read-only Veil channel. You can't reply here.", Toasts.Type.MESSAGE);
    return { cancel: true };
};

const blockEdit: MessageEditListener = async channelId => {
    if (!isVeilSystemChannel(channelId)) return;
    return { cancel: true };
};

/*
 * When the user opens our synthetic channel, Discord's
 * MessageActions.fetchMessages fires an unconditional REST request to
 * /channels/<id>/messages and 400s on our synthetic id. The failure
 * leaves ChannelMessages stuck on "loading" and our seeded backlog
 * never renders. Monkey-patch fetchMessages so calls for our channel
 * resolve immediately and dispatch LOAD_MESSAGES_SUCCESS from local
 * storage, while every other channel keeps the original behaviour.
 */
let originalFetchMessages: ((args: any) => any) | null = null;

function installFetchMessagesPatch(): void {
    if (originalFetchMessages) return;
    const original = (MessageActions as any).fetchMessages?.bind(MessageActions);
    if (typeof original !== "function") return;
    originalFetchMessages = original;
    (MessageActions as any).fetchMessages = function (args: any) {
        if (args?.channelId === VEIL_SYSTEM_CHANNEL_ID) {
            void seedMessages();
            return Promise.resolve();
        }
        return original(args);
    };
}

function removeFetchMessagesPatch(): void {
    if (!originalFetchMessages) return;
    (MessageActions as any).fetchMessages = originalFetchMessages;
    originalFetchMessages = null;
}

export default definePlugin({
    name: "VeilSystemDM",
    description: "Synthetic client-only DM with the Veil bot. Other Veil plugins can post tips, warnings, and notices here. Read-only.",
    authors: [Devs.gabriele],
    required: true,
    dependencies: ["MessageEventsAPI"],

    start() {
        installFetchMessagesPatch();
        addMessagePreSendListener(blockSend);
        addMessagePreEditListener(blockEdit);
        FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
        FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);

        /*
         * Initial inject + boot-time test message. Wait long enough that
         * Discord has finished its own READY/CONNECTION_OPEN store writes,
         * otherwise the channel gets evicted right after we add it.
         */
        setTimeout(async () => {
            try {
                await reinject();
                await postVeilSystemMessage({
                    content: "Veil is loaded. This channel is where Veil drops tips, warnings, and notices about your keys, signed messages, and E2E sessions. It's read-only, so don't try to reply, the message won't go anywhere.",
                    persist: false
                });
            } catch (e: any) {
                console.warn("[VeilSystemDM] boot inject failed:", e?.message ?? e);
            }
        }, 2000);
    },

    stop() {
        removeFetchMessagesPatch();
        removeMessagePreSendListener(blockSend);
        removeMessagePreEditListener(blockEdit);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
    }
});
