/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { Devs } from "@utils/constants";
import { openModal } from "@utils/modal";
import definePlugin from "@utils/types";

import { SignIcon } from "./SignIcon";
import { SignModal } from "./SignModal";

// veil v0.0.1

const BUTTON_ID = "veil-sign";

const VeilSignButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    if (!isMainChat) return null;
    return (
        <ChatBarButton
            tooltip="Sign & send with Veil"
            onClick={() =>
                openModal(modalProps => (
                    <SignModal modalProps={modalProps} channelId={channel.id} />
                ))
            }
        >
            <SignIcon height={20} width={20} />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "VeilSignedMessage",
    description: "Adds a chatbar button to sign a message with an Ed25519 private key (or the stored VeilCrypto key) and send it in the current channel.",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],

    start() {
        addChatBarButton(BUTTON_ID, VeilSignButton, SignIcon);
    },

    stop() {
        removeChatBarButton(BUTTON_ID);
    }
});
