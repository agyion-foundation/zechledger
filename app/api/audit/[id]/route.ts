import { apiError } from "@/lib/http";
import { getState } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const state = await getState();
    const capsule = state.auditCapsules.find((item) => item.id === id);
    if (!capsule) return Response.json({ ok: false, error: "Audit capsule not found." }, { status: 404 });
    const payload = {
      capsule: { ...capsule, manifest: undefined },
      manifest: capsule.manifest,
      verification: {
        hashAlgorithm: "SHA-256",
        signatureAlgorithm: capsule.signatureAlgorithm,
        expectedManifestHash: capsule.manifestHash,
        signature: capsule.signature,
        signingKeyFingerprint: capsule.signingKeyFingerprint,
        ledgerHead: capsule.ledgerHead,
        note: "The manifest is verified with the Ed25519 public key obtained through a separate trusted channel. The ledgerHead field provides context; it is not a Merkle inclusion proof of scope.",
      },
    };
    return new Response(
      `${JSON.stringify(payload, null, 2)}
`,
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="zechledger-audit-${capsule.period}.json"`,
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return apiError(error);
  }
}
