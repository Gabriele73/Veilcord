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
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

const MY_USER_ID = "1500785121995788418";
// veil v0.0.4

const badge: ProfileBadge = {
    id: "veil-self-badge",
    description: "Veil",
    iconSrc: "https://cdn.discordapp.com/badge-icons/5e74e9b61934fc1f67c65515d1f7e60d.png",
    position: BadgePosition.START,
    shouldShow: ({ userId }) => userId === MY_USER_ID,
    link: "https://github.com/"
};

export default definePlugin({
    name: "VeilSelfBadge",
    description: "Adds a personal badge to my own Discord profile (client-side only).",
    authors: [Devs.gabriele],
    required: true,

    start() {
        addProfileBadge(badge);
    },

    stop() {
        removeProfileBadge(badge);
    }
});
