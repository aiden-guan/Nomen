import { after } from "next/server";
import { safeEqual } from "@/app/gate/token";
import { serverSecret } from "@/lib/store";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

/**
 * The heartbeat a Convex cron sends every 10 s on serverless hosts (convex/crons.ts), signed with
 * the server secret. It answers at once and takes the next step of every campaign afterwards; the
 * store's lease keeps ticks from overlapping.
 */
export async function POST(request: Request) {
  const secret = serverSecret();
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || !safeEqual(given, secret)) return Response.json({ error: "Forbidden" }, { status: 403 });
  after(tick);
  return Response.json({ ok: true }, { status: 202 });
}
