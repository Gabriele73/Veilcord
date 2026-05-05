/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

const DEFAULT_API_BASE = "https://api.veil.rip";

export const settings = definePluginSettings({
    apiBase: {
        type: OptionType.STRING,
        description: "Base URL for Veil backend calls (used by Veil signed-message plugins).",
        default: DEFAULT_API_BASE,
        placeholder: DEFAULT_API_BASE
    }
});

export function veilApiBase(): string {
    const raw = (settings.store.apiBase ?? "").trim();
    const base = raw.length > 0 ? raw : DEFAULT_API_BASE;
    return base.replace(/\/+$/, "");
}
