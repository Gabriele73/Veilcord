/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { VeilZwc } from "@plugins/veilCrypto";

export interface VeilSigPayload {
    message: string;
    publicKey: string;
    signature: string;
    v?: number;
}

export function extractVeilSig(content: unknown): VeilSigPayload | null {
    if (typeof content !== "string" || !content) return null;
    const decoded = VeilZwc.decodeSignature(content);
    if (!decoded) return null;
    return {
        message: decoded.message,
        publicKey: decoded.publicKey.toLowerCase(),
        signature: decoded.signature.toLowerCase(),
        v: decoded.v
    };
}
