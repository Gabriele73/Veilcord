# VeilLinkKey

Adds a small **key icon button** next to the bottom-left settings cog (between
the audio buttons and the cog). Clicking it opens the Veil key-management
modal.

Depends on `VeilCrypto`, which already implements the local AES-GCM vault, the
30-day trusted-unlock lease, and the `veil-key-backup` v1 PBKDF2 / AES-GCM
backup format.

## What the modal does

Tabs:

- **Active key** — shows the current public key. Buttons:
  - *Lock vault* — `cryptoService.clearActivePrivateKeyOnly()` (vault stays on
    disk; reload + lease prompt to unlock).
  - *Remove local keys* — `cryptoService.clearStoredKey()` (full local wipe;
    remote account untouched).
- **Paste hex** — paste a 64-char hex Ed25519 private key →
  `cryptoService.forceSetPrivateKey(hex)` (encrypts to vault and activates).
- **Import backup** — load a `veil-key-backup` v1 JSON exported from
  `veil-frontend` → `cryptoService.decryptEncryptedPrivateKeyBackup(payload, password)`
  → `forceSetPrivateKey`. **Same exact format**, no migration needed.
- **Generate** — `cryptoService.generateKeys()` (or wipes + regenerates if a key
  was already linked). The private key is shown ONCE; the user is told to copy
  or back it up.
- **Export backup** *(only when a key is linked)* — password + confirm with the
  same 5-rule strength meter (length 12+, upper, lower, digit, symbol) used by
  `veil-frontend/components/export-key-modal.js`, then
  `cryptoService.createEncryptedPrivateKeyBackup(password)` → JSON file
  download named `veil-key-backup-<uid>-<YYYY-MM-DD>.json`. The output file is
  byte-identical in shape to the one veil-frontend produces and can be loaded
  back via the Import backup tab here, or via the login page on veil.rip.
  (QR export is not implemented in Veilcord — Discord's renderer CSP blocks
  loading the third-party QR encoder veil-frontend uses; the web frontend
  remains the place to make QR backups.)

## Compatibility

- Reads any backup file produced by `veil-frontend/components/export-key-modal.js`
  v1 — file format is identical (`format: "veil-key-backup"`, `version: 1`,
  PBKDF2-SHA256 → AES-GCM, base64 fields).
- Writes any backup file readable by the same upstream import flow (see
  `login.html` `ensureBackupPayloadShape` + `decryptEncryptedPrivateKeyBackup`).
- Storage goes through the same `KeyStorage` IndexedDB (`veil_crypto` DB) that
  veil-frontend uses, so a key linked from Veilcord is visible to the web
  frontend running in the same origin (Discord renderer is its own origin, but
  the schema is identical so manual export/import works).

## Where the entry shows up

Because Discord ships several different compiled shapes for the user panel
(localized aria-labels, indirected `onClick` handlers, varying JSX runtime
identifiers), regex-patching the cog button's call site turned out to be
unreliable across Discord versions. This plugin instead injects via DOM with
a `MutationObserver`:

1. `start()` queries `section[class*="panels__"]` (the bottom-left user panel
   section). Class names are content-hashed by Discord but the `panels__`
   prefix is stable.
2. Inside, `[class*="buttons__"]` is the audio/cog row.
3. The cog is the **last direct `<button>` child** of that row across both
   voice-connected and idle states (the audio buttons are nested inside
   `audioButtonParent__<hash>` wrappers, so a `:scope > button` query skips
   them).
4. We create a `<span data-veil-key-host="1">` host node, `insertBefore`
   the cog, and `createRoot(host).render(<PanelButton/>)`.
5. The `MutationObserver` watches `document.body` (`childList: true,
   subtree: true`), throttled via `requestAnimationFrame`. Whenever Discord's
   reconciler removes our host on a re-render, the observer fires and we
   put it back — typically within a frame, so the user doesn't notice.

`stop()` disconnects the observer, `unmount()`s the React root, and removes
the host node.

This is independent of the compiled JSX shape, so it survives Discord
client updates that previously broke regex-based patches. The trade-off is
the small per-mutation `requestAnimationFrame` callback — it's a single
`querySelector` + a few DOM reads, well below any frame budget.

## Multi-key support — design notes (not yet implemented)

The current `CryptoService` is single-slot: one vault payload, one active
private key, one trusted-unlock lease. Extending this to N keys without
breaking the existing `veil-key-backup` v1 format is straightforward — here
are the options, ordered cheap → expensive.

### Option A. Slotted vault (recommended)

Promote the single `PRIVATE_KEY_VAULT_ID` row into a list keyed by a slot id.

`storage.ts` becomes:

```ts
type KeySlot = {
    id: string;             // uuid
    label: string;          // user-given name, e.g. "personal", "work"
    pubkey: string;         // hex, cached for UI
    vault: VaultPayload;    // existing veil-key-vault v1 blob
    createdAt: number;
    lastUsedAt: number;
};

// Stored under PRIVATE_KEY_VAULT_ID as
// { format: "veil-key-vault-list", version: 2, slots: KeySlot[], activeId: string }
```

`CryptoService` keeps a single `_activePrivateKeyHex` but exposes:

- `listSlots(): Promise<{ id, label, pubkey, createdAt, lastUsedAt }[]>`
- `addSlot({ label, privateKeyHex }): Promise<string>` (returns slot id)
- `setActiveSlot(id): Promise<void>` (re-runs the trusted-unlock dance for the
  selected vault)
- `removeSlot(id): Promise<void>`
- `renameSlot(id, label)`

The trusted-unlock lease stays per-device (one lease unlocks any slot once
trust is established) — the wrapped vault key in the lease becomes per-slot
(`wrappedVaultKeys: Record<slotId, base64>`).

**Backwards compatibility**: on first read, if the row is shape v1
(`format: "veil-key-vault"`), `_initFromStorage` migrates it into the v2 list
with a single slot labelled `"default"` and `activeId = <its id>`. Existing
backups (`veil-key-backup` v1) still import — they just become a new slot.

### Option B. Multi-active signing (later)

If users want to sign with several keys simultaneously (e.g. one for
identity + one for an alt), expose:

- `signWith(slotId, message)` — explicit per-slot signing, used by
  `veilSignedMessage` via a "key picker" inside the Sign modal.
- `_activePrivateKeyHex` becomes `_activeSlotId`; the cached hex moves into a
  small LRU keyed by slot id so we don't decrypt on every sign.

The existing `sign(message)` keeps signing with the active slot for backward
compatibility.

### Option C. Backup file extension

`veil-key-backup` v1 carries a single private key. To export multiple slots
in one file, define `veil-key-backup` v2:

```json
{
  "format": "veil-key-backup",
  "version": 2,
  "kdf": { "...PBKDF2 same as v1...": null },
  "cipher": { "name": "AES-GCM", "iv": "..." },
  "data": "<base64 of JSON({ slots: [{ id, label, privateKey, publicKey, createdAt }] })>",
  "metadata": { "uid": "...", "exportedAt": "..." }
}
```

`decryptEncryptedPrivateKeyBackup` keeps reading v1 (single key). A new
`decryptMultiBackup` reads v2 and yields a `slots[]`. The export modal in
veil-frontend gets a new "Export all keys" button that produces v2.

### UI hook into VeilLinkKey

This plugin's modal already has a slot for multi-key:

- The **Active key** tab becomes a list of slots with "Switch", "Rename",
  "Remove" buttons.
- A new **Slots** tab adds an "Add new slot" entry that funnels into the
  existing **Paste / Import / Generate** flows but tags the result with a
  user-given label.
- The **Export backup** tab gains a "scope" toggle: *active slot only* (writes
  v1, current behavior) or *all slots* (writes v2).

The `LinkKeyModal` is already split into per-mode panels (`StatusPanel`,
`PastePanel`, `ImportPanel`, `GeneratePanel`, `ExportPanel`) so each becomes
a method on a selected slot rather than the global vault — small refactor,
no UI rewrite.

## Multi-key support — design notes (not yet implemented)

The current `CryptoService` is single-slot: one vault payload, one active
private key, one trusted-unlock lease. Extending this to N keys without
breaking the existing `veil-key-backup` v1 format is straightforward — here
are the options, ordered cheap → expensive.

### Option A. Slotted vault (recommended)

Promote the single `PRIVATE_KEY_VAULT_ID` row into a list keyed by a slot id.

`storage.ts` becomes:

```ts
type KeySlot = {
    id: string;             // uuid
    label: string;          // user-given name, e.g. "personal", "work"
    pubkey: string;         // hex, cached for UI
    vault: VaultPayload;    // existing veil-key-vault v1 blob
    createdAt: number;
    lastUsedAt: number;
};

// Stored under PRIVATE_KEY_VAULT_ID as { format: "veil-key-vault-list", version: 2, slots: KeySlot[], activeId: string }
```

`CryptoService` keeps a single `_activePrivateKeyHex` but exposes:

- `listSlots(): Promise<{ id, label, pubkey, createdAt, lastUsedAt }[]>`
- `addSlot({ label, privateKeyHex }): Promise<string>` (returns slot id)
- `setActiveSlot(id): Promise<void>` (re-runs the trusted-unlock dance for the
  selected vault)
- `removeSlot(id): Promise<void>`
- `renameSlot(id, label)`

The trusted-unlock lease stays per-device (one lease unlocks any slot once
trust is established) — the wrapped vault key in the lease becomes per-slot
(`wrappedVaultKeys: Record<slotId, base64>`).

**Backwards compatibility**: on first read, if the row is shape v1
(`format: "veil-key-vault"`), `_initFromStorage` migrates it into the v2 list
with a single slot labelled `"default"` and `activeId = <its id>`. Existing
backups (`veil-key-backup` v1) still import — they just become a new slot.

### Option B. Multi-active signing (later)

If users want to sign with several keys simultaneously (e.g. one for
identity + one for an alt), expose:

- `signWith(slotId, message)` — explicit per-slot signing, used by
  `veilSignedMessage` via a "key picker" inside the Sign modal.
- `_activePrivateKeyHex` becomes `_activeSlotId`; the cached hex moves into a
  small LRU keyed by slot id so we don't decrypt on every sign.

The existing `sign(message)` keeps signing with the active slot for backward
compatibility.

### Option C. Backup file extension

`veil-key-backup` v1 carries a single private key. To export multiple slots
in one file, define `veil-key-backup` v2:

```json
{
  "format": "veil-key-backup",
  "version": 2,
  "kdf": { ... PBKDF2 same as v1 ... },
  "cipher": { "name": "AES-GCM", "iv": "..." },
  "data": "<base64 of JSON({ slots: [{ id, label, privateKey, publicKey, createdAt }] })>",
  "metadata": { "uid": "...", "exportedAt": "..." }
}
```

`decryptEncryptedPrivateKeyBackup` keeps reading v1 (single key). A new
`decryptMultiBackup` reads v2 and yields a `slots[]`. The export modal in
veil-frontend gets a new "Export all keys" button that produces v2.

### UI hook into VeilLinkKey

This plugin's modal already has a slot for multi-key:

- The **Active key** tab becomes a list of slots with "Switch", "Rename",
  "Remove" buttons.
- A new **Slots** tab adds an "Add new slot" entry that funnels into the
  existing **Paste / Import / Generate** flows but tags the result with a
  user-given label.

The `LinkKeyModal` is already split into per-mode panels (`StatusPanel`,
`PastePanel`, `ImportPanel`, `GeneratePanel`) so each becomes a method on a
selected slot rather than the global vault — small refactor, no UI rewrite.
