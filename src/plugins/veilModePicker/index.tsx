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
 * Module-level singleton state. The signed-message plugin keeps
 * `lastEnabled` as a single global flag (not per-channel). E2E is
 * per-channel via the underlying plugin's `enabledByChannel` map; we
 * mirror it here so the picker can reflect the current state when a
 * different channel mounts the button. Listeners are attached once
 * at module load (not inside a component effect), so module state
 * stays correct even when no picker is mounted — every component
 * instance reads through `modeForChannel` instead of caching the
 * mode in its own React state.
 */
const e2eByChannel = new Map<string, boolean>();
let signEnabledGlobal = false;

/** Tick bumped every time module state changes; components subscribe via useState. */
let stateTick = 0;
const stateSubscribers = new Set<() => void>();
function notifySubscribers() {
    stateTick++;
    for (const fn of stateSubscribers) {
        try { fn(); } catch { /* ignore */ }
    }
}

if (typeof window !== "undefined") {
    window.addEventListener(SIGN_TOGGLE_EVENT, (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!detail || typeof detail.enabled !== "boolean") return;
        if (signEnabledGlobal === detail.enabled) return;
        signEnabledGlobal = detail.enabled;
        notifySubscribers();
    });
    window.addEventListener(E2E_TOGGLE_EVENT, (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (!detail || typeof detail.channelId !== "string") return;
        const next = Boolean(detail.enabled);
        const prev = e2eByChannel.get(detail.channelId) === true;
        if (prev === next) return;
        if (next) e2eByChannel.set(detail.channelId, true);
        else e2eByChannel.delete(detail.channelId);
        notifySubscribers();
    });
}

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

    // Optimistically update local module state so the picker icon
    // reflects the user's intent immediately. The underlying plugins
    // are async (sign awaits a binding check, e2e fires its own
    // toggle event); without this, the icon stays on the previous
    // mode until the round-trip completes, which users read as "the
    // picker didn't update". Real plugin state arrives via the
    // SIGN_TOGGLE / E2E_TOGGLE listeners and reconciles us if the
    // request was rejected (e.g. missing binding -> sign plugin
    // dispatches SIGN_TOGGLE { enabled: false } and we revert).
    let changed = false;
    if (signEnabledGlobal !== wantSigned) {
        signEnabledGlobal = wantSigned;
        changed = true;
    }
    const e2ePrev = e2eByChannel.get(channelId) === true;
    if (e2ePrev !== wantE2e) {
        if (wantE2e) e2eByChannel.set(channelId, true);
        else e2eByChannel.delete(channelId);
        changed = true;
    }
    if (changed) notifySubscribers();

    // Disable the outgoing one before enabling the incoming one so
    // the underlying plugins never both think they own the channel
    // for an instant (matters when switching signed <-> e2e).
    if (currentlyE2e && !wantE2e) {
        try {
            window.dispatchEvent(new CustomEvent(REQUEST_E2E_EVENT, {
                detail: { channelId, enabled: false }
            }));
        } catch { /* ignore */ }
    }
    if (currentlySigned && !wantSigned) {
        try {
            window.dispatchEvent(new CustomEvent(REQUEST_SIGN_EVENT, {
                detail: { enabled: false }
            }));
        } catch { /* ignore */ }
    }
    if (!currentlyE2e && wantE2e) {
        try {
            window.dispatchEvent(new CustomEvent(REQUEST_E2E_EVENT, {
                detail: { channelId, enabled: true }
            }));
        } catch { /* ignore */ }
    }
    if (!currentlySigned && wantSigned) {
        try {
            window.dispatchEvent(new CustomEvent(REQUEST_SIGN_EVENT, {
                detail: { enabled: true }
            }));
        } catch { /* ignore */ }
    }
}

/* ---------- ChatBarButton ---------- */

const VeilModeButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    const channelId = channel?.id;
    /*
     * `tick` is just a re-render trigger — actual state lives in the
     * module singleton above. Reading state during render via
     * `modeForChannel` guarantees we never show a stale value, and
     * because both the click action and the request-event reply
     * update the module map, the menu re-opens with the right
     * checked state next time.
     */
    const [, setTick] = useState(stateTick);
    const [e2eEligible, setE2eEligible] = useState(false);

    useEffect(() => {
        const sub = () => setTick(stateTick);
        stateSubscribers.add(sub);
        return () => { stateSubscribers.delete(sub); };
    }, []);

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

    const mode = modeForChannel(channelId);

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

    const pickAndClose = (next: Mode) => {
        // Close first: applyMode dispatches a synchronous cascade
        // through both underlying plugins; if any listener throws
        // (or a future one does), the menu still has to close.
        ContextMenuApi.closeContextMenu();
        applyMode(channelId, next);
    };

    const onClick = (event: React.MouseEvent) => {
        ContextMenuApi.openContextMenu(event as any, () => {
            // Read mode fresh per-render so the radio reflects any
            // module-state change that happened while the menu was open.
            const liveMode = modeForChannel(channelId);
            return (
                <Menu.Menu
                    navId="veil-mode-picker"
                    onClose={ContextMenuApi.closeContextMenu}
                    aria-label="Veil mode"
                >
                    <Menu.MenuGroup label="Veil mode">
                        <Menu.MenuRadioItem
                            id="veil-mode-plain"
                            label="Off"
                            checked={liveMode === "plain"}
                            group="veil-mode"
                            action={() => pickAndClose("plain")}
                        />
                        <Menu.MenuRadioItem
                            id="veil-mode-signed"
                            label="Sign messages"
                            checked={liveMode === "signed"}
                            group="veil-mode"
                            action={() => pickAndClose("signed")}
                        />
                        <Menu.MenuRadioItem
                            id="veil-mode-e2e"
                            label={e2eEligible ? "Encrypt end-to-end" : "Encrypt end-to-end (peer has no Veil key)"}
                            checked={liveMode === "e2e"}
                            group="veil-mode"
                            disabled={!e2eEligible && liveMode !== "e2e"}
                            action={() => {
                                if (!e2eEligible && liveMode !== "e2e") return;
                                pickAndClose("e2e");
                            }}
                        />
                    </Menu.MenuGroup>
                </Menu.Menu>
            );
        });
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
