# VeilCrypto — shared crypto service for Veil plugins

Vencord plugin that ports the logic from `veil-frontend/crypto/` into a single
shared service usable by every Veil plugin running inside Discord.

## What it provides

A singleton `cryptoService` that mirrors the public API of the upstream
`CryptoService` class:

- **Ed25519** key generation, signing, verification (native `crypto.subtle`)
- **Encrypted vault** for the private key (AES-GCM, 32-byte vault key)
- **Trusted-unlock lease** (30 days) so re-opens don't prompt every time
- **Passkey** enrollment / verify / unlock (WebAuthn)
- **Encrypted password backups** (PBKDF2 + AES-GCM)
- **IndexedDB** persistence (`veil_crypto` DB, mirrors the web frontend so
  data is portable in shared origins)

## Differences from the web frontend port

- **No Web Worker.** The upstream version offloads ed25519 to
  `crypto.worker.js`. Inside Discord's renderer we can't trivially spawn
  module workers (CSP + `import.meta.url` + `esm.sh` fetch would all fight
  us), so signing/verification run on the main thread via native
  `crypto.subtle.Ed25519`. Discord's Electron is recent enough that this is
  available; if a future runtime drops native Ed25519 the service throws
  with a clear message.
- **No `@noble/ed25519` fallback.** Avoiding the extra dependency.
- **Passkey RP ID override.** Inside Discord the hostname is
  `discord.com` / `ptb.discord.com`, not `veil.rip`, so the auto-derived
  RP ID is wrong for Veil-domain passkeys. Call
  `cryptoService.setPasskeyRpIdOverride("veil.rip")` (or whatever your RP
  is) before any passkey op.

## Using from another Veil plugin

```ts
// src/plugins/yourVeilPlugin/index.tsx
import definePlugin from "@utils/types";
import { Devs } from "@utils/constants";
import { cryptoService } from "@plugins/veilCrypto";

export default definePlugin({
    name: "YourVeilPlugin",
    description: "...",
    authors: [Devs.gabriele],
    dependencies: ["VeilCrypto"],

    async start() {
        if (await cryptoService.hasStoredKey()) {
            const pub = await cryptoService.getPublicKey();
            const sig = await cryptoService.sign("hello veil");
            console.log({ pub, sig });
        }
    }
});
```

The `dependencies: ["VeilCrypto"]` line ensures Vencord starts the crypto
plugin first.

## Public API

All methods are on `cryptoService` (singleton):

| method | description |
|---|---|
| `hasStoredKey()` | true if a vault is unlocked / a private key is active |
| `setPrivateKey(hex)` | store a hex-encoded ed25519 private key, returns pubkey |
| `forceSetPrivateKey(hex)` | overwrite an existing one |
| `setEphemeralPrivateKey(hex)` | activate without persisting |
| `clearActivePrivateKeyOnly()` | drop the in-memory key, keep the vault |
| `generateKeys()` | new keypair, returns `{ publicKey, privateKey }` |
| `getPublicKey()` | hex pubkey of the active private key |
| `sign(msg)` | hex ed25519 signature |
| `verify(msg, sig, pub)` | boolean |
| `clearStoredKey()` | wipe vault + lease + passkey + user data |
| `getUserData()` / `setUserData(obj)` | arbitrary JSON tied to the local user |
| `isLoggedIn()` | hasStoredKey && userData present |
| `supportsLocalPasskey()` | feature-detect |
| `getPasskeyEnrollmentState()` | snapshot of vault / lease / passkey state |
| `enrollLocalPasskey({ username, userId })` | create + store a WebAuthn credential |
| `verifyEnrolledPasskey()` | prompt for the existing passkey |
| `unlockWithEnrolledPasskey()` | passkey -> vault -> active key |
| `clearPasskeyEnrollment()` | drop the credential record |
| `createEncryptedPrivateKeyBackup(password)` | PBKDF2/AES-GCM payload |
| `decryptEncryptedPrivateKeyBackup(payload, password)` | inverse |
| `setPasskeyRpIdOverride(rpId \| null)` | override hostname-derived RP ID |

## Files

- `index.ts` — Vencord plugin entry, re-exports the service
- `service.ts` — `CryptoService` class + singleton
- `storage.ts` — IndexedDB-backed `KeyStorage`
- `ed25519.ts` — thin wrapper around native `crypto.subtle.Ed25519`
- `utils.ts` — hex / base64 / byte helpers + shared constants
