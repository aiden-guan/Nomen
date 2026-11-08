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
import { latestPack, listStaticAds, type PackAssets, type Render, type VisualState } from "./statics/pipeline";
import type { StaticPlan, StaticResearch } from "./statics/research";
import { PLACEMENTS } from "./statics/specs";
import type { Study } from "./statics/study";
import type { SearchAssets } from "./statics/validate";
import type { Concept as StaticConcept } from "./statics/writer";

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
    statics: staticsView(campaign.id),
    createdAt: campaign.created_at,
  };
}

/** Anthropic list prices per million tokens, for an estimate of what model calls cost (Naive bills its own rate). */
const LIST_PRICE: Record<string, [number, number]> = { "anthropic/claude-opus-5.5": [4, 20], "anthropic/claude-sonnet-5.5": [2, 10], "anthropic/claude-haiku-5.5": [0.1, 0.5] };

function staticsView(campaignId: string) {
  const pack = latestPack(campaignId);
  if (!pack) return null;
  const research = parse<StaticResearch | null>(pack.research_json, null);
  const study = parse<Study | null>(pack.study_json, null);
  const assets = parse<PackAssets | null>(pack.assets_json, null);
  const monid = (db().prepare("select coalesce(sum(cost_micro), 0) total from monid_runs where campaign_id = ? and phase = 'S'").get(campaignId) as { total: number }).total;
  const price = LIST_PRICE[study?.model ?? ""];
  const file = (path: string) => `/api/statics/${pack.id}/files/${path}`;
  return {
    id: pack.id,
    status: pack.status,
    stage: pack.stage,
    error: pack.error,
    createdAt: pack.created_at,
    plan: parse<StaticPlan | null>(pack.plan_json, null),
    research: research && {
      ads: research.ads.slice(0, 30),
      searchAds: research.search_ads,
      cases: research.cases,
      sources: research.sources,
      screenshot: assets?.screenshot ? file(assets.screenshot) : null,
    },
    study: study && { art: study.art, brandIdentity: study.brand_identity, patterns: study.patterns_md, studied: study.studied, notes: study.ads },
    search: parse<(SearchAssets & { problems?: string[]; short?: string[] }) | null>(pack.search_json, null),
    logos: ["logo-1x1.png", "logo-4x1.png"].filter((name) => existsSync(join(mediaDir(join("statics", pack.id)), "logos", name))).map((name) => file(`logos/${name}`)),
    ads: listStaticAds(pack.id)
      .filter((ad) => !ad.rejected)
      .map((ad) => {
        const concept = parse<StaticConcept | null>(ad.concept_json, null);
        const visual = parse<VisualState | null>(ad.visual_json, null);
        return {
          id: ad.id,
          idx: ad.idx,
          generation: ad.generation,
          status: ad.status,
          approved: Boolean(ad.approved),
          concept,
          visual: visual && { kind: visual.kind, error: visual.error ?? null },
          renders: parse<Render[]>(ad.renders_json, []).map((r) => {
            const spec = PLACEMENTS.find((p) => p.id === r.placement);
            return { ...r, url: file(`${ad.id}/${r.file}`), platform: spec?.platform ?? "", label: spec?.label ?? r.placement, textFree: Boolean(spec?.textFree) };
          }),
          qc: parse<{ score: number; pass: boolean; issues: string[] } | null>(ad.qc_json, null),
          error: ad.error,
        };
      }),
    spend: {
      monid: usd(monid),
      images: usd(pack.image_cost_micro),
      tokens: { input: pack.tokens_in, output: pack.tokens_out },
      modelEstimate: price ? Math.round(((pack.tokens_in * price[0] + pack.tokens_out * price[1]) / 1_000_000) * 100) / 100 : null,
    },
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
      frameUrl: existsSync(join(mediaDir(creative.id), `shot${shot.n}-frame.png`)) ? `/api/media/${creative.id}/shot${shot.n}-frame.png` : shot.frame_url,
      qc: shot.qc,
      error: shot.error,
    })),
  };
}

export type BrandView = NonNullable<ReturnType<typeof brandView>>;
export type CampaignView = NonNullable<BrandView["campaign"]>;
export type CreativeView = CampaignView["creatives"][number];
export type BrandListItem = ReturnType<typeof brandList>[number];
