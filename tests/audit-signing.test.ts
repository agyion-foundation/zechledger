import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signAuditManifestHash, signAuditReceipt, verifyAuditCapsuleSignatures } from "@/lib/audit-signing";
import type { AuditCapsule } from "@/lib/types";

let directory = "";
let capsule: AuditCapsule;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "zechledger-audit-signing-"));
  process.env.ZECHLEDGER_DATA_DIR = directory;
  const manifestHash = "a".repeat(64);
  const attestation = await signAuditManifestHash(manifestHash);
  const receiptCore = {
    manifestHash,
    txid: "b".repeat(64),
    blockHeight: 123,
    confirmations: 10,
    observedAt: "2026-08-17T12:00:00.000Z",
    destinationObserved: null,
    accountFingerprint: "c".repeat(64),
    memo: `ZECHLEDGER|AUDIT|v3|${manifestHash}`,
    zatoshi: "1000",
    internalProvenance: "same-account-from-to" as const,
  };
  const receipt = await signAuditReceipt(receiptCore);
  capsule = {
    id: "signed-capsule",
    requestId: "11111111-2222-4333-8444-555555555555",
    name: "Signed",
    vaultId: "vault-export",
    period: "2026-08",
    scopes: ["journals"],
    manifestHash,
    signature: attestation.signature,
    signatureAlgorithm: "Ed25519",
    signingKeyFingerprint: attestation.keyFingerprint,
    ledgerHead: "0".repeat(64),
    entryCount: 0,
    createdAt: "2026-08-17T12:00:00.000Z",
    status: "anchored",
    anchorTxid: receiptCore.txid,
    anchorReceipt: {
      ...receiptCore,
      signature: receipt.signature,
      signatureAlgorithm: "Ed25519",
      signingKeyFingerprint: receipt.keyFingerprint,
    },
  };
});

afterAll(async () => {
  delete process.env.ZECHLEDGER_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

describe("persisted audit signature integrity", () => {
  it("verifies manifest and receipt signatures", async () => {
    await expect(verifyAuditCapsuleSignatures([capsule])).resolves.toBeUndefined();
  });

  it("rejects a manifest or receipt whose signed fields were modified on disk", async () => {
    await expect(verifyAuditCapsuleSignatures([{ ...capsule, manifestHash: "d".repeat(64) }])).rejects.toThrow(
      /capsule signature/,
    );
    await expect(
      verifyAuditCapsuleSignatures([{ ...capsule, anchorReceipt: { ...capsule.anchorReceipt!, confirmations: 11 } }]),
    ).rejects.toThrow(/receipt signature/);
  });
});
