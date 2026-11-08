import type { BrandView, CampaignView } from "../api";
import { BATTLE_LINES } from "./layout";

// The battle below the agora, from the campaign: one Greek company per finished video, the rival
// the Romans stand for, and how each video's posts are doing against the category's top videos.
// Pure, so it is easy to test; scenes/battlefield.ts draws it and derive.ts posts the army.
//
// What the battle shows is a real comparison, never a made-up one: likes per view of each posted
// video against the median likes per view of the top videos the scouts found in the category.
// Where either number is missing, the battle shows no result for it.

export type CompanyState = "formed" | "approved" | "sent" | "engaged" | "failed";

export type Company = {
  /** The video it stands for. */
  creativeId: string;
  idx: number;
  title: string;
  /**
   * formed: the video waits for review; approved: cleared to go; sent: its post is going out;
   * engaged: posted; failed: its post failed.
   */
  state: CompanyState;
  /** Its posts' numbers, once there are any. */
  views: number | null;
  likes: number | null;
  /** Its likes per view against the benchmark (1 = level with the top videos), when both are known. */
  ratio: number | null;
};

export type BattlePlan = {
  /** none: no video finished yet; muster: the army forms up; advance: posts are going out; clash: some are out. */
  phase: "none" | "muster" | "advance" | "clash";
  companies: Company[];
  /** The rival the legion stands for, and how many of its ads the scouts found running. */
  rival: { name: string; ads: number | null } | null;
  /** The category's top videos (from the research): their median likes per view. */
  benchmark: { engagement: number; videos: number } | null;
  /** All the posted videos together, against the benchmark. */
  score: { views: number; likes: number; engagement: number; ratio: number | null } | null;
};

/** A company that does at least this well against the benchmark routs the Romans facing it. */
export const VICTORY = 1.15;
/** One doing worse than this is pushed back (but holds). */
export const SETBACK = 0.87;

const VIEW_KEY = /^(views?|view_?count|plays?|play_?count|video_?views|impressions)$/i;
const LIKE_KEY = /^(likes?|like_?count|reactions?|hearts?|favou?rites?)$/i;

/**
 * Views and likes from a post's analytics, whatever their shape: the shallowest level that has
 * views wins (a total beside a per-platform breakdown is not counted twice). Null without views.
 */
export function postNumbers(analytics: Record<string, unknown> | null | undefined): { views: number; likes: number } | null {
  if (!analytics) return null;
  for (let depth = 0; depth <= 2; depth++) {
    let views = 0;
    let likes = 0;
    let found = false;
    const visit = (o: unknown, d: number) => {
      if (!o || typeof o !== "object") return;
      for (const [key, value] of Object.entries(o as Record<string, unknown>)) {
        if (d === depth && typeof value === "number" && Number.isFinite(value)) {
          if (VIEW_KEY.test(key)) {
            views += value;
            found = true;
          } else if (LIKE_KEY.test(key)) likes += value;
        } else if (d < depth && value && typeof value === "object") visit(value, d + 1);
      }
    };
    visit(analytics, 0);
    if (found) return views > 0 ? { views, likes } : null;
  }
  return null;
}

/** The median likes per view of the category's top videos, from at least three with real numbers. */
export function benchmarkOf(campaign: CampaignView | null): BattlePlan["benchmark"] {
  const videos = (campaign?.research?.videos ?? []) as Array<{ views?: unknown; likes?: unknown }>;
  const rates = videos
    .filter((v) => typeof v.views === "number" && typeof v.likes === "number" && v.views >= 100)
    .map((v) => (v.likes as number) / (v.views as number))
    .sort((a, b) => a - b);
  if (rates.length < 3) return null;
  const mid = rates.length >> 1;
  const engagement = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  return engagement > 0 ? { engagement, videos: rates.length } : null;
}

export function deriveBattle(view: BrandView | null): BattlePlan {
  const campaign = view?.campaign ?? null;
  const none: BattlePlan = { phase: "none", companies: [], rival: null, benchmark: null, score: null };
  if (!campaign) return none;
  const benchmark = benchmarkOf(campaign);

  const rivalName = campaign.plan?.competitors?.[0]?.name ?? campaign.strategy?.competitors?.[0]?.name ?? null;
  const ads = campaign.research?.ads as Array<{ advertiser?: string }> | undefined;
  const rival = rivalName
    ? { name: rivalName, ads: ads ? ads.filter((ad) => typeof ad.advertiser === "string" && ad.advertiser.toLowerCase().includes(rivalName.toLowerCase())).length : null }
    : null;

  let views = 0;
  let likes = 0;
  const companies: Company[] = campaign.creatives
    .filter((c) => c.status === "ready")
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((creative) => {
      const posts = campaign.posts.filter((p) => p.creativeId === creative.id);
      const posted = posts.filter((p) => p.status === "posted");
      const going = posts.some((p) => p.status === "pending" || p.status === "scheduled" || p.status === "processing");
      const failed = posts.length > 0 && posts.every((p) => p.status === "failed");
      const state: CompanyState = posted.length ? "engaged" : going ? "sent" : failed ? "failed" : creative.approved ? "approved" : "formed";
      const counted = posted.map((post) => postNumbers(post.analytics as Record<string, unknown> | null)).filter((n) => n !== null);
      const ownViews = counted.reduce((sum, n) => sum + n.views, 0);
      const ownLikes = counted.reduce((sum, n) => sum + n.likes, 0);
      views += ownViews;
      likes += ownLikes;
      const known = counted.length > 0 && ownViews > 0;
      const ratio = known && benchmark ? ownLikes / ownViews / benchmark.engagement : null;
      return {
        creativeId: creative.id,
        idx: creative.idx,
        title: creative.concept?.title ?? `Video ${creative.idx + 1}`,
        state,
        views: known ? ownViews : null,
        likes: known ? ownLikes : null,
        ratio,
      };
    });
  if (!companies.length) return { ...none, rival, benchmark };

  const phase = companies.some((c) => c.state === "engaged") ? "clash" : companies.some((c) => c.state === "sent") ? "advance" : "muster";
  const score = views > 0 ? { views, likes, engagement: likes / views, ratio: benchmark ? likes / views / benchmark.engagement : null } : null;
  return { phase, companies, rival, benchmark, score };
}

/**
 * Where a company's front rank stands along the battle (`a`): formed up below the agora, closed up
 * and waiting while its post goes out, then in the fight. An engaged company pushes as far as its
 * video does against the top videos: level is the middle of the field, twice as good is near the
 * Romans' gate, half as good is pushed back toward its own lines. With no numbers yet it fights
 * in the middle.
 */
export function companyFront(company: Company): number {
  if (company.state === "sent") return BATTLE_LINES.ready;
  if (company.state !== "engaged") return BATTLE_LINES.muster;
  if (company.ratio === null) return 0;
  if (company.ratio >= VICTORY) return BATTLE_LINES.gate - 22;
  return Math.max(-28, Math.min(48, Math.round(42 * Math.log2(company.ratio))));
}

/** A company that has routed the Romans facing it. */
export function victorious(company: Company) {
  return company.state === "engaged" && company.ratio !== null && company.ratio >= VICTORY;
}

/** Across the battle (`b`): companies side by side, centred, with room between them. */
export function companyB(index: number, count: number) {
  return (index - (count - 1) / 2) * COMPANY_GAP;
}

/** How far apart companies stand (`b`), the files within one, and its ranks (`a`). */
export const COMPANY_GAP = 38;
export const FILE_GAP = 10;
export const RANK_GAP = 10.5;
/** Between the Greek and the Roman front ranks when they fight. */
export const CLASH_GAP = 13;
