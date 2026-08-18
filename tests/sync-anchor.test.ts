import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, DEMO_TESTNET_ADDRESSES } from "@/lib/seed";
import type { AppState, ChainTransaction } from "@/lib/types";

let state: AppState;
let observed: ChainTransaction[] = [];
vi.mock("@/lib/store", () => ({
  mutateState: vi.fn(async (mutator: (state: AppState) => unknown) => {
    const result = await mutator(state);
    return { state, result };
  }),
}));
vi.mock("@/lib/zcash-rpc", () => ({
  configuredWalletSyncScope: vi.fn(() => "1".repeat(64)),
  listReceivedTransactions: vi.fn(async () => observed),
  ZcashRpcError: class ZcashRpcError extends Error {
    code: number;
    constructor(message: string, code = -1) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock("@/lib/audit-signing", () => ({
  signAuditReceipt: vi.fn(async () => ({
    signature: Buffer.from("receipt").toString("base64"),
    keyFingerprint: "f".repeat(64),
  })),
}));

import { POST } from "@/app/api/zcash/sync/route";

const manifestHash = "b".repeat(64);
const txid = "c".repeat(64);
const canonicalId = "d".repeat(64);
const accountFingerprint = "a".repeat(64);
const previousWalletUrl = process.env.ZALLET_RPC_URL;
afterEach(() => {
  if (previousWalletUrl === undefined) delete process.env.ZALLET_RPC_URL;
  else process.env.ZALLET_RPC_URL = previousWalletUrl;
});

function event(status: "confirmed" | "pending"): ChainTransaction {
  return {
    id: canonicalId,
    txid,
    direction: "anchor",
    zatoshi: "1000",
    feeZatoshi: "10000",
    memo: `ZECHLEDGER|AUDIT|v3|${manifestHash}`,
    counterparty: "self",
    vaultId: "vault-export",
    accountFingerprint,
    anchorInternalProvenance: true,
    confirmations: status === "confirmed" ? 12 : 0,
    blockHeight: status === "confirmed" ? 4_200_000 : undefined,
    timestamp: "2026-08-16T12:00:00.000Z",
    status,
    pool: "Orchard",
    source: "rpc",
  };
}

beforeEach(() => {
  state = createSeedState();
  state.auditCapsules.unshift({
    id: "capsule-1",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    name: "Anchor test",
    vaultId: "vault-export",
    period: "2026-08",
    scopes: ["journals"],
    manifestHash,
    signature: Buffer.from("manifest").toString("base64"),
    signatureAlgorithm: "Ed25519",
    signingKeyFingerprint: "f".repeat(64),
    ledgerHead: state.ledgerHead,
    entryCount: 1,
    createdAt: "2026-08-16T10:00:00.000Z",
    status: "pending",
    anchorAddress: DEMO_TESTNET_ADDRESSES.export,
    anchorAccountFingerprint: accountFingerprint,
    manifest: { protocol: "zechledger-audit-capsule/3", scope: { minimumConfirmations: 10 } },
  });
  state.transactions.unshift({
    id: "intent-anchor",
    txid: "intent:intent-anchor",
    direction: "anchor",
    zatoshi: "1000",
    memo: `ZECHLEDGER|AUDIT|v3|${manifestHash}`,
    toAddress: DEMO_TESTNET_ADDRESSES.export,
    counterparty: "outbox",
    vaultId: "vault-export",
    accountFingerprint,
    confirmations: 0,
    timestamp: "2026-08-16T10:00:00.000Z",
    status: "pending",
    pool: "Shielded",
    source: "rpc",
  });
});

describe("anchor sync reconciliation", () => {
  it("creates a signed receipt from the exact memo and account even when internal to_address is null, then rolls it back after a reorg", async () => {
    observed = [event("confirmed")];
    let response = await POST();
    expect(response.status).toBe(200);
    const capsule = state.auditCapsules[0];
    expect(capsule.status).toBe("anchored");
    expect(capsule.anchorReceipt).toMatchObject({
      txid,
      destinationObserved: null,
      accountFingerprint,
      memo: `ZECHLEDGER|AUDIT|v3|${manifestHash}`,
      internalProvenance: "same-account-from-to",
    });
    expect(state.journals.some((entry) => entry.sourceType === "fee" && entry.chainTxid === txid)).toBe(true);

    observed = [{ ...event("confirmed"), blockHeight: 4_200_001 }];
    response = await POST();
    expect(response.status).toBe(200);
    expect(capsule.anchorReceipt?.blockHeight).toBe(4_200_001);

    observed = [event("pending")];
    response = await POST();
    expect(response.status).toBe(200);
    expect(capsule.status).toBe("pending");
    expect(capsule.anchorReceipt).toBeUndefined();
    const feeEntries = state.journals.filter((entry) => entry.sourceType === "fee" && entry.chainTxid === txid);
    expect(feeEntries).toHaveLength(4);
    expect(feeEntries.at(-1)?.description).toMatch(/^REORG REVERSAL/);
  });

  it("does not mutate a pending legacy v2 anchor as though the new policy applied", async () => {
    state.auditCapsules[0].manifest = { protocol: "zechledger-audit-capsule/2" };
    observed = [{ ...event("confirmed"), memo: `ZECHLEDGER|AUDIT|v2|${manifestHash}` }];
    expect((await POST()).status).toBe(200);
    expect(state.auditCapsules[0].status).toBe("pending");
    expect(state.auditCapsules[0].anchorReceipt).toBeUndefined();
  });

  it("enforces the minimum-confirmation policy signed by the capsule for the anchor receipt", async () => {
    state.auditCapsules[0].manifest = {
      protocol: "zechledger-audit-capsule/3",
      scope: { minimumConfirmations: 20 },
    };
    observed = [event("confirmed")];
    expect((await POST()).status).toBe(200);
    expect(state.auditCapsules[0].status).toBe("pending");
    expect(state.auditCapsules[0].anchorReceipt).toBeUndefined();
  });

  it("reverses the expense outbox canonicalId along with the payment and fee after two complete scans in which it is missing", async () => {
    process.env.ZALLET_RPC_URL = "http://mock-zallet";
    const expense = state.expenses[0];
    expense.status = "approved";
    delete expense.txid;
    delete expense.paymentCanonicalId;
    const intentId = "intent-expense";
    state.transactions.unshift({
      id: intentId,
      txid: `intent:${intentId}`,
      direction: "outgoing",
      zatoshi: expense.zatoshi,
      memo: `ZECHLEDGER|${expense.number}|${expense.documentHash.slice(0, 12)}`,
      toAddress: expense.payToAddress,
      counterparty: expense.vendor,
      vaultId: expense.vaultId,
      accountFingerprint: expense.sourceAccountFingerprint,
      expenseId: expense.id,
      confirmations: 0,
      timestamp: "2026-08-17T10:00:00.000Z",
      status: "pending",
      pool: "Orchard",
      source: "rpc",
    });
    const outputId = "e".repeat(64);
    const paymentTxid = "9".repeat(64);
    observed = [
      {
        id: outputId,
        txid: paymentTxid,
        direction: "outgoing",
        zatoshi: expense.zatoshi,
        feeZatoshi: "10000",
        memo: `ZECHLEDGER|${expense.number}|${expense.documentHash.slice(0, 12)}`,
        toAddress: expense.payToAddress,
        counterparty: expense.vendor,
        vaultId: expense.vaultId,
        accountFingerprint: expense.sourceAccountFingerprint,
        confirmations: 12,
        blockHeight: 4_200_010,
        timestamp: "2026-08-17T10:05:00.000Z",
        status: "confirmed",
        pool: "Orchard",
        source: "rpc",
      },
    ];
    expect((await POST()).status).toBe(200);
    expect(expense).toMatchObject({ status: "paid", txid: paymentTxid, paymentCanonicalId: outputId });
    expect(state.transactions.find((tx) => tx.id === intentId)?.canonicalId).toBe(outputId);

    observed = [{ ...observed[0], blockHeight: 4_200_010, timestamp: "2026-09-01T00:06:00.000Z" }];
    expect((await POST()).status).toBe(200);
    expect(expense.paymentBlockHeight).toBe(4_200_010);
    expect(
      state.journals.filter(
        (entry) => entry.sourceType === "payment" && entry.sourceId === expense.id && entry.chainTxid === paymentTxid,
      ),
    ).toHaveLength(3);

    observed = [];
    expect((await POST()).status).toBe(200);
    expect(expense.status).toBe("paid");
    expect(state.transactions.find((transaction) => transaction.canonicalId === outputId)?.observationState).toBe(
      "orphan-candidate",
    );
    expect((await POST()).status).toBe(200);
    expect(expense.status).toBe("approved");
    expect(expense.txid).toBeUndefined();
    expect(expense.paymentCanonicalId).toBeUndefined();
    const payments = state.journals.filter(
      (entry) => entry.sourceType === "payment" && entry.sourceId === expense.id && entry.chainTxid === paymentTxid,
    );
    expect(payments).toHaveLength(4);
    const fees = state.journals.filter((entry) => entry.sourceType === "fee" && entry.chainTxid === paymentTxid);
    expect(fees).toHaveLength(4);
  });

  it("does not let a previously expired attempt poison a new pending retry intent when it reappears", async () => {
    const expense = state.expenses[0];
    expense.status = "approved";
    delete expense.txid;
    delete expense.paymentCanonicalId;
    const oldId = "7".repeat(64);
    const oldTxid = "6".repeat(64);
    state.transactions.unshift({
      id: oldId,
      canonicalId: oldId,
      txid: oldTxid,
      direction: "outgoing",
      zatoshi: expense.zatoshi,
      memo: `ZECHLEDGER|${expense.number}|${expense.documentHash.slice(0, 12)}`,
      toAddress: expense.payToAddress,
      counterparty: expense.vendor,
      vaultId: expense.vaultId,
      accountFingerprint: expense.sourceAccountFingerprint,
      expenseId: expense.id,
      confirmations: 0,
      timestamp: "2026-08-17T09:00:00.000Z",
      status: "failed",
      failureReason: "expired-unmined",
      pool: "Orchard",
      source: "rpc",
    });
    state.transactions.unshift({
      id: "retry-intent",
      txid: "intent:retry-intent",
      direction: "outgoing",
      zatoshi: expense.zatoshi,
      memo: `ZECHLEDGER|${expense.number}|${expense.documentHash.slice(0, 12)}`,
      toAddress: expense.payToAddress,
      counterparty: expense.vendor,
      vaultId: expense.vaultId,
      accountFingerprint: expense.sourceAccountFingerprint,
      expenseId: expense.id,
      confirmations: 0,
      timestamp: "2026-08-17T10:00:00.000Z",
      status: "pending",
      pool: "Orchard",
      source: "rpc",
    });
    observed = [{ ...state.transactions.find((tx) => tx.id === oldId)!, id: oldId, canonicalId: undefined }];
    expect((await POST()).status).toBe(200);
    expect(state.transactions.find((tx) => tx.id === "retry-intent")?.status).toBe("pending");
    expect(state.transactions.find((tx) => tx.id === oldId)?.failureReason).toBe("expired-unmined");
  });

  it("fails closed on memo drift for the same canonical output instead of overwriting it", async () => {
    const invoice = state.invoices.find((item) => item.status === "pending")!;
    const outputId = "4".repeat(64);
    const paymentTxid = "5".repeat(64);
    observed = [
      {
        id: outputId,
        txid: paymentTxid,
        direction: "incoming",
        zatoshi: invoice.zatoshi,
        memo: invoice.memoRef,
        toAddress: invoice.receiveAddress,
        counterparty: "payer",
        vaultId: invoice.vaultId,
        accountFingerprint: invoice.receiveAccountFingerprint,
        confirmations: 12,
        blockHeight: 4_200_020,
        timestamp: "2026-08-17T11:00:00.000Z",
        status: "confirmed",
        pool: "Orchard",
        source: "rpc",
      },
    ];
    expect((await POST()).status).toBe(200);
    expect(invoice.status).toBe("paid");
    observed = [{ ...observed[0], memo: "drifted-memo" }];
    const response = await POST();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringMatching(/memo changed/) });
    expect(state.transactions.find((tx) => tx.canonicalId === outputId)?.memo).toBe(invoice.memoRef);
    expect(invoice.status).toBe("paid");
  });

  it("reverses and rewrites settlement when an invoice is re-mined at the same height with a different Istanbul date", async () => {
    const invoice = state.invoices.find((item) => item.status === "pending")!;
    const outputId = "6".repeat(64);
    const paymentTxid = "7".repeat(64);
    observed = [
      {
        id: outputId,
        txid: paymentTxid,
        direction: "incoming",
        zatoshi: invoice.zatoshi,
        memo: invoice.memoRef,
        toAddress: invoice.receiveAddress,
        counterparty: "payer",
        vaultId: invoice.vaultId,
        accountFingerprint: invoice.receiveAccountFingerprint,
        confirmations: 12,
        blockHeight: 4_200_025,
        timestamp: "2026-08-31T20:59:00.000Z",
        status: "confirmed",
        pool: "Orchard",
        source: "rpc",
      },
    ];
    expect((await POST()).status).toBe(200);
    observed = [{ ...observed[0], timestamp: "2026-08-31T21:01:00.000Z" }];
    expect((await POST()).status).toBe(200);
    const payments = state.journals.filter(
      (entry) => entry.sourceType === "payment" && entry.sourceId === invoice.id && entry.chainTxid === paymentTxid,
    );
    expect(payments).toHaveLength(3);
    expect(payments.at(-1)?.date).toBe("2026-09-01");
  });

  it("records a multi-vault internal transfer once in two scoped journals and the source fee", async () => {
    const transferTxid = "2".repeat(64);
    const transferId = "3".repeat(64);
    const sourceAccount = "1".repeat(64);
    const destinationAccount = "2".repeat(64);
    observed = [
      {
        id: transferId,
        txid: transferTxid,
        direction: "internal",
        zatoshi: "2500000",
        feeZatoshi: "10000",
        memo: "ZECHLEDGER|INTERNAL|scope",
        toAddress: DEMO_TESTNET_ADDRESSES.rnd,
        counterparty: "Transfer between purpose vaults",
        vaultId: "vault-export",
        accountFingerprint: sourceAccount,
        sourceAccountFingerprint: sourceAccount,
        destinationAccountFingerprint: destinationAccount,
        sourceVaultId: "vault-export",
        destinationVaultId: "vault-rnd",
        confirmations: 12,
        blockHeight: 4_200_030,
        timestamp: "2026-08-17T12:00:00.000Z",
        status: "confirmed",
        pool: "Orchard",
        source: "rpc",
      },
    ];
    expect((await POST()).status).toBe(200);
    const postings = state.journals.filter(
      (entry) => entry.sourceType === "transfer" && entry.chainTxid === transferTxid,
    );
    expect(postings).toHaveLength(2);
    expect(new Set(postings.map((entry) => entry.vaultId))).toEqual(new Set(["vault-export", "vault-rnd"]));
    expect(
      postings
        .flatMap((entry) => entry.lines)
        .filter((line) => line.accountCode === "102.10")
        .reduce((sum, line) => sum + line.debitTry - line.creditTry, 0),
    ).toBe(0);
    expect(
      state.journals.filter((entry) => entry.sourceType === "fee" && entry.chainTxid === transferTxid),
    ).toHaveLength(1);
    expect((await POST()).status).toBe(200);
    expect(
      state.journals.filter((entry) => entry.sourceType === "transfer" && entry.chainTxid === transferTxid),
    ).toHaveLength(2);

    observed = [{ ...observed[0], status: "failed", confirmations: 0, failureReason: "orphan-missing" }];
    expect((await POST()).status).toBe(200);
    expect(
      state.journals.filter((entry) => entry.sourceType === "transfer" && entry.chainTxid === transferTxid),
    ).toHaveLength(4);
    expect(
      state.journals.filter((entry) => entry.sourceType === "fee" && entry.chainTxid === transferTxid),
    ).toHaveLength(2);
  });

  it("does not advance the orphan counter on repeated syncs of the same wallet tip snapshot", async () => {
    process.env.ZALLET_RPC_URL = "http://mock-zallet";
    const expense = state.expenses[0];
    const outputId = "8".repeat(64);
    const paymentTxid = "1".repeat(64);
    observed = [
      {
        id: outputId,
        txid: paymentTxid,
        direction: "outgoing",
        zatoshi: expense.zatoshi,
        memo: `ZECHLEDGER|${expense.number}|${expense.documentHash.slice(0, 12)}`,
        toAddress: expense.payToAddress,
        counterparty: expense.vendor,
        vaultId: expense.vaultId,
        accountFingerprint: expense.sourceAccountFingerprint,
        expenseId: expense.id,
        confirmations: 12,
        blockHeight: 4_200_040,
        timestamp: "2026-08-17T13:00:00.000Z",
        status: "confirmed",
        pool: "Orchard",
        source: "rpc",
      },
    ];
    Object.defineProperty(observed, "scanToken", { value: "4200040:aaa", configurable: true });
    expect((await POST()).status).toBe(200);
    observed = [];
    Object.defineProperty(observed, "scanToken", { value: "4200041:bbb", configurable: true });
    expect((await POST()).status).toBe(200);
    expect(state.transactions.find((tx) => tx.canonicalId === outputId)?.status).toBe("confirmed");
    observed = [];
    Object.defineProperty(observed, "scanToken", { value: "4200041:bbb", configurable: true });
    expect((await POST()).status).toBe(200);
    expect(state.transactions.find((tx) => tx.canonicalId === outputId)?.status).toBe("confirmed");
    observed = [];
    Object.defineProperty(observed, "scanToken", { value: "4200042:ccc", configurable: true });
    expect((await POST()).status).toBe(200);
    expect(state.transactions.find((tx) => tx.canonicalId === outputId)?.status).toBe("failed");
  });
});
