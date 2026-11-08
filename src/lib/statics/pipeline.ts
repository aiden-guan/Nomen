import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db, logEvent, newId, now, parse, store, update as updateSqlite } from "../db";
import { ApiError } from "../http";
import { download } from "../media";
import { recomputeSpend } from "../pipeline";
import { MonidClient } from "../monid";
import { NaiveClient } from "../naive";
import { record, type ResearchPack, type ResearchPlan, text } from "../research";
import { ensureRuns, listRuns, progressRuns, requeueFailedRuns } from "../runs";
import { mediaRoot } from "../store/sqlite";
import { getBool, getInt, getSetting } from "../settings";
import type { Strategy } from "../strategy";
import { palette } from "./color";
import type { AdInput, LogoAsset, VisualAsset } from "./layouts";
import { reviewStatic, type StaticVerdict } from "./qc";
import { logoAsset, normalizeImage, renderAdFile, renderLogoPng, visualAsset } from "./render";
import { compactStatics, planStatics, type StaticPlan, type StaticResearch, staticSpecs } from "./research";
import { LOGO_PLACEMENTS, PLACEMENTS } from "./specs";
import { type Study, studyStatics } from "./study";
import { checkAll, checkSearchAssets, type Concept, downgrade, siteCorpus, writeConcepts, writeSearchAssets, type WriterInput } from "./writer";
import type { SearchAssets } from "./validate";

// The static ad pack: research fan-out → study → copy → pictures → every placement rendered →
// checked. The worker calls advanceStatics() every few seconds; each step is idempotent, so a
// restart resumes where it stopped. It works from a campaign's existing research.
//
// The pack's own tables (static_packs, static_ads) and its renders live in SQLite and under
// data/media, like the phones track: static ads don't run on a Convex deployment yet. Campaigns,
// research runs and events are the core's, read and written through the store.

export type PackStage = "research" | "study" | "write" | "produce" | "ready";
export type PackStatus = "running" | "ready" | "failed" | "stopped";

export type PackRow = {
  id: string;
  campaign_id: string;
  brand_id: string;
  status: PackStatus;
  stage: PackStage;
  error: string | null;
  attempts: number;
  options_json: string;
  plan_json: string | null;
  research_json: string | null;
  study_json: string | null;
  search_json: string | null;
  assets_json: string | null;
  tokens_in: number;
  tokens_out: number;
  image_cost_micro: number;
  created_at: string;
  updated_at: string;
};

export type StaticAdRow = {
  id: string;
  pack_id: string;
  idx: number;
  generation: number;
  concept_json: string;
  status: "queued" | "visual" | "rendering" | "checking" | "ready" | "failed";
  visual_json: string | null;
  renders_json: string | null;
  qc_json: string | null;
  approved: number;
  rejected: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type VisualState = { kind: "screenshot" | "site_photo" | "generated" | "none"; file: string | null; attempts: number; cost_micro: number; note?: string; error?: string };
export type Render = { placement: string; file: string; width: number; height: number; bytes: number };
export type PackAssets = { logo: { file: string; hint: string } | null; screenshot: string | null };

export const packDir = (packId: string) => join(mediaRoot(), "statics", packId);

const SCHEMA = `
create table if not exists static_packs (
  id text primary key,
  campaign_id text not null references campaigns(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  status text not null,
  stage text not null,
  error text,
  attempts integer not null default 0,
  options_json text not null,
  plan_json text,
  research_json text,
  study_json text,
  search_json text,
  assets_json text,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  image_cost_micro integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create table if not exists static_ads (
  id text primary key,
  pack_id text not null references static_packs(id) on delete cascade,
  idx integer not null,
  generation integer not null default 1,
  concept_json text not null,
  status text not null,
  visual_json text,
  renders_json text,
  qc_json text,
  approved integer not null default 0,
  rejected integer not null default 0,
  error text,
  created_at text not null,
  updated_at text not null
);

create index if not exists static_packs_campaign on static_packs (campaign_id, created_at);
create index if not exists static_ads_pack on static_ads (pack_id, idx);
`;

let ready = false;

/** Whether this deployment can make static ads: they need the SQLite store and a local disk. */
export const staticsAvailable = () => store().kind === "sqlite";

/** The SQLite connection, with the static ad tables created on first use. */
export function staticsDb() {
  if (!staticsAvailable()) throw new Error("Static ads aren't available on this deployment yet: they still keep their data on the local disk.");
  const conn = db();
  if (!ready) {
    conn.exec(SCHEMA);
    ready = true;
  }
  return conn;
}

/** Test hook: the next call re-runs the schema (after a test swaps the database). */
export function resetStaticsSchemaFlag() {
  ready = false;
}

function update(table: "static_packs" | "static_ads", id: string, fields: Record<string, unknown>) {
  staticsDb();
  updateSqlite(table, id, fields);
}
export const adDir = (packId: string, adId: string) => join(packDir(packId), adId);

export const getPack = (id: string) => staticsDb().prepare("select * from static_packs where id = ?").get(id) as PackRow | undefined;
export const latestPack = (campaignId: string) => staticsDb().prepare("select * from static_packs where campaign_id = ? order by created_at desc limit 1").get(campaignId) as PackRow | undefined;
export const listStaticAds = (packId: string) => staticsDb().prepare("select * from static_ads where pack_id = ? order by idx, generation").all(packId) as StaticAdRow[];
export const getStaticAd = (id: string) => staticsDb().prepare("select * from static_ads where id = ?").get(id) as StaticAdRow | undefined;

type CampaignLite = { id: string; brand_id: string; plan_json: string | null; research_json: string | null; strategy_json: string | null };
const campaignOf = async (id: string) => (await store().find<CampaignLite>("campaigns", { id }, { limit: 1 }))[0];

/** Starts a pack for a campaign (once its research exists). Returns the running pack if there is one. */
export async function startStaticPack(campaignId: string, opts: { concepts?: number } = {}) {
  const campaign = await campaignOf(campaignId);
  if (!campaign) throw new Error("No such campaign");
  const running = latestPack(campaignId);
  if (running?.status === "running") return running.id;
  const id = newId("spk");
  const concepts = Math.max(1, Math.min(8, opts.concepts ?? getInt("static_concepts")));
  // A second pack for the same campaign reuses the static research already collected.
  const previous = running && running.research_json ? running : undefined;
  staticsDb()
    .prepare(
      `insert into static_packs (id, campaign_id, brand_id, status, stage, options_json, plan_json, research_json, created_at, updated_at)
       values (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, campaignId, campaign.brand_id, previous ? "study" : "research", JSON.stringify({ concepts }), previous?.plan_json ?? null, previous?.research_json ?? null, now(), now());
  await logEvent({ brandId: campaign.brand_id, campaignId, message: `Static ads started: ${concepts} concepts for Google, Meta, X and Reddit` });
  return id;
}

export async function advanceStatics() {
  const running = staticsDb().prepare("select id from static_packs where status = 'running' order by created_at").all() as Array<{ id: string }>;
  for (const { id } of running) await advancePack(id);
}

export async function advancePack(id: string) {
  const pack = getPack(id);
  if (!pack || pack.status !== "running") return;
  try {
    if (pack.stage === "research") await stepResearch(pack);
    else if (pack.stage === "study") await stepStudy(pack);
    else if (pack.stage === "write") await stepWrite(pack);
    else if (pack.stage === "produce") await stepProduce(pack);
    if (pack.attempts) update("static_packs", id, { attempts: 0 });
  } catch (error) {
    // A model call that fails is often still billed for what it generated, so the steps that call
    // models retry a few times at most; research (cheap, polled) retries more.
    const limit = pack.stage === "study" || pack.stage === "write" ? 2 : pack.stage === "produce" ? 4 : 10;
    if (transient(error) && pack.attempts < limit) {
      update("static_packs", id, { attempts: pack.attempts + 1 });
      await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, level: "warn", message: `Static ads: ${pack.stage} hit a provider error, trying again (${error instanceof Error ? error.message : String(error)})` });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      update("static_packs", id, { status: "failed", error: message });
      await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, level: "error", message: `Static ads stopped at ${pack.stage}: ${message}` });
    }
  }
}

/** Provider trouble worth another try: rate limits, outages, timeouts, a model call the proxy lost upstream. */
function transient(error: unknown) {
  return error instanceof ApiError && (error.retryable || (error.service === "naive" && /upstream|overloaded|timed? ?out|stream/i.test(error.message)));
}

function clients() {
  const make = <T>(f: () => T) => {
    try {
      return f();
    } catch {
      return null;
    }
  };
  return { naive: make(() => new NaiveClient()), monid: make(() => new MonidClient()) };
}

const addTokens = (packId: string, tokens: { input: number; output: number }) =>
  staticsDb().prepare("update static_packs set tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = ? where id = ?").run(tokens.input, tokens.output, now(), packId);

// ---------- research ----------

async function stepResearch(pack: PackRow) {
  const campaign = (await campaignOf(pack.campaign_id))!;
  const researchPack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!researchPack) return; // the campaign's own research is still running
  const { naive, monid } = clients();
  if (!monid) throw new Error("Static research runs on Monid: add a Monid API key in Settings, then retry.");
  let plan = parse<StaticPlan | null>(pack.plan_json, null);
  if (!plan) {
    plan = await planStatics(naive, researchPack, parse<ResearchPlan | null>(campaign.plan_json, null));
    update("static_packs", pack.id, { plan_json: JSON.stringify(plan) });
    await ensureRuns(pack.campaign_id, staticSpecs(researchPack.domain, plan));
    const who = [...plan.competitors.map((c) => c.name), ...plan.leaders.map((c) => c.name)].join(", ");
    await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, message: `Static research: ${(await listRuns(pack.campaign_id, ["S"])).length} sources across Meta, X, Google${plan.b2b ? ", LinkedIn" : ""} and the web${who ? `; looking at ${who}` : ""}` });
  }
  await progressRuns({ campaignId: pack.campaign_id, brandId: pack.brand_id }, monid, ["S"]);
  const runs = await listRuns(pack.campaign_id, ["S"]);
  if (runs.some((run) => run.status === "pending" || run.status === "running")) return;
  const research = compactStatics(
    runs.map((run) => ({ key: run.key, status: run.status, output: parse<unknown>(run.output_json, undefined) })),
    plan,
  );
  update("static_packs", pack.id, { research_json: JSON.stringify(research), stage: "study" });
  await recomputeSpend(pack.campaign_id); // the campaign's Monid total includes the static research
  const withImages = research.ads.filter((ad) => ad.image).length;
  await logEvent({
    brandId: pack.brand_id,
    campaignId: pack.campaign_id,
    message: `Static research done: ${research.ads.length} ads (${withImages} with images), ${research.search_ads.length} search ads, ${research.cases.length} case studies (${research.sources.done}/${research.sources.total} sources)`,
  });
}

// ---------- study ----------

async function stepStudy(pack: PackRow) {
  const { naive } = clients();
  if (!naive) throw new Error("The ad study runs on Naive: add a Naive API key in Settings, then retry.");
  const campaign = (await campaignOf(pack.campaign_id))!;
  const researchPack = parse<ResearchPack | null>(campaign.research_json, null)!;
  const research = parse<StaticResearch | null>(pack.research_json, null)!;
  const plan = parse<ResearchPlan | null>(campaign.plan_json, null);
  const dir = packDir(pack.id);
  await mkdir(join(dir, "assets"), { recursive: true });
  const assets = await gatherAssets(pack, researchPack, research, campaign);
  const tmp = join(dir, "study-tmp");
  await mkdir(tmp, { recursive: true });
  try {
    const study = await studyStatics(naive, { research, brandName: researchPack.brand.name, category: plan?.category ?? researchPack.brand.industry, screenshotPath: assets.screenshot ? join(/*turbopackIgnore: true*/ dir, assets.screenshot) : null, tmpDir: tmp });
    addTokens(pack.id, study.tokens);
    update("static_packs", pack.id, { study_json: JSON.stringify(study), stage: "write" });
    await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, message: `Ad study: ${study.studied.length} top ads read; direction: ${study.art.type_style} type on ${study.art.scheme}, ${study.art.imagery.replace("_", " ")}, decoration ${study.art.decoration}` });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The brand's logo and a screenshot of its site, stored with the pack. Missing ones stay null. */
async function gatherAssets(pack: PackRow, researchPack: ResearchPack, research: StaticResearch, campaign: CampaignLite): Promise<PackAssets> {
  const existing = parse<PackAssets | null>(pack.assets_json, null);
  if (existing) return existing;
  const dir = packDir(pack.id);
  const assets: PackAssets = { logo: null, screenshot: null };
  const brandRun = (await listRuns(campaign.id, ["A", "C"])).find((run) => run.key === "brand" && run.status === "done");
  const brand = record(record(parse<unknown>(brandRun?.output_json, null))?.brand);
  const logos = (Array.isArray(brand?.logos) ? brand!.logos : []).map((l) => record(l)).filter(Boolean) as Array<Record<string, unknown>>;
  // A wordmark beats an icon; a transparent one beats one on its own tile; bigger beats smaller.
  const rank = (l: Record<string, unknown>) => (text(l.type) === "logo" ? 4 : 0) + (text(l.mode) === "has_opaque_background" ? 0 : 2) + Math.min(1, Number(record(l.resolution)?.width ?? 0) / 600);
  const best = logos.sort((a, b) => rank(b) - rank(a))[0];
  const logoUrl = best ? text(best.url) : researchPack.brand.logo;
  if (logoUrl) {
    try {
      const ext = /\.svg(\?|$)/i.test(logoUrl) ? "svg" : "img";
      await download(logoUrl, join(dir, "assets", `logo.${ext}`));
      assets.logo = { file: `assets/logo.${ext}`, hint: best ? text(best.mode) : "" };
    } catch {
      // no logo: the brand name is set in type instead
    }
  }
  if (research.screenshot) {
    try {
      const raw = await download(research.screenshot, join(dir, "assets", "screenshot-raw"));
      const image = await normalizeImage(await readFile(raw), { maxSide: 1920 });
      await writeFile(join(dir, "assets", "screenshot.jpg"), image.bytes);
      await rm(raw, { force: true });
      assets.screenshot = "assets/screenshot.jpg";
    } catch {
      // no screenshot: product_ui layouts are not offered
    }
  }
  update("static_packs", pack.id, { assets_json: JSON.stringify(assets) });
  return assets;
}

// ---------- copy ----------

async function stepWrite(pack: PackRow) {
  const { naive } = clients();
  if (!naive) throw new Error("The copywriter runs on Naive: add a Naive API key in Settings, then retry.");
  const campaign = (await campaignOf(pack.campaign_id))!;
  const researchPack = parse<ResearchPack | null>(campaign.research_json, null)!;
  const strategy = parse<Strategy | null>(campaign.strategy_json, null);
  const study = parse<Study | null>(pack.study_json, null)!;
  const research = parse<StaticResearch | null>(pack.research_json, null)!;
  const assets = parse<PackAssets>(pack.assets_json, { logo: null, screenshot: null });
  const options = parse<{ concepts: number }>(pack.options_json, { concepts: 4 });
  const input: WriterInput = { pack: researchPack, strategy, research, study, concepts: options.concepts, hasScreenshot: Boolean(assets.screenshot) };
  const corpus = siteCorpus(researchPack, strategy);
  const opts = { hasScreenshot: Boolean(assets.screenshot), photos: Math.min(8, researchPack.brand.images.length) };

  const [first, search] = await Promise.all([writeConcepts(naive, input), writeSearchAssets(naive, input)]);
  addTokens(pack.id, first.tokens);
  addTokens(pack.id, search.tokens);
  let concepts = checkAll(first.concepts, corpus, opts);
  const failing = concepts.filter((c) => c.problems?.length);
  if (failing.length) {
    await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, message: `Copy check sent ${failing.length} concept${failing.length > 1 ? "s" : ""} back: ${failing[0].problems![0]}` });
    try {
      const repair = await writeConcepts(naive, input, { concepts: failing, problems: failing.map((c) => c.problems ?? []) });
      addTokens(pack.id, repair.tokens);
      const fixed = checkAll(repair.concepts, corpus, opts);
      let k = 0;
      concepts = concepts.map((c) => (c.problems?.length ? (fixed[k++] ?? c) : c));
    } catch (error) {
      if (transient(error)) throw error;
    }
  }
  const final = concepts
    .map((c) => (c.problems?.length ? downgrade(c, corpus, opts) : c))
    .filter((c): c is Concept => c !== null)
    .slice(0, options.concepts);
  if (final.length === 0) throw new Error("No concept passed the copy checks; retry to write new ones.");

  const checked = checkSearchAssets(search.assets, corpus);
  update("static_packs", pack.id, { search_json: JSON.stringify({ ...checked.assets, problems: checked.problems, short: checked.short }), stage: "produce" });
  for (const [idx, concept] of final.entries()) insertStaticAd(pack.id, idx, concept);
  await logEvent({
    brandId: pack.brand_id,
    campaignId: pack.campaign_id,
    message: `Copy ready: ${final.length} concepts (${final.map((c) => c.archetype).join(", ")}), ${checked.assets.rsa.headlines.length} search headlines${checked.problems.length ? `; ${checked.problems.length} lines failed the checks and were dropped` : ""}`,
  });
}

export function insertStaticAd(packId: string, idx: number, concept: Concept, generation = 1) {
  const id = newId("sad");
  staticsDb()
    .prepare("insert into static_ads (id, pack_id, idx, generation, concept_json, status, created_at, updated_at) values (?, ?, ?, ?, ?, 'queued', ?, ?)")
    .run(id, packId, idx, generation, JSON.stringify(concept), now(), now());
  return id;
}

// ---------- pictures, renders, checks ----------

const logoCache = new Map<string, LogoAsset | null>();

async function packLogo(pack: PackRow, assets: PackAssets) {
  if (logoCache.has(pack.id)) return logoCache.get(pack.id)!;
  let logo: LogoAsset | null = null;
  if (assets.logo) {
    try {
      logo = await logoAsset(await readFile(join(packDir(pack.id), assets.logo.file)), assets.logo.hint);
    } catch {
      logo = null;
    }
  }
  logoCache.set(pack.id, logo);
  return logo;
}

async function stepProduce(pack: PackRow) {
  const { naive } = clients();
  const assets = parse<PackAssets>(pack.assets_json, { logo: null, screenshot: null });
  const logo = await packLogo(pack, assets);
  await ensureLogos(pack, logo);
  // One ad per tick, so a long render never holds up the other campaigns.
  const ad = listStaticAds(pack.id).find((a) => !a.rejected && a.status !== "ready" && a.status !== "failed");
  if (ad) {
    try {
      await advanceAd(pack, ad, naive, assets, logo);
    } catch (error) {
      if (transient(error)) throw error;
      update("static_ads", ad.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, level: "warn", message: `A static ad failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    return;
  }
  const ads = listStaticAds(pack.id).filter((a) => !a.rejected);
  const ready = ads.filter((a) => a.status === "ready").length;
  update("static_packs", pack.id, { status: "ready", stage: "ready" });
  await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, message: `Static ads ready: ${ready} of ${ads.length} concepts, each sized for Google, Meta, X and Reddit` });
}

async function ensureLogos(pack: PackRow, logo: LogoAsset | null) {
  const dir = join(packDir(pack.id), "logos");
  if (existsSync(join(dir, "logo-4x1.png"))) return;
  const input = await baseInput(pack, logo);
  await mkdir(dir, { recursive: true });
  for (const spec of LOGO_PLACEMENTS) await writeFile(join(dir, `${spec.id}.png`), await renderLogoPng(input, spec.width, spec.height));
}

async function baseInput(pack: PackRow, logo: LogoAsset | null): Promise<AdInput> {
  const campaign = (await campaignOf(pack.campaign_id))!;
  const researchPack = parse<ResearchPack | null>(campaign.research_json, null)!;
  const study = parse<Study | null>(pack.study_json, null);
  return {
    archetype: "editorial",
    copy: { headline: "", cta: "" },
    type: study?.art.type_style ?? "geist",
    palette: palette(researchPack.brand.colors),
    scheme: study?.art.scheme ?? "white",
    brandName: researchPack.brand.name,
    domain: researchPack.domain,
    logo,
    visual: null,
  };
}

async function advanceAd(pack: PackRow, ad: StaticAdRow, naive: NaiveClient | null, assets: PackAssets, logo: LogoAsset | null) {
  const concept = parse<Concept>(ad.concept_json, null as unknown as Concept);
  const dir = adDir(pack.id, ad.id);
  await mkdir(dir, { recursive: true });
  let visual = parse<VisualState | null>(ad.visual_json, null);
  if (ad.status === "queued" || ad.status === "visual" || !visual) {
    visual = await makeVisual(pack, ad, concept, naive, assets, visual);
    update("static_ads", ad.id, { visual_json: JSON.stringify(visual), status: "rendering" });
  }
  const study = parse<Study | null>(pack.study_json, null);
  const base = await baseInput(pack, logo);
  const picture: VisualAsset | null = visual.file ? await visualAsset(await readFile(join(packDir(pack.id), visual.file))) : null;
  if (ad.status === "queued" || ad.status === "visual" || ad.status === "rendering") {
    const renders: Render[] = [];
    for (const placement of PLACEMENTS) {
      if (placement.textFree && !picture) continue;
      const copy = placement.platform === "reddit" ? { ...concept.copy, subhead: undefined, eyebrow: undefined } : concept.copy;
      const input: AdInput = {
        ...base,
        archetype: concept.archetype,
        copy,
        scheme: concept.scheme,
        visual: picture,
        visualKind: visual.kind === "screenshot" ? "screenshot" : "photo",
        look: { decoration: study?.art.decoration ?? "none", cta: Boolean(study?.art.cta_in_image) && placement.cta },
        textFree: placement.textFree,
      };
      const file = await renderAdFile(input, placement.width, placement.height, placement.maxBytes);
      const name = `${placement.id}.${file.ext}`;
      // Runtime files under data/media; the ignore comment keeps Turbopack from tracing the project.
      await writeFile(join(/*turbopackIgnore: true*/ dir, name), file.bytes);
      renders.push({ placement: placement.id, file: name, width: placement.width, height: placement.height, bytes: file.bytes.length });
    }
    update("static_ads", ad.id, { renders_json: JSON.stringify(renders), status: "checking" });
    ad = { ...ad, status: "checking", renders_json: JSON.stringify(renders) };
  }
  if (ad.status === "checking") {
    const renders = parse<Render[]>(ad.renders_json, []);
    const pick = (id: string) => renders.find((r) => r.placement === id);
    const shots = [pick("meta-feed-4x5"), pick("x-1.91x1")].filter((r): r is Render => Boolean(r));
    let verdict: StaticVerdict | null = null;
    if (naive && shots.length) {
      const images = await Promise.all(shots.map(async (r) => (await normalizeImage(await readFile(join(dir, r.file)), { maxSide: 1100 })).bytes));
      try {
        verdict = await reviewStatic(naive, { images, concept, brandName: base.brandName });
        addTokens(pack.id, verdict.tokens);
      } catch (error) {
        if (transient(error)) throw error;
      }
    }
    // A generated picture that failed the check gets one more try with the reviewer's notes.
    if (verdict && !verdict.pass && verdict.fix === "visual" && visual.kind === "generated" && visual.attempts < 2) {
      update("static_ads", ad.id, { qc_json: JSON.stringify(verdict), status: "visual", visual_json: JSON.stringify({ ...visual, note: verdict.issues.slice(0, 3).join(" ") }) });
      await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, message: `Static ad check (${verdict.score}/10) asked for a new picture: ${verdict.issues[0] ?? ""}` });
      return;
    }
    update("static_ads", ad.id, { qc_json: verdict ? JSON.stringify(verdict) : null, status: "ready", error: null });
    if (verdict && !verdict.pass) await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, level: "warn", message: `"${concept.copy.headline.replace(/\*/g, "")}" scored ${verdict.score}/10: ${verdict.issues[0] ?? "see notes"}` });
  }
}

/** The picture for one ad: the site screenshot, one of the brand's photos, a generated photo, or none. */
async function makeVisual(pack: PackRow, ad: StaticAdRow, concept: Concept, naive: NaiveClient | null, assets: PackAssets, previous: VisualState | null): Promise<VisualState> {
  const campaign = (await campaignOf(pack.campaign_id))!;
  const researchPack = parse<ResearchPack | null>(campaign.research_json, null)!;
  const dir = adDir(pack.id, ad.id);
  const relative = (name: string) => join(ad.id, name);
  const kind = concept.visual.kind;
  if (kind === "screenshot") return { kind, file: assets.screenshot, attempts: 1, cost_micro: 0 };
  if (kind === "site_photo") {
    const url = researchPack.brand.images[concept.visual.site_photo];
    try {
      const raw = await download(url, join(dir, "photo-raw"));
      const image = await normalizeImage(await readFile(raw), { maxSide: 1600 });
      await writeFile(join(dir, "visual.jpg"), image.bytes);
      await rm(raw, { force: true });
      return { kind, file: relative("visual.jpg"), attempts: 1, cost_micro: 0 };
    } catch (error) {
      return { kind: "none", file: null, attempts: 1, cost_micro: 0, error: `site photo unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (kind === "generated" && naive && getBool("static_ai_images")) {
    const attempts = (previous?.attempts ?? 0) + 1;
    const refs = researchPack.brand.images.slice(0, 3);
    const prompt = [
      concept.visual.prompt || `A clean product photograph of ${researchPack.brand.name}'s product.`,
      "Photorealistic advertising photograph. The product must match the reference images exactly: shape, colors and label layout.",
      "No added text, letters, logos, screens, people's faces or watermarks. Uncluttered background, soft natural light, the product as the clear subject with room around it.",
      previous?.note ? `A reviewer rejected the previous picture. Fix exactly this: ${previous.note}` : "",
    ].filter(Boolean).join("\n");
    try {
      const result = await naive.generateImage({ model: getSetting("static_image_model"), prompt, aspect_ratio: "1:1", image_urls: refs.length ? refs : undefined }, `${ad.id}-visual-${attempts}`);
      const file = result.files[0];
      if (!file) throw new ApiError("naive", 502, "no_file", "the image model returned no picture");
      staticsDb().prepare("update static_packs set image_cost_micro = image_cost_micro + ? where id = ?").run(result.cost_micro_usd ?? 0, pack.id);
      const link = await naive.fileUrl(file.id);
      const raw = await download(link.url, join(dir, `generated-${attempts}`));
      const image = await normalizeImage(await readFile(raw), { maxSide: 1600 });
      await writeFile(join(dir, "visual.jpg"), image.bytes);
      return { kind, file: relative("visual.jpg"), attempts, cost_micro: (previous?.cost_micro ?? 0) + (result.cost_micro_usd ?? 0) };
    } catch (error) {
      if (error instanceof ApiError && (error.retryable || error.inFlight)) throw error;
      return { kind: "none", file: null, attempts, cost_micro: previous?.cost_micro ?? 0, error: `no generated picture: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { kind: "none", file: null, attempts: 0, cost_micro: 0 };
}

// ---------- edits from the review page ----------

export async function setStaticApproved(adId: string, approved: boolean) {
  update("static_ads", adId, { approved: approved ? 1 : 0 });
}

/** New copy on the same picture: re-rendered on the next tick, no model calls. */
export async function editStaticAd(adId: string, patch: Partial<Pick<Concept["copy"], "headline" | "subhead" | "cta" | "eyebrow">>) {
  const ad = getStaticAd(adId);
  if (!ad) throw new Error("No such ad");
  const concept = parse<Concept>(ad.concept_json, null as unknown as Concept);
  const value = (key: "headline" | "subhead" | "cta" | "eyebrow") => (typeof patch[key] === "string" ? patch[key]!.trim().slice(0, key === "subhead" ? 140 : 80) : undefined);
  // Headline and button cannot be emptied; subhead and eyebrow can.
  if (value("headline")) concept.copy.headline = value("headline")!;
  if (value("cta")) concept.copy.cta = value("cta")!;
  if (typeof patch.subhead === "string") concept.copy.subhead = value("subhead") || undefined;
  if (typeof patch.eyebrow === "string") concept.copy.eyebrow = value("eyebrow") || undefined;
  update("static_ads", adId, { concept_json: JSON.stringify(concept), status: "rendering", qc_json: null });
  const pack = getPack(ad.pack_id)!;
  update("static_packs", pack.id, { status: "running", stage: "produce", error: null });
}

/** A new picture (for photo concepts) or a fresh render, optionally steered by a note. */
export async function regenerateStaticAd(adId: string, note?: string) {
  const ad = getStaticAd(adId);
  if (!ad) throw new Error("No such ad");
  const concept = parse<Concept>(ad.concept_json, null as unknown as Concept);
  if (note?.trim()) concept.visual.prompt = `${concept.visual.prompt}\nDirector's note: ${note.trim()}`;
  update("static_ads", ad.id, { rejected: 1, approved: 0 });
  const id = insertStaticAd(ad.pack_id, ad.idx, concept, ad.generation + 1);
  const pack = getPack(ad.pack_id)!;
  update("static_packs", pack.id, { status: "running", stage: "produce", error: null });
  await logEvent({ brandId: pack.brand_id, campaignId: pack.campaign_id, message: `Remaking static ad "${concept.copy.headline.replace(/\*/g, "")}"${note?.trim() ? ` with the note: ${note.trim()}` : ""}` });
  return id;
}

export async function retryPack(packId: string) {
  const pack = getPack(packId);
  if (!pack) throw new Error("No such pack");
  if (pack.stage === "research") await requeueFailedRuns(pack.campaign_id, ["S"]);
  if (pack.stage === "produce") staticsDb().prepare("update static_ads set status = 'queued', error = null where pack_id = ? and status = 'failed' and rejected = 0").run(packId);
  update("static_packs", packId, { status: "running", error: null, attempts: 0 });
}

export async function stopPack(packId: string) {
  update("static_packs", packId, { status: "stopped", error: "Stopped by you" });
}
