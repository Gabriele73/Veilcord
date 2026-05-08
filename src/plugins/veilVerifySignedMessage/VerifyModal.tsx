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
import { CanonicalAttachment, cryptoService, veilApiBase, VeilSignedBody } from "@plugins/veilCrypto";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { useEffect, useState } from "@webpack/common";

import { VeilSigRef } from "./parser";

type Status = "loading" | "verifying" | "valid" | "invalid" | "error" | "missing";

const STATUS_VARIANT: Record<Status, "info" | "success" | "danger"> = {
    loading: "info",
    verifying: "info",
    valid: "success",
    invalid: "danger",
    error: "danger",
    missing: "danger"
};

const STATUS_LABEL: Record<Status, string> = {
    loading: "Looking for the Veil signature…",
    verifying: "Verifying signature…",
    valid: "Signature is valid",
    invalid: "Signature does NOT match this public key",
    error: "Verification failed",
    missing: "No Veil signature record was found for this message"
};

const FETCH_RETRY_DELAYS_MS = [0, 1500, 4000, 9000, 18000];
const REGISTERED_EVENT = "veil:signed-message:registered";

interface FetchedRecord {
    id: string | null;
    discordMessageId: string | null;
    /** Server-stored body — only present for v2 legacy records. v3 relies on the live Discord body. */
    storedMessage: string | null;
    publicKey: string;
    signature: string;
    v: number;
    submitterPubkey: string;
    createdAt: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function normalizeRecord(raw: any): FetchedRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" ? raw.id.toLowerCase() : null;
    const discordMessageId = typeof raw.discordMessageId === "string" ? raw.discordMessageId : null;
    const storedMessage = typeof raw.message === "string" ? raw.message : null;
    const publicKey = typeof raw.publicKey === "string" ? raw.publicKey.toLowerCase() : null;
    const signature = typeof raw.signature === "string" ? raw.signature.toLowerCase() : null;
    const v = typeof raw.v === "number" ? raw.v : null;
    const submitterPubkey = typeof raw.submitterPubkey === "string" ? raw.submitterPubkey.toLowerCase() : "";
    const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : 0;

    if (!publicKey || !HEX64.test(publicKey)) return null;
    if (!signature || !HEX128.test(signature)) return null;
    if (v == null) return null;

    return { id, discordMessageId, storedMessage, publicKey, signature, v, submitterPubkey, createdAt };
}

export function VerifyModal({
    modalProps,
    sigRef,
    discordMessageId,
    strippedContent,
    attachmentUrls,
    authorTag,
    timestamp
}: {
    modalProps: ModalProps;
    sigRef: VeilSigRef;
    discordMessageId: string | null;
    strippedContent: string;
    attachmentUrls: string[];
    authorTag?: string;
    timestamp?: string;
}) {
    const [status, setStatus] = useState<Status>("loading");
    const [record, setRecord] = useState<FetchedRecord | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [copyHint, setCopyHint] = useState<string | null>(null);
    /** True iff verification succeeded against the v2 attachments-bound canonical body. */
    const [attachmentsBound, setAttachmentsBound] = useState<boolean | null>(null);

    useEffect(() => {
        let cancelled = false;
        let attempt = 0;

        const buildUrl = (): string | null => {
            if (sigRef.v === 2 && sigRef.id) {
                return `${veilApiBase()}/veilcord/signed-message/${encodeURIComponent(sigRef.id)}`;
            }
            if (discordMessageId) {
                return `${veilApiBase()}/veilcord/signed-message/by-discord/${encodeURIComponent(discordMessageId)}`;
            }
            return null;
        };

        const verifyRecord = async (normalized: FetchedRecord) => {
            try {
                let ok = false;
                let bound: boolean | null = null;
                // v2 records: canonical body lives on the backend, no
                // attachment binding existed at sign time. v3 records:
                // reconstruct canonical body from live message and
                // attachment hashes; fall back to text-only canonical
                // for messages signed by older clients that didn't
                // bind file content.
                if (sigRef.v === 2 && typeof normalized.storedMessage === "string") {
                    ok = await cryptoService.verify(normalized.storedMessage, normalized.signature, normalized.publicKey);
                } else {
                    if (attachmentUrls.length > 0) {
                        const hashes: CanonicalAttachment[] = [];
                        let allHashed = true;
                        for (const url of attachmentUrls) {
                            try {
                                const res = await fetch(url);
                                if (!res.ok) { allHashed = false; break; }
                                const bytes = new Uint8Array(await res.arrayBuffer());
                                hashes.push({ sha256Hex: await cryptoService.sha256Hex(bytes) });
                            } catch {
                                allHashed = false;
                                break;
                            }
                        }
                        if (allHashed) {
                            const canonical = VeilSignedBody.buildCanonicalSignedBody(strippedContent, hashes);
                            ok = await cryptoService.verify(canonical, normalized.signature, normalized.publicKey);
                            if (ok) bound = true;
                        }
                    }
                    if (!ok) {
                        const legacy = VeilSignedBody.buildCanonicalSignedBody(strippedContent, []);
                        ok = await cryptoService.verify(legacy, normalized.signature, normalized.publicKey);
                        if (ok && attachmentUrls.length > 0) bound = false;
                    }
                }
                if (cancelled) return;
                setStatus(ok ? "valid" : "invalid");
                setAttachmentsBound(bound);
            } catch (e: any) {
                if (cancelled) return;
                setStatus("error");
                setErrorMsg(e?.message || String(e));
            }
        };

        const tryFetch = async () => {
            const url = buildUrl();
            if (!url) {
                setStatus("error");
                setErrorMsg("No lookup key for this signature.");
                return;
            }
            try {
                const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
                if (cancelled) return;

                if (res.status === 404) {
                    if (attempt + 1 < FETCH_RETRY_DELAYS_MS.length) {
                        attempt++;
                        setTimeout(() => { if (!cancelled) void tryFetch(); }, FETCH_RETRY_DELAYS_MS[attempt]);
                        return;
                    }
                    setStatus("missing");
                    setErrorMsg(null);
                    return;
                }
                if (!res.ok) {
                    setStatus("error");
                    setErrorMsg(`Backend returned HTTP ${res.status}.`);
                    return;
                }

                const raw = await res.json().catch(() => null);
                if (cancelled) return;

                const normalized = normalizeRecord(raw);
                if (!normalized) {
                    setStatus("error");
                    setErrorMsg("Backend returned a malformed signed-message record.");
                    return;
                }
                setRecord(normalized);
                setStatus("verifying");
                await verifyRecord(normalized);
            } catch (e: any) {
                if (cancelled) return;
                setStatus("error");
                setErrorMsg(e?.message || String(e));
            }
        };

        const restartFromEvent = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || detail.discordMessageId !== discordMessageId) return;
            attempt = 0;
            setStatus("loading");
            setErrorMsg(null);
            setRecord(null);
            void tryFetch();
        };

        void tryFetch();
        window.addEventListener(REGISTERED_EVENT, restartFromEvent as EventListener);
        return () => {
            cancelled = true;
            window.removeEventListener(REGISTERED_EVENT, restartFromEvent as EventListener);
        };
    }, [sigRef.v, sigRef.id, discordMessageId, strippedContent, attachmentUrls.join("|")]);

    const copy = (label: string, value: string) => {
        navigator.clipboard.writeText(value).then(() => {
            setCopyHint(`${label} copied`);
            setTimeout(() => setCopyHint(null), 1500);
        }).catch(() => {
            setCopyHint(`Couldn't copy ${label.toLowerCase()}.`);
            setTimeout(() => setCopyHint(null), 1500);
        });
    };

    const statusText =
        status === "error" && errorMsg
            ? `${STATUS_LABEL.error}: ${errorMsg}`
            : STATUS_LABEL[status];

    const recordedAt = record?.createdAt
        ? (() => {
            try { return new Date(record.createdAt).toLocaleString(); } catch { return String(record.createdAt); }
        })()
        : null;

    const displayedBody = VeilSignedBody.stripAttachmentBlock(record?.storedMessage ?? strippedContent);

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM} className="vc-veil-modal">
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

                    {record && (
                        <>
                            <section>
                                <HeadingTertiary>Message</HeadingTertiary>
                                <Card defaultPadding>
                                    <Paragraph style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                        {displayedBody}
                                    </Paragraph>
                                </Card>
                            </section>

                            {attachmentUrls.length > 0 && (
                                <section>
                                    <HeadingTertiary>Attachments</HeadingTertiary>
                                    <Paragraph style={{ margin: 0 }}>
                                        {attachmentsBound === true
                                            ? `${attachmentUrls.length} file${attachmentUrls.length === 1 ? "" : "s"} bound to this signature.`
                                            : attachmentsBound === false
                                                ? `${attachmentUrls.length} file${attachmentUrls.length === 1 ? "" : "s"} attached, but the signature was created before attachment binding shipped. The text is signed; the files are not.`
                                                : "Verifying attachments…"}
                                    </Paragraph>
                                </section>
                            )}

                            <Divider />

                            <section>
                                <HeadingTertiary>Public key</HeadingTertiary>
                                <Flex alignItems="stretch" gap={8}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <CodeBlock content={record.publicKey} lang="" />
                                    </div>
                                    <Button
                                        variant="secondary"
                                        size="small"
                                        onClick={() => copy("Public key", record.publicKey)}
                                    >
                                        Copy
                                    </Button>
                                </Flex>
                            </section>

                            <section>
                                <HeadingTertiary>Signature</HeadingTertiary>
                                <Flex alignItems="stretch" gap={8}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <CodeBlock content={record.signature} lang="" />
                                    </div>
                                    <Button
                                        variant="secondary"
                                        size="small"
                                        onClick={() => copy("Signature", record.signature)}
                                    >
                                        Copy
                                    </Button>
                                </Flex>
                            </section>

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
                                    {recordedAt && (
                                        <Paragraph style={{ margin: 0 }}>
                                            <strong>Recorded:</strong> {recordedAt}
                                        </Paragraph>
                                    )}
                                    {record.discordMessageId && (
                                        <Paragraph style={{ margin: 0 }}>
                                            <strong>Discord message id:</strong>{" "}
                                            <code>{record.discordMessageId}</code>
                                        </Paragraph>
                                    )}
                                    <Paragraph style={{ margin: 0 }}>
                                        <strong>Payload version:</strong> {String(record.v)}
                                    </Paragraph>
                                </Flex>
                            </section>
                        </>
                    )}

                    {copyHint && (
                        <Paragraph style={{ margin: 0, color: "var(--status-positive, #23a55a)" }}>{copyHint}</Paragraph>
                    )}
                </Flex>
            </ModalContent>

            <ModalFooter>
                <Button variant="primary" onClick={modalProps.onClose}>Close</Button>
            </ModalFooter>
        </ModalRoot>
    );
}
