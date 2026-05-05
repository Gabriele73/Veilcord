/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { cryptoService, VeilEd25519, veilApiBase, VeilZwc } from "@plugins/veilCrypto";
import { sendMessage } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { TextArea, TextInput, useEffect, useState } from "@webpack/common";

const HEX64 = /^[0-9a-fA-F]{64}$/;
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
    const [privateKey, setPrivateKey] = useState("");
    const [useStored, setUseStored] = useState(false);
    const [storedAvailable, setStoredAvailable] = useState(false);
    const [storedPublicKey, setStoredPublicKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                if (await cryptoService.hasStoredKey()) {
                    setStoredAvailable(true);
                    setStoredPublicKey(await cryptoService.getPublicKey());
                    setUseStored(true);
                }
            } catch {
                // ignore — fall back to manual entry
            }
        })();
    }, []);

    const trimmedKey = privateKey.trim();
    const privateKeyValid = HEX64.test(trimmedKey);
    const messageReady = message.trim().length > 0;
    const messageTooLong = message.length > MAX_MESSAGE_LEN;
    const canSign = !busy && messageReady && !messageTooLong && (useStored ? storedAvailable : privateKeyValid);

    async function handleSign() {
        setBusy(true);
        setError(null);
        try {
            let publicKey: string;
            let signature: string;
            let signRequest: (canonicalBody: string) => Promise<string>;

            if (useStored) {
                publicKey = await cryptoService.getPublicKey();
                signature = await cryptoService.sign(message);
                signRequest = body => cryptoService.sign(body);
            } else {
                const pk = trimmedKey.toLowerCase();
                publicKey = await VeilEd25519.getPublicKey(pk);
                signature = await VeilEd25519.sign(pk, message);
                signRequest = body => VeilEd25519.sign(pk, body);
            }

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
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>Sign & send via Veil</BaseText>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <Flex flexDirection="column" gap={12}>
                    <Paragraph>
                        Sign a message with an Ed25519 private key. Veil registers the signature with the backend and embeds a tiny lookup id; recipients running Veil verify the signature and see a "Signed" flair.
                    </Paragraph>

                    <section>
                        <HeadingSecondary>Message</HeadingSecondary>
                        <TextArea value={message} onChange={setMessage} placeholder="Message to sign..." />
                        {messageTooLong && (
                            <Paragraph style={{ color: "var(--status-danger)" }}>
                                Message too long — max {MAX_MESSAGE_LEN} chars (signed-id payload reserves {VeilZwc.ZWC_OVERHEAD_CHARS}).
                            </Paragraph>
                        )}
                    </section>

                    {storedAvailable && (
                        <FormSwitch
                            title="Use stored VeilCrypto key"
                            description={storedPublicKey ? `Active public key: ${storedPublicKey.slice(0, 16)}…` : undefined}
                            value={useStored}
                            onChange={setUseStored}
                            hideBorder
                        />
                    )}

                    {!useStored && (
                        <section>
                            <HeadingSecondary>Private key (64-char hex)</HeadingSecondary>
                            <TextInput
                                type="password"
                                value={privateKey}
                                onChange={setPrivateKey}
                                placeholder="ed25519 private key hex"
                            />
                            {privateKey && !privateKeyValid && (
                                <Paragraph style={{ color: "var(--status-danger)" }}>
                                    Invalid private key — must be exactly 64 hex characters.
                                </Paragraph>
                            )}
                        </section>
                    )}

                    {error && (
                        <Paragraph style={{ color: "var(--status-danger)" }}>{error}</Paragraph>
                    )}
                </Flex>
            </ModalContent>

            <ModalFooter>
                <Flex gap={8}>
                    <Button variant="primary" disabled={!canSign} onClick={handleSign}>
                        {busy ? "Signing…" : "Sign & send"}
                    </Button>
                    <Button variant="secondary" onClick={modalProps.onClose}>
                        Cancel
                    </Button>
                </Flex>
            </ModalFooter>
        </ModalRoot>
    );
}
