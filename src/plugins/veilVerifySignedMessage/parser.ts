/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { VeilZwc } from "@plugins/veilCrypto";

export interface VeilSigRef {
    id: string;
    v: number;
}

export function extractVeilSigRef(content: unknown): VeilSigRef | null {
    if (typeof content !== "string" || !content) return null;
    const decoded = VeilZwc.decodeId(content);
    if (!decoded) return null;
    return {
        id: decoded.id.toLowerCase(),
        v: decoded.v
    };
}
