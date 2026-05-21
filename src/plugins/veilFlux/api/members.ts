/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { signedHeaderRequest } from "@plugins/veilCrypto";

/**
 * Typed wrapper over `GET /server/{id}/members`. Response shape pinned to
 * `veil-backend/.../routes/serverapi_membership_routes.kt` (lines 416-528):
 * the route enforces server membership before responding, then injects
 * per-pubkey presence from ServerPresenceTracker. Avatar is always a
 * resolvable URL (dicebear fallback applied server-side).
 */

export interface VeilMember {
    pubkey: string;
    username: string;
    serverNickname: string | null;
    avatar: string;
    badges: number;
    roles: number;
    roleIds: number[];
    joinedAt: number;
    status?: string;
    online?: boolean;
    lastSeen?: number;
}

export async function listServerMembers(serverDbId: number): Promise<VeilMember[]> {
    const data = await signedHeaderRequest<{ members: VeilMember[]; }>(
        "GET",
        `/server/${serverDbId}/members`
    );
    return Array.isArray(data?.members) ? data.members : [];
}
