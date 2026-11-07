// OWNED BY THE PHONES TRACK. GET /api/phones?brandId=… : everything the phones panel shows for a brand.
import { respond } from "@/lib/phones/respond";
import { getStatus } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return respond(() => getStatus(new URL(request.url).searchParams.get("brandId")));
}
