/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { addMessageDecoration, MessageDecorationProps, removeMessageDecoration } from "@api/MessageDecorations";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

// veil v0.0.7

type VeilRole = "dev" | "mod" | "staff";

const VEIL_TEAM: Record<string, VeilRole> = {
    "287255751368638464": "dev",
	"610961103962505237": "staff",
};

const ROLE_META: Record<VeilRole, { label: string; tooltip: string; gradient: string; iconSrc: string; }> = {
    dev: {
        label: "Veil Developer",
        tooltip: "Veil Developer",
        gradient: "linear-gradient(135deg, #5865f2, #7289da)",
        iconSrc: "https://cdn.discordapp.com/badge-icons/5e74e9b61934fc1f67c65515d1f7e60d.png"
    },
    mod: {
        label: "Veil Moderator",
        tooltip: "Veil Moderator",
        gradient: "linear-gradient(135deg, #2ecc71, #1f8b4c)",
        iconSrc: "https://cdn.discordapp.com/badge-icons/5e74e9b61934fc1f67c65515d1f7e60d.png"
    },
    staff: {
        label: "Veil Staff",
        tooltip: "Veil Staff",
        gradient: "linear-gradient(135deg, #f1c40f, #c27c0e)",
        iconSrc: "https://cdn.discordapp.com/badge-icons/5e74e9b61934fc1f67c65515d1f7e60d.png"
    }
};

const ROLES = Object.keys(ROLE_META) as VeilRole[];

const badges: ProfileBadge[] = ROLES.map(role => ({
    id: `veil-team-badge-${role}`,
    description: ROLE_META[role].tooltip,
    iconSrc: ROLE_META[role].iconSrc,
    position: BadgePosition.START,
    shouldShow: ({ userId }) => VEIL_TEAM[userId] === role,
    link: "https://github.com/"
}));

const VEIL_FLAIR_ID = "veil-team-flair";

const VeilFlair = ({ message }: MessageDecorationProps) => {
    const role = message?.author?.id ? VEIL_TEAM[message.author.id] : undefined;
    if (!role) return null;
    const meta = ROLE_META[role];
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                height: "0.9375rem",
                padding: "0 0.275rem",
                borderRadius: "0.1875rem",
                background: meta.gradient,
                color: "#fff",
                fontSize: "0.625rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.02em",
                marginLeft: "0.25rem",
                verticalAlign: "baseline",
                lineHeight: 1
            }}
            aria-label={meta.label}
        >
            {meta.label}
        </span>
    );
};

export default definePlugin({
    name: "VeilTeamBadges",
    description: "Recognises official Veil project developers, moderators and staff with a profile badge and message flair (client-side only).",
    authors: [Devs.gabriele],
    dependencies: ["MessageDecorationsAPI"],
    required: true,

    start() {
        for (const badge of badges) addProfileBadge(badge);
        // addMessageDecoration(VEIL_FLAIR_ID, VeilFlair);
    },

    stop() {
        for (const badge of badges) removeProfileBadge(badge);
        removeMessageDecoration(VEIL_FLAIR_ID);
    }
});
