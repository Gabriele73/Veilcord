/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService } from "@plugins/veilCrypto";
import { Tooltip, useEffect, useState } from "@webpack/common";

import { KeyIcon } from "./KeyIcon";

export function PanelButton({ onClick }: { onClick: () => void; }) {
    const [hasLinkedKey, setHasLinkedKey] = useState(true);

    useEffect(() => {
        let active = true;
        const refresh = async () => {
            try {
                const linked = await cryptoService.hasAnyLinkedKey();
                if (active) setHasLinkedKey(linked);
            } catch {
                if (active) setHasLinkedKey(false);
            }
        };
        void refresh();
        window.addEventListener("veilcrypto:state-change", refresh);
        return () => {
            active = false;
            window.removeEventListener("veilcrypto:state-change", refresh);
        };
    }, []);

    const tooltipText = hasLinkedKey
        ? "Manage your Veil key"
        : "No Veil key linked yet. Click to set one up.";
    const ariaLabel = hasLinkedKey
        ? "Manage your Veil key"
        : "Link a Veil key";
    const className = hasLinkedKey
        ? "vc-veil-panel-button"
        : "vc-veil-panel-button vc-veil-needs-key";

    return (
        <Tooltip text={tooltipText} position="top">
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    type="button"
                    className={className}
                    onClick={onClick}
                    aria-label={ariaLabel}
                >
                    <KeyIcon width={18} height={18} />
                </button>
            )}
        </Tooltip>
    );
}
