/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { VeilSigDecoration } from "./Decoration";
import managedStyle from "./style.css?managed";

// veil v0.0.1

const DECORATION_ID = "veil-sig-decoration";

export default definePlugin({
    name: "VeilVerifySignedMessage",
    description: "Detects Veil zero-width signature payloads in messages and shows a 'Signed' flair next to the author that opens a verification modal.",
    authors: [Devs.gabriele],
    dependencies: ["MessageDecorationsAPI", "VeilCrypto"],
    required: true,

    managedStyle,

    start() {
        addMessageDecoration(DECORATION_ID, props => (
            <VeilSigDecoration message={(props as any).message} />
        ));
    },

    stop() {
        removeMessageDecoration(DECORATION_ID);
    }
});
