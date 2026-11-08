import { type GenericDatabaseReader, type GenericDataModel, type GenericMutationCtx, internalActionGeneric, internalMutationGeneric, makeFunctionReference, mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { guard } from "./auth";

// The heartbeat. Campaigns advance in small idempotent steps (src/lib/worker.ts). On a serverless
// host nothing runs between requests, so Convex asks the site to take the next step.
//
// While a campaign is in flight, each tick asks for the next one 10 s later (`continueTicking`),
// and the chain stops by itself when the work does. A cron every 5 minutes (crons.ts) restarts it
// if something is waiting and nothing is scheduled, and covers slow work: scheduled posts and
// analytics. So an idle site costs one small call every 5 minutes, not one every few seconds.

const kickRef = makeFunctionReference<"action">("worker:kick");
const clearRef = makeFunctionReference<"mutation">("worker:clearPending");
const MARKER = "next-tick";

/** Calls the site's tick route. The site answers at once and works in the background. */
export const kick = internalActionGeneric({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(clearRef as never, {});
    const site = process.env.NOMEN_SITE_URL;
    const secret = process.env.NOMEN_SERVER_SECRET;
    if (!site || !secret) return "not configured: NOMEN_SITE_URL and NOMEN_SERVER_SECRET are set by scripts/vercel-build.sh";
    const response = await fetch(`${site.replace(/\/+$/, "")}/api/worker/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(20_000),
    });
    return `tick: HTTP ${response.status}`;
  },
});

/** The scheduled tick has fired: the next one may be scheduled. */
export const clearPending = internalMutationGeneric({
  args: {},
  handler: async (ctx) => {
    const marker = await ctx.db
      .query("leases")
      .withIndex("by_name", (q) => q.eq("name", MARKER))
      .first();
    if (marker) await ctx.db.patch(marker._id as never, { expires_at: 0 });
  },
});

/** Schedules a tick in `delay` ms, unless one is already on its way. */
async function schedule(ctx: GenericMutationCtx<GenericDataModel>, delay: number) {
  const now = Date.now();
  const marker = await ctx.db
    .query("leases")
    .withIndex("by_name", (q) => q.eq("name", MARKER))
    .first();
  if (marker && (marker.expires_at as number) > now) return false;
  await ctx.scheduler.runAfter(delay, kickRef as never, {});
  // Pending until it should have fired, with room for a slow start.
  const expires_at = now + delay + 60_000;
  if (marker) await ctx.db.patch(marker._id as never, { holder: "scheduler", expires_at });
  else await ctx.db.insert("leases", { name: MARKER, holder: "scheduler", expires_at });
  return true;
}

type Reader = GenericDatabaseReader<GenericDataModel>;
const any = async (db: Reader, table: string, status: string) =>
  Boolean(
    await db
      .query(table)
      .withIndex("by_status", (q) => q.eq("status", status))
      .first(),
  );

/** Work that needs a tick every few seconds: campaigns moving, posts waiting to be sent. */
async function busy(db: Reader) {
  return (await any(db, "campaigns", "running")) || (await any(db, "campaigns", "publishing")) || (await any(db, "posts", "pending"));
}

/** Work that a tick every few minutes is enough for: posts on their way, fresh analytics. */
async function waiting(db: Reader) {
  if ((await any(db, "posts", "scheduled")) || (await any(db, "posts", "processing"))) return true;
  const fortnight = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const posted = await db
    .query("posts")
    .withIndex("by_status", (q) => q.eq("status", "posted"))
    .collect();
  return posted.some((post) => (post.created_at as string) > fortnight);
}

/** Called by the site at the end of each tick: tick again soon if a campaign is still in flight. */
export const continueTicking = mutationGeneric({
  args: { secret: v.string(), delay_ms: v.number() },
  handler: async (ctx, { secret, delay_ms }) => {
    guard(secret);
    return (await busy(ctx.db)) ? await schedule(ctx, delay_ms) : false;
  },
});

/** Every 5 minutes (crons.ts): restart the ticking if anything is waiting and nothing is scheduled. */
export const heartbeat = internalMutationGeneric({
  args: {},
  handler: async (ctx) => {
    if (!(await busy(ctx.db)) && !(await waiting(ctx.db))) return "idle";
    return (await schedule(ctx, 0)) ? "tick scheduled" : "a tick is already scheduled";
  },
});
