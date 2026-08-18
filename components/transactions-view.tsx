"use client";

import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Fingerprint,
  Globe2,
  LockKeyhole,
  RefreshCw,
  ScanEye,
  ShieldCheck,
  Waypoints,
} from "lucide-react";
import { useMemo, useState } from "react";
import { FolioPageHeader, FolioView, useCompactReviewLayout } from "@/components/folio";
import { HashText, InlineSpinner, Modal, StatusBadge } from "@/components/primitives";
import type { ViewProps } from "@/components/view-types";
import { formatZec } from "@/lib/money";
import type { ChainTransaction } from "@/lib/types";

type Lens = "public" | "owner" | "auditor";

function hasWalletMinedPlacement(tx: ChainTransaction) {
  return (
    tx.source === "rpc" &&
    Boolean(tx.observationHash) &&
    /^[0-9a-f]{64}$/i.test(tx.txid) &&
    tx.blockHeight !== undefined &&
    tx.observationState !== "orphan-candidate" &&
    ["confirmed", "pending"].includes(tx.status)
  );
}

function publicWalletStatusLabel(tx: ChainTransaction) {
  if (!hasWalletMinedPlacement(tx)) return "No public observation";
  return tx.status === "confirmed" ? "Wallet: mined" : "Wallet: pending";
}

export function TransactionsView({ data, refresh, notify, busy, setBusy }: ViewProps) {
  const [lens, setLens] = useState<Lens>("owner");
  const [vaultId, setVaultId] = useState(data.state.vaults[0]?.id ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const compactReview = useCompactReviewLayout();
  const documentNumbers = useMemo(
    () =>
      new Map([
        ...data.state.invoices.map((invoice) => [invoice.id, invoice.number] as const),
        ...data.state.expenses.map((expense) => [expense.id, expense.number] as const),
      ]),
    [data.state.expenses, data.state.invoices],
  );
  const transactions = useMemo(
    () =>
      [...data.state.transactions]
        .filter((tx) => {
          if (lens === "public") return hasWalletMinedPlacement(tx);
          if (lens !== "auditor") return true;
          return tx.vaultId === vaultId || tx.sourceVaultId === vaultId || tx.destinationVaultId === vaultId;
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [data.state.transactions, lens, vaultId],
  );
  const selected = selectedId ? (transactions.find((transaction) => transaction.id === selectedId) ?? null) : null;
  const matched = data.state.transactions.filter((tx) => tx.invoiceId || tx.expenseId).length;
  const chainObserved = data.state.transactions.filter(hasWalletMinedPlacement);
  const walletMinedConfirmedCount = chainObserved.filter((tx) => tx.status === "confirmed").length;
  const observedShieldedCount = chainObserved.filter((tx) => tx.pool !== "Transparent").length;

  async function sync() {
    if (busy) return;
    setBusy("sync");
    try {
      const response = await fetch("/api/zcash/sync", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Synchronization failed.");
      const refreshed = await refresh();
      notify(
        refreshed
          ? `${payload.observed} chain outputs scanned; ${payload.matched} records matched.`
          : "The scan completed, but the latest view could not be loaded. Try again.",
        refreshed ? "success" : "error",
      );
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <FolioView className="folio-view--transactions">
      <FolioPageHeader
        overline="Reconciliation workspace"
        title="Link wallet observations to accounting records"
        description="The public chain, wallet observations, and local vault filtering are distinct scopes."
        actions={
          <button
            className="button button--primary"
            onClick={() => void sync()}
            disabled={busy !== null || !data.node.walletReachable}
          >
            {busy === "sync" ? <InlineSpinner /> : <RefreshCw aria-hidden="true" size={17} />}{" "}
            {data.node.walletReachable ? "Run wallet scan" : "Zallet connection required"}
          </button>
        }
      />

      <div className="lens-switcher" role="radiogroup" aria-label="Privacy view">
        <button
          type="button"
          role="radio"
          aria-checked={lens === "public"}
          className={lens === "public" ? "is-active" : ""}
          onClick={() => setLens("public")}
        >
          <div>
            <Globe2 aria-hidden="true" size={20} />
          </div>
          <span>
            <b>Public-chain simulation</b>
            <small>Owner-side preview</small>
          </span>
          {lens === "public" && <CheckCircle2 aria-hidden="true" size={16} />}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={lens === "owner"}
          className={lens === "owner" ? "is-active" : ""}
          onClick={() => setLens("owner")}
        >
          <div>
            <Eye aria-hidden="true" size={20} />
          </div>
          <span>
            <b>Business view</b>
            <small>Local accounting and wallet data</small>
          </span>
          {lens === "owner" && <CheckCircle2 aria-hidden="true" size={16} />}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={lens === "auditor"}
          className={lens === "auditor" ? "is-active" : ""}
          onClick={() => setLens("auditor")}
        >
          <div>
            <ScanEye aria-hidden="true" size={20} />
          </div>
          <span>
            <b>Vault-filter preview</b>
            <small>Not the capsule scope</small>
          </span>
          {lens === "auditor" && <CheckCircle2 aria-hidden="true" size={16} />}
        </button>
      </div>

      {lens === "auditor" && (
        <section className="auditor-scope">
          <span>OWNER-SIDE VAULT FILTER</span>
          {data.state.vaults.map((vault) => (
            <button
              key={vault.id}
              aria-pressed={vaultId === vault.id}
              className={vaultId === vault.id ? "is-active" : ""}
              onClick={() => setVaultId(vault.id)}
            >
              <i style={{ background: vault.color }} />
              {vault.name}
              <small>{vault.period}</small>
            </button>
          ))}
          <em>
            Warning: this is only a DOM filter; the administrator network response contains the full state. A real
            auditor must receive only the server-scoped JSON generated from the Audit & Evidence area.
          </em>
        </section>
      )}

      <section className={`privacy-explainer privacy-explainer--${lens}`}>
        <div className="privacy-explainer__icon">
          {lens === "public" ? (
            <EyeOff aria-hidden="true" size={25} />
          ) : lens === "owner" ? (
            <Fingerprint aria-hidden="true" size={25} />
          ) : (
            <ShieldCheck aria-hidden="true" size={25} />
          )}
        </div>
        <div>
          <span>
            {lens === "public"
              ? "Public-chain fields"
              : lens === "owner"
                ? "Authorized wallet observation"
                : "Owner-side vault filter"}
          </span>
          <h3>
            {lens === "public"
              ? "Shielded details cannot be verified through an explorer."
              : lens === "owner"
                ? "From wallet observation to accounting record."
                : "This filter is not the signed capsule scope."}
          </h3>
        </div>
        <ul>
          <li>
            <b>{lens === "public" ? "Per record" : `${transactions.length} records`}</b>
            <span>Parties</span>
          </li>
          <li>
            <b>
              {lens === "public"
                ? "Pool-dependent"
                : `${formatZec(transactions.reduce((sum, tx) => sum + BigInt(tx.zatoshi), 0n).toString(), 3)} ZEC`}
            </b>
            <span>Amount coverage</span>
          </li>
          <li>
            <b>
              {lens === "public"
                ? "Encrypted"
                : `${transactions.length ? Math.round((transactions.filter((tx) => tx.invoiceId || tx.expenseId).length / transactions.length) * 100) : 0}%`}
            </b>
            <span>Local-record linkage</span>
          </li>
        </ul>
      </section>

      {lens !== "public" && (
        <section className="mini-stats-row">
          <div>
            <Waypoints aria-hidden="true" size={18} />
            <span>
              <b>{data.state.transactions.length}</b> local records
            </span>
          </div>
          <div>
            <CheckCircle2 aria-hidden="true" size={18} />
            <span>
              <b>{walletMinedConfirmedCount}</b> wallet-mined records
            </span>
          </div>
          <div>
            <Fingerprint aria-hidden="true" size={18} />
            <span>
              <b>{matched}</b> local document links
            </span>
          </div>
          <div>
            <ShieldCheck aria-hidden="true" size={18} />
            <span>
              <b>{observedShieldedCount}</b> wallet-observed shielded records
            </span>
          </div>
        </section>
      )}

      <article className="panel table-panel">
        <div className="table-toolbar table-toolbar--plain">
          <div>
            <span className="eyebrow">TRANSACTION LOG</span>
            <h3>
              {lens === "public"
                ? "Public-field candidates from wallet records"
                : lens === "owner"
                  ? "Business transaction records"
                  : "Owner-side filter for the selected vault"}
            </h3>
          </div>
          <div className="source-legend">
            <span>
              <i className="live" />
              RPC / wallet record
            </span>
            <span>
              <i className="fixture" />
              Presentation fixture
            </span>
            <span>
              <i className="local" />
              Local outbox
            </span>
          </div>
        </div>
        {!compactReview && (
          <div className="data-table-wrap" role="region" aria-label="Chain transaction table" tabIndex={0}>
            <table className="data-table tx-table">
              <thead>
                <tr>
                  <th>TRANSACTION</th>
                  <th>{lens === "public" ? "SHIELDED ACTION" : "COUNTERPARTY"}</th>
                  <th>MEMO / MATCH</th>
                  <th>BLOCK</th>
                  <th>AMOUNT</th>
                  <th>STATUS</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id}>
                    <td>
                      <div className="tx-id-cell">
                        <span
                          className={
                            lens === "public"
                              ? "transaction-icon"
                              : `transaction-icon transaction-icon--${tx.direction}`
                          }
                        >
                          {lens === "public" ? (
                            <Globe2 aria-hidden="true" size={16} />
                          ) : tx.direction === "incoming" ? (
                            <ArrowDownLeft aria-hidden="true" size={16} />
                          ) : ["internal", "anchor"].includes(tx.direction) ? (
                            <Fingerprint aria-hidden="true" size={16} />
                          ) : (
                            <ArrowUpRight aria-hidden="true" size={16} />
                          )}
                        </span>
                        <div>
                          {lens === "public" && !hasWalletMinedPlacement(tx) ? (
                            <span>No public observation</span>
                          ) : (
                            <HashText value={tx.txid} chars={6} />
                          )}
                          <small>
                            {lens === "public" && !hasWalletMinedPlacement(tx)
                              ? "Not disclosed from the local record"
                              : `${new Date(tx.timestamp).toLocaleDateString("en-US", { day: "2-digit", month: "short" })} · ${tx.pool}`}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      {lens === "public" ? (
                        !hasWalletMinedPlacement(tx) ? (
                          <span>No public-chain observation</span>
                        ) : tx.pool === "Transparent" ? (
                          <span>Transparent output · public</span>
                        ) : (
                          <span className="shielded-value">
                            <EyeOff aria-hidden="true" size={14} /> Shielded action
                          </span>
                        )
                      ) : (
                        <>
                          <b>{tx.counterparty}</b>
                          <small>
                            {tx.direction === "internal"
                              ? `${data.state.vaults.find((v) => v.id === tx.sourceVaultId)?.name ?? "Unmapped source"} → ${data.state.vaults.find((v) => v.id === tx.destinationVaultId)?.name ?? "Unmapped destination"}`
                              : (data.state.vaults.find((v) => v.id === tx.vaultId)?.name ?? "Unmapped wallet account")}
                          </small>
                        </>
                      )}
                    </td>
                    <td>
                      {lens === "public" ? (
                        <code className="encrypted-memo">
                          {!hasWalletMinedPlacement(tx)
                            ? "No public observation"
                            : tx.pool === "Transparent"
                              ? "No memo · transparent"
                              : "Shielded memo · not publicly accessible"}
                        </code>
                      ) : (
                        <div className="memo-cell">
                          <code>{tx.memo || "No memo"}</code>
                          <small>
                            {tx.invoiceId
                              ? hasWalletMinedPlacement(tx) &&
                                tx.status === "confirmed" &&
                                data.node.nodeSource !== "legacy"
                                ? "Invoice wallet match"
                                : "Local invoice link"
                              : tx.expenseId
                                ? hasWalletMinedPlacement(tx) &&
                                  tx.status === "confirmed" &&
                                  data.node.nodeSource !== "legacy"
                                  ? "Expense wallet match"
                                  : "Local expense link"
                                : "Unclassified"}
                          </small>
                        </div>
                      )}
                    </td>
                    <td>
                      {lens === "public" ? (
                        hasWalletMinedPlacement(tx) ? (
                          <>
                            <b>#{tx.blockHeight?.toLocaleString("en-US")}</b>
                            <small>{tx.confirmations} confirmations</small>
                          </>
                        ) : (
                          <>
                            <b>no observation</b>
                            <small>no explorer evidence available</small>
                          </>
                        )
                      ) : tx.blockHeight && tx.status !== "failed" ? (
                        <>
                          <b>#{tx.blockHeight.toLocaleString("en-US")}</b>
                          <small>{tx.confirmations} confirmations</small>
                        </>
                      ) : tx.txid.startsWith("intent:") ? (
                        <>
                          <b>local outbox</b>
                          <small>not submitted to RPC / outcome unknown</small>
                        </>
                      ) : tx.txid.startsWith("opid:") ? (
                        <>
                          <b>Zallet operation</b>
                          <small>awaiting txid</small>
                        </>
                      ) : /^[0-9a-f]{64}$/i.test(tx.txid) ? (
                        <>
                          <b>no canonical inclusion</b>
                          <small>may be in the mempool, reorganized, or failed</small>
                        </>
                      ) : (
                        <>
                          <b>presentation record</b>
                          <small>no chain claim</small>
                        </>
                      )}
                    </td>
                    <td>
                      {lens === "public" && !hasWalletMinedPlacement(tx) ? (
                        <span className="hidden-amount">No public observation</span>
                      ) : lens === "public" && tx.pool !== "Transparent" ? (
                        <span className="hidden-amount">Shielded · not public</span>
                      ) : lens === "public" ? (
                        <b>{formatZec(tx.zatoshi, 4)} ZEC</b>
                      ) : (
                        <b className={tx.direction === "incoming" ? "positive" : ""}>
                          {["internal", "anchor"].includes(tx.direction)
                            ? "↔ "
                            : tx.direction === "incoming"
                              ? "+"
                              : "−"}
                          {formatZec(tx.zatoshi, 4)} ZEC
                          {["internal", "anchor"].includes(tx.direction) ? " · principal net 0" : ""}
                        </b>
                      )}
                    </td>
                    <td>
                      <StatusBadge
                        status={tx.observationState === "orphan-candidate" ? "warning" : tx.status}
                        label={
                          tx.observationState === "orphan-candidate"
                            ? "Absent from the latest exact scan"
                            : lens === "public"
                              ? publicWalletStatusLabel(tx)
                              : undefined
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="evidence-open-button"
                        data-modal-return={`transaction-${tx.id}`}
                        onClick={() => setSelectedId(tx.id)}
                        aria-label={
                          lens === "public" ? "Open record evidence details" : `Open evidence details for ${tx.txid}`
                        }
                      >
                        <ScanEye aria-hidden="true" size={14} /> Evidence
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {compactReview && (
          <ul className="review-task-list" aria-label="Mobile reconciliation task list">
            {transactions.map((tx) => {
              const linkedNumber = documentNumbers.get(tx.invoiceId ?? tx.expenseId ?? "");
              const hasCanonicalObservation =
                tx.source === "rpc" && Boolean(tx.observationHash) && /^[0-9a-f]{64}$/i.test(tx.txid);
              const unresolvedOutcome = tx.operationOutcome === "unknown" && !hasCanonicalObservation;
              const reason =
                lens === "public"
                  ? !hasWalletMinedPlacement(tx)
                    ? "No public-chain observation exists for this local record"
                    : tx.pool === "Transparent"
                      ? "Transparent transaction fields are public"
                      : "Shielded action · party, amount, and memo are not public"
                  : unresolvedOutcome
                    ? "Outcome unknown · not resubmitted"
                    : tx.source === "demo-fixture"
                      ? `Presentation fixture · ${linkedNumber ? `local link to ${linkedNumber}` : "no chain claim"}`
                      : linkedNumber
                        ? `Linked to ${linkedNumber}`
                        : tx.status === "confirmed"
                          ? "No accounting link"
                          : "Awaiting wallet observation";
              return (
                <li key={tx.id}>
                  <div className="review-task-list__meta">
                    <span>{lens === "public" && !hasWalletMinedPlacement(tx) ? "No public observation" : tx.pool}</span>
                    {lens === "public" && !hasWalletMinedPlacement(tx) ? (
                      <span>Local timestamp not disclosed</span>
                    ) : (
                      <time dateTime={tx.timestamp}>{new Date(tx.timestamp).toLocaleDateString("en-US")}</time>
                    )}
                  </div>
                  <div className="review-task-list__subject">
                    <div>
                      <b>
                        {lens === "public"
                          ? !hasWalletMinedPlacement(tx)
                            ? "Local record"
                            : tx.pool === "Transparent"
                              ? "Transparent transaction"
                              : "Shielded action"
                          : tx.counterparty}
                      </b>
                      <span>{reason}</span>
                    </div>
                    <StatusBadge
                      status={tx.observationState === "orphan-candidate" ? "warning" : tx.status}
                      label={
                        tx.observationState === "orphan-candidate"
                          ? "Absent from the latest exact scan"
                          : lens === "public"
                            ? publicWalletStatusLabel(tx)
                            : undefined
                      }
                    />
                  </div>
                  <div className="review-task-list__footer">
                    <b>
                      {lens === "public" && !hasWalletMinedPlacement(tx)
                        ? "No public amount observation"
                        : lens === "public" && tx.pool !== "Transparent"
                          ? "Amount is not public"
                          : lens === "public"
                            ? `${formatZec(tx.zatoshi, 4)} ZEC`
                            : `${["internal", "anchor"].includes(tx.direction) ? "↔" : tx.direction === "incoming" ? "+" : "−"} ${formatZec(tx.zatoshi, 4)} ZEC`}
                    </b>
                    <button
                      type="button"
                      data-modal-return={`transaction-${tx.id}`}
                      onClick={() => setSelectedId(tx.id)}
                    >
                      Open evidence <ArrowRight aria-hidden="true" size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {transactions.length === 0 && (
          <div className="empty-state empty-state--compact">
            <Globe2 aria-hidden="true" size={24} />
            <h3>No wallet mined-placement records in this scope</h3>
          </div>
        )}
        <div className="table-footer">
          <span>
            {transactions.length} {lens === "public" ? "wallet-reported mined records" : "local transaction records"} ·{" "}
            {lens === "auditor"
              ? "visual owner-side filter only"
              : lens === "public"
                ? "excluding owner-local records"
                : "all vaults"}
          </span>
          <span>
            Last RPC check:{" "}
            {new Date(data.node.lastCheckedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      </article>
      <TransactionModal tx={selected} onClose={() => setSelectedId(null)} data={data} lens={lens} />
    </FolioView>
  );
}

function TransactionModal({
  tx,
  onClose,
  data,
  lens,
}: {
  tx: ChainTransaction | null;
  onClose: () => void;
  data: ViewProps["data"];
  lens: Lens;
}) {
  if (!tx) return null;
  const invoice = data.state.invoices.find((item) => item.id === tx.invoiceId);
  const expense = data.state.expenses.find((item) => item.id === tx.expenseId);
  const linkedDocument = invoice ?? expense;
  const documentJournalEntries = linkedDocument
    ? data.state.journals.filter(
        (entry) =>
          entry.sourceType === "payment" && entry.sourceId === linkedDocument.id && entry.chainTxid === tx.txid,
      )
    : [];
  const documentJournalNet = documentJournalEntries.reduce(
    (net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1),
    0,
  );
  const linkedJournal =
    tx.status === "confirmed" && documentJournalNet > 0
      ? documentJournalEntries.filter((entry) => !entry.description.startsWith("REORG REVERSAL")).at(-1)
      : undefined;
  const canonicalWalletObservation =
    tx.source === "rpc" && Boolean(tx.observationHash) && /^[0-9a-f]{64}$/i.test(tx.txid);
  const currentWalletObservation =
    canonicalWalletObservation && tx.status !== "failed" && tx.observationState !== "orphan-candidate";
  const scopedWalletObservation = currentWalletObservation && data.node.nodeSource !== "legacy";
  const walletMinedPlacement =
    currentWalletObservation && tx.blockHeight !== undefined && ["confirmed", "pending"].includes(tx.status);
  const confirmationsReady = walletMinedPlacement && tx.confirmations >= data.state.settings.minConfirmations;
  const settlementMatched =
    scopedWalletObservation && tx.status === "confirmed" && confirmationsReady && Boolean(linkedDocument);
  const observedAccount = tx.accountFingerprint ?? tx.sourceAccountFingerprint;
  return (
    <Modal
      open={Boolean(tx)}
      onClose={onClose}
      eyebrow="TRANSACTION EVIDENCE"
      title="Observation and accounting trail"
      size="large"
      variant="drawer"
    >
      <div className="tx-detail-head">
        <div className={lens === "public" ? "transaction-icon" : `transaction-icon transaction-icon--${tx.direction}`}>
          {lens === "public" ? (
            <Globe2 aria-hidden="true" size={20} />
          ) : tx.direction === "incoming" ? (
            <ArrowDownLeft aria-hidden="true" size={20} />
          ) : ["internal", "anchor"].includes(tx.direction) ? (
            <Fingerprint aria-hidden="true" size={20} />
          ) : (
            <ArrowUpRight aria-hidden="true" size={20} />
          )}
        </div>
        <div>
          <b>
            {lens === "public"
              ? !walletMinedPlacement
                ? "No public-field observation"
                : tx.pool === "Transparent"
                  ? "Transparent transaction candidate"
                  : "Shielded action candidate"
              : tx.counterparty}
          </b>
          <span>
            {lens === "public"
              ? walletMinedPlacement
                ? `Wallet-record timestamp · ${new Date(tx.timestamp).toLocaleString("en-US")}`
                : "Local timestamp not disclosed"
              : new Date(tx.timestamp).toLocaleString("en-US")}
          </span>
        </div>
        <StatusBadge
          status={
            tx.observationState === "orphan-candidate"
              ? "warning"
              : lens === "public" && !walletMinedPlacement
                ? "unknown"
                : tx.status
          }
          label={
            tx.observationState === "orphan-candidate"
              ? "Absent from the latest exact scan"
              : lens === "public"
                ? publicWalletStatusLabel(tx)
                : undefined
          }
        />
      </div>
      <section className="evidence-report" aria-labelledby="transaction-evidence-title">
        <div className="evidence-report__heading">
          <div>
            <span className="folio-overline">Evidence steps</span>
            <h3 id="transaction-evidence-title">Checks performed for this record</h3>
          </div>
          <small>
            {lens === "public"
              ? walletMinedPlacement
                ? `Wallet mined-placement timestamp · ${new Date(tx.timestamp).toLocaleString("en-US")}`
                : "No public timestamp observation"
              : `${tx.lastObservedAt ? "Latest wallet observation" : "Record timestamp"} · ${new Date(tx.lastObservedAt ?? tx.timestamp).toLocaleString("en-US")}`}
          </small>
        </div>
        <ol className="evidence-ladder">
          <EvidenceCheck
            label="Record source"
            result={
              lens === "public"
                ? walletMinedPlacement
                  ? "Wallet-reported txid and block fields"
                  : "No public-chain observation"
                : tx.source === "rpc"
                  ? scopedWalletObservation
                    ? "Account-scoped wallet observation"
                    : canonicalWalletObservation
                      ? data.node.nodeSource === "legacy"
                        ? "Legacy whole-wallet observation"
                        : "Previous wallet observation"
                      : "RPC outbox / observation incomplete"
                  : tx.source === "demo-fixture"
                    ? "Presentation fixture"
                    : "Local record"
            }
            detail={
              lens === "public"
                ? "The local record source and wallet commitment are not disclosed in this view."
                : canonicalWalletObservation
                  ? `Observation commitment: ${tx.observationHash?.slice(0, 12)}…`
                  : "This step alone is not chain evidence."
            }
            tone={
              lens === "public"
                ? "neutral"
                : scopedWalletObservation
                  ? "positive"
                  : canonicalWalletObservation && tx.status === "failed"
                    ? "warning"
                    : "neutral"
            }
          />
          <EvidenceCheck
            label="Wallet-reported mined placement"
            result={
              walletMinedPlacement
                ? `Reported block #${tx.blockHeight?.toLocaleString("en-US")}`
                : "Could not be verified"
            }
            detail={
              walletMinedPlacement
                ? `${tx.confirmations} confirmations reported · no independent Zebra/explorer transaction lookup was performed on this screen`
                : "No current wallet mined-placement record is available."
            }
            tone={tx.status === "pending" ? "warning" : "neutral"}
          />
          <EvidenceCheck
            label={lens === "public" ? "Public confirmation count" : "Confirmation threshold"}
            result={
              walletMinedPlacement
                ? lens === "public"
                  ? `${tx.confirmations} confirmations`
                  : `${tx.confirmations}/${data.state.settings.minConfirmations} confirmations`
                : "Check could not be performed"
            }
            detail={
              lens === "public"
                ? "This is the wallet-reported value; it must be independently verified with an explorer/node."
                : confirmationsReady
                  ? "The configured accounting threshold has been met."
                  : "It is not considered final until the threshold is met."
            }
            tone={
              lens === "public"
                ? "neutral"
                : confirmationsReady
                  ? "positive"
                  : walletMinedPlacement
                    ? "warning"
                    : "neutral"
            }
          />
          {lens !== "public" && (
            <>
              <EvidenceCheck
                label="Resolved by the wallet"
                result={
                  scopedWalletObservation
                    ? "Authorized account observation"
                    : canonicalWalletObservation && data.node.nodeSource === "legacy"
                      ? "Legacy whole-wallet observation"
                      : canonicalWalletObservation && tx.status === "failed"
                        ? "Previous observation; current status failed"
                        : "Could not be verified"
                }
                detail={
                  scopedWalletObservation
                    ? `Account scope: ${observedAccount ? `${observedAccount.slice(0, 12)}…` : "no fingerprint recorded"}`
                    : data.node.nodeSource === "legacy" && canonicalWalletObservation
                      ? "Legacy RPC does not prove the authorized Zallet account scope."
                      : "A public explorer does not reveal the shielded party, amount, or memo contents."
                }
                tone={scopedWalletObservation ? "positive" : canonicalWalletObservation ? "warning" : "neutral"}
              />
              <EvidenceCheck
                label="Link to accounting record"
                result={
                  linkedDocument
                    ? settlementMatched
                      ? `Matched to ${invoice?.number ?? expense?.number}`
                      : `Local link to ${invoice?.number ?? expense?.number}`
                    : "Unclassified"
                }
                detail={
                  settlementMatched
                    ? "The wallet sync linked the amount, direction, account, and memo criteria; this is not proof of sender identity."
                    : linkedDocument
                      ? "The document relationship exists in the local record; it is not a finalized canonical exact match."
                      : "No invoice or expense link is available."
                }
                tone={settlementMatched ? "positive" : linkedDocument ? "neutral" : "warning"}
              />
              <EvidenceCheck
                label="Posted to the journal"
                result={linkedJournal ? linkedJournal.number : "Could not be verified"}
                detail={
                  linkedJournal?.recordCommitment
                    ? `Active document-reconciliation entry · commitment: ${linkedJournal.recordCommitment.slice(0, 12)}…`
                    : linkedJournal
                      ? "An active payment/receipt journal entry exists; this record has no record-commitment field."
                      : "No active payment/receipt journal entry exists for this txid and document; a fee entry alone is insufficient."
                }
                tone={linkedJournal?.recordCommitment ? "positive" : linkedJournal ? "warning" : "neutral"}
              />
              <EvidenceCheck
                label="Capsule inclusion"
                result="Not performed in this drawer"
                detail="Included records are checked using the downloaded manifest and an independent capsule verifier."
                tone="neutral"
              />
            </>
          )}
        </ol>
      </section>
      <dl className="detail-list">
        <div>
          <dt>Transaction ID</dt>
          <dd>
            {lens === "public" && !walletMinedPlacement ? (
              "No public txid observation"
            ) : (
              <HashText value={tx.txid} chars={9} />
            )}
          </dd>
        </div>
        <div>
          <dt>Pool</dt>
          <dd>
            {lens === "public" && !walletMinedPlacement ? "No public pool observation" : `${tx.pool} · Zcash Testnet`}
          </dd>
        </div>
        <div>
          <dt>Block / confirmations</dt>
          <dd>
            {walletMinedPlacement
              ? `#${tx.blockHeight?.toLocaleString("en-US")} · ${tx.confirmations} confirmations`
              : lens === "public"
                ? "No public-chain observation"
                : "No current block-inclusion evidence"}
          </dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>
            {lens === "public"
              ? !walletMinedPlacement
                ? "No public amount observation"
                : tx.pool !== "Transparent"
                  ? "Shielded · not public"
                  : `${formatZec(tx.zatoshi, 8)} ZEC · wallet-reported transparent field`
              : `${formatZec(tx.zatoshi, 8)} ZEC${["internal", "anchor"].includes(tx.direction) ? ` · intra-vault principal (net 0), fee ${formatZec(tx.feeZatoshi ?? "0", 8)} ZEC` : ""}`}
          </dd>
        </div>
        <div>
          <dt>Encrypted memo</dt>
          <dd>
            {lens === "public" ? (
              !walletMinedPlacement ? (
                "No public memo-class observation"
              ) : tx.pool === "Transparent" ? (
                "Transparent outputs have no memo"
              ) : (
                "Cannot be resolved from public data; appropriate viewing authority and a wallet scan are required"
              )
            ) : (
              <code>{tx.memo || "—"}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Accounting source</dt>
          <dd>
            {lens === "public"
              ? "Not disclosed in the public view"
              : (invoice?.number ?? expense?.number ?? "Not yet classified")}
          </dd>
        </div>
        <div>
          <dt>Data source</dt>
          <dd>
            {lens === "public"
              ? "The local source is not disclosed; public status must be independently checked with an explorer"
              : tx.source === "rpc"
                ? canonicalWalletObservation
                  ? "Wallet RPC observation"
                  : "RPC outbox / no mined wallet placement"
                : tx.source === "demo-fixture"
                  ? "Explicitly labeled synthetic / date-relative presentation fixture"
                  : "Local outbox / not yet a wallet observation"}
          </dd>
        </div>
      </dl>
      {walletMinedPlacement && (
        <a
          className="evidence-explorer-link"
          href={`${data.state.settings.explorerTxUrl}${tx.txid}`}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink aria-hidden="true" size={16} /> Open public transaction metadata in explorer
        </a>
      )}
      <div className="privacy-fact">
        <LockKeyhole aria-hidden="true" size={18} />
        <p>
          <b>What can be checked publicly?</b>
          <span>
            {!walletMinedPlacement
              ? "There is no wallet mined-placement record; the local pool label is not public evidence."
              : tx.pool === "Transparent"
                ? "The wallet record reports transparent fields; the txid and fields must be independently checked with an explorer/node."
                : "The wallet record reports a shielded action; the txid/placement must be checked independently, while the party/amount/memo cannot be derived from an explorer."}
          </span>
        </p>
      </div>
    </Modal>
  );
}

function EvidenceCheck({
  label,
  result,
  detail,
  tone,
}: {
  label: string;
  result: string;
  detail: string;
  tone: "positive" | "warning" | "danger" | "neutral";
}) {
  return (
    <li className={`evidence-check evidence-check--${tone}`}>
      <span className="evidence-check__mark" aria-hidden="true" />
      <div>
        <span>{label}</span>
        <b>{result}</b>
        <small>{detail}</small>
      </div>
    </li>
  );
}
