import { computeMetrics } from "@/lib/accounting";
import { noStoreJson } from "@/lib/http";
import { getState } from "@/lib/store";
import { getZcashStatus } from "@/lib/zcash-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [state, node] = await Promise.all([getState(), getZcashStatus()]);
  const metrics = computeMetrics(state);
  return noStoreJson({ state, node, metrics });
}
