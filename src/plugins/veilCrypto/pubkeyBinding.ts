/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService } from "./service";
import { veilApiBase } from "./settings";

/**
 * OAuth-verified binding of an Ed25519 public key to a Discord user id.
 *
 * The binding is established once per (uid, pubkey) pair via Discord OAuth
 * (`identify` scope). The backend stores a row keyed by linked_at so the
 * same pair can be relinked after an unlink without conflicting with
 * historical rows. History is preserved on unlink so messages signed with
 * a since-rotated key still verify against the original author.
 *
 * All signing routes through `cryptoService.sign()` so trusted-unlock,
 * passkey unlock and the multi-key roadmap stay coherent.
 */

export interface BindingRow {
    publicKey: string;
    linkedAt: number;
    unlinkedAt: number | null;
    timestamp: number;
}

export interface BindingsByUid {
    discordUid: string;
    bindings: BindingRow[];
}

export interface LinkResult {
    discordUid: string;
    publicKey: string;
    linkedAt: number;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POPUP_FEATURES = "width=480,height=720,menubar=no,location=no,toolbar=no,status=no";

interface MintedTokenPayload {
    jti: string;
    state: string;
    verified_uid: string;
    pubkey: string;
    exp: number;
}

function decodeJwtPayload(token: string): MintedTokenPayload {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Binding token is malformed");
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(parts[1].length + ((4 - parts[1].length % 4) % 4), "=");
    const json = atob(padded);
    const payload = JSON.parse(json) as MintedTokenPayload;
    if (!payload.jti || !payload.verified_uid || !payload.pubkey) {
        throw new Error("Binding token is missing required fields");
    }
    return payload;
}

function canonicalLinkBytes(jti: string, verifiedUid: string, pubkey: string, ts: number): string {
    return `veilcord:pubkey-binding:link:v1\n${jti}\n${verifiedUid}\n${pubkey}\n${ts}`;
}

function canonicalUnlinkBytes(discordUid: string, pubkey: string, ts: number): string {
    return `veilcord:pubkey-binding:unlink:v1\n${discordUid}\n${pubkey}\n${ts}`;
}

async function jsonRequest<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const init: RequestInit = {
        method,
        headers: {
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(headers ?? {})
        }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    if (!res.ok) {
        const detail = parsed?.error || `HTTP ${res.status}`;
        throw new Error(detail);
    }
    return parsed as T;
}

/**
 * Opens a Discord OAuth popup, polls for completion, signs the binding
 * token, and persists the (uid, pubkey) link on the backend.
 *
 * Throws if the user closes the popup, denies authorization, or the flow
 * times out (5 minutes by default).
 */
export async function linkPubkeyToDiscord(): Promise<LinkResult> {
    const pubkey = await cryptoService.getPublicKey();
    const base = veilApiBase();

    const start = await jsonRequest<{ state: string; oauthUrl: string; expiresAt: number; }>(
        "POST",
        `${base}/veilcord/pubkey-binding/start`,
        { pubkey }
    );

    // Discord Desktop's Electron shell intercepts window.open and routes the
    // URL through the OS browser via setWindowOpenHandler/shell.openExternal,
    // returning null in the renderer. The OAuth page still opens — we just
    // can't observe its lifecycle. Treat null as "opened externally" and
    // rely on the polling loop and the timeout to drive completion.
    const popup = window.open(start.oauthUrl, "veil-discord-link", POPUP_FEATURES);

    let popupNotified = false;
    const popupListener = (event: MessageEvent) => {
        if (event?.data && typeof event.data === "object" && "veilOAuth" in event.data) {
            popupNotified = true;
        }
    };
    window.addEventListener("message", popupListener);

    try {
        const verified = await pollUntilVerified(start.state, popup, () => popupNotified);

        const payload = decodeJwtPayload(verified.token);
        if (payload.pubkey.toLowerCase() !== pubkey.toLowerCase()) {
            throw new Error("Binding token does not match this client's pubkey.");
        }

        const timestamp = Date.now();
        const canonical = canonicalLinkBytes(
            payload.jti,
            payload.verified_uid,
            pubkey.toLowerCase(),
            timestamp
        );
        const selfSignature = await cryptoService.sign(canonical);

        const result = await jsonRequest<LinkResult>(
            "PUT",
            `${base}/veilcord/pubkey-binding`,
            { jwt: verified.token, selfSignature, timestamp },
            { "X-Public-Key": pubkey.toLowerCase() }
        );

        return result;
    } finally {
        window.removeEventListener("message", popupListener);
        try { if (popup && !popup.closed) popup.close(); } catch { /* ignore */ }
    }
}

interface VerifiedPollResponse {
    status: "verified";
    verifiedUid: string;
    pubkey: string;
    token: string;
    expiresAt: number;
}

interface PendingPollResponse {
    status: "pending" | "consumed" | "expired";
}

type PollResponse = VerifiedPollResponse | PendingPollResponse;

async function pollUntilVerified(
    state: string,
    popup: Window | null,
    quickPokeReady: () => boolean
): Promise<VerifiedPollResponse> {
    const base = veilApiBase();
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (popup && popup.closed && !quickPokeReady()) {
            // User closed the window before authorizing. Wait one more poll
            // cycle in case the close raced with a successful callback that's
            // still flushing through, then bail.
            await sleep(POLL_INTERVAL_MS);
            const final = await pollOnce(base, state);
            if (final.status === "verified") return final;
            throw new Error("Discord login window was closed before authorization completed.");
        }

        const result = await pollOnce(base, state);
        if (result.status === "verified") return result;
        if (result.status === "expired") {
            throw new Error("This link request expired. Please try again.");
        }
        if (result.status === "consumed") {
            throw new Error("This link request was already used.");
        }
        await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("Linking timed out. Please try again.");
}

async function pollOnce(base: string, state: string): Promise<PollResponse> {
    return jsonRequest<PollResponse>(
        "GET",
        `${base}/veilcord/pubkey-binding/start/${encodeURIComponent(state)}`
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Removes the active binding for (uid, currentPubkey). Historical rows are
 * preserved so prior signed messages still verify against this uid.
 */
export async function unlinkPubkeyFromDiscord(discordUid: string): Promise<void> {
    const pubkey = (await cryptoService.getPublicKey()).toLowerCase();
    const timestamp = Date.now();
    const canonical = canonicalUnlinkBytes(discordUid, pubkey, timestamp);
    const selfSignature = await cryptoService.sign(canonical);

    await jsonRequest<{ unlinkedAt: number; }>(
        "DELETE",
        `${veilApiBase()}/veilcord/pubkey-binding`,
        { discordUid, publicKey: pubkey, timestamp, selfSignature },
        { "X-Public-Key": pubkey }
    );
}

/**
 * Public lookup: returns every binding (active and historical) for a
 * Discord uid. Used by the LinkKeyModal status panel and by the verify
 * flair when it needs the full picture.
 */
export async function fetchBindingsByDiscordUid(discordUid: string): Promise<BindingsByUid> {
    const url = `${veilApiBase()}/veilcord/pubkey-binding/by-uid/${encodeURIComponent(discordUid)}`;
    return jsonRequest<BindingsByUid>("GET", url);
}

/**
 * Cheap point-in-time check used by the verify flair on every signed
 * message render. Returns true if the (uid, pubkey) was bound at the
 * given timestamp (ms since epoch).
 */
export async function isBindingActiveAt(
    discordUid: string,
    publicKey: string,
    ts: number
): Promise<boolean> {
    const params = new URLSearchParams({
        uid: discordUid,
        pubkey: publicKey.toLowerCase(),
        ts: String(ts)
    });
    const url = `${veilApiBase()}/veilcord/pubkey-binding/active-at?${params.toString()}`;
    const result = await jsonRequest<{ active: boolean; }>("GET", url);
    return result.active === true;
}
