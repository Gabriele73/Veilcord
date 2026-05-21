/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { UserStore } from "@webpack/common";

/**
 * Discord's `UserRecord.getAvatarURL()` builds a CDN URL from the user's
 * `id`, `avatar`, and a hash of the username. Veil authors carry a
 * resolvable URL on the shadow `veilAvatarUrl` field but no real Discord
 * avatar hash, so the default path returns a Discord-default avatar
 * instead of the user's Veil avatar.
 *
 * This patch wraps `getAvatarURL` on the live UserRecord prototype: if
 * the record has a `veilAvatarUrl`, return it verbatim; otherwise defer
 * to the original. Install runs once per session; uninstall restores the
 * original method exactly so disabling VeilFlux leaves Discord's user
 * rendering untouched.
 */

const UserRecord: any = proxyLazy(() => (UserStore.getCurrentUser() as any)?.constructor);

let originalGetAvatarURL: ((this: any, ...args: any[]) => any) | null = null;
let installed = false;

export function installAvatarPatch(): void {
    if (installed) return;
    try {
        const proto: any = UserRecord?.prototype;
        if (!proto || typeof proto.getAvatarURL !== "function") return;
        originalGetAvatarURL = proto.getAvatarURL;
        proto.getAvatarURL = function patchedGetAvatarURL(this: any, ...args: any[]) {
            const veilUrl = this?.veilAvatarUrl;
            if (typeof veilUrl === "string" && veilUrl.length > 0) return veilUrl;
            return originalGetAvatarURL!.apply(this, args);
        };
        installed = true;
    } catch (err) {
        console.warn("[VeilFlux] avatar patch install failed", err);
    }
}

export function removeAvatarPatch(): void {
    if (!installed) return;
    try {
        const proto: any = UserRecord?.prototype;
        if (proto && originalGetAvatarURL) {
            proto.getAvatarURL = originalGetAvatarURL;
        }
    } catch (err) {
        console.warn("[VeilFlux] avatar patch remove failed", err);
    } finally {
        originalGetAvatarURL = null;
        installed = false;
    }
}
