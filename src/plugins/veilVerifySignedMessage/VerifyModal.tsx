/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { CodeBlock } from "@components/CodeBlock";
import { Divider } from "@components/Divider";
import { Flex } from "@components/Flex";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { cryptoService } from "@plugins/veilCrypto";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { useEffect, useState } from "@webpack/common";

import { VeilSigPayload } from "./parser";

type Status = "verifying" | "valid" | "invalid" | "error";

const STATUS_VARIANT: Record<Status, "info" | "success" | "danger"> = {
    verifying: "info",
    valid: "success",
    invalid: "danger",
    error: "danger"
};

const STATUS_LABEL: Record<Status, string> = {
    verifying: "Verifying signature…",
    valid: "Signature is valid",
    invalid: "Signature does NOT match this public key",
    error: "Verification failed"
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

    const statusText =
        status === "error" && errorMsg
            ? `${STATUS_LABEL.error}: ${errorMsg}`
            : STATUS_LABEL[status];

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>
                    Veil signed message
                </BaseText>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <Flex flexDirection="column" gap={16} style={{ paddingBottom: 8 }}>
                    <Card variant={STATUS_VARIANT[status]} defaultPadding>
                        <Paragraph style={{ margin: 0, fontWeight: 600 }}>{statusText}</Paragraph>
                    </Card>

                    <section>
                        <HeadingTertiary>Message</HeadingTertiary>
                        <Card defaultPadding>
                            <Paragraph style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                {payload.message}
                            </Paragraph>
                        </Card>
                    </section>

                    <Divider />

                    <section>
                        <HeadingTertiary>Public key</HeadingTertiary>
                        <Flex alignItems="stretch" gap={8}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <CodeBlock content={payload.publicKey} lang="" />
                            </div>
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
                        <HeadingTertiary>Signature</HeadingTertiary>
                        <Flex alignItems="stretch" gap={8}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <CodeBlock content={payload.signature} lang="" />
                            </div>
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
                        <>
                            <Divider />
                            <section>
                                <HeadingTertiary>Metadata</HeadingTertiary>
                                <Flex flexDirection="column" gap={4}>
                                    {authorTag && (
                                        <Paragraph style={{ margin: 0 }}>
                                            <strong>From:</strong> {authorTag}
                                        </Paragraph>
                                    )}
                                    {timestamp && (
                                        <Paragraph style={{ margin: 0 }}>
                                            <strong>Sent:</strong> {timestamp}
                                        </Paragraph>
                                    )}
                                    {payload.v != null && (
                                        <Paragraph style={{ margin: 0 }}>
                                            <strong>Payload version:</strong> {String(payload.v)}
                                        </Paragraph>
                                    )}
                                </Flex>
                            </section>
                        </>
                    )}

                    {copyHint && (
                        <Paragraph style={{ margin: 0, color: "var(--status-positive)" }}>{copyHint}</Paragraph>
                    )}
                </Flex>
            </ModalContent>

            <ModalFooter>
                <Button variant="primary" onClick={modalProps.onClose}>Close</Button>
            </ModalFooter>
        </ModalRoot>
    );
}
