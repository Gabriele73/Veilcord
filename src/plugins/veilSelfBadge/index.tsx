/*
 * VeilSelfBadge - a tiny Vencord userplugin that shows a custom profile
 * badge ONLY on your own Discord account, visible ONLY to you (client-side).
 *
 * v0.0.1
 */

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

const MY_USER_ID = "1500785121995788418";

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
