export async function register() {
  if (process.env.ZECHLEDGER_UNSAFE_DEMO_NO_AUTH !== "true" && process.env.ZECHLEDGER_VERCEL_BLOB_DEMO !== "true")
    return;
  const { unsafeDemoEnvironmentAllowed, vercelBlobDemoStoreAllowed } = await import("@/lib/config");
  if (process.env.ZECHLEDGER_UNSAFE_DEMO_NO_AUTH === "true" && !unsafeDemoEnvironmentAllowed()) {
    throw new Error(
      "ZECHLEDGER_UNSAFE_DEMO_NO_AUTH may be enabled only in a non-production process with no wallet and sending disabled.",
    );
  }
  if (process.env.ZECHLEDGER_VERCEL_BLOB_DEMO === "true" && !vercelBlobDemoStoreAllowed()) {
    throw new Error(
      "ZECHLEDGER_VERCEL_BLOB_DEMO may be used only in production with no wallet and all broadcast paths disabled.",
    );
  }
}
