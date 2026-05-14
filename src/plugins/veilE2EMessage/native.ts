/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

/*
 * Fetch raw bytes from a URL in the main process.
 *
 * The renderer can't fetch arbitrary cdn.discordapp.com files because
 * Discord's CDN doesn't send `Access-Control-Allow-Origin` for
 * non-image content types (our `application/x-veil-encrypted`
 * attachments included). Main process has no Same-Origin Policy, so
 * we proxy the fetch through here.
 *
 * Bounded by size and time so a hostile peer can't get the main
 * process to allocate a multi-GB buffer or hang on a slow-loris
 * response — both are crash/freeze-the-app primitives for any peer
 * who can convince Discord's CDN to serve the bytes (e.g. by
 * uploading a large file and pointing a manifest entry at it).
 *
 * Returns a discriminated union so the renderer can attach error
 * details to its log lines without having to interpret a thrown
 * error from across the IPC boundary.
 */
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MiB
const FETCH_TIMEOUT_MS = 30_000;

export async function fetchAttachmentBytes(
    _: IpcMainInvokeEvent,
    url: string
): Promise<{ ok: true; bytes: Uint8Array; } | { ok: false; error: string; }> {
    if (typeof url !== "string" || !url) return { ok: false, error: "no url" };
    if (!/^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\//i.test(url)) {
        return { ok: false, error: "url not on discord cdn" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        const declared = Number(res.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
            return { ok: false, error: "attachment too large" };
        }

        const body = res.body;
        if (!body) return { ok: false, error: "no body" };

        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > MAX_ATTACHMENT_BYTES) {
                try { await reader.cancel(); } catch { /* ignore */ }
                return { ok: false, error: "attachment too large" };
            }
            chunks.push(value);
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
            bytes.set(c, offset);
            offset += c.byteLength;
        }
        return { ok: true, bytes };
    } catch (e: any) {
        if (e?.name === "AbortError") return { ok: false, error: "fetch timed out" };
        return { ok: false, error: String(e?.message ?? e) };
    } finally {
        clearTimeout(timer);
    }
}
