/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { openModal } from "@utils/modal";

import { extractVeilSig } from "./parser";
import { VerifyModal } from "./VerifyModal";

export function VeilSigAccessory({ message }: { message: any; }) {
    const payload = extractVeilSig(message?.content);
    if (!payload) return null;

    const authorTag = message?.author
        ? message.author.global_name || message.author.username || message.author.id
        : undefined;
    const timestamp = (() => {
        const t = message?.timestamp;
        if (!t) return undefined;
        try {
            const d = typeof t === "string" || typeof t === "number" ? new Date(t) : (t.toDate?.() ?? new Date(String(t)));
            return d.toLocaleString();
        } catch {
            return String(t);
        }
    })();

    return (
        <div className="vc-veil-sig">
            <span className="vc-veil-sig-text">{payload.message}</span>
            <button
                type="button"
                className="vc-veil-sig-flair"
                onClick={() =>
                    openModal(modalProps => (
                        <VerifyModal
                            modalProps={modalProps}
                            payload={payload}
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
        </div>
    );
}
