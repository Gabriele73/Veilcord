/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * X25519 helpers for Veil end-to-end DM encryption.
 *
 * Long-term identities are Ed25519. For ECDH we run X25519 (Curve25519)
 * via Web Crypto, but feed it keys derived from the Ed25519 material:
 *
 *   - public key:  decompress the Edwards point, map to Montgomery u
 *                  via the standard birational map u = (1+y)/(1-y) mod p.
 *   - private key: SHA-512 the 32-byte seed, take the first 32 bytes,
 *                  apply the X25519 clamp.
 *
 * ECDH itself (and the ephemeral keypair the sender uses) goes through
 * `crypto.subtle` so the actual scalar multiplication is handled by the
 * runtime. The point-conversion math here is pure bigint and runs once
 * per message.
 */

import { fromHex, normalizePrivateKeyHex } from "./utils";

const P = (1n << 255n) - 19n;
const D_NUMERATOR = -121665n;
const D_DENOMINATOR = 121666n;

const PKCS8_X25519_HEADER = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
    0x04, 0x22, 0x04, 0x20
]);

let nativeAvailable: boolean | null = null;

function mod(a: bigint, m: bigint): bigint {
    const r = a % m;
    return r < 0n ? r + m : r;
}

function powMod(base: bigint, exponent: bigint, m: bigint): bigint {
    let result = 1n;
    let b = mod(base, m);
    let e = exponent;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % m;
        b = (b * b) % m;
        e >>= 1n;
    }
    return result;
}

function invMod(a: bigint, m: bigint): bigint {
    return powMod(a, m - 2n, m);
}

function bytesToLeBigInt(bytes: Uint8Array): bigint {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        v = (v << 8n) | BigInt(bytes[i]);
    }
    return v;
}

function leBigIntToBytes(value: bigint, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let v = value;
    for (let i = 0; i < length; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

function decompressEdwards(pub: Uint8Array): { x: bigint; y: bigint; } {
    if (pub.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");

    const buf = new Uint8Array(pub);
    const xParity = (buf[31] & 0x80) >> 7;
    buf[31] &= 0x7f;

    const y = bytesToLeBigInt(buf);
    if (y >= P) throw new Error("Ed25519 public key y is out of field");

    const dInv = invMod(D_DENOMINATOR, P);
    const D = mod(D_NUMERATOR * dInv, P);

    const y2 = (y * y) % P;
    const u = mod(y2 - 1n, P);
    const v = mod(D * y2 + 1n, P);

    // x = sqrt(u/v) using the trick x = u v^3 (u v^7)^((p-5)/8).
    const v2 = (v * v) % P;
    const v3 = (v2 * v) % P;
    const v7 = (v3 * v3 * v) % P;
    const exp = (P - 5n) / 8n;
    let x = ((u * v3) % P) * powMod((u * v7) % P, exp, P) % P;

    const check = ((v * x) % P) * x % P;
    if (check === u) {
        // square root verified
    } else if (mod(check + u, P) === 0n) {
        const SQRT_M1 = powMod(2n, (P - 1n) / 4n, P);
        x = (x * SQRT_M1) % P;
    } else {
        throw new Error("Ed25519 public key is not on the curve");
    }

    if (x === 0n && xParity === 1) {
        throw new Error("Ed25519 public key has invalid x parity");
    }
    if ((x & 1n) !== BigInt(xParity)) {
        x = mod(-x, P);
    }

    return { x, y };
}

/** Convert an Ed25519 public key (hex) to its X25519 raw public bytes. */
export function ed25519PubToX25519(ed25519PubHex: string): Uint8Array {
    const pub = fromHex(ed25519PubHex.toLowerCase());
    const { y } = decompressEdwards(pub);
    const num = mod(1n + y, P);
    const den = mod(1n - y, P);
    if (den === 0n) throw new Error("Ed25519 public key maps to a singular Montgomery point");
    const u = (num * invMod(den, P)) % P;
    return leBigIntToBytes(u, 32);
}

/** Derive the X25519 (clamped) private seed from an Ed25519 private key. */
export async function ed25519PrivToX25519(ed25519PrivHex: string): Promise<Uint8Array> {
    const priv = fromHex(normalizePrivateKeyHex(ed25519PrivHex));
    if (priv.length !== 32) throw new Error("Ed25519 private key must be 32 bytes");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", priv as BufferSource));
    const seed = digest.slice(0, 32);
    seed[0] &= 248;
    seed[31] &= 127;
    seed[31] |= 64;
    return seed;
}

async function probeNative(): Promise<boolean> {
    if (nativeAvailable !== null) return nativeAvailable;
    try {
        const probeBytes = new Uint8Array(32);
        crypto.getRandomValues(probeBytes);
        probeBytes[0] &= 248;
        probeBytes[31] &= 127;
        probeBytes[31] |= 64;
        const pkcs8 = new Uint8Array(PKCS8_X25519_HEADER.length + 32);
        pkcs8.set(PKCS8_X25519_HEADER);
        pkcs8.set(probeBytes, PKCS8_X25519_HEADER.length);
        await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "X25519", false, ["deriveBits"]);
        nativeAvailable = true;
    } catch {
        nativeAvailable = false;
    }
    return nativeAvailable;
}

function ensureNative() {
    if (!nativeAvailable) {
        throw new Error(
            "VeilCrypto: native X25519 (crypto.subtle) is not available in this runtime. " +
            "Discord/Electron must be on a Chromium build with X25519 Web Crypto support."
        );
    }
}

/** True iff the runtime can perform X25519 ECDH via Web Crypto. */
export async function isAvailable(): Promise<boolean> {
    return probeNative();
}

async function importX25519PrivateKey(seed: Uint8Array): Promise<CryptoKey> {
    if (seed.length !== 32) throw new Error("X25519 private seed must be 32 bytes");
    const pkcs8 = new Uint8Array(PKCS8_X25519_HEADER.length + 32);
    pkcs8.set(PKCS8_X25519_HEADER);
    pkcs8.set(seed, PKCS8_X25519_HEADER.length);
    return crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "X25519", false, ["deriveBits"]);
}

async function importX25519PublicKey(rawPub: Uint8Array): Promise<CryptoKey> {
    if (rawPub.length !== 32) throw new Error("X25519 public key must be 32 bytes");
    return crypto.subtle.importKey("raw", rawPub as BufferSource, "X25519", true, []);
}

/**
 * Generate a fresh ephemeral X25519 keypair. Returns the raw 32-byte
 * private seed (so we can pass it back into the deriveBits path) and the
 * 32-byte public key bytes.
 */
export async function generateEphemeralX25519(): Promise<{ privSeed: Uint8Array; rawPub: Uint8Array; }> {
    await probeNative();
    ensureNative();
    const keyPair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    if (pkcs8.length < 32) throw new Error("Unexpected X25519 PKCS8 length");
    const privSeed = pkcs8.slice(pkcs8.length - 32);
    return { privSeed, rawPub };
}

/** Compute the 32-byte X25519 shared secret between our seed and a peer's raw public key. */
export async function deriveSharedBits(privSeed: Uint8Array, peerRawPub: Uint8Array): Promise<Uint8Array> {
    await probeNative();
    ensureNative();
    const priv = await importX25519PrivateKey(privSeed);
    const pub = await importX25519PublicKey(peerRawPub);
    const bits = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);
    return new Uint8Array(bits);
}
