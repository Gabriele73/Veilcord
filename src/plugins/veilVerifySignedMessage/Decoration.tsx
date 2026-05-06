/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService, isBindingActiveAt, veilApiBase } from "@plugins/veilCrypto";
import { openModal } from "@utils/modal";
import { useEffect, useState } from "@webpack/common";

import { extractVeilSigRef, stripZwc, VeilSigRef } from "./parser";
import { VerifyModal } from "./VerifyModal";

type FlairState = "loading" | "verified" | "signed" | "invalid";

/**
 * Module-level cache keyed by `<lookup>:<authorId>` where <lookup> is the
 * v2 backend id or v3 Discord message id.
 *
 * `verified` and `invalid` are stable: a signed-message record never mutates,
 * and a binding's history is append-only, so once we've confirmed the
 * (uid, pubkey) was bound at the message's createdAt that fact can't be
 * revoked retroactively.
 *
 * `signed` is a soft fallback: it can become `verified` on a subsequent render
 * if the user links their key after the message was sent. Allow bounded
 * re-fetching for those entries via `SIGNED_REVALIDATE_AFTER_MS`.
 */
const flairCache = new Map<string, { state: FlairState; ts: number; }>();
const inflight = new Map<string, Promise<FlairState>>();

const SIGNED_REVALIDATE_AFTER_MS = 5 * 60 * 1000;

interface LookupInput {
    sigRef: VeilSigRef;
    /** Discord message id — required for v3 lookups. */
    discordMessageId: string | null;
    /** Live Discord message content with ZWC stripped — required to verify v3. */
    strippedContent: string;
    authorId: string | null;
}

function lookupKey({ sigRef, discordMessageId, authorId }: LookupInput): string | null {
    if (sigRef.v === 2) return sigRef.id ? `v2:${sigRef.id}:${authorId ?? ""}` : null;
    if (discordMessageId) return `v3:${discordMessageId}:${authorId ?? ""}`;
    return null;
}

async function fetchRecord(sigRef: VeilSigRef, discordMessageId: string | null): Promise<any | null> {
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

async function computeFlairState(input: LookupInput): Promise<FlairState> {
    const key = lookupKey(input);
    if (!key) return "signed";

    const existing = flairCache.get(key);
    if (existing && (existing.state !== "signed" || Date.now() - existing.ts < SIGNED_REVALIDATE_AFTER_MS)) {
        return existing.state;
    }
    const running = inflight.get(key);
    if (running) return running;

    const promise = (async () => {
        try {
            const raw = await fetchRecord(input.sigRef, input.discordMessageId);
            if (!raw) return "signed" as FlairState;

            const publicKey = typeof raw.publicKey === "string" ? raw.publicKey : null;
            const signature = typeof raw.signature === "string" ? raw.signature : null;
            const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : null;
            if (!publicKey || !signature) return "signed" as FlairState;

            let signedBody: string;
            if (input.sigRef.v === 2 && typeof raw.message === "string") {
                signedBody = raw.message;
            } else {
                signedBody = input.strippedContent;
            }

            const sigOk = await cryptoService.verify(signedBody, signature, publicKey);
            if (!sigOk) return "invalid" as FlairState;

            if (!input.authorId || createdAt == null) return "signed" as FlairState;

            const active = await isBindingActiveAt(input.authorId, publicKey, createdAt);
            return active ? ("verified" as FlairState) : ("signed" as FlairState);
        } catch {
            return "signed" as FlairState;
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

export function VeilSigDecoration({ message }: { message: any; }) {
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
        if (!cacheKey) return "signed";
        return flairCache.get(cacheKey)?.state ?? "loading";
    });

    useEffect(() => {
        let cancelled = false;
        void computeFlairState(input).then(result => {
            if (!cancelled) setState(result);
        });
        return () => { cancelled = true; };
    }, [ref.v, ref.id, discordMessageId, authorId, strippedContent]);

    let className = "vc-veil-sig-flair";
    let label = "Signed";
    let tooltip = "Click to verify Veil signature";

    if (state === "verified") {
        className += " vc-veil-sig-flair--verified";
        label = "Verified";
        tooltip = "Signed by this Discord account's linked Veil key. Click for details.";
    } else if (state === "invalid") {
        className += " vc-veil-sig-flair--invalid";
        label = "Invalid";
        tooltip = "Signature does not verify. Click for details.";
    }

    return (
        <button
            type="button"
            className={className}
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
            title={tooltip}
            aria-label={tooltip}
        >
            {label}
        </button>
    );
}
