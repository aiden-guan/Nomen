// The production hook for one-to-one remakes. A remake takes many minutes (a vision pass, image
// edits, several video renders, graphics), longer than the worker's tick may block, so it runs in
// the background here and each tick only checks on it. It resumes from its work directory after a
// restart (src/lib/creative/remake.ts keeps a manifest and stable idempotency keys), so a crash or a
// busy provider costs time, not money. Remakes stay internal: nothing here uploads the result for
// posting, and publish.ts refuses them unless a person clears them.
//
// This file is the edge: it reads the campaign's breakdown and research from the database, finds or
// downloads the reference video, and writes the result onto the creative.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { db, logEvent, parse, update } from "../db";
import { ApiError } from "../http";
import { download, mediaDir } from "../media";
import type { CreativeRow, ProductionContext } from "../production";
import type { Video } from "../research";
import type { Concept } from "../strategy";
import { editFfmpeg } from "./edit";
import { canonicalUrl } from "./references";
import { ensurePersona, remakeVideo } from "./remake";
import type { ReferenceBreakdown } from "./types";

const exec = promisify(execFile);

/** Reference videos are kept here (data/ is gitignored), named by their breakdown id. */
export const referencesDir = () => join(process.cwd(), "data", "media", "references");

const running = new Map<string, Promise<void>>();
const troubles = new Map<string, number>();
/** Busy-provider failures in a row before a remake is given up on. */
const MAX_TROUBLES = 6;
/** A ceiling on one remake's video renders (about $48 at $0.40 a second): a 90 s reference fits, a runaway plan does not. */
const MAX_RENDER_SECONDS = 120;

/**
 * Called by production for a remake concept on every tick: starts the remake once, and otherwise
 * returns at once while it runs. The creative turns ready (or failed) when it ends.
 */
export function advanceRemake(ctx: ProductionContext, creative: CreativeRow, concept: Concept): void {
  if (running.has(creative.id) || creative.status === "ready" || creative.status === "failed") return;
  if (!ctx.naive) {
    update("creatives", creative.id, { status: "failed", error: "a remake needs Naive (image edits and video renders)" });
    return;
  }
  if (ctx.naiveOut()) return; // waits for a top-up, like every other render
  if (creative.status === "queued") update("creatives", creative.id, { status: "producing" });
  const log = (message: string, level: "info" | "warn" | "error" = "info") => logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level, message: `"${concept.title}" (remake): ${message}` });
  const job = runRemake(ctx, creative, concept, log)
    .then(() => void troubles.delete(creative.id))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ApiError && error.outOfCredits) {
        ctx.markNaiveOut();
        return;
      }
      const count = (troubles.get(creative.id) ?? 0) + 1;
      troubles.set(creative.id, count);
      if (error instanceof ApiError && error.retryable && count < MAX_TROUBLES) {
        log(`paused (${message}); resuming on the next tick`, "warn");
        return;
      }
      update("creatives", creative.id, { status: "failed", error: `remake failed: ${message}` });
      log(`failed: ${message}`, "error");
    })
    .finally(() => running.delete(creative.id));
  running.set(creative.id, job);
}

/** The reference's full breakdown (beats) and its download link, from the campaign's own records. */
export function loadReference(campaignId: string, referenceId: string): { breakdown: ReferenceBreakdown; mediaUrl: string | null } | null {
  const row = db().prepare("select style_json, research_json from campaigns where id = ?").get(campaignId) as { style_json: string | null; research_json: string | null } | undefined;
  const breakdowns = parse<{ breakdowns?: ReferenceBreakdown[] } | null>(row?.style_json, null)?.breakdowns ?? [];
  const breakdown = breakdowns.find((b) => b.id === referenceId);
  if (!breakdown) return null;
  const videos = parse<{ videos?: Video[] } | null>(row?.research_json, null)?.videos ?? [];
  const video = videos.find((v) => canonicalUrl(v.url) === canonicalUrl(breakdown.url));
  return { breakdown, mediaUrl: video?.media_url ?? null };
}

/** The reference video on disk, downloaded once from its research link when it is not there yet. */
export async function ensureReferenceVideo(breakdown: Pick<ReferenceBreakdown, "id" | "url">, mediaUrl: string | null, dir = referencesDir()): Promise<string> {
  const path = join(dir, `${breakdown.id}.mp4`);
  if (existsSync(path)) return path;
  if (!mediaUrl) throw new Error(`no download link for the reference ${breakdown.url}; save it as ${path}`);
  try {
    return await download(mediaUrl, path);
  } catch (error) {
    // Platform links expire: say where to put the file by hand.
    throw new Error(`the reference video could not be downloaded (${error instanceof Error ? error.message : String(error)}); save it as ${path}`);
  }
}

async function runRemake(ctx: ProductionContext, creative: CreativeRow, concept: Concept, log: (message: string) => void) {
  const naive = ctx.naive!;
  if (!ctx.product) throw new Error("the campaign has no product brief");
  const referenceId = concept.brief?.reference_id || concept.reference?.id || "";
  const source = loadReference(ctx.campaignId, referenceId);
  if (!source) throw new Error(`the breakdown of reference ${referenceId || "(none)"} is missing`);
  const referencePath = await ensureReferenceVideo(source.breakdown, source.mediaUrl);
  const dir = mediaDir(creative.id);
  const persona = await ensurePersona(naive, { persona: concept.creator, path: join(dir, "persona.png"), idem: creative.id });
  const result = await remakeVideo(naive, {
    referencePath,
    breakdown: source.breakdown,
    lines: source.breakdown.beats.map((_, i) => concept.script?.beats[i]?.line ?? ""),
    personaPath: persona.path,
    persona: concept.creator,
    product: ctx.product,
    kit: ctx.kit ?? null,
    workDir: join(dir, "remake"),
    outPath: join(dir, "final.mp4"),
    idem: creative.id,
    maxRenderSeconds: MAX_RENDER_SECONDS,
    onEvent: log,
  });
  const poster = (await savePoster(result.path, join(dir, "shot0-frame.png"))) ? `/api/media/${creative.id}/shot0-frame.png` : null;
  update("creatives", creative.id, {
    status: "ready",
    cost_micro: result.cost_micro + persona.cost_micro,
    poster_url: poster,
    error: result.failures.length ? `notes: ${result.failures.join("; ").slice(0, 500)}` : null,
  });
  log(`ready, ${result.duration.toFixed(1)} s, internal only (not posted unless cleared)`);
}

async function savePoster(video: string, out: string) {
  const bin = await editFfmpeg();
  if (!bin) return false;
  try {
    await exec(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1.0", "-i", video, "-frames:v", "1", "-vf", "scale=540:-2", out]);
    return existsSync(out);
  } catch {
    return false;
  }
}
