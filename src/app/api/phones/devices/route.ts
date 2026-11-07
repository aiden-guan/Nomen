// OWNED BY THE PHONES TRACK.
// GET /api/phones/devices: the account's Mobilerun phones and which brand each is linked to.
// POST /api/phones/devices { brandId, idempotencyKey, country? }: provision an Android cloud phone (per-minute billing).
import { readJson, respond } from "@/lib/phones/respond";
import { listDevices, provisionDevice } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return respond(listDevices);
}

export function POST(request: Request) {
  return respond(async () => provisionDevice(await readJson(request)));
}
