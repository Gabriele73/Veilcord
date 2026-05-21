/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    closeModal,
    ModalCloseButton,
    ModalContent,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal
} from "@utils/modal";
import { Button, Forms, showToast, TextInput, Toasts, useState } from "@webpack/common";

import { createServer, joinServerByInvite } from "../api/servers";
import { refreshMyServers } from "../stores/veilGuildStore";

type Mode = "join" | "create";

function JoinCreateBody({ modalProps }: { modalProps: ModalProps; }) {
    const [mode, setMode] = useState<Mode>("join");
    const [inviteCode, setInviteCode] = useState("");
    const [serverName, setServerName] = useState("");
    const [description, setDescription] = useState("");
    const [busy, setBusy] = useState(false);

    const handleJoin = async () => {
        const code = inviteCode.trim();
        if (!code) {
            showToast("Enter an invite code.", Toasts.Type.FAILURE);
            return;
        }
        setBusy(true);
        try {
            await joinServerByInvite(code);
            showToast("Joined.", Toasts.Type.SUCCESS);
            await refreshMyServers();
            modalProps.onClose();
        } catch (err: any) {
            showToast(err?.message || "Couldn't join.", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const handleCreate = async () => {
        const name = serverName.trim();
        if (!name) {
            showToast("Pick a server name.", Toasts.Type.FAILURE);
            return;
        }
        setBusy(true);
        try {
            await createServer({ name, description: description.trim() || undefined });
            showToast(`Created ${name}.`, Toasts.Type.SUCCESS);
            await refreshMyServers();
            modalProps.onClose();
        } catch (err: any) {
            showToast(err?.message || "Couldn't create.", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="vc-veil-join-modal-body">
            <div className="vc-veil-join-tabs" role="tablist">
                <button
                    role="tab"
                    aria-selected={mode === "join"}
                    className={`vc-veil-join-tab${mode === "join" ? " vc-veil-join-tab--active" : ""}`}
                    onClick={() => setMode("join")}
                >Join with invite</button>
                <button
                    role="tab"
                    aria-selected={mode === "create"}
                    className={`vc-veil-join-tab${mode === "create" ? " vc-veil-join-tab--active" : ""}`}
                    onClick={() => setMode("create")}
                >Create server</button>
            </div>

            {mode === "join" ? (
                <section className="vc-veil-join-section">
                    <Forms.FormTitle tag="h3">Invite code</Forms.FormTitle>
                    <TextInput
                        value={inviteCode}
                        onChange={setInviteCode}
                        placeholder="e.g. aBc123"
                        autoFocus
                    />
                    <Forms.FormText className="vc-veil-join-hint">
                        Paste a Veil invite code from the person who runs the server.
                    </Forms.FormText>
                    <div className="vc-veil-join-actions">
                        <Button color={Button.Colors.PRIMARY} look={Button.Looks.LINK} onClick={() => modalProps.onClose()}>
                            Cancel
                        </Button>
                        <Button color={Button.Colors.BRAND} disabled={busy} onClick={handleJoin}>
                            {busy ? "Joining…" : "Join"}
                        </Button>
                    </div>
                </section>
            ) : (
                <section className="vc-veil-join-section">
                    <Forms.FormTitle tag="h3">Server name</Forms.FormTitle>
                    <TextInput
                        value={serverName}
                        onChange={setServerName}
                        placeholder="My Veil server"
                        autoFocus
                    />
                    <Forms.FormTitle tag="h3" className="vc-veil-join-spacer">Description (optional)</Forms.FormTitle>
                    <TextInput
                        value={description}
                        onChange={setDescription}
                        placeholder="What's it for?"
                    />
                    <div className="vc-veil-join-actions">
                        <Button color={Button.Colors.PRIMARY} look={Button.Looks.LINK} onClick={() => modalProps.onClose()}>
                            Cancel
                        </Button>
                        <Button color={Button.Colors.BRAND} disabled={busy} onClick={handleCreate}>
                            {busy ? "Creating…" : "Create"}
                        </Button>
                    </div>
                </section>
            )}
        </div>
    );
}

export function openVeilJoinModal() {
    const key = openModal(modalProps => (
        <ModalRoot {...modalProps} size={ModalSize.SMALL} className="vc-veil-modal vc-veil-join-modal">
            <ModalHeader>
                <Forms.FormTitle tag="h1" className="vc-veil-join-modal-title">Veil servers</Forms.FormTitle>
                <ModalCloseButton onClick={() => closeModal(key)} />
            </ModalHeader>
            <ModalContent>
                <JoinCreateBody modalProps={modalProps} />
            </ModalContent>
        </ModalRoot>
    ));
    return key;
}
