import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { guard } from "./auth";

// A lease so only one worker tick runs at a time across serverless instances. A tick that dies
// without releasing it is forgotten when the lease expires.

export const acquire = mutationGeneric({
  args: { secret: v.string(), name: v.string(), holder: v.string(), ttl_ms: v.number() },
  handler: async (ctx, { secret, name, holder, ttl_ms }) => {
    guard(secret);
    const now = Date.now();
    const lease = await ctx.db
      .query("leases")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (lease && lease.expires_at > now && lease.holder !== holder) return false;
    if (lease) await ctx.db.patch(lease._id, { holder, expires_at: now + ttl_ms });
    else await ctx.db.insert("leases", { name, holder, expires_at: now + ttl_ms });
    return true;
  },
});

export const release = mutationGeneric({
  args: { secret: v.string(), name: v.string(), holder: v.string() },
  handler: async (ctx, { secret, name, holder }) => {
    guard(secret);
    const lease = await ctx.db
      .query("leases")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (lease?.holder === holder) await ctx.db.patch(lease._id, { expires_at: 0 });
  },
});
