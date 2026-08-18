import type { StateResponse } from "@/lib/types";

export interface ViewActions {
  refresh: () => Promise<boolean>;
  notify: (message: string, tone?: "success" | "error" | "info") => void;
  busy: string | null;
  setBusy: (value: string | null) => void;
}

export interface ViewProps extends ViewActions {
  data: StateResponse;
}
