/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fromHex, normalizePrivateKeyHex, toBytes, toHex } from "./utils";

const PKCS8_ED25519_HEADER = new Uint8Array([
    48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32
]);

let nativeAvailable: boolean | null = null;

async function probeNative(): Promise<boolean> {
    if (nativeAvailable !== null) return nativeAvailable;
    try {
        const probeBytes = new Uint8Array(32);
        crypto.getRandomValues(probeBytes);
        const pkcs8 = new Uint8Array(PKCS8_ED25519_HEADER.length + 32);
        pkcs8.set(PKCS8_ED25519_HEADER);
        pkcs8.set(probeBytes, PKCS8_ED25519_HEADER.length);
        await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, ["sign"]);
        nativeAvailable = true;
    } catch {
        nativeAvailable = false;
    }
    return nativeAvailable;
}

function privateKeyToPkcs8(privBytes: Uint8Array): Uint8Array {
    const pkcs8 = new Uint8Array(PKCS8_ED25519_HEADER.length + privBytes.length);
    pkcs8.set(PKCS8_ED25519_HEADER);
    pkcs8.set(privBytes, PKCS8_ED25519_HEADER.length);
    return pkcs8;
}

async function importPrivateKey(privateKeyHex: string): Promise<CryptoKey> {
    const privBytes = fromHex(normalizePrivateKeyHex(privateKeyHex));
    return crypto.subtle.importKey(
        "pkcs8",
        privateKeyToPkcs8(privBytes) as BufferSource,
        "Ed25519",
        false,
        ["sign"]
    );
}

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        fromHex(publicKeyHex) as BufferSource,
        "Ed25519",
        true,
        ["verify"]
    );
}

function ensureNative() {
    if (!nativeAvailable) {
        throw new Error(
            "VeilCrypto: native Ed25519 (crypto.subtle) is not available in this runtime. " +
            "Discord/Electron must be on a Chromium build with Ed25519 Web Crypto support."
        );
    }
}

export async function init(): Promise<{ native: boolean; }> {
    const native = await probeNative();
    return { native };
}

export async function getPublicKey(privateKeyHex: string): Promise<string> {
    await probeNative();
    ensureNative();
    const privBytes = fromHex(normalizePrivateKeyHex(privateKeyHex));
    const cryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        privateKeyToPkcs8(privBytes) as BufferSource,
        "Ed25519",
        true,
        ["sign"]
    );
    const jwk = await crypto.subtle.exportKey("jwk", cryptoKey);
    if (typeof jwk.x !== "string") {
        throw new Error("VeilCrypto: failed to derive public key");
    }
    const normalized = jwk.x.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return toHex(out);
}

export async function generatePrivateKey(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return toHex(bytes);
}

export async function sign(privateKeyHex: string, message: string | Uint8Array): Promise<string> {
    await probeNative();
    ensureNative();
    const key = await importPrivateKey(privateKeyHex);
    const msgBytes = typeof message === "string" ? toBytes(message) : message;
    const sig = await crypto.subtle.sign("Ed25519", key, msgBytes as BufferSource);
    return toHex(new Uint8Array(sig));
}

export async function verify(message: string | Uint8Array, signatureHex: string, publicKeyHex: string): Promise<boolean> {
    await probeNative();
    ensureNative();
    const key = await importPublicKey(publicKeyHex);
    const msgBytes = typeof message === "string" ? toBytes(message) : message;
    return crypto.subtle.verify("Ed25519", key, fromHex(signatureHex) as BufferSource, msgBytes as BufferSource);
}
