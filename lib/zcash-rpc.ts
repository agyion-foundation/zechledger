import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MAX_MONEY_ZATOSHI, maskAddress, parseZec, zatoshiToZec } from "@/lib/money";
import {
  canonicalShieldedTestnetAddress,
  canonicalizeObservedAddress,
  isShieldedTestnetAddress,
} from "@/lib/zcash-address";
import { minimumConfirmations, rpcTimeoutMs, syncMaxRows } from "@/lib/config";
import {
  accountFingerprint,
  canonicalAccountUuid,
  configuredVaultAccountMap,
  configuredWalletAccounts,
} from "@/lib/vault-config";
import type { ChainTransaction, ZcashStatus } from "@/lib/types";

const PUBLIC_TESTNET_RPC = "https://zcash-testnet.gateway.tatum.io";

interface RpcResponse<T> {
  result: T;
  error: { code: number; message: string } | null;
  id: string | number;
}
interface Endpoint {
  url: string;
  username?: string;
  password?: string;
  cookiePath?: string;
  label: string;
}
interface BlockchainInfo {
  chain?: string;
  blocks?: number;
  headers?: number;
  verificationprogress?: number;
  bestblockhash?: string;
}
interface BlockInfo {
  height?: number;
  time?: number;
}
interface NetworkInfo {
  version?: number;
  subversion?: string;
  connections?: number;
}
interface BalanceInfo {
  transparent?: string | number;
  private?: string | number;
  total?: string | number;
}
interface AccountBalanceInfo {
  pools?: Record<string, { valueZat?: number | string }>;
}
interface ZalletAccountInfo {
  account_uuid?: string;
  addresses?: Array<{ ua?: string; sapling?: string; transparent?: string }>;
}
interface WalletStatusInfo {
  node_tip?: { height?: number; blockhash?: string };
  wallet_tip?: { height?: number; blockhash?: string };
  fully_synced_height?: number;
  sync_work_remaining?: { unscanned_blocks?: number; progress?: { numerator?: number; denominator?: number } };
}
interface ZalletOutput {
  pool?: string;
  output_index?: number;
  from_account?: string | null;
  to_account?: string | null;
  to_address?: string | null;
  value?: number | string;
  valueZat?: number | string;
  is_change?: boolean;
  walletInternal?: boolean;
  memo?: string | null;
  memoStr?: string | null;
}
interface ZalletTransaction {
  account_uuid?: string;
  mined_height?: number | null;
  txid?: string;
  account_balance_delta?: number;
  fee_paid?: number;
  block_time?: number | null;
  block_datetime?: string | null;
  expired_unmined?: boolean;
  outputs?: ZalletOutput[];
}

export class ZcashRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly method?: string,
  ) {
    super(message);
    this.name = "ZcashRpcError";
  }
}

function isLegacyConfiguration(): boolean {
  return Boolean(process.env.ZCASH_RPC_URL && !process.env.ZALLET_RPC_URL && !process.env.ZEBRA_RPC_URL);
}
function nodeEndpoint(): Endpoint {
  if (process.env.ZEBRA_RPC_URL)
    return {
      url: process.env.ZEBRA_RPC_URL.trim(),
      username: process.env.ZEBRA_RPC_USER,
      password: process.env.ZEBRA_RPC_PASSWORD,
      cookiePath: process.env.ZEBRA_COOKIE_PATH,
      label: "Zebra",
    };
  if (isLegacyConfiguration())
    return {
      url: process.env.ZCASH_RPC_URL!.trim(),
      username: process.env.ZCASH_RPC_USER,
      password: process.env.ZCASH_RPC_PASSWORD,
      label: "Legacy wallet/node",
    };
  return { url: PUBLIC_TESTNET_RPC, label: "Public testnet read-only" };
}
function walletEndpoint(): Endpoint | null {
  const url = process.env.ZALLET_RPC_URL?.trim() || (isLegacyConfiguration() ? process.env.ZCASH_RPC_URL!.trim() : "");
  if (!url) return null;
  return {
    url,
    username: process.env.ZALLET_RPC_USER || process.env.ZCASH_RPC_USER,
    password: process.env.ZALLET_RPC_PASSWORD || process.env.ZCASH_RPC_PASSWORD,
    cookiePath: process.env.ZALLET_COOKIE_PATH,
    label: isLegacyConfiguration() ? "Legacy wallet" : "Zallet",
  };
}
export function rpcConfigured(): boolean {
  return walletEndpoint() !== null;
}

async function authorization(endpoint: Endpoint): Promise<string | undefined> {
  let credentials: string | undefined;
  if (endpoint.cookiePath) {
    try {
      credentials = (await readFile(endpoint.cookiePath, "utf8")).trim();
    } catch (error) {
      throw new ZcashRpcError(`${endpoint.label} RPC cookie could not be read: ${(error as Error).message}`);
    }
  } else if (endpoint.username && endpoint.password !== undefined) {
    credentials = `${endpoint.username}:${endpoint.password}`;
  }
  return credentials ? `Basic ${Buffer.from(credentials).toString("base64")}` : undefined;
}

async function callEndpoint<T>(endpoint: Endpoint, method: string, params: unknown[] = []): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = rpcTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const auth = await authorization(endpoint);
    const response = await fetch(endpoint.url, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: "zechledger", method, params }),
    });
    if (!response.ok)
      throw new ZcashRpcError(`${endpoint.label} RPC HTTP ${response.status}.`, response.status, method);
    const body = (await response.json()) as RpcResponse<T>;
    if (body.error) throw new ZcashRpcError(body.error.message, body.error.code, method);
    return body.result;
  } catch (error) {
    if (error instanceof ZcashRpcError) throw error;
    if ((error as Error).name === "AbortError")
      throw new ZcashRpcError(`${endpoint.label} RPC timed out (${timeoutMs} ms).`, undefined, method);
    throw new ZcashRpcError(
      `${endpoint.label} connection could not be established: ${(error as Error).message}`,
      undefined,
      method,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function callNodeRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  return callEndpoint<T>(nodeEndpoint(), method, params);
}
export async function callWalletRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const endpoint = walletEndpoint();
  if (!endpoint) throw new ZcashRpcError("The Zallet wallet RPC is not connected. Set ZALLET_RPC_URL.");
  return callEndpoint<T>(endpoint, method, params);
}
export const callRpc = callWalletRpc;

export async function assertTestnet(): Promise<BlockchainInfo> {
  const info = await callNodeRpc<BlockchainInfo>("getblockchaininfo");
  const chain = String(info.chain ?? "").toLowerCase();
  if (chain !== "test" && chain !== "testnet")
    throw new ZcashRpcError(
      `SAFETY LOCK: ZechLedger sends transactions only to testnet (node network: ${chain || "unknown"}).`,
      -32099,
      "getblockchaininfo",
    );
  return info;
}

function decimalString(value: string | number | undefined): string {
  if (value === undefined) return "0";
  if (typeof value === "number") return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0";
  return value;
}
function boundedRpcZatoshi(value: string | number, label: string): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new ZcashRpcError(`${label} is not a safe integer zatoshi amount.`);
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new ZcashRpcError(`${label} is not a canonical integer zatoshi amount.`);
  const amount = BigInt(text);
  if (amount > MAX_MONEY_ZATOSHI) throw new ZcashRpcError(`${label} exceeds the Zcash MAX_MONEY limit.`);
  return amount;
}

function syncProgress(wallet: WalletStatusInfo): number | null {
  const progress = wallet.sync_work_remaining?.progress;
  if (progress?.denominator) return progress.numerator! / progress.denominator;
  const node = wallet.node_tip?.height;
  const scanned = wallet.fully_synced_height ?? wallet.wallet_tip?.height;
  return node && scanned !== undefined ? Math.min(1, scanned / node) : null;
}

function walletExactlySynchronized(chain: BlockchainInfo, wallet: WalletStatusInfo | null): boolean {
  if (!wallet || chain.blocks === undefined || !chain.bestblockhash) return false;
  return (
    wallet.node_tip?.height === chain.blocks &&
    wallet.wallet_tip?.height === chain.blocks &&
    wallet.fully_synced_height === chain.blocks &&
    wallet.node_tip?.blockhash === chain.bestblockhash &&
    wallet.wallet_tip?.blockhash === chain.bestblockhash
  );
}

function rpcTimestamp(datetime?: string | null, seconds?: number | null): string | null {
  if (datetime) {
    const parsed = Date.parse(datetime);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (Number.isSafeInteger(seconds) && seconds! > 0) return new Date(seconds! * 1000).toISOString();
  return null;
}

async function canonicalBlockTimestamp(height: number): Promise<string> {
  if (!Number.isSafeInteger(height) || height < 0) throw new ZcashRpcError("Invalid mined height.");
  const block = await callNodeRpc<BlockInfo>("getblock", [String(height), 1]);
  if (
    (block.height !== undefined && block.height !== height) ||
    !Number.isSafeInteger(block.time) ||
    block.time! <= 0
  ) {
    throw new ZcashRpcError(`Zebra block ${height} did not return a canonical timestamp.`, undefined, "getblock");
  }
  return new Date(block.time! * 1000).toISOString();
}

let statusCache: { until: number; value: ZcashStatus } | null = null;

export function configuredWalletSyncScope(): string {
  const rawAccountMap = configuredVaultAccountMap();
  const normalizedAccountMap = rawAccountMap
    ? Object.fromEntries(Object.entries(rawAccountMap).sort(([a], [b]) => a.localeCompare(b)))
    : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        wallet: (process.env.ZALLET_RPC_URL ?? process.env.ZCASH_RPC_URL ?? "").replace(/\/$/, ""),
        account: process.env.ZALLET_ACCOUNT_UUID ? canonicalAccountUuid(process.env.ZALLET_ACCOUNT_UUID) : null,
        accountMap: normalizedAccountMap,
      }),
    )
    .digest("hex");
}

export function assertFreshWalletSyncScope(lastSyncScope?: string, lastSyncAt?: string): void {
  if (!lastSyncScope || !lastSyncAt) {
    throw new ZcashRpcError(
      "Before the first send, an exact sync of the current endpoint/account scope is required, including an empty wallet history.",
    );
  }
  if (lastSyncScope !== configuredWalletSyncScope()) {
    throw new ZcashRpcError(
      "The wallet/account endpoint scope does not match the most recent exact sync, so nothing was broadcast. Use a new ZECHLEDGER_DATA_DIR or restore the correct previous scope.",
    );
  }
  const observedAt = Date.parse(lastSyncAt);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > 15 * 60 * 1000) {
    throw new ZcashRpcError(
      "An exact sync of the current wallet scope within the last 15 minutes is required before sending.",
    );
  }
}

export async function verifyConfiguredWalletScope(): Promise<string> {
  if (isLegacyConfiguration()) return "legacy-unverified-address-scope";
  const accounts = configuredWalletAccounts();
  if (!accounts.length) throw new ZcashRpcError("Wallet-scope verification requires a canonical account allowlist.");
  let addressMap: Record<string, string> = {};
  if (process.env.ZCASH_VAULT_ADDRESS_MAP) {
    try {
      addressMap = JSON.parse(process.env.ZCASH_VAULT_ADDRESS_MAP) as Record<string, string>;
    } catch {
      throw new ZcashRpcError("ZCASH_VAULT_ADDRESS_MAP is not valid JSON for the wallet-ownership check.");
    }
  }
  const accountMap = configuredVaultAccountMap();
  const verified: Array<{ account: string; vault: string; address: string | null }> = [];
  for (const account of accounts) {
    const detail = await callWalletRpc<ZalletAccountInfo>("z_getaccount", [account]);
    if (!detail.account_uuid || canonicalAccountUuid(detail.account_uuid) !== account) {
      throw new ZcashRpcError(`Zallet z_getaccount returned the wrong account: ${account}.`);
    }
    const known = new Set(
      (detail.addresses ?? []).flatMap((item) =>
        [item.ua, item.sapling]
          .filter((value): value is string => Boolean(value))
          .map((value) => canonicalShieldedTestnetAddress(value)),
      ),
    );
    const vault = accountMap?.[account] ?? "vault-export";
    const candidates = [
      addressMap[vault],
      ...(!accountMap || accountMap[account] === "vault-export"
        ? [process.env.ZCASH_RECEIVER_ADDRESS, process.env.ZCASH_FROM_ADDRESS]
        : []),
    ].filter((value): value is string => Boolean(value?.trim()));
    const canonicalCandidates = [...new Set(candidates.map((value) => canonicalShieldedTestnetAddress(value)))];
    if (!canonicalCandidates.length)
      throw new ZcashRpcError(
        `${vault} does not have a shielded address configured for account-ownership verification.`,
      );
    for (const address of canonicalCandidates) {
      if (!known.has(address))
        throw new ZcashRpcError(
          `${vault} has a configured address that does not belong to the mapped Zallet account (${accountFingerprint(account).slice(0, 12)}…).`,
        );
    }
    verified.push({ account, vault, address: canonicalCandidates[0] ?? null });
  }
  return createHash("sha256")
    .update(JSON.stringify(verified.sort((a, b) => a.account.localeCompare(b.account))))
    .digest("hex");
}

export async function getZcashStatus(force = false): Promise<ZcashStatus> {
  if (!force && statusCache && statusCache.until > Date.now()) return statusCache.value;
  const checked = new Date().toISOString();
  const wallet = walletEndpoint();
  const endpoint = nodeEndpoint();
  const source: ZcashStatus["nodeSource"] =
    endpoint.url === PUBLIC_TESTNET_RPC ? "public-readonly" : isLegacyConfiguration() ? "legacy" : "local-zebra";
  const started = Date.now();
  try {
    const chain = await callNodeRpc<BlockchainInfo>("getblockchaininfo");
    const chainName = String(chain.chain ?? "unknown");
    const safe = ["test", "testnet"].includes(chainName.toLowerCase());
    let network: NetworkInfo = {};
    if (source !== "public-readonly") network = await callNodeRpc<NetworkInfo>("getnetworkinfo").catch(() => ({}));
    let walletStatus: WalletStatusInfo | null = null;
    let scopedBalanceZatoshi: bigint | null = null;
    let walletError: Error | null = null;
    if (wallet) {
      try {
        if (isLegacyConfiguration()) {
          const balance = await callWalletRpc<BalanceInfo>("z_gettotalbalance", [0, true]);
          const value = balance.total ?? balance.private ?? balance.transparent;
          scopedBalanceZatoshi = value === undefined ? null : parseZec(decimalString(value));
          walletStatus = {};
        } else {
          const accounts = configuredWalletAccounts();
          if (!accounts.length)
            throw new ZcashRpcError("A scoped balance requires ZALLET_ACCOUNT_UUID or an allowlisted account map.");
          const [status, balances] = await Promise.all([
            callWalletRpc<WalletStatusInfo>("getwalletstatus"),
            Promise.all(
              accounts.map((account) =>
                callWalletRpc<AccountBalanceInfo>("z_getbalanceforaccount", [account, minimumConfirmations()]),
              ),
            ),
          ]);
          walletStatus = status;
          let validatedBalanceZatoshi = 0n;
          for (const accountBalance of balances) {
            if (
              !accountBalance ||
              typeof accountBalance !== "object" ||
              !accountBalance.pools ||
              typeof accountBalance.pools !== "object" ||
              Array.isArray(accountBalance.pools) ||
              Object.keys(accountBalance.pools).length === 0
            ) {
              throw new ZcashRpcError("The Zallet account balance does not contain a verifiable pools object.");
            }
            for (const [poolName, pool] of Object.entries(accountBalance.pools)) {
              if (!pool || typeof pool !== "object" || pool.valueZat === undefined) {
                throw new ZcashRpcError(`Zallet ${poolName} balance record does not contain an exact valueZat.`);
              }
              validatedBalanceZatoshi += boundedRpcZatoshi(pool.valueZat, `Zallet ${poolName} account balance`);
            }
          }
          scopedBalanceZatoshi = validatedBalanceZatoshi;
          if (scopedBalanceZatoshi > MAX_MONEY_ZATOSHI)
            throw new ZcashRpcError("The total allowlisted wallet balance exceeds the MAX_MONEY limit.");
          await verifyConfiguredWalletScope();
        }
      } catch (error) {
        walletError = error as Error;
      }
    }
    const walletReachable = Boolean(wallet && !walletError);
    const walletSynchronized = Boolean(
      walletReachable && source !== "legacy" && walletExactlySynchronized(chain, walletStatus),
    );
    const sendEnabled = process.env.ZCASH_ALLOW_SEND === "true";
    const externalBroadcastConfirmed = process.env.ZALLET_EXTERNAL_BROADCAST_CONFIRMED === "true";
    const fullPrivacyEnabled = (process.env.ZCASH_PRIVACY_POLICY ?? "FullPrivacy") === "FullPrivacy";
    const result: ZcashStatus = {
      configured: Boolean(wallet),
      reachable: true,
      safeTestnet: safe,
      nodeSource: source,
      walletConfigured: Boolean(wallet),
      walletReachable,
      walletSynchronized,
      sendEnabled,
      externalBroadcastConfirmed,
      fullPrivacyEnabled,
      sendReady: safe && walletSynchronized && sendEnabled && externalBroadcastConfirmed && fullPrivacyEnabled,
      walletHeight: walletStatus?.wallet_tip?.height ?? walletStatus?.fully_synced_height ?? null,
      walletSyncProgress: walletStatus ? syncProgress(walletStatus) : null,
      chain: chainName,
      blocks: chain.blocks ?? null,
      headers: chain.headers ?? null,
      verificationProgress: chain.verificationprogress ?? null,
      connections: network.connections ?? null,
      balanceZatoshi: scopedBalanceZatoshi?.toString() ?? null,
      receiverAddress: process.env.ZCASH_RECEIVER_ADDRESS ?? null,
      receiverMasked: maskAddress(process.env.ZCASH_RECEIVER_ADDRESS),
      latencyMs: Date.now() - started,
      nodeVersion:
        network.subversion ??
        (network.version ? String(network.version) : source === "public-readonly" ? "Zebra · public gateway" : null),
      lastCheckedAt: checked,
      message: !safe
        ? `Mainnet lock active · Unexpected network: ${chainName}`
        : walletError
          ? `Testnet is live; Zallet is unreachable: ${walletError.message}`
          : walletReachable
            ? "Testnet node and wallet RPC connections verified"
            : "Zcash Testnet is live · Zallet wallet is not connected yet",
    };
    statusCache = { until: Date.now() + 15_000, value: result };
    return result;
  } catch (error) {
    const result: ZcashStatus = {
      configured: Boolean(wallet),
      reachable: false,
      safeTestnet: false,
      nodeSource: "unavailable",
      walletConfigured: Boolean(wallet),
      walletReachable: false,
      walletSynchronized: false,
      sendEnabled: process.env.ZCASH_ALLOW_SEND === "true",
      externalBroadcastConfirmed: process.env.ZALLET_EXTERNAL_BROADCAST_CONFIRMED === "true",
      fullPrivacyEnabled: (process.env.ZCASH_PRIVACY_POLICY ?? "FullPrivacy") === "FullPrivacy",
      sendReady: false,
      walletHeight: null,
      walletSyncProgress: null,
      chain: null,
      blocks: null,
      headers: null,
      verificationProgress: null,
      connections: null,
      balanceZatoshi: null,
      receiverAddress: process.env.ZCASH_RECEIVER_ADDRESS ?? null,
      receiverMasked: maskAddress(process.env.ZCASH_RECEIVER_ADDRESS),
      latencyMs: Date.now() - started,
      nodeVersion: null,
      lastCheckedAt: checked,
      message: (error as Error).message,
    };
    statusCache = { until: Date.now() + 5_000, value: result };
    return result;
  }
}

function poolName(pool?: string): ChainTransaction["pool"] {
  switch ((pool ?? "").trim().toLowerCase()) {
    case "ironwood":
      return "Ironwood";
    case "orchard":
      return "Orchard";
    case "sapling":
      return "Sapling";
    case "transparent":
      return "Transparent";
    default:
      return "Shielded";
  }
}

function observedPoolName(pool: string | undefined, txid: string): Exclude<ChainTransaction["pool"], "Shielded"> {
  const normalized = poolName(pool);
  if (normalized === "Shielded") {
    throw new ZcashRpcError(`The wallet did not provide a recognized pool for the canonical record (${txid}).`);
  }
  return normalized;
}

function vaultForAccount(accountUuid?: string | null): string {
  if (!accountUuid) return "vault-unmapped";
  const canonicalAccount = canonicalAccountUuid(accountUuid);
  const map = configuredVaultAccountMap();
  if (map) {
    const vaultId = map[canonicalAccount];
    return ["vault-export", "vault-operations", "vault-rnd"].includes(vaultId)
      ? vaultId
      : `vault-unmapped:${canonicalAccount}`;
  }
  const selected = process.env.ZALLET_ACCOUNT_UUID ? canonicalAccountUuid(process.env.ZALLET_ACCOUNT_UUID) : undefined;
  return selected === canonicalAccount ? "vault-export" : `vault-unmapped:${canonicalAccount}`;
}

export type ScannedTransactions = ChainTransaction[] & { scanToken?: string };

async function listZalletTransactions(chain: BlockchainInfo): Promise<ScannedTransactions> {
  const walletStatus = await callWalletRpc<WalletStatusInfo>("getwalletstatus");
  if (!walletExactlySynchronized(chain, walletStatus)) {
    throw new ZcashRpcError(
      `Reconciliation or orphan status cannot be inferred from an incomplete wallet scan or a scan at a different tip (${walletStatus.wallet_tip?.height ?? "?"}/${chain.blocks ?? "?"}).`,
      undefined,
      "getwalletstatus",
    );
  }
  const accounts = configuredWalletAccounts();
  if (!accounts.length)
    throw new ZcashRpcError(
      "Zallet scans do not use a broad null scope; ZALLET_ACCOUNT_UUID or an allowlisted ZALLET_VAULT_ACCOUNT_MAP is required.",
    );
  const allowedAccounts = new Set(accounts);
  const pageSize = 250;
  const maxRows = syncMaxRows();
  const rows: ZalletTransaction[] = [];
  for (const account of accounts) {
    let offset = 0;
    let exhausted = false;
    while (rows.length < maxRows) {
      const limit = Math.min(pageSize, maxRows - rows.length);
      const page = await callWalletRpc<ZalletTransaction[]>("z_listtransactions", [account, null, null, offset, limit]);
      rows.push(...page);
      offset += page.length;
      if (page.length < limit) {
        exhausted = true;
        break;
      }
    }
    if (!exhausted) {
      const probe = await callWalletRpc<ZalletTransaction[]>("z_listtransactions", [account, null, null, offset, 1]);
      if (probe.length || account !== accounts.at(-1)) {
        throw new ZcashRpcError(
          `The allowlisted Zallet history exceeds the ${maxRows}-row safety limit; processing stopped fail-closed instead of performing an incomplete sync. Increase ZALLET_SYNC_MAX_ROWS.`,
        );
      }
    }
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || !/^[0-9a-f]{64}$/i.test(row.txid ?? "")) {
      throw new ZcashRpcError("The Zallet history row does not contain a canonical 64-character hexadecimal txid.");
    }
    if (!row.account_uuid || !allowedAccounts.has(canonicalAccountUuid(row.account_uuid))) {
      throw new ZcashRpcError(
        `The account-scoped Zallet query returned a row outside the allowlist (${row.account_uuid ?? "missing account"}).`,
      );
    }
    if (!Array.isArray(row.outputs) || row.outputs.length === 0) {
      throw new ZcashRpcError(`The Zallet history row does not contain a verifiable outputs array (${row.txid}).`);
    }
    for (const output of row.outputs) {
      if (!output || typeof output !== "object") {
        throw new ZcashRpcError(`Malformed Zallet output object (${row.txid}).`);
      }
      const fromAccount = output.from_account;
      const toAccount = output.to_account;
      if (
        (fromAccount !== undefined && fromAccount !== null && typeof fromAccount !== "string") ||
        (toAccount !== undefined && toAccount !== null && typeof toAccount !== "string") ||
        (!fromAccount && !toAccount)
      ) {
        throw new ZcashRpcError(`The Zallet output does not contain wallet-account provenance (${row.txid}).`);
      }
      if (output.valueZat === undefined && output.value === undefined) {
        throw new ZcashRpcError(`The Zallet output does not contain an exact value (${row.txid}).`);
      }
      if (!Number.isSafeInteger(output.output_index) || output.output_index! < 0) {
        throw new ZcashRpcError(
          `The Zallet output does not contain a stable output_index (${row.txid}); array order is not a canonical chain identity.`,
        );
      }
      observedPoolName(output.pool, row.txid!);
      if (
        (output.memo !== undefined && output.memo !== null && typeof output.memo !== "string") ||
        (output.memoStr !== undefined && output.memoStr !== null && typeof output.memoStr !== "string")
      ) {
        throw new ZcashRpcError(`The Zallet output memo field is malformed (${row.txid}).`);
      }
    }
  }
  const observedAt = new Date().toISOString();
  const blockTimestamps = new Map<number, string>();
  const minedHeights = [
    ...new Set(
      rows.map((row) => row.mined_height).filter((height): height is number => height !== undefined && height !== null),
    ),
  ];
  for (let index = 0; index < minedHeights.length; index += 12) {
    const heights = minedHeights.slice(index, index + 12);
    const timestamps = await Promise.all(heights.map((height) => canonicalBlockTimestamp(height)));
    heights.forEach((height, offset) => blockTimestamps.set(height, timestamps[offset]));
  }
  const rowTimestamps = new Map<ZalletTransaction, string>();
  for (const row of rows) {
    const declared = rpcTimestamp(row.block_datetime, row.block_time);
    if (row.mined_height !== undefined && row.mined_height !== null) {
      const timestamp = blockTimestamps.get(row.mined_height)!;
      if (declared && Math.floor(Date.parse(declared) / 1000) !== Math.floor(Date.parse(timestamp) / 1000)) {
        throw new ZcashRpcError(`The wallet and Zebra block times do not match (${row.txid} @ ${row.mined_height}).`);
      }
      rowTimestamps.set(row, timestamp);
    } else {
      rowTimestamps.set(row, declared ?? observedAt);
    }
  }
  const [endingChain, endingWalletStatus] = await Promise.all([
    assertTestnet(),
    callWalletRpc<WalletStatusInfo>("getwalletstatus"),
  ]);
  if (
    !walletExactlySynchronized(endingChain, endingWalletStatus) ||
    endingChain.blocks !== chain.blocks ||
    endingChain.bestblockhash !== chain.bestblockhash
  ) {
    throw new ZcashRpcError(
      "The exact Zebra/wallet tip changed during the Zallet scan; retry the sync before applying records or absence counters.",
    );
  }
  const endTip = endingWalletStatus.node_tip!;
  const tip = endingChain.blocks!;
  const scanToken = `${endTip.height}:${endTip.blockhash}`;
  const minimum = minimumConfirmations();
  const results: ChainTransaction[] = [];
  const seen = new Set<string>();
  const feeAssignedTxids = new Set<string>();
  for (const row of rows) {
    if (!row.txid || !/^[0-9a-f]{64}$/i.test(row.txid))
      throw new ZcashRpcError("The Zallet history row does not contain a canonical 64-character hexadecimal txid.");
    if (!row.account_uuid || !allowedAccounts.has(canonicalAccountUuid(row.account_uuid))) {
      throw new ZcashRpcError(
        `The account-scoped Zallet query returned a row outside the allowlist (${row.account_uuid ?? "missing account"}).`,
      );
    }
    for (const output of row.outputs ?? []) {
      const memo = output.memo ?? output.memoStr ?? "";
      const fromAccount = output.from_account ? canonicalAccountUuid(output.from_account) : null;
      const toAccount = output.to_account ? canonicalAccountUuid(output.to_account) : null;
      if ((fromAccount && !allowedAccounts.has(fromAccount)) || (toAccount && !allowedAccounts.has(toAccount))) {
        throw new ZcashRpcError(
          `The Zallet output contains wallet-account provenance outside the allowlist (${row.txid}).`,
        );
      }
      const auditMemo = /^ZECHLEDGER\|AUDIT\|v(?:2|3)\|[0-9a-f]{64}$/.test(memo);
      const isAuditSelfTransfer = Boolean(auditMemo && fromAccount && toAccount && fromAccount === toAccount);
      const crossAccount = Boolean(fromAccount && toAccount && fromAccount !== toAccount);
      if ((output.is_change || output.walletInternal) && !isAuditSelfTransfer && !crossAccount) continue;
      const received = Boolean(toAccount);
      const sent = Boolean(fromAccount);
      if (!received && !sent) continue;
      const direction: ChainTransaction["direction"] = isAuditSelfTransfer
        ? "anchor"
        : received && sent
          ? "internal"
          : received
            ? "incoming"
            : "outgoing";
      const canonicalAccount = direction === "outgoing" || direction === "internal" ? fromAccount : toAccount;
      if (row.account_uuid && canonicalAccount && canonicalAccountUuid(row.account_uuid) !== canonicalAccount) continue;
      const value = output.valueZat ?? output.value;
      if (value === undefined) continue;
      const valueZatoshi = boundedRpcZatoshi(value, "Zallet output value");
      if (valueZatoshi <= 0n) continue;
      if (!Number.isSafeInteger(output.output_index) || output.output_index! < 0) {
        throw new ZcashRpcError(
          `The Zallet output does not contain a stable output_index (${row.txid}); array order is not a canonical chain identity.`,
        );
      }
      const normalizedPool = observedPoolName(output.pool, row.txid);
      if (normalizedPool === "Transparent" && memo) {
        throw new ZcashRpcError(`A transparent output cannot carry Zcash memo semantics (${row.txid}).`);
      }
      const identity = `testnet:${row.txid}:${normalizedPool.toLowerCase()}:${output.output_index}:${fromAccount ?? ""}:${toAccount ?? ""}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const confirmations = row.mined_height ? Math.max(0, tip - row.mined_height + 1) : 0;
      const fee =
        sent && !feeAssignedTxids.has(row.txid) && row.fee_paid !== undefined
          ? boundedRpcZatoshi(row.fee_paid, "Zallet fee_paid").toString()
          : undefined;
      if (sent) feeAssignedTxids.add(row.txid);
      const sourceVaultId = fromAccount ? vaultForAccount(fromAccount) : undefined;
      const destinationVaultId = toAccount ? vaultForAccount(toAccount) : undefined;
      results.push({
        id: createHash("sha256").update(identity).digest("hex"),
        txid: row.txid,
        direction,
        zatoshi: valueZatoshi.toString(),
        feeZatoshi: fee,
        memo,
        toAddress: canonicalizeObservedAddress(output.to_address),
        counterparty:
          direction === "internal"
            ? "Transfer between purpose vaults"
            : direction === "anchor"
              ? "Audit anchor self-transfer"
              : direction === "incoming"
                ? `${normalizedPool === "Transparent" ? "Transparent" : "Shielded"} testnet sender`
                : `${normalizedPool === "Transparent" ? "Transparent" : "Shielded"} testnet recipient`,
        vaultId: direction === "internal" ? sourceVaultId! : vaultForAccount(canonicalAccount ?? row.account_uuid),
        accountFingerprint: canonicalAccount ? accountFingerprint(canonicalAccount) : undefined,
        sourceAccountFingerprint: fromAccount ? accountFingerprint(fromAccount) : undefined,
        destinationAccountFingerprint: toAccount ? accountFingerprint(toAccount) : undefined,
        sourceVaultId,
        destinationVaultId,
        anchorInternalProvenance: direction === "anchor" ? true : undefined,
        confirmations,
        blockHeight: row.mined_height ?? undefined,
        timestamp: rowTimestamps.get(row)!,
        status: confirmations >= minimum ? "confirmed" : row.expired_unmined ? "failed" : "pending",
        failureReason: row.expired_unmined ? "expired-unmined" : undefined,
        pool: normalizedPool,
        source: "rpc",
      });
    }
  }
  const batch = results as ScannedTransactions;
  Object.defineProperty(batch, "scanToken", { value: scanToken, enumerable: false });
  return batch;
}

export async function listReceivedTransactions(): Promise<ScannedTransactions> {
  const chain = await assertTestnet();
  if (walletEndpoint() && !isLegacyConfiguration()) await verifyConfiguredWalletScope();
  if (!walletEndpoint()) throw new ZcashRpcError("Set ZALLET_RPC_URL to scan live receipts.");
  if (!isLegacyConfiguration() && (process.env.ZCASH_WALLET_FLAVOR ?? "zallet") === "zallet") {
    try {
      return await listZalletTransactions(chain);
    } catch (error) {
      if (!(error instanceof ZcashRpcError) || error.code !== -32601 || error.method !== "z_listtransactions")
        throw error;
    }
  }
  throw new ZcashRpcError(
    "Legacy wallet RPC supports status/read-only compatibility only; importing account-scoped transactions requires Zallet.",
  );
}

export function validateShieldedTestnetAddress(address: string): boolean {
  return isShieldedTestnetAddress(address);
}

export async function sendShieldedPayment(input: {
  toAddress: string;
  zatoshi: string;
  memo: string;
  fromAddress?: string;
}): Promise<{ operationId: string }> {
  if (process.env.ZCASH_ALLOW_SEND !== "true")
    throw new ZcashRpcError("Sending is locked. Set ZCASH_ALLOW_SEND=true to enable actual testnet broadcasts.");
  if (process.env.ZALLET_EXTERNAL_BROADCAST_CONFIRMED !== "true")
    throw new ZcashRpcError(
      "The Zallet beta RPC does not report the broadcast outcome; separately verify external.broadcast=true and confirm it with ZALLET_EXTERNAL_BROADCAST_CONFIRMED=true.",
    );
  const chain = await assertTestnet();
  if (!walletEndpoint()) throw new ZcashRpcError("The Zallet RPC is not connected for sending.");
  if (isLegacyConfiguration() || process.env.ZCASH_WALLET_FLAVOR === "legacy") {
    throw new ZcashRpcError("Sending through the legacy wallet RPC is disabled; account-scoped Zallet is required.");
  }
  await verifyConfiguredWalletScope();
  const from =
    input.fromAddress?.trim() || process.env.ZCASH_FROM_ADDRESS?.trim() || process.env.ZCASH_RECEIVER_ADDRESS?.trim();
  if (!from) throw new ZcashRpcError("ZCASH_FROM_ADDRESS is not set.");
  if (!validateShieldedTestnetAddress(input.toAddress))
    throw new ZcashRpcError("Payments can be sent only to a testnet Unified or Sapling shielded address.");
  const amount = BigInt(input.zatoshi);
  if (amount <= 0n) throw new ZcashRpcError("The send amount must be greater than zero.");
  const memoBytes = Buffer.byteLength(input.memo, "utf8");
  if (memoBytes > 512) throw new ZcashRpcError(`The Zcash memo limit is 512 bytes (${memoBytes} bytes).`);

  const walletStatus = await callWalletRpc<WalletStatusInfo>("getwalletstatus");
  if (!walletExactlySynchronized(chain, walletStatus)) {
    const walletHeight = walletStatus.wallet_tip?.height ?? walletStatus.fully_synced_height ?? 0;
    throw new ZcashRpcError(
      `The Zallet node/wallet tip height and hash are not exactly synchronized with Zebra (${walletHeight}/${chain.blocks ?? "?"}).`,
    );
  }
  const privacyPolicy = process.env.ZCASH_PRIVACY_POLICY ?? "FullPrivacy";
  if (privacyPolicy !== "FullPrivacy")
    throw new ZcashRpcError(
      "ZechLedger sends only with the Zallet FullPrivacy policy; weaker disclosure policies are rejected.",
    );
  const operationId = await callWalletRpc<string>("z_sendmany", [
    from,
    [
      {
        address: input.toAddress.trim(),
        amount: zatoshiToZec(amount),
        memo: Buffer.from(input.memo, "utf8").toString("hex"),
      },
    ],
    minimumConfirmations(),
    null,
    privacyPolicy,
  ]);
  if (!/^opid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new ZcashRpcError(
      "Zallet z_sendmany did not return a valid exact opid; the broadcast outcome is uncertain and retries must be blocked.",
      undefined,
      "z_sendmany",
    );
  }
  return { operationId };
}

export async function getOperationStatus(operationId: string, consume = false): Promise<unknown> {
  await assertTestnet();
  return callWalletRpc(consume ? "z_getoperationresult" : "z_getoperationstatus", [[operationId]]);
}
