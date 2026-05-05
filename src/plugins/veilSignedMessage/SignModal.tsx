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
import { cryptoService, VeilEd25519, VeilZwc } from "@plugins/veilCrypto";
import { sendMessage } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { TextArea, TextInput, useEffect, useState } from "@webpack/common";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const DISCORD_MAX = 2000;
const MAX_MESSAGE_LEN = DISCORD_MAX - VeilZwc.ZWC_OVERHEAD_CHARS;

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

            if (useStored) {
                publicKey = await cryptoService.getPublicKey();
                signature = await cryptoService.sign(message);
            } else {
                const pk = trimmedKey.toLowerCase();
                publicKey = await VeilEd25519.getPublicKey(pk);
                signature = await VeilEd25519.sign(pk, message);
            }

            const content = message + VeilZwc.encodeSignature(publicKey, signature);

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
                        Sign a message with an Ed25519 private key. Recipients can verify the signature matches the public key you include.
                    </Paragraph>

                    <section>
                        <HeadingSecondary>Message</HeadingSecondary>
                        <TextArea value={message} onChange={setMessage} placeholder="Message to sign..." />
                        {messageTooLong && (
                            <Paragraph style={{ color: "var(--status-danger)" }}>
                                Message too long — max {MAX_MESSAGE_LEN} chars (signature payload reserves {VeilZwc.ZWC_OVERHEAD_CHARS}).
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
