import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ZcashRpcError } from "@/lib/zcash-rpc";

export class ApiConflictError extends Error {
  constructor(
    message: string,
    public readonly rotateRequestId = false,
    public readonly existingRecord?: { id: string; number: string },
  ) {
    super(message);
  }
}

export function apiError(error: unknown) {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { ok: false, error: "Check the information provided.", fields: error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  if (error instanceof ApiConflictError) {
    return NextResponse.json(
      { ok: false, error: error.message, rotateRequestId: error.rotateRequestId, existingRecord: error.existingRecord },
      { status: 409 },
    );
  }
  if (error instanceof ZcashRpcError) {
    const status = error.code === -32099 ? 409 : error.code === 401 ? 401 : 503;
    return NextResponse.json({ ok: false, error: error.message, rpcCode: error.code }, { status });
  }
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}

export function noStoreJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("cache-control", "no-store, max-age=0");
  return response;
}
