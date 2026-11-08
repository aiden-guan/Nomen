// The production hook for brainrot videos. Making one takes minutes (voice, pictures, a clip per
// shot, the checks, the cut), longer than a worker tick may block, so it runs in the background
// here and each tick only checks on it. Everything paid for is kept by key with a manifest
// (brainrot-make.ts), so the next tick after a restart or a busy provider resumes it.
//
// Brainrot ads are deliberately terrible and tie the brand to meme humour, so they are held like
// remakes: `internal` on the concept, and publish.ts refuses them until a person clears them.

import { logEvent, save, store } from "../db";
import { ApiError } from "../http";
import type { CreativeRow, ProductionContext, ShotState } from "../production";
import { getSetting } from "../settings";
import type { Concept } from "../strategy";
import { siteOf } from "./brainrot";
import { type BrainrotShotView, makeBrainrot, OverBudget } from "./brainrot-make";

declare global {
  var __nomenBrainrots: Map<string, Promise<void>> | undefined;
}

const running = () => (globalThis.__nomenBrainrots ??= new Map());
const troubles = new Map<string, number>();
const MAX_TROUBLES = 6;

/** The video model brainrot clips render on, and its assumed price until a clip measures it. */
export const DEFAULT_VIDEO_MODEL = "google/veo-3.1-lite";

/** The shots as the creative's shots, so the camp shows them like any video's. */
export function brainrotShots(creativeId: string, shots: BrainrotShotView[], extraMicro: number, ready: boolean): ShotState[] {
  return shots.map((shot, i) => ({
    n: shot.n,
    frame_prompt: "",
    prompt: `brainrot shot ${shot.n}`,
    seconds: Math.round(shot.seconds * 10) / 10,
    status: shot.status === "rendered" ? (ready ? "passed" : "rendered") : shot.status,
    provider: shot.status === "pending" ? null : "naive",
    renders: shot.status === "pending" ? 0 : 1,
    qc_rounds: 0,
    submit_errors: 0,
    frame_idem: `${creativeId}-brainrot-${shot.n}`,
    frame_file_id: null,
    frame_url: null,
    frame_key: shot.still_key,
    frame_skipped: !shot.still_key,
    text_only: false,
    force_monid: false,
    video_idem: `${creativeId}-brainrot-${shot.n}`,
    job_id: null,
    monid_run_id: null,
    video_file_id: null,
    video_url: null,
    local_path: null,
    qc: null,
    naive_cost: shot.cost_micro + (i === 0 ? extraMicro : 0),
    monid_cost: 0,
    error: shot.error,
  }));
}

/** Called by production for a brainrot concept on every tick: starts the job once, else returns at once. */
export async function advanceBrainrot(ctx: ProductionContext, creative: CreativeRow, concept: Concept): Promise<void> {
  if (running().has(creative.id) || creative.status === "ready" || creative.status === "failed") return;
  if (!ctx.naive || !ctx.monid) {
    await save("creatives", creative.id, { status: "failed", error: "a brainrot video needs Naive (pictures, clips, checks) and Monid (voice, music, sound effects)" });
    return;
  }
  if (!concept.brainrot) {
    await save("creatives", creative.id, { status: "failed", error: "the brainrot script is missing" });
    return;
  }
  if (ctx.naiveOut()) return;
  if (creative.status === "queued") await save("creatives", creative.id, { status: "producing" });
  const log = (message: string, level: "info" | "warn" | "error" = "info") => logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level, message: `"${concept.title}" (brainrot): ${message}` }).catch(() => undefined);
  const job = runBrainrot(ctx, creative, concept, (message) => void log(message))
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
      await save("creatives", creative.id, { status: "failed", error: `brainrot failed: ${message}` });
      await log(`failed: ${message}`, "error");
    })
    .finally(() => running().delete(creative.id));
  running().set(creative.id, job);
}

async function runBrainrot(ctx: ProductionContext, creative: CreativeRow, concept: Concept, log: (message: string) => void) {
  if (!ctx.product) throw new Error("the campaign has no product brief");
  const [brand] = await store().find<{ url: string }>("brands", { id: ctx.brandId }, { limit: 1 });
  const result = await makeBrainrot(
    { naive: ctx.naive!, monid: ctx.monid!, files: store().files },
    {
      prefix: creative.id,
      script: concept.brainrot!,
      product: ctx.product,
      site: siteOf(brand?.url) || ctx.product.name,
      videoModel: getSetting("brainrot_video_model") || DEFAULT_VIDEO_MODEL,
      videoPerSecond: Number(getSetting("brainrot_video_usd_per_second")) || undefined,
      maxUsd: Number(getSetting("brainrot_max_usd")) || 4,
      idem: creative.id,
      onEvent: log,
    },
  );
  const spent = result.spend.naive_micro + result.spend.monid_micro;
  const clips = result.shots.reduce((sum, shot) => sum + shot.cost_micro, 0);
  const unsafe = result.qc && !result.qc.safe;
  await save("creatives", creative.id, {
    status: unsafe ? "failed" : "ready",
    shots_json: JSON.stringify(brainrotShots(creative.id, result.shots, Math.max(0, spent - clips), true)),
    final_key: result.key,
    poster_url: result.poster_key ? `/api/media/${result.poster_key}` : null,
    qc_score: result.qc?.score ?? null,
    continuity_json: JSON.stringify({ checked: Boolean(result.qc), consistent: result.qc?.safe ?? false, mismatched: [], note: result.qc ? result.qc.issues.slice(0, 2).join("; ") || "safe, product readable" : "not checked", rounds: 1 }),
    cost_micro: spent,
    error: unsafe ? `the final check found something off limits: ${result.qc!.issues.join("; ").slice(0, 500)}` : result.notes.length ? `notes: ${result.notes.join("; ").slice(0, 600)}` : null,
  });
  log(`${unsafe ? "failed its final check" : "ready"}, ${result.duration.toFixed(1)} s, $${(spent / 1e6).toFixed(2)}${result.qc ? `, QC ${result.qc.score}/10` : ""}; held until a person clears it for posting`);
}
