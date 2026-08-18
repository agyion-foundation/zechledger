import { getAuditPublicKey } from "@/lib/audit-signing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const key = await getAuditPublicKey();
  return new Response(key.pem, {
    headers: {
      "content-type": "application/x-pem-file",
      "content-disposition": 'attachment; filename="zechledger-audit-public.pem"',
      "x-zechledger-key-fingerprint": key.fingerprint,
      "cache-control": "no-store",
    },
  });
}
