/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

/*
 * Fetch raw bytes from a Discord CDN URL in the main process.
 *
 * Discord's CDN doesn't send `Access-Control-Allow-Origin` for non-image
 * MIME types, which would otherwise block the verifier from hashing
 * attached PDFs / text files / etc. when reconstructing the v4 canonical
 * body. Main process has no Same-Origin Policy.
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
