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
import { createRoot } from "@webpack/common";

import { LinkKeyModal } from "./LinkKeyModal";
import { PanelButton } from "./PanelButton";

// veil v0.0.3

const HOST_MARKER = "data-veil-key-host";

let observer: MutationObserver | null = null;
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let scheduled = false;

function openLinkKeyModal() {
    openModal(modalProps => <LinkKeyModal modalProps={modalProps} />);
}

function findInjectionTarget(): { row: HTMLElement; cog: HTMLElement; } | null {
    // Discord's bottom-left user panel is a <section class="panels__<hash>">
    // containing a <div class="buttons__<hash>"> with the audio button parents
    // (wrapped in audioButtonParent__<hash>) and the settings cog as a direct
    // <button> child. The cog is always the LAST direct <button> child of the
    // buttons row across voice/no-voice states.
    const panel = document.querySelector('section[class*="panels__"]') as HTMLElement | null;
    if (!panel) return null;
    const row = panel.querySelector('[class*="buttons__"]') as HTMLElement | null;
    if (!row) return null;
    const directButtons = row.querySelectorAll(":scope > button");
    const cog = directButtons[directButtons.length - 1] as HTMLElement | undefined;
    if (!cog) return null;
    return { row, cog };
}

function ensureInjected() {
    scheduled = false;
    const target = findInjectionTarget();
    if (!target) return;
    const { row, cog } = target;

    // Already correctly placed?
    if (host && host.parentElement === row && host.nextElementSibling === cog) return;

    if (!host) {
        host = document.createElement("span");
        host.setAttribute(HOST_MARKER, "1");
        host.style.display = "inline-flex";
        host.style.alignItems = "center";
    }

    // Re-attach to the right spot. Discord's React reconciler may have removed
    // the host on a re-render — the MutationObserver wakes us back up here and
    // we just put it back.
    if (host.parentElement !== row || host.nextElementSibling !== cog) {
        host.remove();
        row.insertBefore(host, cog);
    }

    if (!root) {
        root = createRoot(host);
        root.render(
            <ErrorBoundary noop>
                <PanelButton onClick={openLinkKeyModal} />
            </ErrorBoundary>
        );
    }
}

function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(ensureInjected);
}

export default definePlugin({
    name: "VeilLinkKey",
    description: "Adds a key button next to the bottom-left settings cog. Lets you paste a hex private key, import an encrypted veil-key-backup file, generate a new keypair, or export an encrypted backup.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],
    required: true,

    start() {
        ensureInjected();
        if (!observer) {
            // Watch the document for the user panel appearing/re-rendering.
            // Throttled via rAF so we coalesce bursts (Discord re-renders the
            // panel a lot — voice state changes, status updates, etc.).
            observer = new MutationObserver(schedule);
            observer.observe(document.body, { childList: true, subtree: true });
        }
    },

    stop() {
        observer?.disconnect();
        observer = null;
        if (root) {
            try { root.unmount(); } catch { /* ignore */ }
            root = null;
        }
        host?.remove();
        host = null;
        scheduled = false;
    },

    openLinkKeyModal
});

