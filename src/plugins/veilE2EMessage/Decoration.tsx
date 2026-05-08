/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService, VeilE2eContext } from "@plugins/veilCrypto";
import { ChannelStore, ReactDOM, useEffect, useLayoutEffect, useRef, useState, UserStore } from "@webpack/common";

import { decodeEnvelopeBody } from "./parser";

type DecryptState = "loading" | "decrypted" | "locked-out" | "failed" | "vault-locked";

interface E2eDecorationProps {
    message: any;
    getOwnPlaintext: (discordMessageId: string) => string | null;
}

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

export function E2eDecoration({ message, getOwnPlaintext }: E2eDecorationProps) {
    const parsed = decodeEnvelopeBody(message?.content);
    if (!parsed) return null;

    const authorId: string | null = message?.author?.id ?? null;
    const discordMessageId: string | null = typeof message?.id === "string" ? message.id : null;
    const channelId: string | null = message?.channel_id ?? null;

    const [state, setState] = useState<DecryptState>("loading");
    const [plaintext, setPlaintext] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        const run = async () => {
            if (!discordMessageId || !channelId || !authorId) {
                if (!cancelled) setState("failed");
                return;
            }

            const me = UserStore.getCurrentUser?.();
            if (!me) {
                if (!cancelled) setState("vault-locked");
                return;
            }

            // Fast path: our own outgoing message — use the plaintext we
            // captured from the pre-send listener so we don't ask the
            // vault to decrypt something we already have.
            if (authorId === me.id) {
                const cached = getOwnPlaintext(discordMessageId);
                if (cached != null) {
                    if (!cancelled) {
                        setPlaintext(cached);
                        setState("decrypted");
                    }
                    return;
                }
            }

            if (!(await cryptoService.hasStoredKey())) {
                if (!cancelled) setState("vault-locked");
                return;
            }

            const addressed = await cryptoService.isEnvelopeAddressedToUs(parsed.envelope);
            if (!addressed) {
                if (!cancelled) setState("locked-out");
                return;
            }

            const channel = ChannelStore.getChannel(channelId);
            const recipientUid = authorId === me.id
                ? channel?.getRecipientId?.()
                : me.id;
            if (!recipientUid) {
                if (!cancelled) setState("failed");
                return;
            }

            const ctx: VeilE2eContext = {
                senderUid: authorId,
                recipientUid,
                channelId
            };

            const result = await cryptoService.tryDecryptFromSender(parsed.envelope, ctx);
            if (cancelled) return;
            if (result == null) {
                setState("failed");
            } else {
                setPlaintext(result);
                setState("decrypted");
            }
        };

        void run();

        const onOwnPlaintext = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || detail.discordMessageId !== discordMessageId) return;
            void run();
        };
        const onStateChange = () => { void run(); };
        window.addEventListener("veil-e2e:own-plaintext", onOwnPlaintext as EventListener);
        window.addEventListener("veilcrypto:state-change", onStateChange as EventListener);

        return () => {
            cancelled = true;
            window.removeEventListener("veil-e2e:own-plaintext", onOwnPlaintext as EventListener);
            window.removeEventListener("veilcrypto:state-change", onStateChange as EventListener);
        };
    }, [discordMessageId, channelId, authorId, parsed.base64]);

    /*
     * Portal hosts inside the message content node.
     *
     *   - badgeHost: always present, holds the flair pill so it sits at
     *     the end of the message body just like the signed-message
     *     check mark does.
     *   - coverHost: holds the decrypted plaintext as an inline span.
     *     The CSS hides the original message-content children only when
     *     the parent has `vc-veil-e2e-has-cover`, so for non-decrypted
     *     states the raw "🔒 <base64>\nThis message was encrypted with
     *     Veilcord" stays visible.
     *
     * A MutationObserver re-attaches the hosts if Discord re-renders
     * the message-content (edits, reactions, embed loads, etc.).
     */
    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const [badgeHost, setBadgeHost] = useState<HTMLElement | null>(null);
    const [coverHost, setCoverHost] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const li = anchor.closest("li[id^=\"chat-messages-\"]") as HTMLElement | null;
        if (!li) return;

        let attachedBadge: HTMLElement | null = null;
        let attachedCover: HTMLElement | null = null;

        const ensureHosts = () => {
            const content = li.querySelector("[id^=\"message-content-\"]") as HTMLElement | null;
            if (!content) {
                if (attachedBadge) { attachedBadge = null; setBadgeHost(null); }
                if (attachedCover) { attachedCover = null; setCoverHost(null); }
                return;
            }

            let badge = content.querySelector(":scope > .vc-veil-e2e-overlay") as HTMLElement | null;
            if (!badge || !badge.isConnected || badge.parentElement !== content) {
                badge = document.createElement("span");
                badge.className = "vc-veil-e2e-overlay";
                content.appendChild(badge);
            }
            if (attachedBadge !== badge) { attachedBadge = badge; setBadgeHost(badge); }

            let cover = content.querySelector(":scope > .vc-veil-e2e-cover") as HTMLElement | null;
            if (!cover || !cover.isConnected || cover.parentElement !== content) {
                cover = document.createElement("span");
                cover.className = "vc-veil-e2e-cover";
                content.appendChild(cover);
            }
            if (attachedCover !== cover) { attachedCover = cover; setCoverHost(cover); }
        };

        ensureHosts();

        const observer = new MutationObserver(() => {
            const badgeOk = attachedBadge && attachedBadge.isConnected
                && attachedBadge.parentElement?.id?.startsWith("message-content-") === true;
            const coverOk = attachedCover && attachedCover.isConnected
                && attachedCover.parentElement?.id?.startsWith("message-content-") === true;
            if (!badgeOk || !coverOk) ensureHosts();
        });
        observer.observe(li, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
            const content = li.querySelector("[id^=\"message-content-\"]") as HTMLElement | null;
            content?.classList.remove("vc-veil-e2e-has-cover");
        };
    }, [discordMessageId]);

    // Toggle the "hide raw body, show cover" class on the message
    // content based on whether we have plaintext to show. Mounted in
    // its own effect so it tracks state changes (e.g. vault unlocks
    // after we initially rendered as `vault-locked`).
    useEffect(() => {
        const content = coverHost?.parentElement;
        if (!content) return;
        if (state === "decrypted" && plaintext != null) {
            content.classList.add("vc-veil-e2e-has-cover");
        } else {
            content.classList.remove("vc-veil-e2e-has-cover");
        }
    }, [coverHost, state, plaintext]);

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

    const cover = state === "decrypted" && plaintext != null
        ? <span className="vc-veil-e2e-plaintext">{plaintext}</span>
        : null;

    return (
        <>
            <span ref={anchorRef} className="vc-veil-e2e-anchor" aria-hidden="true" />
            {badgeHost && ReactDOM.createPortal(badge, badgeHost)}
            {coverHost && cover && ReactDOM.createPortal(cover, coverHost)}
        </>
    );
}
