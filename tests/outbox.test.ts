import { describe, expect, it } from "vitest";
import { paymentRetryBlocked } from "@/lib/outbox";
import type { ChainTransaction } from "@/lib/types";

const transaction = (overrides: Partial<ChainTransaction> = {}): ChainTransaction => ({
  id: "intent",
  txid: "opid:test",
  direction: "outgoing",
  zatoshi: "1",
  memo: "memo",
  counterparty: "vendor",
  vaultId: "vault-export",
  expenseId: "expense-1",
  confirmations: 0,
  timestamp: "2026-08-17T00:00:00.000Z",
  status: "pending",
  pool: "Orchard",
  source: "rpc",
  ...overrides,
});

describe("payment outbox retry policy", () => {
  it("blocks retries when an asynchronous failure outcome remains unknown after an opid", () => {
    expect(paymentRetryBlocked([transaction({ operationOutcome: "unknown" })], "expense-1")).toBe(true);
  });

  it("does not treat a two-scan orphan state as safe to retry", () => {
    expect(paymentRetryBlocked([transaction({ status: "failed", failureReason: "orphan-missing" })], "expense-1")).toBe(
      true,
    );
  });

  it("treats only wallet expired-unmined outcomes or definite pre-opid RPC rejections as safe", () => {
    expect(
      paymentRetryBlocked([transaction({ status: "failed", failureReason: "expired-unmined" })], "expense-1"),
    ).toBe(false);
    expect(
      paymentRetryBlocked([transaction({ status: "failed", failureReason: "definite-rpc-reject" })], "expense-1"),
    ).toBe(false);
  });
});
