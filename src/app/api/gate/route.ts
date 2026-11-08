import { NextResponse } from "next/server";
import { GATE_COOKIE, GATE_MAX_AGE, gateToken, safeEqual } from "@/app/gate/token";

export const runtime = "nodejs";

/** Checks the site password and, if it matches, remembers this browser for thirty days. */
export async function POST(request: Request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return NextResponse.json({ ok: true });
  let given = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    given = typeof body.password === "string" ? body.password : "";
  } catch {
    // An empty or malformed body is just a wrong password.
  }
  const expected = await gateToken(password);
  if (!safeEqual(await gateToken(given), expected)) {
    // A short pause makes guessing slow without bothering anyone who mistyped.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return NextResponse.json({ error: "That's not the password." }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(GATE_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GATE_MAX_AGE,
  });
  return response;
}
