import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, store } from "./db";
import { type BrandRow, type CampaignOptions, type CampaignRow, defaultOptions } from "./pipeline";
import { mediaRoot } from "./store/sqlite";
import type { CreativeRow, ShotState } from "./production";
import type { PostRow } from "./publish";
import type { Continuity } from "./qc";
import type { ResearchPack, ResearchPlan } from "./research";
import type { Concept, Strategy } from "./strategy";

// What the UI reads. Money leaves the server as dollars; provider ids stay on the server. Each view
// is one read of the store (a snapshot), so the camp's polling costs one round trip on Convex.

export const VEO_USD_PER_SECOND = 0.4; // measured on Naive: an 8 s google/veo-3.1 render cost $3.20

export const usd = (micro: number) => Math.round(micro) / 1_000_000;

export function estimateUsd(options: CampaignOptions) {
  const seconds = options.concepts * options.shotsPerConcept * options.secondsPerShot;
  return options.videoModel === "google/veo-3.1" ? Math.round(seconds * VEO_USD_PER_SECOND * 100) / 100 : null;
}

const STAGES = ["research", "style", "strategy", "production", "review", "live"] as const;

/** Whether a creative's file is stored: recorded on the row, or (older local rows) on disk. */
function stored(creative: CreativeRow, name: string, recorded: string | null | undefined) {
  if (recorded) return true;
  return store().kind === "sqlite" && existsSync(join(mediaRoot(), creative.id, name));
}

export async function brandList() {
  const items = await store().listSnapshot();
  return items.map((item) => {
    const brand = item.brand as unknown as BrandRow;
    const campaign = item.campaign as unknown as CampaignRow | null;
    const creatives = (item.creatives as unknown as CreativeRow[]).filter((c) => !c.rejected);
    const profile = parse<ResearchPack["brand"] | null>(brand.profile_json, null);
    return {
      id: brand.id,
      name: brand.name,
      domain: brand.domain,
      logo: profile?.logo ?? null,
      colors: profile?.colors ?? [],
      campaign: campaign && { id: campaign.id, status: campaign.status, stage: campaign.stage, error: campaign.error },
      ready: creatives.filter((c) => c.status === "ready").length,
      total: creatives.length,
      poster: creatives.find((c) => c.status === "ready" && stored(c, "final.mp4", c.final_key))?.id ?? null,
    };
  });
}

export async function brandView(brandId: string) {
  const snapshot = await store().brandSnapshot(brandId);
  if (!snapshot) return null;
  const brand = snapshot.brand as unknown as BrandRow;
  const campaigns = snapshot.campaigns as unknown as CampaignRow[];
  const profile = parse<ResearchPack["brand"] | null>(brand.profile_json, null);
  return {
    brand: { id: brand.id, name: brand.name, domain: brand.domain, url: brand.url, profile, connected: Boolean(brand.social_activated) },
    campaign: campaigns[0] ? campaignView(campaigns[0], snapshot.runs as unknown as RunRow[], snapshot.creatives as unknown as CreativeRow[], snapshot.posts as unknown as PostRow[]) : null,
    campaigns: campaigns.map((c) => ({ id: c.id, status: c.status, stage: c.stage, created_at: c.created_at })),
    events: snapshot.events,
  };
}

type RunRow = { key: string; phase: string; provider: string; endpoint: string; status: string; error: string | null; cost_micro: number };

function campaignView(campaign: CampaignRow, runs: RunRow[], creativeRows: CreativeRow[], posts: PostRow[]) {
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  const research = parse<ResearchPack | null>(campaign.research_json, null);
  const strategy = parse<Strategy | null>(campaign.strategy_json, null);
  const style = parse<{ slug: string | null; version: number | null; skill_md: string; samples: string[] } | null>(campaign.style_json, null);
  const creatives = creativeRows.filter((c) => !c.rejected).map(creativeView);
  return {
    id: campaign.id,
    status: campaign.status,
    stage: campaign.stage,
    stageIndex: STAGES.indexOf(campaign.stage),
    error: campaign.error,
    naiveOut: Boolean(campaign.naive_out),
    options,
    estimateUsd: estimateUsd(options),
    plan: parse<ResearchPlan | null>(campaign.plan_json, null),
    research,
    style: style && { slug: style.slug, version: style.version, skill_md: style.skill_md, samples: style.samples },
    strategy,
    runs: runs.map((run) => ({ key: run.key, phase: run.phase, provider: run.provider, endpoint: run.endpoint, status: run.status, error: run.error, cost_micro: run.cost_micro, cost: usd(run.cost_micro) })),
    creatives,
    posts: posts.map((post) => ({
      id: post.id,
      creativeId: post.creative_id,
      platforms: parse<string[]>(post.platforms_json, []),
      scheduledAt: post.scheduled_at,
      status: post.status,
      error: post.error,
      analytics: parse<Record<string, unknown> | null>(post.analytics_json, null),
    })),
    spend: { naive: usd(campaign.naive_spend_micro), monid: usd(campaign.monid_spend_micro), style: usd(campaign.style_spend_micro), strategy: usd(campaign.strategy_spend_micro) },
    createdAt: campaign.created_at,
  };
}

function creativeView(creative: CreativeRow) {
  const concept = parse<Concept | null>(creative.concept_json, null);
  const shots = parse<ShotState[]>(creative.shots_json, []);
  const hasFinal = stored(creative, "final.mp4", creative.final_key);
  return {
    id: creative.id,
    idx: creative.idx,
    generation: creative.generation,
    status: creative.status,
    concept,
    caption: creative.caption,
    platforms: parse<string[]>(creative.platforms_json, []),
    approved: Boolean(creative.approved),
    videoUrl: hasFinal ? `/api/media/${creative.id}/final.mp4` : null,
    posterUrl: creative.poster_url,
    qcScore: creative.qc_score,
    continuity: parse<Continuity | null>(creative.continuity_json, null),
    cost: usd(creative.cost_micro),
    error: creative.error,
    shots: shots.map((shot) => ({
      n: shot.n,
      status: shot.status,
      provider: shot.provider,
      renders: shot.renders,
      frameUrl: stored(creative, `shot${shot.n}-frame.png`, shot.frame_key) ? `/api/media/${creative.id}/shot${shot.n}-frame.png` : shot.frame_url,
      qc: shot.qc,
      error: shot.error,
    })),
  };
}

export type BrandView = NonNullable<Awaited<ReturnType<typeof brandView>>>;
export type CampaignView = NonNullable<BrandView["campaign"]>;
export type CreativeView = CampaignView["creatives"][number];
export type BrandListItem = Awaited<ReturnType<typeof brandList>>[number];
