import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import type { AppState } from "@/lib/types";

const DEFAULT_STATE_PATH = "zechledger-demo/ledger.json";

export interface VersionedDemoState {
  state: AppState;
  etag: string;
}

function statePath(): string {
  const configured = process.env.ZECHLEDGER_VERCEL_BLOB_STATE_PATH?.trim();
  return configured || DEFAULT_STATE_PATH;
}

function serialize(state: AppState): string {
  return `${JSON.stringify(state, null, 2)}
`;
}

async function readExisting(): Promise<VersionedDemoState | null> {
  const result = await get(statePath(), { access: "private", useCache: false });
  if (!result) return null;
  if (result.statusCode !== 200 || !result.stream) throw new Error("The Vercel Blob demo ledger could not be read.");
  const raw = await new Response(result.stream).text();
  const etag = result.blob.etag.replace(/^W\//, "");
  if (!etag) throw new Error("The Vercel Blob demo ledger does not include an ETag.");
  return { state: JSON.parse(raw) as AppState, etag };
}

export async function readOrCreateDemoState(createInitial: () => AppState): Promise<VersionedDemoState> {
  const existing = await readExisting();
  if (existing) return existing;
  const initial = createInitial();
  try {
    const uploaded = await put(statePath(), serialize(initial), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8",
      maximumSizeInBytes: 1_000_000,
    });
    return { state: initial, etag: uploaded.etag };
  } catch (error) {
    const raced = await readExisting();
    if (raced) return raced;
    throw error;
  }
}

export async function replaceDemoState(state: AppState, expectedEtag: string): Promise<string> {
  try {
    const uploaded = await put(statePath(), serialize(state), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      ifMatch: expectedEtag,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8",
      maximumSizeInBytes: 1_000_000,
    });
    return uploaded.etag;
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) throw error;
    throw new Error("The Vercel Blob demo ledger could not be written.", { cause: error });
  }
}

export { BlobPreconditionFailedError };
