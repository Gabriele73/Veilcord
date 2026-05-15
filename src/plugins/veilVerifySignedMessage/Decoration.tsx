/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CanonicalAttachment, cryptoService, isBindingActiveAt, veilApiBase, VeilSignedBody } from "@plugins/veilCrypto";
import { openModal } from "@utils/modal";
import { PluginNative } from "@utils/types";
import { FluxDispatcher, MessageStore, ReactDOM, useEffect, useLayoutEffect, useRef, useState, useStateFromStores } from "@webpack/common";

import { stripZwc } from "./parser";
import * as recordCache from "./recordCache";
import { VerifyModal } from "./VerifyModal";

const Native = VencordNative.pluginHelpers.VeilVerifySignedMessage as PluginNative<typeof import("./native")>;

type FlairState = "loading" | "verified" | "signed" | "invalid" | "unverified";

/**
 * Derived verification state cache keyed by `lookupKey(input)`.
 *
 * `verified` and `invalid` are stable: a signed-message record never mutates,
 * and a binding's history is append-only, so once we've confirmed the
 * (uid, pubkey) was bound at the message's createdAt that fact can't be
 * revoked retroactively.
 *
 * `signed` may upgrade to `verified` if the user links their key after the
 * message was sent — revalidate after `SIGNED_REVALIDATE_AFTER_MS`.
 *
 * `unverified` is a soft state: maybe the sender's POST landed late, maybe
 * the marker is fake. Revalidate after `UNVERIFIED_REVALIDATE_AFTER_MS` so
 * we don't hammer the backend.
 */
const flairCache = new Map<string, { state: FlairState; ts: number; }>();
const inflight = new Map<string, Promise<FlairState>>();

const SIGNED_REVALIDATE_AFTER_MS = 5 * 60 * 1000;
const UNVERIFIED_REVALIDATE_AFTER_MS = 60 * 1000;

/** Backoff schedule (ms from start) for the live single-id retry path. */
const FETCH_RETRY_DELAYS_MS = [0, 1500, 4000, 9000, 18000];

/** How long a channel pre-fetch is considered fresh before we re-fetch. */
const CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Custom event dispatched by the signer plugin when its backend POST succeeds,
 * so any mounted decoration for that Discord message id can immediately
 * re-fetch and flip to its real state.
 */
const REGISTERED_EVENT = "veil:signed-message:registered";

/**
 * Channel-scoped record cache. When a chat is opened we batch-fetch
 * every signed record for that channel in one HTTP call; that result
 * (and any subsequent single-id fetches triggered by MESSAGE_CREATE
 * or REGISTERED_EVENT) lives here, indexed by Discord message id.
 *
 * Each badge subscribes to `channelCacheListeners` so it re-renders
 * the moment its message's record lands in the cache, whether from
 * the bulk fetch or from a live single-id top-up.
 */
interface ChannelCacheState {
    records: Map<string, any>;
    loadingPromise: Promise<void> | null;
    loadedAt: number;
}
const channelCaches = new Map<string, ChannelCacheState>();
const channelCacheListeners = new Set<() => void>();

function notifyChannelCacheListeners() {
    for (const l of channelCacheListeners) {
        try { l(); } catch { /* ignore */ }
    }
}

function getChannelCache(channelId: string): ChannelCacheState {
    let c = channelCaches.get(channelId);
    if (!c) {
        c = { records: new Map(), loadingPromise: null, loadedAt: 0 };
        channelCaches.set(channelId, c);
    }
    return c;
}

/**
 * Pull every signed-message record for a channel in one HTTP call and
 * populate the channel cache. Idempotent within CHANNEL_CACHE_TTL_MS so
 * re-opening the same channel doesn't re-fetch. Also writes through to
 * the persistent IDB record cache so subsequent sessions start hot.
 */
async function ensureChannelLoaded(channelId: string): Promise<void> {
    if (!channelId) return;
    const cache = getChannelCache(channelId);
    if (cache.loadedAt > 0 && Date.now() - cache.loadedAt < CHANNEL_CACHE_TTL_MS) return;
    if (cache.loadingPromise) return cache.loadingPromise;

    cache.loadingPromise = (async () => {
        try {
            const url = `${veilApiBase()}/veilcord/signed-message/by-channel/${encodeURIComponent(channelId)}`;
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (!res.ok) return;
            const json = await res.json().catch(() => null);
            const records: any[] = Array.isArray(json?.records) ? json.records : [];
            for (const rec of records) {
                const mid = typeof rec?.discordMessageId === "string" ? rec.discordMessageId : null;
                if (!mid) continue;
                cache.records.set(mid, rec);
                void recordCache.writeHit(mid, rec);
            }
            cache.loadedAt = Date.now();
        } catch {
            /* leave loadedAt=0 so a later mount retries */
        } finally {
            cache.loadingPromise = null;
            notifyChannelCacheListeners();
        }
    })();
    return cache.loadingPromise;
}

/**
 * Fetch a single signed-message record by Discord id with retry, used
 * for messages that arrived after the channel pre-fetch (live
 * MESSAGE_CREATE) and to refresh after the sender's REGISTERED_EVENT.
 * Hits both the channel cache and the persistent IDB cache so the next
 * render is O(1) and survives reloads.
 */
async function liveFetchOne(channelId: string, messageId: string, options?: { force?: boolean; }): Promise<void> {
    if (!channelId || !messageId) return;
    const cache = getChannelCache(channelId);

    if (!options?.force) {
        if (cache.records.has(messageId)) return;
        const persisted = await recordCache.readRecord(messageId);
        if (persisted?.kind === "hit") {
            cache.records.set(messageId, persisted.record);
            notifyChannelCacheListeners();
            return;
        }
        if (persisted?.kind === "miss") {
            // Recent 404 — don't hammer the backend until the TTL lapses.
            return;
        }
    }

    for (let attempt = 0; attempt < FETCH_RETRY_DELAYS_MS.length; attempt++) {
        const delay = FETCH_RETRY_DELAYS_MS[attempt];
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
        try {
            const url = `${veilApiBase()}/veilcord/signed-message/by-discord/${encodeURIComponent(messageId)}`;
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (res.status === 404) {
                void recordCache.writeMiss(messageId);
                return;
            }
            if (!res.ok) continue;
            const raw = await res.json().catch(() => null);
            if (!raw || typeof raw !== "object") continue;
            void recordCache.writeHit(messageId, raw);
            cache.records.set(messageId, raw);
            notifyChannelCacheListeners();
            return;
        } catch { /* retry */ }
    }
}

/**
 * Subscribed once, lazily on first decoration mount. Live messages that
 * arrive into channels the user already opened trigger a single-id
 * fetch so the badge appears in the same render cycle as the message
 * body. Channels the user hasn't opened are skipped — we never poll
 * for data the user isn't looking at.
 */
let messageCreateInstalled = false;
function installMessageCreateHook() {
    if (messageCreateInstalled) return;
    messageCreateInstalled = true;
    FluxDispatcher.subscribe("MESSAGE_CREATE", (event: any) => {
        const msg = event?.message;
        if (!msg || typeof msg.id !== "string") return;
        const channelId = event?.channelId ?? msg.channel_id;
        if (typeof channelId !== "string") return;
        if (!channelCaches.has(channelId)) return;
        void liveFetchOne(channelId, msg.id);
    });
}

/**
 * Forcibly drop a record from every layer of caching and re-fetch it.
 * Used by the sender's REGISTERED_EVENT path so a prior `miss` can't
 * pin a freshly-signed message as unbadged.
 */
function bustCacheFor(channelId: string | null, messageId: string) {
    const prefix = `v4:${messageId}:`;
    for (const key of Array.from(flairCache.keys())) {
        if (key.startsWith(prefix)) flairCache.delete(key);
    }
    if (channelId) {
        const cache = channelCaches.get(channelId);
        cache?.records.delete(messageId);
    }
    void recordCache.invalidate(messageId);
}

interface LookupInput {
    /** Cached record from the channel cache. Required — without a record
     * there's nothing to verify. */
    record: any;
    /** Discord message id — bound into the v4 canonical body. */
    discordMessageId: string;
    /** Discord channel id — bound into the v4 canonical body. */
    channelId: string;
    /** Live Discord message content with ZWC stripped — verified against the canonical body. */
    strippedContent: string;
    authorId: string;
    /** Live attachment URLs in the message, in order. Used to bind file
     * hashes into the canonical signed body so an image swap breaks
     * the signature. Empty array means text-only verify. */
    attachmentUrls: string[];
}

/**
 * Cache of SHA-256 hex hashes keyed by attachment URL. Discord CDN URLs
 * are content-addressable in practice (same content → same URL), so a
 * URL-keyed cache rarely collides. Soft TTL keeps memory bounded.
 */
const ATTACHMENT_HASH_TTL_MS = 30 * 60 * 1000;
const attachmentHashCache = new Map<string, { hex: string; ts: number; }>();

async function hashAttachmentByUrl(url: string): Promise<string | null> {
    const cached = attachmentHashCache.get(url);
    if (cached && Date.now() - cached.ts < ATTACHMENT_HASH_TTL_MS) return cached.hex;
    try {
        const fetched = await Native.fetchAttachmentBytes(url);
        if (!fetched.ok) return null;
        const bytes = fetched.bytes instanceof Uint8Array
            ? fetched.bytes
            : new Uint8Array(fetched.bytes as any);
        const hex = await cryptoService.sha256Hex(bytes);
        attachmentHashCache.set(url, { hex, ts: Date.now() });
        return hex;
    } catch {
        return null;
    }
}

async function hashAllAttachments(urls: string[]): Promise<CanonicalAttachment[] | null> {
    if (urls.length === 0) return [];
    const out: CanonicalAttachment[] = [];
    for (const url of urls) {
        if (!url) return null;
        const hex = await hashAttachmentByUrl(url);
        if (!hex) return null;
        out.push({ sha256Hex: hex });
    }
    return out;
}

function fnv1a32(str: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

function lookupKey({ discordMessageId, channelId, authorId, strippedContent, attachmentUrls }: LookupInput): string {
    const attFp = fnv1a32(attachmentUrls.join("|"));
    return `v4:${discordMessageId}:${channelId}:${authorId}:${fnv1a32(strippedContent)}:${attFp}`;
}

/**
 * Derive the badge's display state from a cached record. The record
 * itself comes from the channel cache (no fetch here). The result is
 * memoized in `flairCache` keyed by the live message fields so an
 * edit, attachment swap, or author change refreshes the verdict.
 */
async function computeFlairState(input: LookupInput): Promise<FlairState> {
    const key = lookupKey(input);

    const cached = flairCache.get(key);
    if (cached) {
        const fresh =
            cached.state === "verified" ||
            cached.state === "invalid" ||
            (cached.state === "signed" && Date.now() - cached.ts < SIGNED_REVALIDATE_AFTER_MS) ||
            (cached.state === "unverified" && Date.now() - cached.ts < UNVERIFIED_REVALIDATE_AFTER_MS);
        if (fresh) return cached.state;
    }
    const running = inflight.get(key);
    if (running) return running;

    const promise = (async (): Promise<FlairState> => {
        try {
            const raw = input.record;
            const publicKey = typeof raw?.publicKey === "string" ? raw.publicKey : null;
            const signature = typeof raw?.signature === "string" ? raw.signature : null;
            const createdAt = typeof raw?.createdAt === "number" ? raw.createdAt : null;
            if (!publicKey || !signature) return "unverified";

            // Rebuild the canonical body from live message metadata
            // (mid, cid, uid) plus attachment hashes. The signature
            // doesn't verify against any other (mid, cid, uid) triple,
            // so a captured signature can't be reused on a different
            // message and a forged record posted under the wrong uid
            // shows up as `invalid`.
            const ctx = {
                discordMessageId: input.discordMessageId,
                channelId: input.channelId,
                senderUid: input.authorId
            };
            const hashes = input.attachmentUrls.length > 0
                ? await hashAllAttachments(input.attachmentUrls)
                : [];
            if (!hashes) return "unverified";
            const canonical = VeilSignedBody.buildCanonicalSignedBodyV4(input.strippedContent, hashes, ctx);
            const sigOk = await cryptoService.verify(canonical, signature, publicKey);
            if (!sigOk) return "invalid";

            if (createdAt == null) return "unverified";

            const active = await isBindingActiveAt(input.authorId, publicKey, createdAt);

            // v4 hard gate: a valid signature alone is not enough.
            // Anyone can mint a signature claiming any sender uid by
            // signing the matching canonical body with their own key,
            // so we require publicKey to actually be bound to the
            // author's discord uid at signing time.
            if (!active) return "unverified";

            return "verified";
        } catch {
            return "unverified";
        }
    })();

    inflight.set(key, promise);
    try {
        const result = await promise;
        flairCache.set(key, { state: result, ts: Date.now() });
        return result;
    } finally {
        inflight.delete(key);
    }
}

const FLAIR_META: Record<FlairState, { className: string; label: string; tooltip: string; }> = {
    loading: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--loading",
        label: "Checking",
        tooltip: "Checking Veil signature."
    },
    verified: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--verified",
        label: "Verified",
        tooltip: "Verified. Signed by this account's linked Veil key. Click for details."
    },
    signed: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--signed",
        label: "Signed",
        tooltip: "Signature is valid, but this Veil key isn't linked to this Discord account. Click for details."
    },
    invalid: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--invalid",
        label: "Invalid",
        tooltip: "Signature does not verify. Click for details."
    },
    unverified: {
        className: "vc-veil-sig-dot vc-veil-sig-dot--unverified",
        label: "Unverified",
        tooltip: "No Veil signature record was found for this message. Click for details."
    }
};

function StateGlyph({ state }: { state: FlairState; }) {
    if (state === "verified" || state === "signed") {
        return (
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.7 6.3l2.3 2.3 4.5-4.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
    }
    if (state === "invalid") {
        return (
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
        );
    }
    if (state === "unverified") {
        return (
            <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M4.2 4.6c0-1.1.9-1.8 1.9-1.8s1.8.7 1.8 1.7c0 1.6-1.8 1.5-1.8 2.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="6.05" cy="9" r="0.7" fill="currentColor" />
            </svg>
        );
    }
    return (
        <svg viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="3" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
            <circle cx="9" cy="6" r="1" fill="currentColor" />
        </svg>
    );
}

export function VeilSigBadge({ message }: { message: any; }) {
    const messageId: string | null = typeof message?.id === "string" ? message.id : null;
    const channelId: string | null = typeof message?.channel_id === "string" ? message.channel_id : null;
    const refMessageId: string | null = typeof message?.messageReference?.message_id === "string"
        ? message.messageReference.message_id
        : null;
    const refChannelId: string | null = typeof message?.messageReference?.channel_id === "string"
        ? message.messageReference.channel_id
        : channelId;

    return (
        <>
            {messageId && channelId && <MainMessageBadge message={message} />}
            {refMessageId && refChannelId && (
                <ReplyContextBadge refChannelId={refChannelId} refMessageId={refMessageId} />
            )}
        </>
    );
}

/**
 * Subscribe a React component to channel-cache version bumps so it
 * re-renders whenever a record lands in (or out of) the cache. Returns
 * a per-render version counter so React picks up the change.
 */
function useChannelCacheVersion(): number {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const listener = () => setVersion(v => v + 1);
        channelCacheListeners.add(listener);
        return () => { channelCacheListeners.delete(listener); };
    }, []);
    return version;
}

function MainMessageBadge({ message }: { message: any; }) {
    const authorTag = message?.author
        ? message.author.global_name || message.author.username || message.author.id
        : undefined;
    const authorId: string | null = message?.author?.id ?? null;
    const discordMessageId: string = String(message?.id ?? "");
    const channelId: string = String(message?.channel_id ?? "");
    const strippedContent = stripZwc(typeof message?.content === "string" ? message.content : "");
    const attachmentUrls: string[] = Array.isArray(message?.attachments)
        ? message.attachments.map((a: any) => (typeof a?.url === "string" ? a.url : "")).filter(Boolean)
        : [];

    const timestamp = (() => {
        const t = message?.timestamp;
        if (!t) return undefined;
        try {
            const d = typeof t === "string" || typeof t === "number"
                ? new Date(t)
                : (t?.toDate?.() ?? new Date(String(t)));
            return d.toLocaleString();
        } catch {
            return String(t);
        }
    })();

    // Re-render whenever the channel cache version bumps so the moment
    // our record lands (from the bulk pre-fetch, a live MESSAGE_CREATE
    // fetch, or REGISTERED_EVENT) the badge appears.
    useChannelCacheVersion();

    // Kick off the per-channel pre-fetch on first mount and install the
    // MESSAGE_CREATE live hook once. Both are idempotent and cheap to
    // call from every badge.
    useEffect(() => {
        if (!channelId) return;
        installMessageCreateHook();
        void ensureChannelLoaded(channelId);
    }, [channelId]);

    // Sender's own tab: when the local POST succeeds, REGISTERED_EVENT
    // fires. Drop any cached `miss` and re-fetch so the badge flips
    // instantly.
    useEffect(() => {
        if (!channelId || !discordMessageId) return;
        const onRegistered = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || detail.discordMessageId !== discordMessageId) return;
            bustCacheFor(channelId, discordMessageId);
            void liveFetchOne(channelId, discordMessageId, { force: true });
        };
        window.addEventListener(REGISTERED_EVENT, onRegistered as EventListener);
        return () => window.removeEventListener(REGISTERED_EVENT, onRegistered as EventListener);
    }, [discordMessageId, channelId]);

    const record = channelId && discordMessageId
        ? channelCaches.get(channelId)?.records.get(discordMessageId) ?? null
        : null;

    const haveAllInputs = !!(record && authorId && channelId && discordMessageId);

    const input: LookupInput | null = haveAllInputs
        ? { record, discordMessageId, channelId, authorId: authorId!, strippedContent, attachmentUrls }
        : null;
    const cacheKey = input ? lookupKey(input) : null;

    const [state, setState] = useState<FlairState>(() => {
        if (!cacheKey) return "loading";
        return flairCache.get(cacheKey)?.state ?? "loading";
    });

    useEffect(() => {
        if (!input) return;
        let cancelled = false;
        void computeFlairState(input).then(result => {
            if (cancelled) return;
            setState(result);
        });
        return () => { cancelled = true; };
        // attachmentUrls is captured by reference inside `input`; join it
        // for the dep array so a URL list change re-runs.
    }, [record, discordMessageId, channelId, authorId, strippedContent, attachmentUrls.join("|")]);

    /*
     * Portal the badge inline at the end of the message content (the
     * `[id^="message-content-"]` div Discord renders the markdown into),
     * so it flows after the message text the way the native "(edited)"
     * marker does. The anchor span is always rendered so the layout
     * effect runs regardless of whether we have a record yet — that way
     * a record landing later still finds the right DOM target.
     */
    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;

        const li = anchor.closest("li[id^=\"chat-messages-\"]") as HTMLElement | null;
        if (!li) return;
        if (!discordMessageId) return;

        const contentSelector = `#message-content-${CSS.escape(discordMessageId)}`;

        let attached: HTMLElement | null = null;

        const ensureHost = () => {
            const content = li.querySelector(contentSelector) as HTMLElement | null;
            if (!content) {
                if (attached) {
                    attached = null;
                    setOverlayHost(null);
                }
                return;
            }
            let host = content.querySelector(":scope > .vc-veil-sig-overlay") as HTMLElement | null;
            if (!host) {
                host = document.createElement("span");
                host.className = "vc-veil-sig-overlay";
            }
            if (host.parentElement !== content || host !== content.lastElementChild) {
                content.appendChild(host);
            }
            if (attached !== host) {
                attached = host;
                setOverlayHost(host);
            }
        };

        ensureHost();

        const observer = new MutationObserver(() => {
            const ok = attached
                && attached.isConnected
                && attached.parentElement?.id === `message-content-${discordMessageId}`
                && attached === attached.parentElement.lastElementChild;
            if (!ok) ensureHost();
        });
        observer.observe(li, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
        };
    }, [discordMessageId]);

    // No record yet (channel still loading, message isn't signed, or
    // record landed as a miss). Render the anchor so the portal-mount
    // effect stays wired, but don't show a badge.
    const showBadge = !!record && state !== "loading";

    const meta = FLAIR_META[state];
    const badge = showBadge ? (
        <button
            type="button"
            className={meta.className}
            onClick={() =>
                openModal(modalProps => (
                    <VerifyModal
                        modalProps={modalProps}
                        sigRef={{ v: 4 }}
                        discordMessageId={discordMessageId}
                        channelId={channelId}
                        authorId={authorId}
                        strippedContent={strippedContent}
                        attachmentUrls={attachmentUrls}
                        authorTag={authorTag}
                        timestamp={timestamp}
                    />
                ))
            }
            title={meta.tooltip}
            aria-label={meta.tooltip}
            data-state={state}
        >
            <StateGlyph state={state} />
            <span className="vc-veil-sig-dot__label">{meta.label}</span>
        </button>
    ) : null;

    return (
        <>
            <span ref={anchorRef} className="vc-veil-sig-anchor" aria-hidden="true" />
            {badge && overlayHost && ReactDOM.createPortal(badge, overlayHost)}
        </>
    );
}

/*
 * Inline flair mounted inside the reply-context snippet (the
 * `[id="message-content-<refId>"]` element Discord renders when a
 * message is a reply). Reuses the same verify-and-lookup pipeline as
 * the main badge but portals its button into the reply preview slot
 * instead of the message body, so a reply that targets a signed
 * message shows the original sender's flair next to the snippet.
 */
function ReplyContextBadge({
    refChannelId,
    refMessageId
}: {
    refChannelId: string;
    refMessageId: string;
}) {
    const refMessage = useStateFromStores(
        [MessageStore],
        () => MessageStore.getMessage(refChannelId, refMessageId) ?? null,
        [refChannelId, refMessageId]
    ) as any;

    const authorTag = refMessage?.author
        ? refMessage.author.global_name || refMessage.author.username || refMessage.author.id
        : undefined;
    const authorId: string | null = refMessage?.author?.id ?? null;
    const channelId: string = typeof refMessage?.channel_id === "string"
        ? refMessage.channel_id
        : refChannelId;
    const strippedContent = stripZwc(typeof refMessage?.content === "string" ? refMessage.content : "");
    const attachmentUrls: string[] = Array.isArray(refMessage?.attachments)
        ? refMessage.attachments.map((a: any) => (typeof a?.url === "string" ? a.url : "")).filter(Boolean)
        : [];

    const timestamp = (() => {
        const t = refMessage?.timestamp;
        if (!t) return undefined;
        try {
            const d = typeof t === "string" || typeof t === "number"
                ? new Date(t)
                : (t?.toDate?.() ?? new Date(String(t)));
            return d.toLocaleString();
        } catch {
            return String(t);
        }
    })();

    useChannelCacheVersion();

    useEffect(() => {
        if (!channelId) return;
        installMessageCreateHook();
        void ensureChannelLoaded(channelId);
    }, [channelId]);

    useEffect(() => {
        if (!channelId || !refMessageId) return;
        const onRegistered = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail || detail.discordMessageId !== refMessageId) return;
            bustCacheFor(channelId, refMessageId);
            void liveFetchOne(channelId, refMessageId, { force: true });
        };
        window.addEventListener(REGISTERED_EVENT, onRegistered as EventListener);
        return () => window.removeEventListener(REGISTERED_EVENT, onRegistered as EventListener);
    }, [refMessageId, channelId]);

    const record = channelId && refMessageId
        ? channelCaches.get(channelId)?.records.get(refMessageId) ?? null
        : null;

    const haveAllInputs = !!(record && authorId && channelId && refMessageId);

    const input: LookupInput | null = haveAllInputs
        ? { record, discordMessageId: refMessageId, channelId, authorId: authorId!, strippedContent, attachmentUrls }
        : null;
    const cacheKey = input ? lookupKey(input) : null;

    const [state, setState] = useState<FlairState>(() => {
        if (!cacheKey) return "loading";
        return flairCache.get(cacheKey)?.state ?? "loading";
    });

    useEffect(() => {
        if (!input) return;
        let cancelled = false;
        void computeFlairState(input).then(result => {
            if (cancelled) return;
            setState(result);
        });
        return () => { cancelled = true; };
    }, [record, refMessageId, channelId, authorId, strippedContent, attachmentUrls.join("|")]);

    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const [host, setHost] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        const li = anchor.closest("li[id^=\"chat-messages-\"]") as HTMLElement | null;
        if (!li) return;

        const contentSelector = `#message-content-${CSS.escape(refMessageId)}`;
        let attached: HTMLElement | null = null;

        const ensureHost = () => {
            const content = li.querySelector(contentSelector) as HTMLElement | null;
            if (!content) {
                if (attached) { attached = null; setHost(null); }
                return;
            }
            let h = content.querySelector(":scope > .vc-veil-sig-reply-overlay") as HTMLElement | null;
            if (!h) {
                h = document.createElement("span");
                h.className = "vc-veil-sig-reply-overlay";
            }
            if (h.parentElement !== content || h !== content.firstElementChild) {
                content.insertBefore(h, content.firstChild);
            }
            if (attached !== h) { attached = h; setHost(h); }
        };

        ensureHost();

        const observer = new MutationObserver(() => {
            const ok = attached
                && attached.isConnected
                && attached.parentElement?.id === `message-content-${refMessageId}`
                && attached === attached.parentElement.firstElementChild;
            if (!ok) ensureHost();
        });
        observer.observe(li, { childList: true, subtree: true });

        return () => observer.disconnect();
    }, [refMessageId]);

    const showBadge = !!record && state !== "loading";

    if (!showBadge) {
        return <span ref={anchorRef} className="vc-veil-sig-anchor" aria-hidden="true" />;
    }

    const meta = FLAIR_META[state];
    const badge = (
        <button
            type="button"
            className={`${meta.className} vc-veil-sig-dot--reply`}
            onClick={e => {
                e.stopPropagation();
                openModal(modalProps => (
                    <VerifyModal
                        modalProps={modalProps}
                        sigRef={{ v: 4 }}
                        discordMessageId={refMessageId}
                        channelId={channelId}
                        authorId={authorId}
                        strippedContent={strippedContent}
                        attachmentUrls={attachmentUrls}
                        authorTag={authorTag}
                        timestamp={timestamp}
                    />
                ));
            }}
            title={meta.tooltip}
            aria-label={meta.tooltip}
            data-state={state}
        >
            <StateGlyph state={state} />
        </button>
    );

    return (
        <>
            <span ref={anchorRef} className="vc-veil-sig-anchor" aria-hidden="true" />
            {host && ReactDOM.createPortal(badge, host)}
        </>
    );
}
