/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService } from "./service";
import { veilApiBase } from "./settings";

/**
 * Shared HTTP client for every Veil backend call from Veilcord. Centralised
 * so all signing flows through the cryptoService singleton (CLAUDE.md rule)
 * and so every Veil plugin uses the same canonical envelope shape that the
 * backend's signature interceptor expects.
 *
 * Envelope shapes are pinned to `veil-backend/.../Application.kt`:
 *
 *  - Body-signed (POST/PUT/PATCH on a registered route):
 *      body is JSON containing a `nonce` field; the signature is ed25519
 *      over the exact UTF-8 bytes of the serialised body.
 *      Headers: X-Public-Key, X-Signature.
 *
 *  - Header-signed (GET/DELETE on a registered route):
 *      signature is ed25519 over the literal string
 *        api_auth:METHOD:path:timestamp:nonce
 *      Headers: X-Public-Key, X-Signature, X-Auth-Timestamp, X-Auth-Nonce.
 *
 * Routes that are public (e.g. GET /user/{id}) still go through veilFetch
 * for consistent base-URL, error handling and AbortController support, but
 * skip the signing step.
 */

export interface VeilFetchOptions {
    /** When true, request is sent with no signature/headers. */
    anonymous?: boolean;
    /** Extra request headers merged after the signed ones. */
    headers?: Record<string, string>;
    /** Abort signal forwarded to fetch. */
    signal?: AbortSignal;
}

export class VeilApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body: unknown) {
        super(message);
        this.name = "VeilApiError";
        this.status = status;
        this.body = body;
    }
}

function newNonceHex(byteLen = 16): string {
    const buf = new Uint8Array(byteLen);
    crypto.getRandomValues(buf);
    let out = "";
    for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, "0");
    return out;
}

function joinUrl(base: string, path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (!path.startsWith("/")) path = "/" + path;
    return base + path;
}

function pathOnly(url: string): string {
    try {
        const u = new URL(url, "http://_");
        return u.pathname + (u.search || "");
    } catch {
        const q = url.indexOf("?");
        const h = url.indexOf("#");
        const end = h === -1 ? url.length : h;
        return url.slice(url.indexOf("/", 8) === -1 ? 0 : url.indexOf("/", 8), end === -1 ? q : end);
    }
}

async function parseResponse(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    const ct = res.headers.get("Content-Type") || "";
    if (ct.includes("application/json")) {
        try { return JSON.parse(text); } catch { return text; }
    }
    return text;
}

function throwIfNotOk(res: Response, body: unknown) {
    if (res.ok) return;
    const errMsg = (body && typeof body === "object" && "error" in (body as any) && typeof (body as any).error === "string")
        ? (body as any).error
        : `HTTP ${res.status}`;
    throw new VeilApiError(errMsg, res.status, body);
}

/**
 * Body-signed request. Caller passes a JSON-serialisable body **without**
 * `nonce`; we add a fresh nonce, serialise once, sign the resulting bytes,
 * and send. Matches `configurePayloadSignatureVerification` in the backend.
 */
export async function signedBodyRequest<T = unknown>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: Record<string, unknown>,
    opts: VeilFetchOptions = {}
): Promise<T> {
    const pubkey = (await cryptoService.getPublicKey()).toLowerCase();
    const envelope = { ...body, nonce: newNonceHex() };
    const payloadText = JSON.stringify(envelope);
    const signature = await cryptoService.sign(payloadText);

    const res = await fetch(joinUrl(veilApiBase(), path), {
        method,
        signal: opts.signal,
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Public-Key": pubkey,
            "X-Signature": signature,
            ...(opts.headers ?? {})
        },
        body: payloadText
    });
    const parsed = await parseResponse(res);
    throwIfNotOk(res, parsed);
    return parsed as T;
}

/**
 * Header-signed request. Used for GET / DELETE routes that need auth but
 * have no body, e.g. `/me/servers`, `/server/{id}/members`,
 * `/channel/{id}/messages`. Signature canonical string mirrors
 * `configureHeaderSignatureVerification` in the backend.
 */
export async function signedHeaderRequest<T = unknown>(
    method: "GET" | "DELETE",
    path: string,
    opts: VeilFetchOptions = {}
): Promise<T> {
    const pubkey = (await cryptoService.getPublicKey()).toLowerCase();
    const nonce = newNonceHex();
    const timestamp = Date.now().toString();
    const canonical = `api_auth:${method.toUpperCase()}:${path}:${timestamp}:${nonce}`;
    const signature = await cryptoService.sign(canonical);

    const res = await fetch(joinUrl(veilApiBase(), path), {
        method,
        signal: opts.signal,
        headers: {
            Accept: "application/json",
            "X-Public-Key": pubkey,
            "X-Signature": signature,
            "X-Auth-Timestamp": timestamp,
            "X-Auth-Nonce": nonce,
            ...(opts.headers ?? {})
        }
    });
    const parsed = await parseResponse(res);
    throwIfNotOk(res, parsed);
    return parsed as T;
}

/**
 * Unsigned GET for public endpoints like `/user/{id|pubkey}`.
 */
export async function publicGet<T = unknown>(path: string, opts: VeilFetchOptions = {}): Promise<T> {
    const res = await fetch(joinUrl(veilApiBase(), path), {
        method: "GET",
        signal: opts.signal,
        headers: { Accept: "application/json", ...(opts.headers ?? {}) }
    });
    const parsed = await parseResponse(res);
    throwIfNotOk(res, parsed);
    return parsed as T;
}

/**
 * Convenience: pick body-signed vs header-signed automatically based on
 * method. Anonymous mode bypasses signing for public routes.
 */
export async function veilApi<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    opts: VeilFetchOptions = {}
): Promise<T> {
    const m = method.toUpperCase();
    if (opts.anonymous) return publicGet<T>(path, opts);
    if (m === "GET" || m === "DELETE") return signedHeaderRequest<T>(m as "GET" | "DELETE", path, opts);
    if (m === "POST" || m === "PUT" || m === "PATCH") {
        return signedBodyRequest<T>(m as "POST" | "PUT" | "PATCH", path, body ?? {}, opts);
    }
    throw new Error(`Unsupported HTTP method: ${method}`);
}

export { veilApiBase };
export { newNonceHex as _veilNewNonceHex };
export { pathOnly as _veilPathOnly };
