import { apiError, noStoreJson } from "@/lib/http";
import { getState, hardResetState } from "@/lib/store";

export const runtime = "nodejs";

export async function POST() {
  try {
    const current = await getState();
    if (current.mode === "live")
      return noStoreJson({ ok: false, error: "Demo reset is disabled in live wallet mode." }, { status: 403 });
    const state = await hardResetState();
    return noStoreJson({ ok: true, revision: state.revision });
  } catch (error) {
    return apiError(error);
  }
}
