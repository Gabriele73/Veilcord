/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { VeilSigBadge } from "./Decoration";
import managedStyle from "./style.css?managed";

// veil v0.0.1

const ACCESSORY_ID = "veil-sig-accessory";

export default definePlugin({
    name: "VeilVerifySignedMessage",
    description: "Detects Veil zero-width signature payloads on messages and renders a per-message verification badge that opens a details modal on click.",
    authors: [Devs.gabriele],
    dependencies: ["MessageAccessoriesAPI", "VeilCrypto"],
    required: true,

    managedStyle,

    start() {
        addMessageAccessory(ACCESSORY_ID, props => (
            <VeilSigBadge message={(props as any).message} />
        ), -1);
    },

    stop() {
        removeMessageAccessory(ACCESSORY_ID);
    }
});
