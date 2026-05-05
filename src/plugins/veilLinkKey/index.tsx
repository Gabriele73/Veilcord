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
    required: true,

    patches: [
        {
            // The bottom-left user panel render module — the one that owns the
            // settings cog (and its handleOpenSettingsContextMenu handler).
            find: "handleOpenSettingsContextMenu=",
            replacement: [
                {
                    // Most common shape: cog JSX call has `onClick: <stuff>handleOpenSettingsContextMenu<stuff>`
                    // somewhere in its props. We splice our JSX expression in just before that JSX call,
                    // which is array-balanced inside the surrounding children:[…].
                    match: /(?=\(0,\i{1,3}\.jsx\w*\)\([^,)]{1,80},\{[\s\S]{0,800}?onClick:[\s\S]{0,200}?handleOpenSettingsContextMenu)/,
                    replace: "$self.renderPanelButton(),",
                    noWarn: true
                },
                {
                    // Some Discord builds inline an arrow `()=>this.handleOpenSettingsContextMenu(...)` and
                    // attach it to a non-`onClick` prop (e.g. `onMenuOpen`). Match any prop reference.
                    match: /(?=\(0,\i{1,3}\.jsx\w*\)\([^,)]{1,80},\{[\s\S]{0,800}?\.handleOpenSettingsContextMenu)/,
                    replace: "$self.renderPanelButton(),",
                    noWarn: true
                },
                {
                    // Fallback: anchor on the cog's aria-label intl key.
                    match: /(?=\(0,\i{1,3}\.jsx\w*\)\([^,)]{1,80},\{[\s\S]{0,800}?#{intl::USER_SETTINGS_ACTIONS_MENU_LABEL})/,
                    replace: "$self.renderPanelButton(),",
                    noWarn: true
                }
            ]
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
