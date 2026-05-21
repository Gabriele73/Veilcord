/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Tooltip } from "@webpack/common";
import type { MouseEvent } from "react";

import { veilApiBase } from "@plugins/veilCrypto";

import type { VeilServerSummary } from "../api/servers";

interface Props {
    server: VeilServerSummary;
    selected: boolean;
    onSelect: (server: VeilServerSummary) => void;
}

function resolveIcon(icon: string | null, uuid: string): string {
    if (typeof icon === "string" && icon.trim().length > 0) {
        const t = icon.trim();
        if (/^https?:\/\//i.test(t)) return t;
        if (t.startsWith("/")) return veilApiBase() + t;
        return t;
    }
    return `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(uuid)}&backgroundColor=0a5b83,1c799f,69d2e7,f1f4dc,f88c49,b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`;
}

function initialsFromName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) return "V";
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Single Veil guild tile sized and shaped to match Discord's native guild
 * icons. Uses the same 48x48 round → squircle hover affordance so the row
 * lines up visually with neighbouring Discord guilds in the sidebar.
 */
export function VeilGuildTile({ server, selected, onSelect }: Props) {
    const onClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(server);
    };

    const iconUrl = resolveIcon(server.icon, server.uuid);
    const initials = initialsFromName(server.name);

    return (
        <Tooltip text={server.name} position="right">
            {(tooltipProps: any) => (
                <div
                    {...tooltipProps}
                    className={`vc-veil-guild-tile${selected ? " vc-veil-guild-tile--selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={onClick}
                    onKeyDown={e => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelect(server);
                        }
                    }}
                    aria-label={server.name}
                >
                    <div className="vc-veil-guild-pill" aria-hidden="true" />
                    <div className="vc-veil-guild-icon">
                        {iconUrl ? (
                            <img
                                src={iconUrl}
                                alt=""
                                draggable={false}
                                onError={e => {
                                    (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                            />
                        ) : null}
                        <span className="vc-veil-guild-initials">{initials}</span>
                    </div>
                </div>
            )}
        </Tooltip>
    );
}
