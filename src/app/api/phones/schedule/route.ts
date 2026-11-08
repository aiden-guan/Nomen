// OWNED BY THE PHONES TRACK. PUT /api/phones/schedule { brandId, enabled, days }: the daily warm-up schedule.
import { readJson, respond } from "@/lib/phones/respond";
import { setSchedule } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(request: Request) {
  return respond(async () => setSchedule(await readJson(request)));
}
