/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getActiveBindingForUid, publicGet, VeilApiError } from "@plugins/veilCrypto";

/**
 * Fetch the Veil profile that's authoritatively linked to a Discord uid.
 *
 * Flow:
 *   1. Look up the active OAuth binding (uid → pubkey).
 *   2. Hit the public `/user/{pubkey}` endpoint to read profile data.
 *
 * Returns `null` if no binding exists or the profile isn't reachable.
 * Never throws — callers render this inline next to other profile chrome
 * and should degrade silently for users who haven't linked a Veil key.
 *
 * Pinned to `veil-backend/.../routes/userapi.kt:13`. The response shape
 * is `{ user, avatar, desc, badges, pubkey, uid }`.
 */

export interface VeilProfile {
    nickname: string;
    avatar: string;
    description: string;
    badges: number;
    pubkey: string;
    uid: string;
}

interface RawProfile {
    user?: string;
    avatar?: string;
    desc?: string;
    badges?: number;
    pubkey?: string;
    uid?: string | number;
}

function normalize(raw: RawProfile): VeilProfile | null {
    if (!raw || typeof raw !== "object") return null;
    const nickname = String(raw.user ?? "").trim() || "Veil user";
    const avatar = String(raw.avatar ?? "").trim();
    const description = String(raw.desc ?? "").trim();
    const badges = Number.isFinite(raw.badges as number) ? Number(raw.badges) : 0;
    const pubkey = String(raw.pubkey ?? "").trim();
    const uid = String(raw.uid ?? "").trim();
    if (!pubkey) return null;
    return { nickname, avatar, description, badges, pubkey, uid };
}

const cache = new Map<string, { ts: number; value: VeilProfile | null; }>();
const CACHE_TTL_MS = 60_000;

export async function fetchVeilProfileForDiscordUid(discordUid: string): Promise<VeilProfile | null> {
    const key = String(discordUid || "").trim();
    if (!key) return null;

    const cached = cache.get(key);
    const now = Date.now();
    if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.value;

    try {
        const binding = await getActiveBindingForUid(key);
        if (!binding?.publicKey) {
            cache.set(key, { ts: now, value: null });
            return null;
        }

        const raw = await publicGet<RawProfile>(`/user/${encodeURIComponent(binding.publicKey)}`);
        const value = normalize(raw);
        cache.set(key, { ts: now, value });
        return value;
    } catch (err) {
        if (err instanceof VeilApiError && err.status === 404) {
            cache.set(key, { ts: now, value: null });
            return null;
        }
        // Network or transient error — don't poison the cache so the next
        // render gets a fresh chance.
        return null;
    }
}

export function invalidateVeilProfileCache(discordUid?: string) {
    if (discordUid) cache.delete(discordUid);
    else cache.clear();
}
