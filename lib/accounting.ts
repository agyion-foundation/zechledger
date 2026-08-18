import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "@/lib/canonical";
import { accountingMonth } from "@/lib/accounting-date";
export { canonicalJson, sha256 } from "@/lib/canonical";
import type { AppState, DashboardMetrics, JournalEntry, JournalLine } from "@/lib/types";
import { expenseCommitmentPayload, invoiceCommitmentPayload } from "@/lib/commitments";
import { safeKurusSum } from "@/lib/money";
import { EXPENSE_ACCOUNT_POLICY } from "@/lib/accounting-policy";

export const GENESIS_HASH = "0".repeat(64);

export function assertBalanced(lines: JournalLine[]): void {
  for (const line of lines) {
    if (![line.debitTry, line.creditTry].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("Journal lines must contain finite, non-negative integer TRY cents.");
    }
  }
  const debit = lines.reduce((sum, line) => sum + line.debitTry, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditTry, 0);
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) {
    throw new Error("Journal total exceeds the safe integer range.");
  }
  if (debit !== credit) {
    throw new Error(`Journal entry is not balanced: debit ${debit}, credit ${credit}`);
  }
  if (debit <= 0 || lines.length < 2) {
    throw new Error("A journal entry must contain at least two lines and a positive amount.");
  }
}

interface JournalDraft {
  date: string;
  description: string;
  sourceType: JournalEntry["sourceType"];
  sourceId: string;
  vaultId: string;
  chainTxid?: string;
  recordCommitment?: string;
  lines: JournalLine[];
  valuationRateTry?: number;
  valuationSource?: "configured-static";
  status?: JournalEntry["status"];
}

export function appendJournal(state: AppState, draft: JournalDraft): JournalEntry {
  assertBalanced(draft.lines);
  const previousHash = state.ledgerHead || GENESIS_HASH;
  const createdAt = new Date().toISOString();
  const core = {
    id: randomUUID(),
    number: `YEV-${String(state.journals.length + 1).padStart(5, "0")}`,
    ...draft,
    status: draft.status ?? "posted",
    createdAt,
    previousHash,
  };
  const entry: JournalEntry = {
    ...core,
    hash: sha256(`${previousHash}:${canonicalJson(core)}`),
  };
  state.journals.push(entry);
  state.ledgerHead = entry.hash;
  return entry;
}

export function verifyLedgerChain(state: AppState): { valid: boolean; at?: string } {
  let previous = GENESIS_HASH;
  for (const entry of state.journals) {
    const core = { ...entry } as unknown as Record<string, unknown>;
    delete core.hash;
    const expected = sha256(`${previous}:${canonicalJson(core)}`);
    if (entry.previousHash !== previous || entry.hash !== expected) {
      return { valid: false, at: entry.number };
    }
    try {
      assertBalanced(entry.lines);
    } catch {
      return { valid: false, at: entry.number };
    }
    previous = entry.hash;
  }
  return { valid: previous === (state.ledgerHead || GENESIS_HASH) };
}

export function computeMetrics(state: AppState): DashboardMetrics {
  const issued = state.invoices.filter((invoice) => invoice.status !== "draft");
  const paid = issued.filter((invoice) => invoice.status === "paid");
  const revenueTry = safeKurusSum(issued.map((invoice) => invoice.tryTotal));
  const paidTry = safeKurusSum(paid.map((invoice) => invoice.tryTotal));
  const receivablesTry = safeKurusSum(
    issued
      .filter((invoice) => invoice.status === "pending" || invoice.status === "overdue")
      .map((invoice) => invoice.tryTotal),
  );
  const expensesTry = safeKurusSum(
    state.expenses.filter((expense) => expense.status !== "draft").map((expense) => expense.tryTotal),
  );
  const paidExpensesTry = safeKurusSum(
    state.expenses.filter((expense) => expense.status === "paid").map((expense) => expense.tryTotal),
  );
  const networkFeesTry = safeKurusSum(
    state.journals
      .filter((entry) => entry.sourceType === "fee")
      .flatMap((entry) => entry.lines)
      .filter((line) => line.accountCode === "780")
      .map((line) => line.debitTry - line.creditTry),
  );

  const netTry = paidTry - paidExpensesTry - networkFeesTry;
  if (!Number.isSafeInteger(netTry))
    throw new Error("Net accounting total exceeds the safe integer range for TRY cents.");

  const confirmed = state.transactions.filter(
    (tx) =>
      tx.status === "confirmed" &&
      tx.observationState !== "orphan-candidate" &&
      (tx.source !== "rpc" || tx.confirmations >= state.settings.minConfirmations),
  );
  let wallet = 0n;
  for (const tx of confirmed) {
    const amount = BigInt(tx.zatoshi);
    if (tx.direction === "incoming") wallet += amount;
    else if (tx.direction === "outgoing") wallet -= amount + BigInt(tx.feeZatoshi ?? "0");
    else if (tx.direction === "anchor" || tx.direction === "internal") {
      wallet -= BigInt(tx.feeZatoshi ?? "0");
    }
  }

  const months = new Map<string, { income: number; expense: number }>();
  for (const entry of state.journals) {
    const cashDeltaKurus = entry.lines
      .filter((line) => line.accountCode === "102.10")
      .reduce((sum, line) => sum + line.debitTry - line.creditTry, 0);
    if (!cashDeltaKurus) continue;
    const key = entry.date.slice(0, 7);
    const current = months.get(key) ?? { income: 0, expense: 0 };
    if (cashDeltaKurus > 0) current.income = safeKurusSum([current.income, cashDeltaKurus]);
    else current.expense = safeKurusSum([current.expense, -cashDeltaKurus]);
    months.set(key, current);
  }
  const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });
  const monthlyFlow = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([period, values]) => ({
      period,
      month: monthFormatter.format(new Date(`${period}-15T12:00:00Z`)).replace(".", ""),
      income: values.income / 100,
      expense: values.expense / 100,
      incomeKurus: values.income,
      expenseKurus: values.expense,
    }));

  const palette = ["#9adf70", "#ffb86b", "#6f8dff", "#d47cf5", "#62c8c5"];
  const categories = new Map<string, number>();
  for (const expense of state.expenses.filter((item) => item.status !== "draft")) {
    categories.set(expense.category, (categories.get(expense.category) ?? 0) + expense.tryTotal / 100);
  }

  return {
    walletBalanceZatoshi: wallet.toString(),
    receivablesTry,
    revenueTry,
    expensesTry,
    netTry,
    networkFeesTry,
    collectionRate: revenueTry ? Math.round((paidTry / revenueTry) * 100) : 0,
    confirmedTransactions: confirmed.length,
    pendingTransactions: state.transactions.filter((tx) => tx.status === "pending").length,
    unclassifiedTransactions: state.transactions.filter(
      (tx) =>
        tx.source === "rpc" &&
        tx.status === "confirmed" &&
        ["incoming", "outgoing"].includes(tx.direction) &&
        ((!tx.invoiceId && !tx.expenseId) || /not applied|manual review/i.test(tx.counterparty)),
    ).length,
    journalBalanced: verifyLedgerChain(state).valid,
    monthlyFlow,
    categorySpend: [...categories.entries()].map(([name, value], index) => ({
      name,
      value: Math.round(value),
      color: palette[index % palette.length],
    })),
  };
}

export function buildAuditManifest(
  state: AppState,
  vaultId: string,
  period: string,
  anchorPlan?: { toAddress: string; accountFingerprint: string; zatoshi: string },
) {
  const vault = state.vaults.find((item) => item.id === vaultId);
  if (!vault) throw new Error("Vault not found.");
  const generatedAt = new Date().toISOString();
  if (state.settings.accountingDatePolicy !== "Europe/Istanbul/v1") {
    throw new Error("The Europe/Istanbul/v1 date policy must be explicitly persisted for a capsule.");
  }
  const scopedTransactions = state.transactions.filter(
    (transaction) =>
      transaction.source === "rpc" &&
      (transaction.vaultId === vaultId ||
        transaction.sourceVaultId === vaultId ||
        transaction.destinationVaultId === vaultId) &&
      accountingMonth(new Date(transaction.timestamp)) === period &&
      transaction.status === "confirmed" &&
      /^[0-9a-f]{64}$/i.test(transaction.txid) &&
      Boolean(transaction.observationHash) &&
      transaction.blockHeight !== undefined,
  );
  for (const transaction of scopedTransactions) {
    if (
      transaction.observationState === "orphan-candidate" ||
      transaction.confirmations < state.settings.minConfirmations
    ) {
      throw new Error(
        `The wallet record in scope does not meet the current observation/confirmation policy (${transaction.txid}).`,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(transaction.accountFingerprint ?? "")) {
      throw new Error(
        `Capsule v3 requires an account-scoped Zallet account fingerprint; the legacy wallet row was not signed (${transaction.txid}).`,
      );
    }
  }
  const scopedTxids = new Set(scopedTransactions.map((transaction) => transaction.txid));
  const periodJournals = state.journals.filter((entry) => entry.vaultId === vaultId && entry.date.startsWith(period));
  if (state.mode === "live") {
    const outOfScopeSettlement = periodJournals.find(
      (entry) =>
        entry.chainTxid &&
        ["payment", "fee", "transfer"].includes(entry.sourceType) &&
        state.transactions.some((transaction) => transaction.txid === entry.chainTxid) &&
        !scopedTxids.has(entry.chainTxid),
    );
    if (outOfScopeSettlement) {
      throw new Error(
        `The chain journal in the selected posting period no longer has a current confirmed wallet placement in the same period (${outOfScopeSettlement.number}); use the v3 capsule for the correction period.`,
      );
    }
  }
  const journals = state.journals
    .filter(
      (entry) =>
        entry.vaultId === vaultId &&
        (entry.date.startsWith(period) || Boolean(entry.chainTxid && scopedTxids.has(entry.chainTxid))),
    )
    .map((entry) => ({
      ...entry,
      capsuleScopeRole: entry.date.startsWith(period) ? ("period-entry" as const) : ("settlement-support" as const),
    }));
  if (scopedTransactions.length > 0) {
    const lastSyncAt = state.settings.lastSyncAt;
    const generatedAtMs = Date.parse(generatedAt);
    const lastSyncAtMs = Date.parse(lastSyncAt ?? "");
    if (
      !lastSyncAt ||
      !Number.isFinite(lastSyncAtMs) ||
      lastSyncAtMs > generatedAtMs ||
      generatedAtMs - lastSyncAtMs > 15 * 60 * 1000 ||
      !state.settings.lastSyncToken ||
      !state.settings.lastSyncScope
    ) {
      throw new Error(
        "The wallet observation is more than 15 minutes old or exact-sync evidence is missing; sync again before creating the capsule.",
      );
    }
    for (const transaction of scopedTransactions) {
      const observedAtMs = Date.parse(transaction.lastObservedAt ?? "");
      if (
        !Number.isFinite(transaction.accountingValuationRateTry) ||
        transaction.accountingValuationRateTry! <= 0 ||
        transaction.accountingValuationSource !== "configured-static" ||
        !transaction.lastObservedAt ||
        !Number.isFinite(observedAtMs) ||
        observedAtMs > lastSyncAtMs ||
        transaction.lastObservedAt !== lastSyncAt ||
        transaction.syncScope !== state.settings.lastSyncScope
      ) {
        throw new Error(`Wallet observation freshness or scope is missing (${transaction.txid}).`);
      }
    }
  }
  const txids = scopedTransactions.map((tx) => ({
    canonicalId: tx.canonicalId ?? tx.id,
    txid: tx.txid,
    timestamp: tx.timestamp,
    lastObservedAt: tx.lastObservedAt,
    syncScope: tx.syncScope,
    status: tx.status,
    confirmations: tx.confirmations,
    blockHeight: tx.blockHeight,
    direction: tx.direction,
    zatoshi: tx.zatoshi,
    feeZatoshi: tx.feeZatoshi,
    memo: tx.memo,
    toAddress: tx.toAddress,
    vaultId: tx.vaultId,
    accountFingerprint: tx.accountFingerprint,
    sourceAccountFingerprint: tx.sourceAccountFingerprint,
    destinationAccountFingerprint: tx.destinationAccountFingerprint,
    sourceVaultId: tx.sourceVaultId,
    destinationVaultId: tx.destinationVaultId,
    anchorInternalProvenance: tx.anchorInternalProvenance,
    accountingValuationRateTry: tx.accountingValuationRateTry,
    accountingValuationSource: tx.accountingValuationSource,
    invoiceId: tx.invoiceId,
    expenseId: tx.expenseId,
    pool: tx.pool,
    source: tx.source,
  }));
  const referencedIds = new Set([
    ...journals
      .filter((entry) => ["invoice", "expense", "payment"].includes(entry.sourceType))
      .map((entry) => entry.sourceId),
    ...scopedTransactions.flatMap((tx) => [tx.invoiceId, tx.expenseId].filter((id): id is string => Boolean(id))),
  ]);
  const documents = [
    ...state.invoices
      .filter(
        (item) =>
          item.status !== "draft" &&
          item.vaultId === vaultId &&
          (item.issueDate.startsWith(period) || referencedIds.has(item.id)),
      )
      .map((item) => ({
        kind: "invoice" as const,
        id: item.id,
        commitment: item.documentHash,
        identityCommitment: sha256(
          canonicalJson({ id: item.id, kind: "invoice", recordCommitment: item.documentHash }),
        ),
        scopeRoles: [
          item.issueDate.startsWith(period) ? "issuance" : null,
          referencedIds.has(item.id) ? "settlement-reference" : null,
        ].filter(Boolean),
        metadata: { id: item.id, kind: "invoice" as const, record: invoiceCommitmentPayload(item) },
      })),
    ...state.expenses
      .filter(
        (item) =>
          item.status !== "draft" &&
          item.vaultId === vaultId &&
          (item.date.startsWith(period) || referencedIds.has(item.id)),
      )
      .map((item) => ({
        kind: "expense" as const,
        id: item.id,
        commitment: item.documentHash,
        identityCommitment: sha256(
          canonicalJson({ id: item.id, kind: "expense", recordCommitment: item.documentHash }),
        ),
        scopeRoles: [
          item.date.startsWith(period) ? "issuance" : null,
          referencedIds.has(item.id) ? "settlement-reference" : null,
        ].filter(Boolean),
        metadata: { id: item.id, kind: "expense" as const, record: expenseCommitmentPayload(item) },
      })),
  ];

  const evidenceClass =
    state.mode === "demo"
      ? "presentation-fixture-no-chain-evidence"
      : txids.length === 0
        ? "live-local-ledger-no-wallet-observation-in-scope"
        : journals.length > 0 || documents.length > 0
          ? "hybrid-wallet-observed-rpc-and-local-ledger"
          : "wallet-observed-rpc";
  const manifest = {
    protocol: "zechledger-audit-capsule/3",
    mode: state.mode,
    evidenceClass,
    network: "Zcash Testnet",
    entity: state.company.legalName,
    scope: {
      vaultId,
      vaultName: vault.name,
      vaultPurpose: vault.purpose,
      vaultMetadataFingerprint: vault.metadataFingerprint ?? null,
      accountScopeFingerprint: state.settings.accountScopeFingerprint ?? null,
      period,
      accountingTimezone: "Europe/Istanbul",
      accountingDatePolicy: state.settings.accountingDatePolicy,
      accountingPeriodRule: "instant-in-timezone-calendar-month",
      minimumConfirmations: state.settings.minConfirmations,
      expenseAccountPolicy: EXPENSE_ACCOUNT_POLICY,
    },
    walletObservation:
      state.mode === "live"
        ? {
            observedAt: state.settings.lastSyncAt ?? null,
            scanToken: state.settings.lastSyncToken ?? null,
            syncScope: state.settings.lastSyncScope ?? null,
            confirmationsAsOfObservation: true,
          }
        : null,
    viewingKey: { source: vault.viewingKeySource, fingerprint: vault.viewingKeyFingerprint ?? null, included: false },
    anchorPlan: anchorPlan ? { mode: "wallet-observed-shielded-self-transfer", ...anchorPlan } : null,
    ledgerHead: state.ledgerHead,
    journals,
    txids,
    documents,
    generatedAt,
  };
  return { manifest, hash: sha256(canonicalJson(manifest)), entryCount: journals.length };
}
