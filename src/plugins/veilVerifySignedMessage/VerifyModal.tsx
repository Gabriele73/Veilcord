/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { cryptoService } from "@plugins/veilCrypto";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { useEffect, useState } from "@webpack/common";

import { VeilSigPayload } from "./parser";

type Status = "verifying" | "valid" | "invalid" | "error";

const STATUS_COLOR: Record<Status, string> = {
    verifying: "var(--text-muted)",
    valid: "var(--status-positive)",
    invalid: "var(--status-danger)",
    error: "var(--status-danger)"
};

export function VerifyModal({
    modalProps,
    payload,
    authorTag,
    timestamp
}: {
    modalProps: ModalProps;
    payload: VeilSigPayload;
    authorTag?: string;
    timestamp?: string;
}) {
    const [status, setStatus] = useState<Status>("verifying");
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [copyHint, setCopyHint] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const ok = await cryptoService.verify(payload.message, payload.signature, payload.publicKey);
                if (cancelled) return;
                setStatus(ok ? "valid" : "invalid");
            } catch (e: any) {
                if (cancelled) return;
                setStatus("error");
                setErrorMsg(e?.message || String(e));
            }
        })();
        return () => { cancelled = true; };
    }, [payload.message, payload.signature, payload.publicKey]);

    const copy = (label: string, value: string) => {
        navigator.clipboard.writeText(value).then(() => {
            setCopyHint(`${label} copied`);
            setTimeout(() => setCopyHint(null), 1500);
        }).catch(() => {
            setCopyHint(`Failed to copy ${label.toLowerCase()}`);
            setTimeout(() => setCopyHint(null), 1500);
        });
    };

    const statusLabel: Record<Status, string> = {
        verifying: "Verifying signature…",
        valid: "Signature is valid",
        invalid: "Signature does NOT match this public key",
        error: errorMsg ? `Verification failed: ${errorMsg}` : "Verification failed"
    };

    const codeStyle: React.CSSProperties = {
        display: "block",
        wordBreak: "break-all",
        padding: "6px 8px",
        background: "var(--background-secondary)",
        borderRadius: 4,
        fontFamily: "var(--font-code)",
        fontSize: 12,
        flex: 1
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>Veil signed message</BaseText>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <Flex flexDirection="column" gap={12}>
                    <Paragraph style={{ color: STATUS_COLOR[status], fontWeight: 600 }}>
                        {statusLabel[status]}
                    </Paragraph>

                    <section>
                        <HeadingSecondary>Message</HeadingSecondary>
                        <pre
                            style={{
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                padding: "8px 10px",
                                background: "var(--background-secondary)",
                                borderRadius: 4,
                                margin: 0,
                                fontFamily: "var(--font-primary)"
                            }}
                        >
                            {payload.message}
                        </pre>
                    </section>

                    <section>
                        <HeadingSecondary>Public key</HeadingSecondary>
                        <Flex gap={8} alignItems="center">
                            <code style={codeStyle}>{payload.publicKey}</code>
                            <Button
                                variant="secondary"
                                size="small"
                                onClick={() => copy("Public key", payload.publicKey)}
                            >
                                Copy
                            </Button>
                        </Flex>
                    </section>

                    <section>
                        <HeadingSecondary>Signature</HeadingSecondary>
                        <Flex gap={8} alignItems="center">
                            <code style={codeStyle}>{payload.signature}</code>
                            <Button
                                variant="secondary"
                                size="small"
                                onClick={() => copy("Signature", payload.signature)}
                            >
                                Copy
                            </Button>
                        </Flex>
                    </section>

                    {(authorTag || timestamp || payload.v != null) && (
                        <section>
                            <HeadingSecondary>Metadata</HeadingSecondary>
                            <Flex flexDirection="column" gap={4}>
                                {authorTag && <Paragraph>From: {authorTag}</Paragraph>}
                                {timestamp && <Paragraph>Sent: {timestamp}</Paragraph>}
                                {payload.v != null && <Paragraph>Payload version: {payload.v}</Paragraph>}
                            </Flex>
                        </section>
                    )}

                    {copyHint && (
                        <Paragraph style={{ color: "var(--status-positive)" }}>{copyHint}</Paragraph>
                    )}
                </Flex>
            </ModalContent>

            <ModalFooter>
                <Button variant="primary" onClick={modalProps.onClose}>Close</Button>
            </ModalFooter>
        </ModalRoot>
    );
}
