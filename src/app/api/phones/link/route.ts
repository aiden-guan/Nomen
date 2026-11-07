// OWNED BY THE PHONES TRACK.
// PUT /api/phones/link { brandId, deviceId, official: true, topics, vpnCountry?, accounts: [{ platform, credentialName? }] }
// DELETE /api/phones/link?brandId=… : unlink the brand's phone and stop its sessions.
import { readJson, respond } from "@/lib/phones/respond";
import { linkAccounts, unlink } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function PUT(request: Request) {
  return respond(async () => linkAccounts(await readJson(request)));
}

export function DELETE(request: Request) {
  return respond(() => unlink(new URL(request.url).searchParams.get("brandId")));
}
