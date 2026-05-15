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
     * Portal the badge into the message-content element so the flair
     * flows inline with the text. We only ensure the host is *attached*
     * to the content node, not that it stays the last child. Fighting
     * Discord for last-child position via a subtree MutationObserver
     * deadlocks the renderer when Discord inserts siblings after our
     * host (embed previews, syntax-highlight passes, reaction bars,
     * etc.): every re-append is itself a mutation that re-fires the
     * observer, and Discord just re-inserts on the next tick. Position
     * is handled by CSS instead.
     */
    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const [host, setHost] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const li = anchor.closest("li[id^=\"chat-messages-\"]") as HTMLElement | null;
        if (!li) return;

        let current: HTMLElement | null = null;

        const ensureHost = () => {
            const content = li.querySelector("[id^=\"message-content-\"]") as HTMLElement | null;
            if (!content) {
                if (current) { current = null; setHost(null); }
                return;
            }
            let h = content.querySelector(":scope > .vc-veil-e2e-overlay") as HTMLElement | null;
            if (!h) {
                h = document.createElement("span");
                h.className = "vc-veil-e2e-overlay";
                content.appendChild(h);
            }
            if (current !== h) { current = h; setHost(h); }
        };

        ensureHost();

        // Observe only direct children of the li so we re-attach if
        // Discord rebuilds the message-content node wholesale (edits,
        // re-renders). We do NOT observe subtree mutations, since those
        // fire on every embed/reaction/highlight tick and would trap us
        // in a render loop with no upside.
        const observer = new MutationObserver(() => {
            if (!current || !current.isConnected) ensureHost();
        });
        observer.observe(li, { childList: true });
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
