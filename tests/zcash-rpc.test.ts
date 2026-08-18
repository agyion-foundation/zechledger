import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  assertFreshWalletSyncScope,
  assertTestnet,
  configuredWalletSyncScope,
  getZcashStatus,
  listReceivedTransactions,
  sendShieldedPayment,
  verifyConfiguredWalletScope,
} from "@/lib/zcash-rpc";

let server: Server;
let url = "";
let chain = "test";
let chainHash = "c".repeat(64);
let walletHash = chainHash;
let mutateTipAfterList = false;
let omitWalletBlockTime = false;
let canonicalBlockTime = 1_700_000_000;
let omitOutputs = false;
let malformedBalance = false;
let firstOutputPool = "ironwood";
let lastSendParams: unknown[] | null = null;
let sendOperationId: unknown = "opid-12345678-1234-1234-1234-123456789abc";
const savedEnv = { ...process.env };

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(raw) as { id: string; method: string; params: unknown[] };
      let result: unknown;
      switch (call.method) {
        case "getblockchaininfo":
          result = { chain, blocks: 100, headers: 100, bestblockhash: chainHash, verificationprogress: 1 };
          break;
        case "getnetworkinfo":
          result = { subversion: "/Zebra:mock/", connections: 8 };
          break;
        case "getwalletstatus":
          result = {
            node_tip: { height: 100, blockhash: walletHash },
            wallet_tip: { height: 100, blockhash: walletHash },
            fully_synced_height: 100,
          };
          break;
        case "z_gettotalbalance":
          result = { private: "1.25", total: "1.25" };
          break;
        case "z_getbalanceforaccount":
          result = malformedBalance
            ? { minimum_confirmations: 5 }
            : { pools: { orchard: { valueZat: 125000000 } }, minimum_confirmations: 5 };
          break;
        case "z_getaccount":
          result = {
            account_uuid: "11111111-1111-4111-8111-111111111111",
            addresses: [
              { sapling: "ztestsapling1knww2nyjc62njkard0jmx7hlsj6twxmxwprn7anvrv4dc2zxanl3nemc0qx2hvplxmd2uau8gyw" },
            ],
          };
          break;
        case "z_listtransactions":
          if (mutateTipAfterList) {
            chainHash = "d".repeat(64);
            walletHash = chainHash;
            mutateTipAfterList = false;
          }
          result = [
            {
              account_uuid: "11111111-1111-4111-8111-111111111111",
              mined_height: 95,
              txid: "a".repeat(64),
              account_balance_delta: 12345678,
              fee_paid: 10000,
              block_time: omitWalletBlockTime ? undefined : 1_700_000_000,
              outputs: omitOutputs
                ? undefined
                : [
                    {
                      pool: firstOutputPool,
                      output_index: 0,
                      to_account: "11111111-1111-4111-8111-111111111111",
                      value: 12345678,
                      is_change: false,
                      memo: "ZECHLEDGER|ZL-2026-0042|abc",
                    },
                    {
                      pool: "ironwood",
                      output_index: 1,
                      to_account: "11111111-1111-4111-8111-111111111111",
                      value: 5000,
                      is_change: true,
                      memo: null,
                    },
                    {
                      pool: "orchard",
                      output_index: 2,
                      from_account: "11111111-1111-4111-8111-111111111111",
                      to_account: "11111111-1111-4111-8111-111111111111",
                      to_address: "self",
                      value: 1000,
                      is_change: true,
                      memo: `ZECHLEDGER|AUDIT|v3|${"b".repeat(64)}`,
                    },
                  ],
            },
          ];
          break;
        case "getblock":
          result = { height: Number(call.params[0]), time: canonicalBlockTime };
          break;
        case "z_sendmany":
          lastSendParams = call.params;
          result = sendOperationId;
          break;
        default:
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
  process.env.ZALLET_ACCOUNT_UUID = "11111111-1111-4111-8111-111111111111";
  process.env.ZCASH_MIN_CONFIRMATIONS = "5";
  process.env.ZCASH_FROM_ADDRESS =
    "ztestsapling1knww2nyjc62njkard0jmx7hlsj6twxmxwprn7anvrv4dc2zxanl3nemc0qx2hvplxmd2uau8gyw";
  delete process.env.ZCASH_RPC_URL;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  process.env = savedEnv;
});

describe("Zebra + Zallet adapter", () => {
  it("validates node and wallet readiness separately", async () => {
    const status = await getZcashStatus(true);
    expect(status.safeTestnet).toBe(true);
    expect(status.nodeSource).toBe("local-zebra");
    expect(status.walletReachable).toBe(true);
    expect(status.balanceZatoshi).toBe("125000000");
    expect(status.walletHeight).toBe(100);
  });

  it("does not report a malformed account balance response as exact zero", async () => {
    malformedBalance = true;
    try {
      const status = await getZcashStatus(true);
      expect(status.walletReachable).toBe(false);
      expect(status.balanceZatoshi).toBeNull();
      expect(status.message).toMatch(/pools object/);
    } finally {
      malformedBalance = false;
    }
  });

  it("does not treat Zallet history missing the outputs field as a complete snapshot", async () => {
    omitOutputs = true;
    try {
      await expect(listReceivedTransactions()).rejects.toThrow(/outputs array/);
    } finally {
      omitOutputs = false;
    }
  });

  it("fails closed on a shielded memo claim for a Transparent output", async () => {
    firstOutputPool = "transparent";
    try {
      await expect(listReceivedTransactions()).rejects.toThrow(/transparent output.*Zcash memo/i);
    } finally {
      firstOutputPool = "ironwood";
    }
  });

  it("binds send readiness to the persisted endpoint/account sync scope", () => {
    expect(() => assertFreshWalletSyncScope(undefined, undefined)).toThrow(/Before the first send/);
    expect(() => assertFreshWalletSyncScope("0".repeat(64), new Date().toISOString())).toThrow(
      /scope does not match the most recent exact sync/,
    );
    expect(() => assertFreshWalletSyncScope(configuredWalletSyncScope(), new Date().toISOString())).not.toThrow();
  });

  it("normalizes integer Zallet outputs, Ironwood memos, and confirmations", async () => {
    process.env.ZALLET_VAULT_ACCOUNT_MAP = JSON.stringify({ "11111111-1111-4111-8111-111111111111": "vault-rnd" });
    process.env.ZCASH_VAULT_ADDRESS_MAP = JSON.stringify({ "vault-rnd": process.env.ZCASH_FROM_ADDRESS });
    let transactions;
    try {
      transactions = await listReceivedTransactions();
    } finally {
      delete process.env.ZALLET_VAULT_ACCOUNT_MAP;
      delete process.env.ZCASH_VAULT_ADDRESS_MAP;
    }
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      txid: "a".repeat(64),
      zatoshi: "12345678",
      memo: "ZECHLEDGER|ZL-2026-0042|abc",
      confirmations: 6,
      status: "confirmed",
      pool: "Ironwood",
      source: "rpc",
      vaultId: "vault-rnd",
    });
    expect(transactions[1]).toMatchObject({
      direction: "anchor",
      zatoshi: "1000",
      feeZatoshi: "10000",
      pool: "Orchard",
    });
  });

  it("uses the canonical block time when a mined wallet row has no timestamp", async () => {
    process.env.ZALLET_VAULT_ACCOUNT_MAP = JSON.stringify({ "11111111-1111-4111-8111-111111111111": "vault-rnd" });
    process.env.ZCASH_VAULT_ADDRESS_MAP = JSON.stringify({ "vault-rnd": process.env.ZCASH_FROM_ADDRESS });
    omitWalletBlockTime = true;
    try {
      const transactions = await listReceivedTransactions();
      expect(transactions[0].timestamp).toBe(new Date(1_700_000_000_000).toISOString());
    } finally {
      omitWalletBlockTime = false;
      delete process.env.ZALLET_VAULT_ACCOUNT_MAP;
      delete process.env.ZCASH_VAULT_ADDRESS_MAP;
    }
  });

  it("rejects the accounting import when wallet and Zebra report different mined block times", async () => {
    process.env.ZALLET_VAULT_ACCOUNT_MAP = JSON.stringify({ "11111111-1111-4111-8111-111111111111": "vault-rnd" });
    process.env.ZCASH_VAULT_ADDRESS_MAP = JSON.stringify({ "vault-rnd": process.env.ZCASH_FROM_ADDRESS });
    canonicalBlockTime = 1_700_000_001;
    try {
      await expect(listReceivedTransactions()).rejects.toThrow(/block times do not match/);
    } finally {
      canonicalBlockTime = 1_700_000_000;
      delete process.env.ZALLET_VAULT_ACCOUNT_MAP;
      delete process.env.ZCASH_VAULT_ADDRESS_MAP;
    }
  });

  it("rejects a Zallet scan when its initial tips have the same height but different hashes", async () => {
    walletHash = "e".repeat(64);
    await expect(listReceivedTransactions()).rejects.toThrow(/scan at a different tip/);
    walletHash = chainHash;
  });

  it("returns no records if the exact tip changes during a Zallet scan", async () => {
    mutateTipAfterList = true;
    await expect(listReceivedTransactions()).rejects.toThrow(/exact Zebra\/wallet tip changed/);
    chainHash = "c".repeat(64);
    walletHash = chainHash;
  });

  it("sends the amount as a decimal string and a null ZIP-317 fee to Zallet", async () => {
    process.env.ZCASH_ALLOW_SEND = "true";
    process.env.ZALLET_EXTERNAL_BROADCAST_CONFIRMED = "true";
    process.env.ZCASH_FROM_ADDRESS =
      "ztestsapling1knww2nyjc62njkard0jmx7hlsj6twxmxwprn7anvrv4dc2zxanl3nemc0qx2hvplxmd2uau8gyw";
    const result = await sendShieldedPayment({
      toAddress: "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez",
      zatoshi: "1",
      memo: "ZECHLEDGER|TEST|one-zatoshi",
    });
    expect(result.operationId).toMatch(/^opid-/);
    expect(lastSendParams?.[1]).toEqual([expect.objectContaining({ amount: "0.00000001" })]);
    expect(lastSendParams?.[3]).toBeNull();
    expect((lastSendParams?.[1] as Array<{ memo: string }>)[0].memo).toBe(
      Buffer.from("ZECHLEDGER|TEST|one-zatoshi").toString("hex"),
    );
  });

  it("rejects a malformed z_sendmany opid as an ambiguous, non-retryable error", async () => {
    process.env.ZCASH_ALLOW_SEND = "true";
    process.env.ZALLET_EXTERNAL_BROADCAST_CONFIRMED = "true";
    sendOperationId = { malformed: true };
    try {
      await expect(
        sendShieldedPayment({
          toAddress: "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez",
          zatoshi: "1",
          memo: "ZECHLEDGER|TEST|malformed-opid",
        }),
      ).rejects.toMatchObject({ method: "z_sendmany", code: undefined });
    } finally {
      sendOperationId = "opid-12345678-1234-1234-1234-123456789abc";
    }
  });

  it("rejects a mainnet response with the hard lock", async () => {
    chain = "main";
    await expect(assertTestnet()).rejects.toThrow(/only to testnet/);
    chain = "test";
  });
  it("fails closed on Zallet disclosure policies other than FullPrivacy", async () => {
    process.env.ZCASH_ALLOW_SEND = "true";
    process.env.ZALLET_EXTERNAL_BROADCAST_CONFIRMED = "true";
    process.env.ZCASH_FROM_ADDRESS =
      "ztestsapling1knww2nyjc62njkard0jmx7hlsj6twxmxwprn7anvrv4dc2zxanl3nemc0qx2hvplxmd2uau8gyw";
    process.env.ZCASH_PRIVACY_POLICY = "AllowRevealedAmounts";
    await expect(
      sendShieldedPayment({
        toAddress: "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez",
        zatoshi: "1",
        memo: "ZECHLEDGER|TEST|privacy",
      }),
    ).rejects.toThrow(/FullPrivacy/);
    delete process.env.ZCASH_PRIVACY_POLICY;
  });

  it("fails closed during preflight when the configured source address does not belong to the mapped account", async () => {
    const original = process.env.ZCASH_FROM_ADDRESS;
    process.env.ZCASH_FROM_ADDRESS =
      "ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez";
    try {
      await expect(verifyConfiguredWalletScope()).rejects.toThrow(/does not belong/);
    } finally {
      process.env.ZCASH_FROM_ADDRESS = original;
    }
  });
});
