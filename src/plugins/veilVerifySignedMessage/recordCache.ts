/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Persistent (IndexedDB) cache for signed-message backend lookups.
 *
 * The backend record for a Discord message id is immutable once
 * inserted. Caching it on disk lets us skip the network round-trip
 * on every channel re-mount, scrollback, or session restart. The
 * in-memory `flairCache` in Decoration.tsx still owns the derived
 * verification state — this layer only memoizes the raw fetched
 * record (or the "missing" verdict) so we don't hammer the backend
 * for each message we render.
 *
 * Stored value shape:
 *   - { kind: "hit", record: any, fetchedAt: number }
 *     fetched-at is stamped, but `record` itself is treated as
 *     immutable, so a hit never expires.
 *   - { kind: "miss", fetchedAt: number }
 *     a 404 response. Short TTL (MISS_TTL_MS) so a record that
 *     lands later eventually shows up.
 */

const DB_NAME = "veil-signed-message-cache";
const DB_VERSION = 1;
const STORE_NAME = "records";

const MISS_TTL_MS = 5 * 60 * 1000;

type CachedHit = { kind: "hit"; record: any; fetchedAt: number; };
type CachedMiss = { kind: "miss"; fetchedAt: number; };
type Cached = CachedHit | CachedMiss;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase | null>(resolve => {
        try {
            if (typeof indexedDB === "undefined") return resolve(null);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: "id" });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    return dbPromise;
}

function withStore<T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
    return openDb().then(db => {
        if (!db) return null;
        return new Promise<T | null>(resolve => {
            try {
                const tx = db.transaction(STORE_NAME, mode);
                const store = tx.objectStore(STORE_NAME);
                const req = op(store);
                req.onsuccess = () => resolve(req.result ?? null);
                req.onerror = () => resolve(null);
                tx.onabort = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    });
}

/**
 * Look up a cached entry. Hits are returned forever (records are
 * immutable). Misses are returned only within MISS_TTL_MS so a
 * record that arrives late can still surface.
 */
export async function readRecord(discordMessageId: string): Promise<Cached | null> {
    const row = await withStore<any>("readonly", store => store.get(discordMessageId));
    if (!row || typeof row !== "object") return null;
    if (row.kind === "hit" && row.record != null) {
        return { kind: "hit", record: row.record, fetchedAt: Number(row.fetchedAt) || 0 };
    }
    if (row.kind === "miss") {
        const fetchedAt = Number(row.fetchedAt) || 0;
        if (Date.now() - fetchedAt < MISS_TTL_MS) {
            return { kind: "miss", fetchedAt };
        }
    }
    return null;
}

export async function writeHit(discordMessageId: string, record: any): Promise<void> {
    await withStore<IDBValidKey>("readwrite", store =>
        store.put({ id: discordMessageId, kind: "hit", record, fetchedAt: Date.now() })
    );
}

export async function writeMiss(discordMessageId: string): Promise<void> {
    await withStore<IDBValidKey>("readwrite", store =>
        store.put({ id: discordMessageId, kind: "miss", fetchedAt: Date.now() })
    );
}

/**
 * Drop a single id from the cache. Used after the sender's own
 * MESSAGE_CREATE registers a fresh signature so any prior `miss`
 * entry can't pin the badge as `unverified`.
 */
export async function invalidate(discordMessageId: string): Promise<void> {
    await withStore<undefined>("readwrite", store => store.delete(discordMessageId));
}
