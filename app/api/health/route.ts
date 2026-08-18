import { getState } from "@/lib/store";
import { unsafeDemoEnvironmentAllowed, validAdminTokenConfigured } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (!validAdminTokenConfigured() && !(unsafeDemoEnvironmentAllowed() && loopback)) {
      return Response.json(
        { ok: false, service: "zechledger", error: "ZECHLEDGER_ADMIN_TOKEN is not configured" },
        { status: 503 },
      );
    }
    const state = await getState();
    return Response.json({ ok: true, service: "zechledger", schema: state.schemaVersion, revision: state.revision });
  } catch {
    return Response.json({ ok: false, service: "zechledger" }, { status: 503 });
  }
}
