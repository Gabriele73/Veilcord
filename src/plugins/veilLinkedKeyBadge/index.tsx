/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { fetchBindingsByDiscordUid } from "@plugins/veilCrypto";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher, UserProfileStore } from "@webpack/common";

/*
 * Inline key icon (Lucide-style stroke). The stroke colour is baked
 * into the SVG itself rather than relying on `currentColor`, because
 * Discord's badge slot doesn't inherit a usable text colour and the
 * icon would otherwise vanish on some themes (CLAUDE.md UI contrast
 * rule). 24x24 viewBox matches Discord's native badge sizing.
 */
const KEY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3ba55c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg>`;

const KEY_ICON = "data:image/svg+xml;base64," + btoa(KEY_ICON_SVG);

const REPO_URL = "https://github.com/Gabriele73/Veilcord";

/*
 * `shouldShow` runs synchronously per badge render, but the binding
 * lookup is async, so the badge is driven by a module-scope cache.
 *
 *   undefined       → never checked, kick off a fetch, return false.
 *   { value: false }→ recently checked, no key, return false (TTL'd).
 *   { value: true } → user has at least one linked key, return true.
 *
 * After a fetch flips a uid to `true` we re-dispatch
 * USER_PROFILE_FETCH_SUCCESS for the cached profile. UserProfileStore
 * mints a fresh profile reference, the memoised profile components
 * re-render, `getBadges()` runs again, and our now-true `shouldShow`
 * lets the badge through. Without this replay, the first profile open
 * would never see the badge until it was closed and reopened.
 *
 * On boot we also subscribe to USER_PROFILE_MODAL_OPEN and
 * USER_PROFILE_FETCH_SUCCESS so the lookup is kicked off as soon as
 * a profile starts loading, not just when the badge surface asks
 * about it. That removes the visible "blink" between a profile
 * opening and the badge appearing for already-cached uids.
 */
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { value: boolean; at: number; };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<boolean>>();

function isLikelyDiscordUid(uid: string | undefined | null): uid is string {
    return typeof uid === "string" && /^\d{17,20}$/.test(uid);
}

function readCache(userId: string): boolean | null {
    const hit = cache.get(userId);
    if (!hit) return null;
    if (hit.value) return true;
    if (Date.now() - hit.at < NEGATIVE_TTL_MS) return false;
    cache.delete(userId);
    return null;
}

function forceProfileRerender(userId: string): void {
    try {
        const profile = (UserProfileStore as any).getUserProfile?.(userId);
        if (profile) {
            FluxDispatcher.dispatch({ type: "USER_PROFILE_FETCH_SUCCESS", userProfile: profile });
        }
    } catch {
        /* re-render is best-effort; the badge will appear next time
           the profile renders even if this dispatch can't fire. */
    }
}

function lookup(userId: string): void {
    if (!isLikelyDiscordUid(userId)) return;
    if (readCache(userId) !== null) return;
    if (inflight.has(userId)) return;

    const promise = fetchBindingsByDiscordUid(userId).then(
        result => {
            const rows = Array.isArray(result?.bindings) ? result.bindings : [];
            const hasActive = rows.some(r => r && r.unlinkedAt == null && typeof r.publicKey === "string");
            cache.set(userId, { value: hasActive, at: Date.now() });
            if (hasActive) forceProfileRerender(userId);
            return hasActive;
        },
        () => {
            cache.set(userId, { value: false, at: Date.now() });
            return false;
        }
    ).finally(() => {
        inflight.delete(userId);
    });

    inflight.set(userId, promise);
}

const linkedKeyBadge: ProfileBadge = {
    id: "veil-linked-key-badge",
    description: "Veil User",
    iconSrc: KEY_ICON,
    position: BadgePosition.END,
    link: REPO_URL,
    shouldShow: ({ userId }) => {
        if (!isLikelyDiscordUid(userId)) return false;
        const cached = readCache(userId);
        if (cached === null) {
            lookup(userId);
            return false;
        }
        return cached;
    }
};

function onProfileOpen(data: any) {
    const userId = data?.userId ?? data?.user?.id;
    if (typeof userId === "string") lookup(userId);
}

function onProfileFetch(data: any) {
    const userId = data?.userProfile?.userId ?? data?.userProfile?.user?.id;
    if (typeof userId === "string") lookup(userId);
}

export default definePlugin({
    name: "VeilLinkedKeyBadge",
    description: "Adds a green key badge labelled \"Veil User\" to every Discord user who has at least one Veil key linked to their profile. The badge sits at the end of the badge row and links back to the Veilcord repo.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],
    required: true,

    start() {
        addProfileBadge(linkedKeyBadge);
        FluxDispatcher.subscribe("USER_PROFILE_MODAL_OPEN", onProfileOpen);
        FluxDispatcher.subscribe("USER_PROFILE_FETCH_SUCCESS", onProfileFetch);
    },

    stop() {
        FluxDispatcher.unsubscribe("USER_PROFILE_MODAL_OPEN", onProfileOpen);
        FluxDispatcher.unsubscribe("USER_PROFILE_FETCH_SUCCESS", onProfileFetch);
        removeProfileBadge(linkedKeyBadge);
        cache.clear();
        inflight.clear();
    }
});
