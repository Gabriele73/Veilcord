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
import { Button, Forms, showToast, Toasts, useEffect, useState } from "@webpack/common";

import { getServerDetail, leaveServer, VeilChannelRecord, VeilServerDetail, VeilServerSummary } from "../api/servers";
import { refreshMyServers, selectServer } from "../stores/veilGuildStore";

interface DetailState {
    loading: boolean;
    error: string | null;
    detail: VeilServerDetail | null;
}

const EMPTY: DetailState = { loading: true, error: null, detail: null };

function ChannelRow({ channel }: { channel: VeilChannelRecord; }) {
    // type 4 is category, every other type is treated as a clickable channel.
    const isCategory = channel.type === 4;
    const prefix = isCategory ? "" : "#";
    return (
        <li
            className={`vc-veil-server-channel${isCategory ? " vc-veil-server-channel--category" : ""}`}
        >
            <span className="vc-veil-server-channel-prefix" aria-hidden="true">{prefix}</span>
            <span className="vc-veil-server-channel-name">{channel.name}</span>
            {channel.topic ? (
                <span className="vc-veil-server-channel-topic">{channel.topic}</span>
            ) : null}
        </li>
    );
}

function ServerModalBody({ summary, modalProps }: { summary: VeilServerSummary; modalProps: ModalProps; }) {
    const [state, setState] = useState<DetailState>(EMPTY);

    useEffect(() => {
        let cancelled = false;
        setState(EMPTY);
        getServerDetail(summary.id).then(
            detail => { if (!cancelled) setState({ loading: false, error: null, detail }); },
            err => { if (!cancelled) setState({ loading: false, error: err?.message || "Couldn't load server", detail: null }); }
        );
        return () => { cancelled = true; };
    }, [summary.id]);

    const handleLeave = async () => {
        try {
            await leaveServer(summary.id);
            showToast(`You left ${summary.name}.`, Toasts.Type.SUCCESS);
            selectServer(null);
            await refreshMyServers();
            modalProps.onClose();
        } catch (err: any) {
            showToast(err?.message || "Couldn't leave the server.", Toasts.Type.FAILURE);
        }
    };

    if (state.loading) {
        return <div className="vc-veil-server-loading">Loading…</div>;
    }
    if (state.error || !state.detail) {
        return <div className="vc-veil-server-error">{state.error || "Couldn't load this server."}</div>;
    }

    const { server, channels, memberCount } = state.detail;
    const sortedChannels = [...channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    return (
        <div className="vc-veil-server-modal-body">
            <header className="vc-veil-server-summary">
                <Forms.FormTitle tag="h2" className="vc-veil-server-name">{server.name}</Forms.FormTitle>
                {server.description ? (
                    <Forms.FormText className="vc-veil-server-desc">{server.description}</Forms.FormText>
                ) : null}
                <Forms.FormText className="vc-veil-server-meta">
                    {memberCount} member{memberCount === 1 ? "" : "s"}
                    {server.ownerName ? ` · owner ${server.ownerName}` : ""}
                </Forms.FormText>
            </header>

            <section className="vc-veil-server-section">
                <Forms.FormTitle tag="h3" className="vc-veil-server-section-title">Channels</Forms.FormTitle>
                {sortedChannels.length === 0 ? (
                    <Forms.FormText>No channels yet.</Forms.FormText>
                ) : (
                    <ul className="vc-veil-server-channels">
                        {sortedChannels.map(c => <ChannelRow key={c.id} channel={c} />)}
                    </ul>
                )}
            </section>

            <footer className="vc-veil-server-footer">
                <Button color={Button.Colors.RED} look={Button.Looks.LINK} onClick={handleLeave}>
                    Leave server
                </Button>
                <Button color={Button.Colors.BRAND} onClick={() => modalProps.onClose()}>
                    Close
                </Button>
            </footer>
        </div>
    );
}

export function openVeilServerModal(summary: VeilServerSummary) {
    const key = openModal(modalProps => (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM} className="vc-veil-modal vc-veil-server-modal">
            <ModalHeader>
                <Forms.FormTitle tag="h1" className="vc-veil-server-modal-title">{summary.name}</Forms.FormTitle>
                <ModalCloseButton onClick={() => closeModal(key)} />
            </ModalHeader>
            <ModalContent>
                <ServerModalBody summary={summary} modalProps={modalProps} />
            </ModalContent>
        </ModalRoot>
    ));
    return key;
}
