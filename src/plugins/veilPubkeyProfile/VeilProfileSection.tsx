/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { showToast, Toasts, useEffect, useState } from "@webpack/common";

import { veilApiBase } from "@plugins/veilCrypto";

import { fetchVeilProfileForDiscordUid, VeilProfile } from "./profile";

interface State {
    loading: boolean;
    profile: VeilProfile | null;
}

const EMPTY: State = { loading: true, profile: null };

function copyText(label: string, value: string) {
    navigator.clipboard.writeText(value).then(
        () => showToast(`${label} copied`, Toasts.Type.SUCCESS),
        () => showToast("Clipboard isn't available right now", Toasts.Type.FAILURE)
    );
}

function shortPubkey(pubkey: string): string {
    if (!pubkey) return "";
    if (pubkey.length <= 16) return pubkey;
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
}

function ProfileBody({ profile }: { profile: VeilProfile; }) {
    const veilProfileUrl = `${veilApiBase().replace(/\/api(\.|\/)/, "/")}/user.html?id=${encodeURIComponent(profile.pubkey)}`;
    const fallbackUrl = `https://veil.rip/user.html?id=${encodeURIComponent(profile.pubkey)}`;
    const linkUrl = /\bveil\.rip\b/.test(veilProfileUrl) ? veilProfileUrl : fallbackUrl;

    return (
        <div className="vc-veil-profile-body">
            <div className="vc-veil-profile-row">
                {profile.avatar ? (
                    <img
                        className="vc-veil-profile-avatar"
                        src={profile.avatar}
                        alt=""
                        draggable={false}
                        onError={e => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                    />
                ) : null}
                <div className="vc-veil-profile-name-block">
                    <div className="vc-veil-profile-name">{profile.nickname}</div>
                    <code
                        className="vc-veil-profile-pubkey"
                        title={profile.pubkey}
                        role="button"
                        tabIndex={0}
                        onClick={() => copyText("Public key", profile.pubkey)}
                        onKeyDown={e => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                copyText("Public key", profile.pubkey);
                            }
                        }}
                    >
                        {shortPubkey(profile.pubkey)}
                    </code>
                </div>
            </div>

            {profile.description ? (
                <p className="vc-veil-profile-desc">{profile.description}</p>
            ) : null}

            <div className="vc-veil-profile-meta">
                {profile.badges > 0 ? (
                    <span className="vc-veil-profile-badges" title={`${profile.badges} Veil badge${profile.badges === 1 ? "" : "s"}`}>
                        {profile.badges} badge{profile.badges === 1 ? "" : "s"}
                    </span>
                ) : null}
                <a
                    className="vc-veil-profile-link"
                    href={linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    View on Veil
                </a>
            </div>
        </div>
    );
}

function VeilProfileSectionInner({ userId }: { userId: string; }) {
    const [state, setState] = useState<State>(EMPTY);

    useEffect(() => {
        let cancelled = false;
        setState(EMPTY);
        fetchVeilProfileForDiscordUid(userId).then(
            profile => { if (!cancelled) setState({ loading: false, profile }); },
            () => { if (!cancelled) setState({ loading: false, profile: null }); }
        );
        return () => { cancelled = true; };
    }, [userId]);

    // Render nothing while we're checking, and nothing when there's no
    // linked Veil profile. Avoid showing an empty placeholder so users
    // without Veil don't see noise on every Discord profile they open.
    if (state.loading || !state.profile) return null;

    return (
        <section className="vc-veil-profile-section">
            <header className="vc-veil-profile-header">
                <span className="vc-veil-profile-title">Veil profile</span>
            </header>
            <ProfileBody profile={state.profile} />
        </section>
    );
}

export const VeilProfileSection = ErrorBoundary.wrap(
    (props: { userId: string; }) => <VeilProfileSectionInner userId={props.userId} />,
    { noop: true }
);
