#!/usr/bin/env node
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

const accountingMonthFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
});
function accountingMonth(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid accounting timestamp");
  const parts = Object.fromEntries(accountingMonthFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}
function decimalFraction(value) {
  const match = Number(value)
    .toString()
    .toLowerCase()
    .match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match || !Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error("invalid valuation rate");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  const digits = BigInt(`${match[1]}${fraction}`);
  const scale = fraction.length - exponent;
  return scale >= 0
    ? { numerator: digits, denominator: 10n ** BigInt(scale) }
    : { numerator: digits * 10n ** BigInt(-scale), denominator: 1n };
}
function tryMinorUnitsFromZatoshi(zatoshi, rateTry) {
  const rate = decimalFraction(rateTry);
  const numerator = BigInt(zatoshi) * rate.numerator;
  const denominator = 1_000_000n * rate.denominator;
  const minorUnits = (2n * numerator + denominator) / (2n * denominator);
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("TRY valuation in minor units exceeds the safe integer range");
  return Number(minorUnits);
}
function zatoshiToZec(zatoshi) {
  const value = BigInt(zatoshi);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const keyFlag = args.indexOf("--public-key");
const publicKeyPath =
  keyFlag >= 0
    ? args[keyFlag + 1]
    : process.env.ZECHLEDGER_AUDIT_PUBLIC_KEY_PATH || path.join(process.cwd(), ".zechledger", "audit-public.pem");
if (!file || !publicKeyPath) {
  console.error("Usage: npm run verify:capsule -- capsule.json --public-key zechledger-audit-public.pem");
  process.exit(2);
}

try {
  const [payloadRaw, publicPem] = await Promise.all([readFile(file, "utf8"), readFile(publicKeyPath, "utf8")]);
  const payload = JSON.parse(payloadRaw);
  const manifest = payload.manifest;
  const expected = payload.verification?.expectedManifestHash ?? payload.capsule?.manifestHash;
  const signature = payload.verification?.signature ?? payload.capsule?.signature;
  const expectedKeyFingerprint = payload.verification?.signingKeyFingerprint ?? payload.capsule?.signingKeyFingerprint;
  if (
    payload.verification &&
    payload.capsule &&
    (payload.verification.expectedManifestHash !== payload.capsule.manifestHash ||
      payload.verification.signature !== payload.capsule.signature ||
      payload.verification.signingKeyFingerprint !== payload.capsule.signingKeyFingerprint)
  ) {
    throw new Error("capsule and verification cryptographic fields do not match");
  }
  if (!manifest || !expected || !signature || !expectedKeyFingerprint)
    throw new Error("Signed manifest fields are missing");
  if (manifest.protocol !== "zechledger-audit-capsule/3")
    throw new Error(
      "Unsupported capsule protocol; for legacy v2, use the verifier from the ZechLedger version that produced the capsule",
    );
  if (!["demo", "live"].includes(manifest.mode)) throw new Error("Capsule mode or evidenceClass is missing");
  const liveEvidenceClasses = new Set([
    "live-local-ledger-no-wallet-observation-in-scope",
    "hybrid-wallet-observed-rpc-and-local-ledger",
    "wallet-observed-rpc",
  ]);
  if (manifest.mode === "demo" && manifest.evidenceClass !== "presentation-fixture-no-chain-evidence")
    throw new Error("Invalid demo evidenceClass");
  if (manifest.mode === "live" && !liveEvidenceClasses.has(manifest.evidenceClass))
    throw new Error("Invalid live evidenceClass");
  if ((manifest.txids ?? []).some((tx) => tx.source !== "rpc"))
    throw new Error("A capsule may contain only RPC wallet observations");
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(manifest.scope?.period ?? "") ||
    manifest.scope?.accountingTimezone !== "Europe/Istanbul" ||
    manifest.scope?.accountingDatePolicy !== "Europe/Istanbul/v1" ||
    manifest.scope?.accountingPeriodRule !== "instant-in-timezone-calendar-month" ||
    !Number.isSafeInteger(manifest.scope?.minimumConfirmations) ||
    manifest.scope.minimumConfirmations < 1 ||
    manifest.scope?.expenseAccountPolicy !== "all-expenses-740/v1"
  ) {
    throw new Error("The signed accounting period, time zone, or confirmation policy is invalid");
  }
  if (!Number.isFinite(Date.parse(manifest.generatedAt))) throw new Error("Manifest generatedAt is invalid");
  const derivedEvidenceClass =
    manifest.mode === "demo"
      ? "presentation-fixture-no-chain-evidence"
      : (manifest.txids ?? []).length === 0
        ? "live-local-ledger-no-wallet-observation-in-scope"
        : (manifest.journals ?? []).length > 0 || (manifest.documents ?? []).length > 0
          ? "hybrid-wallet-observed-rpc-and-local-ledger"
          : "wallet-observed-rpc";
  if (manifest.evidenceClass !== derivedEvidenceClass) throw new Error("evidenceClass does not match the content");
  const actual = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
  const actualKeyFingerprint = createHash("sha256").update(publicPem.trim()).digest("hex");
  const capsule = payload.capsule;
  if (
    !capsule ||
    capsule.vaultId !== manifest.scope?.vaultId ||
    capsule.period !== manifest.scope?.period ||
    capsule.ledgerHead !== manifest.ledgerHead ||
    capsule.entryCount !== (manifest.journals ?? []).length
  ) {
    throw new Error("Capsule envelope scope does not match the signed manifest");
  }
  const manifestTxids = new Set((manifest.txids ?? []).map((transaction) => transaction.txid));
  const seenJournals = new Set();
  for (const entry of manifest.journals ?? []) {
    if (seenJournals.has(entry.id) || seenJournals.has(entry.hash)) throw new Error("duplicate journal entry");
    seenJournals.add(entry.id);
    seenJournals.add(entry.hash);
    const periodEntry = entry.capsuleScopeRole === "period-entry" && entry.date?.startsWith(manifest.scope.period);
    const settlementSupport =
      entry.capsuleScopeRole === "settlement-support" &&
      !entry.date?.startsWith(manifest.scope.period) &&
      entry.chainTxid &&
      manifestTxids.has(entry.chainTxid);
    if (
      manifest.mode === "live" &&
      periodEntry &&
      ["payment", "fee", "transfer"].includes(entry.sourceType) &&
      (!entry.chainTxid || !manifestTxids.has(entry.chainTxid))
    ) {
      throw new Error(
        `${entry.number ?? "journal"} current-period chain entry is not supported by a current confirmed wallet output`,
      );
    }
    if (!entry.lines?.length || entry.vaultId !== manifest.scope.vaultId || (!periodEntry && !settlementSupport)) {
      throw new Error(`${entry.number ?? "journal"} is outside the manifest vault/period/support scope`);
    }
    for (const line of entry.lines) {
      if (
        !Number.isSafeInteger(line.debitTry) ||
        line.debitTry < 0 ||
        !Number.isSafeInteger(line.creditTry) ||
        line.creditTry < 0
      ) {
        throw new Error(`${entry.number} line is not a safe, non-negative integer amount in TRY minor units`);
      }
    }
    const debit = entry.lines.reduce((sum, line) => sum + line.debitTry, 0);
    const credit = entry.lines.reduce((sum, line) => sum + line.creditTry, 0);
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit <= 0 || debit !== credit)
      throw new Error(`${entry.number} is not a balanced entry with safe integer TRY minor units`);
    const core = { ...entry };
    delete core.hash;
    delete core.capsuleScopeRole;
    const expectedJournalHash = createHash("sha256")
      .update(`${entry.previousHash}:${canonicalJson(core)}`)
      .digest("hex");
    if (expectedJournalHash !== entry.hash) throw new Error(`${entry.number} journal digest is invalid`);
  }
  const maxMoney = 2_100_000_000_000_000n;
  const referencedDocumentIds = new Set([
    ...(manifest.journals ?? [])
      .filter((entry) => ["invoice", "expense", "payment"].includes(entry.sourceType))
      .map((entry) => entry.sourceId),
    ...(manifest.txids ?? []).flatMap((tx) => [tx.invoiceId, tx.expenseId].filter(Boolean)),
  ]);
  const documentsById = new Map();
  for (const document of manifest.documents ?? []) {
    if (!document.id || documentsById.has(document.id)) throw new Error("duplicate or missing document ID");
    if (!document.metadata?.record || !document.commitment)
      throw new Error("record metadata commitment payload is missing");
    if (document.metadata.id !== document.id || document.metadata.kind !== document.kind)
      throw new Error("document wrapper identity does not match the committed metadata envelope");
    const identityCommitment = createHash("sha256")
      .update(canonicalJson({ id: document.id, kind: document.kind, recordCommitment: document.commitment }))
      .digest("hex");
    if (identityCommitment !== document.identityCommitment)
      throw new Error("document wrapper identity commitment does not match");
    const commitment = createHash("sha256").update(canonicalJson(document.metadata.record)).digest("hex");
    if (commitment !== document.commitment)
      throw new Error(`${document.kind ?? "record"} metadata commitment does not match`);
    const record = document.metadata.record;
    if (
      !/^[1-9]\d*$/.test(record.zatoshi ?? "") ||
      BigInt(record.zatoshi) > maxMoney ||
      record.amountZec !== zatoshiToZec(record.zatoshi) ||
      !Number.isSafeInteger(record.tryTotal) ||
      record.tryTotal <= 0 ||
      !Number.isFinite(record.valuationRateTry) ||
      record.valuationRateTry <= 0 ||
      record.valuationSource !== "configured-static" ||
      !Number.isSafeInteger(record.vatRate) ||
      record.vatRate < 0 ||
      record.vatRate > 100 ||
      tryMinorUnitsFromZatoshi(record.zatoshi, record.valuationRateTry) !== record.tryTotal
    ) {
      throw new Error("canonical document zatoshi/amountZec/TRY/value/VAT fields are invalid");
    }
    if (!["invoice", "expense"].includes(document.kind) || document.metadata.record.vaultId !== manifest.scope.vaultId)
      throw new Error("document kind/vault is outside the manifest scope");
    const issuanceDate =
      document.kind === "invoice" ? document.metadata.record.issueDate : document.metadata.record.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issuanceDate ?? "")) throw new Error("document issuance date is invalid");
    const expectedRoles = [
      issuanceDate.startsWith(manifest.scope.period) ? "issuance" : null,
      referencedDocumentIds.has(document.id) ? "settlement-reference" : null,
    ].filter(Boolean);
    const actualRoles = [...(document.scopeRoles ?? [])];
    if (
      expectedRoles.length === 0 ||
      actualRoles.length !== new Set(actualRoles).size ||
      canonicalJson([...actualRoles].sort()) !== canonicalJson([...expectedRoles].sort())
    ) {
      throw new Error(`${document.kind} scopeRoles do not match the period/reference scope`);
    }
    documentsById.set(document.id, document);
  }
  for (const entry of manifest.journals ?? []) {
    if (!["invoice", "expense"].includes(entry.sourceType)) continue;
    const document = documentsById.get(entry.sourceId);
    if (!document || entry.recordCommitment !== document.commitment || document.kind !== entry.sourceType) {
      throw new Error(`${entry.number} issuance journal/document commitment binding is invalid`);
    }
  }
  for (const document of documentsById.values()) {
    if (!document.scopeRoles.includes("issuance")) continue;
    const record = document.metadata.record;
    const issuanceEntries = (manifest.journals ?? []).filter(
      (entry) => entry.sourceType === document.kind && entry.sourceId === document.id,
    );
    const issuanceDate = document.kind === "invoice" ? record.issueDate : record.date;
    if (
      issuanceEntries.length !== 1 ||
      issuanceEntries[0].capsuleScopeRole !== "period-entry" ||
      issuanceEntries[0].date !== issuanceDate ||
      issuanceEntries[0].vaultId !== manifest.scope.vaultId ||
      issuanceEntries[0].recordCommitment !== document.commitment ||
      issuanceEntries[0].valuationRateTry !== record.valuationRateTry ||
      issuanceEntries[0].valuationSource !== record.valuationSource
    ) {
      throw new Error(`${document.kind} issuance role is missing its exact committed journal`);
    }
    const entry = issuanceEntries[0];
    const allowedAccounts = document.kind === "invoice" ? ["120", "600", "391"] : ["740", "191", "320"];
    if (entry.lines.some((line) => !allowedAccounts.includes(line.accountCode) || line.zatoshi !== undefined))
      throw new Error(`${document.kind} issuance journal account/zatoshi shape is invalid`);
    const delta = (accountCode) =>
      entry.lines
        .filter((line) => line.accountCode === accountCode)
        .reduce((sum, line) => sum + line.debitTry - line.creditTry, 0);
    const denominator = BigInt(100 + record.vatRate);
    const numerator = BigInt(record.tryTotal) * 100n;
    const net = Number((2n * numerator + denominator) / (2n * denominator));
    const vat = record.tryTotal - net;
    const shapeValid =
      document.kind === "invoice"
        ? delta("120") === record.tryTotal && delta("600") === -net && delta("391") === -vat
        : delta("740") === net && delta("191") === vat && delta("320") === -record.tryTotal;
    if (!shapeValid) throw new Error(`${document.kind} issuance journal TRY/VAT direction does not match the metadata`);
  }
  const canonicalOutputs = new Set();
  const walletObservation = manifest.walletObservation;
  let scanTip = null;
  if ((manifest.txids ?? []).length > 0) {
    const observedAtMs = Date.parse(walletObservation?.observedAt ?? "");
    const generatedAtMs = Date.parse(manifest.generatedAt);
    if (
      !Number.isFinite(observedAtMs) ||
      observedAtMs > generatedAtMs ||
      generatedAtMs - observedAtMs > 15 * 60 * 1000 ||
      !/^\d+:[0-9a-f]{64}(?::legacy)?$/i.test(walletObservation?.scanToken ?? "") ||
      !/^[0-9a-f]{64}$/i.test(walletObservation?.syncScope ?? "") ||
      walletObservation?.confirmationsAsOfObservation !== true
    ) {
      throw new Error("Wallet observation exact-tip/freshness scope is invalid");
    }
    scanTip = Number(walletObservation.scanToken.split(":", 1)[0]);
    if (!Number.isSafeInteger(scanTip) || scanTip < 1) throw new Error("Wallet observation scan tip is invalid");
  }
  for (const tx of manifest.txids ?? []) {
    if (
      !/^[0-9a-f]{64}$/i.test(tx.txid) ||
      !/^[0-9a-f]{64}$/i.test(tx.canonicalId) ||
      !Number.isFinite(Date.parse(tx.timestamp)) ||
      accountingMonth(tx.timestamp) !== manifest.scope.period ||
      !Number.isFinite(Date.parse(tx.lastObservedAt)) ||
      tx.lastObservedAt !== walletObservation.observedAt ||
      tx.syncScope !== walletObservation.syncScope ||
      tx.status !== "confirmed" ||
      !Number.isSafeInteger(tx.confirmations) ||
      tx.confirmations < manifest.scope.minimumConfirmations ||
      !Number.isSafeInteger(tx.blockHeight) ||
      tx.blockHeight < 1 ||
      tx.confirmations !== Math.max(0, scanTip - tx.blockHeight + 1) ||
      !["incoming", "outgoing", "anchor", "internal"].includes(tx.direction) ||
      !["Orchard", "Sapling", "Ironwood", "Transparent"].includes(tx.pool) ||
      !Number.isFinite(tx.accountingValuationRateTry) ||
      tx.accountingValuationRateTry <= 0 ||
      tx.accountingValuationSource !== "configured-static" ||
      !/^[0-9a-f]{64}$/i.test(tx.accountFingerprint ?? "") ||
      !/^[1-9]\d*$/.test(tx.zatoshi) ||
      BigInt(tx.zatoshi) > maxMoney ||
      (tx.feeZatoshi !== undefined && (!/^(0|[1-9]\d*)$/.test(tx.feeZatoshi) || BigInt(tx.feeZatoshi) > maxMoney))
    ) {
      throw new Error("canonical wallet output identity/numeric/status/timestamp field is invalid");
    }
    if (![tx.vaultId, tx.sourceVaultId, tx.destinationVaultId].includes(manifest.scope.vaultId)) {
      throw new Error("wallet output is outside the manifest vault scope");
    }
    const fingerprint = (value) => /^[0-9a-f]{64}$/i.test(value ?? "");
    if (tx.direction === "internal") {
      if (
        !tx.sourceVaultId ||
        !tx.destinationVaultId ||
        tx.sourceVaultId === tx.destinationVaultId ||
        tx.vaultId !== tx.sourceVaultId ||
        !fingerprint(tx.sourceAccountFingerprint) ||
        !fingerprint(tx.destinationAccountFingerprint) ||
        tx.accountFingerprint !== tx.sourceAccountFingerprint ||
        ![tx.sourceVaultId, tx.destinationVaultId].includes(manifest.scope.vaultId)
      )
        throw new Error("internal transfer source/destination vault/account roles are invalid");
    } else if (tx.direction === "incoming") {
      if (
        tx.vaultId !== manifest.scope.vaultId ||
        tx.sourceVaultId ||
        tx.sourceAccountFingerprint ||
        (tx.destinationVaultId && tx.destinationVaultId !== tx.vaultId) ||
        (tx.destinationAccountFingerprint && tx.destinationAccountFingerprint !== tx.accountFingerprint)
      )
        throw new Error("incoming wallet output vault/account roles are invalid");
    } else if (tx.direction === "outgoing") {
      if (
        tx.vaultId !== manifest.scope.vaultId ||
        (tx.sourceVaultId && tx.sourceVaultId !== tx.vaultId) ||
        (tx.sourceAccountFingerprint && tx.sourceAccountFingerprint !== tx.accountFingerprint) ||
        tx.destinationVaultId ||
        tx.destinationAccountFingerprint
      )
        throw new Error("outgoing wallet output vault/account roles are invalid");
    } else if (
      tx.vaultId !== manifest.scope.vaultId ||
      tx.anchorInternalProvenance !== true ||
      (tx.sourceVaultId && tx.sourceVaultId !== tx.vaultId) ||
      (tx.destinationVaultId && tx.destinationVaultId !== tx.vaultId) ||
      (tx.sourceAccountFingerprint && tx.sourceAccountFingerprint !== tx.accountFingerprint) ||
      (tx.destinationAccountFingerprint && tx.destinationAccountFingerprint !== tx.accountFingerprint)
    ) {
      throw new Error("anchor wallet output vault/account provenance roles are invalid");
    }
    if (canonicalOutputs.has(tx.canonicalId)) throw new Error("duplicate canonical wallet output");
    canonicalOutputs.add(tx.canonicalId);
    const scopedJournalDelta = (entries, accountCode) =>
      entries
        .flatMap((entry) => entry.lines)
        .filter((line) => line.accountCode === accountCode)
        .reduce((sum, line) => sum + line.debitTry - line.creditTry, 0);
    const scopePaysFee =
      BigInt(tx.feeZatoshi ?? "0") > 0n &&
      tx.direction !== "incoming" &&
      (tx.direction !== "internal" || tx.sourceVaultId === manifest.scope.vaultId);
    if (scopePaysFee) {
      const expectedFeeTry = tryMinorUnitsFromZatoshi(tx.feeZatoshi, tx.accountingValuationRateTry);
      const feeEntries = (manifest.journals ?? []).filter(
        (entry) =>
          entry.sourceType === "fee" && entry.chainTxid === tx.txid && entry.vaultId === manifest.scope.vaultId,
      );
      if (
        (expectedFeeTry === 0 && feeEntries.length > 0) ||
        (expectedFeeTry > 0 &&
          (feeEntries.length === 0 ||
            feeEntries.some(
              (entry) =>
                entry.valuationRateTry !== tx.accountingValuationRateTry ||
                entry.valuationSource !== tx.accountingValuationSource ||
                entry.lines.some(
                  (line) =>
                    !["102.10", "780"].includes(line.accountCode) ||
                    (line.accountCode === "102.10" && line.zatoshi !== tx.feeZatoshi),
                ),
            ) ||
            scopedJournalDelta(feeEntries, "780") !== expectedFeeTry ||
            scopedJournalDelta(feeEntries, "102.10") !== -expectedFeeTry))
      ) {
        throw new Error("wallet fee output does not match the net 780/102.10 journal accounting");
      }
    }
    if (tx.direction === "internal") {
      const sourceSide = tx.sourceVaultId === manifest.scope.vaultId;
      const transferSourceId = `${sourceSide ? "internal-out" : "internal-in"}:${tx.canonicalId}`;
      const transferEntries = (manifest.journals ?? []).filter(
        (entry) =>
          entry.sourceType === "transfer" &&
          entry.sourceId === transferSourceId &&
          entry.chainTxid === tx.txid &&
          entry.vaultId === manifest.scope.vaultId,
      );
      const expectedTransferTry = tryMinorUnitsFromZatoshi(tx.zatoshi, tx.accountingValuationRateTry);
      const expectedCashDelta = sourceSide ? -expectedTransferTry : expectedTransferTry;
      const expectedClearingDelta = -expectedCashDelta;
      if (
        expectedTransferTry <= 0 ||
        transferEntries.length === 0 ||
        transferEntries.some(
          (entry) =>
            entry.valuationRateTry !== tx.accountingValuationRateTry ||
            entry.valuationSource !== tx.accountingValuationSource ||
            entry.lines.some(
              (line) =>
                !["102.10", "136.10"].includes(line.accountCode) ||
                (line.accountCode === "102.10" && line.zatoshi !== tx.zatoshi),
            ),
        ) ||
        scopedJournalDelta(transferEntries, "102.10") !== expectedCashDelta ||
        scopedJournalDelta(transferEntries, "136.10") !== expectedClearingDelta
      ) {
        throw new Error(
          "internal transfer does not match the net 136.10/102.10 journal accounting for the selected scope",
        );
      }
    }
    if (tx.pool === "Transparent" && (tx.direction === "anchor" || Boolean(tx.memo))) {
      throw new Error("a memo/anchor wallet output cannot be Transparent under shielded semantics");
    }
    const linkedId = tx.invoiceId ?? tx.expenseId;
    if (!linkedId) continue;
    if (tx.pool === "Transparent") throw new Error("a document settlement wallet output cannot be Transparent");
    const document = documentsById.get(linkedId);
    if (!document) throw new Error("the wallet output's linked record commitment is missing from the capsule");
    const expectedMemo = `ZECHLEDGER|${document.metadata.record.number}|${document.commitment.slice(0, 12)}`;
    const invoiceMatch =
      tx.invoiceId &&
      document.kind === "invoice" &&
      tx.direction === "incoming" &&
      tx.zatoshi === document.metadata.record.zatoshi &&
      tx.memo === expectedMemo &&
      tx.toAddress === document.metadata.record.receiveAddress &&
      tx.accountFingerprint === document.metadata.record.receiveAccountFingerprint;
    const expenseMatch =
      tx.expenseId &&
      document.kind === "expense" &&
      tx.direction === "outgoing" &&
      tx.zatoshi === document.metadata.record.zatoshi &&
      tx.memo === expectedMemo &&
      tx.toAddress === document.metadata.record.payToAddress &&
      tx.accountFingerprint === document.metadata.record.sourceAccountFingerprint;
    if (!invoiceMatch && !expenseMatch)
      throw new Error("wallet output does not match the record's memo/amount/address/account commitment");
    const paymentEntries = (manifest.journals ?? []).filter(
      (entry) => entry.sourceType === "payment" && entry.sourceId === linkedId && entry.chainTxid === tx.txid,
    );
    if (
      paymentEntries.length === 0 ||
      paymentEntries.some(
        (entry) =>
          entry.vaultId !== manifest.scope.vaultId ||
          entry.recordCommitment !== document.commitment ||
          entry.valuationRateTry !== document.metadata.record.valuationRateTry ||
          entry.valuationSource !== document.metadata.record.valuationSource ||
          entry.lines.some(
            (line) =>
              !["102.10", document.kind === "invoice" ? "120" : "320"].includes(line.accountCode) ||
              (line.accountCode === "102.10" && line.zatoshi !== tx.zatoshi) ||
              (line.accountCode !== "102.10" && line.zatoshi !== undefined),
          ),
      )
    ) {
      throw new Error("wallet output is missing a scoped payment journal/record commitment binding");
    }
    const accountDelta = (accountCode) =>
      paymentEntries
        .flatMap((entry) => entry.lines)
        .filter((line) => line.accountCode === accountCode)
        .reduce((sum, line) => sum + line.debitTry - line.creditTry, 0);
    const expectedTry = document.metadata.record.tryTotal;
    const cashDelta = accountDelta("102.10");
    const counterDelta = accountDelta(document.kind === "invoice" ? "120" : "320");
    if (
      !Number.isSafeInteger(expectedTry) ||
      expectedTry <= 0 ||
      (document.kind === "invoice" && (cashDelta !== expectedTry || counterDelta !== -expectedTry)) ||
      (document.kind === "expense" && (cashDelta !== -expectedTry || counterDelta !== expectedTry))
    ) {
      throw new Error("wallet output payment journal does not match the net settlement amount/direction");
    }
  }
  if (manifest.ledgerHead !== capsule.ledgerHead) throw new Error("manifest/capsule ledger head fields do not match");
  console.log(`Expected: ${expected}`);
  console.log(`Computed: ${actual}`);
  console.log(`Signing key: ${actualKeyFingerprint}`);
  if (actual !== expected) throw new Error("manifest digest does not match — the content has been modified");
  if (actualKeyFingerprint !== expectedKeyFingerprint)
    throw new Error("public key fingerprint does not match the capsule");
  const signatureValid = verify(
    null,
    Buffer.from(actual, "hex"),
    createPublicKey(publicPem),
    Buffer.from(signature, "base64"),
  );
  if (!signatureValid) throw new Error("Ed25519 signature is invalid");
  const receipt = capsule.anchorReceipt;
  if (capsule.status === "anchored" && !receipt)
    throw new Error("signed wallet observation receipt is missing for the anchored capsule");
  if (receipt) {
    if (
      receipt.manifestHash !== expected ||
      receipt.txid !== capsule.anchorTxid ||
      receipt.signingKeyFingerprint !== actualKeyFingerprint
    ) {
      throw new Error("anchor receipt does not match the capsule/key");
    }
    const plan = manifest.anchorPlan;
    if (
      !plan ||
      !/^[0-9a-f]{64}$/i.test(receipt.txid ?? "") ||
      !/^[0-9a-f]{64}$/i.test(receipt.accountFingerprint ?? "") ||
      !/^[1-9]\d*$/.test(receipt.zatoshi ?? "") ||
      BigInt(receipt.zatoshi) > maxMoney ||
      plan.accountFingerprint !== receipt.accountFingerprint ||
      plan.zatoshi !== receipt.zatoshi ||
      capsule.anchorAddress !== plan.toAddress ||
      receipt.memo !== `ZECHLEDGER|AUDIT|v3|${expected}` ||
      receipt.internalProvenance !== "same-account-from-to" ||
      !Number.isSafeInteger(receipt.blockHeight) ||
      receipt.blockHeight < 1 ||
      !Number.isSafeInteger(receipt.confirmations) ||
      receipt.confirmations < manifest.scope.minimumConfirmations ||
      !Number.isFinite(Date.parse(receipt.observedAt)) ||
      (receipt.destinationObserved !== null && receipt.destinationObserved !== plan.toAddress)
    ) {
      throw new Error("anchor receipt does not match the signed plan/account/destination/amount/memo");
    }
    const receiptCore = {
      manifestHash: receipt.manifestHash,
      txid: receipt.txid,
      blockHeight: receipt.blockHeight,
      confirmations: receipt.confirmations,
      observedAt: receipt.observedAt,
      destinationObserved: receipt.destinationObserved,
      accountFingerprint: receipt.accountFingerprint,
      memo: receipt.memo,
      zatoshi: receipt.zatoshi,
      internalProvenance: receipt.internalProvenance,
    };
    const receiptDigest = createHash("sha256").update(canonicalJson(receiptCore)).digest();
    if (!verify(null, receiptDigest, createPublicKey(publicPem), Buffer.from(receipt.signature, "base64"))) {
      throw new Error("anchor wallet observation receipt signature is invalid");
    }
    console.log(
      `✓ Signed wallet observation: ${receipt.txid} @ ${receipt.blockHeight} (${receipt.confirmations} confirmations)`,
    );
    console.log(
      "  This receipt is not independent proof of memo decryption or chain inclusion; verify the UFVK and node through a separate channel.",
    );
    if (capsule.status !== "anchored")
      console.warn("⚠ The outer-envelope status field is unsigned; using the valid signed anchor receipt.");
  } else if (manifest.anchorPlan) {
    console.log(
      "  The anchor plan is signed; without a signed wallet observation receipt, there is no evidence that the anchor was completed.",
    );
  }
  console.log("✓ Signed manifest integrity and independent Ed25519 signature are valid.");
  if (manifest.mode === "demo")
    console.warn(
      "⚠ PRESENTATION FIXTURE: This capsule contains no chain or wallet evidence and is not live audit evidence.",
    );
  console.log(`  Network: ${manifest.network} · Scope: ${manifest.scope?.vaultName} / ${manifest.scope?.period}`);
  console.log(
    `  Journals: ${manifest.journals?.length ?? 0} · Transactions: ${manifest.txids?.length ?? 0} · Documents: ${manifest.documents?.length ?? 0}`,
  );
  console.log(
    "  Note: Scope entries are signed and their own journal hashes were verified; no Merkle inclusion proof is provided for the global ledgerHead.",
  );
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
