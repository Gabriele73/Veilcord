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
 * Returns a discriminated union so the renderer can attach error
 * details to its log lines without having to interpret a thrown
 * error from across the IPC boundary.
 */
export async function fetchAttachmentBytes(
    _: IpcMainInvokeEvent,
    url: string
): Promise<{ ok: true; bytes: Uint8Array; } | { ok: false; error: string; }> {
    if (typeof url !== "string" || !url) return { ok: false, error: "no url" };
    if (!/^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\//i.test(url)) {
        return { ok: false, error: "url not on discord cdn" };
    }
    try {
        const res = await fetch(url);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const buf = await res.arrayBuffer();
        return { ok: true, bytes: new Uint8Array(buf) };
    } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}
