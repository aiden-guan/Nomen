import { db, logEvent, newId, now, parse, update } from "./db";
import { ApiError } from "./http";
import { MonidClient, providerFailed, runCostMicro, TERMINAL } from "./monid";
import { NaiveClient } from "./naive";
import { advanceCreative, type CreativeRow, insertCreative, type ShotState } from "./production";
import { studyCandidates, studyFormat } from "./format";
import { compactResearch, fallbackPlan, phaseASpecs, phaseCSpecs, planResearch, type ResearchPack, type ResearchPlan, type RunSpec } from "./research";
import { getBool, getInt, getSetting } from "./settings";
import { type Concept, normalizeStrategy, STRATEGY_SCHEMA, type Strategy, strategyMessage } from "./strategy";

// The campaign state machine. The worker calls advanceCampaign() every few seconds; every step is
// idempotent, so a restart picks up exactly where it stopped.

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

export const getBrand = (id: string) => db().prepare("select * from brands where id = ?").get(id) as BrandRow | undefined;
export const getCampaign = (id: string) => db().prepare("select * from campaigns where id = ?").get(id) as CampaignRow | undefined;
export const listCreatives = (campaignId: string) => db().prepare("select * from creatives where campaign_id = ? order by idx, generation").all(campaignId) as CreativeRow[];
const listRuns = (campaignId: string) => db().prepare("select * from monid_runs where campaign_id = ? order by created_at").all(campaignId) as RunRow[];

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

export function createBrand(input: string) {
  const { domain, url } = normalizeDomain(input);
  const existing = db().prepare("select * from brands where domain = ?").get(domain) as BrandRow | undefined;
  if (existing) return existing.id;
  const id = newId("brd");
  const name = domain.split(".")[0];
  db().prepare("insert into brands (id, name, domain, url, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run(id, name[0].toUpperCase() + name.slice(1), domain, url, now(), now());
  return id;
}

export function startCampaign(brandId: string, options: CampaignOptions = defaultOptions()) {
  const id = newId("cmp");
  db()
    .prepare(
      `insert into campaigns (id, brand_id, status, stage, options_json, style_idem, strategy_idem, created_at, updated_at)
       values (?, ?, 'running', 'research', ?, ?, ?, ?, ?)`,
    )
    .run(id, brandId, JSON.stringify(options), `${id}-style`, `${id}-strategy`, now(), now());
  logEvent({ brandId, campaignId: id, message: `Campaign started: ${options.concepts} videos, ${options.shotsPerConcept} shots each, ${options.videoModel}` });
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
  const campaign = getCampaign(id);
  if (!campaign || campaign.status !== "running") return;
  try {
    if (campaign.stage === "research") await stepResearch(campaign);
    else if (campaign.stage === "style") await stepStyle(campaign);
    else if (campaign.stage === "strategy") await stepStrategy(campaign);
    else if (campaign.stage === "production") await stepProduction(campaign);
    if (campaign.attempts) update("campaigns", id, { attempts: 0 });
  } catch (error) {
    if (error instanceof ApiError && error.retryable && campaign.attempts < 10) {
      update("campaigns", id, { attempts: campaign.attempts + 1 });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      update("campaigns", id, { status: "failed", error: message });
      logEvent({ brandId: campaign.brand_id, campaignId: id, level: "error", message: `Stopped at ${campaign.stage}: ${message}` });
    }
  }
  recomputeSpend(id);
}

// ---------- research ----------

async function stepResearch(campaign: CampaignRow) {
  const { monid, naive } = clients();
  if (!monid) throw new Error("Research runs on Monid: add a Monid API key in Settings, then retry.");
  const brand = getBrand(campaign.brand_id)!;
  ensureRuns(campaign.id, phaseASpecs(brand.domain));
  await progressRuns(campaign, monid);
  const runs = listRuns(campaign.id);
  if (runs.some((run) => run.status === "pending" || run.status === "running")) return;

  const forCompact = runs.map((run) => ({ key: run.key, status: run.status, output: parse<unknown>(run.output_json, undefined) }));
  if (!campaign.plan_json) {
    const partial = compactResearch(brand.domain, forCompact, null);
    db().prepare("update brands set name = ?, profile_json = ?, updated_at = ? where id = ?").run(partial.brand.name || brand.name, JSON.stringify(partial.brand), now(), brand.id);
    const plan: ResearchPlan = naive
      ? await planResearch(naive, { domain: brand.domain, brand: partial.brand, siteExcerpt: partial.site_excerpt, similar: partial.similar_sites })
      : fallbackPlan(brand.domain, partial.brand, partial.similar_sites);
    update("campaigns", campaign.id, { plan_json: JSON.stringify(plan) });
    ensureRuns(campaign.id, phaseCSpecs(plan));
    logEvent({
      brandId: brand.id,
      campaignId: campaign.id,
      message: `Research plan: ${plan.category}; competitors ${plan.competitors.map((c) => c.name).join(", ") || "unknown"}; searching ${plan.content_queries.join(", ")}`,
    });
    return;
  }

  const plan = parse<ResearchPlan | null>(campaign.plan_json, null);
  const pack = compactResearch(brand.domain, forCompact, plan);
  const done = runs.filter((run) => run.status === "done").length;
  if (done === 0) throw new Error("Every research source failed. Check the website address and your Monid balance, then retry.");
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  update("campaigns", campaign.id, { research_json: JSON.stringify(pack), stage: options.learnStyle && naive ? "style" : "strategy" });
  logEvent({
    brandId: brand.id,
    campaignId: campaign.id,
    message: `Research done: ${pack.videos.length} top videos, ${pack.ads.length} live ads, ${pack.reddit.length} Reddit threads, ${pack.seo.keywords.length} keywords (${done}/${runs.length} sources)`,
  });
}

function ensureRuns(campaignId: string, specs: RunSpec[]) {
  const insert = db().prepare(
    `insert into monid_runs (id, campaign_id, key, phase, provider, endpoint, input_json, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) on conflict (campaign_id, key) do nothing`,
  );
  for (const spec of specs) insert.run(newId("run"), campaignId, spec.key, spec.phase, spec.provider, spec.endpoint, JSON.stringify(spec.input), now(), now());
}

async function progressRuns(campaign: CampaignRow, monid: MonidClient) {
  const runs = listRuns(campaign.id).filter((run) => run.status === "pending" || run.status === "running");
  await Promise.all(
    runs.map(async (run) => {
      try {
        if (run.status === "pending") {
          const result = await monid.run(run.provider, run.endpoint, JSON.parse(run.input_json));
          if (TERMINAL.has(result.status)) finishRun(campaign, run, result);
          else update("monid_runs", run.id, { run_id: result.runId, status: "running" });
        } else if (run.run_id) {
          const result = await monid.getRun(run.run_id);
          if (TERMINAL.has(result.status)) finishRun(campaign, run, result);
        }
      } catch (error) {
        if (error instanceof ApiError && error.retryable) return; // try again on the next tick
        update("monid_runs", run.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        if (error instanceof ApiError && error.outOfCredits) {
          logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: "Monid balance is too low for some research. Top up at app.monid.ai/wallet." });
        }
      }
    }),
  );
}

function finishRun(campaign: CampaignRow, run: RunRow, result: Awaited<ReturnType<MonidClient["getRun"]>>) {
  const ok = result.status === "COMPLETED" && !providerFailed(result);
  update("monid_runs", run.id, {
    run_id: result.runId,
    status: ok ? "done" : "failed",
    output_json: ok ? JSON.stringify(result.output ?? null) : null,
    error: ok ? null : result.status === "BLOCKED" ? "blocked by a Monid wallet or budget control" : `${result.status.toLowerCase()}${providerFailed(result) ? ` (provider HTTP ${result.providerResponse?.httpStatus})` : ""}`,
    cost_micro: runCostMicro(result),
  });
  if (result.status === "BLOCKED") logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: "A Monid run was blocked by a wallet or budget control. Top up at app.monid.ai/wallet." });
}

// ---------- format study ----------

async function stepStyle(campaign: CampaignRow) {
  const { naive } = clients();
  const brand = getBrand(campaign.brand_id)!;
  const toStrategy = (message: string, level: "info" | "warn" = "info") => {
    update("campaigns", campaign.id, { stage: "strategy" });
    logEvent({ brandId: brand.id, campaignId: campaign.id, level, message });
  };
  if (!naive) return toStrategy("Skipped the format study: no Naive key.", "warn");
  const pack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!pack || studyCandidates(pack).length === 0) return toStrategy("No downloadable top videos to study; the strategist works from the research alone.");
  logEvent({ brandId: brand.id, campaignId: campaign.id, message: `Studying the format of ${studyCandidates(pack).length} top-performing videos frame by frame` });
  try {
    const study = await studyFormat(naive, pack, campaign.id);
    if (!study) return toStrategy("The top videos could not be downloaded for the format study; the strategist works from the research alone.", "warn");
    update("campaigns", campaign.id, { stage: "strategy", style_json: JSON.stringify({ slug: null, version: null, skill_md: study.markdown, samples: study.urls }) });
    logEvent({ brandId: brand.id, campaignId: campaign.id, message: `Format study ready: ${study.urls.length} top videos analyzed` });
  } catch (error) {
    if (error instanceof ApiError && error.retryable) throw error;
    toStrategy(`Skipped the format study: ${error instanceof Error ? error.message : String(error)}`, "warn");
  }
}

// ---------- strategy ----------

let strategistId: string | null = null;

async function stepStrategy(campaign: CampaignRow) {
  const { naive } = clients();
  if (!naive) throw new Error("The strategist runs on Naive: add a Naive API key in Settings, then retry.");
  const brand = getBrand(campaign.brand_id)!;
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  const pack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!pack) throw new Error("Research is missing; start a new campaign.");

  if (!campaign.strategy_session_id) {
    if (!strategistId) {
      const agent = await naive.findAgent(getSetting("strategist_agent"));
      if (!agent) throw new Error(`Naive has no agent named ${getSetting("strategist_agent")}. Run npm run naive:apply once to create it.`);
      strategistId = agent.id;
    }
    const style = parse<{ skill_md: string } | null>(campaign.style_json, null);
    const session = await naive.createSession(
      {
        agent_id: strategistId,
        message: strategyMessage(pack, style, options),
        output_schema: STRATEGY_SCHEMA,
        structured_output_required: true,
        budget_micro_usd: 4_000_000,
        metadata: { nomen_campaign: campaign.id, nomen_brand: brand.id },
      },
      campaign.strategy_idem ?? `${campaign.id}-strategy`,
    );
    update("campaigns", campaign.id, { strategy_session_id: session.id });
    logEvent({ brandId: brand.id, campaignId: campaign.id, message: `The strategist is writing the brand brief and ${options.concepts} concepts` });
    return;
  }

  const session = await naive.getSession(campaign.strategy_session_id);
  update("campaigns", campaign.id, { strategy_spend_micro: session.consumed_micro_usd ?? 0 });
  if (session.status === "queued" || session.status === "running") return;
  if (session.structured_output && (session.status === "idle" || session.status === "completed")) {
    const strategy = normalizeStrategy(session.structured_output, options, pack);
    if (strategy.campaign.concepts.length === 0) throw new Error("The strategist returned no concepts.");
    update("campaigns", campaign.id, { strategy_json: JSON.stringify(strategy), stage: "production" });
    strategy.campaign.concepts.forEach((concept, idx) => insertCreative(campaign.id, idx, concept));
    logEvent({ brandId: brand.id, campaignId: campaign.id, message: `Campaign "${strategy.campaign.name}": ${strategy.campaign.concepts.length} concepts, now producing` });
    return;
  }
  if (session.status === "idle" && campaign.strategy_nudges < 2 && session.stop_reason !== "budget_paused") {
    await naive.sendMessage(
      session.id,
      "Finish now: return the complete structured output matching the schema, with every concept and every shot filled in.",
      `${campaign.strategy_idem}-nudge${campaign.strategy_nudges + 1}`,
    );
    update("campaigns", campaign.id, { strategy_nudges: campaign.strategy_nudges + 1 });
    return;
  }
  throw new Error(`The strategist stopped (${[session.status, session.stop_reason, session.stop_code].filter(Boolean).join(", ")}) without a usable plan.`);
}

// ---------- production ----------

async function stepProduction(campaign: CampaignRow) {
  const { naive, monid } = clients();
  const strategy = parse<Strategy | null>(campaign.strategy_json, null);
  if (!strategy) throw new Error("The campaign has no strategy yet.");
  const ctx = {
    campaignId: campaign.id,
    brandId: campaign.brand_id,
    naive,
    monid,
    strategy,
    naiveOut: () => Boolean(getCampaign(campaign.id)?.naive_out),
    markNaiveOut: () => {
      if (getCampaign(campaign.id)?.naive_out) return;
      update("campaigns", campaign.id, { naive_out: 1 });
      logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: "Naive is out of credits: new renders switch to Kling 3.0 on Monid. Top up Naive to switch back." });
    },
  };
  const active = listCreatives(campaign.id).filter((creative) => !creative.rejected);
  await Promise.all(active.filter((c) => c.status === "queued" || c.status === "producing").map((creative) => advanceCreative(ctx, creative)));
  const now_ = listCreatives(campaign.id).filter((creative) => !creative.rejected);
  if (now_.every((creative) => creative.status === "ready" || creative.status === "failed")) {
    const ready = now_.filter((creative) => creative.status === "ready").length;
    update("campaigns", campaign.id, { stage: "review", status: "review" });
    logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, message: `${ready} of ${now_.length} videos are ready for review` });
    if (getBool("autopilot") && ready > 0) {
      const { approveAll, publishCampaign } = await import("./publish");
      approveAll(campaign.id);
      await publishCampaign(campaign.id, "daily").catch((error: unknown) =>
        logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, level: "warn", message: `Autopilot could not schedule posts: ${error instanceof Error ? error.message : String(error)}` }),
      );
    }
  }
}

/** A fresh take on one concept, optionally steered by a note from the reviewer. */
export function regenerateCreative(creativeId: string, note?: string) {
  const creative = db().prepare("select * from creatives where id = ?").get(creativeId) as CreativeRow | undefined;
  if (!creative) throw new Error("No such video");
  const campaign = getCampaign(creative.campaign_id)!;
  const concept = parse<Concept>(creative.concept_json, null as unknown as Concept);
  if (note?.trim()) {
    concept.shots = concept.shots.map((shot) => ({ ...shot, video_prompt: `${shot.video_prompt}\nDirector's note for this take: ${note.trim()}`, frame_prompt: `${shot.frame_prompt}\nDirector's note: ${note.trim()}` }));
  }
  update("creatives", creative.id, { rejected: 1, approved: 0 });
  const id = insertCreative(campaign.id, creative.idx, concept, creative.generation + 1);
  update("campaigns", campaign.id, { stage: "production", status: "running", error: null });
  logEvent({ brandId: campaign.brand_id, campaignId: campaign.id, message: `Re-rendering "${concept.title}"${note?.trim() ? ` with the note: ${note.trim()}` : ""}` });
  return id;
}

/** Stops a campaign where it is. A running strategist session is cancelled so it stops spending. */
export async function stopCampaign(id: string) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error("No such campaign");
  update("campaigns", id, { status: "stopped", error: "Stopped by you" });
  const { naive } = clients();
  if (naive && campaign.stage === "strategy" && campaign.strategy_session_id) await naive.cancelSession(campaign.strategy_session_id).catch(() => undefined);
  logEvent({ brandId: campaign.brand_id, campaignId: id, level: "warn", message: `Stopped at ${campaign.stage}` });
}

export function retryCampaign(id: string) {
  const campaign = getCampaign(id);
  if (!campaign) throw new Error("No such campaign");
  if (campaign.stage === "research") db().prepare("update monid_runs set status = 'pending', run_id = null, error = null where campaign_id = ? and status = 'failed'").run(id);
  if (campaign.stage === "strategy" && campaign.strategy_session_id) update("campaigns", id, { strategy_session_id: null, strategy_idem: `${id}-strategy-${Date.now()}`, strategy_nudges: 0 });
  if (campaign.stage === "production") {
    for (const creative of listCreatives(id).filter((c) => c.status === "failed" && !c.rejected)) regenerateCreative(creative.id);
  }
  update("campaigns", id, { status: "running", error: null, attempts: 0 });
  logEvent({ brandId: campaign.brand_id, campaignId: id, message: `Retrying from ${campaign.stage}` });
}

export function recomputeSpend(campaignId: string) {
  const campaign = getCampaign(campaignId);
  if (!campaign) return;
  const research = (db().prepare("select coalesce(sum(cost_micro), 0) total from monid_runs where campaign_id = ?").get(campaignId) as { total: number }).total;
  let naiveVideo = 0;
  let monidVideo = 0;
  for (const creative of listCreatives(campaignId)) {
    for (const shot of parse<ShotState[]>(creative.shots_json, [])) {
      naiveVideo += shot.naive_cost;
      monidVideo += shot.monid_cost;
    }
  }
  update("campaigns", campaignId, {
    naive_spend_micro: campaign.style_spend_micro + campaign.strategy_spend_micro + naiveVideo,
    monid_spend_micro: research + monidVideo,
  });
}
