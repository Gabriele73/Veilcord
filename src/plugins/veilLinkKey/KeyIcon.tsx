/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface KeyIconProps {
    width?: number;
    height?: number;
    color?: string;
    className?: string;
}

export function KeyIcon({ width = 18, height = 18, color = "currentColor", className }: KeyIconProps = {}) {
    return (
        <svg
            width={width}
            height={height}
            viewBox="0 0 24 24"
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={className}
        >
            <circle cx="7.5" cy="15.5" r="4" />
            <path d="M10.5 12.5L21 2" />
            <path d="M16 7l3 3" />
            <path d="M19 4l2 2" />
        </svg>
    );
}
