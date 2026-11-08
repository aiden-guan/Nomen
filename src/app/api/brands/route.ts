import { body, handle } from "@/lib/api";
import { db } from "@/lib/db";
import { createBrand, defaultOptions, startCampaign } from "@/lib/pipeline";
import { brandList } from "@/lib/views";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

export async function GET() {
  return handle(() => Response.json({ brands: brandList() }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const { url, staticOnly } = await body<{ url: string; staticOnly: boolean }>(request);
    const brandId = createBrand(String(url ?? ""));
    const running = db().prepare("select id from campaigns where brand_id = ? and status = 'running'").get(brandId) as { id: string } | undefined;
    const campaignId = running?.id ?? startCampaign(brandId, staticOnly ? { ...defaultOptions(), concepts: 0, statics: true } : defaultOptions());
    void tick();
    return Response.json({ brandId, campaignId }, { status: 201 });
  });
}
