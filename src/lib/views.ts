import { existsSync } from "node:fs";
import { join } from "node:path";
import { db, parse } from "./db";
import { mediaDir } from "./media";
import { type BrandRow, type CampaignOptions, type CampaignRow, defaultOptions, listCreatives } from "./pipeline";
import type { CreativeRow, ShotState } from "./production";
import type { PostRow } from "./publish";
import type { Continuity } from "./qc";
import type { ResearchPack, ResearchPlan } from "./research";
import type { Concept, Strategy } from "./strategy";

// What the UI reads. Money leaves the server as dollars; provider ids stay on the server.

export const VEO_USD_PER_SECOND = 0.4; // measured on Naive: an 8 s google/veo-3.1 render cost $3.20

export const usd = (micro: number) => Math.round(micro) / 1_000_000;

export function estimateUsd(options: CampaignOptions) {
  const seconds = options.concepts * options.shotsPerConcept * options.secondsPerShot;
  return options.videoModel === "google/veo-3.1" ? Math.round(seconds * VEO_USD_PER_SECOND * 100) / 100 : null;
}

const STAGES = ["research", "style", "strategy", "production", "review", "live"] as const;

export function brandList() {
  const brands = db().prepare("select * from brands order by updated_at desc").all() as BrandRow[];
  return brands.map((brand) => {
    const campaign = latestCampaign(brand.id);
    const creatives = campaign ? listCreatives(campaign.id).filter((c) => !c.rejected) : [];
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
      poster: creatives.find((c) => c.status === "ready" && existsSync(join(mediaDir(c.id), "final.mp4")))?.id ?? null,
    };
  });
}

function latestCampaign(brandId: string) {
  return db().prepare("select * from campaigns where brand_id = ? order by created_at desc limit 1").get(brandId) as CampaignRow | undefined;
}

export function brandView(brandId: string) {
  const brand = db().prepare("select * from brands where id = ?").get(brandId) as BrandRow | undefined;
  if (!brand) return null;
  const campaign = latestCampaign(brandId);
  const profile = parse<ResearchPack["brand"] | null>(brand.profile_json, null);
  const campaigns = (db().prepare("select id, status, stage, created_at from campaigns where brand_id = ? order by created_at desc").all(brandId) as Array<Pick<CampaignRow, "id" | "status" | "stage" | "created_at">>).map((c) => ({ ...c }));
  const events = db().prepare("select ts, level, message from events where brand_id = ? order by id desc limit 60").all(brandId) as Array<{ ts: string; level: string; message: string }>;
  return {
    brand: { id: brand.id, name: brand.name, domain: brand.domain, url: brand.url, profile, connected: Boolean(brand.social_activated) },
    campaign: campaign ? campaignView(campaign) : null,
    campaigns,
    events,
  };
}

function campaignView(campaign: CampaignRow) {
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  const research = parse<ResearchPack | null>(campaign.research_json, null);
  const strategy = parse<Strategy | null>(campaign.strategy_json, null);
  const style = parse<{ slug: string | null; version: number | null; skill_md: string; samples: string[] } | null>(campaign.style_json, null);
  const runs = db().prepare("select key, phase, provider, endpoint, status, error, cost_micro from monid_runs where campaign_id = ? order by created_at").all(campaign.id) as Array<{
    key: string;
    phase: string;
    provider: string;
    endpoint: string;
    status: string;
    error: string | null;
    cost_micro: number;
  }>;
  const creatives = listCreatives(campaign.id).filter((c) => !c.rejected).map(creativeView);
  const posts = db()
    .prepare("select p.* from posts p join creatives c on c.id = p.creative_id where c.campaign_id = ? order by p.created_at")
    .all(campaign.id) as PostRow[];
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
    runs: runs.map((run) => ({ ...run, cost: usd(run.cost_micro) })),
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
  const hasFinal = existsSync(join(mediaDir(creative.id), "final.mp4"));
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
      frameUrl: shot.frame_url,
      qc: shot.qc,
      error: shot.error,
    })),
  };
}

export type BrandView = NonNullable<ReturnType<typeof brandView>>;
export type CampaignView = NonNullable<BrandView["campaign"]>;
export type CreativeView = CampaignView["creatives"][number];
export type BrandListItem = ReturnType<typeof brandList>[number];
