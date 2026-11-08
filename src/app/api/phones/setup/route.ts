// OWNED BY THE PHONES TRACK. POST /api/phones/setup { brandId }: set the brand's phone up for posting
// (install TikTok, let it see the phone's videos). Signing in stays with a person.
import { readJson, respond } from "@/lib/phones/respond";
import { setUpForPosting } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return respond(async () => setUpForPosting(await readJson(request)));
}
