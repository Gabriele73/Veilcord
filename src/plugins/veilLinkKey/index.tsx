/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";

import { LinkKeyModal } from "./LinkKeyModal";
import { PanelButton } from "./PanelButton";

function openLinkKeyModal() {
    openModal(modalProps => <LinkKeyModal modalProps={modalProps} />);
}

function VeilKeyButton() {
    return <PanelButton onClick={openLinkKeyModal} />;
}

export default definePlugin({
    name: "VeilLinkKey",
    description: "Adds a key button next to the bottom-left settings cog. Lets you paste a hex private key, import an encrypted veil-key-backup file, generate a new keypair, or export an encrypted backup.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],
    required: true,

    patches: [
        {
            find: ".DISPLAY_NAME_STYLES_COACHMARK)",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.VeilKeyButton(),"
            }
        }
    ],

    VeilKeyButton: ErrorBoundary.wrap(VeilKeyButton, { noop: true }),

    openLinkKeyModal
});
