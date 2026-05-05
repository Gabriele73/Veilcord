/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { cryptoService } from "@plugins/veilCrypto";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { Text, useEffect, useState } from "@webpack/common";

import { VeilSigPayload } from "./parser";

type Status = "verifying" | "valid" | "invalid" | "error";

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

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>
                    Veil signed message
                </BaseText>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <Flex flexDirection="column" gap={16} style={{ padding: "4px 0 8px" }}>
                    <div className={`vc-veil-sig-modal-status vc-veil-sig-modal-status--${status}`}>
                        {status === "error" && errorMsg ? `${STATUS_LABEL.error}: ${errorMsg}` : STATUS_LABEL[status]}
                    </div>

                    <div className="vc-veil-sig-modal-section">
                        <div className="vc-veil-sig-modal-label">Message</div>
                        <pre className="vc-veil-sig-modal-message">{payload.message}</pre>
                    </div>

                    <div className="vc-veil-sig-modal-section">
                        <div className="vc-veil-sig-modal-label">Public key</div>
                        <div className="vc-veil-sig-modal-hex-row">
                            <code className="vc-veil-sig-modal-hex">{payload.publicKey}</code>
                            <Button
                                variant="secondary"
                                size="small"
                                onClick={() => copy("Public key", payload.publicKey)}
                            >
                                Copy
                            </Button>
                        </div>
                    </div>

                    <div className="vc-veil-sig-modal-section">
                        <div className="vc-veil-sig-modal-label">Signature</div>
                        <div className="vc-veil-sig-modal-hex-row">
                            <code className="vc-veil-sig-modal-hex">{payload.signature}</code>
                            <Button
                                variant="secondary"
                                size="small"
                                onClick={() => copy("Signature", payload.signature)}
                            >
                                Copy
                            </Button>
                        </div>
                    </div>

                    {(authorTag || timestamp || payload.v != null) && (
                        <div className="vc-veil-sig-modal-section">
                            <div className="vc-veil-sig-modal-label">Metadata</div>
                            <Flex flexDirection="column" gap={4}>
                                {authorTag && (
                                    <div className="vc-veil-sig-modal-meta-row">
                                        <strong>From</strong>
                                        <Text variant="text-sm/normal">{authorTag}</Text>
                                    </div>
                                )}
                                {timestamp && (
                                    <div className="vc-veil-sig-modal-meta-row">
                                        <strong>Sent</strong>
                                        <Text variant="text-sm/normal">{timestamp}</Text>
                                    </div>
                                )}
                                {payload.v != null && (
                                    <div className="vc-veil-sig-modal-meta-row">
                                        <strong>Payload version</strong>
                                        <Text variant="text-sm/normal">{String(payload.v)}</Text>
                                    </div>
                                )}
                            </Flex>
                        </div>
                    )}

                    {copyHint && (
                        <div className="vc-veil-sig-modal-copy-hint">{copyHint}</div>
                    )}
                </Flex>
            </ModalContent>

            <ModalFooter>
                <Button variant="primary" onClick={modalProps.onClose}>Close</Button>
            </ModalFooter>
        </ModalRoot>
    );
}
