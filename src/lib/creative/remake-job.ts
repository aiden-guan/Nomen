// The production hook for one-to-one remakes. A remake takes many minutes (a vision pass, the voice,
// a twin frame and a render per take, filmed monitors, graphics), longer than a worker tick may
// block, so it runs in the background here and each tick only checks on it. Everything it pays for
// is kept by key in the store's files with a manifest (creative/remake.ts), so a restart, a crash
// or a busy provider costs time, not money: the next tick starts it again and it picks up where it
// stopped.
//
// It reads the campaign's breakdown and research from the store, finds the reference video (kept by
// key, "references/<breakdown id>.mp4"), makes the brand's persona once, and writes the result onto
// the creative: the takes as its shots (the camp shows them like any video's), the spend, the check
// and the cut. Remakes stay internal: nothing here uploads the cut for posting, and publish.ts
// refuses them unless a person clears them.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { logEvent, parse, save, store } from "../db";
import { ApiError } from "../http";
import { download, scratchDir } from "../media";
import type { CreativeRow, ProductionContext, ShotState } from "../production";
import type { Video } from "../research";
import { getSetting } from "../settings";
import type { Concept } from "../strategy";
import { cohostDescription, ensurePersona, loadPersona } from "./persona";
import { canonicalUrl } from "./references";
import { OverBudget, type RemakeProgress, remakeVideo, type TakeView } from "./remake";
import type { ProductBrief, ReferenceBreakdown } from "./types";

declare global {
  var __nomenRemakes: Map<string, Promise<void>> | undefined;
}

/** Remakes running in this process (kept on globalThis so a hot reload does not start a second). */
const running = () => (globalThis.__nomenRemakes ??= new Map());
const troubles = new Map<string, number>();
/** Busy-provider pauses in a row before a remake is given up on. */
const MAX_TROUBLES = 6;

/** The reference video's file key: a breakdown's id, or a hand-saved file under data/media/references. */
export const referenceKey = (breakdownId: string) => `references/${breakdownId}.mp4`;

/**
 * Called by production for a remake concept on every tick: starts the remake once, and otherwise
 * returns at once while it runs. The creative turns ready (or failed) when it ends.
 */
export async function advanceRemake(ctx: ProductionContext, creative: CreativeRow, concept: Concept): Promise<void> {
  if (running().has(creative.id) || creative.status === "ready" || creative.status === "failed") return;
  if (!ctx.naive || !ctx.monid) {
    await save("creatives", creative.id, { status: "failed", error: "a remake needs Naive (images and checks) and Monid (the presenter, the voice and file links)" });
    return;
  }
  if (ctx.naiveOut()) return; // waits for a top-up, like every other render
  if (creative.status === "queued") await save("creatives", creative.id, { status: "producing" });
  const log = (message: string, level: "info" | "warn" | "error" = "info") => logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level, message: `"${concept.title}" (remake): ${message}` }).catch(() => undefined);
  const job = runRemake(ctx, creative, concept, (message) => void log(message))
    .then(() => void troubles.delete(creative.id))
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ApiError && error.outOfCredits && error.service === "naive") {
        await ctx.markNaiveOut();
        return;
      }
      const count = (troubles.get(creative.id) ?? 0) + 1;
      troubles.set(creative.id, count);
      if (!(error instanceof OverBudget) && error instanceof ApiError && error.retryable && count < MAX_TROUBLES) {
        await log(`paused (${message}); resuming on the next tick`, "warn");
        return;
      }
      await save("creatives", creative.id, { status: "failed", error: `remake failed: ${message}` });
      await log(`failed: ${message}`, "error");
    })
    .finally(() => running().delete(creative.id));
  running().set(creative.id, job);
}

/** The reference's full breakdown (beats) and its download link, from the campaign's own records. */
export async function loadReference(campaignId: string, referenceId: string): Promise<{ breakdown: ReferenceBreakdown; mediaUrl: string | null } | null> {
  const [row] = await store().find<{ style_json: string | null; research_json: string | null }>("campaigns", { id: campaignId }, { limit: 1 });
  const breakdowns = parse<{ breakdowns?: ReferenceBreakdown[] } | null>(row?.style_json, null)?.breakdowns ?? [];
  const breakdown = breakdowns.find((b) => b.id === referenceId);
  if (!breakdown) return null;
  const videos = parse<{ videos?: Video[] } | null>(row?.research_json, null)?.videos ?? [];
  const video = videos.find((v) => canonicalUrl(v.url) === canonicalUrl(breakdown.url));
  return { breakdown, mediaUrl: video?.media_url ?? null };
}

/**
 * The reference video on this machine: kept by key once downloaded from its research link, so a
 * later tick elsewhere finds it. A platform link that has expired asks for the file by hand.
 */
export async function ensureReferenceVideo(breakdown: Pick<ReferenceBreakdown, "id" | "url">, mediaUrl: string | null, files = store().files): Promise<string> {
  const key = referenceKey(breakdown.id);
  if (await files.exists(key)) return files.localPath(key);
  if (!mediaUrl) throw new Error(`no download link for the reference ${breakdown.url}; save it as data/media/${key}`);
  const local = join(scratchDir(), key);
  try {
    await download(mediaUrl, local);
  } catch (error) {
    throw new Error(`the reference video could not be downloaded (${error instanceof Error ? error.message : String(error)}); save it as data/media/${key}`);
  }
  await files.putFile(key, local, "video/mp4");
  return files.localPath(key);
}

/** The product with every captured visual on this machine's disk (the screen builder reads files). */
async function localVisuals(product: ProductBrief): Promise<ProductBrief> {
  const files = store().files;
  const visuals = await Promise.all(
    product.visuals.map(async (visual) => {
      if (!visual.key || /^https?:/.test(visual.url) || existsSync(visual.url)) return visual;
      return { ...visual, url: await files.localPath(visual.key).catch(() => visual.url) };
    }),
  );
  return { ...product, visuals };
}

/**
 * The takes as the creative's shots, so the camp shows them like any video's: status, provider
 * ("Kling" for Monid), the twin frame as the shot's frame. Each carries its own spend; the first
 * also carries the rest of the remake's (the voice, plates, people), so the campaign's totals add up.
 */
export function takeShots(creativeId: string, progress: RemakeProgress, extra: { naive_micro: number; monid_micro: number }, presenter: string, ready: boolean): ShotState[] {
  const naiveRenders = presenter.startsWith("naive:");
  return progress.takes.map((take: TakeView, i) => ({
    n: take.n,
    frame_prompt: "",
    prompt: `${take.role === "cohost" ? "co-host" : take.inset ? "host cut-out" : "host"}, ${take.start.toFixed(1)}-${take.end.toFixed(1)} s of the reference`,
    seconds: Math.round((take.end - take.start) * 10) / 10,
    status: take.status === "rendered" ? (ready ? "passed" : "rendered") : take.status,
    provider: take.status === "rendering" || take.status === "rendered" ? (naiveRenders ? "naive" : "monid") : null,
    renders: take.status === "rendered" || take.status === "rendering" ? 1 : 0,
    qc_rounds: 0,
    submit_errors: 0,
    frame_idem: `${creativeId}-take${take.n}`,
    frame_file_id: null,
    frame_url: null,
    frame_key: take.frame_key,
    frame_skipped: !take.frame_key,
    text_only: false,
    force_monid: false,
    video_idem: `${creativeId}-take${take.n}`,
    job_id: null,
    monid_run_id: null,
    video_file_id: null,
    video_url: null,
    local_path: null,
    qc: null,
    naive_cost: take.naive_micro + (i === 0 ? extra.naive_micro : 0),
    monid_cost: take.monid_micro + (i === 0 ? extra.monid_micro : 0),
    error: take.error,
  }));
}

async function runRemake(ctx: ProductionContext, creative: CreativeRow, concept: Concept, log: (message: string) => void) {
  if (!ctx.product) throw new Error("the campaign has no product brief");
  const referenceId = concept.brief?.reference_id || concept.reference?.id || "";
  const source = await loadReference(ctx.campaignId, referenceId);
  if (!source) throw new Error(`the breakdown of reference ${referenceId || "(none)"} is missing`);
  const files = store().files;
  const referencePath = await ensureReferenceVideo(source.breakdown, source.mediaUrl, files);
  const deps = { naive: ctx.naive!, monid: ctx.monid!, files };

  // The brand's recurring presenter: made once, from the director's description of this video's presenter.
  const hadHost = Boolean(await loadPersona(files, ctx.brandId, "host"));
  const host = await ensurePersona(deps, { brandId: ctx.brandId, role: "host", description: concept.brief?.creator || concept.creator, character: getSetting("persona_character") || null });
  if (!hadHost) log(`made the brand's presenter: ${host.persona.description} (voice ${host.persona.voice.name})`);
  let peopleCost = host.cost_micro;

  const presenter = getSetting("remake_presenter") || "kling-native";
  const lines = (concept.script?.beats ?? []).map((beat) => ({ line: beat.line, emotion: beat.emotion ?? "", on_screen_text: beat.on_screen_text }));
  const last: { progress: RemakeProgress | null } = { progress: null };
  const record = async (progress: RemakeProgress, ready = false) => {
    last.progress = progress;
    const spent = progress.spend.naive_micro + progress.spend.monid_micro + peopleCost;
    const takes = progress.takes.reduce((sum, t) => sum + t.naive_micro + t.monid_micro, 0);
    const takesNaive = progress.takes.reduce((sum, t) => sum + t.naive_micro, 0);
    const extraNaive = Math.max(0, progress.spend.naive_micro + peopleCost - takesNaive);
    const extra = { naive_micro: extraNaive, monid_micro: Math.max(0, spent - takes - extraNaive) };
    await save("creatives", creative.id, { shots_json: JSON.stringify(takeShots(creative.id, progress, extra, presenter, ready)), cost_micro: spent });
  };

  const result = await remakeVideo(deps, {
    prefix: creative.id,
    referencePath,
    breakdown: source.breakdown,
    lines,
    host,
    cohost: async (other) => {
      const made = await ensurePersona(deps, { brandId: ctx.brandId, role: "cohost", description: cohostDescription(other) });
      if (made.cost_micro) log(`made the brand's co-host for stitched clips: ${made.persona.description}`);
      peopleCost += made.cost_micro;
      return { ...made, cost_micro: 0 };
    },
    product: await localVisuals(ctx.product),
    kit: ctx.kit ?? null,
    maxUsd: Number(getSetting("remake_max_usd")) || 15,
    presenter,
    voice: (["fresh", "convert", "auto"].includes(getSetting("remake_voice")) ? getSetting("remake_voice") : "fresh") as "fresh" | "convert" | "auto",
    screens: (["auto", "track", "plate"].includes(getSetting("remake_screens")) ? getSetting("remake_screens") : "auto") as "auto" | "track" | "plate",
    voiceMatch: getSetting("remake_voice_match") === "on",
    finish: getSetting("finish") !== "off",
    idem: creative.id,
    personasToMake: 0,
    onEvent: log,
    onProgress: (progress) => record(progress),
  });
  if (last.progress) await record(last.progress, true);
  const qc = result.qc;
  await save("creatives", creative.id, {
    status: "ready",
    final_key: result.key,
    poster_url: result.poster_key ? `/api/media/${result.poster_key}` : null,
    qc_score: qc?.score ?? null,
    continuity_json: JSON.stringify({ checked: Boolean(qc), consistent: qc ? qc.same_people && !qc.original_visible : false, mismatched: qc?.mismatched ?? [], note: qc ? qc.issues.slice(0, 2).join("; ") || "matches the reference" : "not checked", rounds: 1 }),
    cost_micro: result.spend.naive_micro + result.spend.monid_micro + peopleCost,
    error: result.notes.length ? `notes: ${result.notes.join("; ").slice(0, 600)}` : null,
  });
  log(`ready, ${result.duration.toFixed(1)} s, $${((result.spend.naive_micro + result.spend.monid_micro + peopleCost) / 1e6).toFixed(2)} (estimated $${result.estimate.usd.total.toFixed(2)}); internal only, not posted unless cleared`);
}
