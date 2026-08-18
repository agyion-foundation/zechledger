import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const attempts = new Map<string, { count: number; resetAt: number }>();
const sessionValue = (token: string, expires: number) =>
  `${expires}.${createHmac("sha256", token).update(`zechledger-session:${expires}`).digest("hex")}`;

export async function POST(request: Request) {
  const configured = process.env.ZECHLEDGER_ADMIN_TOKEN;
  if (!configured || configured.length < 16 || /replace|changeme|change-me/i.test(configured)) {
    return NextResponse.json(
      { ok: false, error: "ZECHLEDGER_ADMIN_TOKEN must be a random, non-placeholder value of at least 16 characters." },
      { status: 503 },
    );
  }
  const now = Date.now();
  for (const [key, value] of attempts) if (value.resetAt <= now) attempts.delete(key);
  if (attempts.size > 1_000) attempts.clear();
  const ip =
    process.env.ZECHLEDGER_TRUST_PROXY === "true"
      ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "proxy-unknown"
      : "global";
  const current = attempts.get(ip);
  if (current && current.resetAt > now && current.count >= 5) {
    return NextResponse.json({ ok: false, error: "Too many attempts. Wait one minute." }, { status: 429 });
  }
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const supplied = Buffer.from(body.token ?? "");
  const expected = Buffer.from(configured);
  const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected);
  if (!valid) {
    attempts.set(ip, {
      count: current?.resetAt && current.resetAt > now ? current.count + 1 : 1,
      resetAt: now + 60_000,
    });
    return NextResponse.json({ ok: false, error: "Invalid administrator key." }, { status: 401 });
  }
  attempts.delete(ip);
  const response = NextResponse.json({ ok: true });
  const expires = Math.floor(Date.now() / 1000) + 8 * 60 * 60;
  response.cookies.set("zechledger_session", sessionValue(configured, expires), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.ZECHLEDGER_COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}
