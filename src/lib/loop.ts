import { logEvent, now as nowIso, parse, store } from "./db";
import { type CampaignOptions, type CampaignStatus, defaultOptions, startCampaign } from "./pipeline";
import { VEO_USD_PER_SECOND } from "./views";

// The always-on loop ("Autopilot" on the brand page). For each brand that opts in, the worker starts
// the brand's next campaign once the last one is finished, its videos have gone out, the cadence has
// passed and the weekly budget has room for it. Every input is the user's: the loop is off and has
// no budget until a person sets one, and posting stays a separate opt-in.

// ---------- money ----------

const MICRO = 1_000_000;
const DAY_MS = 24 * 3600 * 1000;
/** The budget window: spend in the trailing seven days counts against the weekly budget. */
export const WINDOW_MS = 7 * DAY_MS;

/**
 * Untracked spend per video, in USD. Model calls through Naive's proxy (script writer and critic,
 * QC, the first-frame gate, the screen designer, the reference breakdowns), text-to-speech and the
 * site capture are billed to the organization but never reported back per call. At Sonnet 5.5 list
 * prices ($2 in, $10 out per million tokens) a typical video's share is about $1 (scripts ~$0.25,
 * QC and frame checks ~$0.40, up to four screens ~$0.20 each) plus ~$1 per campaign for six
 * reference breakdowns; $2 per video, counted on at least the planned number of videos, is an
 * over-estimate on purpose. Frames are recorded already, so they are counted twice: fine.
 */
export const UNTRACKED_USD_PER_VIDEO = 2;

/**
 * Seconds of presenter video the estimate assumes per video. The script caps a presenter remake at
 * 24 s, but shots snap up to 4/6/8 s and stretch to fit their lines: 34 s has been rendered.
 * Faceless videos cost almost nothing, so pricing every video as a presenter video over-counts.
 */
export const PRESENTER_SECONDS_PER_VIDEO = 36;

/** Renders per shot the estimate assumes: QC re-renders a shot up to 3 times; 1.8 was measured. */
export const RENDERS_PER_SHOT = 2;

/** Research on Monid plus the creative director's session (measured: about $0.25). */
export const CAMPAIGN_OVERHEAD_USD = 1;

/** Known video model prices per second of output. */
const USD_PER_SECOND: Record<string, number> = { "google/veo-3.1": VEO_USD_PER_SECOND };
/** A model we have no measured price for is assumed to cost more than Veo, never less. */
export const UNKNOWN_MODEL_USD_PER_SECOND = 0.5;

export const usdPerSecond = (model: string) => USD_PER_SECOND[model] ?? UNKNOWN_MODEL_USD_PER_SECOND;

/**
 * What the next campaign may cost, in micro-USD, before it starts. The UI's video estimate
 * (videos x shots x seconds x price) under-counts: the script, not the options, sets how long a
 * video runs, and QC re-renders shots. A measured 2-video campaign estimated at $12.80 spent
 * $26.10. So: videos x (max(shots x seconds, 36 s) x 2 renders x price + $2 untracked) + $1.
 */
export function estimateCampaignMicro(options: Pick<CampaignOptions, "concepts" | "shotsPerConcept" | "secondsPerShot" | "videoModel">) {
  const seconds = Math.max(options.shotsPerConcept * options.secondsPerShot, PRESENTER_SECONDS_PER_VIDEO);
  const perVideo = seconds * RENDERS_PER_SHOT * usdPerSecond(options.videoModel) + UNTRACKED_USD_PER_VIDEO;
  return Math.round((options.concepts * perVideo + CAMPAIGN_OVERHEAD_USD) * MICRO);
}

/**
 * What one campaign has cost so far, for the budget: recorded spend (the larger of the stored
 * totals and a fresh sum of their sources) plus the untracked allowance for every video it planned
 * or made, re-renders of a whole video included.
 */
export function campaignSpendMicro(row: {
  naive_spend_micro: number;
  monid_spend_micro: number;
  style_spend_micro: number;
  strategy_spend_micro: number;
  creative_micro: number;
  research_micro: number;
  videos: number;
  planned: number;
}) {
  const stored = row.naive_spend_micro + row.monid_spend_micro;
  const fresh = row.style_spend_micro + row.strategy_spend_micro + row.creative_micro + row.research_micro;
  return Math.max(stored, fresh) + Math.max(row.videos, row.planned) * UNTRACKED_USD_PER_VIDEO * MICRO;
}

// ---------- the decision ----------

export type LoopSettings = {
  enabled: boolean;
  weekly_budget_micro: number;
  cadence_days: number;
  autopost: boolean;
  /** A campaign whose unposted videos a person chose to skip: it no longer holds the loop. */
  waived_campaign_id: string | null;
};

export type LoopCampaign = {
  id: string;
  status: CampaignStatus;
  created_at: string;
  /** When it last changed. Its spend counts against the week until seven days after this. */
  spent_at: string;
  /** Recorded spend plus the untracked allowance (campaignSpendMicro). */
  spend_micro: number;
  /** Finished videos that were not rejected. */
  ready: number;
};

export type LoopCode = "off" | "no_budget" | "running" | "review" | "posting" | "cadence" | "too_expensive" | "over_budget" | "start" | "error";

export type LoopDecision = { start: boolean; code: LoopCode; reason: string; next_at?: string };

export type LoopInput = {
  loop: LoopSettings;
  campaigns: LoopCampaign[];
  /** The brand's posts still on their way: how many are being submitted, and the last scheduled time. */
  posts: { inFlight: number; until: string | null };
  estimateMicro: number;
  now: Date;
};

/** Spend that still counts against the week at `now`: every campaign that changed in the last 7 days. */
export function spendInWindow(campaigns: Pick<LoopCampaign, "spent_at" | "spend_micro" | "status">[], now: Date) {
  return campaigns.filter((c) => inWindow(c, now)).reduce((sum, c) => sum + c.spend_micro, 0);
}

const inWindow = (c: Pick<LoopCampaign, "spent_at" | "status">, now: Date) => c.status === "running" || Date.parse(c.spent_at) > now.getTime() - WINDOW_MS;

/**
 * Whether to start the brand's next campaign now. The rules, in order:
 *   off: never.  No budget (0): never.  A campaign running: wait for it.
 *   The last campaign's videos are waiting for review: wait for a person (or their "skip").
 *   Posts still going out or scheduled: wait until the last one is due.
 *   The last campaign started less than cadence_days ago: wait until then.
 *   The next campaign's estimate alone is over the weekly budget: never, until the budget changes.
 *   Spend in the trailing 7 days + the estimate over the budget: wait until enough ages out.
 * Otherwise start.
 */
export function nextLoopAction({ loop, campaigns, posts, estimateMicro, now }: LoopInput): LoopDecision {
  if (!loop.enabled) return { start: false, code: "off", reason: "Autopilot is off." };
  if (loop.weekly_budget_micro <= 0) return { start: false, code: "no_budget", reason: "No weekly budget is set, so autopilot cannot start campaigns." };

  const ordered = [...campaigns].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const number = (id: string) => ordered.findIndex((c) => c.id === id) + 1;
  const running = ordered.find((c) => c.status === "running");
  if (running) return { start: false, code: "running", reason: `Campaign ${number(running.id)} is still running.` };

  const last = ordered.at(-1);
  if (last && last.status === "review" && last.ready > 0 && last.id !== loop.waived_campaign_id) {
    return {
      start: false,
      code: "review",
      reason: `Campaign ${number(last.id)}'s ${plural(last.ready, "video")} ${last.ready === 1 ? "is" : "are"} waiting to be approved and scheduled. Publish ${last.ready === 1 ? "it" : "them"}, or skip ${last.ready === 1 ? "it" : "them"} to let autopilot move on.`,
    };
  }
  if (posts.inFlight > 0) return { start: false, code: "posting", reason: `${plural(posts.inFlight, "post")} ${posts.inFlight === 1 ? "is" : "are"} still being submitted.` };
  if (posts.until && Date.parse(posts.until) > now.getTime()) {
    return { start: false, code: "posting", reason: `Waiting for the last scheduled post (${stamp(posts.until)}) before the next campaign.`, next_at: posts.until };
  }
  if (last) {
    const due = Date.parse(last.created_at) + loop.cadence_days * DAY_MS;
    if (due > now.getTime()) {
      const next_at = new Date(due).toISOString();
      return { start: false, code: "cadence", reason: `Campaign ${number(last.id)} started less than ${plural(loop.cadence_days, "day")} ago; the next one is due ${stamp(next_at)}.`, next_at };
    }
  }

  const budget = loop.weekly_budget_micro;
  if (estimateMicro > budget) {
    return { start: false, code: "too_expensive", reason: `The next campaign may cost up to ${usd(estimateMicro)}, more than the whole weekly budget of ${usd(budget)}. Raise the budget or make fewer videos per campaign.` };
  }
  const spent = spendInWindow(campaigns, now);
  if (spent + estimateMicro > budget) {
    // The earliest time enough of this week's spend ages out of the window for the next campaign to fit.
    const counted = campaigns.filter((c) => inWindow(c, now) && c.status !== "running").sort((a, b) => Date.parse(a.spent_at) - Date.parse(b.spent_at));
    let remaining = spent;
    let next_at: string | undefined;
    for (const c of counted) {
      remaining -= c.spend_micro;
      if (remaining + estimateMicro <= budget) {
        next_at = new Date(Date.parse(c.spent_at) + WINDOW_MS).toISOString();
        break;
      }
    }
    return {
      start: false,
      code: "over_budget",
      reason: `Over budget: ${usd(spent)} spent in the last 7 days + up to ${usd(estimateMicro)} for the next campaign is more than the ${usd(budget)} weekly budget.${next_at ? ` It fits again ${stamp(next_at)}.` : ""}`,
      ...(next_at ? { next_at } : {}),
    };
  }
  const days = last ? Math.floor((now.getTime() - Date.parse(last.created_at)) / DAY_MS) : 0;
  return {
    start: true,
    code: "start",
    reason: `${last ? `Campaign ${number(last.id)} started ${plural(days, "day")} ago` : "No campaign yet"}; ${usd(spent)} spent in the last 7 days + up to ${usd(estimateMicro)} fits the ${usd(budget)} weekly budget.`,
  };
}

const usd = (micro: number) => `$${(micro / MICRO).toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** An absolute time, so a waiting reason reads the same on every tick and is logged once. */
const stamp = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

// ---------- storage ----------

// One row per brand in `brand_loops` (both stores: src/lib/store/sqlite.ts and convex/tables.ts),
// created on the brand's first change. Every read and write goes through the store, so the loop
// runs the same locally and on Convex.

type LoopRow = { brand_id: string; enabled: number; weekly_budget_micro: number; cadence_days: number; autopost: number; waived_campaign_id: string | null; last_json: string | null };

/** The last decision the loop recorded, and since when it has held. */
export type LastDecision = LoopDecision & { at: string };

export const DEFAULT_LOOP: LoopSettings = { enabled: false, weekly_budget_micro: 0, cadence_days: 7, autopost: false, waived_campaign_id: null };

export async function getLoop(brandId: string): Promise<LoopSettings & { last: LastDecision | null }> {
  const [row] = await store().find<LoopRow>("brand_loops", { brand_id: brandId }, { limit: 1 });
  if (!row) return { ...DEFAULT_LOOP, last: null };
  return {
    enabled: Boolean(row.enabled),
    weekly_budget_micro: row.weekly_budget_micro,
    cadence_days: row.cadence_days,
    autopost: Boolean(row.autopost),
    waived_campaign_id: row.waived_campaign_id,
    last: parse<LastDecision | null>(row.last_json, null),
  };
}

export async function saveLoop(brandId: string, settings: LoopSettings) {
  await store().upsert("brand_loops", ["brand_id"], {
    brand_id: brandId,
    enabled: Number(settings.enabled),
    weekly_budget_micro: settings.weekly_budget_micro,
    cadence_days: settings.cadence_days,
    autopost: Number(settings.autopost),
    waived_campaign_id: settings.waived_campaign_id,
    updated_at: nowIso(),
  });
}

/** Whether this brand's finished videos are approved and scheduled without a person: loop on and posting on. */
export async function autopostOn(brandId: string) {
  const loop = await getLoop(brandId);
  return loop.enabled && loop.autopost;
}

/** A post still "pending" or "processing" a day after it was due is stuck, and no longer holds the loop. */
const STUCK_POST_MS = DAY_MS;

type CampaignSpendRow = {
  id: string;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
  options_json: string;
  naive_spend_micro: number;
  monid_spend_micro: number;
  style_spend_micro: number;
  strategy_spend_micro: number;
};

/** The brand's campaigns and posts, shaped for the decision. */
export async function loopHistory(brandId: string, now = new Date()): Promise<Pick<LoopInput, "campaigns" | "posts">> {
  const rows = await store().find<CampaignSpendRow>("campaigns", { brand_id: brandId }, { order: [["created_at", "asc"]] });
  const ids = rows.map((row) => row.id);
  const creatives = ids.length ? await store().find<{ campaign_id: string; status: string; rejected: number; cost_micro: number }>("creatives", { campaign_id: { in: ids } }) : [];
  const runs = ids.length ? await store().find<{ campaign_id: string; cost_micro: number }>("monid_runs", { campaign_id: { in: ids } }) : [];
  const campaigns = rows.map((row) => {
    const mine = creatives.filter((c) => c.campaign_id === row.id);
    const totals = {
      ...row,
      creative_micro: mine.reduce((sum, c) => sum + (c.cost_micro ?? 0), 0),
      research_micro: runs.filter((r) => r.campaign_id === row.id).reduce((sum, r) => sum + (r.cost_micro ?? 0), 0),
      videos: mine.length,
      planned: parse<Partial<CampaignOptions>>(row.options_json, {}).concepts ?? 0,
    };
    return {
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      spent_at: row.updated_at > row.created_at ? row.updated_at : row.created_at,
      spend_micro: campaignSpendMicro(totals),
      ready: mine.filter((c) => c.status === "ready" && !c.rejected).length,
    };
  });
  type Post = { status: string; scheduled_at: string | null; created_at: string };
  const posts = await store().find<Post>("posts", { brand_id: brandId, status: { in: ["pending", "processing", "scheduled"] } });
  const stuckBefore = new Date(now.getTime() - STUCK_POST_MS).toISOString();
  const inFlight = posts.filter((p) => (p.status === "pending" || p.status === "processing") && (p.scheduled_at ?? p.created_at) > stuckBefore).length;
  const until = posts.reduce<string | null>((latest, p) => (p.scheduled_at && (!latest || p.scheduled_at > latest) ? p.scheduled_at : latest), null);
  return { campaigns, posts: { inFlight, until } };
}

/** The decision for one brand right now, from the store. Reads only. */
export async function decide(brandId: string, now = new Date()) {
  const loop = await getLoop(brandId);
  const history = await loopHistory(brandId, now);
  const estimateMicro = estimateCampaignMicro(defaultOptions());
  return { loop, history, estimateMicro, decision: nextLoopAction({ loop, ...history, estimateMicro, now }) };
}

/** Waiting reasons worth a line in the activity log. "Running" and "off" are already obvious there. */
const LOGGED: ReadonlySet<LoopCode> = new Set(["no_budget", "review", "posting", "cadence", "too_expensive", "over_budget"]);

const sameDecision = (a: LoopDecision | null, b: LoopDecision) => Boolean(a) && a!.code === b.code && a!.reason === b.reason && a!.next_at === b.next_at;

async function recordDecision(brandId: string, decision: LoopDecision) {
  await store().update("brand_loops", { brand_id: brandId }, { last_json: JSON.stringify({ ...decision, at: nowIso() } satisfies LastDecision) });
}

/**
 * Worker step: decide for every brand with the loop on, start a campaign where the rules allow, and
 * log a decision only when it changes, so a wait is one line in the activity log, not one per tick.
 */
export async function advanceLoop(now = new Date()) {
  const brands = await store().find<{ brand_id: string }>("brand_loops", { enabled: 1 });
  for (const { brand_id: brandId } of brands) {
    try {
      const { loop, decision } = await decide(brandId, now);
      if (decision.start) {
        const campaignId = await startCampaign(brandId, defaultOptions());
        const n = (await store().find("campaigns", { brand_id: brandId })).length;
        await recordDecision(brandId, decision);
        await logEvent({ brandId, campaignId, message: `Autopilot started campaign ${n}. ${decision.reason}` });
        continue;
      }
      if (sameDecision(loop.last, decision)) continue;
      await recordDecision(brandId, decision);
      if (LOGGED.has(decision.code)) {
        await logEvent({ brandId, level: decision.code === "over_budget" || decision.code === "too_expensive" || decision.code === "no_budget" ? "warn" : "info", message: `Autopilot is waiting: ${decision.reason}` });
      }
    } catch (error) {
      const failed: LoopDecision = { start: false, code: "error", reason: `Autopilot hit an error: ${error instanceof Error ? error.message : String(error)}` };
      if (sameDecision((await getLoop(brandId)).last, failed)) continue;
      await recordDecision(brandId, failed);
      await logEvent({ brandId, level: "error", message: failed.reason });
    }
  }
}

// ---------- what the UI reads and changes ----------

export async function loopView(brandId: string, now = new Date()) {
  const { loop, history, estimateMicro, decision } = await decide(brandId, now);
  const ordered = [...history.campaigns].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const last = ordered.at(-1);
  return {
    settings: {
      enabled: loop.enabled,
      weeklyBudgetUsd: loop.weekly_budget_micro / MICRO,
      cadenceDays: loop.cadence_days,
      autopost: loop.autopost,
    },
    status: {
      decision,
      /** When the loop will look again with something new to act on; "now" when it is about to start one. */
      nextRunAt: decision.start ? now.toISOString() : (decision.next_at ?? null),
      spendThisWeekUsd: spendInWindow(history.campaigns, now) / MICRO,
      estimateUsd: estimateMicro / MICRO,
      last: loop.last,
      /** The campaign a person can let the loop move past without posting it. */
      skippable: decision.code === "review" && last ? last.id : null,
    },
    assumptions: {
      untrackedUsdPerVideo: UNTRACKED_USD_PER_VIDEO,
      presenterSecondsPerVideo: PRESENTER_SECONDS_PER_VIDEO,
      rendersPerShot: RENDERS_PER_SHOT,
      campaignOverheadUsd: CAMPAIGN_OVERHEAD_USD,
    },
  };
}

export type LoopView = Awaited<ReturnType<typeof loopView>>;

export type LoopPatch = { enabled?: unknown; weeklyBudgetUsd?: unknown; cadenceDays?: unknown; autopost?: unknown; skipCampaignId?: unknown };

/** Applies a person's change to the loop settings. Throws with a message the UI can show. */
export async function updateLoop(brandId: string, patch: LoopPatch) {
  const current = await getLoop(brandId);
  const next: LoopSettings = { ...current };
  if (patch.weeklyBudgetUsd !== undefined) {
    const dollars = Number(patch.weeklyBudgetUsd);
    if (patch.weeklyBudgetUsd === "" || patch.weeklyBudgetUsd === null || !Number.isFinite(dollars) || dollars < 0 || dollars > 100_000) throw new Error("Enter a weekly budget in dollars, from 0 to 100,000.");
    next.weekly_budget_micro = Math.round(dollars * 100) * 10_000;
  }
  if (patch.cadenceDays !== undefined) {
    const days = Number(patch.cadenceDays);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error("Run a campaign every 1 to 60 days.");
    next.cadence_days = days;
  }
  if (patch.autopost !== undefined) next.autopost = patch.autopost === true;
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (next.enabled && next.weekly_budget_micro <= 0) {
    throw new Error(current.enabled ? "Autopilot is on, so it needs a weekly budget above $0. Turn it off first." : "Set a weekly budget before turning autopilot on.");
  }
  if (typeof patch.skipCampaignId === "string") {
    const [campaign] = await store().find("campaigns", { id: patch.skipCampaignId, brand_id: brandId }, { limit: 1 });
    if (!campaign) throw new Error("No such campaign for this brand.");
    next.waived_campaign_id = patch.skipCampaignId;
  }
  await saveLoop(brandId, next);

  const changes: string[] = [];
  if (next.enabled !== current.enabled) changes.push(next.enabled ? "turned on" : "turned off");
  if (next.weekly_budget_micro !== current.weekly_budget_micro) changes.push(`weekly budget ${usd(next.weekly_budget_micro)}`);
  if (next.cadence_days !== current.cadence_days) changes.push(`a campaign every ${plural(next.cadence_days, "day")}`);
  if (next.autopost !== current.autopost) changes.push(next.autopost ? "finished videos are approved and scheduled automatically" : "finished videos wait for a person's approval");
  if (next.waived_campaign_id !== current.waived_campaign_id) changes.push("the last campaign's unposted videos are skipped");
  if (changes.length) await logEvent({ brandId, message: `Autopilot settings changed by you: ${changes.join("; ")}` });
}
