/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService, isBindingActiveAt, veilApiBase } from "@plugins/veilCrypto";
import { openModal } from "@utils/modal";
import { useEffect, useState } from "@webpack/common";

import { extractVeilSigRef, VeilSigRef } from "./parser";
import { VerifyModal } from "./VerifyModal";

type FlairState = "loading" | "verified" | "signed" | "invalid";

/**
 * Module-level cache keyed by `signedMessageId:authorId`.
 *
 * `verified` and `invalid` are stable: a signed-message record on the backend
 * never mutates, and a binding's history is append-only, so once we've
 * confirmed the (uid, pubkey) was bound at the message's createdAt that fact
 * can't be revoked retroactively.
 *
 * `signed` is a soft fallback: it can become `verified` on a subsequent render
 * if the user links their key after the message was sent (and the link's
 * linked_at predates the message's createdAt — which only happens during a
 * brief catch-up window after a fresh link). Allow bounded re-fetching for
 * those entries via `SIGNED_REVALIDATE_AFTER_MS`.
 */
const flairCache = new Map<string, { state: FlairState; ts: number; }>();
const inflight = new Map<string, Promise<FlairState>>();

const SIGNED_REVALIDATE_AFTER_MS = 5 * 60 * 1000;

async function computeFlairState(sigRef: VeilSigRef, authorId: string | null): Promise<FlairState> {
    const cacheKey = `${sigRef.id}:${authorId ?? ""}`;
    const existing = flairCache.get(cacheKey);
    if (existing && (existing.state !== "signed" || Date.now() - existing.ts < SIGNED_REVALIDATE_AFTER_MS)) {
        return existing.state;
    }
    const inflightPromise = inflight.get(cacheKey);
    if (inflightPromise) return inflightPromise;

    const promise = (async () => {
        try {
            const res = await fetch(
                `${veilApiBase()}/veilcord/signed-message/${encodeURIComponent(sigRef.id)}`,
                { headers: { Accept: "application/json" } }
            );
            if (!res.ok) return "signed" as FlairState;

            const raw: any = await res.json().catch(() => null);
            if (!raw || typeof raw !== "object") return "signed" as FlairState;
            const message: unknown = raw.message;
            const publicKey: unknown = raw.publicKey;
            const signature: unknown = raw.signature;
            const createdAt: unknown = raw.createdAt;
            if (typeof message !== "string" || typeof publicKey !== "string" || typeof signature !== "string") {
                return "signed" as FlairState;
            }

            const sigOk = await cryptoService.verify(message, signature, publicKey);
            if (!sigOk) return "invalid" as FlairState;

            if (!authorId || typeof createdAt !== "number") return "signed" as FlairState;

            const active = await isBindingActiveAt(authorId, publicKey, createdAt);
            return active ? ("verified" as FlairState) : ("signed" as FlairState);
        } catch {
            return "signed" as FlairState;
        }
    })();

    inflight.set(cacheKey, promise);
    try {
        const result = await promise;
        flairCache.set(cacheKey, { state: result, ts: Date.now() });
        return result;
    } finally {
        inflight.delete(cacheKey);
    }
}

export function VeilSigDecoration({ message }: { message: any; }) {
    const ref = extractVeilSigRef(message?.content);
    if (!ref) return null;

    const authorTag = message?.author
        ? message.author.global_name || message.author.username || message.author.id
        : undefined;
    const authorId: string | null = message?.author?.id ?? null;

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

    const [state, setState] = useState<FlairState>(() => {
        const cached = flairCache.get(`${ref.id}:${authorId ?? ""}`);
        return cached?.state ?? "loading";
    });

    useEffect(() => {
        let cancelled = false;
        void computeFlairState(ref, authorId).then(result => {
            if (!cancelled) setState(result);
        });
        return () => { cancelled = true; };
    }, [ref.id, authorId]);

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
