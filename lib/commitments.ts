import { canonicalJson, sha256 } from "@/lib/canonical";
import { MAX_MONEY_ZATOSHI, tryFromZatoshi, zatoshiToZec } from "@/lib/money";
import type { AppState, ChainTransaction } from "@/lib/types";

interface CommonCommitment {
  requestId: string;
  number: string;
  issuerLegalName: string;
  issuerTaxId: string;
  issuerFingerprint: string;
  zatoshi: string;
  tryTotal: number;
  valuationRateTry: number;
  valuationSource: "configured-static";
  vatRate: number;
  vaultId: string;
}
export interface InvoiceCommitmentInput extends CommonCommitment {
  client: string;
  title: string;
  issueDate: string;
  dueDate: string;
  receiveAddress: string;
  receiveAccountFingerprint?: string;
}
export interface ExpenseCommitmentInput extends CommonCommitment {
  vendor: string;
  category: string;
  description: string;
  date: string;
  payToAddress: string;
  sourceAccountFingerprint?: string;
}

export function invoiceCommitmentPayload(value: InvoiceCommitmentInput) {
  return {
    requestId: value.requestId,
    number: value.number,
    client: value.client,
    title: value.title,
    issuerLegalName: value.issuerLegalName,
    issuerTaxId: value.issuerTaxId,
    issuerFingerprint: value.issuerFingerprint,
    issueDate: value.issueDate,
    dueDate: value.dueDate,
    amountZec: zatoshiToZec(value.zatoshi),
    zatoshi: value.zatoshi,
    tryTotal: value.tryTotal,
    valuationRateTry: value.valuationRateTry,
    valuationSource: value.valuationSource,
    vatRate: value.vatRate,
    vaultId: value.vaultId,
    receiveAddress: value.receiveAddress,
    receiveAccountFingerprint: value.receiveAccountFingerprint,
  };
}

export function expenseCommitmentPayload(value: ExpenseCommitmentInput) {
  return {
    requestId: value.requestId,
    number: value.number,
    vendor: value.vendor,
    category: value.category,
    description: value.description,
    issuerLegalName: value.issuerLegalName,
    issuerTaxId: value.issuerTaxId,
    issuerFingerprint: value.issuerFingerprint,
    date: value.date,
    amountZec: zatoshiToZec(value.zatoshi),
    zatoshi: value.zatoshi,
    tryTotal: value.tryTotal,
    valuationRateTry: value.valuationRateTry,
    valuationSource: value.valuationSource,
    vatRate: value.vatRate,
    vaultId: value.vaultId,
    payToAddress: value.payToAddress,
    sourceAccountFingerprint: value.sourceAccountFingerprint,
  };
}

export const recordCommitment = (payload: object) => sha256(canonicalJson(payload));

export function transactionObservationPayload(transaction: ChainTransaction) {
  return {
    canonicalId: transaction.canonicalId ?? transaction.id,
    txid: transaction.txid,
    direction: transaction.direction,
    zatoshi: transaction.zatoshi,
    memo: transaction.memo,
    toAddress: transaction.toAddress ?? null,
    vaultId: transaction.vaultId,
    accountFingerprint: transaction.accountFingerprint ?? null,
    sourceAccountFingerprint: transaction.sourceAccountFingerprint ?? null,
    destinationAccountFingerprint: transaction.destinationAccountFingerprint ?? null,
    sourceVaultId: transaction.sourceVaultId ?? null,
    destinationVaultId: transaction.destinationVaultId ?? null,
    anchorInternalProvenance: transaction.anchorInternalProvenance ?? false,
    pool: transaction.pool,
    source: transaction.source,
  };
}

export const transactionObservationCommitment = (transaction: ChainTransaction) =>
  recordCommitment(transactionObservationPayload(transaction));

export function verifyRecordCommitments(state: AppState): { valid: boolean; at?: string } {
  try {
    const transactionIds = new Set<string>();
    const canonicalIds = new Set<string>();
    for (const transaction of state.transactions) {
      const amount = BigInt(transaction.zatoshi);
      const fee = transaction.feeZatoshi === undefined ? 0n : BigInt(transaction.feeZatoshi);
      if (transactionIds.has(transaction.id)) return { valid: false, at: `transaction-id:${transaction.id}` };
      transactionIds.add(transaction.id);
      if (transaction.canonicalId) {
        if (canonicalIds.has(transaction.canonicalId))
          return { valid: false, at: `transaction-canonical:${transaction.canonicalId}` };
        canonicalIds.add(transaction.canonicalId);
      }
      if (
        amount < 0n ||
        amount > MAX_MONEY_ZATOSHI ||
        fee < 0n ||
        fee > MAX_MONEY_ZATOSHI ||
        !Number.isSafeInteger(transaction.confirmations) ||
        transaction.confirmations < 0 ||
        (transaction.blockHeight !== undefined &&
          (!Number.isSafeInteger(transaction.blockHeight) || transaction.blockHeight < 0)) ||
        !Number.isFinite(Date.parse(transaction.timestamp))
      )
        return { valid: false, at: `transaction:${transaction.id}` };
      if (
        transaction.status === "confirmed" &&
        transaction.source === "rpc" &&
        (!/^[0-9a-f]{64}$/i.test(transaction.txid) || !/^[0-9a-f]{64}$/i.test(transaction.canonicalId ?? ""))
      ) {
        return { valid: false, at: `transaction-txid:${transaction.id}` };
      }
      const observed =
        transaction.source === "demo-fixture" || (transaction.source === "rpc" && Boolean(transaction.canonicalId));
      if (
        transaction.source === "rpc" &&
        transaction.canonicalId &&
        !/^[0-9a-f]{64}$/i.test(transaction.accountFingerprint ?? "")
      ) {
        return { valid: false, at: `transaction-account:${transaction.id}` };
      }
      if (
        transaction.direction === "internal" &&
        transaction.source === "rpc" &&
        (!/^[0-9a-f]{64}$/i.test(transaction.sourceAccountFingerprint ?? "") ||
          !/^[0-9a-f]{64}$/i.test(transaction.destinationAccountFingerprint ?? ""))
      ) {
        return { valid: false, at: `transaction-account:${transaction.id}` };
      }
      if (observed && transaction.observationHash !== transactionObservationCommitment(transaction)) {
        return { valid: false, at: `transaction-observation:${transaction.id}` };
      }
      if (transaction.direction === "internal") {
        const canonicalId = transaction.canonicalId ?? transaction.id;
        const sourceId = `internal-out:${canonicalId}`;
        const destinationId = `internal-in:${canonicalId}`;
        const sourceEntries = state.journals.filter(
          (entry) => entry.sourceType === "transfer" && entry.sourceId === sourceId,
        );
        const destinationEntries = state.journals.filter(
          (entry) => entry.sourceType === "transfer" && entry.sourceId === destinationId,
        );
        const sourceNet = sourceEntries.reduce(
          (net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1),
          0,
        );
        const destinationNet = destinationEntries.reduce(
          (net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1),
          0,
        );
        const sourceOriginal = sourceEntries.filter((entry) => !entry.description.startsWith("REORG REVERSAL")).at(-1);
        const destinationOriginal = destinationEntries
          .filter((entry) => !entry.description.startsWith("REORG REVERSAL"))
          .at(-1);
        const sourceCash = sourceOriginal?.lines.find((line) => line.accountCode === "102.10");
        const destinationCash = destinationOriginal?.lines.find((line) => line.accountCode === "102.10");
        const expectedTry = sourceOriginal?.valuationRateTry
          ? tryFromZatoshi(amount, sourceOriginal.valuationRateTry)
          : 0;
        if (
          !transaction.sourceVaultId ||
          !transaction.destinationVaultId ||
          transaction.sourceVaultId === transaction.destinationVaultId ||
          transaction.vaultId !== transaction.sourceVaultId ||
          (sourceOriginal &&
            (sourceCash?.zatoshi !== transaction.zatoshi ||
              sourceCash?.creditTry !== expectedTry ||
              sourceCash?.debitTry !== 0)) ||
          (destinationOriginal &&
            (destinationCash?.zatoshi !== transaction.zatoshi ||
              destinationCash?.debitTry !== expectedTry ||
              destinationCash?.creditTry !== 0)) ||
          (transaction.status === "confirmed" &&
            (sourceNet !== 1 || destinationNet !== 1 || !sourceOriginal || !destinationOriginal)) ||
          (transaction.status !== "confirmed" && (sourceNet !== 0 || destinationNet !== 0))
        ) {
          return { valid: false, at: `transaction-transfer:${transaction.id}` };
        }
      }
      if (fee > 0n && tryFromZatoshi(fee, state.settings.demoRateTry) > 0) {
        const feeEntries = state.journals.filter(
          (entry) => entry.sourceType === "fee" && entry.chainTxid === transaction.txid,
        );
        const activeFees = feeEntries.reduce(
          (net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1),
          0,
        );
        const originals = feeEntries.filter((entry) => !entry.description.startsWith("REORG REVERSAL"));
        const latest = originals.at(-1);
        const cash = latest?.lines.find((line) => line.accountCode === "102.10");
        const finance = latest?.lines.find((line) => line.accountCode === "780");
        const expectedTry = latest?.valuationRateTry ? tryFromZatoshi(fee, latest.valuationRateTry) : 0;
        if (
          (transaction.status === "confirmed" && activeFees !== 1) ||
          (transaction.status !== "confirmed" && activeFees !== 0) ||
          !latest ||
          cash?.zatoshi !== transaction.feeZatoshi ||
          Math.max(cash?.debitTry ?? 0, cash?.creditTry ?? 0) !== expectedTry ||
          Math.max(finance?.debitTry ?? 0, finance?.creditTry ?? 0) !== expectedTry
        ) {
          return { valid: false, at: `transaction-fee:${transaction.id}` };
        }
      }
    }

    const documentIds = new Set<string>();
    const invoiceRequests = new Set<string>();
    const invoiceNumbers = new Set<string>();
    for (const invoice of state.invoices) {
      if (documentIds.has(invoice.id) || invoiceRequests.has(invoice.requestId) || invoiceNumbers.has(invoice.number))
        return { valid: false, at: `${invoice.number}:duplicate` };
      documentIds.add(invoice.id);
      invoiceRequests.add(invoice.requestId);
      invoiceNumbers.add(invoice.number);
      if (invoice.memoRef !== `ZECHLEDGER|${invoice.number}|${invoice.documentHash.slice(0, 12)}`)
        return { valid: false, at: `${invoice.number}:memo` };
      if (invoice.tryTotal !== tryFromZatoshi(invoice.zatoshi, invoice.valuationRateTry))
        return { valid: false, at: `${invoice.number}:try-total` };
      if (recordCommitment(invoiceCommitmentPayload(invoice)) !== invoice.documentHash)
        return { valid: false, at: invoice.number };
      const issuance = state.journals.filter(
        (entry) => entry.sourceType === "invoice" && entry.sourceId === invoice.id,
      );
      const expectedIssuance = invoice.status === "draft" ? 0 : 1;
      if (
        issuance.length !== expectedIssuance ||
        issuance.some(
          (journal) =>
            journal.recordCommitment !== invoice.documentHash ||
            journal.lines.reduce((sum, line) => sum + line.debitTry, 0) !== invoice.tryTotal ||
            journal.lines.reduce((sum, line) => sum + line.creditTry, 0) !== invoice.tryTotal,
        )
      )
        return { valid: false, at: `${invoice.number}:journal-binding` };
      const settlements = state.journals.filter(
        (entry) => entry.sourceType === "payment" && entry.sourceId === invoice.id,
      );
      const activeSettlements = settlements.reduce(
        (net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1),
        0,
      );
      if (invoice.status === "paid") {
        if (!invoice.paymentTxid || activeSettlements !== 1)
          return { valid: false, at: `${invoice.number}:settlement` };
        const transaction = state.transactions.find(
          (item) => item.invoiceId === invoice.id && item.txid === invoice.paymentTxid && item.status === "confirmed",
        );
        const settlement = settlements
          .filter((entry) => entry.chainTxid === invoice.paymentTxid && !entry.description.startsWith("REORG REVERSAL"))
          .at(-1);
        const cash = settlement?.lines.find((line) => line.accountCode === "102.10");
        const receivable = settlement?.lines.find((line) => line.accountCode === "120");
        if (
          !transaction ||
          transaction.direction !== "incoming" ||
          transaction.zatoshi !== invoice.zatoshi ||
          transaction.memo !== invoice.memoRef ||
          transaction.vaultId !== invoice.vaultId ||
          cash?.zatoshi !== invoice.zatoshi ||
          cash?.debitTry !== invoice.tryTotal ||
          cash?.creditTry !== 0 ||
          receivable?.creditTry !== invoice.tryTotal ||
          receivable?.debitTry !== 0
        ) {
          return { valid: false, at: `${invoice.number}:payment-binding` };
        }
        if (
          state.mode === "live" &&
          (transaction.toAddress !== invoice.receiveAddress ||
            transaction.accountFingerprint !== invoice.receiveAccountFingerprint ||
            transaction.canonicalId !== invoice.paymentCanonicalId)
        )
          return { valid: false, at: `${invoice.number}:wallet-binding` };
        if (
          invoice.paidAt !== transaction.timestamp ||
          (invoice.paymentBlockHeight !== undefined && invoice.paymentBlockHeight !== transaction.blockHeight)
        ) {
          return { valid: false, at: `${invoice.number}:placement-binding` };
        }
      } else if (
        activeSettlements !== 0 ||
        invoice.paymentTxid ||
        invoice.paymentCanonicalId ||
        invoice.paymentBlockHeight !== undefined ||
        invoice.paidAt
      ) {
        return { valid: false, at: `${invoice.number}:unpaid-binding` };
      }
    }

    const expenseRequests = new Set<string>();
    const expenseNumbers = new Set<string>();
    for (const expense of state.expenses) {
      if (documentIds.has(expense.id) || expenseRequests.has(expense.requestId) || expenseNumbers.has(expense.number))
        return { valid: false, at: `${expense.number}:duplicate` };
      documentIds.add(expense.id);
      expenseRequests.add(expense.requestId);
      expenseNumbers.add(expense.number);
      if (expense.tryTotal !== tryFromZatoshi(expense.zatoshi, expense.valuationRateTry))
        return { valid: false, at: `${expense.number}:try-total` };
      if (recordCommitment(expenseCommitmentPayload(expense)) !== expense.documentHash)
        return { valid: false, at: expense.number };
      const issuance = state.journals.filter(
        (entry) => entry.sourceType === "expense" && entry.sourceId === expense.id,
      );
      if (
        issuance.length !== 1 ||
        issuance.some(
          (journal) =>
            journal.recordCommitment !== expense.documentHash ||
            journal.lines.reduce((sum, line) => sum + line.debitTry, 0) !== expense.tryTotal ||
            journal.lines.reduce((sum, line) => sum + line.creditTry, 0) !== expense.tryTotal,
        )
      )
        return { valid: false, at: `${expense.number}:journal-binding` };
      const settlements = state.journals.filter(
        (entry) => entry.sourceType === "payment" && entry.sourceId === expense.id,
      );
      const activeSettlements = settlements.reduce(
        (net, entry) => net + (entry.description.startsWith("REORG REVERSAL") ? -1 : 1),
        0,
      );
      if (expense.status === "paid") {
        if (!expense.txid || activeSettlements !== 1) return { valid: false, at: `${expense.number}:settlement` };
        const transaction = state.transactions.find(
          (item) => item.expenseId === expense.id && item.txid === expense.txid && item.status === "confirmed",
        );
        const expectedMemo = `ZECHLEDGER|${expense.number}|${expense.documentHash.slice(0, 12)}`;
        const settlement = settlements
          .filter((entry) => entry.chainTxid === expense.txid && !entry.description.startsWith("REORG REVERSAL"))
          .at(-1);
        const cash = settlement?.lines.find((line) => line.accountCode === "102.10");
        const payable = settlement?.lines.find((line) => line.accountCode === "320");
        if (
          !transaction ||
          transaction.direction !== "outgoing" ||
          transaction.zatoshi !== expense.zatoshi ||
          transaction.memo !== expectedMemo ||
          transaction.vaultId !== expense.vaultId ||
          cash?.zatoshi !== expense.zatoshi ||
          cash?.creditTry !== expense.tryTotal ||
          cash?.debitTry !== 0 ||
          payable?.debitTry !== expense.tryTotal ||
          payable?.creditTry !== 0
        ) {
          return { valid: false, at: `${expense.number}:payment-binding` };
        }
        if (
          state.mode === "live" &&
          (transaction.toAddress !== expense.payToAddress ||
            transaction.accountFingerprint !== expense.sourceAccountFingerprint ||
            transaction.canonicalId !== expense.paymentCanonicalId)
        )
          return { valid: false, at: `${expense.number}:wallet-binding` };
        if (expense.paymentBlockHeight !== undefined && expense.paymentBlockHeight !== transaction.blockHeight)
          return { valid: false, at: `${expense.number}:placement-binding` };
      } else if (
        activeSettlements !== 0 ||
        expense.txid ||
        expense.paymentCanonicalId ||
        expense.paymentBlockHeight !== undefined
      ) {
        return { valid: false, at: `${expense.number}:unpaid-binding` };
      }
    }

    const capsuleIds = new Set<string>();
    const capsuleRequests = new Set<string>();
    for (const capsule of state.auditCapsules) {
      if (capsuleIds.has(capsule.id) || capsuleRequests.has(capsule.requestId))
        return { valid: false, at: `audit:${capsule.id}:duplicate` };
      capsuleIds.add(capsule.id);
      capsuleRequests.add(capsule.requestId);
      if (
        capsule.requestFingerprint &&
        capsule.requestFingerprint !==
          recordCommitment({
            kind: "audit-request",
            requestId: capsule.requestId,
            vaultId: capsule.vaultId,
            period: capsule.period,
            anchor: Boolean(capsule.anchorAddress || capsule.status === "pending" || capsule.status === "anchored"),
          })
      )
        return { valid: false, at: `audit:${capsule.id}:request` };
      if (
        !capsule.manifest ||
        typeof capsule.manifest !== "object" ||
        recordCommitment(capsule.manifest) !== capsule.manifestHash
      ) {
        return { valid: false, at: `audit:${capsule.id}:manifest` };
      }
      const manifest = capsule.manifest as {
        scope?: { vaultId?: unknown; period?: unknown };
        ledgerHead?: unknown;
        journals?: unknown[];
      };
      if (
        manifest.scope?.vaultId !== capsule.vaultId ||
        manifest.scope?.period !== capsule.period ||
        manifest.ledgerHead !== capsule.ledgerHead ||
        !Array.isArray(manifest.journals) ||
        manifest.journals.length !== capsule.entryCount
      ) {
        return { valid: false, at: `audit:${capsule.id}:scope` };
      }
      if (capsule.status === "anchored") {
        const receipt = capsule.anchorReceipt;
        const transaction = capsule.anchorTxid
          ? state.transactions.find((item) => item.txid === capsule.anchorTxid && item.status === "confirmed")
          : undefined;
        if (
          !receipt ||
          !transaction ||
          receipt.manifestHash !== capsule.manifestHash ||
          receipt.txid !== capsule.anchorTxid ||
          receipt.blockHeight !== transaction.blockHeight ||
          receipt.memo !== transaction.memo ||
          receipt.zatoshi !== transaction.zatoshi ||
          receipt.accountFingerprint !== transaction.accountFingerprint ||
          receipt.internalProvenance !== "same-account-from-to"
        ) {
          return { valid: false, at: `audit:${capsule.id}:receipt` };
        }
      } else if (capsule.anchorReceipt) return { valid: false, at: `audit:${capsule.id}:status` };
    }
    return { valid: true };
  } catch {
    return { valid: false, at: "record-schema" };
  }
}
