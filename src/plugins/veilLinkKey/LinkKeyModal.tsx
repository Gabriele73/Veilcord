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
import { cryptoService } from "@plugins/veilCrypto";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize } from "@utils/modal";
import { showToast, TextInput, Toasts, useEffect, useRef, useState } from "@webpack/common";

const HEX64 = /^[0-9a-fA-F]{64}$/;

type Mode = "status" | "paste" | "import" | "generate" | "export";

type ActiveKeyInfo = { hasKey: boolean; publicKey: string | null; uid: string | null; };

async function readActiveKey(): Promise<ActiveKeyInfo> {
    try {
        if (await cryptoService.hasStoredKey()) {
            const userData = await cryptoService.getUserData().catch(() => null);
            return {
                hasKey: true,
                publicKey: await cryptoService.getPublicKey(),
                uid: userData?.uid || userData?.username || null
            };
        }
    } catch {
        // fall through
    }
    return { hasKey: false, publicKey: null, uid: null };
}

function ModeTabs({ mode, setMode, hasKey }: { mode: Mode; setMode: (m: Mode) => void; hasKey: boolean; }) {
    const tabs: Array<[Mode, string, boolean]> = [
        ["status", hasKey ? "Active key" : "No key", true],
        ["paste", "Paste hex", true],
        ["import", "Import backup", true],
        ["generate", "Generate", true],
        ["export", "Export backup", hasKey]
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

function StatusPanel({ info, refresh, onClose }: { info: ActiveKeyInfo; refresh: () => Promise<void>; onClose: () => void; }) {
    const [busy, setBusy] = useState(false);

    async function lock() {
        setBusy(true);
        try {
            await cryptoService.clearActivePrivateKeyOnly();
            showToast("Vault locked. Re-authenticate to use it again.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (e: any) {
            showToast(e?.message || "Failed to lock vault", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    async function wipe() {
        if (!confirm("This will permanently delete the encrypted vault, lease, and any passkey enrollment from this device. The remote account is not affected. Continue?")) return;
        setBusy(true);
        try {
            await cryptoService.clearStoredKey();
            showToast("Local Veil keys removed.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (e: any) {
            showToast(e?.message || "Failed to remove keys", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    if (!info.hasKey) {
        return (
            <Paragraph>
                No private key is currently linked to this Discord client. Use one of the tabs above to paste an existing
                key, import an encrypted <code>veil-key-backup</code> file, or generate a new keypair.
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
                The matching private key is stored in the encrypted local vault (AES-GCM) and unlocked by a 30-day
                trusted-device lease — same scheme as veil-frontend.
            </Paragraph>
            <Flex gap={8} style={{ flexWrap: "wrap" }}>
                <Button variant="secondary" disabled={busy} onClick={lock}>Lock vault</Button>
                <Button variant="dangerPrimary" disabled={busy} onClick={wipe}>
                    Remove local keys
                </Button>
                <Button variant="secondary" onClick={onClose}>Close</Button>
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
            setError(e?.message || "Failed to link key");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Flex flexDirection="column" gap={10}>
            <Paragraph>
                Paste a 64-character hex Ed25519 private key. {existing && "This will REPLACE the currently linked key."}
            </Paragraph>
            <TextInput
                type="password"
                value={hex}
                onChange={setHex}
                placeholder="ed25519 private key hex"
            />
            {hex && !valid && (
                <Paragraph className="vc-veil-error">
                    Invalid private key — must be exactly 64 hex characters.
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
            if (!ensureBackupShape(parsed)) throw new Error("Selected file is not a valid encrypted Veil backup");
            setPayload(parsed);
            setFileName(file.name);
        } catch (err: any) {
            setError(err?.message || "Failed to read backup file");
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
            showToast("Backup unlocked and key linked.", Toasts.Type.SUCCESS);
            setPayload(null);
            setFileName("");
            setPassword("");
            await refresh();
        } catch (e: any) {
            setError(e?.message || "Failed to unlock backup");
        } finally {
            setBusy(false);
        }
    }

    return (
        <Flex flexDirection="column" gap={10}>
            <Paragraph>
                Import an encrypted backup exported from veil-frontend (<code>veil-key-backup</code> v1 JSON).
                {existing && " The currently linked key will be REPLACED."}
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
            <TextInput
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="Backup password"
            />
            {error && <Paragraph className="vc-veil-error">{error}</Paragraph>}
            <Flex gap={8}>
                <Button variant="primary" disabled={!payload || !password || busy} onClick={unlock}>
                    {busy ? "Unlocking…" : "Unlock & link"}
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
        if (existing && !confirm("A private key is already linked. Generating will REPLACE it. Continue?")) return;
        setBusy(true);
        setError(null);
        try {
            if (existing) {
                await cryptoService.clearStoredKey();
            }
            const { publicKey, privateKey } = await cryptoService.generateKeys();
            if (!privateKey) throw new Error("Generation returned no private key");
            setRevealed({ publicKey, privateKey });
            showToast("New keypair generated and linked.", Toasts.Type.SUCCESS);
            await refresh();
        } catch (e: any) {
            setError(e?.message || "Failed to generate key");
        } finally {
            setBusy(false);
        }
    }

    async function copy(value: string, label: string) {
        try {
            await navigator.clipboard.writeText(value);
            showToast(`${label} copied`, Toasts.Type.SUCCESS);
        } catch {
            showToast("Clipboard unavailable", Toasts.Type.FAILURE);
        }
    }

    return (
        <Flex flexDirection="column" gap={10}>
            <Paragraph>
                Generate a fresh Ed25519 keypair and link it. {existing && "Existing local keys will be wiped first."}
                {" "}
                <strong>Save the private key to a safe place — losing it means losing access to anything signed with it.</strong>
            </Paragraph>
            {error && <Paragraph className="vc-veil-error">{error}</Paragraph>}
            {revealed ? (
                <Flex flexDirection="column" gap={8}>
                    <section>
                        <HeadingSecondary>Public key</HeadingSecondary>
                        <PubkeyChip publicKey={revealed.publicKey} />
                    </section>
                    <section>
                        <HeadingSecondary>Private key (hex) — copy now</HeadingSecondary>
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
                        This is the only time the private key is shown. Use the encrypted backup flow in veil-frontend
                        to make a recoverable copy.
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
            setError("Password must be at least 12 chars and include upper, lower, number, and symbol");
            return;
        }
        if (!matches) {
            setError("Password confirmation does not match");
            return;
        }
        setBusy(true);
        try {
            const payload = await cryptoService.createEncryptedPrivateKeyBackup(password);
            const fileName = `${buildBackupFileBaseName(info.uid)}.json`;
            downloadJson(JSON.stringify(payload, null, 2), fileName);
            showToast("Encrypted key backup downloaded", Toasts.Type.SUCCESS);
            setPassword("");
            setConfirm("");
        } catch (e: any) {
            setError(e?.message || "Failed to export backup");
            showToast(e?.message || "Failed to export backup", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Flex flexDirection="column" gap={12}>
            <div className="vc-veil-info-card">
                This backup is encrypted locally with PBKDF2-SHA256 (600k iterations) + AES-GCM before download.
                Same <code>veil-key-backup</code> v1 format the web frontend uses — it can be loaded back via the
                Import backup tab here, or via the login page on veil.rip. Keep the password and file private.
            </div>

            <section>
                <HeadingSecondary>Encryption password</HeadingSecondary>
                <TextInput
                    type="password"
                    value={password}
                    onChange={setPassword}
                    placeholder="Use a strong password"
                />
            </section>

            <StrengthMeter password={password} />

            <section>
                <HeadingSecondary>Confirm password</HeadingSecondary>
                <TextInput
                    type="password"
                    value={confirm}
                    onChange={setConfirm}
                    placeholder="Retype password"
                />
                {confirm && !matches && (
                    <Paragraph className="vc-veil-error">
                        Passwords do not match.
                    </Paragraph>
                )}
            </section>

            <Paragraph className="vc-veil-muted">
                Losing this password means losing access to anything signed with the key. There is no recovery.
            </Paragraph>

            {error && <Paragraph className="vc-veil-error">{error}</Paragraph>}

            <Flex gap={8}>
                <Button variant="primary" disabled={!ready} onClick={exportFile}>
                    {busy ? "Encrypting…" : "Download Encrypted File"}
                </Button>
            </Flex>
        </Flex>
    );
}

export function LinkKeyModal({ modalProps }: { modalProps: ModalProps; }) {
    const [info, setInfo] = useState<ActiveKeyInfo>({ hasKey: false, publicKey: null, uid: null });
    const [mode, setMode] = useState<Mode>("import");

    const refresh = async () => setInfo(await readActiveKey());

    useEffect(() => { void refresh(); }, []);

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM} className="vc-veil-modal">
            <ModalHeader>
                <BaseText size="lg" weight="semibold" style={{ flexGrow: 1 }}>
                    Veil — Link Private Key
                </BaseText>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <ModeTabs mode={mode} setMode={setMode} hasKey={info.hasKey} />
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
