/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IconProps } from "@utils/types";

interface LockIconProps extends IconProps {
    locked?: boolean;
}

export function LockIcon({ height = 20, width = 20, className, locked = true }: LockIconProps) {
    return (
        <svg
            viewBox="0 0 24 24"
            height={height}
            width={width}
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            {locked
                ? <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                : <path d="M8 11V8a4 4 0 0 1 7.5-2" />}
            <circle cx="12" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
        </svg>
    );
}
