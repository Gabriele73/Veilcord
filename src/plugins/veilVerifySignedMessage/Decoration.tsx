/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openModal } from "@utils/modal";

import { extractVeilSigRef } from "./parser";
import { VerifyModal } from "./VerifyModal";

export function VeilSigDecoration({ message }: { message: any; }) {
    const ref = extractVeilSigRef(message?.content);
    if (!ref) return null;

    const authorTag = message?.author
        ? message.author.global_name || message.author.username || message.author.id
        : undefined;
    const timestamp = (() => {
        const t = message?.timestamp;
        if (!t) return undefined;
        try {
            const d = typeof t === "string" || typeof t === "number"
                ? new Date(t)
                : (t?.toDate?.() ?? new Date(String(t)));
            return d.toLocaleString();
        } catch {
            return String(t);
        }
    })();

    return (
        <button
            type="button"
            className="vc-veil-sig-flair"
            onClick={() =>
                openModal(modalProps => (
                    <VerifyModal
                        modalProps={modalProps}
                        sigRef={ref}
                        authorTag={authorTag}
                        timestamp={timestamp}
                    />
                ))
            }
            title="Click to verify Veil signature"
            aria-label="Verify Veil signature"
        >
            Signed
        </button>
    );
}
