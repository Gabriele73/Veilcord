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
import { cryptoService, veilApiBase, VeilZwc } from "@plugins/veilCrypto";
import { LinkKeyModal } from "@plugins/veilLinkKey/LinkKeyModal";
import { sendMessage } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { TextArea, useEffect, useState } from "@webpack/common";

const DISCORD_MAX = 2000;
const MAX_MESSAGE_LEN = DISCORD_MAX - VeilZwc.ZWC_OVERHEAD_CHARS;
const SIGNED_MESSAGE_VERSION = VeilZwc.SIGNED_MESSAGE_VERSION;

interface RegisterResponse {
    id: string;
    createdAt?: number;
}

async function registerSignedMessage({
    message,
    publicKey,
    signature,
    signRequest
}: {
    message: string;
    publicKey: string;
    signature: string;
    signRequest: (canonicalBody: string) => Promise<string>;
}): Promise<RegisterResponse> {
    const body = {
        message,
        publicKey,
        signature,
        v: SIGNED_MESSAGE_VERSION,
        nonce: typeof crypto?.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: Math.floor(Date.now() / 1000)
    };
    const canonical = JSON.stringify(body);
    const requestSignature = await signRequest(canonical);

    const res = await fetch(`${veilApiBase()}/veilcord/signed-message`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Public-Key": publicKey,
            "X-Signature": requestSignature
        },
        body: canonical
    });

    let payload: any = null;
    try {
        payload = await res.json();
    } catch { /* ignore */ }

    if (!res.ok) {
        const reason = (payload && typeof payload.error === "string") ? payload.error : `HTTP ${res.status}`;
        throw new Error(`Backend rejected signed message: ${reason}`);
    }
    if (!payload || typeof payload.id !== "string" || !/^[0-9a-f]{16}$/.test(payload.id)) {
        throw new Error("Backend returned an invalid id.");
    }
    return { id: payload.id, createdAt: typeof payload.createdAt === "number" ? payload.createdAt : undefined };
}

export function SignModal({ modalProps, channelId }: { modalProps: ModalProps; channelId: string; }) {
    const [message, setMessage] = useState("");
    const [keyReady, setKeyReady] = useState(false);
    const [storedPublicKey, setStoredPublicKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function refreshKey() {
        try {
            if (await cryptoService.hasStoredKey()) {
                setStoredPublicKey(await cryptoService.getPublicKey());
                setKeyReady(true);
                return;
            }
        } catch {
            // fall through
        }
        setKeyReady(false);
        setStoredPublicKey(null);
    }

    useEffect(() => { void refreshKey(); }, []);

    function openLinkKey() {
        modalProps.onClose();
        openModal(props => <LinkKeyModal modalProps={props} />);
    }

    const messageReady = message.trim().length > 0;
    const messageTooLong = message.length > MAX_MESSAGE_LEN;
    const canSign = !busy && keyReady && messageReady && !messageTooLong;

    async function handleSign() {
        setBusy(true);
        setError(null);
        try {
            if (!await cryptoService.hasStoredKey()) {
                throw new Error("No private key is linked. Use the key button next to the settings cog to link or generate one.");
            }
            const publicKey = await cryptoService.getPublicKey();
            const signature = await cryptoService.sign(message);
            const signRequest = (body: string) => cryptoService.sign(body);

            const { id } = await registerSignedMessage({
                message,
                publicKey,
                signature,
                signRequest
            });

            const content = message + VeilZwc.encodeId(id);

            await sendMessage(channelId, { content });
            modalProps.onClose();
        } catch (e: any) {
            setError(e?.message || String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>Sign and send via Veil</BaseText>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <Flex flexDirection="column" gap={12}>
                    <Paragraph>
                        Sign a message with your linked Ed25519 key. Veil registers the signature with the backend and embeds a tiny lookup id, so recipients running Veil can verify the signature and see a "Signed" flair.
                    </Paragraph>

                    <section>
                        <HeadingSecondary>Active key</HeadingSecondary>
                        {keyReady && storedPublicKey ? (
                            <code style={{
                                display: "inline-block",
                                padding: "4px 8px",
                                background: "var(--background-secondary)",
                                borderRadius: 4,
                                fontSize: 12,
                                wordBreak: "break-all"
                            }}>
                                {storedPublicKey}
                            </code>
                        ) : (
                            <Flex flexDirection="column" gap={8}>
                                <Paragraph style={{ color: "var(--status-danger)" }}>
                                    There's no private key linked to this client. All Veil signing goes through the shared
                                    VeilCrypto vault, so you'll need to link one first.
                                </Paragraph>
                                <Flex gap={8}>
                                    <Button variant="primary" onClick={openLinkKey}>Link a key…</Button>
                                </Flex>
                            </Flex>
                        )}
                    </section>

                    <section>
                        <HeadingSecondary>Message</HeadingSecondary>
                        <TextArea value={message} onChange={setMessage} placeholder="Message to sign..." />
                        {messageTooLong && (
                            <Paragraph style={{ color: "var(--status-danger)" }}>
                                That's a bit long. The maximum is {MAX_MESSAGE_LEN} characters (the signed-id payload reserves {VeilZwc.ZWC_OVERHEAD_CHARS}).
                            </Paragraph>
                        )}
                    </section>

                    {error && (
                        <Paragraph style={{ color: "var(--status-danger)" }}>{error}</Paragraph>
                    )}
                </Flex>
            </ModalContent>

            <ModalFooter>
                <Flex gap={8}>
                    <Button variant="primary" disabled={!canSign} onClick={handleSign}>
                        {busy ? "Signing…" : "Sign and send"}
                    </Button>
                    <Button variant="secondary" onClick={modalProps.onClose}>
                        Cancel
                    </Button>
                </Flex>
            </ModalFooter>
        </ModalRoot>
    );
}
