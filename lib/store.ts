import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { getDataDirectory } from "@/lib/data-directory";
import { createEmptyLiveState, createSeedState, DEMO_TESTNET_ADDRESSES } from "@/lib/seed";
import {
  assertShieldedTestnetAddress,
  canonicalShieldedTestnetAddress,
  isTestnetUnifiedFullViewingKey,
  shieldedTestnetAddressKind,
} from "@/lib/zcash-address";
import { verifyLedgerChain } from "@/lib/accounting";
import { verifyAuditCapsuleSignatures } from "@/lib/audit-signing";
import { verifyRecordCommitments } from "@/lib/commitments";
import { minimumConfirmations, unsafeDemoEnvironmentAllowed, vercelBlobDemoStoreAllowed } from "@/lib/config";
import { canonicalAccountUuid, configuredVaultAccountMap, configuredWalletAccounts } from "@/lib/vault-config";
import type { AppState } from "@/lib/types";
import { accountingDate } from "@/lib/accounting-date";

function dataFile(): string {
  return path.join(getDataDirectory(), "ledger.json");
}

let mutationQueue: Promise<unknown> = Promise.resolve();
const heldDataLocks = new Map<string, Promise<void>>();

function processStartToken(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? null;
  } catch {
    return null;
  }
}

function processIsActive(pid: number, expectedStart: string | null | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  const actualStart = processStartToken(pid);
  return !expectedStart || !actualStart || actualStart === expectedStart;
}

async function acquireDataLock(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, ".zechledger.lock");
  const owner = { pid: process.pid, startToken: processStartToken(process.pid), nonce: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify(owner)}
`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      process.once("exit", () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, "utf8")) as { nonce?: string };
          if (current.nonce === owner.nonce) unlinkSync(lockPath);
        } catch {}
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: { pid?: number; startToken?: string | null };
      try {
        current = JSON.parse(await readFile(lockPath, "utf8")) as typeof current;
      } catch {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw new Error(
          "The ZECHLEDGER_DATA_DIR lock file cannot be read; processing stopped fail-closed because another writer may be active.",
        );
      }
      const active =
        Number.isSafeInteger(current.pid) && current.pid! > 0 && processIsActive(current.pid!, current.startToken);
      const sameDevelopmentProcess =
        process.env.NODE_ENV === "development" &&
        current.pid === process.pid &&
        current.startToken === processStartToken(process.pid);
      if (sameDevelopmentProcess) return;
      if (active)
        throw new Error(
          `ZECHLEDGER_DATA_DIR is being used by another live process (pid ${current.pid}); the multi-writer file store was rejected.`,
        );
      await unlink(lockPath).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error("Failed to acquire the exclusive ZECHLEDGER_DATA_DIR lock.");
}

async function ensureDataLock(): Promise<void> {
  const directory = getDataDirectory();
  let lock = heldDataLocks.get(directory);
  if (!lock) {
    lock = acquireDataLock(directory);
    heldDataLocks.set(directory, lock);
    lock.catch(() => heldDataLocks.delete(directory));
  }
  await lock;
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const current = mutationQueue.catch(() => undefined).then(operation);
  mutationQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function writeStateFile(state: AppState): Promise<void> {
  const directory = getDataDirectory();
  await ensureDataLock();
  await mkdir(directory, { recursive: true });
  const destination = dataFile();
  const temporary = `${destination}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(
        `${JSON.stringify(state, null, 2)}
`,
        "utf8",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function applyRuntimeConfiguration(state: AppState): AppState {
  const receiver = process.env.ZCASH_RECEIVER_ADDRESS?.trim();
  const configured = Boolean(process.env.ZALLET_RPC_URL || process.env.ZCASH_RPC_URL);
  const demoAddresses: Record<string, string> = {
    "vault-export": DEMO_TESTNET_ADDRESSES.export,
    "vault-operations": DEMO_TESTNET_ADDRESSES.operations,
    "vault-rnd": DEMO_TESTNET_ADDRESSES.rnd,
  };
  for (const vault of state.vaults) {
    vault.address = demoAddresses[vault.id] ?? DEMO_TESTNET_ADDRESSES.export;
    vault.addressSource = "demo";
    vault.pool = "Sapling";
  }
  state.settings.receiverAddress = DEMO_TESTNET_ADDRESSES.export;
  if (configured) state.mode = "live";
  if (configured) {
    if (process.env.ZALLET_VAULT_ACCOUNT_MAP && process.env.ZALLET_ACCOUNT_UUID?.trim()) {
      const accountMap = configuredVaultAccountMap()!;
      const selectedAccount = canonicalAccountUuid(process.env.ZALLET_ACCOUNT_UUID);
      const accounts = Object.keys(accountMap);
      if (accounts.length !== 1 || accounts[0] !== selectedAccount) {
        throw new Error(
          "ZALLET_ACCOUNT_UUID must be unset when using a multi-account ZALLET_VAULT_ACCOUNT_MAP; otherwise, the other vaults will not be scanned.",
        );
      }
    } else if (process.env.ZALLET_ACCOUNT_UUID) {
      canonicalAccountUuid(process.env.ZALLET_ACCOUNT_UUID);
    } else if (process.env.ZALLET_VAULT_ACCOUNT_MAP) {
      configuredVaultAccountMap();
    }
    const legalName = process.env.ZECHLEDGER_COMPANY_LEGAL_NAME?.trim();
    const taxId = process.env.ZECHLEDGER_COMPANY_TAX_ID?.trim();
    const operatorName = process.env.ZECHLEDGER_OPERATOR_NAME?.trim();
    if (!legalName || !taxId || !operatorName) {
      throw new Error(
        "Live mode requires ZECHLEDGER_COMPANY_LEGAL_NAME, ZECHLEDGER_COMPANY_TAX_ID, and ZECHLEDGER_OPERATOR_NAME.",
      );
    }
    const entityFingerprint = createHash("sha256").update(JSON.stringify({ legalName, taxId })).digest("hex");
    const hasFinancialHistory =
      state.invoices.length > 0 ||
      state.expenses.length > 0 ||
      state.journals.length > 0 ||
      state.transactions.length > 0 ||
      state.auditCapsules.length > 0;
    const accounts = configuredWalletAccounts();
    if (!accounts.length) throw new Error("Live mode requires a canonical Zallet account UUID allowlist.");
    const accountMap = configuredVaultAccountMap();
    const allowedAccountFingerprints = new Set(
      accounts.map((account) => createHash("sha256").update(account).digest("hex")),
    );
    for (const transaction of state.transactions.filter((item) => item.source === "rpc" && item.canonicalId)) {
      if (
        !transaction.accountFingerprint ||
        !allowedAccountFingerprints.has(transaction.accountFingerprint) ||
        (transaction.sourceAccountFingerprint &&
          !allowedAccountFingerprints.has(transaction.sourceAccountFingerprint)) ||
        (transaction.destinationAccountFingerprint &&
          !allowedAccountFingerprints.has(transaction.destinationAccountFingerprint))
      ) {
        throw new Error(`The wallet output account is outside the scope allowlist (${transaction.canonicalId}).`);
      }
    }
    if (accountMap) {
      const allowedVaults = new Set(state.vaults.map((vault) => vault.id));
      for (const vaultId of Object.values(accountMap))
        if (!allowedVaults.has(vaultId)) throw new Error(`The account map contains an unknown vault: ${vaultId}.`);
      const mappedVaults = Object.values(accountMap);
      if (new Set(mappedVaults).size !== mappedVaults.length)
        throw new Error(
          "Every purpose vault must be mapped to exactly one complete Zallet account UUID; multiple accounts per vault are not supported.",
        );
    }
    const scopePayload = accountMap
      ? Object.entries(accountMap).sort(([left], [right]) => left.localeCompare(right))
      : [[accounts[0], "vault-export"]];
    const accountScopeFingerprint = createHash("sha256").update(JSON.stringify(scopePayload)).digest("hex");
    if (
      state.settings.accountScopeFingerprint &&
      state.settings.accountScopeFingerprint !== accountScopeFingerprint &&
      hasFinancialHistory
    ) {
      throw new Error(
        "The wallet account/vault scope cannot be changed after history exists; use a new ZECHLEDGER_DATA_DIR.",
      );
    }
    state.settings.accountScopeFingerprint = accountScopeFingerprint;
    if (state.entityFingerprint && state.entityFingerprint !== entityFingerprint && hasFinancialHistory) {
      throw new Error(
        "The live legal-entity identity cannot be changed over existing ledger history; use a new ZECHLEDGER_DATA_DIR.",
      );
    }
    state.entityFingerprint = entityFingerprint;
    state.company = {
      name: process.env.ZECHLEDGER_COMPANY_NAME?.trim() || legalName,
      legalName,
      taxId,
      fiscalPeriod: process.env.ZECHLEDGER_FISCAL_PERIOD?.trim() || String(new Date().getUTCFullYear()),
      logoMark: process.env.ZECHLEDGER_COMPANY_LOGO_MARK?.trim().slice(0, 3) || "ZL",
      source: "env",
    };
    state.settings.operatorName = operatorName;
    for (const [index, vault] of state.vaults.entries()) {
      if (vault.metadataFingerprint) vault.metadataSource = "stale";
      else {
        vault.name = `Purpose Vault ${index + 1}`;
        vault.purpose = "Live metadata is not configured";
        vault.period = state.company.fiscalPeriod;
        vault.budgetTry = 0;
        vault.metadataSource = "placeholder";
      }
      vault.viewingKeySource = "unknown";
      delete vault.viewingKeyFingerprint;
    }
    if (process.env.ZECHLEDGER_VAULT_METADATA_MAP) {
      let metadata: Record<string, { name?: string; purpose?: string; period?: string; budgetTryKurus?: number }>;
      try {
        metadata = JSON.parse(process.env.ZECHLEDGER_VAULT_METADATA_MAP) as typeof metadata;
      } catch {
        throw new Error("ZECHLEDGER_VAULT_METADATA_MAP is not valid JSON.");
      }
      for (const vault of state.vaults) {
        const item = metadata[vault.id];
        if (!item) continue;
        if (
          !item.name?.trim() ||
          !item.purpose?.trim() ||
          !item.period?.trim() ||
          !Number.isSafeInteger(item.budgetTryKurus) ||
          item.budgetTryKurus! < 0
        ) {
          throw new Error(
            `ZECHLEDGER_VAULT_METADATA_MAP.${vault.id} is missing or does not contain a safe integer TRY-cent value.`,
          );
        }
        const normalized = {
          name: item.name.trim(),
          purpose: item.purpose.trim(),
          period: item.period.trim(),
          budgetTryKurus: item.budgetTryKurus!,
        };
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(normalized, Object.keys(normalized).sort()))
          .digest("hex");
        const hasHistory =
          state.invoices.some((record) => record.vaultId === vault.id) ||
          state.expenses.some((record) => record.vaultId === vault.id) ||
          state.journals.some((record) => record.vaultId === vault.id) ||
          state.transactions.some((record) => record.vaultId === vault.id) ||
          state.auditCapsules.some((record) => record.vaultId === vault.id);
        if (vault.metadataFingerprint && vault.metadataFingerprint !== fingerprint && hasHistory) {
          throw new Error(
            `${vault.id} purpose metadata cannot be changed after history exists; use a new vault ID or data directory.`,
          );
        }
        vault.name = normalized.name;
        vault.purpose = normalized.purpose;
        vault.period = normalized.period;
        vault.budgetTry = normalized.budgetTryKurus;
        vault.metadataSource = "env";
        vault.metadataFingerprint = fingerprint;
      }
    }
  }
  if (!state.settings.accountingDatePolicy) {
    const hasLegacyChainDatedHistory =
      state.mode === "live" &&
      (state.transactions.some(
        (transaction) =>
          transaction.source === "rpc" && Boolean(transaction.blockHeight || transaction.observationHash),
      ) ||
        state.journals.some((journal) => Boolean(journal.chainTxid)));
    if (hasLegacyChainDatedHistory) {
      throw new Error(
        "This live ledger was created with the legacy UTC chain-date policy and cannot be relabeled as Europe/Istanbul/v1. Archive the data and start with a new ZECHLEDGER_DATA_DIR.",
      );
    }
    state.settings.accountingDatePolicy = "Europe/Istanbul/v1";
  }
  if (state.settings.accountingDatePolicy !== "Europe/Istanbul/v1") {
    throw new Error("Unsupported accounting date policy; a new ZECHLEDGER_DATA_DIR is required.");
  }
  const configuredMinimumConfirmations = minimumConfirmations();
  const hasCanonicalWalletHistory = state.transactions.some(
    (transaction) => transaction.source === "rpc" && Boolean(transaction.observationHash),
  );
  if (
    state.mode === "live" &&
    hasCanonicalWalletHistory &&
    state.settings.minConfirmations !== configuredMinimumConfirmations
  ) {
    throw new Error(
      `ZCASH_MIN_CONFIRMATIONS cannot be changed after financial wallet history exists (${state.settings.minConfirmations} → ${configuredMinimumConfirmations}); a new ZECHLEDGER_DATA_DIR is required.`,
    );
  }
  state.settings.minConfirmations = configuredMinimumConfirmations;
  const rate = Number(process.env.ZECHLEDGER_DEMO_RATE_TRY ?? state.settings.demoRateTry);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("ZECHLEDGER_DEMO_RATE_TRY must be positive and finite.");
  state.settings.demoRateTry = rate;
  state.settings.explorerTxUrl = process.env.ZCASH_EXPLORER_TX_URL ?? state.settings.explorerTxUrl;
  if (receiver) {
    assertShieldedTestnetAddress(receiver, "ZCASH_RECEIVER_ADDRESS");
    const canonicalReceiver = canonicalShieldedTestnetAddress(receiver);
    state.settings.receiverAddress = canonicalReceiver;
    const exportVault = state.vaults.find((vault) => vault.id === "vault-export");
    if (exportVault) {
      exportVault.address = canonicalReceiver;
      exportVault.addressSource = "env";
      exportVault.pool = shieldedTestnetAddressKind(canonicalReceiver) === "unified" ? "Shielded" : "Sapling";
    }
  }
  if (process.env.ZCASH_VAULT_ADDRESS_MAP) {
    try {
      const map = JSON.parse(process.env.ZCASH_VAULT_ADDRESS_MAP) as Record<string, string>;
      for (const vault of state.vaults) {
        const address = map[vault.id]?.trim();
        if (address) {
          assertShieldedTestnetAddress(address, `ZCASH_VAULT_ADDRESS_MAP.${vault.id}`);
          const canonicalAddress = canonicalShieldedTestnetAddress(address);
          vault.address = canonicalAddress;
          vault.addressSource = "env";
          vault.pool = shieldedTestnetAddressKind(canonicalAddress) === "unified" ? "Shielded" : "Sapling";
        }
      }
      const exportAddress = map["vault-export"]?.trim();
      if (exportAddress) state.settings.receiverAddress = canonicalShieldedTestnetAddress(exportAddress);
    } catch {
      throw new Error("ZCASH_VAULT_ADDRESS_MAP is not a valid JSON object.");
    }
  }
  const accountingAsOf = accountingDate();
  for (const invoice of state.invoices) {
    if (!invoice.paymentTxid && ["pending", "overdue"].includes(invoice.status)) {
      invoice.status = invoice.dueDate < accountingAsOf ? "overdue" : "pending";
    }
  }
  if (configured && process.env.ZCASH_VAULT_UFVK_MAP) {
    let map: Record<string, string>;
    try {
      map = JSON.parse(process.env.ZCASH_VAULT_UFVK_MAP) as Record<string, string>;
    } catch {
      throw new Error("ZCASH_VAULT_UFVK_MAP is not a valid JSON object.");
    }
    for (const vault of state.vaults) {
      const ufvk = map[vault.id]?.trim();
      if (!ufvk) continue;
      if (!isTestnetUnifiedFullViewingKey(ufvk))
        throw new Error(`ZCASH_VAULT_UFVK_MAP.${vault.id} is not in ZIP-316 testnet UFVK format.`);
      vault.viewingKeyFingerprint = createHash("sha256").update(ufvk).digest("hex");
      vault.viewingKeySource = "env";
    }
  }
  return state;
}

async function readVercelBlobState(): Promise<{ state: AppState; etag: string }> {
  const { readOrCreateDemoState } = await import("@/lib/vercel-blob-demo-store");
  const versioned = await readOrCreateDemoState(() => applyRuntimeConfiguration(createSeedState()));
  const parsed = versioned.state;
  if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.journals))
    throw new Error("Unsupported Vercel demo data schema.");
  if (parsed.mode !== "demo") throw new Error("The Vercel Blob store accepts only an explicitly labeled demo ledger.");
  const recordIntegrity = verifyRecordCommitments(parsed);
  if (!recordIntegrity.valid)
    throw new Error(`Record metadata commitment integrity is invalid (${recordIntegrity.at}).`);
  await verifyAuditCapsuleSignatures(parsed.auditCapsules);
  return { state: applyRuntimeConfiguration(parsed), etag: versioned.etag };
}

async function mutateVercelBlobState<T>(
  mutator: (state: AppState) => T | Promise<T>,
): Promise<{ state: AppState; result: T }> {
  const { BlobPreconditionFailedError, replaceDemoState } = await import("@/lib/vercel-blob-demo-store");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { state, etag } = await readVercelBlobState();
    const integrity = verifyLedgerChain(state);
    const records = verifyRecordCommitments(state);
    if (!records.valid)
      throw new Error(`Record metadata commitment integrity is invalid (${records.at}); the mutation was halted.`);
    if (!integrity.valid)
      throw new Error(
        `Ledger hash-chain integrity is invalid (${integrity.at ?? "head"}); all mutations were stopped fail-closed.`,
      );
    const result = await mutator(state);
    const postIntegrity = verifyLedgerChain(state);
    const postRecords = verifyRecordCommitments(state);
    if (!postRecords.valid)
      throw new Error(
        `The mutation invalidated record commitment integrity (${postRecords.at}); the write was canceled.`,
      );
    await verifyAuditCapsuleSignatures(state.auditCapsules);
    if (!postIntegrity.valid)
      throw new Error(
        `The mutation invalidated ledger integrity (${postIntegrity.at ?? "head"}); the write was canceled.`,
      );
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    state.activities = state.activities.slice(0, 80);
    try {
      await replaceDemoState(state, etag);
      return { state, result };
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) continue;
      throw error;
    }
  }
  throw new Error("The Vercel demo ledger was updated concurrently; the safe retry limit was exceeded.");
}

async function resetVercelBlobState(): Promise<AppState> {
  const { BlobPreconditionFailedError, replaceDemoState } = await import("@/lib/vercel-blob-demo-store");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { etag } = await readVercelBlobState();
    const state = applyRuntimeConfiguration(createSeedState());
    try {
      await replaceDemoState(state, etag);
      return state;
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) continue;
      throw error;
    }
  }
  throw new Error("The Vercel demo reset could not be completed because of a concurrent update.");
}

async function readStateFile(): Promise<AppState> {
  await ensureDataLock();
  try {
    const raw = await readFile(/* turbopackIgnore: true */ dataFile(), "utf8");
    const parsed = JSON.parse(raw) as AppState;
    if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.journals)) throw new Error("Unsupported data schema.");
    const recordIntegrity = verifyRecordCommitments(parsed);
    if (!recordIntegrity.valid)
      throw new Error(`Record metadata commitment integrity is invalid (${recordIntegrity.at}).`);
    await verifyAuditCapsuleSignatures(parsed.auditCapsules);
    const walletConfigured = Boolean(process.env.ZALLET_RPC_URL || process.env.ZCASH_RPC_URL);
    if (unsafeDemoEnvironmentAllowed() && parsed.mode !== "demo") {
      throw new Error(
        "The unsafe authentication opt-out cannot be used with an existing or live ledger; restart with a token.",
      );
    }
    if (walletConfigured && parsed.mode !== "live") {
      throw new Error(
        "A demo ledger cannot be silently migrated to live mode. Archive the .zechledger directory and restart with a clean ZECHLEDGER_DATA_DIR.",
      );
    }
    return applyRuntimeConfiguration(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    const walletConfigured = Boolean(process.env.ZALLET_RPC_URL || process.env.ZCASH_RPC_URL);
    const initial = applyRuntimeConfiguration(walletConfigured ? createEmptyLiveState() : createSeedState());
    await writeStateFile(initial);
    return initial;
  }
}

export async function getState(): Promise<AppState> {
  if (vercelBlobDemoStoreAllowed()) return (await readVercelBlobState()).state;
  return serialized(readStateFile);
}

export async function mutateState<T>(
  mutator: (state: AppState) => T | Promise<T>,
): Promise<{ state: AppState; result: T }> {
  if (vercelBlobDemoStoreAllowed()) return mutateVercelBlobState(mutator);
  return serialized(async () => {
    const state = await readStateFile();
    const integrity = verifyLedgerChain(state);
    const records = verifyRecordCommitments(state);
    if (!records.valid)
      throw new Error(`Record metadata commitment integrity is invalid (${records.at}); the mutation was halted.`);
    if (!integrity.valid)
      throw new Error(
        `Ledger hash-chain integrity is invalid (${integrity.at ?? "head"}); all mutations were stopped fail-closed.`,
      );
    const result = await mutator(state);
    const postIntegrity = verifyLedgerChain(state);
    const postRecords = verifyRecordCommitments(state);
    if (!postRecords.valid)
      throw new Error(
        `The mutation invalidated record commitment integrity (${postRecords.at}); the disk write was canceled.`,
      );
    await verifyAuditCapsuleSignatures(state.auditCapsules);
    if (!postIntegrity.valid)
      throw new Error(
        `The mutation invalidated ledger integrity (${postIntegrity.at ?? "head"}); the disk write was canceled.`,
      );
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    state.activities = state.activities.slice(0, 80);
    await writeStateFile(state);
    return { state, result };
  });
}

export async function hardResetState(): Promise<AppState> {
  if (vercelBlobDemoStoreAllowed()) return resetVercelBlobState();
  return serialized(async () => {
    const state = applyRuntimeConfiguration(createSeedState());
    await writeStateFile(state);
    return state;
  });
}
