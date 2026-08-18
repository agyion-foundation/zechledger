import { createHash } from "node:crypto";

export function canonicalAccountUuid(value: string): string {
  const account = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(account)) {
    throw new Error("The Zallet account UUID format is invalid.");
  }
  return account;
}

export function configuredVaultAccountMap(): Record<string, string> | null {
  if (!process.env.ZALLET_VAULT_ACCOUNT_MAP) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.ZALLET_VAULT_ACCOUNT_MAP);
  } catch {
    throw new Error("ZALLET_VAULT_ACCOUNT_MAP is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("ZALLET_VAULT_ACCOUNT_MAP must be a JSON object.");
  const normalized: Record<string, string> = {};
  for (const [account, vault] of Object.entries(parsed)) {
    const canonical = canonicalAccountUuid(account);
    if (canonical in normalized)
      throw new Error(`ZALLET_VAULT_ACCOUNT_MAP contains a duplicate canonical account (${canonical}).`);
    if (typeof vault !== "string" || !vault.trim())
      throw new Error(`ZALLET_VAULT_ACCOUNT_MAP.${canonical} must be a non-empty vault ID.`);
    normalized[canonical] = vault.trim();
  }
  return normalized;
}

export function accountFingerprint(accountUuid: string): string {
  return createHash("sha256").update(canonicalAccountUuid(accountUuid)).digest("hex");
}

export function accountFingerprintForVault(vaultId: string): string | undefined {
  const map = configuredVaultAccountMap();
  if (map) {
    const accounts = Object.entries(map)
      .filter(([, mappedVault]) => mappedVault === vaultId)
      .map(([account]) => account);
    if (accounts.length !== 1)
      throw new Error(
        `${vaultId} requires exactly one complete Zallet account UUID mapping (found: ${accounts.length}).`,
      );
    return accountFingerprint(accounts[0]);
  }
  const account = process.env.ZALLET_ACCOUNT_UUID;
  return vaultId === "vault-export" && account ? accountFingerprint(account) : undefined;
}

export function configuredWalletAccounts(): string[] {
  if (process.env.ZALLET_ACCOUNT_UUID?.trim()) return [canonicalAccountUuid(process.env.ZALLET_ACCOUNT_UUID)];
  const map = configuredVaultAccountMap();
  return map ? Object.keys(map).sort() : [];
}
