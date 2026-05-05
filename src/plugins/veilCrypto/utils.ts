/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DB_NAME = "veil_crypto";
export const DB_VERSION = 2;
export const STORE_NAME = "keys";
export const USER_STORE_NAME = "user";

export const PRIVATE_KEY_ID = "ed25519_private_key";
export const USER_DATA_ID = "current_user";

export const PRIVATE_KEY_VAULT_ID = "ed25519_private_key_vault_v1";
export const TRUSTED_UNLOCK_KEY_ID = "ed25519_trusted_unlock_key_v1";
export const TRUSTED_UNLOCK_STATE_ID = "ed25519_trusted_unlock_state_v1";
export const PASSKEY_CREDENTIAL_ID = "ed25519_local_passkey_credential_v1";

export const TRUSTED_UNLOCK_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
export const VAULT_KEY_BYTES = 32;
export const VAULT_IV_BYTES = 12;

export const BACKUP_KDF_ITERATIONS = 250000;
export const BACKUP_SALT_BYTES = 16;
export const BACKUP_IV_BYTES = 12;

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
    const normalized = String(base64 || "")
        .trim()
        .replace(/-/g, "+")
        .replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function toHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
    const match = hex.match(/.{1,2}/g);
    if (!match) return new Uint8Array(0);
    return new Uint8Array(match.map(byte => parseInt(byte, 16)));
}

export function toBytes(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

export function normalizePrivateKeyHex(privateKeyHex: unknown): string {
    return String(privateKeyHex || "").trim().toLowerCase();
}

export function isValidPrivateKeyHex(privateKeyHex: unknown): boolean {
    return /^[0-9a-f]{64}$/.test(normalizePrivateKeyHex(privateKeyHex));
}

export function normalizeByteArray(input: unknown): Uint8Array {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
        const view = input as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    throw new Error("Expected byte array");
}
