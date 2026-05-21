/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Synthetic id encoding for Veil entities surfaced through Discord-shaped
 * stores. Discord internals call `BigInt(id)` and Number-cast snowflakes;
 * Veil ids therefore must be numeric decimal strings under 2^63.
 *
 * Layout:
 *   "99" + 16 zero-padded decimal digits → server (max servers.id ≈ 1e16)
 *   "98" + 16 zero-padded decimal digits → channel
 *   "97" + 16 zero-padded decimal digits → room (group chat)
 *   "96" + 16 zero-padded decimal digits → meta pseudo-guild (rooms/DMs)
 *
 * The "9" prefix keeps Veil ids comfortably below 2^63 (≈9.22e18) while
 * staying out of Discord's real snowflake range, which is the timestamp
 * field shifted left by 22 bits — Discord IDs from 2024 onward look like
 * 13xxxxxxxxxxxxxxxxxx, well above ours, but a leading "9" still parses
 * cleanly through every BigInt path we've audited.
 *
 * The bidi map only stores entries the runtime has actually seen, so it
 * grows linearly with the user's Veil membership and resets per session.
 */

export type VeilEntityKind = "server" | "channel" | "room" | "meta";

interface Entry {
    kind: VeilEntityKind;
    dbId: number;
    uuid?: string;
}

const PREFIX: Record<VeilEntityKind, string> = {
    server: "99",
    channel: "98",
    room: "97",
    meta: "96"
};

const META_GUILD_ID = "96" + "0".repeat(16);

const synthToEntry = new Map<string, Entry>();
const dbToSynth = new Map<string, string>();

function makeSyntheticId(kind: VeilEntityKind, dbId: number): string {
    return PREFIX[kind] + String(dbId).padStart(16, "0");
}

function dbKey(kind: VeilEntityKind, dbId: number): string {
    return `${kind}:${dbId}`;
}

export function registerEntity(kind: VeilEntityKind, dbId: number, uuid?: string): string {
    const key = dbKey(kind, dbId);
    let synth = dbToSynth.get(key);
    if (!synth) {
        synth = makeSyntheticId(kind, dbId);
        dbToSynth.set(key, synth);
        synthToEntry.set(synth, { kind, dbId, uuid });
    } else if (uuid && !synthToEntry.get(synth)?.uuid) {
        synthToEntry.set(synth, { kind, dbId, uuid });
    }
    return synth;
}

export function getEntity(syntheticId: string): Entry | null {
    return synthToEntry.get(syntheticId) ?? null;
}

export function isVeilId(id: unknown): id is string {
    if (typeof id !== "string") return false;
    return id.length === 18 && (
        id.startsWith("99") || id.startsWith("98") ||
        id.startsWith("97") || id.startsWith("96")
    );
}

export function isVeilGuildId(id: unknown): id is string {
    return typeof id === "string" && (id.startsWith("99") || id === META_GUILD_ID) && id.length === 18;
}

export function isVeilChannelId(id: unknown): id is string {
    return typeof id === "string" && id.length === 18 && id.startsWith("98");
}

export function isVeilRoomId(id: unknown): id is string {
    return typeof id === "string" && id.length === 18 && id.startsWith("97");
}

export const VEIL_META_GUILD_ID = META_GUILD_ID;
