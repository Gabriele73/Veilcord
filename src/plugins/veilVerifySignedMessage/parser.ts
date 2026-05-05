/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const VEIL_SIG_RE = /```veil-sig\s*\n([\s\S]+?)\n```/;

export interface VeilSigPayload {
    message: string;
    publicKey: string;
    signature: string;
    v?: number;
}

export function extractVeilSig(content: unknown): VeilSigPayload | null {
    if (typeof content !== "string" || !content) return null;
    const match = content.match(VEIL_SIG_RE);
    if (!match) return null;
    try {
        const obj = JSON.parse(match[1]);
        if (obj?.veil !== "signed-message") return null;
        if (typeof obj.message !== "string") return null;
        if (typeof obj.publicKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(obj.publicKey)) return null;
        if (typeof obj.signature !== "string" || !/^[0-9a-fA-F]{128}$/.test(obj.signature)) return null;
        return {
            message: obj.message,
            publicKey: obj.publicKey.toLowerCase(),
            signature: obj.signature.toLowerCase(),
            v: typeof obj.v === "number" ? obj.v : undefined
        };
    } catch {
        return null;
    }
}
