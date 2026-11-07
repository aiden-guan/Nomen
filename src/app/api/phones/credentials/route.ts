// OWNED BY THE PHONES TRACK. GET /api/phones/credentials: saved login names per platform (never the values).
import { respond } from "@/lib/phones/respond";
import { credentialNames } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return respond(credentialNames);
}
