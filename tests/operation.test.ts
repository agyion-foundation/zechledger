import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/lib/seed";
import type { AppState } from "@/lib/types";

let state: AppState;
let records: unknown[] = [];
vi.mock("@/lib/store", () => ({
  mutateState: vi.fn(async (mutator: (state: AppState) => unknown) => ({ state, result: await mutator(state) })),
}));
vi.mock("@/lib/zcash-rpc", () => ({ getOperationStatus: vi.fn(async () => records) }));

import { GET } from "@/app/api/zcash/operation/[id]/route";

const id = "opid-12345678-1234-4234-8234-123456789abc";
const other = "opid-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tx1 = "1".repeat(64);
const tx2 = "2".repeat(64);

beforeEach(() => {
  state = createSeedState();
  state.transactions.unshift({
    id: "intent",
    txid: `opid:${id}`,
    direction: "outgoing",
    zatoshi: "1",
    memo: "memo",
    toAddress: state.expenses[0].payToAddress,
    counterparty: "test",
    vaultId: "vault-export",
    confirmations: 0,
    timestamp: new Date().toISOString(),
    status: "pending",
    pool: "Shielded",
    source: "rpc",
  });
});

describe("exact Zallet operation association", () => {
  it("associates only the exact opid record's multiple-txid result", async () => {
    records = [
      { id: other, status: "success", result: { txid: "f".repeat(64) } },
      { id, status: "success", result: { txids: [tx1, tx2] } },
    ];
    const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ retryBlocked: true, outcomeUnknown: false });
    expect(state.transactions[0]).toMatchObject({
      txid: `opdone:${id}`,
      operationTxids: [tx1, tx2],
      status: "pending",
    });
  });

  it("does not borrow records[0] when the exact opid is absent and returns 409/manual sync", async () => {
    records = [{ id: other, status: "success", result: { txid: tx1 } }];
    const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(409);
    expect(state.transactions[0].txid).toBe(`opid:${id}`);
    expect(state.transactions[0].operationTxids).toBeUndefined();
    expect(state.transactions[0].operationOutcome).toBe("unknown");
  });

  it("persists a non-array operation RPC response as unknown and terminal", async () => {
    records = null as unknown as unknown[];
    const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(409);
    expect(state.transactions[0].operationOutcome).toBe("unknown");
  });

  it("treats a success result with a missing or partially malformed txid set as unknown/terminal", async () => {
    records = [{ id, status: "success", result: { txids: [tx1, "malformed"] } }];
    const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ retryBlocked: true, outcomeUnknown: true });
    expect(state.transactions[0]).toMatchObject({ txid: `opid:${id}`, operationOutcome: "unknown" });
    expect(state.transactions[0].operationTxids).toEqual([]);
  });

  it("does not treat an async failure after an opid as a definite rejection; the intent remains pending and retry-blocked", async () => {
    records = [{ id, status: "failed", error: { message: "second broadcast transport failed" } }];
    const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ retryBlocked: true, operation: { status: "failed" } });
    expect(state.transactions[0]).toMatchObject({ status: "pending", txid: `opid:${id}`, operationOutcome: "unknown" });
    expect(state.transactions[0].failureReason).toBeUndefined();
  });
});
