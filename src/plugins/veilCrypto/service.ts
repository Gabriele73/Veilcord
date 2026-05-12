/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as ed from "./ed25519";
import { KeyStorage } from "./storage";
import {
    BACKUP_IV_BYTES,
    BACKUP_KDF_ITERATIONS,
    BACKUP_SALT_BYTES,
    base64ToBytes,
    bytesToBase64,
    fromHex,
    isValidPrivateKeyHex,
    normalizeByteArray,
    normalizePrivateKeyHex,
    TRUSTED_UNLOCK_LEASE_MS,
    VAULT_IV_BYTES,
    VAULT_KEY_BYTES
} from "./utils";
import {
    deriveSharedBits,
    ed25519PrivToX25519,
    ed25519PubToX25519,
    generateEphemeralX25519,
    isAvailable as isX25519Available
} from "./x25519";

/*
 * Multi-recipient envelope (v2).
 *
 * A single random AES-128 content key K encrypts the plaintext once.
 * For every recipient (in 1:1 DMs that's [the other user, ourselves])
 * we attach a slot that wraps K with a key derived from
 * `HKDF(ECDH(eph_priv, slot_static_x25519_pub))`. Either party can
 * unwrap by computing `ECDH(my_static_x25519_priv, eph_pub)` and
 * picking their own slot by 4-byte fingerprint.
 *
 *   [ver=2 :1B][magic 0x56 0xE2 :2B]
 *   [eph_pub :32B][payload_iv :12B][n_slots :1B]
 *   slot[0..n_slots-1] each 48B:
 *       [fpr :4B][wrap_iv :12B][wrapped_K + GCM_tag :32B]
 *   [ciphertext + GCM_tag :N+16B]
 *
 * Both wrap and payload AEADs bind to context-specific AAD so slot
 * substitution and cross-channel replay both fail to decrypt.
 */
const E2E_ENVELOPE_VERSION = 0x02;
const E2E_ENVELOPE_MAGIC = new Uint8Array([0x56, 0xE2]);
const E2E_FPR_BYTES = 4;
const E2E_EPH_PUB_BYTES = 32;
const E2E_PAYLOAD_IV_BYTES = 12;
const E2E_WRAP_IV_BYTES = 12;
const E2E_CONTENT_KEY_BYTES = 16;
const E2E_AEAD_TAG_BYTES = 16;
const E2E_WRAPPED_KEY_BYTES = E2E_CONTENT_KEY_BYTES + E2E_AEAD_TAG_BYTES;
const E2E_SLOT_BYTES = E2E_FPR_BYTES + E2E_WRAP_IV_BYTES + E2E_WRAPPED_KEY_BYTES;
const E2E_HEADER_BYTES = 1 + E2E_ENVELOPE_MAGIC.length + E2E_EPH_PUB_BYTES + E2E_PAYLOAD_IV_BYTES + 1;
const E2E_MIN_ENVELOPE_BYTES = E2E_HEADER_BYTES + E2E_SLOT_BYTES + E2E_AEAD_TAG_BYTES;
const E2E_MAX_SLOTS = 16;

const PAYLOAD_AAD_TAG = new TextEncoder().encode("veil-e2e-dm/v2-payload\n");
const SLOT_AAD_TAG = new TextEncoder().encode("veil-e2e-dm/v2-slot\n");
const SLOT_HKDF_TAG = new TextEncoder().encode("veil-e2e-dm/v2-wrap\n");

export interface VeilE2eContext {
    senderUid: string;
    recipientUid: string;
    channelId: string;
    discordMessageId?: string;
}

interface E2eSlot {
    fpr: Uint8Array;
    wrapIv: Uint8Array;
    wrapped: Uint8Array;
}

interface ParsedE2eEnvelope {
    ephPub: Uint8Array;
    payloadIv: Uint8Array;
    slots: E2eSlot[];
    payload: Uint8Array;
}

function buildE2ePayloadAad(ctx: VeilE2eContext): Uint8Array {
    const s = `${ctx.senderUid}\n${ctx.recipientUid}\n${ctx.channelId}\n${ctx.discordMessageId || ''}`;
    const body = new TextEncoder().encode(s);
    const out = new Uint8Array(PAYLOAD_AAD_TAG.length + body.length);
    out.set(PAYLOAD_AAD_TAG, 0);
    out.set(body, PAYLOAD_AAD_TAG.length);
    return out;
}

function buildE2eSlotAad(ephPub: Uint8Array, slotFpr: Uint8Array): Uint8Array {
    const out = new Uint8Array(SLOT_AAD_TAG.length + ephPub.length + slotFpr.length);
    out.set(SLOT_AAD_TAG, 0);
    out.set(ephPub, SLOT_AAD_TAG.length);
    out.set(slotFpr, SLOT_AAD_TAG.length + ephPub.length);
    return out;
}

function buildSlotHkdfInfo(ephPub: Uint8Array, slotFpr: Uint8Array): Uint8Array {
    const out = new Uint8Array(SLOT_HKDF_TAG.length + ephPub.length + slotFpr.length);
    out.set(SLOT_HKDF_TAG, 0);
    out.set(ephPub, SLOT_HKDF_TAG.length);
    out.set(slotFpr, SLOT_HKDF_TAG.length + ephPub.length);
    return out;
}

function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

async function fingerprintPubkey(ed25519PubHex: string): Promise<Uint8Array> {
    const bytes = fromHex(ed25519PubHex.toLowerCase());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return digest.slice(0, E2E_FPR_BYTES);
}

async function deriveSlotWrapKey(
    sharedSecret: Uint8Array,
    ephPub: Uint8Array,
    slotFpr: Uint8Array
): Promise<CryptoKey> {
    const baseKey = await crypto.subtle.importKey(
        "raw",
        sharedSecret as BufferSource,
        "HKDF",
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(0) as BufferSource,
            info: buildSlotHkdfInfo(ephPub, slotFpr) as BufferSource
        },
        baseKey,
        { name: "AES-GCM", length: E2E_CONTENT_KEY_BYTES * 8 },
        false,
        ["encrypt", "decrypt"]
    );
}

function parseE2eEnvelope(envelope: Uint8Array): ParsedE2eEnvelope | null {
    if (!(envelope instanceof Uint8Array)) return null;
    if (envelope.length < E2E_MIN_ENVELOPE_BYTES) return null;

    let o = 0;
    if (envelope[o++] !== E2E_ENVELOPE_VERSION) return null;
    if (envelope[o++] !== E2E_ENVELOPE_MAGIC[0]) return null;
    if (envelope[o++] !== E2E_ENVELOPE_MAGIC[1]) return null;

    const ephPub = envelope.slice(o, o + E2E_EPH_PUB_BYTES);
    o += E2E_EPH_PUB_BYTES;
    const payloadIv = envelope.slice(o, o + E2E_PAYLOAD_IV_BYTES);
    o += E2E_PAYLOAD_IV_BYTES;

    const nSlots = envelope[o++];
    if (nSlots === 0 || nSlots > E2E_MAX_SLOTS) return null;

    const slotsTotalBytes = nSlots * E2E_SLOT_BYTES;
    if (envelope.length < o + slotsTotalBytes + E2E_AEAD_TAG_BYTES) return null;

    const slots: E2eSlot[] = [];
    for (let i = 0; i < nSlots; i++) {
        const fpr = envelope.slice(o, o + E2E_FPR_BYTES);
        o += E2E_FPR_BYTES;
        const wrapIv = envelope.slice(o, o + E2E_WRAP_IV_BYTES);
        o += E2E_WRAP_IV_BYTES;
        const wrapped = envelope.slice(o, o + E2E_WRAPPED_KEY_BYTES);
        o += E2E_WRAPPED_KEY_BYTES;
        slots.push({ fpr, wrapIv, wrapped });
    }

    const payload = envelope.slice(o);
    if (payload.length < E2E_AEAD_TAG_BYTES) return null;

    return { ephPub, payloadIv, slots, payload };
}

export class CryptoService {
    private static instance: CryptoService | null = null;

    keyStorage!: KeyStorage;
    private _hasStoredKey = false;
    private _activePrivateKeyHex: string | null = null;
    private _initialized = false;
    private _initPromise: Promise<void> | null = null;
    private _passkeyRpIdOverride: string | null = null;

    constructor() {
        if (CryptoService.instance) return CryptoService.instance;
        this.keyStorage = new KeyStorage();
        CryptoService.instance = this;
        this._initPromise = this._initFromStorage();
    }

    private async _initFromStorage() {
        try {
            await ed.init();
            const vault = await this.keyStorage.getPrivateKeyVault();
            let unlocked = false;
            if (vault) {
                unlocked = await this._tryUnlockVaultFromTrustedLease(vault);
            }
            if (!unlocked) {
                await this._tryLoadAndMigrateLegacyPlaintextKey();
            }
        } catch (error) {
            console.warn("VeilCrypto: Failed to initialize key from storage", error);
        } finally {
            this._initialized = true;
        }
    }

    private async _ensureInitialized() {
        if (!this._initialized && this._initPromise) {
            await this._initPromise;
        }
    }

    setPasskeyRpIdOverride(rpId: string | null) {
        this._passkeyRpIdOverride = rpId ? String(rpId).trim().toLowerCase() || null : null;
    }

    private _resolveDefaultPasskeyRpId(): string | null {
        if (this._passkeyRpIdOverride) return this._passkeyRpIdOverride;

        const hostname = String(globalThis.location?.hostname || "").trim().toLowerCase();
        if (!hostname) return null;
        if (hostname === "localhost" || hostname === "[::1]") return null;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
        if (hostname.endsWith(".veil.rip")) return "veil.rip";
        return hostname;
    }

    private _derivePasskeyRpIdCandidates(record: any = null): (string | null)[] {
        const candidates: (string | null)[] = [];
        const seen = new Set<string>();
        const add = (value: any) => {
            if (typeof value !== "string") return;
            const normalized = value.trim().toLowerCase();
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            candidates.push(normalized);
        };
        add(record?.rpId);
        add(this._resolveDefaultPasskeyRpId());
        candidates.push(null);
        return candidates;
    }

    private async _setActivePrivateKey(privateKeyHex: string) {
        const normalized = normalizePrivateKeyHex(privateKeyHex);
        if (!isValidPrivateKeyHex(normalized)) {
            throw new Error("Invalid private key format");
        }
        this._activePrivateKeyHex = normalized;
        this._hasStoredKey = true;
        this._emitStateChange();
    }

    private async _clearActivePrivateKey() {
        this._activePrivateKeyHex = null;
        this._hasStoredKey = false;
        this._emitStateChange();
    }

    private _emitStateChange() {
        try {
            globalThis.dispatchEvent?.(new CustomEvent("veilcrypto:state-change"));
        } catch { /* ignore */ }
    }

    private async _encryptPrivateKeyForVault(privateKeyHex: string, vaultKeyBytes: Uint8Array) {
        const normalized = normalizePrivateKeyHex(privateKeyHex);
        const encoder = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
        const key = await crypto.subtle.importKey(
            "raw",
            normalizeByteArray(vaultKeyBytes) as BufferSource,
            { name: "AES-GCM" },
            false,
            ["encrypt"]
        );
        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv as BufferSource },
            key,
            encoder.encode(normalized) as BufferSource
        );
        return {
            format: "veil-key-vault",
            version: 1,
            cipher: { name: "AES-GCM", iv: bytesToBase64(iv) },
            data: bytesToBase64(new Uint8Array(encrypted)),
            updatedAt: Date.now()
        };
    }

    private async _decryptPrivateKeyFromVault(vaultPayload: any, vaultKeyBytes: Uint8Array): Promise<string> {
        if (!vaultPayload || typeof vaultPayload !== "object") throw new Error("Invalid vault payload");
        if (vaultPayload.format !== "veil-key-vault" || Number(vaultPayload.version) !== 1) {
            throw new Error("Unsupported vault format");
        }
        const ivB64 = vaultPayload?.cipher?.iv;
        const dataB64 = vaultPayload?.data;
        if (!ivB64 || !dataB64) throw new Error("Vault payload is incomplete");

        const key = await crypto.subtle.importKey(
            "raw",
            normalizeByteArray(vaultKeyBytes) as BufferSource,
            { name: "AES-GCM" },
            false,
            ["decrypt"]
        );
        let decrypted: ArrayBuffer;
        try {
            decrypted = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: base64ToBytes(ivB64) as BufferSource },
                key,
                base64ToBytes(dataB64) as BufferSource
            );
        } catch {
            throw new Error("Failed to decrypt key vault");
        }
        const privateKeyHex = new TextDecoder().decode(decrypted).trim().toLowerCase();
        if (!isValidPrivateKeyHex(privateKeyHex)) {
            throw new Error("Vault decryption produced an invalid private key");
        }
        return privateKeyHex;
    }

    private async _getOrCreateTrustedUnlockKey(): Promise<CryptoKey> {
        const existingRecord = await this.keyStorage.getTrustedUnlockKeyRecord();
        const existingKey = await this._resolveTrustedUnlockKeyFromRecord(existingRecord);
        if (existingKey) return existingKey;

        const nonExtractableKey = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        ) as CryptoKey;

        try {
            await this.keyStorage.setTrustedUnlockKeyRecord({
                key: nonExtractableKey,
                createdAt: Date.now(),
                format: "crypto-key"
            });
            return nonExtractableKey;
        } catch (error) {
            console.warn("VeilCrypto: non-extractable trusted key persistence failed, using raw-key fallback", error);
        }

        const extractableKey = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        ) as CryptoKey;
        const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", extractableKey));
        await this.keyStorage.setTrustedUnlockKeyRecord({
            rawKey: bytesToBase64(rawKey),
            createdAt: Date.now(),
            format: "raw-key"
        });
        return crypto.subtle.importKey(
            "raw",
            rawKey,
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );
    }

    private async _resolveTrustedUnlockKeyFromRecord(record: any): Promise<CryptoKey | null> {
        if (record?.key instanceof CryptoKey) return record.key;
        if (typeof record?.rawKey === "string" && record.rawKey.trim()) {
            try {
                return await crypto.subtle.importKey(
                    "raw",
                    base64ToBytes(record.rawKey) as BufferSource,
                    { name: "AES-GCM" },
                    false,
                    ["encrypt", "decrypt"]
                );
            } catch (error) {
                console.warn("VeilCrypto: failed to import raw trusted key fallback", error);
                return null;
            }
        }
        return null;
    }

    private _isTrustedUnlockStateValid(state: any): boolean {
        if (!state || typeof state !== "object") return false;
        if (state.format !== "veil-trusted-unlock" || Number(state.version) !== 1) return false;
        if (!state?.cipher?.iv || !state?.wrappedVaultKey) return false;
        return Number.isFinite(Number(state.expiresAt));
    }

    private async _buildTrustedUnlockState(vaultKeyBytes: Uint8Array, trustedKey: CryptoKey, previousState: any = null) {
        const iv = crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
        const wrappedVaultKey = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv as BufferSource },
            trustedKey,
            normalizeByteArray(vaultKeyBytes) as BufferSource
        );
        const now = Date.now();
        return {
            format: "veil-trusted-unlock",
            version: 1,
            cipher: { name: "AES-GCM", iv: bytesToBase64(iv) },
            wrappedVaultKey: bytesToBase64(new Uint8Array(wrappedVaultKey)),
            createdAt: Number(previousState?.createdAt) || now,
            lastRefreshedAt: now,
            expiresAt: now + TRUSTED_UNLOCK_LEASE_MS
        };
    }

    private async _unwrapVaultKeyFromTrustedState(trustedState: any, trustedKey: CryptoKey): Promise<Uint8Array> {
        const unwrapped = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: base64ToBytes(trustedState.cipher.iv) as BufferSource },
            trustedKey,
            base64ToBytes(trustedState.wrappedVaultKey) as BufferSource
        );
        return new Uint8Array(unwrapped);
    }

    private async _unlockVaultWithTrustedMaterial(vaultPayload: any, trustedState: any, trustedKey: CryptoKey, { refreshLease = true } = {}) {
        const vaultKeyBytes = await this._unwrapVaultKeyFromTrustedState(trustedState, trustedKey);
        const privateKeyHex = await this._decryptPrivateKeyFromVault(vaultPayload, vaultKeyBytes);
        await this._setActivePrivateKey(privateKeyHex);
        if (refreshLease) {
            const refreshedState = await this._buildTrustedUnlockState(vaultKeyBytes, trustedKey, trustedState);
            await this.keyStorage.setTrustedUnlockState(refreshedState);
        }
    }

    private async _persistPrivateKeySecurely(privateKeyHex: string, { setActive = true } = {}) {
        const normalized = normalizePrivateKeyHex(privateKeyHex);
        if (!isValidPrivateKeyHex(normalized)) {
            throw new Error("Invalid private key format");
        }
        const vaultKeyBytes = crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES));
        const vaultPayload = await this._encryptPrivateKeyForVault(normalized, vaultKeyBytes);
        const trustedKey = await this._getOrCreateTrustedUnlockKey();
        const trustedState = await this._buildTrustedUnlockState(vaultKeyBytes, trustedKey);
        await this.keyStorage.setPrivateKeyVault(vaultPayload);
        await this.keyStorage.setTrustedUnlockState(trustedState);
        await this.keyStorage.clearPrivateKey();
        if (setActive) await this._setActivePrivateKey(normalized);
    }

    private async _tryUnlockVaultFromTrustedLease(vaultPayload: any): Promise<boolean> {
        const trustedState = await this.keyStorage.getTrustedUnlockState();
        const trustedKeyRecord = await this.keyStorage.getTrustedUnlockKeyRecord();
        const trustedKey = await this._resolveTrustedUnlockKeyFromRecord(trustedKeyRecord);
        if (!this._isTrustedUnlockStateValid(trustedState) || !trustedKey) return false;
        if (Number(trustedState.expiresAt) <= Date.now()) return false;
        try {
            await this._unlockVaultWithTrustedMaterial(vaultPayload, trustedState, trustedKey, { refreshLease: true });
            return true;
        } catch (error) {
            console.warn("VeilCrypto: trusted lease unlock failed", error);
            return false;
        }
    }

    private async _verifyPasskeyRecord(record: any): Promise<boolean> {
        if (!record?.id) return false;
        const expectedId = String(record.id || "").trim();
        if (!expectedId) return false;

        const knownCredentialIds = new Set<string>([expectedId]);
        if (Array.isArray(record?.legacyIds)) {
            for (const legacyId of record.legacyIds) {
                if (typeof legacyId !== "string") continue;
                const normalized = legacyId.trim();
                if (!normalized) continue;
                knownCredentialIds.add(normalized);
            }
        }

        let allowCredentials: PublicKeyCredentialDescriptor[] = [];
        try {
            allowCredentials = Array.from(knownCredentialIds, id => ({
                type: "public-key" as const,
                id: base64ToBytes(id) as BufferSource
            }));
        } catch {
            allowCredentials = [];
        }

        const expectedUserHandle = (typeof record?.userHandle === "string" && record.userHandle.trim())
            ? record.userHandle.trim()
            : null;

        const requestAssertion = async (publicKeyOptions: PublicKeyCredentialRequestOptions) => {
            const assertion = await navigator.credentials.get({ publicKey: publicKeyOptions });
            if (!(assertion instanceof PublicKeyCredential)) return null;
            const assertionId = bytesToBase64(new Uint8Array(assertion.rawId));
            const response = assertion.response as AuthenticatorAssertionResponse;
            const responseUserHandle = response?.userHandle
                ? bytesToBase64(new Uint8Array(response.userHandle))
                : null;
            return { assertionId, responseUserHandle };
        };

        const maybePersistRotatedCredentialId = async (assertionId: string) => {
            if (!assertionId || knownCredentialIds.has(assertionId)) return;
            const legacyIds = Array.from(knownCredentialIds).filter(id => id !== assertionId);
            await this.keyStorage.setPasskeyCredential({
                ...record,
                id: assertionId,
                legacyIds: legacyIds.slice(0, 3),
                updatedAt: Date.now()
            });
        };

        const assertionMatches = async (assertionResult: { assertionId: string; responseUserHandle: string | null; } | null) => {
            if (!assertionResult?.assertionId) return false;
            if (knownCredentialIds.has(assertionResult.assertionId)) return true;
            if (expectedUserHandle && assertionResult.responseUserHandle === expectedUserHandle) {
                await maybePersistRotatedCredentialId(assertionResult.assertionId);
                return true;
            }
            return false;
        };

        const rpCandidates = this._derivePasskeyRpIdCandidates(record);

        if (allowCredentials.length > 0) {
            for (const rpId of rpCandidates) {
                try {
                    const assertion = await requestAssertion({
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        allowCredentials,
                        timeout: 60_000,
                        userVerification: "required",
                        ...(rpId ? { rpId } : {})
                    });
                    if (await assertionMatches(assertion)) return true;
                } catch (error: any) {
                    if (error?.name === "NotAllowedError") continue;
                    if (error?.name === "SecurityError" || error?.name === "InvalidStateError" || error?.name === "TypeError") continue;
                    throw new Error(error?.message || "Failed to verify passkey");
                }
            }
        }

        for (const rpId of rpCandidates) {
            try {
                const assertion = await requestAssertion({
                    challenge: crypto.getRandomValues(new Uint8Array(32)),
                    timeout: 60_000,
                    userVerification: "required",
                    ...(rpId ? { rpId } : {})
                });
                if (await assertionMatches(assertion)) return true;
            } catch (error: any) {
                if (error?.name === "NotAllowedError") continue;
                if (error?.name === "SecurityError" || error?.name === "InvalidStateError" || error?.name === "TypeError") continue;
                throw new Error(error?.message || "Failed to verify passkey");
            }
        }

        return false;
    }

    private async _tryUnlockVaultWithPasskey(vaultPayload: any): Promise<boolean> {
        if (!this.supportsLocalPasskey()) return false;
        const passkeyRecord = await this.keyStorage.getPasskeyCredential();
        if (!passkeyRecord?.id) return false;
        const trustedState = await this.keyStorage.getTrustedUnlockState();
        const trustedKeyRecord = await this.keyStorage.getTrustedUnlockKeyRecord();
        const trustedKey = await this._resolveTrustedUnlockKeyFromRecord(trustedKeyRecord);
        if (!this._isTrustedUnlockStateValid(trustedState) || !trustedKey) return false;
        const verified = await this._verifyPasskeyRecord(passkeyRecord);
        if (!verified) return false;
        try {
            await this._unlockVaultWithTrustedMaterial(vaultPayload, trustedState, trustedKey, { refreshLease: true });
            return true;
        } catch (error) {
            console.warn("VeilCrypto: passkey unlock failed", error);
            return false;
        }
    }

    private async _tryLoadAndMigrateLegacyPlaintextKey(): Promise<boolean> {
        const legacyKey = await this.keyStorage.getPrivateKey();
        if (!isValidPrivateKeyHex(legacyKey)) return false;
        const normalized = normalizePrivateKeyHex(legacyKey);
        await this._setActivePrivateKey(normalized);
        try {
            await this._persistPrivateKeySecurely(normalized, { setActive: false });
        } catch (error) {
            console.warn("VeilCrypto: plaintext key migration failed", error);
        }
        return true;
    }

    // --- Public API ---

    async hasStoredKey(): Promise<boolean> {
        await this._ensureInitialized();
        return this._hasStoredKey;
    }

    async hasAnyLinkedKey(): Promise<boolean> {
        await this._ensureInitialized();
        if (this._hasStoredKey) return true;
        const vault = await this.keyStorage.getPrivateKeyVault();
        return Boolean(vault);
    }

    async setPrivateKey(privateKeyHex: string): Promise<string> {
        await this._ensureInitialized();
        if (this._hasStoredKey) return this.getPublicKey();
        await this._persistPrivateKeySecurely(privateKeyHex, { setActive: true });
        return this.getPublicKey();
    }

    async generateKeys(): Promise<{ publicKey: string; privateKey: string | null; }> {
        await this._ensureInitialized();
        if (this._hasStoredKey) {
            const existingPublicKey = await this.getPublicKey();
            return { publicKey: existingPublicKey, privateKey: null };
        }
        const privateKey = await ed.generatePrivateKey();
        const publicKey = await ed.getPublicKey(privateKey);
        await this._persistPrivateKeySecurely(privateKey, { setActive: true });
        return { publicKey, privateKey };
    }

    async getPublicKey(): Promise<string> {
        await this._ensureInitialized();
        if (!this._hasStoredKey || !this._activePrivateKeyHex) {
            throw new Error("Private key not available");
        }
        return ed.getPublicKey(this._activePrivateKeyHex);
    }

    async sign(message: string | Uint8Array): Promise<string> {
        await this._ensureInitialized();
        if (!this._hasStoredKey || !this._activePrivateKeyHex) {
            throw new Error("Private key not available");
        }
        return ed.sign(this._activePrivateKeyHex, message);
    }

    async verify(message: string | Uint8Array, signature: string, publicKey: string): Promise<boolean> {
        await this._ensureInitialized();
        return ed.verify(message, signature, publicKey);
    }

    async clearStoredKey(): Promise<void> {
        await this.keyStorage.clearPrivateKey();
        await this.keyStorage.clearPrivateKeyVault();
        await this.keyStorage.clearTrustedUnlockState();
        await this.keyStorage.clearTrustedUnlockKeyRecord();
        await this.keyStorage.clearPasskeyCredential();
        await this.keyStorage.clearUserData();
        await this._clearActivePrivateKey();
    }

    getUserData() { return this.keyStorage.getUserData(); }
    setUserData(userData: any) { return this.keyStorage.setUserData(userData); }

    async isLoggedIn(): Promise<boolean> {
        await this._ensureInitialized();
        if (!this._hasStoredKey) return false;
        const userData = await this.keyStorage.getUserData();
        return userData !== null;
    }

    async forceSetPrivateKey(privateKeyHex: string): Promise<string> {
        await this._ensureInitialized();
        await this._persistPrivateKeySecurely(privateKeyHex, { setActive: true });
        return this.getPublicKey();
    }

    async setEphemeralPrivateKey(privateKeyHex: string): Promise<string> {
        await this._ensureInitialized();
        await this._setActivePrivateKey(privateKeyHex);
        return this.getPublicKey();
    }

    async clearActivePrivateKeyOnly(): Promise<void> {
        await this._clearActivePrivateKey();
    }

    supportsLocalPasskey(): boolean {
        return Boolean(
            globalThis.isSecureContext &&
            (globalThis as any).PublicKeyCredential &&
            navigator?.credentials &&
            typeof navigator.credentials.create === "function" &&
            typeof navigator.credentials.get === "function"
        );
    }

    async getPasskeyEnrollmentState() {
        const supported = this.supportsLocalPasskey();
        if (!supported) {
            return {
                supported: false,
                enrolled: false,
                trustedLeaseActive: false,
                trustedLeaseExpiresAt: null,
                hasEncryptedVault: false,
                passkeyLoginAvailable: false
            };
        }
        const credential = await this.keyStorage.getPasskeyCredential();
        const vault = await this.keyStorage.getPrivateKeyVault();
        const trustedState = await this.keyStorage.getTrustedUnlockState();
        const trustedKeyRecord = await this.keyStorage.getTrustedUnlockKeyRecord();
        const trustedKey = await this._resolveTrustedUnlockKeyFromRecord(trustedKeyRecord);
        const expiresAt = Number(trustedState?.expiresAt);
        const trustedLeaseActive = Number.isFinite(expiresAt) && expiresAt > Date.now();
        const hasEncryptedVault = Boolean(vault);
        const enrolled = Boolean(credential?.id);
        const passkeyLoginAvailable = enrolled
            && hasEncryptedVault
            && this._isTrustedUnlockStateValid(trustedState)
            && Boolean(trustedKey);
        return {
            supported: true,
            enrolled,
            trustedLeaseActive,
            trustedLeaseExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
            hasEncryptedVault,
            passkeyLoginAvailable
        };
    }

    async enrollLocalPasskey({ username = "", userId = "", uid = "" }: { username?: string; userId?: string; uid?: string; } = {}) {
        await this._ensureInitialized();
        if (!this.supportsLocalPasskey()) throw new Error("Passkeys are not available in this browser");
        if (!this._hasStoredKey) throw new Error("You must be authenticated before enrolling a passkey");

        const effectiveUserId = String(userId || uid || "").trim() || await this.getPublicKey();
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(effectiveUserId));
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const userHandle = new Uint8Array(digest);
        const displayName = String(username || effectiveUserId).slice(0, 64);
        const name = String(username || effectiveUserId || "veil-user").slice(0, 64);
        const rpId = this._resolveDefaultPasskeyRpId();

        let credential: Credential | null;
        try {
            credential = await navigator.credentials.create({
                publicKey: {
                    challenge,
                    rp: rpId ? { name: "Veil", id: rpId } : { name: "Veil" },
                    user: { id: userHandle, name, displayName },
                    pubKeyCredParams: [
                        { type: "public-key", alg: -7 },
                        { type: "public-key", alg: -257 }
                    ],
                    authenticatorSelection: {
                        residentKey: "required",
                        requireResidentKey: true,
                        userVerification: "required"
                    },
                    timeout: 60_000,
                    attestation: "none"
                }
            });
        } catch (error: any) {
            if (error?.name === "NotAllowedError") throw new Error("Passkey enrollment was cancelled");
            throw new Error(error?.message || "Failed to enroll passkey");
        }

        if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey enrollment failed");

        const response = credential.response as AuthenticatorAttestationResponse;
        const transports = (typeof response?.getTransports === "function")
            ? response.getTransports()
            : [];
        const credentialId = bytesToBase64(new Uint8Array(credential.rawId));

        const record = {
            id: credentialId,
            transports: Array.isArray(transports) ? transports : [],
            rpId: rpId || null,
            userHandle: bytesToBase64(userHandle),
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await this.keyStorage.setPasskeyCredential(record);
        return record;
    }

    async verifyEnrolledPasskey(): Promise<boolean> {
        await this._ensureInitialized();
        if (!this.supportsLocalPasskey()) throw new Error("Passkeys are not available in this browser");
        const record = await this.keyStorage.getPasskeyCredential();
        if (!record?.id) throw new Error("No passkey is enrolled");
        return this._verifyPasskeyRecord(record);
    }

    async unlockWithEnrolledPasskey(): Promise<boolean> {
        await this._ensureInitialized();
        if (this._hasStoredKey) return true;
        if (!this.supportsLocalPasskey()) throw new Error("Passkeys are not available in this browser");
        const record = await this.keyStorage.getPasskeyCredential();
        if (!record?.id) throw new Error("No passkey is enrolled");
        const vaultPayload = await this.keyStorage.getPrivateKeyVault();
        if (!vaultPayload) throw new Error("No encrypted key vault found");
        const unlocked = await this._tryUnlockVaultWithPasskey(vaultPayload);
        if (!unlocked) throw new Error("Passkey verification was cancelled or failed");
        return true;
    }

    async clearPasskeyEnrollment(): Promise<void> {
        await this.keyStorage.clearPasskeyCredential();
    }

    async createEncryptedPrivateKeyBackup(password: string) {
        await this._ensureInitialized();
        if (!password || typeof password !== "string") throw new Error("Password is required");
        const privateKeyHex = this._activePrivateKeyHex;
        if (!privateKeyHex) throw new Error("No private key found for this session");

        const userData = await this.keyStorage.getUserData();
        const exportTimestamp = new Date().toISOString();
        const backupPlaintext = JSON.stringify({
            privateKey: privateKeyHex,
            publicKey: userData?.pubkey || null,
            uid: userData?.uid || null,
            exportedAt: exportTimestamp,
            app: "veil"
        });

        const encoder = new TextEncoder();
        const salt = crypto.getRandomValues(new Uint8Array(BACKUP_SALT_BYTES));
        const iv = crypto.getRandomValues(new Uint8Array(BACKUP_IV_BYTES));
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            encoder.encode(password),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        const aesKey = await crypto.subtle.deriveKey(
            { name: "PBKDF2", hash: "SHA-256", salt, iterations: BACKUP_KDF_ITERATIONS },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt"]
        );
        const encryptedBytes = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            aesKey,
            encoder.encode(backupPlaintext)
        );

        return {
            format: "veil-key-backup",
            version: 2,
            exportedAt: exportTimestamp,
            kdf: { name: "PBKDF2", hash: "SHA-256", iterations: BACKUP_KDF_ITERATIONS, salt: bytesToBase64(salt) },
            cipher: { name: "AES-GCM", iv: bytesToBase64(iv) },
            data: bytesToBase64(new Uint8Array(encryptedBytes)),
            metadata: { uid: userData?.uid || null, publicKey: userData?.pubkey || null }
        };
    }

    async decryptEncryptedPrivateKeyBackup(backupPayload: any, password: string) {
        if (!password || typeof password !== "string") throw new Error("Password is required");
        const payload = typeof backupPayload === "string" ? JSON.parse(backupPayload) : backupPayload;
        if (!payload || typeof payload !== "object") throw new Error("Invalid backup format");
        if (payload.format !== "veil-key-backup" || ![1, 2].includes(payload.version)) throw new Error("Unsupported backup format");

        const iterations = Number(payload?.kdf?.iterations);
        const saltB64 = payload?.kdf?.salt;
        const ivB64 = payload?.cipher?.iv;
        const dataB64 = payload?.data;
        if (!iterations || !saltB64 || !ivB64 || !dataB64) throw new Error("Backup payload is incomplete");

        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            encoder.encode(password) as BufferSource,
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        const aesKey = await crypto.subtle.deriveKey(
            { name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(saltB64) as BufferSource, iterations },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["decrypt"]
        );

        let decryptedText: string;
        try {
            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: base64ToBytes(ivB64) as BufferSource },
                aesKey,
                base64ToBytes(dataB64) as BufferSource
            );
            decryptedText = new TextDecoder().decode(decryptedBuffer);
        } catch {
            throw new Error("Failed to decrypt backup: incorrect password or corrupted data");
        }

        const decrypted = JSON.parse(decryptedText);
        const privateKey = decrypted?.privateKey;
        if (!privateKey || !/^[0-9a-fA-F]{64}$/.test(privateKey)) {
            throw new Error("Decrypted backup does not contain a valid private key");
        }
        return {
            privateKey: privateKey.toLowerCase(),
            publicKey: decrypted?.publicKey || null,
            uid: decrypted?.uid || null
        };
    }

    /**
     * Encrypt `plaintext` to one or more Ed25519 recipients. In a 1:1
     * DM the caller passes `[theirPubHex, ourPubHex]` so both parties
     * can decrypt later (the sender reads their own messages on echo
     * and across reloads via the same code path the recipient uses).
     *
     * Layout: a fresh ephemeral X25519 keypair is generated; a random
     * 16-byte content key K encrypts the plaintext under AES-128-GCM
     * with AAD bound to `senderUid || recipientUid || channelId`; for
     * every recipient pubkey we attach a slot that wraps K with a key
     * derived via `HKDF(ECDH(eph_priv, slot_static_pub))`. Slots are
     * deduped by fingerprint so passing `[A, A]` produces a single
     * slot.
     */
    async encryptForRecipients(
        recipientEd25519PubHexes: string[],
        plaintext: string,
        ctx: VeilE2eContext
    ): Promise<Uint8Array> {
        await this._ensureInitialized();
        if (!(await isX25519Available())) {
            throw new Error("This Discord build doesn't support X25519 end-to-end crypto.");
        }
        if (!Array.isArray(recipientEd25519PubHexes) || recipientEd25519PubHexes.length === 0) {
            throw new Error("Need at least one recipient public key");
        }

        // Dedupe by fingerprint (catches `[recipient, ourselves]` when
        // the active key happens to also be the recipient, and the
        // hypothetical note-to-self DM).
        const slotInputs: { fpr: Uint8Array; pubHex: string; }[] = [];
        const seenFpr = new Set<string>();
        for (const pub of recipientEd25519PubHexes) {
            if (typeof pub !== "string" || !pub) continue;
            const fpr = await fingerprintPubkey(pub);
            const fprKey = bytesToBase64(fpr);
            if (seenFpr.has(fprKey)) continue;
            seenFpr.add(fprKey);
            slotInputs.push({ fpr, pubHex: pub });
        }
        if (slotInputs.length === 0) throw new Error("No valid recipient public keys");
        if (slotInputs.length > E2E_MAX_SLOTS) {
            throw new Error(`Too many recipients (max ${E2E_MAX_SLOTS})`);
        }

        const { privSeed: ephPriv, rawPub: ephPub } = await generateEphemeralX25519();

        const contentKeyBytes = crypto.getRandomValues(new Uint8Array(E2E_CONTENT_KEY_BYTES));
        const contentKey = await crypto.subtle.importKey(
            "raw",
            contentKeyBytes as BufferSource,
            { name: "AES-GCM", length: E2E_CONTENT_KEY_BYTES * 8 },
            false,
            ["encrypt"]
        );

        const payloadAad = buildE2ePayloadAad(ctx);
        const payloadIv = crypto.getRandomValues(new Uint8Array(E2E_PAYLOAD_IV_BYTES));
        const ciphertextAndTag = new Uint8Array(await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: payloadIv as BufferSource, additionalData: payloadAad as BufferSource },
            contentKey,
            new TextEncoder().encode(plaintext) as BufferSource
        ));

        const wrappedSlots: Uint8Array[] = [];
        for (const { fpr, pubHex } of slotInputs) {
            const recipientX25519Pub = ed25519PubToX25519(pubHex);
            const sharedSecret = await deriveSharedBits(ephPriv, recipientX25519Pub);
            const wrapKey = await deriveSlotWrapKey(sharedSecret, ephPub, fpr);
            const wrapIv = crypto.getRandomValues(new Uint8Array(E2E_WRAP_IV_BYTES));
            const wrapAad = buildE2eSlotAad(ephPub, fpr);
            const wrapped = new Uint8Array(await crypto.subtle.encrypt(
                { name: "AES-GCM", iv: wrapIv as BufferSource, additionalData: wrapAad as BufferSource },
                wrapKey,
                contentKeyBytes as BufferSource
            ));
            const slot = new Uint8Array(E2E_SLOT_BYTES);
            let so = 0;
            slot.set(fpr, so); so += E2E_FPR_BYTES;
            slot.set(wrapIv, so); so += E2E_WRAP_IV_BYTES;
            slot.set(wrapped, so);
            wrappedSlots.push(slot);
        }

        const envelopeSize = E2E_HEADER_BYTES + wrappedSlots.length * E2E_SLOT_BYTES + ciphertextAndTag.length;
        const envelope = new Uint8Array(envelopeSize);
        let o = 0;
        envelope[o++] = E2E_ENVELOPE_VERSION;
        envelope.set(E2E_ENVELOPE_MAGIC, o); o += E2E_ENVELOPE_MAGIC.length;
        envelope.set(ephPub, o); o += E2E_EPH_PUB_BYTES;
        envelope.set(payloadIv, o); o += E2E_PAYLOAD_IV_BYTES;
        envelope[o++] = wrappedSlots.length;
        for (const slot of wrappedSlots) {
            envelope.set(slot, o); o += E2E_SLOT_BYTES;
        }
        envelope.set(ciphertextAndTag, o);

        return envelope;
    }

    /**
     * Try to decrypt an E2E envelope with the current active private
     * key. Returns the plaintext on success, or `null` for any failure
     * mode (no slot for our key, bad magic, tampered ciphertext, locked
     * vault). Never throws — the receiver decorator runs this on every
     * candidate message and a throw would poison the message list.
     */
    async tryDecryptFromSender(
        envelope: Uint8Array,
        ctx: VeilE2eContext
    ): Promise<string | null> {
        try {
            await this._ensureInitialized();
            if (!this._activePrivateKeyHex) return null;
            if (!(await isX25519Available())) return null;

            const parsed = parseE2eEnvelope(envelope);
            if (!parsed) return null;

            const ourPub = await this.getPublicKey();
            const ourFpr = await fingerprintPubkey(ourPub);
            const matchingSlot = parsed.slots.find(slot => bytesEqualConstantTime(slot.fpr, ourFpr));
            if (!matchingSlot) return null;

            const myX25519Priv = await ed25519PrivToX25519(this._activePrivateKeyHex);
            const sharedSecret = await deriveSharedBits(myX25519Priv, parsed.ephPub);
            const wrapKey = await deriveSlotWrapKey(sharedSecret, parsed.ephPub, matchingSlot.fpr);
            const wrapAad = buildE2eSlotAad(parsed.ephPub, matchingSlot.fpr);

            const contentKeyBytes = new Uint8Array(await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: matchingSlot.wrapIv as BufferSource, additionalData: wrapAad as BufferSource },
                wrapKey,
                matchingSlot.wrapped as BufferSource
            ));
            if (contentKeyBytes.length !== E2E_CONTENT_KEY_BYTES) return null;

            const contentKey = await crypto.subtle.importKey(
                "raw",
                contentKeyBytes as BufferSource,
                { name: "AES-GCM", length: E2E_CONTENT_KEY_BYTES * 8 },
                false,
                ["decrypt"]
            );

            const payloadAad = buildE2ePayloadAad(ctx);
            const plainBytes = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: parsed.payloadIv as BufferSource, additionalData: payloadAad as BufferSource },
                contentKey,
                parsed.payload as BufferSource
            );
            return new TextDecoder().decode(plainBytes);
        } catch {
            return null;
        }
    }

    /**
     * Cheap pre-check used by the receiver decoration before it tries
     * to decrypt: returns true if any slot in the envelope is addressed
     * to the fingerprint of our current public key.
     */
    async isEnvelopeAddressedToUs(envelope: Uint8Array): Promise<boolean> {
        try {
            await this._ensureInitialized();
            if (!this._activePrivateKeyHex) return false;
            const parsed = parseE2eEnvelope(envelope);
            if (!parsed) return false;
            const ourPub = await this.getPublicKey();
            const ourFpr = await fingerprintPubkey(ourPub);
            return parsed.slots.some(slot => bytesEqualConstantTime(slot.fpr, ourFpr));
        } catch {
            return false;
        }
    }

    /**
     * Encrypt a raw attachment blob with a fresh AES-GCM-256 key. The
     * returned `key` and `iv` travel inside the multi-recipient content
     * envelope (as part of the JSON manifest) so only intended recipients
     * can decrypt the bytes. The ciphertext is what gets uploaded to
     * Discord's CDN.
     */
    async encryptAttachmentBytes(plaintextBytes: Uint8Array): Promise<{
        ciphertext: Uint8Array;
        key: Uint8Array;
        iv: Uint8Array;
    }> {
        const key = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const aesKey = await crypto.subtle.importKey(
            "raw",
            key as BufferSource,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt"]
        );
        const ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv as BufferSource },
            aesKey,
            plaintextBytes as BufferSource
        ));
        return { ciphertext: ct, key, iv };
    }

    /**
     * Decrypt an attachment blob with the per-attachment key and IV the
     * sender packed into the message manifest.
     */
    async decryptAttachmentBytes(
        ciphertext: Uint8Array,
        key: Uint8Array,
        iv: Uint8Array
    ): Promise<Uint8Array> {
        const aesKey = await crypto.subtle.importKey(
            "raw",
            key as BufferSource,
            { name: "AES-GCM", length: 256 },
            false,
            ["decrypt"]
        );
        return new Uint8Array(await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv as BufferSource },
            aesKey,
            ciphertext as BufferSource
        ));
    }

    /**
     * SHA-256 of arbitrary bytes, returned as a lowercase hex string.
     * Used by the signed-message flow to bind attachments to the
     * signature canonical body.
     */
    async sha256Hex(bytes: Uint8Array): Promise<string> {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
        let s = "";
        for (let i = 0; i < digest.length; i++) s += digest[i].toString(16).padStart(2, "0");
        return s;
    }
}

export const cryptoService = new CryptoService();
