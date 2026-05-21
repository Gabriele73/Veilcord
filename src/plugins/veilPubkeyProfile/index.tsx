/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { BindingRow, fetchBindingsByDiscordUid } from "@plugins/veilCrypto";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { showToast, Toasts, useEffect, useState } from "@webpack/common";

import { KeyGlyph } from "./KeyGlyph";
import { VeilProfileSection } from "./VeilProfileSection";

interface BindingsState {
    loading: boolean;
    active: BindingRow[];
    previous: BindingRow[];
    error: string | null;
}

const EMPTY_STATE: BindingsState = { loading: true, active: [], previous: [], error: null };

function formatDate(ts: number): string {
    try {
        return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
        return String(ts);
    }
}

function shortPubkey(pubkey: string): string {
    if (pubkey.length <= 16) return pubkey;
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
}

function copy(label: string, value: string) {
    navigator.clipboard.writeText(value).then(
        () => showToast(`${label} copied`, Toasts.Type.SUCCESS),
        () => showToast("Clipboard isn't available right now", Toasts.Type.FAILURE)
    );
}

function BindingRowView({ row, kind }: { row: BindingRow; kind: "active" | "previous"; }) {
    return (
        <li className={`vc-veil-pkp-row vc-veil-pkp-row--${kind}`}>
            <code
                className="vc-veil-pkp-chip"
                title={row.publicKey}
                onClick={() => copy("Public key", row.publicKey)}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        copy("Public key", row.publicKey);
                    }
                }}
            >
                {shortPubkey(row.publicKey)}
            </code>
            <span className="vc-veil-pkp-meta">
                {kind === "active"
                    ? `Linked ${formatDate(row.linkedAt)}`
                    : `${formatDate(row.linkedAt)} → ${row.unlinkedAt != null ? formatDate(row.unlinkedAt) : "?"}`}
            </span>
        </li>
    );
}

function ProfilePubkeysBody({ userId }: { userId: string; }) {
    const [state, setState] = useState<BindingsState>(EMPTY_STATE);
    const [showHistory, setShowHistory] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setState(EMPTY_STATE);
        fetchBindingsByDiscordUid(userId).then(
            result => {
                if (cancelled) return;
                const rows = Array.isArray(result?.bindings) ? result.bindings : [];
                const active = rows.filter(r => r.unlinkedAt == null)
                    .sort((a, b) => b.linkedAt - a.linkedAt);
                const previous = rows.filter(r => r.unlinkedAt != null)
                    .sort((a, b) => (b.unlinkedAt ?? 0) - (a.unlinkedAt ?? 0));
                setState({ loading: false, active, previous, error: null });
            },
            err => {
                if (cancelled) return;
                setState({ loading: false, active: [], previous: [], error: err?.message || "Lookup failed" });
            }
        );
        return () => { cancelled = true; };
    }, [userId]);

    if (state.loading) {
        return (
            <div className="vc-veil-pkp-body vc-veil-pkp-body--loading">
                <KeyGlyph />
                <span>Checking Veil keys…</span>
            </div>
        );
    }

    if (state.error) {
        return (
            <div className="vc-veil-pkp-body vc-veil-pkp-body--empty">
                <KeyGlyph />
                <span>Couldn't check Veil keys.</span>
            </div>
        );
    }

    if (state.active.length === 0 && state.previous.length === 0) {
        return (
            <div className="vc-veil-pkp-body vc-veil-pkp-body--empty">
                <KeyGlyph />
                <span>No Veil key linked to this account.</span>
            </div>
        );
    }

    return (
        <div className="vc-veil-pkp-body">
            {state.active.length > 0 ? (
                <ul className="vc-veil-pkp-list">
                    {state.active.map(row => (
                        <BindingRowView key={`a-${row.linkedAt}`} row={row} kind="active" />
                    ))}
                </ul>
            ) : (
                <div className="vc-veil-pkp-muted">No key linked right now.</div>
            )}

            {state.previous.length > 0 && (
                <button
                    type="button"
                    className="vc-veil-pkp-history-toggle"
                    onClick={() => setShowHistory(v => !v)}
                    aria-expanded={showHistory}
                >
                    {showHistory ? "Hide" : "Show"} previous keys ({state.previous.length})
                </button>
            )}

            {showHistory && state.previous.length > 0 && (
                <ul className="vc-veil-pkp-list vc-veil-pkp-list--history">
                    {state.previous.map(row => (
                        <BindingRowView key={`p-${row.linkedAt}`} row={row} kind="previous" />
                    ))}
                </ul>
            )}
        </div>
    );
}

function ProfilePubkeysSection({ userId }: { userId: string; }) {
    if (!userId) return null;
    return (
        <section className="vc-veil-pkp-section">
            <header className="vc-veil-pkp-header">
                <KeyGlyph />
                <span className="vc-veil-pkp-title">Veil keys</span>
            </header>
            <ProfilePubkeysBody userId={userId} />
        </section>
    );
}

const profilePubkeysComponent = ErrorBoundary.wrap(
    (props: { userId: string; }) => <ProfilePubkeysSection userId={props.userId} />,
    { noop: true }
);

const profileBundleComponent = ErrorBoundary.wrap(
    (props: { userId: string; }) => (
        <>
            <VeilProfileSection userId={props.userId} />
            <ProfilePubkeysSection userId={props.userId} />
        </>
    ),
    { noop: true }
);

export default definePlugin({
    name: "VeilPubkeyProfile",
    description: "Show a user's Veil profile and officially linked Veil public keys on their Discord profile popout, full profile modal, and DM sidebar.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],
    required: true,

    /*
     * Three patches mirror FriendsSince so the section appears in every
     * surface Discord renders user profiles in:
     *   1. DM sidebar profile panel
     *   2. User popout (small overlay)
     *   3. Full profile modal v2 (the big tabbed modal)
     *
     * Each anchors after the "Member Since" pill — the most stable
     * neighbour available across all three views — and captures the
     * uid expression so we can pass it straight into our component
     * without going through Discord's full user object.
     */
    patches: [
        {
            find: "#{intl::PREMIUM_GIFTING_BUTTON}),action:",
            replacement: {
                match: /#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id)}\)}\)/,
                replace: "$&,$self.profileBundleComponent({userId:$1})"
            }
        },
        {
            find: ",applicationRoleConnection:",
            replacement: {
                match: /#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id),.{0,100}}\)}\),/,
                replace: "$&$self.profileBundleComponent({userId:$1}),"
            }
        },
        {
            find: ".MODAL_V2,onClose:",
            replacement: {
                match: /#{intl::USER_PROFILE_MEMBER_SINCE}\),.{0,100}userId:(\i\.id),.{0,100}}\)}\),/,
                replace: "$&$self.profileBundleComponent({userId:$1}),"
            }
        }
    ],

    profilePubkeysComponent,
    profileBundleComponent
});
