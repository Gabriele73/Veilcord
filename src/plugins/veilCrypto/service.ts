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
    isValidPrivateKeyHex,
    normalizeByteArray,
    normalizePrivateKeyHex,
    TRUSTED_UNLOCK_LEASE_MS,
    VAULT_IV_BYTES,
    VAULT_KEY_BYTES
} from "./utils";

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
            version: 1,
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
        if (payload.format !== "veil-key-backup" || payload.version !== 1) throw new Error("Unsupported backup format");

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
}

export const cryptoService = new CryptoService();
