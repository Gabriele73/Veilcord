/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IconProps } from "@utils/types";

export function SignIcon({ height = 24, width = 24, className }: IconProps) {
    return (
        <svg
            viewBox="0 0 24 24"
            height={height}
            width={width}
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" fill="currentColor" stroke="none" />
            <path d="M20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor" stroke="none" />
            <path d="M4 22h16" />
        </svg>
    );
}
