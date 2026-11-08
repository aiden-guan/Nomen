import { after } from "next/server";
import { body, handle } from "@/lib/api";
import { store } from "@/lib/db";
import { createBrand, defaultOptions, startCampaign } from "@/lib/pipeline";
import { brandList } from "@/lib/views";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

export async function GET() {
  return handle(async () => Response.json({ brands: await brandList() }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const { url, staticOnly } = await body<{ url: string; staticOnly: boolean }>(request);
    if (staticOnly && store().kind !== "sqlite") return Response.json({ error: "Static ads aren't available on this deployment yet: they still keep their data on the local disk." }, { status: 400 });
    const brandId = await createBrand(String(url ?? ""));
    const [running] = await store().find<{ id: string }>("campaigns", { brand_id: brandId, status: "running" }, { limit: 1 });
    const campaignId = running?.id ?? (await startCampaign(brandId, staticOnly ? { ...defaultOptions(), concepts: 0, statics: true } : defaultOptions()));
    after(tick);
    return Response.json({ brandId, campaignId }, { status: 201 });
  });
}
