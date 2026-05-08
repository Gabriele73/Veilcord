/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ReactDOM, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { DecryptState, getEntry, subscribe } from "./decryptCache";

const FLAIR_META: Record<DecryptState, { className: string; label: string; tooltip: string; }> = {
    loading: {
        className: "vc-veil-e2e-flair vc-veil-e2e-flair--loading",
        label: "Decrypting",
        tooltip: "Decrypting this Veil message."
    },
    decrypted: {
        className: "vc-veil-e2e-flair vc-veil-e2e-flair--decrypted",
        label: "Decrypted",
        tooltip: "End-to-end decrypted with your Veil key."
    },
    "locked-out": {
        className: "vc-veil-e2e-flair vc-veil-e2e-flair--locked",
        label: "Encrypted",
        tooltip: "Encrypted to a different Veil key. You can't read this one."
    },
    failed: {
        className: "vc-veil-e2e-flair vc-veil-e2e-flair--failed",
        label: "Can't decrypt",
        tooltip: "Couldn't decrypt this message. The envelope may have been tampered with."
    },
    "vault-locked": {
        className: "vc-veil-e2e-flair vc-veil-e2e-flair--locked",
        label: "Encrypted",
        tooltip: "Unlock your Veil key to read encrypted messages."
    }
};

function StateGlyph({ state }: { state: DecryptState; }) {
    if (state === "decrypted") {
        return (
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 6h6v3H3zM4 6V4.5a2 2 0 0 1 3.5-1.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
    }
    if (state === "failed") {
        return (
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
        );
    }
    return (
        <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 6h6v3.2H3zM4.2 6V4.4a1.8 1.8 0 0 1 3.6 0V6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export function E2eBadge({ messageId }: { messageId: string; }) {
    const [state, setState] = useState<DecryptState | null>(() => getEntry(messageId)?.state ?? null);

    useEffect(() => {
        setState(getEntry(messageId)?.state ?? null);
        return subscribe(changedId => {
            if (changedId !== messageId) return;
            setState(getEntry(messageId)?.state ?? null);
        });
    }, [messageId]);

    /*
     * Portal the badge into the trailing edge of the message-content
     * element, the same slot the signed-message check uses, so it flows
     * after the last word the way the native "(edited)" marker does.
     * MutationObserver re-attaches if Discord rebuilds the content node
     * (edits, reactions, embed loads).
     */
    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const [host, setHost] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const li = anchor.closest("li[id^=\"chat-messages-\"]") as HTMLElement | null;
        if (!li) return;

        let attached: HTMLElement | null = null;

        const ensureHost = () => {
            const content = li.querySelector("[id^=\"message-content-\"]") as HTMLElement | null;
            if (!content) {
                if (attached) { attached = null; setHost(null); }
                return;
            }
            let h = content.querySelector(":scope > .vc-veil-e2e-overlay") as HTMLElement | null;
            if (!h || !h.isConnected || h.parentElement !== content) {
                h = document.createElement("span");
                h.className = "vc-veil-e2e-overlay";
                content.appendChild(h);
            }
            if (attached !== h) { attached = h; setHost(h); }
        };

        ensureHost();

        const observer = new MutationObserver(() => {
            const ok = attached && attached.isConnected
                && attached.parentElement?.id?.startsWith("message-content-") === true;
            if (!ok) ensureHost();
        });
        observer.observe(li, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [messageId]);

    if (state == null) return <span ref={anchorRef} className="vc-veil-e2e-anchor" aria-hidden="true" />;

    const meta = FLAIR_META[state];
    const badge = (
        <span
            className={meta.className}
            title={meta.tooltip}
            aria-label={meta.tooltip}
            data-state={state}
        >
            <StateGlyph state={state} />
            <span className="vc-veil-e2e-flair__label">{meta.label}</span>
        </span>
    );

    return (
        <>
            <span ref={anchorRef} className="vc-veil-e2e-anchor" aria-hidden="true" />
            {host && ReactDOM.createPortal(badge, host)}
        </>
    );
}
