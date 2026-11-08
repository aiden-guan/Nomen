import { type NextRequest, NextResponse } from "next/server";
import { GATE_COOKIE, gateToken, safeEqual } from "./app/gate/token";
import { liveEnabled } from "./lib/live";

// Two guards for hosted deployments, both off in local development.
//
// SITE_PASSWORD puts a password in front of the whole site. Pages without the cookie go to /gate;
// API calls get a 401, and /api/status a "locked" status, because the app header renders it on
// every page and expects that shape.
//
// Where real campaigns can't run (Vercel before Convex is connected, or NOMEN_DEMO_ONLY=1; see
// src/lib/live.ts), `/` plays the demo and the API is switched off here, so nothing on the server
// opens a database or calls a provider. Once Convex is connected, `/` is live and /demo the demo.

type Status = { naive: { ok: boolean; error?: string }; monid: { ok: boolean; error?: string }; mobilerun: { configured: boolean }; ffmpeg: boolean };

const statusSaying = (error: string): Status => ({ naive: { ok: false, error }, monid: { ok: false, error }, mobilerun: { configured: false }, ffmpeg: false });

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isGate = pathname === "/gate" || pathname === "/api/gate";
  // The worker's heartbeat comes from Convex, not a browser: the route checks its own secret.
  const isTick = pathname === "/api/worker/tick";

  const password = process.env.SITE_PASSWORD;
  if (password && !isGate && !isTick) {
    const cookie = request.cookies.get(GATE_COOKIE)?.value;
    if (!cookie || !safeEqual(cookie, await gateToken(password))) {
      if (pathname === "/api/status") return NextResponse.json(statusSaying("locked"), { status: 401 });
      if (pathname.startsWith("/api/")) return NextResponse.json({ error: "This site needs its password." }, { status: 401 });
      const gate = request.nextUrl.clone();
      gate.pathname = "/gate";
      gate.search = pathname === "/" && !search ? "" : `?next=${encodeURIComponent(pathname + search)}`;
      return NextResponse.redirect(gate);
    }
  }

  if (!liveEnabled() && pathname.startsWith("/api/") && !isGate) {
    if (pathname === "/api/status") return NextResponse.json(statusSaying("demo build"));
    return NextResponse.json({ error: "This is a demo build: campaigns are simulated, so the API is off." }, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  // Everything except build assets (scripts, workers, fonts, images) and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
