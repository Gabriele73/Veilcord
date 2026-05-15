/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { fetchBindingsByDiscordUid } from "@plugins/veilCrypto";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { useEffect, useState } from "@webpack/common";

/*
 * Inline green key SVG. Colors are baked into the SVG itself (not
 * `currentColor`) because Discord's badge slot doesn't propagate a
 * useful inherited color and the icon would otherwise vanish on
 * some themes (see CLAUDE.md UI contrast notes).
 */
const KEY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
    <path fill="#3ba55c" d="M14.5 3a6.5 6.5 0 1 0 6.32 8.05.75.75 0 0 0-.18-.74l-1.16-1.16a.75.75 0 0 0-1.06 0l-.97.97a.75.75 0 0 1-1.06 0l-1.06-1.06a.75.75 0 0 1 0-1.06l.97-.97a.75.75 0 0 0 0-1.06l-.79-.79A6.47 6.47 0 0 0 14.5 3Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>
    <path fill="#3ba55c" d="m11.5 11.91-7.97 7.97a1.25 1.25 0 0 0 0 1.77l1.06 1.06a1.25 1.25 0 0 0 1.77 0l.97-.97a.75.75 0 0 0 .22-.53V20h1.2a.75.75 0 0 0 .53-.22l.97-.97a.75.75 0 0 0 .22-.53V17h1.2a.75.75 0 0 0 .53-.22l1.06-1.06a.75.75 0 0 0 .22-.53v-1.69a6.55 6.55 0 0 1-1.98-1.59Z"/>
</svg>`;

const KEY_ICON = "data:image/svg+xml;base64," + btoa(KEY_ICON_SVG);

const REPO_URL = "https://github.com/Gabriele73/Veilcord";

/*
 * The Badges API gates badges through a synchronous `shouldShow`, but
 * the binding lookup is async. Rather than fight Discord's render
 * lifecycle from outside React, the badge always opts in via
 * `shouldShow` and a React component owns the async state with hooks.
 * When the lookup resolves negatively the component renders `null`,
 * collapsing to nothing in the badge row. When it resolves positively
 * the component renders the green key image and Discord's tooltip
 * wrapper picks up `description` for the "Veil User" label and
 * `link` for the click-through.
 *
 * Results are cached at module scope so reopening the same profile
 * (or seeing the same user across multiple surfaces) doesn't refetch
 * every time. Negatives are TTL-cached so we eventually re-check a
 * user who linked a key after their profile was first viewed.
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

function lookup(userId: string): Promise<boolean> {
    const cached = readCache(userId);
    if (cached !== null) return Promise.resolve(cached);

    const existing = inflight.get(userId);
    if (existing) return existing;

    const promise = fetchBindingsByDiscordUid(userId).then(
        result => {
            const rows = Array.isArray(result?.bindings) ? result.bindings : [];
            const hasActive = rows.some(r => r && r.unlinkedAt == null && typeof r.publicKey === "string");
            cache.set(userId, { value: hasActive, at: Date.now() });
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
    return promise;
}

function VeilLinkedKeyIcon({ userId }: { userId: string; }) {
    const initial = readCache(userId);
    const [linked, setLinked] = useState<boolean | null>(initial);

    useEffect(() => {
        if (!isLikelyDiscordUid(userId)) {
            setLinked(false);
            return;
        }
        const synchronous = readCache(userId);
        if (synchronous !== null) {
            setLinked(synchronous);
            return;
        }
        let cancelled = false;
        lookup(userId).then(value => {
            if (!cancelled) setLinked(value);
        });
        return () => { cancelled = true; };
    }, [userId]);

    if (!linked) return null;

    return (
        <img
            src={KEY_ICON}
            alt=" "
            aria-hidden
            style={{ width: "1em", height: "1em" }}
        />
    );
}

const linkedKeyBadge: ProfileBadge = {
    id: "veil-linked-key-badge",
    description: "Veil User",
    position: BadgePosition.END,
    link: REPO_URL,
    component: VeilLinkedKeyIcon as ProfileBadge["component"],
    key: "veil-linked-key",
    shouldShow: ({ userId }) => isLikelyDiscordUid(userId)
};

export default definePlugin({
    name: "VeilLinkedKeyBadge",
    description: "Adds a green key badge labelled \"Veil User\" to every Discord user who has at least one Veil key linked to their profile. The badge sits at the end of the badge row and links back to the Veilcord repo.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],
    required: true,

    start() {
        addProfileBadge(linkedKeyBadge);
    },

    stop() {
        removeProfileBadge(linkedKeyBadge);
        cache.clear();
        inflight.clear();
    }
});
