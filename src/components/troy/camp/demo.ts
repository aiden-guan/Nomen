import { type BrandView, type CreativeView, normalizeSite } from "../api";
import { stationForEvent } from "../scenes/derive";
import { LAND, landFor } from "../scenes/layout";
import { SAMPLE } from "./sample";

// The demo camp replays one campaign on a clock: the website, research, the format study, the
// strategy, production, your review and the posting, in about two minutes, without keys or
// spending. It builds the same BrandView the core's API returns, so it drives the real camp code.
//
// What it replays is a DemoScript: either the made-up sample below (./sample.ts) or a campaign
// recorded from a real run with `npm run demo:export`, whose videos then play in the theatre.
// Recordings live in public/demo/<id>/ and are listed in public/demo/index.json.

export const DEMO_ID = "demo";

/** A recorded video's research reference, as the camp shows it, from its concept. */
function referenceOf(concept: unknown) {
  const ref = (concept as { reference?: { id?: string; url?: string; author?: string; views?: number; followers?: number | null; outlier?: number | null; format?: string } } | null)?.reference;
  if (!ref?.url) return null;
  return { id: ref.id ?? "", url: ref.url, author: ref.author ?? "", platform: /instagram/.test(ref.url) ? "instagram" : /youtube/.test(ref.url) ? "youtube" : "tiktok", views: ref.views ?? 0, followers: ref.followers ?? null, outlier: ref.outlier ?? null, thumbnail: null, format: ref.format ?? "", paidAd: false };
}

type Campaign = NonNullable<BrandView["campaign"]>;
type ShotView = CreativeView["shots"][number];

export type DemoCreative = {
  idx: number;
  concept: CreativeView["concept"];
  caption: string;
  platforms: string[];
  /** The lowest QC score of its shots. */
  qcScore: number | null;
  /** Dollars spent on its renders. */
  cost: number;
  generation: number;
  shots: Array<{ n: number; provider: string | null; renders: number; qc: ShotView["qc"] }>;
  /** File names in the recording's folder, or absolute URLs. */
  video: string | null;
  poster: string | null;
  /** Numbers shown once it is posted. Only for made-up brands, or real numbers. */
  analytics?: Record<string, number> | null;
};

export type DemoScript = {
  version: 1;
  /** True when exported from a real campaign (by scripts/demo-export.mjs). */
  recorded: boolean;
  recordedAt?: string;
  brand: { name: string; domain: string; url: string; profile: BrandView["brand"]["profile"] };
  options: Campaign["options"];
  estimateUsd: number | null;
  plan: Campaign["plan"];
  research: {
    videos: number;
    ads: number;
    reddit: number;
    keywords: number;
    domainRating: number | null;
    /**
     * The category's top videos: their median views, and likes at their median likes per view.
     * The battle compares the campaign's own posts against this. Missing in older recordings.
     */
    benchmark?: { views: number; likes: number } | null;
    /** How many of the running ads the scouts found were each rival's. */
    rivalAds?: Array<{ name: string; ads: number }>;
  } | null;
  runs: Array<{ key: string; phase: string; provider: string; status: "done" | "failed"; error: string | null; cost: number }>;
  style: { slug: string | null; version: number | null; samples: number } | null;
  strategy: Campaign["strategy"];
  creatives: DemoCreative[];
  /** The campaign's event lines, with seconds since it started (real seconds for recordings). */
  events: Array<{ s: number; level: string; message: string }>;
  spend: Campaign["spend"];
};

export type PublishMode = "now" | "daily";

export type DemoState = {
  /** Seconds on the demo clock. */
  t: number;
  /** Wall-clock time (ms) of t = 0. Event timestamps hang off it, so they stay put while paused. */
  origin: number;
  /** What you approved in the theatre, by video index. */
  approved: Record<number, boolean>;
  /** When you sent the approved videos out, and which ones. */
  publish: { mode: PublishMode; at: number; ids: number[] } | null;
};

export const freshState = (now = Date.now()): DemoState => ({ t: 0, origin: now, approved: {}, publish: null });

// --- The clock -------------------------------------------------------------------------------

/** Per video: first frames, rendering, then quality checks (seconds). */
const FRAMES = 5;
const RENDER = 12;
const QC = 4;
const PER_VIDEO = FRAMES + RENDER + QC;
/** Seconds the clock runs past the review before it waits for you. */
export const REVIEW_HOLD = 2;

export type Timeline = {
  research: [number, number];
  style: [number, number] | null;
  strategy: [number, number];
  production: [number, number];
  /** Every video is ready from here, and the campaign waits for your review. */
  review: number;
  /** Seconds between one video's start and the next one's. */
  stagger: number;
};

// Research takes as long as the scouts' rides: each source stays out until its scout has ridden
// to its land and gathered a moment (the camp's riders take 15 to 21 seconds there and back), and
// the research is done once the last of them is home with the case.

/**
 * Seconds a source stays out, by its land's row on the map: the ride there and a moment's
 * gathering. The rows at the ends of the high road are the longest rides; the ride home takes
 * about as long again.
 */
const STAY_BY_ROW = [9.2, 8, 8.2, 9.4, 10.8];
const stay = (key: string) => STAY_BY_ROW[LAND[landFor(key)].row];
const firstStart = (i: number) => 0.6 + i * 0.25;
/** Seconds the planned sweep's scouts take to march out of the horse to the stable. */
const MARCH_OUT = 8;

export function timeline(script: DemoScript): Timeline {
  const first = script.runs.filter((run) => run.phase === "A");
  const home = Math.max(20, ...first.map((run, i) => firstStart(i) + 2 * stay(run.key)), ...secondSweep(script).map((run) => run.end + (run.end - run.start)));
  const research: [number, number] = [0, Math.ceil(home + 1)];
  const style: [number, number] | null = script.style ? [research[1], research[1] + 8] : null;
  const strategyStart = style ? style[1] : research[1];
  const strategy: [number, number] = [strategyStart, strategyStart + 9];
  const count = Math.max(1, script.creatives.length);
  const stagger = count > 1 ? Math.min(2.5, 8 / (count - 1)) : 0;
  const production: [number, number] = [strategy[1], strategy[1] + PER_VIDEO + stagger * (count - 1) + 0.5];
  return { research, style, strategy, production, review: production[1], stagger };
}

/** The stage starts, for skipping forward and back. */
export function marks(script: DemoScript) {
  const tl = timeline(script);
  return [tl.research[0], ...(tl.style ? [tl.style[0]] : []), tl.strategy[0], tl.production[0], tl.review];
}

const ordered = (script: DemoScript) => script.creatives.slice().sort((a, b) => a.idx - b.idx);

// A recording's videos weren't posted, so they have no numbers of their own, and the battle only
// fights once posts have numbers. The replay gives them illustrative ones instead: each video's likes
// per view set against the recording's benchmark (the category's top videos), so the attacks end
// differently (two ahead, one level, one behind). They are marked `illustrative: true`, and the
// scoreboard, the agora, the soldiers' cards and the tour say so. Real numbers always win.

/** Illustrative likes per view against the benchmark, by the video's place in the campaign. */
export const ILLUSTRATIVE_RATIOS = [1.32, 1.04, 1.24, 0.78];
/** Illustrative views, by the video's place in the campaign. */
const ILLUSTRATIVE_VIEWS = [38_400, 21_700, 64_900, 12_300];

/** Whether the replay shows illustrative numbers: a benchmark to set them against, and no real ones. */
export function illustrativeNumbers(script: DemoScript) {
  const bench = script.research?.benchmark;
  return Boolean(bench && bench.views > 0 && bench.likes > 0) && script.creatives.every((c) => !c.analytics);
}

function illustrativeAnalytics(script: DemoScript, idx: number): Record<string, number> | null {
  const bench = script.research?.benchmark;
  if (!bench || !illustrativeNumbers(script)) return null;
  const k = Math.max(0, ordered(script).findIndex((c) => c.idx === idx));
  const views = ILLUSTRATIVE_VIEWS[k % ILLUSTRATIVE_VIEWS.length];
  const likes = Math.round(views * (bench.likes / bench.views) * ILLUSTRATIVE_RATIOS[k % ILLUSTRATIVE_RATIOS.length]);
  return { views, likes };
}

/** Stand-ins for the running ads the scouts found, each with its advertiser where the recording knows it. */
function rivalAds(research: NonNullable<DemoScript["research"]>) {
  const known = (research.rivalAds ?? []).flatMap((r) => Array.from({ length: r.ads }, () => ({ advertiser: r.name })));
  return [...known, ...Array.from({ length: Math.max(0, research.ads - known.length) }, () => ({}))];
}
const between = (a: number, b: number, t: number) => (b <= a ? (t >= b ? 1 : 0) : Math.max(0, Math.min(1, (t - a) / (b - a))));

/** When the research plan comes back: once the first sweep is in. */
function planTime(script: DemoScript) {
  const first = script.runs.filter((run) => run.phase === "A");
  const end = first.reduce((latest, run, i) => Math.max(latest, firstStart(i) + stay(run.key)), 0);
  return Math.max(5.5, end + 0.5);
}

/**
 * When each source of the planned sweep (the runs after the first sweep, in order) starts and
 * comes back in. Its scouts march out of the horse when the plan lists them, so the sweep starts
 * once they reach the stable: a land at a time, the farthest first so every scout is home soon
 * after, and a land's sources together, since one scout fetches them all.
 */
function secondSweep(script: DemoScript) {
  const runs = script.runs.filter((run) => run.phase !== "A");
  const begin = planTime(script) + MARCH_OUT;
  const lands = [...new Set(runs.map((run) => landFor(run.key)))].sort((a, b) => STAY_BY_ROW[LAND[b].row] - STAY_BY_ROW[LAND[a].row]);
  const seen = new Map<string, number>();
  return runs.map((run) => {
    const land = landFor(run.key);
    const n = seen.get(land) ?? 0;
    seen.set(land, n + 1);
    const start = begin + lands.indexOf(land) * 0.5 + n * 0.3;
    return { start, end: start + stay(run.key) };
  });
}

function videoWindow(tl: Timeline, i: number) {
  const begin = tl.production[0] + i * tl.stagger;
  return { begin, framed: begin + FRAMES, rendered: begin + FRAMES + RENDER, ready: begin + PER_VIDEO };
}

/** How long the run lasts after the videos go out. */
function publishLength(publish: NonNullable<DemoState["publish"]>) {
  const n = Math.max(1, publish.ids.length);
  return publish.mode === "now" ? 4 + (n - 1) * 1.5 + 14 : 1.5 + n * 0.8 + 10;
}

/** The furthest the clock may go: it waits at the review until you send videos out (or autoplay does). */
export function limit(script: DemoScript, state: DemoState, auto: boolean) {
  if (state.publish) return state.publish.at + publishLength(state.publish);
  return auto ? Number.POSITIVE_INFINITY : timeline(script).review + REVIEW_HOLD;
}

export function finished(script: DemoScript, state: DemoState) {
  return Boolean(state.publish) && state.t >= limit(script, state, false) - 0.01;
}

/** Sends the approved videos out, as the theatre's "Post now" and "One a day" buttons do. */
export function publish(script: DemoScript, state: DemoState, mode: PublishMode): DemoState {
  if (state.publish || state.t < timeline(script).review) return state;
  const ids = ordered(script)
    .map((c) => c.idx)
    .filter((idx) => state.approved[idx]);
  if (!ids.length) return state;
  return { ...state, publish: { mode, at: state.t, ids } };
}

export function approveAll(script: DemoScript, state: DemoState): DemoState {
  if (state.t < timeline(script).review) return state;
  return { ...state, approved: Object.fromEntries(script.creatives.map((c) => [c.idx, true])) };
}

/** Moves the clock on. Autoplay approves each video, then posts them, as a person would. */
export function advance(script: DemoScript, state: DemoState, dt: number, auto: boolean, hold = Number.POSITIVE_INFINITY): DemoState {
  const tl = timeline(script);
  let next: DemoState = { ...state, t: state.t + dt };
  if (auto && !next.publish && next.t >= tl.review) {
    const videos = ordered(script);
    let approved = next.approved;
    videos.forEach((c, i) => {
      if (approved[c.idx] === undefined && next.t >= tl.review + 2 + i * 0.9) approved = { ...approved, [c.idx]: true };
    });
    next = { ...next, approved };
    if (next.t >= tl.review + 3 + videos.length * 0.9) next = publish(script, next, "now");
  }
  // A tour step's hold stops the clock (one already passed leaves it where it is).
  return { ...next, t: Math.min(next.t, limit(script, next, auto), Math.max(hold, state.t)) };
}

/**
 * Puts the clock at `t`, as the tour does: before the review nothing is approved or posted yet,
 * and before the videos went out they are not out.
 */
export function seek(script: DemoScript, state: DemoState, t: number): DemoState {
  const tl = timeline(script);
  const at = Math.max(0, Math.min(t, limit(script, state, false)));
  if (at < tl.review) return { ...state, t: at, approved: {}, publish: null };
  if (state.publish && at <= state.publish.at) return { ...state, t: at, publish: null };
  return { ...state, t: at };
}

/** Skips to the next stage, or back to the start of this one (or the one before). */
export function jump(script: DemoScript, state: DemoState, direction: 1 | -1): DemoState {
  const tl = timeline(script);
  const starts = marks(script);
  if (direction > 0) {
    const mark = starts.find((m) => m > state.t + 0.05);
    if (mark !== undefined) return { ...state, t: mark };
    // At the review: approve everything and post it, then run to the end.
    if (!state.publish) return publish(script, approveAll(script, state), "now");
    return { ...state, t: limit(script, state, false) };
  }
  const mark = [...starts].reverse().find((m) => m < state.t - 1.5) ?? 0;
  return mark < tl.review ? { ...state, t: mark, approved: {}, publish: null } : { ...state, t: mark, publish: null };
}

// --- The view at a moment ----------------------------------------------------------------------

/** The campaign as the API would return it at this moment of the replay. */
export function replay(script: DemoScript, state: DemoState): BrandView {
  const tl = timeline(script);
  const { t } = state;
  const key = scriptKey(script);
  const videos = ordered(script);

  const stage = t < tl.research[1] ? "research" : tl.style && t < tl.style[1] ? "style" : t < tl.strategy[1] ? "strategy" : t < tl.production[1] ? "production" : "review";
  const stageOrder = ["research", "style", "strategy", "production", "review", "live"];

  // Research sources: the first sweep, then the planned one.
  const planAt = planTime(script);
  const first = script.runs.filter((run) => run.phase === "A");
  const second = script.runs.filter((run) => run.phase !== "A");
  const runView = (run: DemoScript["runs"][number], start: number, end: number) => {
    const status = t < start ? "pending" : t < end ? "running" : run.status;
    const over = t >= end;
    return { key: run.key, phase: run.phase, provider: run.provider, endpoint: "/demo", status, error: over ? run.error : null, cost_micro: over ? Math.round(run.cost * 1e6) : 0, cost: over ? run.cost : 0 };
  };
  const runs = first.map((run, i) => runView(run, firstStart(i), firstStart(i) + stay(run.key)));
  // The planned sources are listed once the plan is in; their scouts march out to the stable.
  if (t >= planAt + 0.3) {
    const times = secondSweep(script);
    second.forEach((run, j) => runs.push(runView(run, times[j].start, times[j].end)));
  }

  // Production: each video paints its first frames, renders its shots, then passes QC.
  const progress = new Map<number, number>();
  const creatives =
    t < tl.production[0]
      ? []
      : videos.map((c, i) => {
          const w = videoWindow(tl, i);
          const frames = between(w.begin, w.framed, t);
          const render = between(w.framed, w.rendered, t);
          const qc = between(w.rendered, w.ready, t);
          progress.set(c.idx, render);
          const count = Math.max(1, c.shots.length);
          const shots = c.shots.map((shot, k) => {
            const share = (k + 1) / count;
            const status =
              frames < share ? "pending" : render <= (k / count) * 0.5 ? "framed" : render < 0.6 + 0.4 * share ? "rendering" : qc < share ? "rendered" : "passed";
            const working = status !== "pending" && status !== "framed";
            return {
              n: shot.n,
              status,
              provider: working ? (shot.provider ?? "naive") : null,
              renders: working ? Math.max(1, shot.renders) : 0,
              frameUrl: null,
              qc: status === "passed" ? (shot.qc ?? { score: c.qcScore ?? 8, pass: true, issues: [], fix_prompt: "" }) : null,
              error: null,
            };
          });
          const ready = t >= w.ready;
          return {
            id: `crv_${key}_${c.idx}`,
            idx: c.idx,
            generation: ready ? c.generation : 1,
            status: t < w.begin ? "queued" : ready ? "ready" : "producing",
            concept: c.concept,
            // The viral video it was built on, so the theatre says so ("remake of @creator, 1.2M views").
            reference: referenceOf(c.concept),
            caption: c.caption,
            platforms: c.platforms,
            approved: ready && Boolean(state.approved[c.idx]),
            videoUrl: ready ? c.video : null,
            posterUrl: ready ? c.poster : null,
            qcScore: ready ? c.qcScore : null,
            continuity: null,
            cost: Math.round(c.cost * render * 100) / 100,
            error: null,
            shots,
          };
        });

  // Posting: queued when you send them, then out (now) or on the calendar (one a day).
  const posts: Array<{ id: string; creativeId: string; platforms: string[]; scheduledAt: string | null; status: string; error: null; analytics: Record<string, number | boolean> | null }> = [];
  const live: Array<{ at: number; message: string }> = [];
  const pub = state.publish;
  if (pub && t >= pub.at) {
    live.push({ at: pub.at, message: `Queued ${pub.ids.length} posts ${pub.mode === "now" ? "to go out now" : "one per day"}` });
    pub.ids.forEach((idx, j) => {
      const c = script.creatives.find((x) => x.idx === idx);
      if (!c) return;
      const platforms = c.platforms.length ? c.platforms : ["tiktok"];
      let status: string;
      let scheduledAt: string | null = null;
      let analytics: Record<string, number | boolean> | null = null;
      if (pub.mode === "now") {
        const sent = pub.at + 1 + j * 1.2;
        const out = pub.at + 4 + j * 1.5;
        status = t < sent ? "pending" : t < out ? "processing" : "posted";
        if (t >= sent) live.push({ at: sent, message: `Post submitted: ${platforms.join(", ")}` });
        const numbers = c.analytics ?? illustrativeAnalytics(script, c.idx);
        if (status === "posted" && numbers) {
          const grown = between(out, out + 12, t);
          analytics = Object.fromEntries(Object.entries(numbers).map(([name, value]) => [name, Math.round(value * grown)]));
          if (!c.analytics) analytics.illustrative = true;
        }
      } else {
        const sent = pub.at + 1.5 + j * 0.8;
        scheduledAt = dailySlot(state.origin + pub.at * 1000, j);
        status = t < sent ? "pending" : "scheduled";
        if (t >= sent) live.push({ at: sent, message: `Post scheduled for ${scheduledAt.slice(0, 16).replace("T", " ")} UTC: ${platforms.join(", ")}` });
      }
      posts.push({ id: `pst_${key}_${idx}`, creativeId: `crv_${key}_${idx}`, platforms, scheduledAt, status, error: null, analytics });
    });
  }
  const open = posts.some((p) => p.status === "pending" || p.status === "processing");
  const settled = Boolean(pub) && t >= (pub?.at ?? 0) && !open;
  const finalStage = settled ? "live" : stage;
  const status = settled ? "live" : pub && t >= pub.at ? "publishing" : finalStage === "review" ? "review" : "running";

  // Spend grows with the work.
  const totalCost = videos.reduce((n, c) => n + c.cost, 0);
  const rendered = videos.length ? videos.reduce((n, c) => n + (totalCost ? c.cost : 1) * (progress.get(c.idx) ?? 0), 0) / (totalCost || videos.length) : 0;
  const spend = {
    naive: Math.round(script.spend.naive * rendered * 100) / 100,
    monid: Math.round(script.spend.monid * between(0, tl.research[1], t) * 100) / 100,
    style: tl.style && t >= tl.style[1] ? script.spend.style : 0,
    strategy: t >= tl.strategy[1] ? script.spend.strategy : 0,
  };

  const reviewEvents = t >= tl.review ? [{ at: tl.review, level: "info", message: `${videos.length} of ${videos.length} videos are ready for review` }] : [];
  const events = [...placeEvents(script), ...reviewEvents, ...live.map((e) => ({ ...e, level: "info" }))]
    .filter((e) => e.at <= t)
    .sort((a, b) => a.at - b.at)
    .slice(-60)
    .reverse()
    .map((e) => ({ ts: new Date(state.origin + e.at * 1000).toISOString(), level: e.level, message: e.message }));

  const research = script.research;
  const view = {
    brand: { id: DEMO_ID, name: script.brand.name, domain: script.brand.domain, url: script.brand.url, profile: script.brand.profile, connected: true },
    campaign: {
      id: `cmp_${key}`,
      status,
      stage: finalStage,
      stageIndex: stageOrder.indexOf(finalStage),
      error: null,
      naiveOut: false,
      options: script.options,
      estimateUsd: script.estimateUsd,
      plan: t >= planAt ? script.plan : null,
      research:
        t >= tl.research[1] && research
          ? {
              domain: script.brand.domain,
              brand: {},
              site_excerpt: "",
              similar_sites: [],
              seo: { domain_rating: research.domainRating, keywords: Array(research.keywords).fill({}) },
              // The recording keeps the top videos' numbers as one benchmark, so every stand-in has it.
              videos: Array(research.videos).fill(research.benchmark ? { views: research.benchmark.views, likes: research.benchmark.likes } : {}),
              ads: rivalAds(research),
              reddit: Array(research.reddit).fill({}),
              aeo: [],
            }
          : null,
      style: script.style && tl.style && t >= tl.style[1] ? { slug: script.style.slug, version: script.style.version, skill_md: "", samples: Array(script.style.samples).fill("") } : null,
      strategy: t >= tl.strategy[1] ? script.strategy : null,
      runs,
      creatives,
      posts,
      spend,
      createdAt: new Date(state.origin).toISOString(),
    },
    campaigns: [],
    events,
  };
  return view as unknown as BrandView;
}

/** One a day at 16:00 UTC, as the core schedules them (the first slot at least 30 minutes away). */
function dailySlot(from: number, day: number) {
  const now = new Date(from);
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16, 0, 0));
  if (slot.getTime() - from < 30 * 60 * 1000) slot.setUTCDate(slot.getUTCDate() + 1);
  slot.setUTCDate(slot.getUTCDate() + day);
  return slot.toISOString();
}

/** The id a replayed video goes by in the camp (its creative in the replayed view). */
export const demoCreativeId = (script: DemoScript, idx: number) => `crv_${scriptKey(script)}_${idx}`;

const keys = new WeakMap<DemoScript, string>();
/** A short id for the brand, so cached posters never mix two scripts. */
function scriptKey(script: DemoScript) {
  let key = keys.get(script);
  if (!key) {
    key = script.brand.domain.replace(/[^a-z0-9]+/gi, "").slice(0, 24).toLowerCase() || "demo";
    keys.set(script, key);
  }
  return key;
}

// --- Event lines -----------------------------------------------------------------------------

const placed = new WeakMap<DemoScript, Array<{ at: number; level: string; message: string }>>();
const STAGES = ["research", "style", "strategy", "production"] as const;
const STAGE_OF_STATION: Record<string, number> = { scouts: 0, oracle: 1, tent: 2, workshop: 3, theatre: 4, agora: 5 };

/**
 * Puts the script's event lines on the demo clock. Lines that mark a step (the plan, research
 * done, a video ready…) land exactly when the camp shows that step; the rest keep their place
 * within their stage. Review and posting lines are left out: the replay writes those as you act.
 */
export function placeEvents(script: DemoScript) {
  const cached = placed.get(script);
  if (cached) return cached;
  const tl = timeline(script);
  const windows: Array<[number, number] | null> = [tl.research, tl.style, tl.strategy, tl.production];
  const videos = ordered(script);
  const titles = videos.map((c, i) => ({ title: c.concept?.title ?? "", window: videoWindow(tl, i) })).filter((v) => v.title);

  // Each line's stage never goes backwards.
  let current = 0;
  const lines = script.events
    .slice()
    .sort((a, b) => a.s - b.s)
    .map((event) => {
      const station = stationForEvent(event.message, STAGES[Math.min(current, 3)]);
      let index = STAGE_OF_STATION[station] ?? current;
      // Without a format study, its lines (say, that it was skipped) belong to the strategy.
      if (index === 1 && !tl.style) index = 2;
      if (index <= 3) current = Math.max(current, index);
      return { ...event, stage: index > 3 ? -1 : current };
    })
    .filter((event) => event.stage >= 0 && windows[event.stage]);

  // Real seconds each stage took, from its first line to the next stage's first line.
  const starts = STAGES.map((_, k) => lines.find((l) => l.stage === k)?.s);
  const realWindow = (k: number): [number, number] => {
    const start = starts[k] ?? 0;
    const next = starts.slice(k + 1).find((s) => s !== undefined);
    const last = lines.filter((l) => l.stage === k).reduce((m, l) => Math.max(m, l.s), start);
    return [start, next ?? last + 1];
  };

  const perTitle = new Map<string, number>();
  const out = lines.map((line) => {
    const m = line.message;
    const window = windows[line.stage]!;
    let at: number | null = null;
    if (/^Campaign started/i.test(m)) at = 0;
    else if (/^Research plan:/i.test(m)) at = planTime(script);
    else if (/^Research done:/i.test(m)) at = tl.research[1] - 0.6;
    else if (/^Studying the format/i.test(m) && tl.style) at = tl.style[0] + 0.6;
    else if (/^Format study ready/i.test(m) && tl.style) at = tl.style[1] - 0.5;
    else if (/^Skipped the format study/i.test(m)) at = tl.strategy[0] + 0.2;
    else if (/^The strategist is writing/i.test(m)) at = tl.strategy[0] + 0.6;
    else if (/concepts, now producing/i.test(m)) at = tl.strategy[1] - 0.4;
    else if (line.stage === 3) {
      const video = titles.find((v) => m.includes(`"${v.title}"`));
      if (video && /" is ready/.test(m)) at = video.window.ready;
      else if (video) {
        // Notes about one video (a QC send-back, a re-render) land while it renders.
        const k = (perTitle.get(video.title) ?? 0) + 1;
        perTitle.set(video.title, k);
        at = video.window.framed + Math.min(0.9, k * 0.3) * (video.window.ready - video.window.framed);
      }
    }
    if (at === null) {
      const [a, b] = realWindow(line.stage);
      const share = b > a ? (line.s - a) / (b - a) : 0.5;
      at = window[0] + 0.4 + Math.max(0, Math.min(1, share)) * (window[1] - window[0] - 0.8);
    }
    return { at, level: line.level, message: m };
  });
  placed.set(script, out);
  return out;
}

// --- Loading a recording -----------------------------------------------------------------------

/** Checks the shape of a script read from a file, so a bad one falls back to the sample. */
export function isScript(value: unknown): value is DemoScript {
  const s = value as DemoScript | null;
  return Boolean(
    s &&
      s.version === 1 &&
      s.brand &&
      typeof s.brand.name === "string" &&
      typeof s.brand.domain === "string" &&
      s.options &&
      s.spend &&
      Array.isArray(s.runs) &&
      Array.isArray(s.events) &&
      Array.isArray(s.creatives) &&
      s.creatives.length > 0 &&
      s.creatives.every((c) => typeof c.idx === "number" && Array.isArray(c.shots)),
  );
}

const media = (path: string | null, base: string) => (!path ? null : /^(https?:|data:|blob:|\/)/.test(path) ? path : `${base}${path}`);

/**
 * The script to replay for a website: the recording for that domain if there is one, else the
 * first recording, else the made-up sample. Never throws.
 */
export async function loadDemoScript(site: string | null): Promise<DemoScript> {
  try {
    const index = await fetch("/demo/index.json", { cache: "no-cache" });
    if (!index.ok) return SAMPLE;
    // A recording answers to its domain and to any other name it lists (naive.ai for usenaive.ai).
    const list = ((await index.json()) as { scripts?: Array<{ id: string; domain: string; aliases?: string[] }> }).scripts ?? [];
    const checked = site ? normalizeSite(site) : null;
    const wanted = checked && "domain" in checked ? checked.domain : null;
    const entry = list.find((s) => wanted && (s.domain === wanted || s.aliases?.includes(wanted))) ?? list[0];
    if (!entry || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) return SAMPLE;
    const base = `/demo/${entry.id}/`;
    const response = await fetch(`${base}script.json`, { cache: "no-cache" });
    const script: unknown = response.ok ? await response.json() : null;
    if (!isScript(script)) {
      console.warn(`[demo] ${base}script.json is missing or malformed; playing the sample instead.`);
      return SAMPLE;
    }
    const profile = script.brand.profile;
    return {
      ...script,
      brand: { ...script.brand, profile: profile && { ...profile, logo: profile.logo ? media(profile.logo, base) : profile.logo } },
      creatives: script.creatives.map((c) => ({ ...c, video: media(c.video, base), poster: media(c.poster, base) })),
    };
  } catch (error) {
    console.warn("[demo] could not load a recording; playing the sample instead.", error);
    return SAMPLE;
  }
}
