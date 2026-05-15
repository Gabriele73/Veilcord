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
import { showToast, Toasts, useState } from "@webpack/common";

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

const veilPubkeyLookupComponent = ErrorBoundary.wrap(
    () => <VeilPubkeyLookup />,
    { noop: true }
);

export default definePlugin({
    name: "VeilPubkeyLookup",
    description: "Look up Discord users by their linked Veil public key from the Add Friends screen.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],
    required: true,

    patches: [
        {
            find: "addFriendUsernameRow",
            replacement: {
                match: /(\.addFriendUsernameRow.{0,600}\]\}\))\]/,
                replace: "$1,$self.veilPubkeyLookupComponent()]"
            }
        }
    ],

    veilPubkeyLookupComponent
});
