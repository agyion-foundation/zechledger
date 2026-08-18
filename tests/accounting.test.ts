import { describe, expect, it } from "vitest";
import {
  appendJournal,
  buildAuditManifest,
  canonicalJson,
  computeMetrics,
  sha256,
  verifyLedgerChain,
} from "@/lib/accounting";
import { createSeedState } from "@/lib/seed";
import { verifyRecordCommitments } from "@/lib/commitments";

describe("double-entry, tamper-evident ledger", () => {
  it("creates a balanced synthetic presentation seed", () => {
    const state = createSeedState();
    expect(state.journals.length).toBeGreaterThan(10);
    expect(verifyLedgerChain(state)).toEqual({ valid: true });
    expect(computeMetrics(state).journalBalanced).toBe(true);
  });

  it("rejects an unbalanced journal entry", () => {
    const state = createSeedState();
    expect(() =>
      appendJournal(state, {
        date: "2026-08-01",
        description: "malformed",
        sourceType: "fee",
        sourceId: "x",
        vaultId: "vault-export",
        lines: [
          { accountCode: "100", accountName: "Cash", debitTry: 100, creditTry: 0 },
          { accountCode: "600", accountName: "Revenue", debitTry: 0, creditTry: 99 },
        ],
      }),
    ).toThrow(/not balanced/);
  });

  it("prevents Infinity or unsafe TRY-cent amounts from corrupting the ledger", () => {
    const state = createSeedState();
    expect(() =>
      appendJournal(state, {
        date: "2026-08-01",
        description: "overflow",
        sourceType: "fee",
        sourceId: "overflow",
        vaultId: "vault-export",
        lines: [
          { accountCode: "100", accountName: "Cash", debitTry: Infinity, creditTry: 0 },
          { accountCode: "600", accountName: "Revenue", debitTry: 0, creditTry: Infinity },
        ],
      }),
    ).toThrow(/integer TRY cents/);
  });

  it("breaks the hash chain when a journal identity or number is changed", () => {
    const state = createSeedState();
    state.journals[0].id = "identity-changed";
    expect(verifyLedgerChain(state).valid).toBe(false);
  });

  it("detects changes to historical records during hash-chain verification", () => {
    const state = createSeedState();
    state.journals[2].lines[0].debitTry += 1;
    const result = verifyLedgerChain(state);
    expect(result.valid).toBe(false);
    expect(result.at).toBe(state.journals[2].number);
  });

  it("balances debits and credits in every journal entry", () => {
    const state = createSeedState();
    for (const entry of state.journals) {
      expect(entry.lines.reduce((s, l) => s + l.debitTry, 0)).toBe(entry.lines.reduce((s, l) => s + l.creditTry, 0));
    }
  });

  it("computes accounting metrics from seed documents", () => {
    const metrics = computeMetrics(createSeedState());
    expect(metrics.revenueTry).toBeGreaterThan(metrics.expensesTry);
    expect(metrics.collectionRate).toBeGreaterThan(60);
    expect(metrics.confirmedTransactions).toBeGreaterThan(0);
    expect(BigInt(metrics.walletBalanceZatoshi)).toBeGreaterThan(0n);
  });
  it("treats internal vault-transfer principal as neutral and the source fee as balance-reducing", () => {
    const state = createSeedState();
    const before = BigInt(computeMetrics(state).walletBalanceZatoshi);
    const template = state.transactions[0];
    state.transactions.push({
      ...template,
      id: "internal-fee-metric",
      txid: "a".repeat(64),
      direction: "internal",
      zatoshi: "999999",
      feeZatoshi: "1234",
      status: "confirmed",
    });
    expect(BigInt(computeMetrics(state).walletBalanceZatoshi)).toBe(before - 1234n);
  });

  it("produces the same audit-manifest hash after a JSON round trip", () => {
    const state = createSeedState();
    const period = state.invoices[0].issueDate.slice(0, 7);
    const { manifest, hash } = buildAuditManifest(state, state.invoices[0].vaultId, period);
    const downloaded = JSON.parse(JSON.stringify(manifest));
    expect(sha256(canonicalJson(downloaded))).toBe(hash);
  });

  it("fails closed on disk tampering with record metadata, the TRY total, or the issuance journal binding", () => {
    const clean = createSeedState();
    expect(verifyRecordCommitments(clean)).toEqual({ valid: true });

    const destinationTamper = structuredClone(clean);
    destinationTamper.expenses[0].payToAddress = destinationTamper.invoices[0].receiveAddress;
    expect(verifyRecordCommitments(destinationTamper).valid).toBe(false);

    const tryTamper = structuredClone(clean);
    tryTamper.invoices[0].tryTotal += 1;
    expect(verifyRecordCommitments(tryTamper)).toMatchObject({ valid: false });

    const journalTamper = structuredClone(clean);
    const issuance = journalTamper.journals.find((entry) => entry.sourceType === "invoice");
    if (!issuance) throw new Error("test issuance journal is missing");
    issuance.recordCommitment = "0".repeat(64);
    expect(verifyRecordCommitments(journalTamper).valid).toBe(false);
  });

  it("never copies the runtime receiver environment value into demo-seed QR codes or documents", () => {
    const previous = process.env.ZCASH_RECEIVER_ADDRESS;
    process.env.ZCASH_RECEIVER_ADDRESS = "t1-mainnet-or-invalid-attacker-value";
    try {
      const state = createSeedState();
      expect(state.invoices.every((invoice) => invoice.receiveAddress.startsWith("ztestsapling1"))).toBe(true);
      expect(state.invoices.some((invoice) => invoice.receiveAddress.includes("attacker"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ZCASH_RECEIVER_ADDRESS;
      else process.env.ZCASH_RECEIVER_ADDRESS = previous;
    }
  });

  it("fails closed on tampering with the settlement projection, observation, or audit envelope", () => {
    const clean = createSeedState();

    const fakePaid = structuredClone(clean);
    const pending = fakePaid.invoices.find((invoice) => invoice.status === "pending");
    if (!pending) throw new Error("pending invoice fixture is missing");
    pending.status = "paid";
    pending.paymentTxid = "f".repeat(64);
    pending.paidAt = new Date().toISOString();
    expect(verifyRecordCommitments(fakePaid)).toMatchObject({
      valid: false,
      at: expect.stringContaining(":settlement"),
    });

    const memoTamper = structuredClone(clean);
    memoTamper.invoices[0].memoRef = "ZECHLEDGER|tampered";
    expect(verifyRecordCommitments(memoTamper)).toMatchObject({ valid: false, at: expect.stringContaining(":memo") });

    const observationTamper = structuredClone(clean);
    observationTamper.transactions[0].memo = "tampered-wallet-observation";
    expect(verifyRecordCommitments(observationTamper)).toMatchObject({
      valid: false,
      at: expect.stringContaining("transaction-observation"),
    });

    const duplicateIssuance = structuredClone(clean);
    const issuance = duplicateIssuance.journals.find((entry) => entry.sourceType === "invoice");
    if (!issuance) throw new Error("invoice issuance fixture is missing");
    duplicateIssuance.journals.push(structuredClone(issuance));
    expect(verifyRecordCommitments(duplicateIssuance)).toMatchObject({
      valid: false,
      at: expect.stringContaining(":journal-binding"),
    });

    const capsuleState = structuredClone(clean);
    const manifest = {
      scope: { vaultId: "vault-export", period: "2026-08" },
      ledgerHead: clean.ledgerHead,
      journals: [],
    };
    capsuleState.auditCapsules.push({
      id: "capsule-integrity",
      requestId: "capsule-request",
      name: "Integrity",
      vaultId: "vault-export",
      period: "2026-08",
      scopes: ["journals"],
      manifestHash: sha256(canonicalJson(manifest)),
      signature: "AA==",
      signatureAlgorithm: "Ed25519",
      signingKeyFingerprint: "a".repeat(64),
      ledgerHead: clean.ledgerHead,
      entryCount: 0,
      createdAt: new Date().toISOString(),
      status: "local",
      manifest,
    });
    expect(verifyRecordCommitments(capsuleState)).toEqual({ valid: true });
    (capsuleState.auditCapsules[0].manifest as { scope: { period: string } }).scope.period = "2026-09";
    expect(verifyRecordCommitments(capsuleState)).toMatchObject({
      valid: false,
      at: expect.stringContaining(":manifest"),
    });
  });
});
