/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { signedBodyRequest, signedHeaderRequest } from "@plugins/veilCrypto";

/**
 * Typed wrappers over the Veil channel-message endpoints. Pinned to
 * `veil-backend/.../routes/serverapi_channel_routes.kt`:
 *
 *   GET  /channel/{id}/messages?before=&limit=
 *     -> { messages: VeilMessage[], hasMore: boolean }
 *
 *   POST /channel/{id}/message
 *     body: { message, timestamp, nonce } (envelope adds nonce)
 *     -> { success, messageId, channelId, content, timestamp,
 *           username, avatar, badges, ... }
 */

export interface VeilMessageAuthor {
    pubkey: string;
    username: string;
    avatar: string;
    badges: number;
}

export interface VeilMessage {
    id: string;
    content: string;
    timestamp: number;
    signature: string;
    nonce: string;
    author: VeilMessageAuthor;
}

interface VeilMessagesResponse {
    messages: VeilMessage[];
    hasMore: boolean;
}

export async function fetchVeilMessages(
    channelDbId: number,
    opts: { before?: number; limit?: number; } = {}
): Promise<VeilMessagesResponse> {
    const params = new URLSearchParams();
    if (opts.before != null) params.set("before", String(opts.before));
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const path = `/channel/${channelDbId}/messages${qs ? `?${qs}` : ""}`;
    const data = await signedHeaderRequest<VeilMessagesResponse>("GET", path);
    return {
        messages: Array.isArray(data?.messages) ? data.messages : [],
        hasMore: Boolean(data?.hasMore)
    };
}

export interface VeilSendResponse {
    success: boolean;
    messageId: string;
    channelId: number;
    channelUuid: string;
    content: string;
    timestamp: number;
    nonce: string;
    username: string;
    avatar: string;
    badges: number;
}

export async function postVeilMessage(channelDbId: number, content: string): Promise<VeilSendResponse> {
    return signedBodyRequest<VeilSendResponse>(
        "POST",
        `/channel/${channelDbId}/message`,
        { message: content, timestamp: Date.now() }
    );
}
