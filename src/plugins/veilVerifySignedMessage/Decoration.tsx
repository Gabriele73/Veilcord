/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService, isBindingActiveAt, veilApiBase } from "@plugins/veilCrypto";
import { openModal } from "@utils/modal";
import { ReactDOM, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { extractVeilSigRef, stripZwc, VeilSigRef } from "./parser";
import { VerifyModal } from "./VerifyModal";

type FlairState = "loading" | "verified" | "signed" | "invalid" | "unverified";

/**
 * Module-level cache keyed by `<lookup>:<authorId>` where `<lookup>` is either
 * `v2:<backend id>` or `v3:<discord message id>`.
 *
 * `verified` and `invalid` are stable: a signed-message record never mutates,
 * and a binding's history is append-only, so once we've confirmed the
 * (uid, pubkey) was bound at the message's createdAt that fact can't be
 * revoked retroactively.
 *
 * `signed` may upgrade to `verified` if the user links their key after the
 * message was sent — revalidate after `SIGNED_REVALIDATE_AFTER_MS`.
 *
 * `unverified` is a soft state: maybe the sender's POST landed late, maybe
 * the marker is fake. Revalidate after `UNVERIFIED_REVALIDATE_AFTER_MS` so
 * we don't hammer the backend, but the sender's own-message event listener
 * (below) can also bust the entry on demand.
 */
const flairCache = new Map<string, { state: FlairState; ts: number; }>();
const inflight = new Map<string, Promise<FlairState>>();

const SIGNED_REVALIDATE_AFTER_MS = 5 * 60 * 1000;
const UNVERIFIED_REVALIDATE_AFTER_MS = 60 * 1000;

/** Backoff schedule (ms from start) for fetching a record that may be in-flight. */
const FETCH_RETRY_DELAYS_MS = [0, 1500, 4000, 9000, 18000];

/**
 * Custom event dispatched by the signer plugin when its backend POST succeeds,
 * so any mounted decoration for that Discord message id can immediately
 * re-fetch and flip from `loading`/`unverified` to its real state.
 */
const REGISTERED_EVENT = "veil:signed-message:registered";

function bustCacheForDiscordMessageId(discordMessageId: string) {
    const prefix = `v3:${discordMessageId}:`;
    for (const key of Array.from(flairCache.keys())) {
        if (key.startsWith(prefix)) flairCache.delete(key);
    }
}

interface LookupInput {
    sigRef: VeilSigRef;
    /** Discord message id — required for v3 lookups. */
    discordMessageId: string | null;
    /** Live Discord message content with ZWC stripped — required to verify v3. */
    strippedContent: string;
    authorId: string | null;
}

function fnv1a32(str: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

function lookupKey({ sigRef, discordMessageId, authorId, strippedContent }: LookupInput): string | null {
    if (sigRef.v === 2) return sigRef.id ? `v2:${sigRef.id}:${authorId ?? ""}` : null;
    if (discordMessageId) return `v3:${discordMessageId}:${authorId ?? ""}:${fnv1a32(strippedContent)}`;
    return null;
}

async function fetchRecordOnce(sigRef: VeilSigRef, discordMessageId: string | null): Promise<any | null> {
    const base = veilApiBase();
    let url: string;
    if (sigRef.v === 2 && sigRef.id) {
        url = `${base}/veilcord/signed-message/${encodeURIComponent(sigRef.id)}`;
    } else if (discordMessageId) {
        url = `${base}/veilcord/signed-message/by-discord/${encodeURIComponent(discordMessageId)}`;
    } else {
        return null;
    }
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const raw = await res.json().catch(() => null);
    if (!raw || typeof raw !== "object") return null;
    return raw;
}

async function fetchRecordWithRetry(
    sigRef: VeilSigRef,
    discordMessageId: string | null,
    onRetry: () => void
): Promise<any | null> {
    for (let attempt = 0; attempt < FETCH_RETRY_DELAYS_MS.length; attempt++) {
        const delay = FETCH_RETRY_DELAYS_MS[attempt];
        if (delay > 0) {
            await new Promise(r => setTimeout(r, delay));
            onRetry();
        }
        const raw = await fetchRecordOnce(sigRef, discordMessageId);
        if (raw) return raw;
    }
    return null;
}

async function computeFlairState(
    input: LookupInput,
    onLoadingTick: () => void
): Promise<FlairState> {
    const key = lookupKey(input);
    if (!key) return "unverified";

    const cached = flairCache.get(key);
    if (cached) {
        const fresh =
            cached.state === "verified" ||
            cached.state === "invalid" ||
            (cached.state === "signed" && Date.now() - cached.ts < SIGNED_REVALIDATE_AFTER_MS) ||
            (cached.state === "unverified" && Date.now() - cached.ts < UNVERIFIED_REVALIDATE_AFTER_MS);
        if (fresh) return cached.state;
    }
    const running = inflight.get(key);
    if (running) return running;

    const promise = (async (): Promise<FlairState> => {
        try {
            const raw = await fetchRecordWithRetry(input.sigRef, input.discordMessageId, onLoadingTick);
            if (!raw) return "unverified";

            const publicKey = typeof raw.publicKey === "string" ? raw.publicKey : null;
            const signature = typeof raw.signature === "string" ? raw.signature : null;
            const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : null;
            if (!publicKey || !signature) return "unverified";

            const signedBody =
                input.sigRef.v === 2 && typeof raw.message === "string"
                    ? raw.message
                    : input.strippedContent;

            const sigOk = await cryptoService.verify(signedBody, signature, publicKey);
            if (!sigOk) return "invalid";

            if (!input.authorId || createdAt == null) return "signed";

            const active = await isBindingActiveAt(input.authorId, publicKey, createdAt);
            return active ? "verified" : "signed";
        } catch {
            return "unverified";
        }
    })();

    inflight.set(key, promise);
    try {
        const result = await promise;
        flairCache.set(key, { state: result, ts: Date.now() });
        return result;
    } finally {
        inflight.delete(key);
    }
}

const FLAIR_META: Record<FlairState, { className: string; label: string; tooltip: string; }> = {
    loading: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--loading",
        label: "Checking",
        tooltip: "Checking Veil signature."
    },
    verified: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--verified",
        label: "Verified",
        tooltip: "Verified. Signed by this account's linked Veil key. Click for details."
    },
    signed: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--signed",
        label: "Signed",
        tooltip: "Signature is valid, but this Veil key isn't linked to this Discord account. Click for details."
    },
    invalid: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--invalid",
        label: "Invalid",
        tooltip: "Signature does not verify. Click for details."
    },
    unverified: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--unverified",
        label: "Unverified",
        tooltip: "No Veil signature record was found for this message. Click for details."
    }
};

function StateGlyph({ state }: { state: FlairState; }) {
    if (state === "verified" || state === "signed") {
        return (
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.7 6.3l2.3 2.3 4.5-4.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
    }
    if (state === "invalid") {
        return (
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
        );
    }
    if (state === "unverified") {
        return (
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M4.2 4.6c0-1.1.9-1.8 1.9-1.8s1.8.7 1.8 1.7c0 1.6-1.8 1.5-1.8 2.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="6.05" cy="9" r="0.7" fill="currentColor" />
            </svg>
        );
    }
    return (
        <svg viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="3" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
            <circle cx="9" cy="6" r="1" fill="currentColor" />
        </svg>
    );
}

export function VeilSigBadge({ message }: { message: any; }) {
    const ref = extractVeilSigRef(message?.content);
    if (!ref) return null;

    const authorTag = message?.author
        ? message.author.global_name || message.author.username || message.author.id
        : undefined;
    const authorId: string | null = message?.author?.id ?? null;
    const discordMessageId: string | null = typeof message?.id === "string" ? message.id : null;
    const strippedContent = stripZwc(typeof message?.content === "string" ? message.content : "");

    const timestamp = (() => {
        const t = message?.timestamp;
        if (!t) return undefined;
        try {
            const d = typeof t === "string" || typeof t === "number"
                ? new Date(t)
                : (t?.toDate?.() ?? new Date(String(t)));
            return d.toLocaleString();
        } catch {
            return String(t);
        }
    })();

    const input: LookupInput = { sigRef: ref, discordMessageId, strippedContent, authorId };
    const cacheKey = lookupKey(input);

    const [state, setState] = useState<FlairState>(() => {
        if (!cacheKey) return "unverified";
        return flairCache.get(cacheKey)?.state ?? "loading";
    });

    useEffect(() => {
        let cancelled = false;
        let nonce = 0;

        const run = () => {
            const myNonce = ++nonce;
            void computeFlairState(input, () => { /* tick noop, kept for future spinner pulse */ }).then(result => {
                if (cancelled || myNonce !== nonce) return;
                setState(result);
            });
        };

        run();

        const onRegistered = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || typeof detail.discordMessageId !== "string") return;
            if (detail.discordMessageId !== discordMessageId) return;
            bustCacheForDiscordMessageId(discordMessageId);
            setState("loading");
            run();
        };
        window.addEventListener(REGISTERED_EVENT, onRegistered as EventListener);

        return () => {
            cancelled = true;
            window.removeEventListener(REGISTERED_EVENT, onRegistered as EventListener);
        };
    }, [ref.v, ref.id, discordMessageId, authorId, strippedContent]);

    const meta = FLAIR_META[state];

    /*
     * Portal the badge inline at the end of the message content (the
     * `[id^="message-content-"]` div Discord renders the markdown into),
     * so it flows after the message text the way the native "(edited)"
     * marker does. This avoids the previous overlay approach taking up a
     * full line on multi-line messages, and the badge naturally follows
     * the last word of the message wherever it ends.
     *
     * Discord re-renders message-content from scratch on edits and on a
     * handful of other interactions, which wipes any imperatively-added
     * children (including our portal host span). A MutationObserver on
     * the message <li> lets us detect that and re-attach the host so the
     * badge survives edits, reactions, embed loads, etc.
     */
    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;

        const li = anchor.closest("li[id^=\"chat-messages-\"]") as HTMLElement | null;
        if (!li) return;

        let attached: HTMLElement | null = null;

        const ensureHost = () => {
            const content = li.querySelector("[id^=\"message-content-\"]") as HTMLElement | null;
            if (!content) {
                if (attached) {
                    attached = null;
                    setOverlayHost(null);
                }
                return;
            }
            let host = content.querySelector(":scope > .vc-veil-sig-overlay") as HTMLElement | null;
            if (!host || !host.isConnected) {
                host = document.createElement("span");
                host.className = "vc-veil-sig-overlay";
                content.appendChild(host);
            } else if (host.parentElement !== content) {
                content.appendChild(host);
            }
            if (attached !== host) {
                attached = host;
                setOverlayHost(host);
            }
        };

        ensureHost();

        const observer = new MutationObserver(() => {
            // Cheap guard: only re-run if our host actually went away or
            // a different message-content node now lives under the <li>.
            if (!attached || !attached.isConnected || attached.parentElement?.id?.startsWith("message-content-") !== true) {
                ensureHost();
            }
        });
        observer.observe(li, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
        };
    }, [discordMessageId]);

    const badge = (
        <button
            type="button"
            className={meta.className}
            onClick={() =>
                openModal(modalProps => (
                    <VerifyModal
                        modalProps={modalProps}
                        sigRef={ref}
                        discordMessageId={discordMessageId}
                        strippedContent={strippedContent}
                        authorTag={authorTag}
                        timestamp={timestamp}
                    />
                ))
            }
            title={meta.tooltip}
            aria-label={meta.tooltip}
            data-state={state}
        >
            <StateGlyph state={state} />
            <span className="vc-veil-sig-dot__label">{meta.label}</span>
        </button>
    );

    return (
        <>
            <span ref={anchorRef} className="vc-veil-sig-anchor" aria-hidden="true" />
            {overlayHost && ReactDOM.createPortal(badge, overlayHost)}
        </>
    );
}
