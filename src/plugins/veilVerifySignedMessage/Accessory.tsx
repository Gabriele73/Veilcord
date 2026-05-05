/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { openModal } from "@utils/modal";
import { findCssClassesLazy } from "@webpack";
import { Parser, useLayoutEffect, useRef } from "@webpack/common";

import { extractVeilSig } from "./parser";
import { VerifyModal } from "./VerifyModal";

const MessageClasses = findCssClassesLazy("messageContent", "markupRtl");

const PAYLOAD_MARKER = '"veil":"signed-message"';
const MESSAGE_SELECTOR = 'li[id^="chat-messages-"], [id^="message-content-"], [class*="message_"]';

export function VeilSigAccessory({ message }: { message: any; }) {
    const payload = extractVeilSig(message?.content);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
        if (!payload || !wrapperRef.current) return;

        let host: HTMLElement | null = wrapperRef.current;
        while (host && !(host.matches && host.matches(MESSAGE_SELECTOR))) {
            host = host.parentElement;
        }
        if (!host) host = wrapperRef.current.parentElement;
        if (!host) return;

        const pres = host.querySelectorAll<HTMLPreElement>("pre");
        pres.forEach(pre => {
            if (pre.textContent && pre.textContent.includes(PAYLOAD_MARKER)) {
                pre.dataset.veilSigHidden = "1";
                pre.style.display = "none";
            }
        });
    }, [message?.id, payload?.signature]);

    if (!payload) return null;

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
        <div ref={wrapperRef} className={classes("vc-veil-sig", MessageClasses?.messageContent)}>
            <span className="vc-veil-sig-body">{Parser.parse(payload.message)}</span>
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
