import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, store } from "./db";
import { MIN_RELEVANCE } from "./creative/relevance";
import type { FunnelRole, ReferenceBreakdown, ReferenceCandidate } from "./creative/types";
import { type BrandRow, type CampaignOptions, type CampaignRow, type CreativeState, creativeState, defaultOptions, originOf } from "./pipeline";
import { mediaRoot } from "./store/sqlite";
import type { CreativeRow, ShotState } from "./production";
import type { PostRow } from "./publish";
import type { Continuity } from "./qc";
import type { ResearchPack, ResearchPlan, Video } from "./research";
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
  const state = creativeState(campaign);
  const videos = new Map((research?.videos ?? []).map((video) => [video.url, video]));
  const creatives = creativeRows.filter((c) => !c.rejected).map((row) => creativeView(row, videos));
  // Which of our videos remake which reference: the videos once they exist, the director's briefs before.
  const uses: ReferenceUse[] = creatives.length
    ? creatives.map((c) => ({ id: c.concept?.reference?.id ?? c.concept?.brief?.reference_id ?? null, url: c.concept?.reference?.url ?? null, title: c.concept?.title ?? `Video ${c.idx + 1}`, creativeId: c.id }))
    : (strategy?.campaign.briefs ?? []).map((brief) => ({ id: brief.reference_id || null, url: null, title: brief.title, creativeId: null }));
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
    /** The reference study, step by step (the "style" stage), for a live status line. */
    study: studyView(state),
    /** The viral videos the agents studied, are studying, or set aside, with their numbers. */
    references: referencesView(state, videos, uses),
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

function creativeView(creative: CreativeRow, videos: Map<string, Video> = new Map()) {
  const concept = parse<Concept | null>(creative.concept_json, null);
  const shots = parse<ShotState[]>(creative.shots_json, []);
  const hasFinal = stored(creative, "final.mp4", creative.final_key);
  const ref = concept?.reference;
  const video = ref ? videos.get(ref.url) : undefined;
  return {
    id: creative.id,
    idx: creative.idx,
    generation: creative.generation,
    status: creative.status,
    concept,
    /** The viral video this one remakes, with its numbers ("remake of @creator, 1.2M views"). */
    reference: ref?.url
      ? { id: ref.id, url: ref.url, author: ref.author, platform: video?.platform ?? null, views: ref.views, followers: ref.followers, outlier: ref.outlier, thumbnail: video?.thumbnail ?? null, format: ref.format, paidAd: Boolean(video?.ad) }
      : null,
    /** Its job in the campaign and what it is judged on, from the director's brief (research steering). */
    role: concept?.brief?.role ?? null,
    metric: concept?.brief?.metric ?? null,
    /** The script room's result: length and the critic's last score. */
    script: concept?.script ? { seconds: concept.script.total_seconds, beats: concept.script.beats.length, critic: concept.script.review?.score ?? null, notes: concept.script.review?.notes ?? [] } : null,
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

// ---------- the reference study ----------

/** studied: broken down beat by beat · studying: being broken down now · unreadable: the breakdown failed · shortlisted / dropped: by the relevance screen. */
export type ReferenceStatus = "studied" | "studying" | "unreadable" | "shortlisted" | "dropped";

/** A viral video the agents considered as a model, with its numbers and which of our videos remake it. */
export type ReferenceView = {
  url: string;
  status: ReferenceStatus;
  platform: string;
  author: string;
  thumbnail: string | null;
  caption: string;
  views: number;
  followers: number | null;
  /** Views per follower: how far it outran its account. */
  outlier: number | null;
  likes: number | null;
  saves: number | null;
  shares: number | null;
  comments: number | null;
  /** Seconds. */
  duration: number | null;
  /** competitor, category, adjacent, benchmark or ad: the lane it was found in. */
  lane: ReferenceCandidate["origin"] | null;
  /** The ranking's reason: "41x the account's followers, 9% engagement, 23 s". */
  why: string | null;
  /** The relevance screen's verdict (0-10) and reason, when it ran. */
  relevance: number | null;
  relevanceReason: string | null;
  /** From the breakdown, once there is one. */
  id: string | null;
  format: string | null;
  hook: { line: string; onScreen: string; mechanic: string } | null;
  fit: { score: number; reason: string } | null;
  whyItWorks: string | null;
  beats: number;
  error: string | null;
  /**
   * Research steering (docs/research-steering.md): reach or convert, the 0-10 conversion evidence and
   * the named signals behind it ("ran 94 days"). From the breakdown, else the candidate's score;
   * null on studies from before it.
   */
  role: FunnelRole | null;
  conversion: number | null;
  signals: string[];
  /** A paid ad from an ad library: libraries publish no views, so `views` is 0 and means unknown. */
  paidAd: boolean;
  /** Our videos that remake it (or the director's briefs, before the videos exist). */
  remadeBy: Array<{ title: string; creativeId: string | null }>;
};

type ReferenceUse = { id: string | null; url: string | null; title: string; creativeId: string | null };

const MAX_SET_ASIDE = 12;

export function referencesView(state: CreativeState | null, videos: Map<string, Video>, uses: ReferenceUse[] = []): ReferenceView[] {
  if (!state) return [];
  const candidates = new Map((state.candidates ?? []).map((c) => [c.url, c]));
  const screened = new Map((state.screened ?? []).map((s) => [s.url, s]));
  const failures = new Map((state.failures ?? []).map((f) => [f.url, f.error]));
  const out: ReferenceView[] = [];
  const seen = new Set<string>();

  const add = (url: string, status: ReferenceStatus, breakdown?: ReferenceBreakdown) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    const video = videos.get(url);
    const candidate = candidates.get(url);
    const verdict = screened.get(url);
    const views = breakdown?.views ?? video?.views ?? candidate?.views ?? 0;
    const followers = breakdown?.followers ?? video?.followers ?? candidate?.followers ?? null;
    const lane = breakdown?.origin ?? candidate?.origin ?? (video ? (video.ad ? "ad" : originOf(video)) : null);
    const paidAd = lane === "ad";
    const outlier = paidAd ? null : (breakdown?.outlier ?? candidate?.score.outlier ?? (followers ? Math.round((views / Math.max(followers, 1000)) * 10) / 10 : null));
    out.push({
      url,
      status,
      platform: breakdown?.platform ?? video?.platform ?? candidate?.platform ?? "tiktok",
      author: breakdown?.author ?? video?.author ?? candidate?.author ?? "",
      thumbnail: video?.thumbnail ?? null,
      caption: (video?.caption ?? "").slice(0, 240),
      views,
      followers,
      outlier,
      likes: video?.likes ?? null,
      saves: video?.saves ?? null,
      shares: video?.shares ?? null,
      comments: video?.comments ?? null,
      duration: breakdown?.duration ?? video?.duration ?? null,
      lane,
      why: candidate?.score.why ?? null,
      relevance: verdict?.relevance ?? candidate?.relevance ?? null,
      relevanceReason: verdict?.reason ?? candidate?.relevance_reason ?? null,
      id: breakdown?.id ?? null,
      format: breakdown?.format ?? null,
      hook: breakdown ? { line: breakdown.hook.line, onScreen: breakdown.hook.on_screen_text, mechanic: breakdown.hook.mechanic } : null,
      fit: breakdown?.fit ?? null,
      whyItWorks: breakdown?.why_it_works ?? null,
      beats: breakdown?.beats.length ?? 0,
      error: failures.get(url) ?? null,
      role: breakdown?.role ?? candidate?.score.role ?? null,
      conversion: breakdown?.conversion?.score ?? candidate?.score.conversion ?? null,
      signals: breakdown?.conversion?.signals ?? candidate?.score.signals ?? [],
      paidAd,
      remadeBy: uses.filter((use) => (breakdown && use.id === breakdown.id) || use.url === url).map(({ title, creativeId }) => ({ title, creativeId })),
    });
  };

  for (const breakdown of state.breakdowns ?? []) add(breakdown.url, "studied", breakdown);
  // Picked and not studied: still being broken down (or retried), or its breakdown failed.
  for (const url of state.picked ?? []) add(url, state.retry?.includes(url) || !state.breakdowns ? "studying" : "unreadable");
  for (const url of failures.keys()) add(url, "unreadable");
  // Then the ones set aside: the shortlist the breakdowns were picked from, and what the screen dropped.
  let setAside = 0;
  for (const candidate of state.candidates ?? []) {
    if (setAside >= MAX_SET_ASIDE) break;
    const relevance = screened.get(candidate.url)?.relevance ?? candidate.relevance;
    if (seen.has(candidate.url)) continue;
    add(candidate.url, relevance !== undefined && relevance < MIN_RELEVANCE ? "dropped" : "shortlisted");
    setAside++;
  }
  for (const verdict of state.screened ?? []) {
    if (setAside >= MAX_SET_ASIDE) break;
    if (verdict.relevance >= MIN_RELEVANCE || seen.has(verdict.url) || !videos.has(verdict.url)) continue;
    add(verdict.url, "dropped");
    setAside++;
  }
  return out;
}

/** Where the reference study is, for the status line: the product, the screenshots, the screen, the breakdowns. */
export function studyView(state: CreativeState | null) {
  if (!state || (!state.product && !state.candidates && !state.breakdowns)) return null;
  return {
    product: state.product ? { name: state.product.name, kind: state.product.kind, oneLiner: state.product.one_liner, visuals: state.product.visuals.length, fromKit: state.product.visuals.filter((v) => v.source.startsWith("brandkit:")).length } : null,
    captured: Boolean(state.captured),
    screened: state.screened?.length ?? 0,
    kept: (state.screened ?? []).filter((s) => s.relevance >= MIN_RELEVANCE).length,
    picked: state.picked?.length ?? 0,
    studied: state.breakdowns?.length ?? 0,
    failed: state.failures?.length ?? 0,
    done: Boolean(state.breakdowns) && !state.retry?.length,
  };
}

export type BrandView = NonNullable<Awaited<ReturnType<typeof brandView>>>;
export type CampaignView = NonNullable<BrandView["campaign"]>;
export type CreativeView = CampaignView["creatives"][number];
export type BrandListItem = Awaited<ReturnType<typeof brandList>>[number];
