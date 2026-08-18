import { randomUUID } from "node:crypto";
import { buildAuditManifest, verifyLedgerChain } from "@/lib/accounting";
import { signAuditManifestHash } from "@/lib/audit-signing";
import { recordCommitment } from "@/lib/commitments";
import { ApiConflictError, apiError, noStoreJson } from "@/lib/http";
import { getState, mutateState } from "@/lib/store";
import { auditSchema } from "@/lib/validation";
import { assertFreshWalletSyncScope, sendShieldedPayment, ZcashRpcError } from "@/lib/zcash-rpc";
import type { AuditCapsule } from "@/lib/types";
import { accountFingerprintForVault } from "@/lib/vault-config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = auditSchema.parse(await request.json());
    const requestFingerprint = recordCommitment({
      kind: "audit-request",
      requestId: input.requestId,
      vaultId: input.vaultId,
      period: input.period,
      anchor: input.anchor,
    });
    const snapshot = await getState();
    const prior = snapshot.auditCapsules.find((item) => item.requestId === input.requestId);
    if (prior) {
      const priorFingerprint =
        prior.requestFingerprint ??
        recordCommitment({
          kind: "audit-request",
          requestId: prior.requestId,
          vaultId: prior.vaultId,
          period: prior.period,
          anchor: Boolean(prior.anchorAddress || prior.status === "pending" || prior.status === "anchored"),
        });
      if (priorFingerprint !== requestFingerprint) {
        throw new ApiConflictError("The same audit requestId cannot be reused with a different payload.", true, {
          id: prior.id,
          number: prior.name,
        });
      }
      if (input.anchor && prior.status === "local") {
        return noStoreJson(
          {
            ok: false,
            error: "The previous anchor attempt was definitively rejected; retry with a new idempotency key.",
            rotateRequestId: true,
          },
          { status: 409 },
        );
      }
      return noStoreJson(
        {
          ok: true,
          capsule: prior,
          manifest: prior.manifest,
          idempotent: true,
          outcomeUnknown: prior.status === "pending" && !prior.operationId,
        },
        { status: prior.status === "pending" ? 202 : 200 },
      );
    }
    const integrity = verifyLedgerChain(snapshot);
    if (!integrity.valid)
      throw new Error(`Ledger integrity check failed (${integrity.at ?? "head"}); the capsule was not signed.`);
    const selectedVault = snapshot.vaults.find((item) => item.id === input.vaultId);
    if (snapshot.mode === "live" && !["env", "stale"].includes(selectedVault?.metadataSource ?? ""))
      throw new Error("Purpose-vault metadata must be configured for a live audit.");
    let anchorAddress: string | undefined;
    let anchorAccountFingerprint: string | undefined;
    if (input.anchor) {
      if (process.env.ZCASH_ALLOW_SEND !== "true")
        throw new ZcashRpcError("Anchor sending is disabled; ZCASH_ALLOW_SEND=true is required.");
      assertFreshWalletSyncScope(snapshot.settings.lastSyncScope, snapshot.settings.lastSyncAt);
      const vault = snapshot.vaults.find((item) => item.id === input.vaultId);
      if (!vault || !["env", "stale"].includes(vault.metadataSource))
        throw new Error("Purpose-vault metadata must be configured for a live audit.");
      if (vault.addressSource !== "env")
        throw new Error("A real testnet address must be configured for the vault selected for the anchor.");
      if (vault.viewingKeySource !== "env" || !vault.viewingKeyFingerprint)
        throw new Error("The selected vault's env UFVK fingerprint must be configured for the anchor policy.");
      let mappedFrom: string | undefined;
      if (process.env.ZCASH_VAULT_ADDRESS_MAP) {
        const addressMap = JSON.parse(process.env.ZCASH_VAULT_ADDRESS_MAP) as Record<string, string>;
        mappedFrom = addressMap[input.vaultId]?.trim();
      } else if (input.vaultId === "vault-export") {
        mappedFrom = process.env.ZCASH_FROM_ADDRESS?.trim() || process.env.ZCASH_RECEIVER_ADDRESS?.trim();
      }
      if (!mappedFrom || mappedFrom !== vault.address) {
        throw new Error(
          "The anchor must be a safe self-transfer; the vault's source and recipient addresses were not found in the same env mapping.",
        );
      }
      anchorAddress = mappedFrom;
      anchorAccountFingerprint = accountFingerprintForVault(input.vaultId);
      if (!anchorAccountFingerprint)
        throw new Error("A Zallet account mapping for the purpose vault is required for the anchor.");
    }

    const { manifest, hash, entryCount } = buildAuditManifest(
      snapshot,
      input.vaultId,
      input.period,
      anchorAddress && anchorAccountFingerprint
        ? { toAddress: anchorAddress, accountFingerprint: anchorAccountFingerprint, zatoshi: "1000" }
        : undefined,
    );
    const attestation = await signAuditManifestHash(hash);
    const memo = `ZECHLEDGER|AUDIT|v3|${hash}`;
    const intentId = input.anchor ? randomUUID() : undefined;
    const mutation = await mutateState((state) => {
      const existing = state.auditCapsules.find((item) => item.requestId === input.requestId);
      if (existing) {
        const existingFingerprint =
          existing.requestFingerprint ??
          recordCommitment({
            kind: "audit-request",
            requestId: existing.requestId,
            vaultId: existing.vaultId,
            period: existing.period,
            anchor: Boolean(existing.anchorAddress || existing.status === "pending" || existing.status === "anchored"),
          });
        if (existingFingerprint !== requestFingerprint)
          throw new ApiConflictError("The same audit requestId cannot be reused with a different payload.", true, {
            id: existing.id,
            number: existing.name,
          });
        return { capsule: existing, created: false };
      }
      const vault = state.vaults.find((item) => item.id === input.vaultId);
      if (!vault) throw new Error("Purpose vault not found.");
      const capsule: AuditCapsule = {
        id: randomUUID(),
        requestId: input.requestId,
        requestFingerprint,
        name: `${vault.name} · ${input.period} audit capsule`,
        vaultId: input.vaultId,
        period: input.period,
        scopes: ["journals", "transactions", "documents", "viewing-key-fingerprint"],
        manifestHash: hash,
        signature: attestation.signature,
        signatureAlgorithm: "Ed25519",
        signingKeyFingerprint: attestation.keyFingerprint,
        ledgerHead: snapshot.ledgerHead,
        entryCount,
        createdAt: new Date().toISOString(),
        status: input.anchor ? "pending" : "local",
        anchorAddress,
        anchorAccountFingerprint,
        manifest,
      };
      state.auditCapsules.unshift(capsule);
      if (intentId) {
        state.transactions.unshift({
          id: intentId,
          txid: `intent:${intentId}`,
          direction: "anchor",
          zatoshi: "1000",
          memo,
          toAddress: anchorAddress,
          counterparty: "Audit digest · self-transfer outbox",
          vaultId: input.vaultId,
          accountFingerprint: anchorAccountFingerprint,
          anchorInternalProvenance: true,
          confirmations: 0,
          timestamp: new Date().toISOString(),
          status: "pending",
          pool: "Shielded",
          source: "rpc",
        });
      }
      state.activities.unshift({
        id: randomUUID(),
        kind: "audit",
        title: input.anchor ? "Anchor intent persisted to the durable outbox" : "Signed audit capsule created",
        detail: `${vault.name} · ${hash.slice(0, 12)}…`,
        timestamp: new Date().toISOString(),
        tone: input.anchor ? "warning" : "positive",
      });
      return { capsule, created: true };
    });
    const capsule = mutation.result.capsule;
    if (!mutation.result.created && input.anchor && capsule.status === "local") {
      return noStoreJson(
        { ok: false, error: "The same idempotency key was used for a local capsule.", rotateRequestId: true },
        { status: 409 },
      );
    }
    if (!mutation.result.created || !input.anchor || !intentId || !anchorAddress) {
      return noStoreJson(
        { ok: true, capsule, manifest: capsule.manifest, idempotent: !mutation.result.created },
        { status: mutation.result.created ? 201 : 200 },
      );
    }

    try {
      const result = await sendShieldedPayment({
        toAddress: anchorAddress,
        fromAddress: anchorAddress,
        zatoshi: "1000",
        memo,
      });
      const update = await mutateState((state) => {
        const current = state.auditCapsules.find((item) => item.id === capsule.id);
        const tx = state.transactions.find((item) => item.id === intentId && item.status === "pending");
        if (current) current.operationId = result.operationId;
        if (tx) tx.txid = `opid:${result.operationId}`;
        state.activities.unshift({
          id: randomUUID(),
          kind: "audit",
          title: "Anchor submitted to Zallet · awaiting chain confirmation",
          detail: result.operationId,
          timestamp: new Date().toISOString(),
          tone: "warning",
        });
        return current ?? capsule;
      });
      return noStoreJson(
        { ok: true, capsule: update.result, manifest, operationId: result.operationId },
        { status: 202 },
      );
    } catch (error) {
      const definitelyFailed =
        error instanceof ZcashRpcError &&
        (error.method !== "z_sendmany" || (error.code !== undefined && error.code < 0));
      await mutateState((state) => {
        const current = state.auditCapsules.find((item) => item.id === capsule.id);
        const tx = state.transactions.find((item) => item.id === intentId);
        if (definitelyFailed) {
          if (current) current.status = "local";
          if (tx) tx.status = "failed";
        } else if (tx) {
          tx.operationOutcome = "unknown";
        }
        state.activities.unshift({
          id: randomUUID(),
          kind: "audit",
          title: definitelyFailed ? "Anchor broadcast rejected" : "Anchor RPC outcome uncertain · do not resend",
          detail: (error as Error).message,
          timestamp: new Date().toISOString(),
          tone: "warning",
        });
      });
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}
