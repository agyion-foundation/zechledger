import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/lib/seed";
import { recordCommitment } from "@/lib/commitments";
import type { AppState } from "@/lib/types";

let state: AppState;
vi.mock("@/lib/store", () => ({
  getState: vi.fn(async () => state),
  mutateState: vi.fn(async () => {
    throw new Error("mutate must not be called");
  }),
}));
vi.mock("@/lib/zcash-rpc", () => ({
  sendShieldedPayment: vi.fn(),
  ZcashRpcError: class ZcashRpcError extends Error {
    code?: number;
    method?: string;
  },
}));

import { POST } from "@/app/api/audit/route";

const request = (body: object) =>
  new Request("http://localhost/api/audit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("audit request idempotency", () => {
  beforeEach(() => {
    state = createSeedState();
    const requestId = "11111111-2222-4333-8444-555555555555";
    const period = state.invoices[0].issueDate.slice(0, 7);
    const vaultId = state.invoices[0].vaultId;
    const manifest = { scope: { vaultId, period }, ledgerHead: state.ledgerHead, journals: [] };
    state.auditCapsules = [
      {
        id: "audit-capsule",
        requestId,
        requestFingerprint: recordCommitment({ kind: "audit-request", requestId, vaultId, period, anchor: false }),
        name: "Stored capsule",
        vaultId,
        period,
        scopes: ["journals"],
        manifestHash: recordCommitment(manifest),
        signature: "AA==",
        signatureAlgorithm: "Ed25519",
        signingKeyFingerprint: "a".repeat(64),
        ledgerHead: state.ledgerHead,
        entryCount: 0,
        createdAt: new Date().toISOString(),
        status: "local",
        manifest,
      },
    ];
  });

  it("returns the stored capsule for the same payload", async () => {
    const capsule = state.auditCapsules[0];
    const response = await POST(
      request({ requestId: capsule.requestId, vaultId: capsule.vaultId, period: capsule.period, anchor: false }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, idempotent: true, capsule: { id: capsule.id } });
  });

  it("returns 409 when the same requestId is used with a different period or anchor setting", async () => {
    const capsule = state.auditCapsules[0];
    const changedPeriod = await POST(
      request({ requestId: capsule.requestId, vaultId: capsule.vaultId, period: "2099-12", anchor: false }),
    );
    expect(changedPeriod.status).toBe(409);
    expect(await changedPeriod.json()).toMatchObject({ ok: false, rotateRequestId: true });
    const changedAnchor = await POST(
      request({ requestId: capsule.requestId, vaultId: capsule.vaultId, period: capsule.period, anchor: true }),
    );
    expect(changedAnchor.status).toBe(409);
    expect(await changedAnchor.json()).toMatchObject({ ok: false, rotateRequestId: true });
  });
});
