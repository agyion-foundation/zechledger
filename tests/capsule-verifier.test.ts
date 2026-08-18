import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendJournal, buildAuditManifest, canonicalJson } from "@/lib/accounting";
import { tryFromZatoshi } from "@/lib/money";
import { createSeedState } from "@/lib/seed";

let directory = "";
let publicPath = "";
let privatePem = "";
let publicPem = "";
let baseManifest: ReturnType<typeof buildAuditManifest>["manifest"];
let liveManifest: ReturnType<typeof buildAuditManifest>["manifest"];
let liveState: ReturnType<typeof createSeedState>;
let internalManifest: ReturnType<typeof buildAuditManifest>["manifest"];
let vaultId = "";
let period = "";

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "zechledger-verifier-"));
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  privatePem = pair.privateKey;
  publicPem = pair.publicKey;
  publicPath = path.join(directory, "public.pem");
  await writeFile(publicPath, publicPem);
  const state = createSeedState();
  vaultId = state.invoices[0].vaultId;
  period = state.invoices[0].issueDate.slice(0, 7);
  baseManifest = buildAuditManifest(state, vaultId, period).manifest;

  liveState = createSeedState();
  const invoice = liveState.invoices[0];
  const observedAt = new Date().toISOString();
  const syncScope = "7".repeat(64);
  liveState.mode = "live";
  liveState.settings.lastSyncAt = observedAt;
  liveState.settings.lastSyncScope = syncScope;
  liveState.settings.lastSyncToken = `4000000:${"8".repeat(64)}`;
  liveState.transactions = [
    {
      id: "1".repeat(64),
      canonicalId: "1".repeat(64),
      txid: invoice.paymentTxid!,
      direction: "incoming",
      zatoshi: invoice.zatoshi,
      memo: invoice.memoRef,
      toAddress: invoice.receiveAddress,
      counterparty: "Testnet sender",
      vaultId: invoice.vaultId,
      accountFingerprint: "4".repeat(64),
      confirmations: 11,
      blockHeight: 3_999_990,
      timestamp: `${period}-15T21:30:00.000Z`,
      lastObservedAt: observedAt,
      syncScope,
      observationState: "observed",
      accountingValuationRateTry: liveState.settings.demoRateTry,
      accountingValuationSource: "configured-static",
      status: "confirmed",
      pool: "Orchard",
      source: "rpc",
      observationHash: "3".repeat(64),
    },
  ];
  liveManifest = buildAuditManifest(liveState, vaultId, period).manifest;

  const internalState = createSeedState();
  internalState.journals = [];
  internalState.invoices = [];
  internalState.expenses = [];
  internalState.ledgerHead = "0".repeat(64);
  const internalObservedAt = new Date().toISOString();
  const internalSyncScope = "9".repeat(64);
  const internalCanonicalId = "a".repeat(64);
  const internalTxid = "b".repeat(64);
  const internalZatoshi = "100000000";
  const internalFeeZatoshi = "10000";
  const rate = internalState.settings.demoRateTry;
  const amountTry = tryFromZatoshi(internalZatoshi, rate);
  const feeTry = tryFromZatoshi(internalFeeZatoshi, rate);
  const [periodYear, periodMonth] = period.split("-").map(Number);
  const priorDate = new Date(Date.UTC(periodYear, periodMonth - 2, 15)).toISOString().slice(0, 10);
  const periodDate = `${period}-15`;
  internalState.mode = "live";
  internalState.settings.lastSyncAt = internalObservedAt;
  internalState.settings.lastSyncScope = internalSyncScope;
  internalState.settings.lastSyncToken = `4000000:${"c".repeat(64)}`;
  internalState.transactions = [
    {
      id: internalCanonicalId,
      canonicalId: internalCanonicalId,
      txid: internalTxid,
      direction: "internal",
      zatoshi: internalZatoshi,
      feeZatoshi: internalFeeZatoshi,
      memo: "ZECHLEDGER|INTERNAL|verifier",
      counterparty: "Transfer between purpose vaults",
      vaultId: "vault-export",
      accountFingerprint: "d".repeat(64),
      sourceAccountFingerprint: "d".repeat(64),
      destinationAccountFingerprint: "e".repeat(64),
      sourceVaultId: "vault-export",
      destinationVaultId: "vault-rnd",
      confirmations: 11,
      blockHeight: 3_999_990,
      timestamp: `${period}T12:00:00.000Z`.replace(`${period}T`, `${period}-15T`),
      lastObservedAt: internalObservedAt,
      syncScope: internalSyncScope,
      observationState: "observed",
      accountingValuationRateTry: rate,
      accountingValuationSource: "configured-static",
      status: "confirmed",
      pool: "Orchard",
      source: "rpc",
      observationHash: "f".repeat(64),
    },
  ];
  const appendTransfer = (date: string, reverse: boolean) =>
    appendJournal(internalState, {
      date,
      description: `${reverse ? "REORG REVERSAL · " : ""}Outgoing transfer between purpose vaults`,
      sourceType: "transfer",
      sourceId: `internal-out:${internalCanonicalId}`,
      vaultId: "vault-export",
      chainTxid: internalTxid,
      valuationRateTry: rate,
      valuationSource: "configured-static",
      lines: reverse
        ? [
            { accountCode: "136.10", accountName: "Transfer", debitTry: 0, creditTry: amountTry },
            { accountCode: "102.10", accountName: "ZEC", debitTry: amountTry, creditTry: 0, zatoshi: internalZatoshi },
          ]
        : [
            { accountCode: "136.10", accountName: "Transfer", debitTry: amountTry, creditTry: 0 },
            { accountCode: "102.10", accountName: "ZEC", debitTry: 0, creditTry: amountTry, zatoshi: internalZatoshi },
          ],
    });
  const appendFee = (date: string, reverse: boolean) =>
    appendJournal(internalState, {
      date,
      description: `${reverse ? "REORG REVERSAL · " : ""}ZIP-317`,
      sourceType: "fee",
      sourceId: `fee:${internalCanonicalId}`,
      vaultId: "vault-export",
      chainTxid: internalTxid,
      valuationRateTry: rate,
      valuationSource: "configured-static",
      lines: reverse
        ? [
            { accountCode: "780", accountName: "Network expense", debitTry: 0, creditTry: feeTry },
            { accountCode: "102.10", accountName: "ZEC", debitTry: feeTry, creditTry: 0, zatoshi: internalFeeZatoshi },
          ]
        : [
            { accountCode: "780", accountName: "Network expense", debitTry: feeTry, creditTry: 0 },
            { accountCode: "102.10", accountName: "ZEC", debitTry: 0, creditTry: feeTry, zatoshi: internalFeeZatoshi },
          ],
    });
  appendTransfer(priorDate, false);
  appendTransfer(periodDate, true);
  appendTransfer(periodDate, false);
  appendFee(priorDate, false);
  appendFee(periodDate, true);
  appendFee(periodDate, false);
  internalManifest = buildAuditManifest(internalState, "vault-export", period).manifest;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function verifyManifest(manifest: typeof baseManifest, capsuleChanges: Record<string, unknown> = {}) {
  const hash = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
  const signature = sign(null, Buffer.from(hash, "hex"), privatePem).toString("base64");
  const fingerprint = createHash("sha256").update(publicPem.trim()).digest("hex");
  const capsule = {
    id: "capsule-test",
    requestId: "11111111-2222-4333-8444-555555555555",
    vaultId,
    period,
    manifestHash: hash,
    signature,
    signingKeyFingerprint: fingerprint,
    ledgerHead: manifest.ledgerHead,
    entryCount: manifest.journals.length,
    status: "local",
    ...capsuleChanges,
  };
  const file = path.join(directory, `${Math.random().toString(16).slice(2)}.json`);
  await writeFile(
    file,
    JSON.stringify({
      capsule,
      manifest,
      verification: {
        expectedManifestHash: hash,
        signature,
        signingKeyFingerprint: fingerprint,
      },
    }),
  );
  return spawnSync(process.execPath, ["scripts/verify-capsule.mjs", file, "--public-key", publicPath], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("independent capsule verifier semantics", () => {
  it("verifies a valid signed demo manifest", async () => {
    const result = await verifyManifest(structuredClone(baseManifest));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Signed manifest integrity");
  });

  it("does not silently reinterpret legacy v2 under v3 rules", async () => {
    const legacy = structuredClone(baseManifest);
    (legacy as { protocol: string }).protocol = "zechledger-audit-capsule/2";
    const result = await verifyManifest(legacy);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/legacy v2/);
  });

  it("rejects fractional line amounts and an incorrect vault scope even when signed", async () => {
    const fractional = structuredClone(baseManifest);
    fractional.journals[0].lines[0].debitTry += 0.5;
    const fractionalResult = await verifyManifest(fractional);
    expect(fractionalResult.status).toBe(1);
    expect(fractionalResult.stderr).toMatch(/integer amount in TRY minor units/);

    const wrongVault = structuredClone(baseManifest);
    wrongVault.journals[0].vaultId = "vault-rnd";
    const scopeResult = await verifyManifest(wrongVault);
    expect(scopeResult.status).toBe(1);
    expect(scopeResult.stderr).toMatch(/outside the manifest .*scope/);
  });

  it("validates document scopeRoles and vault scope semantically even when signed", async () => {
    const wrongRoles = structuredClone(baseManifest);
    wrongRoles.documents[0].scopeRoles = [];
    const rolesResult = await verifyManifest(wrongRoles);
    expect(rolesResult.status).toBe(1);
    expect(rolesResult.stderr).toMatch(/scopeRoles/);

    const wrongVault = structuredClone(baseManifest);
    wrongVault.documents[0].metadata.record.vaultId = "vault-rnd";
    wrongVault.documents[0].commitment = createHash("sha256")
      .update(canonicalJson(wrongVault.documents[0].metadata.record))
      .digest("hex");
    wrongVault.documents[0].identityCommitment = createHash("sha256")
      .update(
        canonicalJson({
          id: wrongVault.documents[0].id,
          kind: wrongVault.documents[0].kind,
          recordCommitment: wrongVault.documents[0].commitment,
        }),
      )
      .digest("hex");
    const vaultResult = await verifyManifest(wrongVault);
    expect(vaultResult.status).toBe(1);
    expect(vaultResult.stderr).toMatch(/document kind\/vault/);
  });

  it("validates the Istanbul period, exact sync, and freshness scope of a live wallet observation", async () => {
    const valid = await verifyManifest(structuredClone(liveManifest));
    expect(valid.status, valid.stderr).toBe(0);

    const wrongPeriod = structuredClone(liveManifest);
    wrongPeriod.txids[0].timestamp = "2025-12-31T20:59:59.000Z";
    const periodResult = await verifyManifest(wrongPeriod);
    expect(periodResult.status).toBe(1);
    expect(periodResult.stderr).toMatch(/timestamp|identity/);

    const transparentMatch = structuredClone(liveManifest);
    transparentMatch.txids[0].pool = "Transparent";
    const transparentResult = await verifyManifest(transparentMatch);
    expect(transparentResult.status).toBe(1);
    expect(transparentResult.stderr).toMatch(/cannot be Transparent/);
  });

  it("signs a producer wallet row only at the same exact-sync observation instant", () => {
    const stale = structuredClone(liveState);
    stale.transactions[0].lastObservedAt = new Date(
      Date.parse(stale.transactions[0].lastObservedAt!) - 1_000,
    ).toISOString();
    expect(() => buildAuditManifest(stale, vaultId, period)).toThrow(/observation freshness or scope/);
  });

  it("fails closed on the old posting period after orphaning or a cross-month remine", () => {
    const orphaned = structuredClone(liveState);
    orphaned.transactions[0].status = "failed";
    orphaned.transactions[0].observationState = "absent";
    expect(() => buildAuditManifest(orphaned, vaultId, period)).toThrow(/chain journal in the selected posting period/);

    const remined = structuredClone(liveState);
    const [year, month] = period.split("-").map(Number);
    const nextPeriod = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
    remined.transactions[0].timestamp = `${nextPeriod}-01T12:00:00.000Z`;
    expect(() => buildAuditManifest(remined, vaultId, period)).toThrow(/chain journal in the selected posting period/);
  });

  it("verifies cross-period fee and internal-transfer support history with explicit semantics", async () => {
    expect(internalManifest.journals.some((entry) => entry.capsuleScopeRole === "settlement-support")).toBe(true);
    const valid = await verifyManifest(structuredClone(internalManifest));
    expect(valid.status, valid.stderr).toBe(0);

    const tampered = structuredClone(internalManifest);
    const fee = tampered.journals.find(
      (entry) => entry.sourceType === "fee" && entry.capsuleScopeRole === "period-entry",
    );
    expect(fee).toBeDefined();
    const cash = fee!.lines.find((line) => line.accountCode === "102.10");
    cash!.zatoshi = (BigInt(cash!.zatoshi!) + 1n).toString();
    const core = { ...fee! } as Record<string, unknown>;
    delete core.hash;
    delete core.capsuleScopeRole;
    fee!.hash = createHash("sha256")
      .update(`${fee!.previousHash}:${canonicalJson(core)}`)
      .digest("hex");
    const result = await verifyManifest(tampered);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/fee output/);
  });

  it("does not verify a live posting-period chain journal without a current wallet output", async () => {
    const unsupported = structuredClone(liveManifest);
    unsupported.txids = [];
    unsupported.evidenceClass = "live-local-ledger-no-wallet-observation-in-scope";
    const result = await verifyManifest(unsupported);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/current confirmed wallet/);
  });

  it("rejects divergence between duplicate cryptographic fields in capsule and verification", async () => {
    const result = await verifyManifest(structuredClone(baseManifest), {
      manifestHash: "0".repeat(64),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cryptographic fields/);
  });

  it("rejects drift in the unsigned outer-envelope entryCount", async () => {
    const result = await verifyManifest(structuredClone(baseManifest), {
      entryCount: baseManifest.journals.length + 1,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/envelope scope/);
  });
});
