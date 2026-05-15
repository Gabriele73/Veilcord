/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { proxyLazy } from "@utils/lazy";
import { findByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, UserStore } from "@webpack/common";

/*
 * Discord stores expect real ChannelRecord / MessageRecord / UserRecord
 * instances (with methods like `isPrivate()`, `isBlockedForMessage()`,
 * etc.), not plain objects. Dispatching CHANNEL_CREATE with a plain
 * object crashes the store with "e.isPrivate is not a function" and
 * the DM list crashes with "PrivateChannel.renderAvatar: no user or
 * channel" if the recipient isn't a real UserRecord. We pull Discord's
 * own factories out of the webpack graph and run our raw payloads
 * through them so the resulting instances have the full prototype
 * chain Discord expects.
 */
const createChannelRecordFromServer = findByCodeLazy(".GUILD_TEXT]", "fromServer)");
const createMessageRecord = findByCodeLazy(".createFromServer(", ".isBlockedForMessage", "messageReference:");
const UserRecord: any = proxyLazy(() => (UserStore.getCurrentUser() as any).constructor);

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
const WELCOME_SHOWN_KEY = "VeilSystemDM_welcome_shown_v1";
const ID_MIGRATION_KEY = "VeilSystemDM_id_migrated_v2";

export interface StoredMessage {
    id: string;
    content: string;
    timestamp: number;
}

let lastInjectedChannel = false;

/*
 * In-memory queue of non-persisted messages dispatched during this
 * session (e.g. the boot-time welcome line). seedMessages mixes them
 * into the LOAD_MESSAGES_SUCCESS payload so that opening the channel
 * after fetchMessages was short-circuited doesn't wipe transient
 * notices from the rendered scrollback.
 */
const ephemeralMessages: StoredMessage[] = [];

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
    /*
     * Discord's CHANNEL_CREATE store handler ingests `recipients` entries
     * into UserStore. Passing just the recipient id leaves UserStore
     * empty for that id, and the DM list's PrivateChannel component
     * crashes on render with "renderAvatar: no user or channel".
     * Pass the full user object so the recipient is registered as a
     * side effect of channel injection.
     */
    return {
        id: VEIL_SYSTEM_CHANNEL_ID,
        type: 1,
        recipients: [buildSystemUser()],
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
 * Build a Discord-format snowflake from a millisecond timestamp.
 *
 * Layout (64 bits):
 *   bits 63..22 : (ts - DISCORD_EPOCH_MS)
 *   bits 21..17 : worker id  (we use 31 — out of Discord's allocation)
 *   bits 16..12 : process id (we use 31 — out of Discord's allocation)
 *   bits 11..0  : 12-bit increment
 *
 * The synthetic channel's `lastMessageId` is the DM list's sort key, so
 * generating message ids from the message's real timestamp lets the
 * channel float to its natural position by recency instead of being
 * pinned at the top by an out-of-range id like the legacy "99999..."
 * scheme produced.
 */
const DISCORD_EPOCH_MS = 1420070400000;
let snowflakeIncrement = 0;

function makeMessageSnowflake(timestampMs: number): string {
    const safeTs = Math.max(timestampMs, DISCORD_EPOCH_MS + 1);
    const tsBits = BigInt(safeTs - DISCORD_EPOCH_MS) << 22n;
    const workerBits = 31n << 17n;
    const processBits = 31n << 12n;
    const inc = BigInt((snowflakeIncrement++) & 0xFFF);
    return (tsBits | workerBits | processBits | inc).toString();
}

/*
 * Allocate a synthetic message id derived from `now`. Within a single
 * millisecond the 12-bit increment guarantees uniqueness up to 4096
 * messages, far beyond anything VeilSystemDM ever produces.
 */
function nextMessageId(): string {
    return makeMessageSnowflake(Date.now());
}

/*
 * One-shot migration that rewrites any persisted message ids in the
 * legacy "99999..." namespace to real Discord-format snowflakes derived
 * from each message's stored timestamp. Without this, the most recent
 * stored message keeps the channel pinned to the top of the DM list
 * even after we switch the snowflake generator.
 *
 * Idempotent: a flag in DataStore guarantees this runs at most once.
 */
async function migrateLegacyMessageIds(): Promise<void> {
    const already = await DataStore.get<boolean>(ID_MIGRATION_KEY);
    if (already) return;
    try {
        const stored = (await DataStore.get<StoredMessage[]>(MESSAGES_KEY)) ?? [];
        if (stored.length === 0) {
            await DataStore.set(ID_MIGRATION_KEY, true);
            return;
        }
        const sorted = [...stored].sort((a, b) => a.timestamp - b.timestamp);
        const rewritten: StoredMessage[] = sorted.map(m => ({
            id: makeMessageSnowflake(m.timestamp),
            content: m.content,
            timestamp: m.timestamp
        }));
        await DataStore.set(MESSAGES_KEY, rewritten);
        await DataStore.del(COUNTER_KEY);
        await DataStore.set(ID_MIGRATION_KEY, true);
    } catch (e: any) {
        console.warn("[VeilSystemDM] id migration failed:", e?.message ?? e);
    }
}

async function loadMessages(): Promise<StoredMessage[]> {
    return (await DataStore.get<StoredMessage[]>(MESSAGES_KEY)) ?? [];
}

async function saveMessages(messages: StoredMessage[]): Promise<void> {
    await DataStore.set(MESSAGES_KEY, messages);
}

/*
 * Push the synthetic system user into UserStore. Without this, the DM
 * list's PrivateChannel component crashes on render with
 * "renderAvatar: no user or channel" because UserStore.getUser returns
 * undefined for the recipient id.
 */
function injectUser(): void {
    const user = new UserRecord(buildSystemUser());
    FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
}

/*
 * Push the channel into ChannelStore / PrivateChannelStore. Idempotent:
 * subsequent CHANNEL_CREATE dispatches are no-ops on the store.
 */
export function injectChannel(): void {
    injectUser();
    if (ChannelStore.getChannel?.(VEIL_SYSTEM_CHANNEL_ID)) {
        lastInjectedChannel = true;
        return;
    }
    FluxDispatcher.dispatch({
        type: "CHANNEL_CREATE",
        channel: createChannelRecordFromServer(buildChannel())
    });
    lastInjectedChannel = true;
}

/*
 * Seed MessageStore for the synthetic channel with the persisted
 * backlog. Without this, opening the channel triggers a REST fetch
 * to /channels/.../messages which 404s and shows "couldn't load".
 */
/*
 * Seed MessageStore for the synthetic channel with the persisted
 * backlog plus any in-memory ephemeral messages. Always dispatches
 * LOAD_MESSAGES_SUCCESS, even with an empty array, because that's
 * what flips ChannelMessages out of its initial pending state and
 * unblocks rendering. Without this dispatch, opening the channel
 * after the fetchMessages short-circuit leaves the scroller stuck
 * on "loading" forever.
 */
export async function seedMessages(): Promise<void> {
    const stored = await loadMessages();
    const all = [...stored, ...ephemeralMessages];
    FluxDispatcher.dispatch({
        type: "LOAD_MESSAGES_SUCCESS",
        channelId: VEIL_SYSTEM_CHANNEL_ID,
        messages: all.map(s => createMessageRecord(buildMessage(s))),
        isBefore: false,
        isAfter: false,
        hasMoreBefore: false,
        hasMoreAfter: false
    });
}

export async function reinject(): Promise<void> {
    await migrateLegacyMessageIds();
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
        id: nextMessageId(),
        content: opts.content,
        timestamp: Date.now()
    };

    if (opts.persist) {
        const existing = await loadMessages();
        existing.push(stored);
        await saveMessages(existing);
    } else {
        ephemeralMessages.push(stored);
    }

    FluxDispatcher.dispatch({
        type: "MESSAGE_CREATE",
        channelId: VEIL_SYSTEM_CHANNEL_ID,
        message: createMessageRecord(buildMessage(stored)),
        optimistic: false,
        isPushNotification: false
    });
}

export async function clearVeilSystemHistory(): Promise<void> {
    await DataStore.set(MESSAGES_KEY, []);
    ephemeralMessages.length = 0;
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

/*
 * Post the welcome line the first time the user ever boots Veilcord
 * with this plugin enabled, then never again. The "shown" flag is
 * keyed in DataStore so the marker survives restarts. The message
 * itself is persisted normally and lives in the conversation history
 * like any other entry, so the user can scroll up to it forever.
 */
export async function postWelcomeMessageOnce(): Promise<void> {
    const alreadyShown = await DataStore.get<boolean>(WELCOME_SHOWN_KEY);
    if (alreadyShown) return;
    await DataStore.set(WELCOME_SHOWN_KEY, true);
    await postVeilSystemMessage({
        content: "Veil is loaded. This channel is where Veil drops tips, warnings, and notices about your keys, signed messages, and E2E sessions. It's read-only, so don't try to reply, the message won't go anywhere.",
        persist: true
    });
}
