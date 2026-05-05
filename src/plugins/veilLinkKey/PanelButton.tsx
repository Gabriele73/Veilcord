/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Tooltip } from "@webpack/common";

import { KeyIcon } from "./KeyIcon";

export function PanelButton({ onClick }: { onClick: () => void; }) {
    return (
        <Tooltip text="Manage your Veil key">
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className="vc-veil-panel-button"
                    onClick={onClick}
                    aria-label="Manage Veil private key"
                >
                    <KeyIcon width={18} height={18} />
                </button>
            )}
        </Tooltip>
    );
}
