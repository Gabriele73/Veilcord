/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cryptoService } from "@plugins/veilCrypto";
import { findComponentByCodeLazy } from "@webpack";
import { useEffect, useState } from "@webpack/common";

import { KeyIcon } from "./KeyIcon";

const Button = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

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

    return (
        <Button
            tooltipText={tooltipText}
            icon={() => <KeyIcon width={20} height={20} color={hasLinkedKey ? "currentColor" : "var(--status-danger)"} />}
            redGlow={!hasLinkedKey}
            aria-label={ariaLabel}
            onClick={onClick}
        />
    );
}
