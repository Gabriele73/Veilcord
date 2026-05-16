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
import { CanonicalAttachment, cryptoService, isBindingActiveAt, veilApiBase, VeilSignedBody } from "@plugins/veilCrypto";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { PluginNative } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { VeilSigRef } from "./parser";
import * as recordCache from "./recordCache";

const Native = VencordNative.pluginHelpers.VeilVerifySignedMessage as PluginNative<typeof import("./native")>;

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
    const publicKey = typeof raw.publicKey === "string" ? raw.publicKey.toLowerCase() : null;
    const signature = typeof raw.signature === "string" ? raw.signature.toLowerCase() : null;
    const v = typeof raw.v === "number" ? raw.v : null;
    const submitterPubkey = typeof raw.submitterPubkey === "string" ? raw.submitterPubkey.toLowerCase() : "";
    const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : 0;

    if (!publicKey || !HEX64.test(publicKey)) return null;
    if (!signature || !HEX128.test(signature)) return null;
    if (v == null) return null;

    return { id, discordMessageId, publicKey, signature, v, submitterPubkey, createdAt };
}

export function VerifyModal({
    modalProps,
    sigRef,
    discordMessageId,
    channelId,
    authorId,
    strippedContent,
    attachmentUrls,
    authorTag,
    timestamp
}: {
    modalProps: ModalProps;
    sigRef: VeilSigRef;
    discordMessageId: string | null;
    channelId: string | null;
    authorId: string | null;
    strippedContent: string;
    attachmentUrls: string[];
    authorTag?: string;
    timestamp?: string;
}) {
    const [status, setStatus] = useState<Status>("loading");
    const [record, setRecord] = useState<FetchedRecord | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [copyHint, setCopyHint] = useState<string | null>(null);
    /** True iff verification succeeded against the attachments-bound canonical body. */
    const [attachmentsBound, setAttachmentsBound] = useState<boolean | null>(null);
    /** Exact byte sequence (UTF-8 string) that Ed25519 signed over. Exposed so
     *  the user can copy it and verify with any third-party Ed25519 tool. */
    const [canonicalPayload, setCanonicalPayload] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        let attempt = 0;

        const buildUrl = (): string | null => {
            if (sigRef.v !== 4 || !discordMessageId) return null;
            return `${veilApiBase()}/veilcord/signed-message/by-discord/${encodeURIComponent(discordMessageId)}`;
        };

        const hashAttachmentList = async (): Promise<CanonicalAttachment[] | null> => {
            const out: CanonicalAttachment[] = [];
            for (const url of attachmentUrls) {
                try {
                    const fetched = await Native.fetchAttachmentBytes(url);
                    if (!fetched.ok) return null;
                    const bytes = fetched.bytes instanceof Uint8Array
                        ? fetched.bytes
                        : new Uint8Array(fetched.bytes as any);
                    out.push({ sha256Hex: await cryptoService.sha256Hex(bytes) });
                } catch {
                    return null;
                }
            }
            return out;
        };

        const verifyRecord = async (normalized: FetchedRecord) => {
            try {
                let ok = false;
                let bound: boolean | null = null;
                // v4 only: rebuilds (mid, cid, uid) + attachment hashes
                // from live message metadata. v3 inserts are no longer
                // accepted server-side and v3 records are not rendered.
                if (sigRef.v !== 4) {
                    setStatus("invalid");
                    setAttachmentsBound(null);
                    return;
                }
                if (!discordMessageId || !channelId || !authorId) {
                    ok = false;
                } else {
                    const hashes = attachmentUrls.length > 0
                        ? await hashAttachmentList()
                        : [];
                    if (hashes) {
                        const ctx = {
                            discordMessageId,
                            channelId,
                            senderUid: authorId
                        };
                        const canonical = VeilSignedBody.buildCanonicalSignedBodyV4(strippedContent, hashes, ctx);
                        setCanonicalPayload(canonical);
                        ok = await cryptoService.verify(canonical, normalized.signature, normalized.publicKey);
                        if (ok) bound = attachmentUrls.length > 0 ? true : null;
                    }
                }
                if (cancelled) return;
                if (!ok) {
                    setStatus("invalid");
                    setAttachmentsBound(bound);
                    return;
                }
                // v4 hard gate: a valid signature alone proves nothing
                // about the apparent author. Anyone can sign a canonical
                // body containing any uid with their own key. Require
                // publicKey to be bound to authorId at signing time and
                // treat unbound v4 records as if they didn't exist —
                // showing the pubkey / signature in the modal would let
                // graffiti masquerade as a "Signed by …" attribution.
                if (authorId && normalized.createdAt) {
                    const active = await isBindingActiveAt(
                        authorId,
                        normalized.publicKey,
                        normalized.createdAt
                    );
                    if (cancelled) return;
                    if (!active) {
                        setRecord(null);
                        setStatus("missing");
                        setAttachmentsBound(null);
                        return;
                    }
                }
                setStatus("valid");
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
            // Persistent cache: a `hit` is good forever (records are
            // immutable); a `miss` is honored within its TTL so we
            // don't replay the retry ladder for a record we already
            // confirmed isn't there yet. The MESSAGE_REGISTERED event
            // invalidates the cached entry on the sender's own client
            // so a freshly-registered record surfaces immediately.
            if (discordMessageId) {
                const persisted = await recordCache.readRecord(discordMessageId);
                if (cancelled) return;
                if (persisted) {
                    if (persisted.kind === "hit") {
                        const normalized = normalizeRecord(persisted.record);
                        if (normalized) {
                            setRecord(normalized);
                            setStatus("verifying");
                            await verifyRecord(normalized);
                            return;
                        }
                    } else {
                        setStatus("missing");
                        setErrorMsg(null);
                        return;
                    }
                }
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
                    if (discordMessageId) void recordCache.writeMiss(discordMessageId);
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
                if (discordMessageId) void recordCache.writeHit(discordMessageId, raw);
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
            if (discordMessageId) void recordCache.invalidate(discordMessageId);
            setStatus("loading");
            setErrorMsg(null);
            setRecord(null);
            setCanonicalPayload(null);
            void tryFetch();
        };

        void tryFetch();
        window.addEventListener(REGISTERED_EVENT, restartFromEvent as EventListener);
        return () => {
            cancelled = true;
            window.removeEventListener(REGISTERED_EVENT, restartFromEvent as EventListener);
        };
    }, [sigRef.v, discordMessageId, channelId, authorId, strippedContent, attachmentUrls.join("|")]);

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

    const displayedBody = VeilSignedBody.stripAttachmentBlock(strippedContent);

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

                            {canonicalPayload && (
                                <section>
                                    <HeadingTertiary>Signed payload</HeadingTertiary>
                                    <Paragraph style={{ margin: "0 0 8px", color: "var(--text-muted, #949ba4)", fontSize: "0.8125rem" }}>
                                        These are the exact bytes Ed25519 signed over. Copy them and run any third-party verifier against the public key and signature above to confirm the result yourself.
                                    </Paragraph>
                                    <Flex alignItems="stretch" gap={8}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <CodeBlock content={canonicalPayload} lang="" />
                                        </div>
                                        <Button
                                            variant="secondary"
                                            size="small"
                                            onClick={() => copy("Signed payload", canonicalPayload)}
                                        >
                                            Copy
                                        </Button>
                                    </Flex>
                                </section>
                            )}

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
