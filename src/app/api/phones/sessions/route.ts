// OWNED BY THE PHONES TRACK. POST /api/phones/sessions { brandId, platform? }: run a warm-up now.
import { readJson, respond } from "@/lib/phones/respond";
import { runNow } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return respond(async () => runNow(await readJson(request)));
}
