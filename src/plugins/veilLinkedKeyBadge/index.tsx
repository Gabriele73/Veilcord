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
const KEY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M18.9771 14.7904C21.6743 12.0932 21.6743 7.72013 18.9771 5.02291C16.2799 2.3257 11.9068 2.3257 9.20961 5.02291C7.41866 6.81385 6.8169 9.34366 7.40432 11.6311C7.49906 12 7.41492 12.399 7.14558 12.6684L3.43349 16.3804C3.11558 16.6984 2.95941 17.1435 3.00906 17.5904L3.24113 19.679C3.26587 19.9017 3.36566 20.1093 3.52408 20.2677L3.73229 20.4759C3.89072 20.6343 4.09834 20.7341 4.32101 20.7589L6.4096 20.9909C6.85645 21.0406 7.30164 20.8844 7.61956 20.5665L8.32958 19.8565L6.58343 18.1294C6.28893 17.8382 6.28632 17.3633 6.5776 17.0688C6.86888 16.7743 7.34375 16.7717 7.63825 17.063L9.39026 18.7958L11.3319 16.8541C11.6013 16.5848 12 16.5009 12.3689 16.5957C14.6563 17.1831 17.1861 16.5813 18.9771 14.7904ZM12.5858 8.58579C13.3668 7.80474 14.6332 7.80474 15.4142 8.58579C16.1953 9.36684 16.1953 10.6332 15.4142 11.4142C14.6332 12.1953 13.3668 12.1953 12.5858 11.4142C11.8047 10.6332 11.8047 9.36684 12.5858 8.58579Z" fill="#3ba55c"/></svg>`;

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
