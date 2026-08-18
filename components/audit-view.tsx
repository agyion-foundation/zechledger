"use client";

import {
  Archive,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Radio,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { FolioPageHeader, FolioView } from "@/components/folio";
import { CopyButton, HashText, InlineSpinner, StatusBadge } from "@/components/primitives";
import type { ViewProps } from "@/components/view-types";
import { formatTry, maskAddress, receiverCapabilityLabel } from "@/lib/money";
import { accountingMonth } from "@/lib/accounting-date";

export function AuditView({ data, refresh, notify, busy, setBusy }: ViewProps) {
  const nowPeriod = accountingMonth();
  const [vaultId, setVaultId] = useState(data.state.vaults[0]?.id ?? "");
  const [period, setPeriod] = useState(nowPeriod);
  const [anchor, setAnchor] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const selectedVault = data.state.vaults.find((vault) => vault.id === vaultId)!;
  const hasRealViewingKey = selectedVault.viewingKeySource === "env" && Boolean(selectedVault.viewingKeyFingerprint);
  const scopedWalletReady =
    data.node.safeTestnet &&
    data.node.walletReachable &&
    data.node.walletSynchronized &&
    data.node.nodeSource !== "legacy";
  const anchorEligible =
    data.state.mode === "live" &&
    data.node.sendReady &&
    scopedWalletReady &&
    ["env", "stale"].includes(selectedVault.metadataSource) &&
    selectedVault.addressSource === "env" &&
    hasRealViewingKey;
  const scopedTransactions = data.state.transactions.filter(
    (tx) =>
      tx.source === "rpc" &&
      (tx.vaultId === vaultId || tx.sourceVaultId === vaultId || tx.destinationVaultId === vaultId) &&
      accountingMonth(new Date(tx.timestamp)) === period &&
      tx.status === "confirmed" &&
      tx.observationState !== "orphan-candidate" &&
      tx.confirmations >= data.state.settings.minConfirmations &&
      /^[0-9a-f]{64}$/i.test(tx.txid) &&
      Boolean(tx.observationHash) &&
      tx.blockHeight !== undefined,
  );
  const scopedTxids = new Set(scopedTransactions.map((transaction) => transaction.txid));
  const scopedJournals = data.state.journals.filter(
    (entry) =>
      entry.vaultId === vaultId &&
      (entry.date.startsWith(period) || Boolean(entry.chainTxid && scopedTxids.has(entry.chainTxid))),
  );
  const supportingJournalCount = scopedJournals.filter((entry) => !entry.date.startsWith(period)).length;
  const lastSyncAtMs = Date.parse(data.state.settings.lastSyncAt ?? "");
  const walletEvidenceFresh =
    scopedTransactions.length === 0 ||
    (Number.isFinite(lastSyncAtMs) &&
      Date.now() - lastSyncAtMs <= 15 * 60 * 1000 &&
      Date.now() >= lastSyncAtMs &&
      Boolean(data.state.settings.lastSyncToken) &&
      Boolean(data.state.settings.lastSyncScope) &&
      scopedTransactions.every(
        (transaction) =>
          transaction.lastObservedAt === data.state.settings.lastSyncAt &&
          transaction.syncScope === data.state.settings.lastSyncScope,
      ));
  const canAnchor = anchorEligible && walletEvidenceFresh;
  useEffect(() => {
    setAnchor(false);
  }, [vaultId, period, canAnchor]);
  async function createCapsule(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (
      anchor &&
      canAnchor &&
      !window.confirm(
        `Broadcast 0.00001000 test ZEC plus the network fee to the document-bound self-transfer address for the ${selectedVault.name} / ${period} capsule? This broadcast cannot be reversed.`,
      )
    )
      return;
    setBusy("audit");
    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, vaultId, period, anchor: anchor && canAnchor }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.rotateRequestId) setRequestId(crypto.randomUUID());
        throw new Error(payload.error ?? "The audit capsule could not be generated.");
      }
      const refreshed = await refresh();
      setRequestId(crypto.randomUUID());
      const capsuleStatus = payload.capsule?.status;
      const successMessage =
        capsuleStatus === "anchored"
          ? "The capsule was previously confirmed with a wallet observation."
          : capsuleStatus === "pending"
            ? payload.operationId
              ? "The anchor was submitted to Zallet; awaiting chain confirmation."
              : "The anchor outbox outcome is unknown; it was not resubmitted and will be reconciled during synchronization."
            : "The signed audit capsule is ready to download.";
      notify(
        refreshed
          ? successMessage
          : "The capsule was generated, but the latest sharing log could not be loaded. Try again.",
        refreshed ? (capsuleStatus === "pending" ? "info" : "success") : "error",
      );
      const blob = new Blob([JSON.stringify({ capsule: payload.capsule, manifest: payload.manifest }, null, 2)], {
        type: "application/json",
      });
      const download = document.createElement("a");
      download.href = URL.createObjectURL(blob);
      download.download = `zechledger-audit-${period}.json`;
      download.click();
      URL.revokeObjectURL(download.href);
    } catch (cause) {
      notify((cause as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }
  return (
    <FolioView className="folio-view--audit">
      <FolioPageHeader
        overline="Evidence and disclosure scope"
        title="Show each verification claim separately"
        description="Signature, trust, ledger integrity, and anchoring are separate checks."
      />
      <section className="evidence-matrix" aria-labelledby="evidence-matrix-title">
        <header>
          <div>
            <span className="folio-overline">Evidence matrix</span>
            <h3 id="evidence-matrix-title">Available verification layers</h3>
          </div>
          <p>Unknown or unperformed checks are not shown in green.</p>
        </header>
        <div className="evidence-matrix__rows">
          <article>
            <div className="evidence-matrix__icon">
              <Radio aria-hidden="true" size={18} />
            </div>
            <div>
              <h4>Public testnet connection</h4>
              <p>A block, txid, and confirmation count do not prove the shielded party, amount, or memo.</p>
            </div>
            <span
              className={`evidence-state ${data.node.reachable && data.node.safeTestnet ? "is-positive" : "is-unknown"}`}
            >
              {data.node.reachable && data.node.safeTestnet
                ? `Zebra #${data.node.blocks?.toLocaleString("en-US") ?? "—"}`
                : "Could not be verified"}
            </span>
          </article>
          <article>
            <div className="evidence-matrix__icon">
              <Fingerprint aria-hidden="true" size={18} />
            </div>
            <div>
              <h4>Authorized account-scoped wallet observation</h4>
              <p>A viewing-authority observation and memo match do not establish sender identity.</p>
            </div>
            <span className={`evidence-state ${scopedWalletReady ? "is-positive" : "is-unknown"}`}>
              {scopedWalletReady
                ? `Synchronized #${data.node.walletHeight?.toLocaleString("en-US") ?? "—"}`
                : "Could not be verified"}
            </span>
          </article>
          <article>
            <div className="evidence-matrix__icon">
              <ShieldCheck aria-hidden="true" size={18} />
            </div>
            <div>
              <h4>Journal and hash-chain integrity</h4>
              <p>This checks balance and the hash chain; it is not proof of ledger completeness or solvency.</p>
            </div>
            <span className={`evidence-state ${data.metrics.journalBalanced ? "is-positive" : "is-danger"}`}>
              {data.metrics.journalBalanced ? `${data.state.journals.length} valid records` : "Integrity issue"}
            </span>
          </article>
          <article>
            <div className="evidence-matrix__icon">
              <Archive aria-hidden="true" size={18} />
            </div>
            <div>
              <h4>Signed capsule and anchor receipt</h4>
              <p>
                Ed25519 validity is checked; trust in the institutional signer must be established through a separate
                channel.
              </p>
            </div>
            <span className={`evidence-state ${data.state.auditCapsules.length ? "is-neutral" : "is-unknown"}`}>
              {data.state.auditCapsules.length
                ? `${data.state.auditCapsules.length} capsules · ${data.state.auditCapsules.filter((capsule) => capsule.status === "anchored").length} anchors`
                : "Not generated yet"}
            </span>
          </article>
        </div>
      </section>
      <div className="audit-layout">
        <form className="panel capsule-builder" onSubmit={createCapsule}>
          <div className="panel__header">
            <div>
              <span className="eyebrow">AUDIT CAPSULE</span>
              <h3>Generate shareable evidence</h3>
            </div>
            <Archive aria-hidden="true" size={20} />
          </div>
          <fieldset className="field vault-field">
            <legend>Purpose vault / fund</legend>
            <div className="audit-vaults">
              {data.state.vaults.map((vault) => (
                <button
                  type="button"
                  key={vault.id}
                  aria-pressed={vaultId === vault.id}
                  className={vaultId === vault.id ? "is-active" : ""}
                  onClick={() => setVaultId(vault.id)}
                >
                  <i aria-hidden="true" style={{ background: vault.color }} />
                  <div>
                    <b>{vault.name}</b>
                    <span>{vault.purpose}</span>
                  </div>
                </button>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>Fiscal month scope</span>
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required />
          </label>
          <div className="scope-preview">
            <div className="scope-preview__head">
              <Eye aria-hidden="true" size={17} />
              <span>Disclosure preview</span>
            </div>
            <dl className="disclosure-contract">
              <div>
                <dt>Purpose vault</dt>
                <dd>{selectedVault.name}</dd>
              </div>
              <div>
                <dt>Period</dt>
                <dd>{period}</dd>
              </div>
              <div>
                <dt>Signed timestamp field</dt>
                <dd>The generation time is bound to the manifest.generatedAt field</dd>
              </div>
            </dl>
            <div className="scope-preview__group">
              <b>Included fields</b>
              <ul>
                <li>
                  <CheckCircle2 aria-hidden="true" size={15} />
                  <span>
                    Signed scope: vaultId, vault name/purpose, metadata/account fingerprints, selected month, Istanbul
                    time policy, and minimum confirmation threshold
                  </span>
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={15} />
                  <span>
                    {scopedJournals.length} journal entries and hash-chain linkage
                    {supportingJournalCount
                      ? ` · ${supportingJournalCount} out-of-period settlement/adjustment entries`
                      : ""}
                  </span>
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={15} />
                  <span>
                    {scopedTransactions.length} wallet-observed transactions: canonicalId/txid, mined timestamp, latest
                    observation/sync scope, confirmations/block at observation time, direction, amount/fee, memo,
                    destination address, pool/source, document links, and all vault/account fingerprint fields
                  </span>
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={15} />
                  <span>
                    For intra-vault transfers involving the selected vault, the counterparty vaultId and account
                    fingerprint may also appear in the transaction record
                  </span>
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={15} />
                  <span>
                    Complete commitment payload: document/request IDs and number, kind/scopeRoles, identityCommitment,
                    customer/supplier, category/description, issuer and issuer fingerprint, dates, VAT, canonical
                    TRY/ZEC amounts, valuation source, vault, full address, and account fingerprint
                  </span>
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={15} />
                  <span>Metadata commitments, manifest hash, Ed25519 signature, and signing-key fingerprint</span>
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={15} />
                  <span>
                    If anchoring is selected, the plan includes the full destination address, account fingerprint, and
                    1,000 zatoshis; the receipt includes the txid, height/confirmations, observedAt, full observed
                    destination, full memo, amount, and account fingerprint
                  </span>
                </li>
                <li>
                  <CheckCircle2 aria-hidden="true" size={15} />
                  <span>
                    {hasRealViewingKey ? (
                      <>
                        UFVK as a fingerprint only: <HashText value={selectedVault.viewingKeyFingerprint!} chars={8} />
                      </>
                    ) : (
                      "UFVK is not configured; no viewing-authority claim is made"
                    )}
                  </span>
                </li>
              </ul>
            </div>
            <div className="scope-blocked">
              <EyeOff aria-hidden="true" size={15} />
              <span>
                <b>Excluded:</b> documents and journal entries for vaults not directly selected, the wallet recovery
                seed phrase, spending key, and UFVK itself. The cross-scope identities for intra-vault transfers are the
                exception above.
              </span>
            </div>
            <p className="disclosure-note">
              The counts shown here are a live preliminary calculation; the server reconstructs the manifest scope
              during generation, and only the returned JSON determines the signed scope.
            </p>
            <p className="disclosure-note">
              The person/organization receiving the capsule and the reason for disclosure are not signed manifest
              fields; maintain a separate disclosure log for them.
            </p>
          </div>
          <label className="anchor-toggle">
            <input
              type="checkbox"
              checked={anchor && canAnchor}
              disabled={!canAnchor}
              onChange={(e) => setAnchor(e.target.checked)}
            />
            <span>
              <i>
                <Radio aria-hidden="true" size={16} />
              </i>
              <p>
                <b>Wallet-observed testnet anchor</b>
                <small>
                  {canAnchor
                    ? "Places the digest in an encrypted self-transfer memo; after confirmation, the txid and height are separately signed with Ed25519. This is not an independent decryption proof."
                    : !walletEvidenceFresh
                      ? "The scoped wallet records require an exact sync completed within the past 15 minutes."
                      : "Requires live mode, an account-scoped synchronized wallet, open broadcast gates, FullPrivacy, an env-provided address/UFVK, and a same-account mapping verified by the server."}
                </small>
              </p>
            </span>
          </label>
          <button className="button button--primary button--wide" disabled={busy !== null || !walletEvidenceFresh}>
            {busy === "audit" ? <InlineSpinner /> : <Archive aria-hidden="true" size={17} />}{" "}
            {anchor && canAnchor ? "Generate capsule, broadcast anchor & download" : "Generate capsule & download"}
          </button>
          <a className="button button--ghost button--wide" href="/api/audit/public-key" download>
            <KeyRound aria-hidden="true" size={16} /> Download Ed25519 public key
          </a>
          <p className="builder-footnote">
            Share the public key through a separate trusted channel and compare its fingerprint. The UFVK is not
            included in the package; only its fingerprint is bound. Two files downloaded from the same server do not
            alone establish a trust root.
          </p>
        </form>
        <aside className="audit-scope-card">
          <div className="audit-scope-card__top">
            <span className="eyebrow eyebrow--on-dark">SELECTED SCOPE</span>
            <StatusBadge status="active" />
          </div>
          <h3>{selectedVault.name}</h3>
          <p>
            {selectedVault.purpose} · capsule month {period}
          </p>
          <div className="audit-scope-stats">
            <div>
              <span>REFERENCE BUDGET</span>
              <b>{formatTry(selectedVault.budgetTry, true)}</b>
            </div>
            <div>
              <span>CAPSULE TRANSACTIONS</span>
              <b>{scopedTransactions.length}</b>
            </div>
            <div>
              <span>POOL</span>
              <b>{receiverCapabilityLabel(selectedVault.pool)}</b>
            </div>
          </div>
          <div className="key-fingerprint">
            <KeyRound aria-hidden="true" size={17} />
            <div>
              <span>
                {hasRealViewingKey
                  ? "UFVK FINGERPRINT · ENV"
                  : selectedVault.viewingKeyFingerprint
                    ? "PRESENTATION FINGERPRINT · NO AUTHORITY CLAIM"
                    : "VIEWING KEY · NOT CONFIGURED"}
              </span>
              <code>{selectedVault.viewingKeyFingerprint ?? "—"}</code>
            </div>
            {selectedVault.viewingKeyFingerprint && <CopyButton value={selectedVault.viewingKeyFingerprint} compact />}
          </div>
          <div className="scope-address">
            <span>{receiverCapabilityLabel(selectedVault.pool).toUpperCase()}</span>
            <code>{maskAddress(selectedVault.address, 14, 10)}</code>
          </div>
          <div className="scope-divider" />
          <ul className="audit-guarantees">
            <li>
              <CheckCircle2 aria-hidden="true" size={15} /> The auditor reads only resolved records included in the
              capsule
            </li>
            <li>
              <CheckCircle2 aria-hidden="true" size={15} /> Can match record metadata digests
            </li>
            <li>
              <LockKeyhole aria-hidden="true" size={15} /> Cannot spend ZEC or sign transactions
            </li>
          </ul>
        </aside>
      </div>
      <section className="panel capsules-list">
        <div className="panel__header">
          <div>
            <span className="eyebrow">PAST CAPSULES</span>
            <h3>Audit disclosure log</h3>
          </div>
          <span>{data.state.auditCapsules.length} packages</span>
        </div>
        {data.state.auditCapsules.length ? (
          <div className="capsule-rows">
            {data.state.auditCapsules.map((capsule) => (
              <div key={capsule.id}>
                <div className="capsule-icon">
                  <Archive aria-hidden="true" size={18} />
                </div>
                <div className="capsule-name">
                  <b>{capsule.name}</b>
                  <span>
                    {new Date(capsule.createdAt).toLocaleString("en-US")} · {capsule.entryCount} records · key{" "}
                    {capsule.signingKeyFingerprint.slice(0, 10)}… ·{" "}
                    {(capsule.manifest as { protocol?: string }).protocol === "zechledger-audit-capsule/3"
                      ? "v3"
                      : "legacy v2 · read-only"}
                  </span>
                </div>
                <div className="capsule-hash">
                  <span>MANIFEST SHA-256</span>
                  <HashText value={capsule.manifestHash} chars={8} />
                </div>
                <StatusBadge status={capsule.status} />
                {capsule.anchorTxid ? (
                  <HashText value={capsule.anchorTxid} chars={5} />
                ) : capsule.operationId ? (
                  <span className="operation-label">Wallet operation pending…</span>
                ) : null}
                <a
                  className="icon-button icon-button--light"
                  aria-label={`Download ${capsule.name} capsule`}
                  href={`/api/audit/${capsule.id}`}
                  download
                >
                  <Download aria-hidden="true" size={16} />
                </a>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state empty-state--compact">
            <Archive aria-hidden="true" size={25} />
            <h3>No capsules yet</h3>
            <p>Generate the first verifiable scope package above.</p>
          </div>
        )}
      </section>
      <section className="audit-caveats">
        <div>
          <RotateCcw aria-hidden="true" size={19} />
          <p>
            <b>Honest authority model</b>
            <span>
              A viewing key cannot be “revoked” at the chain level. Rotate access at the end of the period by moving to
              a new purpose vault.
            </span>
          </p>
        </div>
        <div>
          <ShieldCheck aria-hidden="true" size={19} />
          <p>
            <b>Testnet warning</b>
            <span>
              Testnet has a smaller anonymity set. IP addresses, timing, and local server metadata must be protected
              separately.
            </span>
          </p>
        </div>
        <div>
          <Fingerprint aria-hidden="true" size={19} />
          <p>
            <b>No custom-cryptography claim</b>
            <span>
              The capsule binds resolved wallet records, document/journal digests, and the Ed25519 signature. It makes
              no claim of a zero-knowledge balance proof or a global Merkle inclusion proof.
            </span>
          </p>
        </div>
      </section>
    </FolioView>
  );
}
