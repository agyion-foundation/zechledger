import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountFingerprint } from "@/lib/vault-config";
import { DEMO_TESTNET_ADDRESSES } from "@/lib/seed";
import { listReceivedTransactions } from "@/lib/zcash-rpc";

const accountA = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const accountB = "11111111-2222-4333-8444-555555555555";
const txid = "9".repeat(64);
const saved = { ...process.env };
let server: Server;
let url = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(raw) as { id: string; method: string; params: unknown[] };
      let result: unknown;
      if (call.method === "getblockchaininfo")
        result = {
          chain: "test",
          blocks: 200,
          headers: 200,
          bestblockhash: "2".repeat(64),
          verificationprogress: 1,
        };
      else if (call.method === "getwalletstatus")
        result = {
          node_tip: { height: 200, blockhash: "2".repeat(64) },
          wallet_tip: { height: 200, blockhash: "2".repeat(64) },
          fully_synced_height: 200,
        };
      else if (call.method === "z_getaccount") {
        const account = String(call.params[0]);
        result = {
          account_uuid: account,
          addresses: [{ sapling: account === accountA ? DEMO_TESTNET_ADDRESSES.export : DEMO_TESTNET_ADDRESSES.rnd }],
        };
      } else if (call.method === "getblock") {
        result = { height: Number(call.params[0]), time: 1_700_000_000 };
      } else if (call.method === "z_listtransactions") {
        const account = String(call.params[0]);
        result = [
          {
            account_uuid: account,
            mined_height: 195,
            txid,
            fee_paid: 10_000,
            block_time: 1_700_000_000,
            outputs: [
              {
                pool: "ORCHARD",
                output_index: 7,
                from_account: accountA,
                to_account: accountB,
                valueZat: 2_500_000,
                walletInternal: true,
                memo: "ZECHLEDGER|INTERNAL|scope",
              },
            ],
          },
        ];
      } else {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "not found" } }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result, error: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock listen failed");
  url = `http://127.0.0.1:${address.port}`;
  process.env.ZEBRA_RPC_URL = url;
  process.env.ZALLET_RPC_URL = url;
  process.env.ZALLET_VAULT_ACCOUNT_MAP = JSON.stringify({ [accountA]: "vault-export", [accountB]: "vault-rnd" });
  process.env.ZCASH_VAULT_ADDRESS_MAP = JSON.stringify({
    "vault-export": DEMO_TESTNET_ADDRESSES.export,
    "vault-rnd": DEMO_TESTNET_ADDRESSES.rnd,
  });
  process.env.ZCASH_MIN_CONFIRMATIONS = "5";
  delete process.env.ZALLET_ACCOUNT_UUID;
  delete process.env.ZCASH_RPC_URL;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  process.env = saved;
});

describe("multi-account internal transfer normalization", () => {
  it("emits the same output from two account pages as one source-scoped event and source fee", async () => {
    const transactions = await listReceivedTransactions();
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      txid,
      direction: "internal",
      zatoshi: "2500000",
      feeZatoshi: "10000",
      pool: "Orchard",
      vaultId: "vault-export",
      sourceVaultId: "vault-export",
      destinationVaultId: "vault-rnd",
      accountFingerprint: accountFingerprint(accountA),
      sourceAccountFingerprint: accountFingerprint(accountA),
      destinationAccountFingerprint: accountFingerprint(accountB),
    });
    expect(transactions.scanToken).toBe(`200:${"2".repeat(64)}`);
  });
});
