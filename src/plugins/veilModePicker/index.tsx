/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import ErrorBoundary from "@components/ErrorBoundary";
import { getActiveBindingForUid, VeilX25519 } from "@plugins/veilCrypto";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ContextMenuApi, Menu, useEffect, useState } from "@webpack/common";

/*
 * Unified Veil mode picker.
 *
 * Replaces the two separate chatbar toggles (`VeilSignedMessage` and
 * `VeilE2EMessage`) with one button that opens a three-way picker:
 *
 *   - plain   — no Veil framing, default Discord behaviour.
 *   - signed  — outgoing messages get signed and registered on the
 *               Veil backend. Requires a linked key.
 *   - e2e     — outgoing messages get end-to-end encrypted to the
 *               peer's linked Veil key. DM-only, requires the peer
 *               to have a linked key.
 *
 * Signed and E2E are mutually exclusive (the underlying plugins
 * already enforce that via window events). This plugin owns only the
 * UI; behaviour stays in the original plugins. We talk to them via
 * `veil-mode:request-sign` / `veil-mode:request-e2e` and listen to
 * `veil-sign:toggle` / `veil-e2e:toggle` to stay in sync with auto-
 * disables (failed encrypt, mode collision, missing binding, etc).
 */

type Mode = "plain" | "signed" | "e2e";

const SIGN_TOGGLE_EVENT = "veil-sign:toggle";
const E2E_TOGGLE_EVENT = "veil-e2e:toggle";
const REQUEST_SIGN_EVENT = "veil-mode:request-sign";
const REQUEST_E2E_EVENT = "veil-mode:request-e2e";

const BUTTON_ID = "veil-mode";

/* ---------- icons ---------- */

function PlainIcon({ width = 20, height = 20 }: { width?: number; height?: number; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="currentColor" />
        </svg>
    );
}

function SignGlyph({ width = 20, height = 20 }: { width?: number; height?: number; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" aria-hidden="true">
            <path
                d="M4 19h16M6 16l9-9 3 3-9 9H6v-3z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function LockGlyph({ width = 20, height = 20, locked = true }: { width?: number; height?: number; locked?: boolean; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path
                d={locked
                    ? "M8 11V8a4 4 0 0 1 8 0v3"
                    : "M8 11V8a4 4 0 0 1 7.5-2"}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
        </svg>
    );
}

/* ---------- per-channel sign-mode tracking ----------
 *
 * The signed-message plugin keeps `lastEnabled` as a single global
 * flag rather than per-channel state, because its chatbar button used
 * to live in every channel and read the same shared toggle. We mirror
 * that here: sign mode is global, not per-channel. E2E stays per-
 * channel because the underlying plugin tracks `enabledByChannel`. */
const e2eByChannel = new Map<string, boolean>();
let signEnabledGlobal = false;

function modeForChannel(channelId: string): Mode {
    if (signEnabledGlobal) return "signed";
    if (e2eByChannel.get(channelId) === true) return "e2e";
    return "plain";
}

function applyMode(channelId: string, mode: Mode) {
    // Compute deltas so we don't fire redundant requests. The
    // underlying plugins debounce, but extra dispatches show up as
    // toast spam when something rejects.
    const currentlySigned = signEnabledGlobal;
    const currentlyE2e = e2eByChannel.get(channelId) === true;
    const wantSigned = mode === "signed";
    const wantE2e = mode === "e2e";

    if (currentlyE2e !== wantE2e) {
        try {
            window.dispatchEvent(new CustomEvent(REQUEST_E2E_EVENT, {
                detail: { channelId, enabled: wantE2e }
            }));
        } catch { /* ignore */ }
    }
    if (currentlySigned !== wantSigned) {
        try {
            window.dispatchEvent(new CustomEvent(REQUEST_SIGN_EVENT, {
                detail: { enabled: wantSigned }
            }));
        } catch { /* ignore */ }
    }
}

/* ---------- ChatBarButton ---------- */

const VeilModeButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const channelId = channel?.id;
    const [mode, setMode] = useState<Mode>(channelId ? modeForChannel(channelId) : "plain");
    const [e2eEligible, setE2eEligible] = useState(false);

    /*
     * Sync local state with global/channel flips that originate from
     * elsewhere (auto-disable on failed encrypt, MODE_E2E_ON_EVENT
     * collision, etc). The picker is the only UI surface, but the
     * underlying plugins still call `setEnabled` from their own send-
     * paths.
     */
    useEffect(() => {
        if (!channelId) return;
        setMode(modeForChannel(channelId));

        const onSignToggle = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || typeof detail.enabled !== "boolean") return;
            signEnabledGlobal = detail.enabled;
            setMode(modeForChannel(channelId));
        };
        const onE2eToggle = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || typeof detail.channelId !== "string") return;
            const next = Boolean(detail.enabled);
            if (next) e2eByChannel.set(detail.channelId, true);
            else e2eByChannel.delete(detail.channelId);
            if (detail.channelId === channelId) {
                setMode(modeForChannel(channelId));
            }
        };
        window.addEventListener(SIGN_TOGGLE_EVENT, onSignToggle as EventListener);
        window.addEventListener(E2E_TOGGLE_EVENT, onE2eToggle as EventListener);
        return () => {
            window.removeEventListener(SIGN_TOGGLE_EVENT, onSignToggle as EventListener);
            window.removeEventListener(E2E_TOGGLE_EVENT, onE2eToggle as EventListener);
        };
    }, [channelId]);

    /*
     * Compute E2E eligibility (peer has a linked key + subtle-crypto
     * X25519 is available). Only matters for DMs. Result gates the
     * "Encrypt" radio item; we still render it disabled with an
     * explanation rather than hiding it so the user understands why.
     */
    useEffect(() => {
        let cancelled = false;
        setE2eEligible(false);
        if (!channel || !channel.isDM?.() || channel.isGroupDM?.()) return;
        const recipientUid = channel.getRecipientId?.();
        if (!recipientUid) return;

        void (async () => {
            try {
                const [available, binding] = await Promise.all([
                    VeilX25519.isAvailable(),
                    getActiveBindingForUid(recipientUid)
                ]);
                if (!cancelled) setE2eEligible(Boolean(available && binding));
            } catch {
                if (!cancelled) setE2eEligible(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [channel?.id]);

    if (!isMainChat || !channel || !channelId) return null;

    const tooltip =
        mode === "signed" ? "Veil mode: Sign. Click to change."
        : mode === "e2e" ? "Veil mode: Encrypt. Click to change."
        : "Veil mode: Off. Click to sign or encrypt.";

    const iconColor =
        mode === "signed" ? "var(--text-link, #00a8fc)"
        : mode === "e2e" ? "var(--green-360, #23a55a)"
        : "var(--interactive-normal, #b5bac1)";

    const Glyph = mode === "signed" ? SignGlyph
        : mode === "e2e" ? LockGlyph
        : PlainIcon;

    const onClick = (event: React.MouseEvent) => {
        ContextMenuApi.openContextMenu(event as any, () => (
            <Menu.Menu
                navId="veil-mode-picker"
                onClose={ContextMenuApi.closeContextMenu}
                aria-label="Veil mode"
            >
                <Menu.MenuGroup label="Veil mode">
                    <Menu.MenuRadioItem
                        id="veil-mode-plain"
                        label="Off"
                        checked={mode === "plain"}
                        group="veil-mode"
                        action={() => {
                            applyMode(channelId, "plain");
                            setMode("plain");
                        }}
                    />
                    <Menu.MenuRadioItem
                        id="veil-mode-signed"
                        label="Sign messages"
                        checked={mode === "signed"}
                        group="veil-mode"
                        action={() => {
                            applyMode(channelId, "signed");
                            // Optimistic — `veil-sign:toggle` will
                            // overwrite if the underlying plugin
                            // refuses (no binding, etc).
                            setMode("signed");
                        }}
                    />
                    <Menu.MenuRadioItem
                        id="veil-mode-e2e"
                        label={e2eEligible ? "Encrypt end-to-end" : "Encrypt end-to-end (peer has no Veil key)"}
                        checked={mode === "e2e"}
                        group="veil-mode"
                        disabled={!e2eEligible && mode !== "e2e"}
                        action={() => {
                            if (!e2eEligible && mode !== "e2e") return;
                            applyMode(channelId, "e2e");
                            setMode("e2e");
                        }}
                    />
                </Menu.MenuGroup>
            </Menu.Menu>
        ));
    };

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={onClick}
            buttonProps={{ "aria-pressed": mode !== "plain" } as any}
        >
            <span style={{ color: iconColor, display: "inline-flex" }}>
                <Glyph height={20} width={20} />
            </span>
        </ChatBarButton>
    );
};

const VeilModeButtonIcon = () => <SignGlyph />;

export default definePlugin({
    name: "VeilModePicker",
    description: "Single chatbar control to switch between plain, signed, and end-to-end encrypted Veil modes. Replaces the separate sign and encrypt toggles.",
    authors: [Devs.gabriele],
    dependencies: ["ChatInputButtonAPI", "VeilCrypto", "VeilLinkKey", "VeilSignedMessage", "VeilE2EMessage"],
    required: true,

    start() {
        addChatBarButton(BUTTON_ID, ErrorBoundary.wrap(VeilModeButton, { noop: true }) as any, VeilModeButtonIcon);
    },

    stop() {
        removeChatBarButton(BUTTON_ID);
        e2eByChannel.clear();
        signEnabledGlobal = false;
    }
});
