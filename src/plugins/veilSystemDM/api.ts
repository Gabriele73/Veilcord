/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { FluxDispatcher } from "@webpack/common";

/*
 * Synthetic, client-only system DM. Ids use a 19-digit "999"-prefixed
 * snowflake space that real Discord ids will never enter, so we can
 * recognise our own channel/user/messages on sight and Discord's BigInt
 * parsers still accept them.
 */
export const VEIL_SYSTEM_USER_ID = "9999900000000000001";
export const VEIL_SYSTEM_CHANNEL_ID = "9999900000000000002";

const MESSAGES_KEY = "VeilSystemDM_messages_v1";
const COUNTER_KEY = "VeilSystemDM_counter_v1";

export interface StoredMessage {
    id: string;
    content: string;
    timestamp: number;
}

let lastInjectedChannel = false;

export function buildSystemUser(): any {
    return {
        id: VEIL_SYSTEM_USER_ID,
        username: "Veil",
        globalName: "Veil",
        global_name: "Veil",
        discriminator: "0000",
        avatar: null,
        bot: true,
        system: true,
        flags: 0,
        publicFlags: 0,
        public_flags: 0,
        accentColor: null,
        banner: null
    };
}

function buildChannel(): any {
    return {
        id: VEIL_SYSTEM_CHANNEL_ID,
        type: 1,
        recipients: [VEIL_SYSTEM_USER_ID],
        recipient_ids: [VEIL_SYSTEM_USER_ID],
        last_message_id: null,
        flags: 0,
        is_spam: false
    };
}

export function buildMessage(stored: StoredMessage): any {
    const isoTs = new Date(stored.timestamp).toISOString();
    return {
        id: stored.id,
        type: 0,
        channel_id: VEIL_SYSTEM_CHANNEL_ID,
        author: buildSystemUser(),
        content: stored.content,
        timestamp: isoTs,
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        reactions: [],
        pinned: false,
        flags: 0
    };
}

/*
 * Allocate a monotonically-increasing synthetic message id. Persisting
 * the counter means ids stay unique across restarts, so MessageStore
 * never sees a collision with a previously-replayed message.
 */
async function nextMessageId(): Promise<string> {
    const counter = (await DataStore.get<number>(COUNTER_KEY)) ?? 0;
    const next = counter + 1;
    await DataStore.set(COUNTER_KEY, next);
    // 19-digit id: "99999" prefix + 14 digits of counter, zero-padded.
    return "99999" + String(next).padStart(14, "0");
}

async function loadMessages(): Promise<StoredMessage[]> {
    return (await DataStore.get<StoredMessage[]>(MESSAGES_KEY)) ?? [];
}

async function saveMessages(messages: StoredMessage[]): Promise<void> {
    await DataStore.set(MESSAGES_KEY, messages);
}

/*
 * Push the channel into ChannelStore / PrivateChannelStore. Idempotent:
 * subsequent CHANNEL_CREATE dispatches are no-ops on the store.
 */
export function injectChannel(): void {
    FluxDispatcher.dispatch({
        type: "CHANNEL_CREATE",
        channel: buildChannel()
    });
    lastInjectedChannel = true;
}

/*
 * Seed MessageStore for the synthetic channel with the persisted
 * backlog. Without this, opening the channel triggers a REST fetch
 * to /channels/.../messages which 404s and shows "couldn't load".
 */
export async function seedMessages(): Promise<void> {
    const stored = await loadMessages();
    if (stored.length === 0) return;
    FluxDispatcher.dispatch({
        type: "LOAD_MESSAGES_SUCCESS",
        channelId: VEIL_SYSTEM_CHANNEL_ID,
        messages: stored.map(buildMessage),
        isBefore: false,
        isAfter: false,
        hasMoreBefore: false,
        hasMoreAfter: false
    });
}

export async function reinject(): Promise<void> {
    injectChannel();
    await seedMessages();
}

/*
 * Public entry point. Persists the message and fires MESSAGE_CREATE so
 * the chat surface updates live if the channel is open.
 *
 * Other Veil plugins import this and call it to post tips/warnings:
 *
 *     import { postVeilSystemMessage } from "@plugins/veilSystemDM";
 *     await postVeilSystemMessage("Link a key to enable signed mode.");
 *
 * Pass `{ persist: false }` for transient one-shot notices (e.g. the
 * boot-time test message) that shouldn't survive restarts.
 */
export async function postVeilSystemMessage(
    contentOrOpts: string | { content: string; persist?: boolean; }
): Promise<void> {
    const opts = typeof contentOrOpts === "string"
        ? { content: contentOrOpts, persist: true }
        : { persist: true, ...contentOrOpts };

    if (!opts.content || typeof opts.content !== "string") return;

    if (!lastInjectedChannel) injectChannel();

    const stored: StoredMessage = {
        id: await nextMessageId(),
        content: opts.content,
        timestamp: Date.now()
    };

    if (opts.persist) {
        const existing = await loadMessages();
        existing.push(stored);
        await saveMessages(existing);
    }

    FluxDispatcher.dispatch({
        type: "MESSAGE_CREATE",
        channelId: VEIL_SYSTEM_CHANNEL_ID,
        message: buildMessage(stored),
        optimistic: false,
        isPushNotification: false
    });
}

export async function clearVeilSystemHistory(): Promise<void> {
    await DataStore.set(MESSAGES_KEY, []);
    FluxDispatcher.dispatch({
        type: "LOAD_MESSAGES_SUCCESS",
        channelId: VEIL_SYSTEM_CHANNEL_ID,
        messages: [],
        isBefore: false,
        isAfter: false,
        hasMoreBefore: false,
        hasMoreAfter: false
    });
}

export function isVeilSystemChannel(channelId: string | null | undefined): boolean {
    return channelId === VEIL_SYSTEM_CHANNEL_ID;
}
