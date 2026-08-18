import { noStoreJson } from "@/lib/http";
import { getZcashStatus } from "@/lib/zcash-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  return noStoreJson({ ok: true, node: await getZcashStatus(force) });
}
