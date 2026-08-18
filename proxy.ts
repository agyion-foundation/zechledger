import { NextRequest, NextResponse } from "next/server";

const publicPaths = new Set(["/api/health", "/api/auth/login"]);

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

async function validCookie(value: string | undefined, token: string): Promise<boolean> {
  if (!value) return false;
  const [expiryText, suppliedSignature] = value.split(".");
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000) || !suppliedSignature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`zechledger-session:${expiry}`));
  const expected = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return safeEqual(suppliedSignature, expected);
}

function json(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

function isLoopbackRequest(request: NextRequest): boolean {
  const hostname = (request.headers.get("host") ?? "")
    .split(":")[0]
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function unsafeDemoAllowed(request: NextRequest): boolean {
  return (
    process.env.ZECHLEDGER_UNSAFE_DEMO_NO_AUTH === "true" &&
    process.env.NODE_ENV !== "production" &&
    !process.env.ZALLET_RPC_URL &&
    !process.env.ZCASH_RPC_URL &&
    process.env.ZCASH_ALLOW_SEND !== "true" &&
    isLoopbackRequest(request)
  );
}

function isSameOrigin(request: NextRequest, origin: string): boolean {
  try {
    const originUrl = new URL(origin);
    const host = request.headers.get("host");
    const protocol =
      process.env.ZECHLEDGER_TRUST_PROXY === "true"
        ? `${request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol.replace(":", "")}:`
        : request.nextUrl.protocol;
    return (
      origin === request.nextUrl.origin || Boolean(host && originUrl.host === host && originUrl.protocol === protocol)
    );
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  if (publicPaths.has(request.nextUrl.pathname)) return NextResponse.next();
  const token = process.env.ZECHLEDGER_ADMIN_TOKEN;
  if (!token) {
    if (unsafeDemoAllowed(request)) {
      const origin = request.headers.get("origin");
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && origin && !isSameOrigin(request, origin))
        return json("Origin/CSRF check failed.", 403);
      return NextResponse.next();
    }
    return json(
      "ZECHLEDGER_ADMIN_TOKEN is required. The unsafe opt-out may be used only in a non-production, loopback-only demo with no wallet and sending disabled.",
      503,
    );
  }
  if (token.length < 16 || /replace|changeme|change-me/i.test(token))
    return json("ZECHLEDGER_ADMIN_TOKEN must be a random, non-placeholder value of at least 16 characters.", 503);

  const cookieValid = await validCookie(request.cookies.get("zechledger_session")?.value, token);
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const bearerValid = bearer ? safeEqual(await sha256(bearer), await sha256(token)) : false;
  if (!cookieValid && !bearerValid) return json("Authentication required.", 401);

  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && !isSameOrigin(request, origin)) return json("Origin/CSRF check failed.", 403);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
