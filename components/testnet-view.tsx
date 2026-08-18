"use client";

import {
  Activity,
  CheckCircle2,
  CircleOff,
  Database,
  ExternalLink,
  Fingerprint,
  FlaskConical,
  Gauge,
  HardDrive,
  KeyRound,
  LockKeyhole,
  Network,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  TerminalSquare,
  WalletCards,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { FolioPageHeader, FolioView } from "@/components/folio";
import { CopyButton, InlineSpinner } from "@/components/primitives";
import type { ViewProps } from "@/components/view-types";
import { formatZec, maskAddress } from "@/lib/money";

export function TestnetView({ data, refresh, notify, busy, setBusy }: ViewProps) {
  const { node } = data;
  const accountScopedWallet = node.walletReachable && node.nodeSource !== "legacy";
  const synchronizedScopedWallet =
    accountScopedWallet && node.safeTestnet && node.walletSynchronized && node.balanceZatoshi !== null;
  const [tab, setTab] = useState<"status" | "setup" | "safety">("status");
  async function rescan() {
    if (busy) return;
    setBusy("lab-sync");
    try {
      const response = await fetch("/api/zcash/sync", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Scan failed.");
      const refreshed = await refresh();
      notify(
        refreshed
          ? `${payload.observed} wallet records scanned; ${payload.matched} local document links processed.`
          : "The scan completed, but the latest view could not be loaded. Try again.",
        refreshed ? "success" : "error",
      );
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }
  async function checkNow() {
    if (busy) return;
    setBusy("node-check");
    try {
      const response = await fetch("/api/zcash/status?force=1", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Check failed.");
      const refreshed = await refresh();
      notify(
        refreshed ? payload.node.message : "The check completed, but the latest view could not be loaded. Try again.",
        refreshed && payload.node.safeTestnet ? "success" : "error",
      );
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }
  async function resetDemo() {
    if (
      busy ||
      data.state.mode !== "demo" ||
      !window.confirm("Reset the local presentation data to its initial state? This action cannot be undone.")
    )
      return;
    setBusy("reset");
    try {
      const response = await fetch("/api/demo/reset", { method: "POST" });
      if (!response.ok) throw new Error("Reset failed.");
      const refreshed = await refresh();
      notify(
        refreshed
          ? "The synthetic presentation ledger was reset."
          : "The presentation ledger was reset, but the latest view could not be loaded. Try again.",
        refreshed ? "success" : "error",
      );
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }
  const sourceLabel =
    node.nodeSource === "public-readonly"
      ? "Public Zebra gateway · read-only"
      : node.nodeSource === "local-zebra"
        ? "Local Z3 / Zebra"
        : node.nodeSource === "legacy"
          ? "Legacy compatibility layer"
          : "Unreachable";
  return (
    <FolioView className="folio-view--testnet">
      <FolioPageHeader
        overline="Zcash testnet infrastructure"
        title="Connection, synchronization, and broadcast safety"
        description="Network, wallet, and broadcast gates are monitored separately."
        aside={
          <dl className="system-header-facts">
            <div>
              <dt>Chain tip</dt>
              <dd>#{node.blocks?.toLocaleString("en-US") ?? "—"}</dd>
            </div>
            <div>
              <dt>Last check</dt>
              <dd>
                {new Date(node.lastCheckedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
              </dd>
            </div>
          </dl>
        }
      />
      <section className="system-safety-strip" aria-label="Network safety status">
        <span className={node.reachable && node.safeTestnet ? "is-positive" : "is-danger"}>
          {node.reachable ? <Wifi aria-hidden="true" size={15} /> : <WifiOff aria-hidden="true" size={15} />}
          {node.reachable && node.safeTestnet
            ? "Testnet connection verified"
            : node.reachable
              ? "The network could not be verified as testnet"
              : "No network observation"}
        </span>
        <span>
          <LockKeyhole aria-hidden="true" size={15} /> Mainnet locked at the code level
        </span>
        <span>
          <FlaskConical aria-hidden="true" size={15} /> Test funds have no monetary value
        </span>
      </section>
      <div className="lab-tabs" role="tablist" aria-label="Testnet lab sections">
        <button
          role="tab"
          id="tab-status"
          aria-controls="panel-status"
          aria-selected={tab === "status"}
          className={tab === "status" ? "is-active" : ""}
          onClick={() => setTab("status")}
        >
          <Activity aria-hidden="true" size={16} /> Live status
        </button>
        <button
          role="tab"
          id="tab-setup"
          aria-controls="panel-setup"
          aria-selected={tab === "setup"}
          className={tab === "setup" ? "is-active" : ""}
          onClick={() => setTab("setup")}
        >
          <TerminalSquare aria-hidden="true" size={16} /> Setup guide
        </button>
        <button
          role="tab"
          id="tab-safety"
          aria-controls="panel-safety"
          aria-selected={tab === "safety"}
          className={tab === "safety" ? "is-active" : ""}
          onClick={() => setTab("safety")}
        >
          <ShieldCheck aria-hidden="true" size={16} /> Security model
        </button>
      </div>
      {tab === "status" && (
        <div role="tabpanel" id="panel-status" aria-labelledby="tab-status">
          <section className="node-grid">
            <article className={`node-card ${node.reachable && node.safeTestnet ? "is-online" : ""}`}>
              <div className="node-card__head">
                <div>
                  <Server aria-hidden="true" size={20} />
                </div>
                <span>
                  <b>Zebra node</b>
                  <small>{sourceLabel}</small>
                </span>
                <i>{node.reachable && node.safeTestnet ? "TESTNET" : node.reachable ? "WRONG NETWORK" : "OFFLINE"}</i>
              </div>
              <div className="node-card__metric">
                <span>CHAIN TIP</span>
                <b>{node.blocks?.toLocaleString("en-US") ?? "—"}</b>
                <small>
                  {node.headers && node.blocks
                    ? `${Math.max(0, node.headers - node.blocks)} blocks behind`
                    : "Height unknown"}
                </small>
              </div>
              <ul>
                <li>
                  <span>Network</span>
                  <b>{node.chain ?? "—"}</b>
                </li>
                <li>
                  <span>Verification</span>
                  <b>{node.verificationProgress !== null ? `${(node.verificationProgress * 100).toFixed(3)}%` : "—"}</b>
                </li>
                <li>
                  <span>Latency</span>
                  <b>{node.latencyMs !== null ? `${node.latencyMs} ms` : "—"}</b>
                </li>
                <li>
                  <span>Version</span>
                  <b>{node.nodeVersion ?? "—"}</b>
                </li>
              </ul>
            </article>
            <article className={`node-card ${node.walletReachable ? "is-online" : ""}`}>
              <div className="node-card__head">
                <div>
                  <WalletCards aria-hidden="true" size={20} />
                </div>
                <span>
                  <b>{node.nodeSource === "legacy" ? "Legacy wallet RPC" : "Zallet RPC adapter"}</b>
                  <small>Observation layer · not proof of custody</small>
                </span>
                <i>{node.walletReachable ? "RPC REACHABLE" : "UNREACHABLE"}</i>
              </div>
              <div className="node-card__metric">
                <span>
                  {node.nodeSource === "legacy" ? "LEGACY WHOLE-WALLET BALANCE" : "ALLOWLISTED ACCOUNT TOTAL"}
                </span>
                <b>
                  {synchronizedScopedWallet ? formatZec(node.balanceZatoshi!, 5) : "—"} <small>TAZ</small>
                </b>
                <small>
                  {synchronizedScopedWallet
                    ? "Wallet RPC total for allowlisted accounts; not independent proof of balance"
                    : node.nodeSource === "legacy" && node.walletReachable
                      ? "Legacy whole-wallet value; not scoped to the purpose vault"
                      : "No synchronized, account-scoped wallet observation"}
                </small>
              </div>
              <ul>
                <li>
                  <span>Wallet tip</span>
                  <b>{node.walletHeight?.toLocaleString("en-US") ?? "—"}</b>
                </li>
                <li>
                  <span>Scan</span>
                  <b>{node.walletSyncProgress !== null ? `${(node.walletSyncProgress * 100).toFixed(2)}%` : "—"}</b>
                </li>
                <li>
                  <span>Receiver</span>
                  <b>{maskAddress(node.receiverAddress, 8, 6)}</b>
                </li>
                <li>
                  <span>Spending authority</span>
                  <b>Not verified by the status API</b>
                </li>
              </ul>
            </article>
            <article className="node-card safety-node">
              <div className="node-card__head">
                <div>
                  <LockKeyhole aria-hidden="true" size={20} />
                </div>
                <span>
                  <b>Broadcast lock</b>
                  <small>Configuration gates · not proof of broadcast</small>
                </span>
                <i>{node.sendReady ? "SERVER PREREQUISITES PASSED" : "LOCKED"}</i>
              </div>
              <div className="safety-lock-visual">
                <ShieldCheck aria-hidden="true" size={36} />
                <span>MAINNET</span>
                <b>BLOCKED</b>
              </div>
              <ul>
                <li>
                  {node.safeTestnet ? (
                    <CheckCircle2 aria-hidden="true" size={14} />
                  ) : (
                    <CircleOff aria-hidden="true" size={14} />
                  )}
                  <span>Testnet network check: {node.safeTestnet ? "verified" : "not verified"}</span>
                </li>
                <li>
                  {node.sendEnabled ? (
                    <CheckCircle2 aria-hidden="true" size={14} />
                  ) : (
                    <CircleOff aria-hidden="true" size={14} />
                  )}
                  <span>Send permission: {node.sendEnabled ? "enabled by operator" : "disabled"}</span>
                </li>
                <li>
                  {node.externalBroadcastConfirmed ? (
                    <CheckCircle2 aria-hidden="true" size={14} />
                  ) : (
                    <CircleOff aria-hidden="true" size={14} />
                  )}
                  <span>
                    Operator external-broadcast attestation:{" "}
                    {node.externalBroadcastConfirmed ? "configured" : "pending"}
                  </span>
                </li>
                <li>
                  {node.fullPrivacyEnabled ? (
                    <CheckCircle2 aria-hidden="true" size={14} />
                  ) : (
                    <CircleOff aria-hidden="true" size={14} />
                  )}
                  <span>Configured privacy policy: {node.fullPrivacyEnabled ? "FullPrivacy" : "rejected"}</span>
                </li>
              </ul>
            </article>
          </section>
          <section className="status-message">
            <span className={node.safeTestnet ? "pulse-dot" : "demo-dot"} />
            <div>
              <b>{node.message}</b>
              <p>Last check: {new Date(node.lastCheckedAt).toLocaleString("en-US")}</p>
            </div>
            <button className="button button--ghost" onClick={() => void checkNow()} disabled={busy !== null}>
              {busy === "node-check" ? <InlineSpinner /> : <RefreshCw aria-hidden="true" size={15} />} Check now
            </button>
          </section>
          <section className="lab-actions">
            <article>
              <div>
                <RefreshCw aria-hidden="true" size={21} />
              </div>
              <h3>Wallet scan</h3>
              <p>Scan allowlisted account history page by page; do not import if the safe upper bound is exceeded.</p>
              <button
                className="button button--primary"
                onClick={() => void rescan()}
                disabled={busy !== null || !node.walletReachable}
              >
                {busy === "lab-sync" ? <InlineSpinner /> : <Radio aria-hidden="true" size={16} />} Scan testnet
              </button>
            </article>
            <article>
              <div>
                <Zap aria-hidden="true" size={21} />
              </div>
              <h3>Get test funds</h3>
              <p>
                Fund the testnet Unified Address; wait for at least {data.state.settings.minConfirmations}{" "}
                confirmations.
              </p>
              <div className="action-links">
                <a href="https://fauzec.com/" target="_blank" rel="noreferrer">
                  Fauzec <ExternalLink aria-hidden="true" size={13} />
                </a>
                <a href="https://zcashfaucet.jinolabs.xyz/" target="_blank" rel="noreferrer">
                  Jino Faucet <ExternalLink aria-hidden="true" size={13} />
                </a>
              </div>
            </article>
            <article>
              <div>
                <ExternalLink aria-hidden="true" size={21} />
              </div>
              <h3>Verify independently</h3>
              <p>
                Open the canonical txid in an explorer and check only public fields. The shielded party and amount
                cannot be verified through an explorer.
              </p>
              <a className="button button--ghost" href="https://zexplorer.app/testnet" target="_blank" rel="noreferrer">
                zexplorer.app <ExternalLink aria-hidden="true" size={14} />
              </a>
            </article>
          </section>
        </div>
      )}
      {tab === "setup" && (
        <section className="setup-layout" role="tabpanel" id="panel-setup" aria-labelledby="tab-setup">
          <article className="panel setup-steps">
            <div className="panel__header">
              <div>
                <span className="eyebrow">COPY-PASTE SETUP</span>
                <h3>Current Z3 testnet stack</h3>
              </div>
              <span className="version-chip">2026 · NU6.3+</span>
            </div>
            <Step
              number="1"
              title="Clone Z3"
              text="The Zebra node and beta Zallet wallet run as separate processes under the official Z3 Compose definition."
              code={`git clone https://github.com/ZcashFoundation/z3.git
cd z3
./scripts/setup-network.sh testnet`}
            />
            <Step
              number="2"
              title="Start the testnet services"
              text="The initial Zebra synchronization requires approximately 30 GB and may take 2–12 hours, depending on the hardware."
              code={`docker compose --env-file .env.testnet up -d zebra
./scripts/check-zebra-readiness.sh 18080`}
            />
            <Step
              number="3"
              title="Initialize Zallet once"
              text="The encryption identity and wallet database are kept on the same network volume; the wallet recovery seed never enters the browser or ZechLedger."
              code={`# Full commands are in Z3 docs/faq.md
docker compose --env-file .env.testnet run --rm --no-deps zallet \
  --datadir /var/lib/zallet --config /etc/zallet/zallet.toml generate-encryption-identity
docker compose --env-file .env.testnet run --rm --no-deps zallet \
  --datadir /var/lib/zallet --config /etc/zallet/zallet.toml init-wallet-encryption
docker compose --env-file .env.testnet up -d zallet`}
            />
            <Step
              number="4"
              title="Connect ZechLedger"
              text="Mount the Zebra and Zallet cookie files read-only; keep wallet RPC on the loopback interface or a private Docker network only."
              code={`cp .env.example .env.local
# ZEBRA_RPC_URL=http://127.0.0.1:18232
# ZALLET_RPC_URL=http://127.0.0.1:40232
# ZCASH_RECEIVER_ADDRESS=utest1...
npm run dev`}
            />
            <div className="setup-callout">
              <CircleOff aria-hidden="true" size={18} />
              <p>
                <b>Why is zcashd absent?</b>
                <span>
                  zcashd v6.20.0 stopped at the EoS height on July 18, 2026, and does not support Ironwood/NU6.3.
                  ZechLedger’s primary adapter is Zebra + Zallet.
                </span>
              </p>
            </div>
          </article>
          <aside className="setup-side">
            <article className="panel architecture-card">
              <span className="eyebrow">CONNECTION ARCHITECTURE</span>
              <div className="architecture-flow">
                <div>
                  <Network aria-hidden="true" size={20} />
                  <span>
                    <b>Zebra</b>
                    <small>Consensus + block data</small>
                  </span>
                </div>
                <i>JSON-RPC</i>
                <div>
                  <KeyRound aria-hidden="true" size={20} />
                  <span>
                    <b>Zallet</b>
                    <small>Wallet scanning + memo processing</small>
                  </span>
                </div>
                <i>SERVER ONLY</i>
                <div className="app-node">
                  <span>ZL</span>
                  <b>ZechLedger API</b>
                </div>
              </div>
              <ul>
                <li>
                  <CheckCircle2 aria-hidden="true" size={14} /> No RPC password in the browser
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={14} /> ZEC stored as integer zatoshis
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={14} /> Automatic ZIP-317 fees
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={14} /> Zallet experimental RPC feature detection
                </li>
              </ul>
            </article>
            <article className="panel resource-card">
              <span className="eyebrow">TESTNET RESOURCES</span>
              <div>
                <HardDrive aria-hidden="true" size={18} />
                <span>
                  <b>~30 GB SSD</b>
                  <small>Zebra testnet state</small>
                </span>
              </div>
              <div>
                <Gauge aria-hidden="true" size={18} />
                <span>
                  <b>2–12 hours</b>
                  <small>Initial synchronization estimate</small>
                </span>
              </div>
              <div>
                <Database aria-hidden="true" size={18} />
                <span>
                  <b>Persistent volume</b>
                  <small>Zallet wallet.db + identity</small>
                </span>
              </div>
              <a href="https://github.com/ZcashFoundation/z3" target="_blank" rel="noreferrer">
                Z3 documentation <ExternalLink aria-hidden="true" size={13} />
              </a>
            </article>
          </aside>
        </section>
      )}
      {tab === "safety" && (
        <section className="safety-layout" role="tabpanel" id="panel-safety" aria-labelledby="tab-safety">
          <div className="safety-principles">
            <Safety
              icon={<KeyRound aria-hidden="true" size={21} />}
              title="Key isolation"
              text="When using a Zallet deployment, the spending key must remain in the wallet keystore. The ZechLedger client bundle contains no secrets; actual custody must be verified separately from the deployment configuration."
            />
            <Safety
              icon={<ShieldCheck aria-hidden="true" size={21} />}
              title="Network separation"
              text="Before every send, an independent Zebra getblockchaininfo result must be test/testnet; any other network is rejected with HTTP 409."
            />
            <Safety
              icon={<LockKeyhole aria-hidden="true" size={21} />}
              title="Deny by default"
              text="Broadcasting also requires ZCASH_ALLOW_SEND=true. An inadvertently running RPC cannot authorize spending by itself."
            />
            <Safety
              icon={<Fingerprint aria-hidden="true" size={21} />}
              title="Minimal-data memo"
              text="The memo contains an invoice code and metadata-commitment prefix, not PII. The 512-byte limit is validated in UTF-8 bytes."
            />
          </div>
          <article className="panel threat-card">
            <div className="panel__header">
              <div>
                <span className="eyebrow">THREAT MODEL</span>
                <h3>What is and is not addressed?</h3>
              </div>
              <ShieldCheck aria-hidden="true" size={21} />
            </div>
            <table>
              <thead>
                <tr>
                  <th>RISK</th>
                  <th>CONTROL</th>
                  <th>RESIDUAL RISK</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Commercial graph on the public chain</td>
                  <td>Sapling/Orchard/Ironwood shielded transfer + FullPrivacy</td>
                  <td>Timing correlation</td>
                </tr>
                <tr>
                  <td>Wallet purpose-scope mixing</td>
                  <td>Allowlisted account ↔ purpose-vault mapping + UFVK fingerprint</td>
                  <td>Periods are not separate wallet accounts</td>
                </tr>
                <tr>
                  <td>Accidental mainnet payment</td>
                  <td>Chain assertion + address prefix + env lock</td>
                  <td>Operator configuration responsibility</td>
                </tr>
                <tr>
                  <td>Public light server metadata</td>
                  <td>Self-hosted Z3/Zaino, TLS, independent height check</td>
                  <td>IP and traffic analysis</td>
                </tr>
                <tr>
                  <td>Post hoc ledger modification</td>
                  <td>Hash chain + signed manifest/wallet observation</td>
                  <td>Local endpoint security</td>
                </tr>
              </tbody>
            </table>
            <div className="threat-foot">
              <CircleOff aria-hidden="true" size={16} />
              <span>
                This demo does not produce a “zero-knowledge balance-sheet proof.” When an account-scoped wallet
                observation is available, the shielded transaction record, viewing scope, and metadata integrity are
                bound as separate evidence.
              </span>
            </div>
          </article>
          <article className="reset-card">
            <RotateCcw aria-hidden="true" size={20} />
            <div>
              <b>Reset presentation data</b>
              <span>
                Restores the local synthetic, date-relative invoice, transaction, and journal fixtures to their initial
                state. Does not affect the live testnet.
              </span>
            </div>
            <button
              className="button button--danger"
              onClick={() => void resetDemo()}
              disabled={busy !== null || data.state.mode !== "demo"}
            >
              {busy === "reset" ? <InlineSpinner /> : <RotateCcw aria-hidden="true" size={15} />}{" "}
              {data.state.mode === "demo" ? "Reset" : "Disabled in live mode"}
            </button>
          </article>
        </section>
      )}
    </FolioView>
  );
}

function Step({ number, title, text, code }: { number: string; title: string; text: string; code: string }) {
  return (
    <div className="setup-step">
      <span>{number}</span>
      <div>
        <h4>{title}</h4>
        <p>{text}</p>
        <pre>
          <code>{code}</code>
          <CopyButton value={code} compact />
        </pre>
      </div>
    </div>
  );
}
function Safety({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <article>
      <div>{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}
