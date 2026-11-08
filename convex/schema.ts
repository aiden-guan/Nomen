import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The core's SQLite tables (src/lib/store/sqlite.ts) as Convex tables: same columns, same shapes.
// Ids stay the core's own strings ("brd_…", "cmp_…"); Convex's _id is internal.

const text = v.string();
const num = v.number();
const maybeText = v.union(v.string(), v.null());
const maybeNum = v.union(v.number(), v.null());

export default defineSchema({
  settings: defineTable({ key: text, value: text }).index("by_key", ["key"]),

  brands: defineTable({
    id: text,
    name: text,
    domain: text,
    url: text,
    profile_json: maybeText,
    identity_id: maybeText,
    social_activated: num,
    created_at: text,
    updated_at: text,
  })
    .index("by_row_id", ["id"])
    .index("by_domain", ["domain"]),

  campaigns: defineTable({
    id: text,
    brand_id: text,
    status: text,
    stage: text,
    error: maybeText,
    attempts: num,
    options_json: text,
    plan_json: maybeText,
    research_json: maybeText,
    style_build_id: maybeText,
    style_idem: maybeText,
    style_json: maybeText,
    style_started_at: maybeText,
    style_attempt: num,
    strategy_idem: maybeText,
    strategy_session_id: maybeText,
    strategy_nudges: num,
    strategy_json: maybeText,
    naive_out: num,
    style_spend_micro: num,
    strategy_spend_micro: num,
    naive_spend_micro: num,
    monid_spend_micro: num,
    created_at: text,
    updated_at: text,
  })
    .index("by_row_id", ["id"])
    .index("by_brand", ["brand_id"])
    .index("by_status", ["status"]),

  monid_runs: defineTable({
    id: text,
    campaign_id: text,
    key: text,
    phase: text,
    provider: text,
    endpoint: text,
    input_json: text,
    run_id: maybeText,
    status: text,
    output_json: maybeText,
    error: maybeText,
    cost_micro: num,
    created_at: text,
    updated_at: text,
  })
    .index("by_row_id", ["id"])
    .index("by_campaign", ["campaign_id"]),

  creatives: defineTable({
    id: text,
    campaign_id: text,
    idx: num,
    generation: num,
    concept_json: text,
    shots_json: text,
    status: text,
    final_file_id: maybeText,
    final_url: maybeText,
    final_url_expires_at: maybeText,
    final_external_url: maybeText,
    final_key: maybeText,
    poster_url: maybeText,
    qc_score: maybeNum,
    continuity_json: maybeText,
    caption: text,
    platforms_json: text,
    approved: num,
    rejected: num,
    cost_micro: num,
    error: maybeText,
    created_at: text,
    updated_at: text,
  })
    .index("by_row_id", ["id"])
    .index("by_campaign", ["campaign_id"]),

  posts: defineTable({
    id: text,
    creative_id: text,
    brand_id: text,
    idem: text,
    naive_post_id: maybeText,
    platforms_json: text,
    scheduled_at: maybeText,
    status: text,
    result_json: maybeText,
    analytics_json: maybeText,
    analytics_at: maybeText,
    error: maybeText,
    created_at: text,
    updated_at: text,
  })
    .index("by_row_id", ["id"])
    .index("by_creative", ["creative_id"])
    .index("by_brand", ["brand_id"])
    .index("by_status", ["status"]),

  events: defineTable({ brand_id: maybeText, campaign_id: maybeText, ts: text, level: text, message: text })
    .index("by_brand", ["brand_id"])
    .index("by_campaign", ["campaign_id"]),

  /** Each brand's autopilot (src/lib/loop.ts). */
  brand_loops: defineTable({
    brand_id: text,
    enabled: num,
    weekly_budget_micro: num,
    cadence_days: num,
    autopost: num,
    waived_campaign_id: maybeText,
    last_json: maybeText,
    updated_at: text,
  })
    .index("by_brand", ["brand_id"])
    .index("by_enabled", ["enabled"]),

  /** Media (renders, frames, finished videos) by the core's file key, like "crv_…/final.mp4". */
  files: defineTable({ key: text, storage_id: v.id("_storage"), content_type: text, size: num, created_at: text }).index("by_key", ["key"]),

  /** Who is running the worker tick, so two ticks never overlap. */
  leases: defineTable({ name: text, holder: text, expires_at: num }).index("by_name", ["name"]),
});
