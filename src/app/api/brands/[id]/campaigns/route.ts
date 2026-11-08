import { body, handle } from "@/lib/api";
import { type CampaignOptions, defaultOptions, getBrand, startCampaign } from "@/lib/pipeline";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

/** Starts a fresh campaign for the brand: new research, new strategy, new videos. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const brandId = (await params).id;
    if (!getBrand(brandId)) return Response.json({ error: "No such brand" }, { status: 404 });
    const overrides = await body<CampaignOptions>(request);
    const defaults = defaultOptions();
    const options: CampaignOptions = {
      concepts: clamp(overrides.concepts, 1, 8, defaults.concepts),
      shotsPerConcept: clamp(overrides.shotsPerConcept, 1, 3, defaults.shotsPerConcept),
      secondsPerShot: clamp(overrides.secondsPerShot, 4, 10, defaults.secondsPerShot),
      videoModel: typeof overrides.videoModel === "string" && overrides.videoModel ? overrides.videoModel : defaults.videoModel,
      learnStyle: typeof overrides.learnStyle === "boolean" ? overrides.learnStyle : defaults.learnStyle,
    };
    const campaignId = startCampaign(brandId, options);
    void tick();
    return Response.json({ campaignId }, { status: 201 });
  });
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
