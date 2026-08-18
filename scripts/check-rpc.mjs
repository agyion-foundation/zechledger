#!/usr/bin/env node
import nextEnv from "@next/env";
import { readFile } from "node:fs/promises";

nextEnv.loadEnvConfig(process.cwd());
const nodeOnly = process.argv.includes("--node-only");
const legacyUrl = process.env.ZCASH_RPC_URL?.trim();
const configuredNodeUrl = process.env.ZEBRA_RPC_URL?.trim() || legacyUrl;
const nodeUrl = configuredNodeUrl || "https://zcash-testnet.gateway.tatum.io";
const walletUrl = process.env.ZALLET_RPC_URL?.trim() || legacyUrl;

async function basicAuth(prefix) {
  const cookiePath = process.env[`${prefix}_COOKIE_PATH`]?.trim();
  if (cookiePath) {
    const cookie = (await readFile(cookiePath, "utf8")).trim();
    if (!cookie.includes(":")) throw new Error(`${prefix}_COOKIE_PATH contents are not in user:password format`);
    return cookie;
  }
  const user = process.env[`${prefix}_RPC_USER`];
  return user ? `${user}:${process.env[`${prefix}_RPC_PASSWORD`] || ""}` : undefined;
}

async function rpc(url, method, params = [], auth) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Basic ${Buffer.from(auth).toString("base64")}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "zechledger-check", method, params }),
    signal: AbortSignal.timeout(Number(process.env.ZCASH_RPC_TIMEOUT_MS ?? 12_000)),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${method}: ${body.error?.message || `HTTP ${response.status}`}`);
  return body.result;
}

try {
  if (process.env.ZCASH_ALLOW_SEND === "true") {
    if (process.env.ZALLET_EXTERNAL_BROADCAST_CONFIRMED !== "true")
      throw new Error("Sending is enabled, but operator confirmation for Zallet [external] broadcast=true is missing.");
    if ((process.env.ZCASH_PRIVACY_POLICY ?? "FullPrivacy") !== "FullPrivacy")
      throw new Error("ZechLedger permits sending only with FullPrivacy.");
  }
  if (!walletUrl && !nodeOnly)
    throw new Error(
      "ZALLET_RPC_URL was not found. Populate .env.local to check the wallet deployment, or use --node-only for an intentional node-only check.",
    );
  const auth = legacyUrl && !process.env.ZEBRA_RPC_URL ? await basicAuth("ZCASH") : await basicAuth("ZEBRA");
  const chain = await rpc(nodeUrl, "getblockchaininfo", [], auth);
  const safe = chain.chain === "test" || chain.chain === "testnet";
  console.log(
    `${safe ? "✓" : "✗"} Zebra: chain=${chain.chain} height=${chain.blocks} headers=${chain.headers} (${configuredNodeUrl ? "configured" : "public read-only"})`,
  );
  if (!safe) process.exit(1);
  if (walletUrl) {
    const walletAuth = legacyUrl && !process.env.ZALLET_RPC_URL ? await basicAuth("ZCASH") : await basicAuth("ZALLET");
    const status = await rpc(walletUrl, "getwalletstatus", [], walletAuth);
    console.log(
      `✓ Zallet: wallet_tip=${status.wallet_tip?.height ?? "not-scanning"} node_tip=${status.node_tip?.height ?? "?"}`,
    );
    let accounts = [];
    if (process.env.ZALLET_ACCOUNT_UUID?.trim()) accounts = [process.env.ZALLET_ACCOUNT_UUID.trim().toLowerCase()];
    else if (process.env.ZALLET_VAULT_ACCOUNT_MAP)
      accounts = Object.keys(JSON.parse(process.env.ZALLET_VAULT_ACCOUNT_MAP)).map((account) => account.toLowerCase());
    if (!accounts.length)
      throw new Error("A scoped wallet check requires ZALLET_ACCOUNT_UUID or an allowlisted account map");
    const accountMap = process.env.ZALLET_VAULT_ACCOUNT_MAP
      ? Object.fromEntries(
          Object.entries(JSON.parse(process.env.ZALLET_VAULT_ACCOUNT_MAP)).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        )
      : null;
    const addressMap = process.env.ZCASH_VAULT_ADDRESS_MAP ? JSON.parse(process.env.ZCASH_VAULT_ADDRESS_MAP) : {};
    let balanceZat = 0n;
    for (const account of accounts) {
      const [balance, detail] = await Promise.all([
        rpc(
          walletUrl,
          "z_getbalanceforaccount",
          [account, Number(process.env.ZCASH_MIN_CONFIRMATIONS ?? 10)],
          walletAuth,
        ),
        rpc(walletUrl, "z_getaccount", [account], walletAuth),
      ]);
      if (String(detail.account_uuid).toLowerCase() !== account)
        throw new Error(`z_getaccount scope mismatch: ${account}`);
      const known = new Set(
        (detail.addresses ?? [])
          .flatMap((item) => [item.ua, item.sapling])
          .filter(Boolean)
          .map((value) => value.toLowerCase()),
      );
      const vault = accountMap?.[account] ?? "vault-export";
      const candidates = [
        addressMap[vault],
        ...(!accountMap || vault === "vault-export"
          ? [process.env.ZCASH_RECEIVER_ADDRESS, process.env.ZCASH_FROM_ADDRESS]
          : []),
      ].filter(Boolean);
      for (const address of candidates)
        if (!known.has(address.toLowerCase()))
          throw new Error(`${vault} address does not belong to the mapped account: ${account}`);
      for (const pool of Object.values(balance.pools ?? {})) balanceZat += BigInt(pool.valueZat ?? 0);
    }
    console.log(`✓ Allowlisted wallet balance: ${balanceZat} zatoshi (${accounts.length} accounts)`);
  } else {
    console.log("○ Intentional --node-only mode: wallet/send/sync were not verified.");
  }
} catch (error) {
  console.error(`✗ RPC check failed: ${error.message}`);
  process.exit(1);
}
