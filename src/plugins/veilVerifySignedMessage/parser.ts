/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { VeilZwc } from "@plugins/veilCrypto";

export interface VeilSigRef {
    v: number;
    /** v2 backend lookup id. Absent for v3+. */
    id?: string;
}

export function extractVeilSigRef(content: unknown): VeilSigRef | null {
    if (typeof content !== "string" || !content) return null;
    const decoded = VeilZwc.decodeRef(content);
    if (!decoded) return null;
    return {
        v: decoded.v,
        id: decoded.id?.toLowerCase()
    };
}

export function stripZwc(content: string): string {
    const decoded = VeilZwc.decodeRef(content);
    return decoded ? decoded.message : content;
}
