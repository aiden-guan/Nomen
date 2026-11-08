import { db, logEvent } from "./db";
import { advanceLoop } from "./loop";
import { advancePhones } from "./phones";
import { advanceCampaign } from "./pipeline";
import { advancePosts } from "./publish";

// One in-process loop drives every campaign, post, brand autopilot and phone session. It is safe to
// restart at any time: all state lives in SQLite and every provider call is idempotent or polled.

declare global {
  var __nomenWorker: { timer: NodeJS.Timeout; busy: boolean } | undefined;
}

const TICK_MS = 4000;

export function startWorker() {
  if (globalThis.__nomenWorker || process.env.NOMEN_WORKER === "off") return;
  const state = { timer: setInterval(() => void tick(), TICK_MS), busy: false };
  state.timer.unref?.();
  globalThis.__nomenWorker = state;
}

export async function tick() {
  const state = globalThis.__nomenWorker;
  if (state?.busy) return;
  if (state) state.busy = true;
  try {
    const running = db().prepare("select id from campaigns where status = 'running' order by created_at").all() as Array<{ id: string }>;
    for (const { id } of running) await advanceCampaign(id);
    await advancePosts().catch((error: unknown) => report("posts", error));
    // After posts, so the loop sees which of them are still going out.
    await advanceLoop().catch((error: unknown) => report("loop", error));
    await advancePhones().catch((error: unknown) => report("phones", error));
  } catch (error) {
    report("worker", error);
  } finally {
    if (state) state.busy = false;
  }
}

let lastReport = 0;
function report(area: string, error: unknown) {
  if (Date.now() - lastReport < 60_000) return; // one log line a minute, not one per tick
  lastReport = Date.now();
  logEvent({ level: "error", message: `${area}: ${error instanceof Error ? error.message : String(error)}` });
}
