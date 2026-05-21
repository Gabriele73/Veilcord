/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, MessageActions } from "@webpack/common";

import { cryptoService } from "@plugins/veilCrypto";

import { postVeilMessage, VeilMessage } from "./api/messages";
import { getEntity, isVeilChannelId } from "./idMap";
import { toMessageRecord } from "./messages/buildMessagePayload";
import { makeSnowflake } from "./records/buildGuildPayload";

/**
 * MessageActions.sendMessage on a Veil channel id can't go to Discord's
 * REST endpoint. Patch it to:
 *
 *   1. Resolve synthetic channel id → Veil db id.
 *   2. Look up our own pubkey + cached profile so the optimistic
 *      message renders with the same user record fetched messages will
 *      use.
 *   3. Dispatch an optimistic MESSAGE_CREATE with a client-generated
 *      nonce so the chat shell shows the message immediately.
 *   4. POST `/channel/{id}/message` via the signed body envelope.
 *   5. On ack, dispatch MESSAGE_UPDATE so the optimistic record is
 *      reconciled with server state. On failure, MESSAGE_DELETE the
 *      optimistic record so the user sees it disappear.
 *
 * Discord's MessageStore dedupes by nonce; we mirror that contract so
 * a successful echo from the WebSocket bridge (Phase 4) doesn't double
 * up.
 */

let originalSendMessage: ((...args: any[]) => any) | null = null;
let optimisticIncrement = 0;

function nextNonce(): string {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    let s = "";
    for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, "0");
    return s;
}

function nextOptimisticIncrement(): number {
    optimisticIncrement = (optimisticIncrement + 1) & 0xfff;
    return optimisticIncrement;
}

interface SelfAuthor {
    pubkey: string;
    username: string;
    avatar: string;
    badges: number;
}

async function resolveSelfAuthor(): Promise<SelfAuthor> {
    const pubkey = (await cryptoService.getPublicKey()).toLowerCase();
    const userData = await cryptoService.getUserData().catch(() => null);
    return {
        pubkey,
        username: userData?.user || userData?.nickname || "You",
        avatar: userData?.avatar || "",
        badges: Number(userData?.badges) || 0
    };
}

function syntheticVeilMessage(opts: {
    nonce: string;
    timestamp: number;
    content: string;
    author: SelfAuthor;
    syntheticId: string;
}): VeilMessage {
    return {
        id: opts.syntheticId,
        content: opts.content,
        timestamp: opts.timestamp,
        signature: "",
        nonce: opts.nonce,
        author: {
            pubkey: opts.author.pubkey,
            username: opts.author.username,
            avatar: opts.author.avatar,
            badges: opts.author.badges
        }
    };
}

async function sendVeilMessage(channelId: string, content: string): Promise<void> {
    const entity = getEntity(channelId);
    if (!entity || entity.kind !== "channel") return;

    const trimmed = String(content || "").trim();
    if (trimmed.length === 0) return;

    const nonce = nextNonce();
    const ts = Date.now();
    const optimisticUuid = `${nonce}-${ts}`;
    const optimisticSnowflake = makeSnowflake(ts, nextOptimisticIncrement());

    let author: SelfAuthor;
    try {
        author = await resolveSelfAuthor();
    } catch (err) {
        console.warn("[VeilFlux] cannot resolve self author for send", err);
        return;
    }

    const optimisticVeilMsg = syntheticVeilMessage({
        nonce,
        timestamp: ts,
        content: trimmed,
        author,
        syntheticId: optimisticUuid
    });

    const optimisticRecord: any = toMessageRecord(channelId, optimisticVeilMsg);
    // Force the optimistic snowflake we just minted; toMessageRecord derives
    // its own from the timestamp + uuid hash, but the dedupe + reconcile
    // path is simpler if the optimistic id stays predictable.
    try { (optimisticRecord as any).id = optimisticSnowflake; } catch { /* frozen */ }
    try { (optimisticRecord as any).nonce = nonce; } catch { /* frozen */ }

    FluxDispatcher.dispatch({
        type: "MESSAGE_CREATE",
        channelId,
        message: optimisticRecord,
        optimistic: true
    });

    try {
        const ack = await postVeilMessage(entity.dbId, trimmed);
        const ackedVeilMsg: VeilMessage = {
            id: ack.messageId,
            content: ack.content,
            timestamp: ack.timestamp,
            signature: "",
            nonce: ack.nonce ?? nonce,
            author: {
                pubkey: author.pubkey,
                username: ack.username || author.username,
                avatar: ack.avatar || author.avatar,
                badges: ack.badges ?? author.badges
            }
        };
        const ackedRecord: any = toMessageRecord(channelId, ackedVeilMsg);
        // Preserve the optimistic snowflake id so MessageStore reconciles
        // in place rather than appending a duplicate row.
        try { (ackedRecord as any).id = optimisticSnowflake; } catch { /* frozen */ }
        try { (ackedRecord as any).nonce = ack.nonce ?? nonce; } catch { /* frozen */ }

        FluxDispatcher.dispatch({
            type: "MESSAGE_UPDATE",
            message: ackedRecord
        });
    } catch (err) {
        console.warn("[VeilFlux] sendVeilMessage failed", err);
        FluxDispatcher.dispatch({
            type: "MESSAGE_DELETE",
            channelId,
            id: optimisticSnowflake,
            mlDeleted: true
        });
    }
}

export function installSendInterceptor(): void {
    if (originalSendMessage) return;
    const sender: any = (MessageActions as any).sendMessage;
    if (typeof sender !== "function") return;
    const bound = sender.bind(MessageActions);
    originalSendMessage = bound;

    (MessageActions as any).sendMessage = function (
        channelId: string,
        messageData: any,
        waitForChannelReady?: boolean,
        options?: any
    ) {
        if (isVeilChannelId(channelId)) {
            const content = messageData?.content;
            void sendVeilMessage(channelId, String(content ?? ""));
            return Promise.resolve();
        }
        return bound(channelId, messageData, waitForChannelReady, options);
    };
}

export function removeSendInterceptor(): void {
    if (!originalSendMessage) return;
    (MessageActions as any).sendMessage = originalSendMessage;
    originalSendMessage = null;
}
