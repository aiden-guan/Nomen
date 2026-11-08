import { logEvent, newId, now, parse, save, store } from "./db";
import { ApiError } from "./http";
import { MonidClient } from "./monid";
import { NaiveClient } from "./naive";
import { advanceCreative, type CreativeRow, insertCreative, type ShotState } from "./production";
import { studyCandidates, studyFormat } from "./format";
import { compactResearch, fallbackPlan, phaseASpecs, phaseCSpecs, planResearch, type ResearchPack, type ResearchPlan } from "./research";
import { ensureRuns, listRuns, progressRuns, requeueFailedRuns } from "./runs";
import { getBool, getInt, getSetting } from "./settings";
import { type Concept, normalizeStrategy, type PastResult, STRATEGY_SCHEMA, type Strategy, strategyMessage } from "./strategy";

// The campaign state machine. The worker calls advanceCampaign() every few seconds; every step is
// idempotent, so a restart picks up exactly where it stopped. Rows live in the store (src/lib/store):
// SQLite locally, Convex on serverless hosts, so every read and write is awaited.

export type CampaignStage = "research" | "style" | "strategy" | "production" | "review" | "live";
export type CampaignStatus = "running" | "review" | "publishing" | "live" | "failed" | "stopped";

/** concepts is the number of videos; 0 makes a static-ads-only campaign. statics starts a static ad pack when research is done. */
export type CampaignOptions = { concepts: number; shotsPerConcept: number; secondsPerShot: number; videoModel: string; learnStyle: boolean; statics?: boolean };

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

export const getBrand = async (id: string) => (await store().find<BrandRow>("brands", { id }, { limit: 1 }))[0];
export const getCampaign = async (id: string) => (await store().find<CampaignRow>("campaigns", { id }, { limit: 1 }))[0];
export const listCreatives = (campaignId: string) => store().find<CreativeRow>("creatives", { campaign_id: campaignId }, { order: [["idx", "asc"], ["generation", "asc"]] });

export function defaultOptions(): CampaignOptions {
  return {
    concepts: Math.max(1, Math.min(8, getInt("videos_per_campaign"))),
    shotsPerConcept: Math.max(1, Math.min(3, getInt("shots_per_video"))),
    secondsPerShot: Math.max(4, Math.min(10, getInt("video_seconds"))),
    videoModel: getSetting("video_model"),
    learnStyle: getBool("learn_style"),
    statics: getBool("static_ads_auto"),
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
  await logEvent({
    brandId,
    campaignId: id,
    message: options.concepts > 0 ? `Campaign started: ${options.concepts} videos, ${options.shotsPerConcept} shots each, ${options.videoModel}${options.statics ? ", plus static ads" : ""}` : "Campaign started: research and static ads, no videos",
  });
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
  await progressRuns({ campaignId: campaign.id, brandId: campaign.brand_id }, monid, ["A", "C"]);
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
  const pack = compactResearch(brand.domain, forCompact, plan);
  const done = runs.filter((run) => run.status === "done").length;
  if (done === 0) throw new Error("Every research source failed. Check the website address and your Monid balance, then retry.");
  const options = parse<CampaignOptions>(campaign.options_json, defaultOptions());
  const videos = options.concepts > 0;
  await save("campaigns", campaign.id, videos ? { research_json: JSON.stringify(pack), stage: options.learnStyle && naive ? "style" : "strategy" } : { research_json: JSON.stringify(pack), stage: "review", status: "review" });
  await logEvent({
    brandId: brand.id,
    campaignId: campaign.id,
    message: `Research done: ${pack.videos.length} top videos, ${pack.ads.length} live ads, ${pack.reddit.length} Reddit threads, ${pack.seo.keywords.length} keywords (${done}/${runs.length} sources)`,
  });
  if (options.statics || !videos) {
    // Static packs keep their tables and renders on the local disk, so they need the SQLite store.
    if (store().kind !== "sqlite") {
      await logEvent({ brandId: brand.id, campaignId: campaign.id, level: "warn", message: "Static ads aren't available on this deployment yet: they still keep their data on the local disk." });
    } else {
      const { startStaticPack } = await import("./statics/pipeline");
      await startStaticPack(campaign.id);
    }
  }
}

// ---------- format study ----------

async function stepStyle(campaign: CampaignRow) {
  const { naive } = clients();
  const brand = (await getBrand(campaign.brand_id))!;
  const toStrategy = async (message: string, level: "info" | "warn" = "info") => {
    await save("campaigns", campaign.id, { stage: "strategy" });
    await logEvent({ brandId: brand.id, campaignId: campaign.id, level, message });
  };
  if (!naive) return toStrategy("Skipped the format study: no Naive key.", "warn");
  const pack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!pack || studyCandidates(pack).length === 0) return toStrategy("No downloadable top videos to study; the strategist works from the research alone.");
  await logEvent({ brandId: brand.id, campaignId: campaign.id, message: `Studying the format of ${studyCandidates(pack).length} top-performing videos frame by frame` });
  try {
    const study = await studyFormat(naive, pack, campaign.id);
    if (!study) return toStrategy("The top videos could not be downloaded for the format study; the strategist works from the research alone.", "warn");
    await save("campaigns", campaign.id, { stage: "strategy", style_json: JSON.stringify({ slug: null, version: null, skill_md: study.markdown, samples: study.urls }) });
    await logEvent({ brandId: brand.id, campaignId: campaign.id, message: `Format study ready: ${study.urls.length} top videos analyzed` });
  } catch (error) {
    if (error instanceof ApiError && error.retryable) throw error;
    await toStrategy(`Skipped the format study: ${error instanceof Error ? error.message : String(error)}`, "warn");
  }
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
        message: strategyMessage(pack, style, options, await pastResults(brand.id, campaign.id)),
        output_schema: STRATEGY_SCHEMA,
        structured_output_required: true,
        budget_micro_usd: 4_000_000,
        metadata: { nomen_campaign: campaign.id, nomen_brand: brand.id },
      },
      campaign.strategy_idem ?? `${campaign.id}-strategy`,
    );
    await save("campaigns", campaign.id, { strategy_session_id: session.id });
    await logEvent({ brandId: brand.id, campaignId: campaign.id, message: `The strategist is writing the brand brief and ${options.concepts} concepts` });
    return;
  }

  const session = await naive.getSession(campaign.strategy_session_id);
  await save("campaigns", campaign.id, { strategy_spend_micro: session.consumed_micro_usd ?? 0 });
  if (session.status === "queued" || session.status === "running") return;
  if (session.structured_output && (session.status === "idle" || session.status === "completed")) {
    const strategy = normalizeStrategy(session.structured_output, options, pack);
    if (strategy.campaign.concepts.length === 0) throw new Error("The strategist returned no concepts.");
    // Videos first, then the stage, so a tick that reads "production" always finds them; and only
    // once, so a tick that died in between doesn't add a second set.
    if ((await listCreatives(campaign.id)).length === 0) {
      for (const [idx, concept] of strategy.campaign.concepts.entries()) await insertCreative(campaign.id, idx, concept);
    }
    await save("campaigns", campaign.id, { strategy_json: JSON.stringify(strategy), stage: "production" });
    await logEvent({ brandId: brand.id, campaignId: campaign.id, message: `Campaign "${strategy.campaign.name}": ${strategy.campaign.concepts.length} concepts, now producing` });
    return;
  }
  if (session.status === "idle" && campaign.strategy_nudges < 2 && session.stop_reason !== "budget_paused") {
    await naive.sendMessage(
      session.id,
      "Finish now: return the complete structured output matching the schema, with every concept and every shot filled in.",
      `${campaign.strategy_idem}-nudge${campaign.strategy_nudges + 1}`,
    );
    await save("campaigns", campaign.id, { strategy_nudges: campaign.strategy_nudges + 1 });
    return;
  }
  throw new Error(`The strategist stopped (${[session.status, session.stop_reason, session.stop_code].filter(Boolean).join(", ")}) without a usable plan.`);
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
  if (campaign.stage === "research") await requeueFailedRuns(id, ["A", "C"]);
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
  const research = (await listRuns(campaignId, ["A", "C", "S"])).reduce((sum, run) => sum + (run.cost_micro ?? 0), 0);
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
