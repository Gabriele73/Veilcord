/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { signedHeaderRequest, signedBodyRequest } from "@plugins/veilCrypto";

/**
 * Typed wrappers over the Veil server / channel / message endpoints. Every
 * call routes through the cryptoService-signed envelope (CLAUDE.md rule).
 *
 * Endpoint shapes are pinned to `veil-backend/.../routes/serverapi_*.kt`.
 */

export interface VeilServerSummary {
    id: number;
    uuid: string;
    name: string;
    icon: string | null;
    description: string | null;
    ownerPubkey: string;
    flags: number;
    roles: number;
    nickname: string | null;
    memberCount: number;
}

export interface VeilChannelRecord {
    id: number;
    uuid: string;
    name: string;
    type: number;
    topic: string | null;
    position: number;
    parentId: number | null;
    flags: number;
    permissions?: number;
    canSend?: boolean;
    canManageMessages?: boolean;
}

export interface VeilServerDetail {
    server: {
        id: number;
        uuid: string;
        name: string;
        description: string | null;
        icon: string | null;
        ownerPubkey: string;
        ownerName: string | null;
        ownerAvatar: string | null;
        createdAt: number;
        flags: number;
        isMember: boolean;
        memberRoles: number;
        memberPermissions: number;
    };
    channels: VeilChannelRecord[];
    memberCount: number;
}

export async function listMyServers(): Promise<VeilServerSummary[]> {
    const data = await signedHeaderRequest<{ servers: VeilServerSummary[]; }>("GET", "/me/servers");
    return Array.isArray(data?.servers) ? data.servers : [];
}

export async function getServerDetail(serverId: number): Promise<VeilServerDetail> {
    return signedHeaderRequest<VeilServerDetail>("GET", `/server/${serverId}`);
}

export interface CreateServerInput {
    name: string;
    description?: string;
    icon?: string;
    discoverable?: boolean;
}

export async function createServer(input: CreateServerInput): Promise<{ id: number; uuid: string; }> {
    const body: Record<string, unknown> = {
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        discoverable: !!input.discoverable
    };
    return signedBodyRequest<{ id: number; uuid: string; }>("POST", "/server/create", body);
}

export async function joinServerByInvite(code: string): Promise<{ serverId: number; }> {
    return signedBodyRequest<{ serverId: number; }>("POST", "/server/join", { code });
}

export async function leaveServer(serverId: number): Promise<void> {
    await signedBodyRequest("POST", `/server/${serverId}/leave`, {});
}
