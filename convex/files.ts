import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { guard } from "./auth";

// Media in Convex file storage, named by the core's file keys ("crv_…/final.mp4"). The server
// uploads through a one-time upload URL, then records the key; the app serves the storage URL.

export const uploadUrl = mutationGeneric({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    guard(secret);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Names an uploaded file. A file already under that key is replaced and deleted. */
export const record = mutationGeneric({
  args: { secret: v.string(), key: v.string(), storage_id: v.id("_storage"), content_type: v.string(), size: v.number() },
  handler: async (ctx, { secret, ...file }) => {
    guard(secret);
    const existing = await ctx.db
      .query("files")
      .withIndex("by_key", (q) => q.eq("key", file.key))
      .first();
    if (existing) {
      if (existing.storage_id !== file.storage_id) await ctx.storage.delete(existing.storage_id);
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("files", { ...file, created_at: new Date().toISOString() });
  },
});

export const get = queryGeneric({
  args: { secret: v.string(), key: v.string() },
  handler: async (ctx, { secret, key }) => {
    guard(secret);
    const file = await ctx.db
      .query("files")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!file) return null;
    return { url: await ctx.storage.getUrl(file.storage_id), size: file.size, content_type: file.content_type };
  },
});

export const remove = mutationGeneric({
  args: { secret: v.string(), key: v.string() },
  handler: async (ctx, { secret, key }) => {
    guard(secret);
    const file = await ctx.db
      .query("files")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (!file) return;
    await ctx.storage.delete(file.storage_id);
    await ctx.db.delete(file._id);
  },
});
