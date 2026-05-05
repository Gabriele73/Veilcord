/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./panelButton.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";

import { LinkKeyModal } from "./LinkKeyModal";
import { PanelButton } from "./PanelButton";

// veil v0.0.2

function openLinkKeyModal() {
    openModal(modalProps => <LinkKeyModal modalProps={modalProps} />);
}

export default definePlugin({
    name: "VeilLinkKey",
    description: "Adds a key button next to the bottom-left settings cog. Lets you paste a hex private key, import an encrypted veil-key-backup file, generate a new keypair, or export an encrypted backup.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],
    required: false,

    patches: [
        {
            // The bottom-left user panel render module — the one that owns the
            // settings cog (and its handleOpenSettingsContextMenu handler).
            find: "handleOpenSettingsContextMenu=",
            replacement: {
                // Inject our key panel button right before the settings cog JSX call.
                // Anchor: a JSX call whose props block sets `onClick` to a
                // `handleOpenSettingsContextMenu` reference (this/i/<bare>).
                match: /(?=\(0,[^)]{1,40}\.jsxs?\)\([^,)]+,\{[^{}]{0,500}?onClick:[^,}]*?handleOpenSettingsContextMenu)/,
                replace: "$self.renderPanelButton(),"
            }
        }
    ],

    renderPanelButton() {
        return (
            <ErrorBoundary noop>
                <PanelButton onClick={openLinkKeyModal} />
            </ErrorBoundary>
        );
    },

    openLinkKeyModal
});
