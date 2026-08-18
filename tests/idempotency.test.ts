import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState, DEMO_TESTNET_ADDRESSES } from "@/lib/seed";
import type { AppState } from "@/lib/types";

let state: AppState;
let walletFails = false;
vi.mock("@/lib/zcash-rpc", () => ({
  verifyConfiguredWalletScope: vi.fn(async () => {
    if (walletFails) throw new Error("wallet down");
  }),
  ZcashRpcError: class ZcashRpcError extends Error {
    code?: number;
  },
}));
vi.mock("@/lib/store", () => ({
  getState: vi.fn(async () => state),
  mutateState: vi.fn(async (mutator: (state: AppState) => unknown) => ({ state, result: await mutator(state) })),
}));
import { POST as postInvoice } from "@/app/api/invoices/route";
import { POST as postExpense } from "@/app/api/expenses/route";

beforeEach(() => {
  state = createSeedState();
  walletFails = false;
  delete process.env.ZALLET_RPC_URL;
  delete process.env.ZCASH_RPC_URL;
});
afterEach(() => {
  delete process.env.ZALLET_RPC_URL;
  delete process.env.ZCASH_RPC_URL;
});
const request = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("document create idempotency", () => {
  it("replays the same invoice requestId and payload with one journal; a mismatch returns 409", async () => {
    const body = {
      requestId: "123e4567-e89b-42d3-a456-426614174111",
      client: "Atlas Test",
      title: "Idempotent service",
      issueDate: "2026-08-17",
      dueDate: "2026-09-07",
      amountZec: "0.01000000",
      vatRate: 20,
      vaultId: "vault-export",
    };
    const count = state.journals.length;
    expect((await postInvoice(request("http://localhost/api/invoices", body))).status).toBe(201);
    process.env.ZALLET_RPC_URL = "http://unreachable-wallet";
    walletFails = true;
    expect((await postInvoice(request("http://localhost/api/invoices", body))).status).toBe(200);
    expect(state.journals).toHaveLength(count + 1);
    const mismatch = await postInvoice(request("http://localhost/api/invoices", { ...body, title: "Changed" }));
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      rotateRequestId: true,
      existingRecord: { number: expect.stringMatching(/^ZL-/) },
    });
  });

  it("does not enqueue a second payable/payment during an expense timeout retry", async () => {
    const body = {
      requestId: "123e4567-e89b-42d3-a456-426614174222",
      vendor: "Node Test",
      category: "Infrastructure",
      description: "Idempotent expense",
      date: "2026-08-17",
      amountZec: "0.01000000",
      vatRate: 20,
      vaultId: "vault-export",
      payToAddress: DEMO_TESTNET_ADDRESSES.rnd,
    };
    const count = state.journals.length;
    expect((await postExpense(request("http://localhost/api/expenses", body))).status).toBe(201);
    process.env.ZALLET_RPC_URL = "http://unreachable-wallet";
    walletFails = true;
    expect((await postExpense(request("http://localhost/api/expenses", body))).status).toBe(200);
    expect(state.journals).toHaveLength(count + 1);
    expect(state.expenses.filter((item) => item.requestId === body.requestId)).toHaveLength(1);
  });
});
