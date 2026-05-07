/*
 * Vencord, a modification for Discord's desktop app
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function KeyGlyph({ size = 14 }: { size?: number; } = {}) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="vc-veil-pkp-glyph"
        >
            <circle cx="6" cy="10" r="2.6" />
            <path d="M8.5 9.4l5.4-5.4" />
            <path d="M11.6 6.3l1.6 1.6" />
        </svg>
    );
}
