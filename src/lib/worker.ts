import { randomUUID } from "node:crypto";
import { logEvent, store } from "./db";
import { advanceLoop } from "./loop";
import { advancePhones } from "./phones";
import { advanceCampaign } from "./pipeline";
import { advancePosts } from "./publish";
import { loadSettings } from "./settings";
import { advanceStatics } from "./statics/pipeline";

// One loop drives every campaign, static ad pack, post, brand autopilot and phone session. It is safe to restart at
// any time: all state lives in the store and every provider call is idempotent or polled.
//
// On a machine that stays up, the loop runs in-process every 4 s. On a serverless host nothing runs
// between requests, so Convex calls /api/worker/tick: every 10 s while a campaign is in flight, and
// every 5 minutes otherwise (convex/worker.ts). A lease in the store keeps two ticks from
// overlapping, whichever instance they run on.

declare global {
  var __nomenWorker: { timer: NodeJS.Timeout; busy: boolean } | undefined;
}

const TICK_MS = 4000;
/** A tick may run this long before another may take over (the tick route stops at 300 s). */
const LEASE_MS = 300_000;

export function startWorker() {
  if (globalThis.__nomenWorker || process.env.NOMEN_WORKER === "off" || process.env.VERCEL) return;
  const state = { timer: setInterval(() => void tick(), TICK_MS), busy: false };
  state.timer.unref?.();
  globalThis.__nomenWorker = state;
}

export async function tick() {
  const state = globalThis.__nomenWorker;
  if (state?.busy) return;
  if (state) state.busy = true;
  const holder = randomUUID();
  let leased = false;
  try {
    leased = await store().lease.acquire("worker", holder, LEASE_MS);
    if (!leased) return;
    await loadSettings();
    const running = await store().find<{ id: string }>("campaigns", { status: "running" }, { order: [["created_at", "asc"]] });
    for (const { id } of running) await advanceCampaign(id);
    // Static ad packs and phones keep their own tables in SQLite; they don't run on Convex yet.
    if (store().kind === "sqlite") await advanceStatics().catch((error: unknown) => report("static ads", error));
    await advancePosts().catch((error: unknown) => report("posts", error));
    // After posts, so the loop sees which of them are still going out.
    await advanceLoop().catch((error: unknown) => report("loop", error));
    if (store().kind === "sqlite") await advancePhones().catch((error: unknown) => report("phones", error));
  } catch (error) {
    await report("worker", error);
  } finally {
    if (leased) await store().lease.release("worker", holder).catch(() => undefined);
    if (state) state.busy = false;
  }
  if (leased) await store().nextTick(10_000).catch((error: unknown) => report("worker", error));
}

let lastReport = 0;
async function report(area: string, error: unknown) {
  if (Date.now() - lastReport < 60_000) return; // one log line a minute, not one per tick
  lastReport = Date.now();
  await logEvent({ level: "error", message: `${area}: ${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined);
}
