import { type Casting, type CastingDeps, type ClientTaste, searchKeywords, stepCasting } from "./creative/casting";
import { logEvent, parse, save } from "./db";
import { ApiError } from "./http";
import type { CampaignRow } from "./pipeline";
import { creativeState, listCreatives } from "./pipeline";
import type { CreativeRow } from "./production";
import type { Video } from "./research";
import { getSetting } from "./settings";
import type { Concept, Strategy } from "./strategy";

// The production stage of a campaign in real-creator mode: every brief is cast instead of rendered
// (creative/casting.ts). A brief with an approved creator is "ready" for your review with its
// briefing and outreach draft; one the client turned down for every creator is "failed". When all
// are settled the campaign moves to review, exactly as rendered videos do.

type Clients = { naive: { message: CastingDeps["message"] } | null; monid: CastingDeps["monid"] };

/** The brand the client-taste agent stands in for, from the strategy and the product brief. */
export function clientTaste(strategy: Strategy, product: { audience?: string } | undefined): ClientTaste {
  return {
    name: strategy.brand.name,
    tone: strategy.brand.tone,
    audience: product?.audience || strategy.audience.map((a) => a.description).join(" / "),
    values: [...strategy.brand.value_props.slice(0, 2), ...strategy.brand.proof_points.slice(0, 1)],
    competitors: strategy.competitors.map((c) => c.name).slice(0, 5),
  };
}

export async function stepCastingStage(campaign: CampaignRow, clients: Clients): Promise<{ settled: boolean; ready: number; total: number }> {
  if (!clients.naive) throw new ApiError("naive", 503, "no_key", "Naive is not connected: casting needs its model");
  const strategy = parse<Strategy | null>(campaign.strategy_json, null);
  if (!strategy) throw new Error("The campaign has no strategy yet.");
  const product = creativeState(campaign)?.product;
  if (!product) throw new Error("The campaign has no product brief.");
  const research = parse<{ videos?: Video[]; domain?: string } | null>(campaign.research_json, null);
  const taste = clientTaste(strategy, product);
  const fee = `$${getSetting("creator_fee_usd") || "150"} flat for one video, with usage on the brand's own accounts`;
  const deps: CastingDeps = {
    message: (input) => clients.naive!.message(input),
    monid: clients.monid,
    log: (message, level = "info") => logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level, message }),
  };
  const all = (await listCreatives(campaign.id)).filter((c) => !c.rejected);
  await Promise.all(
    all
      .filter((c) => c.status === "queued" || c.status === "producing")
      .map(async (creative: CreativeRow) => {
        const concept = parse<(Concept & { casting?: Casting }) | null>(creative.concept_json, null);
        if (!concept) return save("creatives", creative.id, { status: "failed", error: "unreadable concept" });
        const lines = concept.script?.beats?.map((b) => b.line).filter(Boolean) ?? [];
        const casting = await stepCasting(
          deps,
          {
            concept: { title: concept.title, hook: concept.hook, angle: concept.brief?.angle, cta: concept.brief?.cta, lines, format: concept.format },
            reference: { url: concept.reference?.url ?? "", format: concept.reference?.format ?? concept.format },
            product,
            taste,
            research: research?.videos ?? [],
            brand: { name: strategy.brand.name, domain: research?.domain },
            keywords: searchKeywords({ category: strategy.brand.category, audience: product.audience, angle: concept.brief?.angle }),
            fee,
          },
          concept.casting ?? null,
        );
        const status = casting.status === "approved" ? "ready" : casting.status === "no_match" ? "failed" : "producing";
        await save("creatives", creative.id, {
          concept_json: JSON.stringify({ ...concept, casting }),
          status,
          ...(casting.status === "approved" && casting.outreach ? { caption: casting.outreach.message } : {}),
          ...(casting.status === "no_match" ? { error: `no creator approved: ${casting.reviews[casting.reviews.length - 1]?.reasons[0] ?? "none fit"}` } : {}),
          cost_micro: (creative.cost_micro ?? 0) + Math.max(0, casting.cost_micro - (concept.casting?.cost_micro ?? 0)),
        });
      }),
  );
  const now = (await listCreatives(campaign.id)).filter((c) => !c.rejected);
  const settled = now.every((c) => c.status === "ready" || c.status === "failed");
  return { settled, ready: now.filter((c) => c.status === "ready").length, total: now.length };
}
