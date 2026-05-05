/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    DB_NAME,
    DB_VERSION,
    PASSKEY_CREDENTIAL_ID,
    PRIVATE_KEY_ID,
    PRIVATE_KEY_VAULT_ID,
    STORE_NAME,
    TRUSTED_UNLOCK_KEY_ID,
    TRUSTED_UNLOCK_STATE_ID,
    USER_DATA_ID,
    USER_STORE_NAME
} from "./utils";

export class KeyStorage {
    private dbPromise: Promise<IDBDatabase>;

    constructor() {
        this.dbPromise = this._openDB();
    }

    private _openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = event => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains(USER_STORE_NAME)) {
                    db.createObjectStore(USER_STORE_NAME, { keyPath: "id" });
                }
            };
        });
    }

    private async _getKeyRecord(id: string): Promise<any> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(id);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result?.value ?? null);
        });
    }

    private async _setKeyRecord(id: string, value: any): Promise<void> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put({ id, value });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    private async _deleteKeyRecord(id: string): Promise<void> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    getPrivateKey() { return this._getKeyRecord(PRIVATE_KEY_ID); }
    setPrivateKey(privateKeyHex: string) { return this._setKeyRecord(PRIVATE_KEY_ID, privateKeyHex); }
    async hasPrivateKey() { return (await this.getPrivateKey()) !== null; }
    clearPrivateKey() { return this._deleteKeyRecord(PRIVATE_KEY_ID); }

    getPrivateKeyVault() { return this._getKeyRecord(PRIVATE_KEY_VAULT_ID); }
    setPrivateKeyVault(vaultPayload: any) { return this._setKeyRecord(PRIVATE_KEY_VAULT_ID, vaultPayload); }
    clearPrivateKeyVault() { return this._deleteKeyRecord(PRIVATE_KEY_VAULT_ID); }

    getTrustedUnlockKeyRecord() { return this._getKeyRecord(TRUSTED_UNLOCK_KEY_ID); }
    setTrustedUnlockKeyRecord(record: any) { return this._setKeyRecord(TRUSTED_UNLOCK_KEY_ID, record); }
    clearTrustedUnlockKeyRecord() { return this._deleteKeyRecord(TRUSTED_UNLOCK_KEY_ID); }

    getTrustedUnlockState() { return this._getKeyRecord(TRUSTED_UNLOCK_STATE_ID); }
    setTrustedUnlockState(state: any) { return this._setKeyRecord(TRUSTED_UNLOCK_STATE_ID, state); }
    clearTrustedUnlockState() { return this._deleteKeyRecord(TRUSTED_UNLOCK_STATE_ID); }

    getPasskeyCredential() { return this._getKeyRecord(PASSKEY_CREDENTIAL_ID); }
    setPasskeyCredential(record: any) { return this._setKeyRecord(PASSKEY_CREDENTIAL_ID, record); }
    clearPasskeyCredential() { return this._deleteKeyRecord(PASSKEY_CREDENTIAL_ID); }

    async getUserData(): Promise<any> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(USER_STORE_NAME, "readonly");
            const store = transaction.objectStore(USER_STORE_NAME);
            const request = store.get(USER_DATA_ID);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result?.value || null);
        });
    }

    async setUserData(userData: any): Promise<void> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(USER_STORE_NAME, "readwrite");
            const store = transaction.objectStore(USER_STORE_NAME);
            const request = store.put({ id: USER_DATA_ID, value: userData });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    async clearUserData(): Promise<void> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(USER_STORE_NAME, "readwrite");
            const store = transaction.objectStore(USER_STORE_NAME);
            const request = store.delete(USER_DATA_ID);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }
}
