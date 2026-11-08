import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { logEvent, newId, now, parse, save, store } from "./db";
import { ApiError } from "./http";
import { MonidClient, providerFailed, runCostMicro, TERMINAL } from "./monid";
import { NaiveClient } from "./naive";
import { advanceCreative, type CreativeRow, insertCreative, type ShotState } from "./production";
import { scratchDir } from "./media";
import { captureSiteVisuals } from "./creative/capture";
import { planProduction } from "./creative/plan";
import { getBrandKit } from "./creative/brandkit";
import { analyzeProduct } from "./creative/product";
import { breakdownAll, pickForBreakdown, scoreCandidates } from "./creative/references";
import { applyRelevance, screenRelevance } from "./creative/relevance";
import { scout, scoutSpecs } from "./creative/scout";
import { targetSeconds, writeScript } from "./creative/script";
import type { ProductBrief, ProductVisual, ReferenceBreakdown, ReferenceCandidate } from "./creative/types";
import { compactResearch, fallbackPlan, phaseASpecs, phaseCSpecs, planResearch, type ResearchPack, type ResearchPlan, type RunSpec, type Video } from "./research";
import { getBool, getInt, getSetting } from "./settings";
import { type Concept, conceptFrom, normalizeStrategy, type PastResult, STRATEGY_SCHEMA, type Strategy, strategyMessage } from "./strategy";

// The campaign state machine. The worker calls advanceCampaign() every few seconds; every step is
// idempotent, so a restart picks up exactly where it stopped. Rows live in the store (src/lib/store):
// SQLite locally, Convex on serverless hosts, so every read and write is awaited. Files that must
// outlive a tick (captured screenshots, renders, the cut) go through store().files; scratch work
// (downloads, reference videos) lives in scratchDir() for the length of one tick.

export type CampaignStage = "research" | "style" | "strategy" | "production" | "review" | "live";
export type CampaignStatus = "running" | "review" | "publishing" | "live" | "failed" | "stopped";

export type CampaignOptions = { concepts: number; shotsPerConcept: number; secondsPerShot: number; videoModel: string; learnStyle: boolean };

export type BrandRow = { id: string; name: string; domain: string; url: string; profile_json: string | null; identity_id: string | null; social_activated: number; created_at: string };

export type CampaignRow = {
  id: string;
  brand_id: string;
  status: CampaignStatus;
  stage: CampaignStage;
  error: string | null;
  attempts: number;
  options_json: string;
  plan_json: string | null;
  research_json: string | null;
  style_build_id: string | null;
  style_idem: string | null;
  style_json: string | null;
  style_started_at: string | null;
  style_attempt: number;
  strategy_idem: string | null;
  strategy_session_id: string | null;
  strategy_nudges: number;
  strategy_json: string | null;
  naive_out: number;
  style_spend_micro: number;
  strategy_spend_micro: number;
  naive_spend_micro: number;
  monid_spend_micro: number;
  created_at: string;
  updated_at: string;
};

type RunRow = { id: string; campaign_id: string; key: string; phase: "A" | "C"; provider: string; endpoint: string; input_json: string; run_id: string | null; status: "pending" | "running" | "done" | "failed"; output_json: string | null; error: string | null; cost_micro: number };

export const getBrand = async (id: string) => (await store().find<BrandRow>("brands", { id }, { limit: 1 }))[0];
export const getCampaign = async (id: string) => (await store().find<CampaignRow>("campaigns", { id }, { limit: 1 }))[0];
export const listCreatives = (campaignId: string) => store().find<CreativeRow>("creatives", { campaign_id: campaignId }, { order: [["idx", "asc"], ["generation", "asc"]] });
const listRuns = (campaignId: string) => store().find<RunRow>("monid_runs", { campaign_id: campaignId }, { order: [["created_at", "asc"]] });

export function defaultOptions(): CampaignOptions {
  return {
    concepts: Math.max(1, Math.min(8, getInt("videos_per_campaign"))),
    shotsPerConcept: Math.max(1, Math.min(3, getInt("shots_per_video"))),
    secondsPerShot: Math.max(4, Math.min(10, getInt("video_seconds"))),
    videoModel: getSetting("video_model"),
    learnStyle: getBool("learn_style"),
  };
}

export function normalizeDomain(input: string) {
  const trimmed = input.trim();
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!url.hostname.includes(".")) throw new Error("Enter a website address like example.com");
  return { domain: url.hostname.replace(/^www\./, "").toLowerCase(), url: `${url.protocol}//${url.hostname}` };
}

export async function createBrand(input: string) {
  const { domain, url } = normalizeDomain(input);
  const [existing] = await store().find<BrandRow>("brands", { domain }, { limit: 1 });
  if (existing) return existing.id;
  const id = newId("brd");
  const name = domain.split(".")[0];
  await store().insert("brands", { id, name: name[0].toUpperCase() + name.slice(1), domain, url, created_at: now(), updated_at: now() });
  return id;
}

export async function startCampaign(brandId: string, options: CampaignOptions = defaultOptions()) {
  const id = newId("cmp");
  await store().insert("campaigns", {
    id,
    brand_id: brandId,
    status: "running",
    stage: "research",
    options_json: JSON.stringify(options),
    style_idem: `${id}-style`,
    strategy_idem: `${id}-strategy`,
    created_at: now(),
    updated_at: now(),
  });
  await logEvent({ brandId, campaignId: id, message: `Campaign started: ${options.concepts} videos, ${options.shotsPerConcept} shots each, ${options.videoModel}` });
  return id;
}

export function clients() {
  const build = <T>(make: () => T): T | null => {
    try {
      return make();
    } catch {
      return null;
    }
  };
  return { naive: build(() => new NaiveClient()), monid: build(() => new MonidClient()) };
}

export async function advanceCampaign(id: string) {
  const campaign = await getCampaign(id);
  if (!campaign || campaign.status !== "running") return;
  try {
    if (campaign.stage === "research") await stepResearch(campaign);
    else if (campaign.stage === "style") await stepStyle(campaign);
    else if (campaign.stage === "strategy") await stepStrategy(campaign);
    else if (campaign.stage === "production") await stepProduction(campaign);
    if (campaign.attempts) await save("campaigns", id, { attempts: 0 });
  } catch (error) {
    if (error instanceof ApiError && error.retryable && campaign.attempts < 10) {
      await save("campaigns", id, { attempts: campaign.attempts + 1 });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await save("campaigns", id, { status: "failed", error: message });
      await logEvent({ brandId: campaign.brand_id, campaignId: id, level: "error", message: `Stopped at ${campaign.stage}: ${message}` });
    }
  }
  await recomputeSpend(id);
}

// ---------- research ----------

async function stepResearch(campaign: CampaignRow) {
  const { monid, naive } = clients();
  if (!monid) throw new Error("Research runs on Monid: add a Monid API key in Settings, then retry.");
  const brand = (await getBrand(campaign.brand_id))!;
  await ensureRuns(campaign.id, phaseASpecs(brand.domain));
  await progressRuns(campaign, monid);
  const runs = await listRuns(campaign.id);
  if (runs.some((run) => run.status === "pending" || run.status === "running")) return;

  const forCompact = runs.map((run) => ({ key: run.key, status: run.status, output: parse<unknown>(run.output_json, undefined) }));
  if (!campaign.plan_json) {
    const partial = compactResearch(brand.domain, forCompact, null);
    await save("brands", brand.id, { name: partial.brand.name || brand.name, profile_json: JSON.stringify(partial.brand) });
    const plan: ResearchPlan = naive
      ? await planResearch(naive, { domain: brand.domain, brand: partial.brand, siteExcerpt: partial.site_excerpt, similar: partial.similar_sites })
      : fallbackPlan(brand.domain, partial.brand, partial.similar_sites);
    await save("campaigns", campaign.id, { plan_json: JSON.stringify(plan) });
    await ensureRuns(campaign.id, phaseCSpecs(plan));
    await logEvent({
      brandId: brand.id,
      campaignId: campaign.id,
      message: `Research plan: ${plan.category}; competitors ${plan.competitors.map((c) => c.name).join(", ") || "unknown"}; searching ${plan.content_queries.join(", ")}`,
    });
    return;
  }

  const plan = parse<ResearchPlan | null>(campaign.plan_json, null);
  if (plan && !plan.scouted) {
    // The scout reads the first wave (who broke out, which hooks and hashtags recur) and digs further.
    const firstWave = compactResearch(brand.domain, forCompact, plan);
    const searched = [plan.brand_name, ...plan.content_queries, ...plan.competitors.map((c) => c.name)];
    let report = { notes: "", searches: [] as Array<{ platform: string; query: string; why: string }> };
    if (naive && firstWave.videos.length) {
      try {
        report = await scout(naive, { plan, videos: firstWave.videos, brand: { name: firstWave.brand.name, description: firstWave.brand.description }, alreadySearched: searched });
      } catch (error) {
        if (error instanceof ApiError && error.retryable) throw error;
      }
    }
    const specs = scoutSpecs({ notes: report.notes, searches: report.searches as Parameters<typeof scoutSpecs>[0]["searches"] });
    await ensureRuns(campaign.id, specs);
    await save("campaigns", campaign.id, { plan_json: JSON.stringify({ ...plan, scouted: true, scout_notes: report.notes }) });
    await logEvent({
      brandId: brand.id,
      campaignId: campaign.id,
      message: specs.length
        ? `Scout: ${report.notes || "following up on the first wave"} Digging into ${report.searches.map((x) => `"${x.query}" (${x.platform})`).join(", ")}`
        : `Scout: no follow-up searches${report.notes ? `. ${report.notes}` : ""}`,
    });
    return;
  }
  const pack = compactResearch(brand.domain, forCompact, plan);
  const done = runs.filter((run) => run.status === "done").length;
  if (done === 0) throw new Error("Every research source failed. Check the website address and your Monid balance, then retry.");
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  await save("campaigns", campaign.id, { research_json: JSON.stringify(pack), stage: options.learnStyle && naive ? "style" : "strategy" });
  await logEvent({
    brandId: brand.id,
    campaignId: campaign.id,
    message: `Research done: ${pack.videos.length} short videos to rank, ${pack.ads.length} live ads, ${pack.reddit.length} Reddit threads, ${pack.seo.keywords.length} keywords (${done}/${runs.length} sources)`,
  });
}

async function ensureRuns(campaignId: string, specs: RunSpec[]) {
  for (const spec of specs) {
    const row = { id: newId("run"), campaign_id: campaignId, key: spec.key, phase: spec.phase, provider: spec.provider, endpoint: spec.endpoint, input_json: JSON.stringify(spec.input), status: "pending", created_at: now(), updated_at: now() };
    await store().insert("monid_runs", row, { unique: ["campaign_id", "key"] });
  }
}

async function progressRuns(campaign: CampaignRow, monid: MonidClient) {
  const runs = (await listRuns(campaign.id)).filter((run) => run.status === "pending" || run.status === "running");
  await Promise.all(
    runs.map(async (run) => {
      try {
        if (run.status === "pending") {
          const result = await monid.run(run.provider, run.endpoint, JSON.parse(run.input_json));
          if (TERMINAL.has(result.status)) await finishRun(campaign, run, result);
          else await save("monid_runs", run.id, { run_id: result.runId, status: "running" });
        } else if (run.run_id) {
          const result = await monid.getRun(run.run_id);
          if (TERMINAL.has(result.status)) await finishRun(campaign, run, result);
        }
      } catch (error) {
        if (error instanceof ApiError && error.retryable) return; // try again on the next tick
        await save("monid_runs", run.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        if (error instanceof ApiError && error.outOfCredits) {
          await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: "Monid balance is too low for some research. Top up at app.monid.ai/wallet." });
        }
      }
    }),
  );
}

async function finishRun(campaign: CampaignRow, run: RunRow, result: Awaited<ReturnType<MonidClient["getRun"]>>) {
  const ok = result.status === "COMPLETED" && !providerFailed(result);
  await save("monid_runs", run.id, {
    run_id: result.runId,
    status: ok ? "done" : "failed",
    output_json: ok ? JSON.stringify(result.output ?? null) : null,
    error: ok ? null : result.status === "BLOCKED" ? "blocked by a Monid wallet or budget control" : `${result.status.toLowerCase()}${providerFailed(result) ? ` (provider HTTP ${result.providerResponse?.httpStatus})` : ""}`,
    cost_micro: runCostMicro(result),
  });
  if (result.status === "BLOCKED") await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: "A Monid run was blocked by a wallet or budget control. Top up at app.monid.ai/wallet." });
}

// ---------- references and the product (the "style" stage) ----------

/** What the reference stage keeps on the campaign (in style_json), step by step, so a restart resumes. */
export type CreativeState = {
  slug: null;
  version: null;
  /** A readable summary of the references for the research tab. */
  skill_md: string;
  samples: string[];
  product?: ProductBrief;
  captured?: boolean;
  candidates?: Array<Pick<ReferenceCandidate, "url" | "platform" | "author" | "views" | "followers" | "origin" | "score"> & { relevance?: number; relevance_reason?: string }>;
  /** The relevance screen's verdicts, by URL (done once, before the first breakdown). */
  screened?: Array<{ url: string; relevance: number; reason: string }>;
  /** The candidates picked for a breakdown, saved before the breakdowns start (they take minutes). */
  picked?: string[];
  breakdowns?: ReferenceBreakdown[];
  failures?: Array<{ url: string; error: string }>;
  /** Reference URLs whose breakdown failed for a passing reason, retried once on the next tick. */
  retry?: string[];
};

/** A researched video's lane, from the search that found it. */
export const originOf = (video: Pick<Video, "source">): ReferenceCandidate["origin"] =>
  /^tiktok_comp_/.test(video.source) ? "competitor" : /^tiktok_bench_/.test(video.source) ? "benchmark" : /^scout_/.test(video.source) ? "adjacent" : "category";

export const creativeState = (campaign: Pick<CampaignRow, "style_json">) => parse<CreativeState | null>(campaign.style_json, null);

async function stepStyle(campaign: CampaignRow) {
  const { naive } = clients();
  const brand = (await getBrand(campaign.brand_id))!;
  const log = (message: string, level: "info" | "warn" = "info") => logEvent({ brandId: brand.id, campaignId: campaign.id, level, message });
  if (!naive) {
    await save("campaigns", campaign.id, { stage: "strategy" });
    return log("Skipped the reference study: no Naive key.", "warn");
  }
  const pack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!pack) throw new Error("Research is missing; start a new campaign.");
  const state: CreativeState = creativeState(campaign) ?? { slug: null, version: null, skill_md: "", samples: [] };
  const persist = () => save("campaigns", campaign.id, { style_json: JSON.stringify(state) });
  // Downloads for the product analyst and the reference videos: only needed within one tick.
  const work = join(scratchDir(), `work-${campaign.id}`);
  const toStrategy = async () => {
    await save("campaigns", campaign.id, { stage: "strategy" });
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  };

  if (!state.product) {
    const kit = getBrandKit(brand.id);
    const hasKit = kit.assets.length > 0 || kit.repo !== null;
    state.product = await analyzeProduct(naive, pack, work, hasKit ? kit : null);
    await persist();
    const fromKit = state.product.visuals.filter((v) => v.source.startsWith("brandkit:")).length;
    return log(
      `Product brief: ${state.product.kind}, "${state.product.one_liner}" (${state.product.visuals.length} visuals${fromKit ? `, ${fromKit} from the brand kit` : ""}${kit.repo ? `; code scanned: ${kit.repo.commands.length} commands, ${kit.repo.screens.length} screens` : ""})`,
    );
  }

  if (!state.captured) {
    if (state.product.kind !== "physical") {
      const dir = join(scratchDir(), `visuals-${campaign.id}`);
      try {
        const shots = await captureSiteVisuals(naive, { domain: brand.domain, dir });
        // Production cuts to these on later ticks (on a serverless host, maybe another machine): keep them.
        const kept = await Promise.all(shots.map((shot, i) => keepVisual(`visuals-${campaign.id}`, { ...shot, id: `s${i + 1}` })));
        state.product.visuals.push(...kept);
        await log(`Captured ${shots.length} phone-size screenshots of ${brand.domain} to show the product on screen`);
      } catch (error) {
        if (error instanceof ApiError && error.retryable && campaign.attempts < 3) throw error;
        await log(`Could not screenshot ${brand.domain}: ${error instanceof Error ? error.message : String(error)}`, "warn");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    state.captured = true;
    await persist();
    return;
  }

  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  if (!state.breakdowns || state.retry?.length) {
    const ranked = scoreCandidates(pack.videos, originOf);
    // Numbers pick viral clips; the relevance screen keeps only ones a remake would make sense for.
    if (!state.screened && options.learnStyle && ranked.length) {
      const plan = parse<ResearchPlan | null>(campaign.plan_json, null);
      try {
        state.screened = await screenRelevance(naive, ranked, { product: state.product, scoutNotes: plan?.scout_notes });
      } catch (error) {
        if (error instanceof ApiError && error.retryable && campaign.attempts < 3) throw error;
        state.screened = [];
      }
      const kept = state.screened.filter((r) => r.relevance >= 6).length;
      await log(`Relevance screen: ${kept} of ${state.screened.length} top-ranked videos could be remade for ${state.product.name}${state.screened.length ? ` (dropped: ${state.screened.filter((r) => r.relevance < 6).slice(0, 4).map((r) => r.reason).join("; ")})` : ""}`);
      await persist();
    }
    const candidates = state.screened?.length ? applyRelevance(ranked, state.screened) : ranked;
    const verdicts = new Map((state.screened ?? []).map((r) => [r.url, r]));
    state.candidates = candidates.slice(0, 20).map(({ url, platform, author, views, followers, origin, score }) => ({ url, platform, author, views, followers, origin, score, relevance: verdicts.get(url)?.relevance, relevance_reason: verdicts.get(url)?.reason }));
    // A second pass only retries the breakdowns that failed for a passing reason (a busy provider).
    const picks = state.retry?.length ? ranked.filter((c) => state.retry!.includes(c.url)) : options.learnStyle ? pickForBreakdown(candidates, 6, { keepOrder: Boolean(state.screened?.length) }) : [];
    if (picks.length && !state.retry?.length) {
      // The shortlist shows (the camp's references) while the breakdowns run, which takes minutes.
      state.picked = picks.map((p) => p.url);
      await persist();
      await log(`Breaking down ${picks.length} outlier videos beat by beat (transcript, cuts, frames): ${picks.map((p) => `@${p.author} ${p.score.why}`).join("; ")}`);
    }
    const result = picks.length
      ? await breakdownAll(naive, picks, { workDir: work, brand: { name: state.product.name, one_liner: state.product.one_liner, kind: state.product.kind } })
      : { breakdowns: [] as ReferenceBreakdown[], failures: [] };
    const firstPass = !state.retry?.length;
    state.breakdowns = [...(state.breakdowns ?? []), ...result.breakdowns].sort((a, b) => b.fit.score - a.fit.score);
    state.retry = firstPass ? result.failures.filter((f) => f.retryable).map((f) => f.candidate.url) : [];
    state.failures = [...(state.failures ?? []).filter((f) => !picks.some((p) => p.url === f.url)), ...result.failures.map((f) => ({ url: f.candidate.url, error: f.error }))];
    state.samples = state.breakdowns.map((b) => b.url);
    state.skill_md = referencesMarkdown(state);
    await persist();
    if (state.retry.length) return log(`${state.retry.length} reference video(s) hit a busy provider; retrying them once`, "warn");
    await toStrategy();
    return log(
      state.breakdowns.length
        ? `Reference study ready: ${state.breakdowns.length} videos broken down${state.failures.length ? ` (${state.failures.length} could not be read)` : ""}`
        : "No reference video could be broken down; the director works from the research alone.",
      state.breakdowns.length ? "info" : "warn",
    );
  }
  await toStrategy();
}

/** Keeps a captured image in the store's files and points the visual at a local copy of it. */
async function keepVisual(folder: string, visual: ProductVisual): Promise<ProductVisual> {
  const files = store().files;
  const key = `${folder}/${basename(visual.url)}`;
  await files.putFile(key, visual.url, /\.jpe?g$/i.test(key) ? "image/jpeg" : "image/png");
  return { ...visual, key, url: await files.localPath(key) };
}

/** The research tab's view of the reference study. */
export function referencesMarkdown(state: CreativeState) {
  const lines: string[] = [];
  if (state.product) {
    lines.push(`## Product brief`, ``, `**${state.product.name}** (${state.product.kind}): ${state.product.one_liner}`, ``, `- Problem: ${state.product.problem}`, `- Aha: ${state.product.aha}`, `- Visuals on screen: ${state.product.visuals.map((v) => `${v.id} ${v.caption}`).join("; ") || "none"}`, ``);
  }
  for (const ref of state.breakdowns ?? []) {
    lines.push(
      `## @${ref.author} on ${ref.platform}: ${ref.views.toLocaleString("en")} views${ref.outlier ? `, ${ref.outlier.toFixed(1)}x followers` : ""}`,
      ``,
      `${ref.url} · ${Math.round(ref.duration)} s · ${ref.format} · fit ${ref.fit.score}/10 (${ref.fit.reason})`,
      ``,
      `**Hook** (${ref.hook.mechanic}): "${ref.hook.line}"${ref.hook.on_screen_text ? ` / on screen: "${ref.hook.on_screen_text}"` : ""}`,
      ``,
      ...ref.beats.map((b) => `- ${b.start.toFixed(1)}-${b.end.toFixed(1)}s **${b.job}** (${b.shot}): ${b.visual}${b.line ? ` / "${b.line}"` : ""}`),
      ``,
      `Why it works: ${ref.why_it_works}`,
      ``,
    );
  }
  if (state.failures?.length) lines.push(`Could not read: ${state.failures.map((f) => `${f.url} (${f.error})`).join("; ")}`);
  return lines.join("\n");
}

// ---------- strategy ----------

let strategistId: string | null = null;

async function stepStrategy(campaign: CampaignRow) {
  const { naive } = clients();
  if (!naive) throw new Error("The strategist runs on Naive: add a Naive API key in Settings, then retry.");
  const brand = (await getBrand(campaign.brand_id))!;
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  const pack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!pack) throw new Error("Research is missing; start a new campaign.");
  const state = creativeState(campaign);
  const product = state?.product ?? (await import("./creative/product")).fallbackBrief(pack);
  const breakdowns = state?.breakdowns ?? [];

  // The director's briefs are in: the script room writes each video, then production starts.
  if (campaign.strategy_json) return scriptRoom(campaign, naive, product, breakdowns);

  if (!campaign.strategy_session_id) {
    if (!strategistId) {
      const agent = await naive.findAgent(getSetting("strategist_agent"));
      if (!agent) throw new Error(`Naive has no agent named ${getSetting("strategist_agent")}. Run npm run naive:apply once to create it.`);
      strategistId = agent.id;
    }
    const session = await naive.createSession(
      {
        agent_id: strategistId,
        message: strategyMessage(pack, { product, breakdowns }, options, await pastResults(brand.id, campaign.id)),
        output_schema: STRATEGY_SCHEMA,
        structured_output_required: true,
        budget_micro_usd: 4_000_000,
        metadata: { nomen_campaign: campaign.id, nomen_brand: brand.id },
      },
      campaign.strategy_idem ?? `${campaign.id}-strategy`,
    );
    await save("campaigns", campaign.id, { strategy_session_id: session.id });
    await logEvent({ brandId: brand.id, campaignId: campaign.id, message: `The creative director is choosing which ${breakdowns.length ? "reference videos to transplant" : "patterns to use"} for ${options.concepts} videos` });
    return;
  }

  const session = await naive.getSession(campaign.strategy_session_id);
  await save("campaigns", campaign.id, { strategy_spend_micro: session.consumed_micro_usd ?? 0 });
  if (session.status === "queued" || session.status === "running") return;
  if (session.structured_output && (session.status === "idle" || session.status === "completed")) {
    const strategy = normalizeStrategy(session.structured_output, options, { referenceIds: breakdowns.map((b) => b.id), visualIds: product.visuals.map((v) => v.id) });
    if (!strategy.campaign.briefs?.length) throw new Error("The creative director returned no video briefs.");
    await save("campaigns", campaign.id, { strategy_json: JSON.stringify(strategy) });
    await logEvent({
      brandId: brand.id,
      campaignId: campaign.id,
      message: `Campaign "${strategy.campaign.name}": ${strategy.campaign.briefs.map((b) => `"${b.title}" (${b.format.replace(/_/g, " ")})`).join(", ")}. The script room is writing them.`,
    });
    return;
  }
  if (session.status === "idle" && campaign.strategy_nudges < 2 && session.stop_reason !== "budget_paused") {
    await naive.sendMessage(
      session.id,
      "Finish now: return the complete structured output matching the schema, with every video brief filled in.",
      `${campaign.strategy_idem}-nudge${campaign.strategy_nudges + 1}`,
    );
    await save("campaigns", campaign.id, { strategy_nudges: campaign.strategy_nudges + 1 });
    return;
  }
  throw new Error(`The strategist stopped (${[session.status, session.stop_reason, session.stop_code].filter(Boolean).join(", ")}) without a usable plan.`);
}

/**
 * The script room: every brief gets a writer and a critic in parallel. Finished concepts are saved
 * as they land, so a restart only rewrites the ones that were missing.
 */
async function scriptRoom(campaign: CampaignRow, naive: NaiveClient, product: ProductBrief, breakdowns: ReferenceBreakdown[]) {
  const strategy = parse<Strategy>(campaign.strategy_json, null as unknown as Strategy);
  const briefs = strategy.campaign.briefs ?? [];
  const done = strategy.campaign.concepts ?? [];
  const pending = briefs.filter((brief) => !done.some((concept) => concept.brief?.title === brief.title));
  const round = (strategy.campaign.script_rounds ?? 0) + 1;
  strategy.campaign.script_rounds = round;
  const results = await Promise.allSettled(
    pending.map(async (brief) => {
      const reference = breakdowns.find((b) => b.id === brief.reference_id) ?? breakdowns[0];
      const script = await writeScript(naive, { product, brief, reference: reference ?? emptyReference(), targetSeconds: reference ? targetSeconds(reference, brief.format) : 18 });
      const plan = planProduction(script, brief, product, reference?.delivery ?? "", reference?.beats ?? []);
      return conceptFrom(brief, script, plan, reference, product);
    }),
  );
  const failures: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") done.push(result.value);
    else if (!(result.reason instanceof ApiError && result.reason.retryable) || round >= 4) failures.push(`"${pending[i].title}": ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  strategy.campaign.concepts = briefs.map((brief) => done.find((concept) => concept.brief?.title === brief.title)).filter((c): c is Concept => Boolean(c));
  await save("campaigns", campaign.id, { strategy_json: JSON.stringify(strategy) });
  for (const failure of failures) await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: `The script room could not write ${failure}` });
  const outstanding = briefs.length - strategy.campaign.concepts.length - failures.length;
  if (outstanding > 0) return; // retryable trouble: try the rest next tick
  if (strategy.campaign.concepts.length === 0) throw new Error("The script room could not write any of the videos.");

  // Videos first, then the stage, so a tick that reads "production" always finds them; and only
  // once, so a tick that died in between doesn't add a second set.
  if ((await listCreatives(campaign.id)).length === 0) {
    for (const [idx, concept] of strategy.campaign.concepts.entries()) await insertCreative(campaign.id, idx, concept);
  }
  await save("campaigns", campaign.id, { stage: "production" });
  await logEvent({
    brandId: campaign.brand_id,
    campaignId: campaign.id,
    message: `Scripts ready: ${strategy.campaign.concepts.map((c) => `"${c.title}" ${c.script?.total_seconds ?? "?"}s, critic ${c.script?.review?.score ?? "?"}/10`).join("; ")}. Now producing.`,
  });
}

function emptyReference(): ReferenceBreakdown {
  return {
    id: "",
    url: "",
    platform: "tiktok",
    author: "",
    views: 0,
    followers: null,
    outlier: null,
    duration: 18,
    format: "talking head with product cutaways and captions",
    hook: { line: "", on_screen_text: "", visual: "", mechanic: "a relatable problem stated bluntly in the first second" },
    beats: [],
    pacing: { cuts: 0, avg_shot_seconds: 3, words_per_minute: null },
    caption_style: "bold white captions",
    delivery: "casual, direct",
    why_it_works: "",
    fit: { score: 5, reason: "no reference available" },
    transcript: "",
  };
}

/** What this brand's earlier posted videos did, so the next campaign learns from them. */
async function pastResults(brandId: string, currentCampaignId: string): Promise<PastResult[]> {
  type Post = { creative_id: string; platforms_json: string; status: string; analytics_json: string | null };
  const posts = await store().find<Post>("posts", { brand_id: brandId, status: { in: ["posted", "failed"] } }, { order: [["created_at", "desc"]] });
  const creatives = posts.length ? await store().find<{ id: string; campaign_id: string; concept_json: string }>("creatives", { id: { in: [...new Set(posts.map((p) => p.creative_id))] } }) : [];
  const byId = new Map(creatives.map((c) => [c.id, c]));
  const rows = posts
    .map((post) => ({ post, creative: byId.get(post.creative_id) }))
    .filter((row) => row.creative && row.creative.campaign_id !== currentCampaignId)
    .slice(0, 12)
    .map(({ post, creative }) => ({ concept_json: creative!.concept_json, platforms_json: post.platforms_json, status: post.status, analytics_json: post.analytics_json }));
  return rows.map((row) => {
    const concept = parse<Partial<Concept>>(row.concept_json, {});
    return {
      title: concept.title ?? "",
      format: concept.format ?? "",
      hook: concept.hook ?? "",
      platforms: parse<string[]>(row.platforms_json, []),
      status: row.status,
      analytics: parse<Record<string, unknown> | null>(row.analytics_json, null),
    };
  });
}

// ---------- production ----------

async function stepProduction(campaign: CampaignRow) {
  const { naive, monid } = clients();
  const strategy = parse<Strategy | null>(campaign.strategy_json, null);
  if (!strategy) throw new Error("The campaign has no strategy yet.");
  // Read once per tick; flipped (and saved) the moment Naive runs out.
  let naiveOut = Boolean(campaign.naive_out);
  const ctx = {
    campaignId: campaign.id,
    brandId: campaign.brand_id,
    naive,
    monid,
    strategy,
    product: creativeState(campaign)?.product,
    kit: (() => {
      const kit = getBrandKit(campaign.brand_id);
      return kit.assets.length || kit.repo ? kit : null;
    })(),
    naiveOut: () => naiveOut,
    markNaiveOut: async () => {
      if (naiveOut) return;
      naiveOut = true;
      await save("campaigns", campaign.id, { naive_out: 1 });
      await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: "Naive is out of credits: new renders switch to Kling 3.0 on Monid. Top up Naive to switch back." });
    },
  };
  const active = (await listCreatives(campaign.id)).filter((creative) => !creative.rejected);
  await Promise.all(active.filter((c) => c.status === "queued" || c.status === "producing").map((creative) => advanceCreative(ctx, creative)));
  const now_ = (await listCreatives(campaign.id)).filter((creative) => !creative.rejected);
  if (now_.every((creative) => creative.status === "ready" || creative.status === "failed")) {
    const ready = now_.filter((creative) => creative.status === "ready").length;
    await save("campaigns", campaign.id, { stage: "review", status: "review" });
    await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, message: `${ready} of ${now_.length} videos are ready for review` });
    if (getBool("autopilot") && ready > 0) {
      const { approveAll, publishCampaign } = await import("./publish");
      await approveAll(campaign.id);
      await publishCampaign(campaign.id, "daily").catch((error: unknown) =>
        logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: `Autopilot could not schedule posts: ${error instanceof Error ? error.message : String(error)}` }),
      );
    }
  }
}

/** A fresh take on one concept, optionally steered by a note from the reviewer. */
export async function regenerateCreative(creativeId: string, note?: string) {
  const [creative] = await store().find<CreativeRow>("creatives", { id: creativeId }, { limit: 1 });
  if (!creative) throw new Error("No such video");
  const campaign = (await getCampaign(creative.campaign_id))!;
  const concept = parse<Concept>(creative.concept_json, null as unknown as Concept);
  if (note?.trim()) {
    concept.shots = concept.shots.map((shot) => ({ ...shot, video_prompt: `${shot.video_prompt}\nDirector's note for this take: ${note.trim()}`, frame_prompt: `${shot.frame_prompt}\nDirector's note: ${note.trim()}` }));
  }
  await save("creatives", creative.id, { rejected: 1, approved: 0 });
  const id = await insertCreative(campaign.id, creative.idx, concept, creative.generation + 1);
  await save("campaigns", campaign.id, { stage: "production", status: "running", error: null });
  await logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, message: `Re-rendering "${concept.title}"${note?.trim() ? ` with the note: ${note.trim()}` : ""}` });
  return id;
}

/** Stops a campaign where it is. A running strategist session is cancelled so it stops spending. */
export async function stopCampaign(id: string) {
  const campaign = await getCampaign(id);
  if (!campaign) throw new Error("No such campaign");
  await save("campaigns", id, { status: "stopped", error: "Stopped by you" });
  const { naive } = clients();
  if (naive && campaign.stage === "strategy" && campaign.strategy_session_id) await naive.cancelSession(campaign.strategy_session_id).catch(() => undefined);
  await logEvent({ brandId: campaign.brand_id, campaignId: id, level: "warn", message: `Stopped at ${campaign.stage}` });
}

export async function retryCampaign(id: string) {
  const campaign = await getCampaign(id);
  if (!campaign) throw new Error("No such campaign");
  if (campaign.stage === "research") await store().update("monid_runs", { campaign_id: id, status: "failed" }, { status: "pending", run_id: null, error: null });
  if (campaign.stage === "strategy" && campaign.strategy_session_id) await save("campaigns", id, { strategy_session_id: null, strategy_idem: `${id}-strategy-${Date.now()}`, strategy_nudges: 0 });
  if (campaign.stage === "production") {
    for (const creative of (await listCreatives(id)).filter((c) => c.status === "failed" && !c.rejected)) await regenerateCreative(creative.id);
  }
  await save("campaigns", id, { status: "running", error: null, attempts: 0 });
  await logEvent({ brandId: campaign.brand_id, campaignId: id, message: `Retrying from ${campaign.stage}` });
}

export async function recomputeSpend(campaignId: string) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return;
  const research = (await listRuns(campaignId)).reduce((sum, run) => sum + (run.cost_micro ?? 0), 0);
  let naiveVideo = 0;
  let monidVideo = 0;
  for (const creative of await listCreatives(campaignId)) {
    for (const shot of parse<ShotState[]>(creative.shots_json, [])) {
      naiveVideo += shot.naive_cost;
      monidVideo += shot.monid_cost;
    }
  }
  await save("campaigns", campaignId, {
    naive_spend_micro: campaign.style_spend_micro + campaign.strategy_spend_micro + naiveVideo,
    monid_spend_micro: research + monidVideo,
  });
}
