/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { cryptoService, getActiveBindingForUid, VeilX25519 } from "@plugins/veilCrypto";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelStore, showToast, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import { E2eDecoration } from "./Decoration";
import { LockIcon } from "./LockIcon";
import { decodeEnvelopeBody, encodeEnvelopeBody } from "./parser";
import managedStyle from "./style.css?managed";

// veil v0.0.1

const BUTTON_ID = "veil-e2e";
const ACCESSORY_ID = "veil-e2e-accessory";

const enabledByChannel = new Map<string, boolean>();

function setEnabled(channelId: string, value: boolean) {
    if (value) enabledByChannel.set(channelId, true);
    else enabledByChannel.delete(channelId);
    try {
        window.dispatchEvent(new CustomEvent("veil-e2e:toggle", { detail: { channelId, enabled: value } }));
    } catch { /* ignore */ }
}

function isEnabled(channelId: string): boolean {
    return enabledByChannel.get(channelId) === true;
}

const sendListener: MessageSendListener = async (channelId, messageObj) => {
    if (!isEnabled(channelId)) return;
    if (!messageObj || typeof messageObj.content !== "string" || messageObj.content.length === 0) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel || !channel.isDM() || channel.isGroupDM()) {
        showToast("Veil E2E only works in 1:1 DMs.", Toasts.Type.FAILURE);
        setEnabled(channelId, false);
        return { cancel: true };
    }

    try {
        if (!(await VeilX25519.isAvailable())) {
            showToast("This Discord build doesn't support X25519, so E2E isn't available.", Toasts.Type.FAILURE);
            setEnabled(channelId, false);
            return { cancel: true };
        }

        if (!(await cryptoService.hasStoredKey())) {
            showToast("Link a Veil key to send encrypted messages.", Toasts.Type.FAILURE);
            setEnabled(channelId, false);
            return { cancel: true };
        }

        const me = UserStore.getCurrentUser?.();
        const recipientUid = channel.getRecipientId?.();
        if (!me || !recipientUid) {
            showToast("Couldn't find the recipient for this DM.", Toasts.Type.FAILURE);
            return { cancel: true };
        }

        const binding = await getActiveBindingForUid(recipientUid);
        if (!binding) {
            showToast("This user doesn't have a Veil key linked anymore.", Toasts.Type.FAILURE);
            setEnabled(channelId, false);
            return { cancel: true };
        }

        const plaintext = messageObj.content;
        const ourPub = await cryptoService.getPublicKey();
        const envelope = await cryptoService.encryptForRecipients(
            [binding.publicKey, ourPub],
            plaintext,
            { senderUid: me.id, recipientUid, channelId }
        );
        const finalContent = encodeEnvelopeBody(envelope);

        if (finalContent.length > 2000) {
            showToast(
                `Encrypted message is too long by ${finalContent.length - 2000} chars. Split it up.`,
                Toasts.Type.FAILURE
            );
            return { cancel: true };
        }

        messageObj.content = finalContent;
    } catch (e: any) {
        showToast(`E2E failed: ${e?.message || e}`, Toasts.Type.FAILURE);
        return { cancel: true };
    }
};

const VeilE2EButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const [enabled, setEnabledLocal] = useState(channel ? isEnabled(channel.id) : false);
    const [eligible, setEligible] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const channelId = channel?.id;
        setEnabledLocal(channelId ? isEnabled(channelId) : false);
        setEligible(false);

        if (!channel || !channel.isDM() || channel.isGroupDM()) return;
        const recipientUid = channel.getRecipientId?.();
        if (!recipientUid) return;

        void (async () => {
            try {
                const [available, binding] = await Promise.all([
                    VeilX25519.isAvailable(),
                    getActiveBindingForUid(recipientUid)
                ]);
                if (cancelled) return;
                setEligible(Boolean(available && binding));
            } catch {
                if (!cancelled) setEligible(false);
            }
        })();

        const onToggle = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || detail.channelId !== channelId) return;
            setEnabledLocal(Boolean(detail.enabled));
        };
        window.addEventListener("veil-e2e:toggle", onToggle as EventListener);

        return () => {
            cancelled = true;
            window.removeEventListener("veil-e2e:toggle", onToggle as EventListener);
        };
    }, [channel?.id]);

    if (!isMainChat || !channel) return null;
    if (!channel.isDM() || channel.isGroupDM()) return null;
    if (!eligible) return null;

    const tooltip = enabled
        ? "E2E mode is on. Click to turn off."
        : "Encrypt this DM end-to-end with this user's Veil key.";

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => {
                const next = !enabled;
                setEnabled(channel.id, next);
                setEnabledLocal(next);
            }}
            buttonProps={{ "aria-pressed": enabled } as any}
        >
            <span
                style={{
                    color: enabled
                        ? "var(--text-link, #00a8fc)"
                        : "var(--interactive-normal, #b5bac1)",
                    display: "inline-flex"
                }}
            >
                <LockIcon height={20} width={20} locked={!enabled} />
            </span>
        </ChatBarButton>
    );
};

function hasE2eContent(message: any): boolean {
    return decodeEnvelopeBody(message?.content) !== null;
}

function E2eAccessoryHost(props: any) {
    const message = props?.message;
    if (!hasE2eContent(message)) return null;
    return <E2eDecoration message={message} />;
}

export default definePlugin({
    name: "VeilE2EMessage",
    description: "In a 1:1 DM where the other user has linked a Veil key, adds a lock toggle that encrypts your message end-to-end. Recipients with the plugin auto-decrypt in place with a special flair.",
    authors: [Devs.gabriele],
    dependencies: ["ChatInputButtonAPI", "MessageEventsAPI", "MessageAccessoriesAPI", "VeilCrypto", "VeilLinkKey"],
    required: true,

    managedStyle,

    start() {
        addChatBarButton(BUTTON_ID, VeilE2EButton, LockIcon);
        addMessagePreSendListener(sendListener);
        addMessageAccessory(ACCESSORY_ID, E2eAccessoryHost, -1);
    },

    stop() {
        removeChatBarButton(BUTTON_ID);
        removeMessagePreSendListener(sendListener);
        removeMessageAccessory(ACCESSORY_ID);
        enabledByChannel.clear();
    }
});
