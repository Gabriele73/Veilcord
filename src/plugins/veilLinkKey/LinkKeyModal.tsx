/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./linkKeyModal.css";

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import {
    BindingRow,
    cryptoService,
    fetchBindingsByDiscordUid,
    linkPubkeyToDiscord,
    unlinkPubkeyFromDiscord
} from "@plugins/veilCrypto";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { showToast, TextInput, Toasts, useEffect, useRef, useState, UserStore } from "@webpack/common";

const HEX64 = /^[0-9a-fA-F]{64}$/;

type Mode = "status" | "paste" | "import" | "generate" | "export";

type ActiveKeyInfo = {
    hasKey: boolean;
    publicKey: string | null;
    uid: string | null;
    hasVault: boolean;
    passkeyEnrolled: boolean;
    passkeyLoginAvailable: boolean;
    trustedLeaseActive: boolean;
};

const EMPTY_KEY_INFO: ActiveKeyInfo = {
    hasKey: false,
    publicKey: null,
    uid: null,
    hasVault: false,
    passkeyEnrolled: false,
    passkeyLoginAvailable: false,
    trustedLeaseActive: false
};

async function readActiveKey(): Promise<ActiveKeyInfo> {
    let hasKey = false;
    let publicKey: string | null = null;
    try {
        if (await cryptoService.hasStoredKey()) {
            hasKey = true;
            try { publicKey = await cryptoService.getPublicKey(); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }

    const userData = await cryptoService.getUserData().catch(() => null);
    const uid = userData?.uid || userData?.username || null;
    if (!publicKey && userData?.pubkey) publicKey = userData.pubkey;

    let hasVault = false;
    let passkeyEnrolled = false;
    let passkeyLoginAvailable = false;
    let trustedLeaseActive = false;
    try {
        const state = await cryptoService.getPasskeyEnrollmentState();
        hasVault = Boolean(state?.hasEncryptedVault);
        passkeyEnrolled = Boolean(state?.enrolled);
        passkeyLoginAvailable = Boolean(state?.passkeyLoginAvailable);
        trustedLeaseActive = Boolean(state?.trustedLeaseActive);
    } catch { /* ignore */ }

    return { hasKey, publicKey, uid, hasVault, passkeyEnrolled, passkeyLoginAvailable, trustedLeaseActive };
}

function ModeTabs({ mode, setMode, info }: { mode: Mode; setMode: (m: Mode) => void; info: ActiveKeyInfo; }) {
    const statusLabel = info.hasKey
        ? "Active key"
        : (info.hasVault ? "Locked vault" : "No key");
    const tabs: Array<[Mode, string, boolean]> = [
        ["status", statusLabel, true],
        ["paste", "Paste hex", !info.hasKey],
        ["import", "Import backup", !info.hasKey],
        ["generate", "Generate", !info.hasKey],
        ["export", "Export backup", info.hasKey]
    ];
    return (
        <div className="vc-veil-tabs">
            {tabs.filter(([, , show]) => show).map(([id, label]) => (
                <Button
                    key={id}
                    size="small"
                    variant={mode === id ? "primary" : "secondary"}
                    onClick={() => setMode(id)}
                >
                    {label}
                </Button>
            ))}
        </div>
    );
}

function PubkeyChip({ publicKey }: { publicKey: string; }) {
    return (
        <code className="vc-veil-pubkey-chip">
            {publicKey}
        </code>
    );
}

function formatBindingDate(ts: number): string {
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return String(ts);
    }
}

function DiscordLinkSection({
    publicKey,
    discordUid,
    bindings,
    busy,
    error,
    onLink,
    onUnlink
}: {
    publicKey: string;
    discordUid: string;
    bindings: BindingRow[];
    busy: boolean;
    error: string | null;
    onLink: () => Promise<void>;
    onUnlink: () => Promise<void>;
}) {
    const lowerPub = publicKey.toLowerCase();
    const rowsForThisKey = bindings.filter(b => b.publicKey?.toLowerCase() === lowerPub);
    const active = rowsForThisKey.find(b => b.unlinkedAt == null) ?? null;
    const previous = rowsForThisKey.filter(b => b.unlinkedAt != null);

    return (
        <section className="vc-veil-discord-link">
            <HeadingSecondary>Discord link</HeadingSecondary>
            {active ? (
                <Flex flexDirection="column" gap={6}>
                    <Paragraph style={{ margin: 0 }}>
                        Linked to your Discord account <strong>{discordUid}</strong> on{" "}
                        <strong>{formatBindingDate(active.linkedAt)}</strong>.
                    </Paragraph>
                    <Paragraph className="vc-veil-muted" style={{ margin: 0 }}>
                        Verifying clients can confirm your signed messages were authored by this Discord account.
                    </Paragraph>
                    <Flex gap={8} style={{ flexWrap: "wrap" }}>
                        <Button variant="secondary" disabled={busy} onClick={onUnlink}>
                            {busy ? "Working…" : "Unlink"}
                        </Button>
                    </Flex>
                </Flex>
            ) : (
                <Flex flexDirection="column" gap={6}>
                    <Paragraph style={{ margin: 0 }}>
                        Link this key to your Discord account so others can verify your signed messages
                        are really from <strong>{discordUid}</strong>. You'll be redirected to Discord to
                        authorize the <code>identify</code> scope; nothing else is shared.
                    </Paragraph>
                    <Flex gap={8} style={{ flexWrap: "wrap" }}>
                        <Button variant="primary" disabled={busy} onClick={onLink}>
                            {busy ? "Opening Discord…" : "Link to Discord"}
                        </Button>
                    </Flex>
                </Flex>
            )}
            {error && <Paragraph className="vc-veil-error" style={{ margin: 0 }}>{error}</Paragraph>}
            {previous.length > 0 && (
                <details className="vc-veil-binding-history">
                    <summary>Previous links ({previous.length})</summary>
                    <ul className="vc-veil-binding-history-list">
                        {previous.map(row => (
                            <li key={row.linkedAt}>
                                Linked {formatBindingDate(row.linkedAt)}
                                {row.unlinkedAt != null && ` · unlinked ${formatBindingDate(row.unlinkedAt)}`}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </section>
    );
}

function StatusPanel({ info, refresh, onClose }: { info: ActiveKeyInfo; refresh: () => Promise<void>; onClose: () => void; }) {
    const [busy, setBusy] = useState(false);
    const [bindings, setBindings] = useState<BindingRow[]>([]);
    const [bindingBusy, setBindingBusy] = useState(false);
    const [bindingError, setBindingError] = useState<string | null>(null);

    const discordUid: string | null = (UserStore.getCurrentUser?.() as any)?.id ?? null;

    const refreshBindings = async () => {
        if (!discordUid) { setBindings([]); return; }
        try {
            const result = await fetchBindingsByDiscordUid(discordUid);
            setBindings(result?.bindings ?? []);
        } catch {
            setBindings([]);
        }
    };

    useEffect(() => { void refreshBindings(); }, [discordUid, info.hasKey, info.publicKey]);

    async function linkToDiscord() {
        setBindingBusy(true);
        setBindingError(null);
        try {
            const result = await linkPubkeyToDiscord();
            if (discordUid && result.discordUid !== discordUid) {
                // The OAuth popup opened in the OS default browser; if that
                // browser is signed into a different Discord account than the
                // one this Discord client is using, the binding lands under
                // the wrong uid and the rest of the UI silently looks
                // unlinked. Surface it loudly with the actual numeric ids.
                setBindingError(
                    `You authorized Discord account ${result.discordUid}, but Discord here is signed in as ${discordUid}. ` +
                    `Sign your default browser into ${discordUid} and try again, or unlink ${result.discordUid} via that account.`
                );
                await refreshBindings();
                return;
            }
            showToast("Linked to your Discord account.", Toasts.Type.SUCCESS);
            await refreshBindings();
        } catch (e: any) {
            setBindingError(e?.message || "Couldn't link to Discord");
        } finally {
            setBindingBusy(false);
        }
    }

    async function unlinkFromDiscord() {
        if (!discordUid) return;
        if (!confirm("Unlink this key from your Discord account? Messages signed before now will still verify, but new ones won't be tied to this account until you link again.")) return;
        setBindingBusy(true);
        setBindingError(null);
        try {
            await unlinkPubkeyFromDiscord(discordUid);
            showToast("Unlinked.", Toasts.Type.SUCCESS);
            await refreshBindings();
        } catch (e: any) {
            setBindingError(e?.message || "Couldn't unlink");
        } finally {
            setBindingBusy(false);
        }
    }

    async function lock() {
        setBusy(true);
        try {
            await cryptoService.clearActivePrivateKeyOnly();
            showToast("Vault locked. Reload Discord or use your passkey to unlock it again.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (e: any) {
            showToast(e?.message || "Couldn't lock the vault", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    async function unlockWithPasskey() {
        setBusy(true);
        try {
            await cryptoService.unlockWithEnrolledPasskey();
            showToast("Vault unlocked.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (e: any) {
            showToast(e?.message || "Couldn't unlock the vault", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    async function wipe() {
        if (!confirm("This will permanently delete the encrypted vault, the trusted-device lease, and any passkey enrolled on this device. Your remote account isn't affected. Continue?")) return;
        setBusy(true);
        try {
            await cryptoService.clearStoredKey();
            showToast("Local Veil keys removed.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (e: any) {
            showToast(e?.message || "Couldn't remove the local keys", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    if (!info.hasKey && info.hasVault) {
        return (
            <Flex flexDirection="column" gap={10}>
                <section>
                    <HeadingSecondary>Vault locked</HeadingSecondary>
                    {info.publicKey
                        ? <PubkeyChip publicKey={info.publicKey} />
                        : <Paragraph className="vc-veil-muted">(your public key will appear once the vault is unlocked)</Paragraph>}
                </section>
                <Paragraph>
                    Your encrypted vault is still saved locally. Only the unlocked copy in memory was cleared.
                    {info.trustedLeaseActive && " Reloading Discord will unlock it again automatically through the trusted-device lease."}
                    {!info.trustedLeaseActive && " The trusted-device lease has expired, so you'll need to unlock with your passkey or re-import the encrypted backup."}
                </Paragraph>
                <Flex gap={8} style={{ flexWrap: "wrap" }}>
                    {info.passkeyLoginAvailable && (
                        <Button variant="primary" disabled={busy} onClick={unlockWithPasskey}>
                            {busy ? "Unlocking…" : "Unlock with passkey"}
                        </Button>
                    )}
                    <Button variant="secondary" disabled={busy} onClick={() => location.reload()}>
                        Reload Discord
                    </Button>
                    <Button variant="dangerPrimary" disabled={busy} onClick={wipe}>
                        Remove local keys
                    </Button>
                </Flex>
            </Flex>
        );
    }

    if (!info.hasKey) {
        return (
            <Paragraph>
                There's no private key linked to this client yet. Use one of the tabs above to paste an existing key,
                import an encrypted <code>veil-key-backup</code> file, or generate a fresh keypair.
            </Paragraph>
        );
    }

    return (
        <Flex flexDirection="column" gap={10}>
            <section>
                <HeadingSecondary>Active public key</HeadingSecondary>
                {info.publicKey ? <PubkeyChip publicKey={info.publicKey} /> : <Paragraph>(unavailable)</Paragraph>}
            </section>
            <Paragraph>
                Your private key lives in an encrypted local vault (AES-GCM) and stays unlocked through a 30-day
                trusted-device lease.
            </Paragraph>
            {info.publicKey && discordUid && (
                <DiscordLinkSection
                    publicKey={info.publicKey}
                    discordUid={discordUid}
                    bindings={bindings}
                    busy={bindingBusy}
                    error={bindingError}
                    onLink={linkToDiscord}
                    onUnlink={unlinkFromDiscord}
                />
            )}
            <Flex gap={8} style={{ flexWrap: "wrap" }}>
                <Button variant="secondary" disabled={busy} onClick={lock}>Lock vault</Button>
                <Button variant="dangerPrimary" disabled={busy} onClick={wipe}>
                    Remove local keys
                </Button>
            </Flex>
        </Flex>
    );
}

function PastePanel({ existing, refresh }: { existing: boolean; refresh: () => Promise<void>; }) {
    const [hex, setHex] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const trimmed = hex.trim().toLowerCase();
    const valid = HEX64.test(trimmed);

    async function attach() {
        setBusy(true);
        setError(null);
        try {
            await cryptoService.forceSetPrivateKey(trimmed);
            showToast("Private key linked.", Toasts.Type.SUCCESS);
            setHex("");
            await refresh();
        } catch (e: any) {
            setError(e?.message || "Couldn't link that key");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Flex flexDirection="column" gap={10}>
            <Paragraph>
                Paste a 64-character hex Ed25519 private key. {existing && "This will replace the key that's currently linked."}
            </Paragraph>
            <div className="vc-veil-input-row">
                <TextInput
                    type="password"
                    value={hex}
                    onChange={setHex}
                    placeholder="ed25519 private key hex"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                />
            </div>
            {hex && !valid && (
                <Paragraph className="vc-veil-error">
                    That doesn't look right. A private key must be exactly 64 hex characters.
                </Paragraph>
            )}
            {error && <Paragraph className="vc-veil-error">{error}</Paragraph>}
            <Flex gap={8}>
                <Button variant="primary" disabled={!valid || busy} onClick={attach}>
                    {busy ? "Linking…" : (existing ? "Replace key" : "Link key")}
                </Button>
            </Flex>
        </Flex>
    );
}

function ImportPanel({ existing, refresh }: { existing: boolean; refresh: () => Promise<void>; }) {
    const fileRef = useRef<HTMLInputElement>(null);
    const [payload, setPayload] = useState<any>(null);
    const [fileName, setFileName] = useState<string>("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function ensureBackupShape(p: any): boolean {
        if (!p || typeof p !== "object") return false;
        if (p.format !== "veil-key-backup" || p.version !== 1) return false;
        if (!p?.kdf?.salt || !p?.kdf?.iterations) return false;
        if (!p?.cipher?.iv || !p?.data) return false;
        return true;
    }

    async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
        setError(null);
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (!ensureBackupShape(parsed)) throw new Error("That file isn't a valid encrypted Veil backup.");
            setPayload(parsed);
            setFileName(file.name);
        } catch (err: any) {
            setError(err?.message || "Couldn't read the backup file");
            setPayload(null);
            setFileName("");
        }
    }

    async function unlock() {
        if (!payload) return;
        setBusy(true);
        setError(null);
        try {
            const { privateKey } = await cryptoService.decryptEncryptedPrivateKeyBackup(payload, password);
            await cryptoService.forceSetPrivateKey(privateKey);
            showToast("Backup unlocked. Your key is now linked.", Toasts.Type.SUCCESS);
            setPayload(null);
            setFileName("");
            setPassword("");
            await refresh();
        } catch (e: any) {
            setError(e?.message || "Couldn't unlock that backup");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Flex flexDirection="column" gap={10}>
            <Paragraph>
                Import an encrypted backup you've exported.
                {existing && " The currently linked key will be replaced."}
            </Paragraph>
            <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                onChange={pickFile}
                style={{ display: "none" }}
            />
            <Flex gap={8} style={{ flexWrap: "wrap" }}>
                <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                    {fileName ? `Selected: ${fileName}` : "Choose backup file…"}
                </Button>
                {payload && (
                    <Button variant="secondary" onClick={() => { setPayload(null); setFileName(""); }}>
                        Clear
                    </Button>
                )}
            </Flex>
            <div className="vc-veil-input-row">
                <TextInput
                    type="password"
                    value={password}
                    onChange={setPassword}
                    placeholder="Backup password"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                />
            </div>
            {error && <Paragraph className="vc-veil-error">{error}</Paragraph>}
            <Flex gap={8}>
                <Button variant="primary" disabled={!payload || !password || busy} onClick={unlock}>
                    {busy ? "Unlocking…" : "Unlock and link"}
                </Button>
            </Flex>
        </Flex>
    );
}

function GeneratePanel({ existing, refresh }: { existing: boolean; refresh: () => Promise<void>; }) {
    const [revealed, setRevealed] = useState<{ publicKey: string; privateKey: string; } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function generate() {
        if (existing && !confirm("A private key is already linked. Generating a new one will replace it. Continue?")) return;
        setBusy(true);
        setError(null);
        try {
            if (existing) {
                await cryptoService.clearStoredKey();
            }
            const { publicKey, privateKey } = await cryptoService.generateKeys();
            if (!privateKey) throw new Error("The generator didn't return a private key.");
            setRevealed({ publicKey, privateKey });
            showToast("New keypair generated and linked.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (e: any) {
            setError(e?.message || "Couldn't generate a new keypair");
        } finally {
            setBusy(false);
        }
    }

    async function copy(value: string, label: string) {
        try {
            await navigator.clipboard.writeText(value);
            showToast(`${label} copied`, Toasts.Type.SUCCESS);
        } catch {
            showToast("Clipboard isn't available right now", Toasts.Type.FAILURE);
        }
    }

    return (
        <Flex flexDirection="column" gap={10}>
            <Paragraph>
                Generate a fresh Ed25519 keypair and link it.{existing && " Your existing local keys will be wiped first."}
                {" "}
                <strong>Save the private key somewhere safe. If you lose it, you lose access to anything signed with it.</strong>
            </Paragraph>
            {error && <Paragraph className="vc-veil-error">{error}</Paragraph>}
            {revealed ? (
                <Flex flexDirection="column" gap={8}>
                    <section>
                        <HeadingSecondary>Public key</HeadingSecondary>
                        <PubkeyChip publicKey={revealed.publicKey} />
                    </section>
                    <section>
                        <HeadingSecondary>Private key (hex), copy it now</HeadingSecondary>
                        <PubkeyChip publicKey={revealed.privateKey} />
                    </section>
                    <Flex gap={8} style={{ flexWrap: "wrap" }}>
                        <Button variant="secondary" onClick={() => copy(revealed.privateKey, "Private key")}>
                            Copy private key
                        </Button>
                        <Button variant="secondary" onClick={() => copy(revealed.publicKey, "Public key")}>
                            Copy public key
                        </Button>
                        <Button variant="primary" onClick={() => setRevealed(null)}>Done</Button>
                    </Flex>
                    <BaseText size="sm" className="vc-veil-warning">
                        This is the only time the private key will be shown. Use the encrypted backup flow to make a recoverable copy.
                    </BaseText>
                </Flex>
            ) : (
                <Flex gap={8}>
                    <Button variant="primary" disabled={busy} onClick={generate}>
                        {busy ? "Generating…" : "Generate keypair"}
                    </Button>
                </Flex>
            )}
        </Flex>
    );
}

type PasswordEval = {
    checks: { length: boolean; lower: boolean; upper: boolean; digit: boolean; symbol: boolean; };
    score: number;
    label: string;
    tone: "weak" | "fair" | "good" | "strong";
    isAcceptable: boolean;
};

function evaluatePassword(password: string): PasswordEval {
    const checks = {
        length: password.length >= 12,
        lower: /[a-z]/.test(password),
        upper: /[A-Z]/.test(password),
        digit: /\d/.test(password),
        symbol: /[^A-Za-z0-9]/.test(password)
    };
    const score = Object.values(checks).filter(Boolean).length;
    let label = "Too weak";
    let tone: PasswordEval["tone"] = "weak";
    if (score >= 5) { label = "Strong"; tone = "strong"; }
    else if (score === 4) { label = "Good"; tone = "good"; }
    else if (score === 3) { label = "Fair"; tone = "fair"; }
    const isAcceptable = checks.length && checks.lower && checks.upper && checks.digit && checks.symbol;
    return { checks, score, label, tone, isAcceptable };
}

function StrengthMeter({ password }: { password: string; }) {
    const evalResult = evaluatePassword(password);
    const tones: Record<PasswordEval["tone"], string> = {
        weak: "#ff7f8a",
        fair: "#f0b346",
        good: "#9dcf65",
        strong: "#57c78e"
    };
    const widthPct = Math.round((evalResult.score / 5) * 100);
    const rules: Array<[keyof PasswordEval["checks"], string]> = [
        ["length", "At least 12 characters"],
        ["upper", "At least one uppercase letter"],
        ["lower", "At least one lowercase letter"],
        ["digit", "At least one number"],
        ["symbol", "At least one symbol"]
    ];
    return (
        <div className="vc-veil-strength-card">
            <div className="vc-veil-strength-header">
                <span className="vc-veil-strength-label">Password Strength</span>
                <span
                    className="vc-veil-strength-value"
                    style={{ color: password ? tones[evalResult.tone] : "var(--veil-text-muted)" }}
                >
                    {password ? evalResult.label : "Not set"}
                </span>
            </div>
            <div className="vc-veil-strength-track">
                <div
                    className="vc-veil-strength-fill"
                    style={{
                        width: `${widthPct}%`,
                        background: tones[evalResult.tone]
                    }}
                />
            </div>
            <ul className="vc-veil-rules">
                {rules.map(([key, label]) => {
                    const pass = evalResult.checks[key];
                    return (
                        <li key={key} className={`vc-veil-rule${pass ? " pass" : ""}`}>
                            <span className="vc-veil-rule-dot" />
                            {label}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function buildBackupFileBaseName(uid: string | null): string {
    const raw = uid || "user";
    const safe = raw
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "user";
    const date = new Date().toISOString().slice(0, 10);
    return `veil-key-backup-${safe}-${date}`;
}

function downloadJson(content: string, fileName: string) {
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ExportPanel({ info }: { info: ActiveKeyInfo; }) {
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const evalResult = evaluatePassword(password);
    const matches = password.length > 0 && password === confirm;
    const ready = !busy && evalResult.isAcceptable && matches;

    async function exportFile() {
        setError(null);
        if (!evalResult.isAcceptable) {
            setError("Your password needs at least 12 characters with an uppercase letter, a lowercase letter, a number, and a symbol.");
            return;
        }
        if (!matches) {
            setError("The password and its confirmation don't match.");
            return;
        }
        setBusy(true);
        try {
            const payload = await cryptoService.createEncryptedPrivateKeyBackup(password);
            const fileName = `${buildBackupFileBaseName(info.uid)}.json`;
            downloadJson(JSON.stringify(payload, null, 2), fileName);
            showToast("Encrypted backup downloaded.", Toasts.Type.SUCCESS);
            setPassword("");
            setConfirm("");
        } catch (e: any) {
            setError(e?.message || "Couldn't export the backup");
            showToast(e?.message || "Couldn't export the backup", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Flex flexDirection="column" gap={12}>
            <div className="vc-veil-info-card">
                The backup is encrypted locally with PBKDF2-SHA256 (600k iterations) and AES-GCM before it leaves your
                client. Keep both the password and the backup
                file private.
            </div>

            <section className="vc-veil-input-row">
                <HeadingSecondary>Encryption password</HeadingSecondary>
                <TextInput
                    type="password"
                    value={password}
                    onChange={setPassword}
                    placeholder="Use a strong password"
                    autoComplete="new-password"
                    spellCheck={false}
                    autoCapitalize="off"
                />
            </section>

            <StrengthMeter password={password} />

            <section className="vc-veil-input-row">
                <HeadingSecondary>Confirm password</HeadingSecondary>
                <TextInput
                    type="password"
                    value={confirm}
                    onChange={setConfirm}
                    placeholder="Retype password"
                    autoComplete="new-password"
                    spellCheck={false}
                    autoCapitalize="off"
                />
                {confirm && !matches && (
                    <Paragraph className="vc-veil-error">
                        Passwords don't match.
                    </Paragraph>
                )}
            </section>

            <Paragraph className="vc-veil-muted">
                If you lose this password, you lose access to anything signed with the key. There's no recovery.
            </Paragraph>

            {error && <Paragraph className="vc-veil-error">{error}</Paragraph>}

            <Flex gap={8}>
                <Button variant="primary" disabled={!ready} onClick={exportFile}>
                    {busy ? "Encrypting…" : "Download encrypted file"}
                </Button>
            </Flex>
        </Flex>
    );
}

export function LinkKeyModal({ modalProps }: { modalProps: ModalProps; }) {
    const [info, setInfo] = useState<ActiveKeyInfo>(EMPTY_KEY_INFO);
    const [mode, setMode] = useState<Mode>("import");
    const initialModeApplied = useRef(false);

    const refresh = async () => setInfo(await readActiveKey());

    useEffect(() => { void refresh(); }, []);

    useEffect(() => {
        if (initialModeApplied.current) return;
        if (info.hasKey || info.hasVault) {
            setMode("status");
        }
        initialModeApplied.current = true;
    }, [info.hasKey, info.hasVault]);

    useEffect(() => {
        if (info.hasKey && (mode === "paste" || mode === "import" || mode === "generate")) {
            setMode("status");
        }
    }, [info.hasKey, mode]);

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM} className="vc-veil-modal">
            <ModalHeader>
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>
                    Manage your Veil key
                </BaseText>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <ModeTabs mode={mode} setMode={setMode} info={info} />
                {mode === "status" && <StatusPanel info={info} refresh={refresh} onClose={modalProps.onClose} />}
                {mode === "paste" && <PastePanel existing={info.hasKey} refresh={refresh} />}
                {mode === "import" && <ImportPanel existing={info.hasKey} refresh={refresh} />}
                {mode === "generate" && <GeneratePanel existing={info.hasKey} refresh={refresh} />}
                {mode === "export" && <ExportPanel info={info} />}
            </ModalContent>

            <ModalFooter>
                <Flex gap={8}>
                    <Button variant="secondary" onClick={modalProps.onClose}>Close</Button>
                </Flex>
            </ModalFooter>
        </ModalRoot>
    );
}
