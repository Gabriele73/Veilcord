/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { fetchDiscordUidByPubkey } from "@plugins/veilCrypto";
import { Devs } from "@utils/constants";
import { openUserProfile } from "@utils/discord";
import definePlugin from "@utils/types";
import { createRoot, showToast, Toasts, useState } from "@webpack/common";

const MOUNT_CLASS = "vc-veil-pkl-mount";
const ROW_CLASS_PREFIX = "addFriendUsernameRow";

function VeilPubkeyLookup() {
    const [pubkey, setPubkey] = useState("");
    const [loading, setLoading] = useState(false);

    async function handleSubmit() {
        const trimmed = pubkey.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(trimmed)) {
            showToast("Enter a valid 64-character hex public key.", Toasts.Type.FAILURE);
            return;
        }
        setLoading(true);
        try {
            const result = await fetchDiscordUidByPubkey(trimmed);
            openUserProfile(result.discordUid);
        } catch (err: any) {
            const msg = err?.message || "Couldn't find a user with that key.";
            showToast(msg, Toasts.Type.FAILURE);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="vc-veil-pkl-section">
            <div className="vc-veil-pkl-header">Look up by Veil public key</div>
            <div className="vc-veil-pkl-row">
                <input
                    className="vc-veil-pkl-input"
                    type="text"
                    placeholder="Paste a 64-character hex public key"
                    value={pubkey}
                    onChange={e => setPubkey(e.currentTarget.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSubmit(); }}
                    disabled={loading}
                    maxLength={64}
                />
                <button
                    className="vc-veil-pkl-button"
                    onClick={handleSubmit}
                    disabled={loading || pubkey.trim().length < 64}
                >
                    {loading ? "Looking up..." : "Look up"}
                </button>
            </div>
        </div>
    );
}

const WrappedLookup = ErrorBoundary.wrap(
    () => <VeilPubkeyLookup />,
    { noop: true }
);

let observer: MutationObserver | null = null;
const activeRoots: Array<{ root: any; host: HTMLElement; }> = [];
const mounted = new WeakSet<Element>();

function findRowElement(root: ParentNode): Element | null {
    return root.querySelector(`[class*="${ROW_CLASS_PREFIX}"]`);
}

function ensureMounted(row: Element) {
    if (mounted.has(row)) return;
    const parent = row.parentElement;
    if (!parent) return;
    if (parent.querySelector(`:scope > .${MOUNT_CLASS}`)) {
        mounted.add(row);
        return;
    }

    const host = document.createElement("div");
    host.className = MOUNT_CLASS;
    parent.insertBefore(host, row.nextSibling);

    const root = createRoot(host);
    root.render(<WrappedLookup />);
    activeRoots.push({ root, host });
    mounted.add(row);
}

function unmountAll() {
    while (activeRoots.length) {
        const { root, host } = activeRoots.pop()!;
        try { root.unmount(); } catch { /* ignore */ }
        try { host.remove(); } catch { /* ignore */ }
    }
}

function scan() {
    const row = findRowElement(document);
    if (row) {
        ensureMounted(row);
    } else if (activeRoots.length) {
        // Add Friends page is no longer in DOM, clean up.
        unmountAll();
    }
}

export default definePlugin({
    name: "VeilPubkeyLookup",
    description: "Look up Discord users by their linked Veil public key from the Add Friends screen.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],
    required: true,

    start() {
        scan();
        observer = new MutationObserver(() => scan());
        observer.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        observer?.disconnect();
        observer = null;
        unmountAll();
    }
});
