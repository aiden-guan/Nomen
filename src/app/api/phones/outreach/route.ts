// OWNED BY THE PHONES TRACK. A brief's outreach DM, sent from the brand's own account on its phone.
// GET ?brandId=&creativeId=: its latest session. POST { brandId, creativeId }: send it (approved briefs only).
import { readJson, respond } from "@/lib/phones/respond";
import { outreachStatus, sendOutreach } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url);
  return respond(async () => outreachStatus({ brandId: url.searchParams.get("brandId"), creativeId: url.searchParams.get("creativeId") }));
}

export function POST(request: Request) {
  return respond(async () => sendOutreach(await readJson(request)));
}
