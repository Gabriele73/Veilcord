/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isVeilChannelId, isVeilGuildId } from "./idMap";

/**
 * Discord runs background fetches on guild / channel selection: lurker
 * join, powerups, billing offers, member fetches, etc. Those hit
 * `discord.com/api/v9/...` with a Veil synthetic id in the path, which
 * 4xxs because the id doesn't exist on Discord's side. Each failure
 * pollutes the console and triggers retry storms.
 *
 * This shim wraps `window.fetch` and `XMLHttpRequest.open` so any
 * outbound call whose URL contains a Veil-synthetic guild or channel id
 * short-circuits with a synthetic empty response. We only suppress
 * Discord-host URLs; calls to `api.veil.rip` are passed through
 * untouched so VeilFlux's own signed-envelope requests still work.
 *
 * Gateway WebSocket (client → server) messages are also intercepted:
 *   OP 8  REQUEST_GUILD_MEMBERS   — causes 4004 Unknown Guild for synthetic ids
 *   OP 14 GUILD_SUBSCRIPTION_UPDATE — member-list lazy load; also errors
 * Both are dropped / filtered when they reference a Veil synthetic guild id.
 * Client→server gateway frames are plain JSON (no compression), so string
 * parsing is safe.
 */

const DISCORD_HOSTS = ["discord.com", "discordapp.com", "discord.gg"];

function isDiscordHost(url: string): boolean {
    try {
        const u = new URL(url, location.href);
        return DISCORD_HOSTS.some(h => u.host === h || u.host.endsWith("." + h));
    } catch {
        // Relative URLs default to current origin (Discord). Treat them as
        // Discord-host so we suppress relative `/api/v9/...` calls too.
        return url.startsWith("/api/");
    }
}

function urlReferencesVeilEntity(url: string): boolean {
    // Extract every 18-digit numeric chunk and test against the
    // synthetic-id classifier. Cheap regex pass; never false-positives on
    // shorter Discord snowflakes (17 digits as of 2026) or longer hashes.
    const matches = url.match(/\d{18}/g);
    if (!matches) return false;
    for (const m of matches) {
        if (isVeilGuildId(m) || isVeilChannelId(m)) return true;
    }
    return false;
}

function shouldSuppress(url: string): boolean {
    return isDiscordHost(url) && urlReferencesVeilEntity(url);
}

function emptyJsonResponse(status: number): Response {
    const is204 = status === 204;
    return new Response(is204 ? null : "[]", {
        status,
        statusText: is204 ? "No Content" : "OK",
        headers: is204 ? {} : { "Content-Type": "application/json" }
    });
}

/**
 * Inspect a client→server WebSocket frame. Returns:
 *   null          — drop the frame entirely
 *   original data — pass through unchanged
 *   new string    — send the rewritten payload (Veil guild_ids filtered out)
 *
 * Only OP 8 (REQUEST_GUILD_MEMBERS) and OP 14 (GUILD_SUBSCRIPTION_UPDATE)
 * are touched. All other opcodes pass through untouched.
 */
function patchVeilGatewayFrame(data: any): any | null {
    if (typeof data !== "string") return data;
    let msg: any;
    try { msg = JSON.parse(data); } catch { return data; }
    const op: number = msg?.op;
    if (op !== 8 && op !== 14) return data;
    const d = msg?.d;
    if (!d) return data;
    // Single guild_id field — drop the whole frame
    if (d.guild_id && isVeilGuildId(String(d.guild_id))) return null;
    // guild_ids array — filter out Veil ids, drop if nothing remains
    if (Array.isArray(d.guild_ids)) {
        const filtered = d.guild_ids.filter((id: any) => !isVeilGuildId(String(id)));
        if (filtered.length === 0) return null;
        if (filtered.length !== d.guild_ids.length)
            return JSON.stringify({ ...msg, d: { ...d, guild_ids: filtered } });
    }
    return data;
}

let originalFetch: typeof fetch | null = null;
let originalXhrOpen: ((this: XMLHttpRequest, ...args: any[]) => void) | null = null;
let originalWsSend: ((data: any) => void) | null = null;
let installed = false;

export function installFetchSuppressor(): void {
    if (installed) return;
    installed = true;

    originalFetch = window.fetch.bind(window);
    window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string"
            ? input
            : input instanceof URL
                ? input.toString()
                : (input as Request).url;
        if (shouldSuppress(url)) {
            return Promise.resolve(emptyJsonResponse(200));
        }
        return originalFetch!(input, init);
    } as typeof fetch;

    originalXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string, ...rest: any[]) {
        if (typeof url === "string" && shouldSuppress(url)) {
            // Most Discord API endpoints that fire on guild/channel
            // selection (members, integrations, stage instances) return
            // arrays. `[]` is the safest empty response — handlers that
            // do `body.forEach(...)` accept it; handlers that probe
            // `.length` or destructure also accept it.
            void method;
            return originalXhrOpen!.call(this, "GET", "data:application/json,%5B%5D", ...rest);
        }
        return originalXhrOpen!.call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;

    originalWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedWsSend(this: WebSocket, data: any) {
        const out = patchVeilGatewayFrame(data);
        if (out === null) return;
        return originalWsSend!.call(this, out);
    };
}

export function removeFetchSuppressor(): void {
    if (!installed) return;
    if (originalFetch) window.fetch = originalFetch;
    if (originalXhrOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
    if (originalWsSend) WebSocket.prototype.send = originalWsSend;
    originalFetch = null;
    originalXhrOpen = null;
    originalWsSend = null;
    installed = false;
}

// Eager install at module load. Discord restores its last selected route
// before the Vencord plugin lifecycle runs `start()`; if the saved route
// pointed at a Veil synthetic guild, Discord fires the lurker-join and
// powerups REST calls during boot, well before `installFetchSuppressor`
// would otherwise run. Side-effecting at import time guarantees the
// suppressor is in place by the time those early calls fire.
try {
    installFetchSuppressor();
} catch (err) {
    console.warn("[VeilFlux] eager fetch suppressor install failed", err);
}
