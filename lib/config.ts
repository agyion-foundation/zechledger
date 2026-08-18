export function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export const minimumConfirmations = () => integerEnv("ZCASH_MIN_CONFIRMATIONS", 10, 1, 100);
export const rpcTimeoutMs = () => integerEnv("ZCASH_RPC_TIMEOUT_MS", 12_000, 1_000, 120_000);
export const syncMaxRows = () => integerEnv("ZALLET_SYNC_MAX_ROWS", 5_000, 250, 100_000);

export function validAdminTokenConfigured(): boolean {
  const token = process.env.ZECHLEDGER_ADMIN_TOKEN;
  return Boolean(token && token.length >= 16 && !/replace|changeme|change-me/i.test(token));
}

export function unsafeDemoEnvironmentAllowed(): boolean {
  return (
    process.env.ZECHLEDGER_UNSAFE_DEMO_NO_AUTH === "true" &&
    process.env.NODE_ENV !== "production" &&
    !process.env.ZALLET_RPC_URL &&
    !process.env.ZCASH_RPC_URL &&
    process.env.ZCASH_ALLOW_SEND !== "true"
  );
}

export function vercelBlobDemoStoreAllowed(): boolean {
  return (
    process.env.ZECHLEDGER_VERCEL_BLOB_DEMO === "true" &&
    process.env.NODE_ENV === "production" &&
    !process.env.ZALLET_RPC_URL &&
    !process.env.ZCASH_RPC_URL &&
    process.env.ZCASH_ALLOW_SEND !== "true" &&
    process.env.ZALLET_EXTERNAL_BROADCAST_CONFIRMED !== "true"
  );
}
