import { randomUUID } from "node:crypto";
import { appendJournal } from "@/lib/accounting";
import { accountingDate } from "@/lib/accounting-date";
import { signAuditReceipt } from "@/lib/audit-signing";
import { transactionObservationCommitment } from "@/lib/commitments";
import { apiError, noStoreJson } from "@/lib/http";
import { tryFromZatoshi } from "@/lib/money";
import { mutateState } from "@/lib/store";
import { configuredWalletSyncScope, listReceivedTransactions } from "@/lib/zcash-rpc";
import type { AppState, ChainTransaction } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function paymentNetPosted(state: AppState, sourceId: string, txid: string): boolean {
  const entries = state.journals.filter(
    (entry) => entry.sourceType === "payment" && entry.sourceId === sourceId && entry.chainTxid === txid,
  );
  return entries.reduce((net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1), 0) > 0;
}

function feeNetPosted(state: AppState, txid: string): boolean {
  const entries = state.journals.filter((entry) => entry.sourceType === "fee" && entry.chainTxid === txid);
  return entries.reduce((net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1), 0) > 0;
}

function transferNetPosted(state: AppState, sourceId: string): boolean {
  const entries = state.journals.filter((entry) => entry.sourceType === "transfer" && entry.sourceId === sourceId);
  return entries.reduce((net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1), 0) > 0;
}

function appendTransferJournal(
  state: AppState,
  input: {
    sourceId: string;
    txid: string;
    vaultId: string;
    side: "source" | "destination";
    reverse: boolean;
    date: string;
    zatoshi: string;
    amountTry: number;
    valuationRateTry: number;
  },
): void {
  const sourceLines = [
    { accountCode: "136.10", accountName: "Transfers Between Purpose Vaults", debitTry: input.amountTry, creditTry: 0 },
    {
      accountCode: "102.10",
      accountName: "ZEC Testnet Asset",
      debitTry: 0,
      creditTry: input.amountTry,
      zatoshi: input.zatoshi,
    },
  ];
  const destinationLines = [
    {
      accountCode: "102.10",
      accountName: "ZEC Testnet Asset",
      debitTry: input.amountTry,
      creditTry: 0,
      zatoshi: input.zatoshi,
    },
    { accountCode: "136.10", accountName: "Transfers Between Purpose Vaults", debitTry: 0, creditTry: input.amountTry },
  ];
  const original = input.side === "source" ? sourceLines : destinationLines;
  const lines = input.reverse
    ? original.map((line) => ({ ...line, debitTry: line.creditTry, creditTry: line.debitTry }))
    : original;
  appendJournal(state, {
    date: input.date,
    description: `${input.reverse ? "REORG REVERSAL ENTRY · " : ""}Transfer between purpose vaults: ${input.side === "source" ? "outflow" : "inflow"} · ${input.txid.slice(0, 10)}`,
    sourceType: "transfer",
    sourceId: input.sourceId,
    vaultId: input.vaultId,
    chainTxid: input.txid,
    valuationRateTry: input.valuationRateTry,
    valuationSource: "configured-static",
    lines,
  });
}

function assertStableObservation(existing: ChainTransaction, event: ChainTransaction): void {
  const pairs: Array<[string, unknown, unknown]> = [
    ["txid", existing.txid, event.txid],
    ["direction", existing.direction, event.direction],
    ["zatoshi", existing.zatoshi, event.zatoshi],
    ["memo", existing.memo, event.memo],
    ["vault", existing.vaultId, event.vaultId],
    ["pool", existing.pool, event.pool],
    ["sourceAccount", existing.sourceAccountFingerprint, event.sourceAccountFingerprint],
    ["destinationAccount", existing.destinationAccountFingerprint, event.destinationAccountFingerprint],
    ["sourceVault", existing.sourceVaultId, event.sourceVaultId],
    ["destinationVault", existing.destinationVaultId, event.destinationVaultId],
  ];
  for (const [field, previous, next] of pairs) {
    if (previous !== next)
      throw new Error(
        `Canonical wallet output ${field} changed (${event.canonicalId ?? event.id}); sync stopped in fail-closed mode.`,
      );
  }
  if (existing.accountFingerprint && existing.accountFingerprint !== event.accountFingerprint) {
    throw new Error(
      `The account field in canonical wallet output changed (${event.canonicalId ?? event.id}); sync stopped in fail-closed mode.`,
    );
  }
  if (existing.toAddress && event.toAddress && existing.toAddress !== event.toAddress) {
    throw new Error(
      `The destination field in canonical wallet output changed (${event.canonicalId ?? event.id}); sync stopped in fail-closed mode.`,
    );
  }
  if (existing.toAddress && !event.toAddress && existing.direction !== "anchor") {
    throw new Error(
      `The destination field disappeared from canonical wallet output (${event.canonicalId ?? event.id}); sync stopped in fail-closed mode.`,
    );
  }
}

export async function POST() {
  try {
    const observed = await listReceivedTransactions();
    const scanToken = observed.scanToken;
    const syncObservedAt = new Date().toISOString();
    const syncScope = configuredWalletSyncScope();
    const { result } = await mutateState(async (state) => {
      const observedCanonicalIds = new Set(observed.map((event) => event.id));
      if (
        state.settings.lastSyncScope &&
        state.settings.lastSyncScope !== syncScope &&
        state.transactions.some((tx) => tx.source === "rpc")
      ) {
        throw new Error(
          "The wallet/account sync scope cannot be changed: use a new ZECHLEDGER_DATA_DIR instead of mixing records from the old and new wallets.",
        );
      }
      const distinctSnapshot = !scanToken || state.settings.lastSyncToken !== scanToken;
      const stableZalletScope =
        Boolean(process.env.ZALLET_RPC_URL) &&
        (process.env.ZCASH_WALLET_FLAVOR ?? "zallet") === "zallet" &&
        state.settings.lastSyncScope === syncScope;
      const canInferAbsence = stableZalletScope && distinctSnapshot;
      const orphanCandidates = stableZalletScope ? { ...(state.settings.orphanCandidates ?? {}) } : {};
      for (const id of observedCanonicalIds) delete orphanCandidates[id];
      const missing: ChainTransaction[] = [];
      if (canInferAbsence) {
        for (const tx of state.transactions.filter(
          (item) =>
            item.source === "rpc" &&
            item.status === "confirmed" &&
            /^[0-9a-f]{64}$/i.test(item.txid) &&
            item.syncScope === syncScope,
        )) {
          const canonicalId = tx.canonicalId ?? tx.id;
          if (observedCanonicalIds.has(canonicalId)) continue;
          const observations = (orphanCandidates[canonicalId] ?? 0) + 1;
          if (observations >= 2) {
            missing.push(tx);
            delete orphanCandidates[canonicalId];
          } else {
            orphanCandidates[canonicalId] = observations;
            tx.observationState = "orphan-candidate";
          }
        }
      }
      state.settings.orphanCandidates = orphanCandidates;
      const events: ChainTransaction[] = [
        ...missing.map((tx) => ({
          ...tx,
          confirmations: 0,
          status: "failed" as const,
          failureReason: "orphan-missing" as const,
          observationState: "absent" as const,
        })),
        ...observed,
      ];
      let imported = 0;
      let updated = 0;
      let matched = 0;
      let posted = 0;
      state.mode = "live";

      for (const event of events) {
        const eventCanonicalId = event.canonicalId ?? event.id;
        const observedVaultId = event.vaultId;
        const canonicalExisting = state.transactions.find(
          (tx) => tx.source === "rpc" && (tx.id === event.id || tx.canonicalId === event.id),
        );
        if (canonicalExisting) assertStableObservation(canonicalExisting, event);
        const previousBlockHeight = canonicalExisting?.blockHeight;
        const eventAccountingDate = accountingDate(new Date(event.timestamp));
        const previousObservedDate = canonicalExisting
          ? accountingDate(new Date(canonicalExisting.timestamp))
          : undefined;
        const exactIntent = (tx: ChainTransaction) =>
          tx.source === "rpc" &&
          tx.status === "pending" &&
          (tx.txid.startsWith("intent:") ||
            tx.txid.startsWith("opid:") ||
            tx.txid.startsWith("opdone:") ||
            Boolean(tx.operationTxids?.includes(event.txid))) &&
          tx.direction === event.direction &&
          tx.zatoshi === event.zatoshi &&
          tx.memo === event.memo &&
          tx.accountFingerprint === event.accountFingerprint &&
          (event.direction === "anchor"
            ? event.anchorInternalProvenance === true && (!event.toAddress || event.toAddress === tx.toAddress)
            : Boolean(event.toAddress && tx.toAddress === event.toAddress));
        const existing = canonicalExisting ?? state.transactions.find(exactIntent);
        let transaction: ChainTransaction = event;
        if (existing) {
          Object.assign(existing, {
            txid: event.txid,
            vaultId: event.vaultId,
            accountFingerprint: event.accountFingerprint,
            confirmations: event.confirmations,
            status: event.status,
            blockHeight: event.blockHeight,
            timestamp: event.timestamp,
            memo: event.memo || existing.memo,
            toAddress: event.toAddress ?? existing.toAddress,
            pool: event.pool,
            feeZatoshi: event.feeZatoshi,
            sourceAccountFingerprint: event.sourceAccountFingerprint,
            destinationAccountFingerprint: event.destinationAccountFingerprint,
            sourceVaultId: event.sourceVaultId,
            destinationVaultId: event.destinationVaultId,
            anchorInternalProvenance: event.anchorInternalProvenance,
            failureReason: event.failureReason,
          });
          transaction = existing;
          updated += 1;
        } else {
          state.transactions.unshift(event);
          imported += 1;
        }

        transaction.canonicalId = eventCanonicalId;
        transaction.observationState = event.failureReason === "orphan-missing" ? "absent" : "observed";
        const historicalValuation = state.journals.find(
          (entry) =>
            ["fee", "transfer"].includes(entry.sourceType) &&
            entry.chainTxid === event.txid &&
            !entry.description.startsWith("REORG REVERSAL"),
        );
        const transactionValuationRateTry =
          transaction.accountingValuationRateTry ?? historicalValuation?.valuationRateTry ?? state.settings.demoRateTry;
        transaction.accountingValuationRateTry = transactionValuationRateTry;
        transaction.accountingValuationSource = "configured-static";
        delete transaction.operationOutcome;
        transaction.observationHash = transactionObservationCommitment(transaction);
        transaction.syncScope = syncScope;
        if (observedCanonicalIds.has(event.id)) transaction.lastObservedAt = syncObservedAt;

        const knownVault = state.vaults.some((vault) => vault.id === observedVaultId);
        let eventFeePosted = feeNetPosted(state, event.txid);
        const feePlacementChanged =
          knownVault &&
          event.status === "confirmed" &&
          eventFeePosted &&
          Boolean(event.feeZatoshi && BigInt(event.feeZatoshi) > 0n) &&
          previousBlockHeight !== undefined &&
          (previousBlockHeight !== event.blockHeight || previousObservedDate !== eventAccountingDate);
        if (feePlacementChanged) {
          const original = state.journals.find(
            (entry) =>
              entry.sourceType === "fee" &&
              entry.chainTxid === event.txid &&
              !entry.description.startsWith("REORG REVERSAL"),
          );
          const feeTry = original?.lines.reduce((sum, line) => sum + line.debitTry, 0) ?? 0;
          const feeZatoshi = original?.lines.find((line) => line.accountCode === "102.10")?.zatoshi;
          if (feeTry > 0) {
            appendJournal(state, {
              date: accountingDate(),
              description: `REORG REVERSAL ENTRY · re-mined ZIP-317 · ${event.txid.slice(0, 10)}`,
              sourceType: "fee",
              sourceId: `${transaction.id}:fee`,
              vaultId: observedVaultId,
              chainTxid: event.txid,
              valuationRateTry: original?.valuationRateTry ?? transactionValuationRateTry,
              valuationSource: original?.valuationSource ?? "configured-static",
              lines: [
                {
                  accountCode: "102.10",
                  accountName: "ZEC Testnet Asset",
                  debitTry: feeTry,
                  creditTry: 0,
                  zatoshi: feeZatoshi,
                },
                { accountCode: "780", accountName: "Financing / Network Expenses", debitTry: 0, creditTry: feeTry },
              ],
            });
            posted += 1;
            eventFeePosted = false;
          }
        }
        if (
          knownVault &&
          event.status === "confirmed" &&
          event.feeZatoshi &&
          BigInt(event.feeZatoshi) > 0n &&
          !eventFeePosted
        ) {
          const feeTry = tryFromZatoshi(event.feeZatoshi, transactionValuationRateTry);
          if (feeTry > 0) {
            appendJournal(state, {
              date: eventAccountingDate,
              description: `ZIP-317 wallet network fee · ${event.txid.slice(0, 10)}`,
              sourceType: "fee",
              sourceId: `${transaction.id}:fee`,
              vaultId: observedVaultId,
              chainTxid: event.txid,
              valuationRateTry: transactionValuationRateTry,
              valuationSource: "configured-static",
              lines: [
                { accountCode: "780", accountName: "Financing / Network Expenses", debitTry: feeTry, creditTry: 0 },
                {
                  accountCode: "102.10",
                  accountName: "ZEC Testnet Asset",
                  debitTry: 0,
                  creditTry: feeTry,
                  zatoshi: event.feeZatoshi,
                },
              ],
            });
            posted += 1;
          }
        } else if (knownVault && event.status !== "confirmed" && eventFeePosted) {
          const original = state.journals.find(
            (entry) =>
              entry.sourceType === "fee" &&
              entry.chainTxid === event.txid &&
              !entry.description.startsWith("REORG REVERSAL"),
          );
          const feeTry = original?.lines.reduce((sum, line) => sum + line.debitTry, 0) ?? 0;
          const feeZatoshi = original?.lines.find((line) => line.accountCode === "102.10")?.zatoshi;
          if (feeTry > 0) {
            appendJournal(state, {
              date: accountingDate(),
              description: `REORG REVERSAL ENTRY · ZIP-317 · ${event.txid.slice(0, 10)}`,
              sourceType: "fee",
              sourceId: `${transaction.id}:fee`,
              vaultId: observedVaultId,
              chainTxid: event.txid,
              valuationRateTry: original?.valuationRateTry ?? transactionValuationRateTry,
              valuationSource: original?.valuationSource ?? "configured-static",
              lines: [
                {
                  accountCode: "102.10",
                  accountName: "ZEC Testnet Asset",
                  debitTry: feeTry,
                  creditTry: 0,
                  zatoshi: feeZatoshi,
                },
                { accountCode: "780", accountName: "Financing / Network Expenses", debitTry: 0, creditTry: feeTry },
              ],
            });
            posted += 1;
          }
        }

        if (event.direction === "anchor") {
          const manifestHash = event.memo.match(/^ZECHLEDGER\|AUDIT\|v(?:2|3)\|([0-9a-f]{64})$/)?.[1];
          const capsule = manifestHash
            ? state.auditCapsules.find((item) => item.manifestHash === manifestHash)
            : undefined;
          const capsuleManifest = capsule?.manifest as
            { protocol?: unknown; scope?: { minimumConfirmations?: unknown } } | undefined;
          const v3AnchorPolicy = capsuleManifest?.protocol === "zechledger-audit-capsule/3";
          const signedMinimumConfirmations = Number(capsuleManifest?.scope?.minimumConfirmations);
          if (
            capsule &&
            v3AnchorPolicy &&
            event.anchorInternalProvenance === true &&
            event.zatoshi === "1000" &&
            observedVaultId === capsule.vaultId &&
            Boolean(capsule.anchorAccountFingerprint) &&
            event.accountFingerprint === capsule.anchorAccountFingerprint &&
            Boolean(capsule.anchorAddress) &&
            (!event.toAddress || event.toAddress === capsule.anchorAddress)
          ) {
            capsule.anchorTxid = event.txid;
            const anchorFeePosted = feeNetPosted(state, event.txid);
            if (
              event.status === "confirmed" &&
              Number.isSafeInteger(signedMinimumConfirmations) &&
              signedMinimumConfirmations > 0 &&
              event.confirmations >= signedMinimumConfirmations
            ) {
              capsule.status = "anchored";
              capsule.anchoredAt = event.timestamp;
              if (
                event.blockHeight !== undefined &&
                (!capsule.anchorReceipt ||
                  capsule.anchorReceipt.txid !== event.txid ||
                  capsule.anchorReceipt.blockHeight !== event.blockHeight)
              ) {
                const receiptCore = {
                  manifestHash: capsule.manifestHash,
                  txid: event.txid,
                  blockHeight: event.blockHeight,
                  confirmations: event.confirmations,
                  observedAt: new Date().toISOString(),
                  destinationObserved: event.toAddress ?? null,
                  accountFingerprint: event.accountFingerprint ?? capsule.anchorAccountFingerprint ?? "unknown",
                  memo: event.memo,
                  zatoshi: event.zatoshi,
                  internalProvenance: "same-account-from-to" as const,
                };
                const receiptSignature = await signAuditReceipt(receiptCore);
                capsule.anchorReceipt = {
                  ...receiptCore,
                  signature: receiptSignature.signature,
                  signatureAlgorithm: "Ed25519",
                  signingKeyFingerprint: receiptSignature.keyFingerprint,
                };
              }
              if (event.feeZatoshi && BigInt(event.feeZatoshi) > 0n && !anchorFeePosted) {
                const feeTry = tryFromZatoshi(event.feeZatoshi, transactionValuationRateTry);
                if (feeTry > 0) {
                  appendJournal(state, {
                    date: eventAccountingDate,
                    description: `Audit anchor ZIP-317 fee · ${capsule.name}`,
                    sourceType: "fee",
                    sourceId: `${capsule.id}:anchor-fee`,
                    vaultId: capsule.vaultId,
                    chainTxid: event.txid,
                    valuationRateTry: transactionValuationRateTry,
                    valuationSource: "configured-static",
                    lines: [
                      {
                        accountCode: "780",
                        accountName: "Financing / Network Expenses",
                        debitTry: feeTry,
                        creditTry: 0,
                      },
                      {
                        accountCode: "102.10",
                        accountName: "ZEC Testnet Asset",
                        debitTry: 0,
                        creditTry: feeTry,
                        zatoshi: event.feeZatoshi,
                      },
                    ],
                  });
                  posted += 1;
                }
              }
            } else {
              capsule.status = "pending";
              delete capsule.anchoredAt;
              delete capsule.anchorReceipt;
              if (anchorFeePosted) {
                const original = state.journals.find(
                  (entry) =>
                    entry.sourceType === "fee" &&
                    entry.chainTxid === event.txid &&
                    !entry.description.startsWith("REORG REVERSAL"),
                );
                const feeTry = original?.lines.reduce((sum, line) => sum + line.debitTry, 0) ?? 0;
                const feeZatoshi = original?.lines.find((line) => line.accountCode === "102.10")?.zatoshi;
                if (feeTry > 0) {
                  appendJournal(state, {
                    date: accountingDate(),
                    description: `REORG REVERSAL ENTRY · Audit anchor · ${capsule.name}`,
                    sourceType: "fee",
                    sourceId: `${capsule.id}:anchor-fee`,
                    vaultId: capsule.vaultId,
                    chainTxid: event.txid,
                    valuationRateTry: original?.valuationRateTry ?? transactionValuationRateTry,
                    valuationSource: original?.valuationSource ?? "configured-static",
                    lines: [
                      {
                        accountCode: "102.10",
                        accountName: "ZEC Testnet Asset",
                        debitTry: feeTry,
                        creditTry: 0,
                        zatoshi: feeZatoshi,
                      },
                      {
                        accountCode: "780",
                        accountName: "Financing / Network Expenses",
                        debitTry: 0,
                        creditTry: feeTry,
                      },
                    ],
                  });
                  posted += 1;
                }
              }
            }
          }
          continue;
        }

        if (event.direction === "internal") {
          const sourceVaultId = event.sourceVaultId;
          const destinationVaultId = event.destinationVaultId;
          const sourceKnown = Boolean(sourceVaultId && state.vaults.some((vault) => vault.id === sourceVaultId));
          const destinationKnown = Boolean(
            destinationVaultId && state.vaults.some((vault) => vault.id === destinationVaultId),
          );
          if (!sourceKnown || !destinationKnown || sourceVaultId === destinationVaultId) {
            transaction.counterparty = "Purpose-vault transfer scope mismatch · manual review";
            continue;
          }
          const sourceId = `internal-out:${eventCanonicalId}`;
          const destinationId = `internal-in:${eventCanonicalId}`;
          let sourcePosted = transferNetPosted(state, sourceId);
          let destinationPosted = transferNetPosted(state, destinationId);
          const original = state.journals.find(
            (entry) =>
              entry.sourceType === "transfer" &&
              entry.chainTxid === event.txid &&
              !entry.description.startsWith("REORG REVERSAL"),
          );
          const amountTry =
            original?.lines.reduce((sum, line) => sum + line.debitTry, 0) ??
            tryFromZatoshi(event.zatoshi, transactionValuationRateTry);
          const valuationRateTry = original?.valuationRateTry ?? transactionValuationRateTry;
          const placementChanged =
            event.status === "confirmed" &&
            sourcePosted &&
            destinationPosted &&
            previousBlockHeight !== undefined &&
            (previousBlockHeight !== event.blockHeight || previousObservedDate !== eventAccountingDate);
          if (placementChanged || (event.status !== "confirmed" && (sourcePosted || destinationPosted))) {
            if (sourcePosted) {
              appendTransferJournal(state, {
                sourceId,
                txid: event.txid,
                vaultId: sourceVaultId!,
                side: "source",
                reverse: true,
                date: accountingDate(),
                zatoshi: event.zatoshi,
                amountTry,
                valuationRateTry,
              });
              posted += 1;
              sourcePosted = false;
            }
            if (destinationPosted) {
              appendTransferJournal(state, {
                sourceId: destinationId,
                txid: event.txid,
                vaultId: destinationVaultId!,
                side: "destination",
                reverse: true,
                date: accountingDate(),
                zatoshi: event.zatoshi,
                amountTry,
                valuationRateTry,
              });
              posted += 1;
              destinationPosted = false;
            }
          }
          if (event.status === "confirmed") {
            if (!sourcePosted) {
              appendTransferJournal(state, {
                sourceId,
                txid: event.txid,
                vaultId: sourceVaultId!,
                side: "source",
                reverse: false,
                date: eventAccountingDate,
                zatoshi: event.zatoshi,
                amountTry,
                valuationRateTry,
              });
              posted += 1;
            }
            if (!destinationPosted) {
              appendTransferJournal(state, {
                sourceId: destinationId,
                txid: event.txid,
                vaultId: destinationVaultId!,
                side: "destination",
                reverse: false,
                date: eventAccountingDate,
                zatoshi: event.zatoshi,
                amountTry,
                valuationRateTry,
              });
              posted += 1;
            }
          }
          continue;
        }

        if (event.direction === "incoming") {
          const invoice = state.invoices.find((item) => item.memoRef === event.memo && item.zatoshi === event.zatoshi);
          if (!invoice) continue;
          if (
            observedVaultId !== invoice.vaultId ||
            (invoice.receiveAccountFingerprint && event.accountFingerprint !== invoice.receiveAccountFingerprint)
          ) {
            transaction.counterparty = `Vault/account mismatch · ${invoice.number} (manual review)`;
            continue;
          }
          if (!event.toAddress || event.toAddress !== invoice.receiveAddress) {
            transaction.counterparty = `Collection address mismatch · ${invoice.number} (manual review)`;
            continue;
          }
          const priorInvoiceOutput =
            invoice.paymentCanonicalId ??
            state.transactions.find(
              (item) => item !== transaction && item.invoiceId === invoice.id && item.status === "confirmed",
            )?.canonicalId;
          transaction.counterparty = invoice.clientAlias;
          matched += 1;
          if (
            invoice.status === "paid" &&
            invoice.paymentTxid &&
            (invoice.paymentTxid !== event.txid ||
              Boolean(priorInvoiceOutput && priorInvoiceOutput !== eventCanonicalId))
          ) {
            transaction.counterparty = `${invoice.clientAlias} · duplicate/overpayment (not applied)`;
            continue;
          }
          transaction.invoiceId = invoice.id;
          let netPosted = paymentNetPosted(state, invoice.id, event.txid);
          const invoicePlacementChanged =
            event.status === "confirmed" &&
            netPosted &&
            invoice.paymentCanonicalId === eventCanonicalId &&
            invoice.paymentBlockHeight !== undefined &&
            event.blockHeight !== undefined &&
            (invoice.paymentBlockHeight !== event.blockHeight || previousObservedDate !== eventAccountingDate);
          if (invoicePlacementChanged) {
            appendJournal(state, {
              date: accountingDate(),
              description: `REORG REVERSAL ENTRY · re-mined · ${invoice.number}`,
              sourceType: "payment",
              sourceId: invoice.id,
              recordCommitment: invoice.documentHash,
              vaultId: invoice.vaultId,
              chainTxid: event.txid,
              valuationRateTry: invoice.valuationRateTry,
              valuationSource: invoice.valuationSource,
              lines: [
                { accountCode: "120", accountName: "Trade Receivables", debitTry: invoice.tryTotal, creditTry: 0 },
                {
                  accountCode: "102.10",
                  accountName: "ZEC Testnet Asset",
                  debitTry: 0,
                  creditTry: invoice.tryTotal,
                  zatoshi: event.zatoshi,
                },
              ],
            });
            posted += 1;
            netPosted = false;
          }
          if (event.status === "confirmed") {
            invoice.status = "paid";
            invoice.paymentTxid = event.txid;
            invoice.paymentCanonicalId = eventCanonicalId;
            invoice.paymentBlockHeight = event.blockHeight;
            invoice.paidAt = event.timestamp;
            if (!netPosted) {
              appendJournal(state, {
                date: eventAccountingDate,
                description: `Testnet receipt · ${invoice.number}`,
                sourceType: "payment",
                sourceId: invoice.id,
                recordCommitment: invoice.documentHash,
                vaultId: invoice.vaultId,
                chainTxid: event.txid,
                valuationRateTry: invoice.valuationRateTry,
                valuationSource: invoice.valuationSource,
                lines: [
                  {
                    accountCode: "102.10",
                    accountName: "ZEC Testnet Asset",
                    debitTry: invoice.tryTotal,
                    creditTry: 0,
                    zatoshi: event.zatoshi,
                  },
                  { accountCode: "120", accountName: "Trade Receivables", debitTry: 0, creditTry: invoice.tryTotal },
                ],
              });
              posted += 1;
            }
          } else if (invoice.status === "paid" && invoice.paymentTxid === event.txid) {
            if (netPosted) {
              appendJournal(state, {
                date: accountingDate(),
                description: `REORG REVERSAL ENTRY · ${invoice.number}`,
                sourceType: "payment",
                sourceId: invoice.id,
                recordCommitment: invoice.documentHash,
                vaultId: invoice.vaultId,
                chainTxid: event.txid,
                valuationRateTry: invoice.valuationRateTry,
                valuationSource: invoice.valuationSource,
                lines: [
                  { accountCode: "120", accountName: "Trade Receivables", debitTry: invoice.tryTotal, creditTry: 0 },
                  {
                    accountCode: "102.10",
                    accountName: "ZEC Testnet Asset",
                    debitTry: 0,
                    creditTry: invoice.tryTotal,
                    zatoshi: event.zatoshi,
                  },
                ],
              });
              posted += 1;
            }
            invoice.status = invoice.dueDate < accountingDate() ? "overdue" : "pending";
            delete invoice.paymentTxid;
            delete invoice.paymentCanonicalId;
            delete invoice.paymentBlockHeight;
            delete invoice.paidAt;
          }
          continue;
        }

        if (event.direction === "outgoing") {
          const expense = state.expenses.find(
            (item) =>
              item.zatoshi === event.zatoshi &&
              `ZECHLEDGER|${item.number}|${item.documentHash.slice(0, 12)}` === event.memo,
          );
          if (!expense) continue;
          if (
            observedVaultId !== expense.vaultId ||
            (expense.sourceAccountFingerprint && event.accountFingerprint !== expense.sourceAccountFingerprint)
          ) {
            transaction.counterparty = `Vault/account mismatch · ${expense.number} (manual review)`;
            continue;
          }
          if (!event.toAddress || event.toAddress !== expense.payToAddress) {
            transaction.counterparty = `Recipient address mismatch · ${expense.number} (manual review)`;
            continue;
          }
          const priorExpenseOutput =
            expense.paymentCanonicalId ??
            state.transactions.find(
              (item) => item !== transaction && item.expenseId === expense.id && item.status === "confirmed",
            )?.canonicalId;
          transaction.counterparty = expense.vendor;
          matched += 1;
          if (
            expense.status === "paid" &&
            expense.txid &&
            (expense.txid !== event.txid || Boolean(priorExpenseOutput && priorExpenseOutput !== eventCanonicalId))
          ) {
            transaction.counterparty = `${expense.vendor} · duplicate payment (not applied)`;
            continue;
          }
          transaction.expenseId = expense.id;
          for (const intent of state.transactions.filter(
            (tx) =>
              tx.id !== transaction.id &&
              tx.expenseId === expense.id &&
              tx.status === "pending" &&
              Boolean(tx.operationTxids?.includes(event.txid)),
          )) {
            intent.status = "failed";
            intent.failureReason = event.failureReason;
          }
          let settlementPosted = paymentNetPosted(state, expense.id, event.txid);
          const networkFeePosted = feeNetPosted(state, event.txid);
          const expensePlacementChanged =
            event.status === "confirmed" &&
            settlementPosted &&
            expense.paymentCanonicalId === eventCanonicalId &&
            expense.paymentBlockHeight !== undefined &&
            event.blockHeight !== undefined &&
            (expense.paymentBlockHeight !== event.blockHeight || previousObservedDate !== eventAccountingDate);
          if (expensePlacementChanged) {
            appendJournal(state, {
              date: accountingDate(),
              description: `REORG REVERSAL ENTRY · re-mined · ${expense.number}`,
              sourceType: "payment",
              sourceId: expense.id,
              recordCommitment: expense.documentHash,
              vaultId: expense.vaultId,
              chainTxid: event.txid,
              valuationRateTry: expense.valuationRateTry,
              valuationSource: expense.valuationSource,
              lines: [
                {
                  accountCode: "102.10",
                  accountName: "ZEC Testnet Asset",
                  debitTry: expense.tryTotal,
                  creditTry: 0,
                  zatoshi: event.zatoshi,
                },
                { accountCode: "320", accountName: "Trade Payables", debitTry: 0, creditTry: expense.tryTotal },
              ],
            });
            posted += 1;
            settlementPosted = false;
          }
          if (event.status === "confirmed") {
            if (!settlementPosted) {
              appendJournal(state, {
                date: eventAccountingDate,
                description: `Expense payment · ${expense.number}`,
                sourceType: "payment",
                sourceId: expense.id,
                recordCommitment: expense.documentHash,
                vaultId: expense.vaultId,
                chainTxid: event.txid,
                valuationRateTry: expense.valuationRateTry,
                valuationSource: expense.valuationSource,
                lines: [
                  { accountCode: "320", accountName: "Trade Payables", debitTry: expense.tryTotal, creditTry: 0 },
                  {
                    accountCode: "102.10",
                    accountName: "ZEC Testnet Asset",
                    debitTry: 0,
                    creditTry: expense.tryTotal,
                    zatoshi: event.zatoshi,
                  },
                ],
              });
              posted += 1;
            }
            if (event.feeZatoshi && BigInt(event.feeZatoshi) > 0n && !networkFeePosted) {
              const feeTry = tryFromZatoshi(event.feeZatoshi, transactionValuationRateTry);
              if (feeTry > 0) {
                appendJournal(state, {
                  date: eventAccountingDate,
                  description: `ZIP-317 network fee · ${expense.number}`,
                  sourceType: "fee",
                  sourceId: `${expense.id}:fee`,
                  vaultId: expense.vaultId,
                  chainTxid: event.txid,
                  valuationRateTry: transactionValuationRateTry,
                  valuationSource: "configured-static",
                  lines: [
                    { accountCode: "780", accountName: "Financing / Network Expenses", debitTry: feeTry, creditTry: 0 },
                    {
                      accountCode: "102.10",
                      accountName: "ZEC Testnet Asset",
                      debitTry: 0,
                      creditTry: feeTry,
                      zatoshi: event.feeZatoshi,
                    },
                  ],
                });
                posted += 1;
              }
            }
            expense.status = "paid";
            expense.txid = event.txid;
            expense.paymentCanonicalId = eventCanonicalId;
            expense.paymentBlockHeight = event.blockHeight;
          } else if (expense.status === "paid" && expense.txid === event.txid) {
            if (settlementPosted) {
              appendJournal(state, {
                date: accountingDate(),
                description: `REORG REVERSAL ENTRY · ${expense.number}`,
                sourceType: "payment",
                sourceId: expense.id,
                recordCommitment: expense.documentHash,
                vaultId: expense.vaultId,
                chainTxid: event.txid,
                valuationRateTry: expense.valuationRateTry,
                valuationSource: expense.valuationSource,
                lines: [
                  {
                    accountCode: "102.10",
                    accountName: "ZEC Testnet Asset",
                    debitTry: expense.tryTotal,
                    creditTry: 0,
                    zatoshi: event.zatoshi,
                  },
                  { accountCode: "320", accountName: "Trade Payables", debitTry: 0, creditTry: expense.tryTotal },
                ],
              });
              posted += 1;
            }
            if (networkFeePosted) {
              const original = state.journals.find(
                (entry) =>
                  entry.sourceType === "fee" &&
                  entry.chainTxid === event.txid &&
                  !entry.description.startsWith("REORG REVERSAL"),
              );
              const feeTry = original?.lines.reduce((sum, line) => sum + line.debitTry, 0) ?? 0;
              const feeZatoshi = original?.lines.find((line) => line.accountCode === "102.10")?.zatoshi;
              if (feeTry > 0) {
                appendJournal(state, {
                  date: accountingDate(),
                  description: `REORG REVERSAL ENTRY · ZIP-317 · ${expense.number}`,
                  sourceType: "fee",
                  sourceId: `${expense.id}:fee`,
                  vaultId: expense.vaultId,
                  chainTxid: event.txid,
                  valuationRateTry: original?.valuationRateTry ?? transactionValuationRateTry,
                  valuationSource: original?.valuationSource ?? "configured-static",
                  lines: [
                    {
                      accountCode: "102.10",
                      accountName: "ZEC Testnet Asset",
                      debitTry: feeTry,
                      creditTry: 0,
                      zatoshi: feeZatoshi,
                    },
                    { accountCode: "780", accountName: "Financing / Network Expenses", debitTry: 0, creditTry: feeTry },
                  ],
                });
                posted += 1;
              }
            }
            expense.status = "approved";
            delete expense.txid;
            delete expense.paymentCanonicalId;
            delete expense.paymentBlockHeight;
          }
        }
      }

      state.settings.lastSyncScope = syncScope;
      state.settings.lastSyncAt = syncObservedAt;
      if (scanToken) state.settings.lastSyncToken = scanToken;
      state.activities.unshift({
        id: randomUUID(),
        kind: "sync",
        title: "Live testnet synchronization completed",
        detail: `${imported} new · ${updated} updated · ${matched} exact memo matches · ${missing.length} missing/orphaned`,
        timestamp: new Date().toISOString(),
        tone: "positive",
      });
      return { observed: observed.length, imported, updated, matched, posted, orphaned: missing.length };
    });
    return noStoreJson({ ok: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
