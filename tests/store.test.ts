import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "../convex/schema";
import { store, useStore } from "@/lib/store";
import { type ConvexCaller, convexStore } from "@/lib/store/convex";
import { sqliteConnection, sqliteStore } from "@/lib/store/sqlite";
import type { Store } from "@/lib/store/types";
import { approveAll } from "@/lib/publish";
import { type CampaignOptions, createBrand, getCampaign, listCreatives, recomputeSpend, regenerateCreative, retryCampaign, startCampaign } from "@/lib/pipeline";
import { insertCreative } from "@/lib/production";
import { brandList, brandView } from "@/lib/views";
import { tick } from "@/lib/worker";
import { getSetting, loadSettings, setSetting } from "@/lib/settings";

// The core's store has two backends: SQLite (a machine with a disk) and Convex (serverless hosts).
// Every test here runs against both, the Convex one on convex-test's in-memory backend running the
// real functions in convex/, so the two can't drift apart.

const SECRET = "test-secret-".padEnd(40, "x");
process.env.NOMEN_SERVER_SECRET = SECRET;

const modules = import.meta.glob("../convex/**/*.ts");

function memoryConvex(): ConvexCaller {
  const t = convexTest(schema, modules);
  return {
    query: (name, args) => t.query(makeFunctionReference<"query">(name), { ...args, secret: SECRET } as never),
    mutation: (name, args) => t.mutation(makeFunctionReference<"mutation">(name), { ...args, secret: SECRET } as never),
  };
}

function freshSqlite(): Store {
  const db = sqliteConnection();
  for (const table of ["events", "posts", "creatives", "monid_runs", "campaigns", "brands", "settings"]) db.prepare(`delete from ${table}`).run();
  return sqliteStore();
}

const BACKENDS: Array<[string, () => Store]> = [
  ["SQLite", freshSqlite],
  ["Convex", () => convexStore(memoryConvex())],
];

const OPTIONS: CampaignOptions = { concepts: 2, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1", learnStyle: true };
const brandRow = (id: string, domain: string, updated = "2026-01-01T10:00:00.000Z") => ({ id, name: domain, domain, url: `https://${domain}`, created_at: updated, updated_at: updated });

describe.each(BACKENDS)("the %s store", (_name, make) => {
  let s: Store;
  beforeEach(() => {
    s = make();
    useStore(s);
  });
  afterEach(() => useStore(undefined));

  it("fills in the table's defaults and finds rows by conditions", async () => {
    await s.insert("brands", brandRow("brd_a", "a.example"));
    await s.insert("brands", { ...brandRow("brd_b", "b.example"), identity_id: "idn_1" });
    const [a] = await s.find<Record<string, unknown>>("brands", { id: "brd_a" });
    expect(a).toMatchObject({ id: "brd_a", profile_json: null, identity_id: null, social_activated: 0 });
    expect(await s.find("brands", { identity_id: null })).toHaveLength(1);
    expect(await s.find("brands", { identity_id: { ne: null } })).toHaveLength(1);
    expect(await s.find("brands", { domain: { in: ["a.example", "b.example", "c.example"] } })).toHaveLength(2);
    expect(await s.find("brands", { domain: { in: [] } })).toHaveLength(0);
    expect(await s.find("brands", { updated_at: { lte: "2026-01-01T10:00:00.000Z" } })).toHaveLength(2);
  });

  it("orders, limits, and breaks ties by insertion order", async () => {
    for (const [i, day] of ["03", "01", "03", "02"].entries()) await s.insert("brands", brandRow(`brd_${i}`, `${i}.example`, `2026-11-${day}T00:00:00.000Z`));
    const asc = await s.find<{ id: string }>("brands", {}, { order: [["updated_at", "asc"]] });
    expect(asc.map((r) => r.id)).toEqual(["brd_1", "brd_3", "brd_0", "brd_2"]);
    const desc = await s.find<{ id: string }>("brands", {}, { order: [["updated_at", "desc"]], limit: 3 });
    expect(desc.map((r) => r.id)).toEqual(["brd_2", "brd_0", "brd_3"]);
  });

  it("does nothing on a duplicate of the unique columns", async () => {
    await s.insert("brands", brandRow("brd_1", "one.example"));
    await s.insert("campaigns", { id: "cmp_1", brand_id: "brd_1", status: "running", stage: "research", options_json: "{}", created_at: "t", updated_at: "t" });
    const run = { id: "run_1", campaign_id: "cmp_1", key: "site", phase: "A", provider: "p", endpoint: "/e", input_json: "{}", status: "pending", created_at: "t", updated_at: "t" };
    expect(await s.insert("monid_runs", run, { unique: ["campaign_id", "key"] })).toBe(true);
    expect(await s.insert("monid_runs", { ...run, id: "run_2" }, { unique: ["campaign_id", "key"] })).toBe(false);
    expect(await s.find("monid_runs", { campaign_id: "cmp_1" })).toHaveLength(1);
  });

  it("updates matching rows, stamps updated_at and removes rows", async () => {
    await s.insert("brands", brandRow("brd_a", "a.example"));
    await s.insert("brands", brandRow("brd_b", "b.example"));
    expect(await s.update("brands", { id: "brd_a" }, { social_activated: 1, identity_id: "idn" })).toBe(1);
    const [a] = await s.find<{ social_activated: number; updated_at: string }>("brands", { id: "brd_a" });
    expect(a.social_activated).toBe(1);
    expect(a.updated_at > "2026-01-01T10:00:00.000Z").toBe(true);
    expect(await s.update("brands", { domain: { in: ["a.example", "b.example"] } }, { name: "x" })).toBe(2);
    expect(await s.remove("brands", { id: "brd_b" })).toBe(1);
    expect(await s.find("brands")).toHaveLength(1);
  });

  it("keeps settings by key", async () => {
    await setSetting("video_seconds", "6");
    await loadSettings();
    expect(getSetting("video_seconds")).toBe("6");
    await setSetting("video_seconds", "10");
    expect(getSetting("video_seconds")).toBe("10");
    expect(await s.find("settings", { key: "video_seconds" })).toHaveLength(1);
  });

  it("logs events and reads them newest first", async () => {
    for (const message of ["one", "two", "three"]) await s.logEvent({ brand_id: "brd_a", campaign_id: "cmp_a", ts: "2026-11-08T10:00:00.000Z", level: "info", message });
    expect((await s.events({ brand_id: "brd_a", limit: 2 })).map((e) => e.message)).toEqual(["three", "two"]);
    expect((await s.events({ campaign_id: "cmp_a" })).map((e) => e.message)).toEqual(["three", "two", "one"]);
  });

  it("hands one tick at a time the lease", async () => {
    if (s.kind === "sqlite") return; // one process: the in-process flag does this
    expect(await s.lease.acquire("worker", "a", 60_000)).toBe(true);
    expect(await s.lease.acquire("worker", "b", 60_000)).toBe(false);
    await s.lease.release("worker", "a");
    expect(await s.lease.acquire("worker", "b", 60_000)).toBe(true);
  });
});

describe.each(BACKENDS)("the pipeline on the %s store", (_name, make) => {
  beforeEach(() => useStore(make()));
  afterEach(() => useStore(undefined));

  it("creates a brand once per domain, starts a campaign and shows it", async () => {
    const brandId = await createBrand("https://www.Acme.example/pricing");
    expect(await createBrand("acme.example")).toBe(brandId);
    const campaignId = await startCampaign(brandId, OPTIONS);
    const view = (await brandView(brandId))!;
    expect(view.brand).toMatchObject({ id: brandId, name: "Acme", domain: "acme.example", connected: false });
    expect(view.campaign).toMatchObject({ id: campaignId, status: "running", stage: "research", stageIndex: 0, options: OPTIONS, runs: [], creatives: [], posts: [] });
    expect(view.events[0].message).toBe("Campaign started: 2 videos, 2 shots each, google/veo-3.1");
    const [listed] = await brandList();
    expect(listed).toMatchObject({ id: brandId, campaign: { id: campaignId, stage: "research" }, ready: 0, total: 0, poster: null });
    expect(await brandView("brd_nope")).toBeNull();
  });

  it("retries failed research, re-shoots a video, approves the cut and adds up the spend", async () => {
    const brandId = await createBrand("acme.example");
    const campaignId = await startCampaign(brandId, OPTIONS);
    const run = (key: string, status: string, cost: number) => ({ id: `run_${key}`, campaign_id: campaignId, key, phase: "A", provider: "p", endpoint: "/e", input_json: "{}", status, cost_micro: cost, created_at: "t", updated_at: "t" });
    await store().insert("monid_runs", run("site", "done", 30_000));
    await store().insert("monid_runs", run("seo", "failed", 0));
    await retryCampaign(campaignId);
    expect((await store().find<{ key: string; status: string }>("monid_runs", { campaign_id: campaignId }, { order: [["key", "asc"]] })).map((r) => [r.key, r.status])).toEqual([
      ["seo", "pending"],
      ["site", "done"],
    ]);

    const concept = { title: "Swap", format: "UGC", angle: "a", platforms: ["tiktok"], hook: "h", creator: "", setting: "", shots: [{ frame_prompt: "f", video_prompt: "v", seconds: 8 }], reference_images: [], caption: "c", hashtags: [], cta: "", inspired_by: [], why: "" };
    const first = await insertCreative(campaignId, 0, concept as never);
    const second = await insertCreative(campaignId, 1, concept as never);
    const shots = (n: number) => JSON.stringify([{ n: 1, status: "passed", naive_cost: n, monid_cost: 1000 }]);
    await store().update("creatives", { id: first }, { status: "ready", shots_json: shots(3_200_000) });
    await store().update("creatives", { id: second }, { status: "ready", shots_json: shots(3_200_000) });
    const retake = await regenerateCreative(second, "brighter");
    const creatives = await listCreatives(campaignId);
    expect(creatives.map((c) => [c.idx, c.generation, c.rejected])).toEqual([
      [0, 1, 0],
      [1, 1, 1],
      [1, 2, 0],
    ]);
    expect(creatives.find((c) => c.id === retake)!.concept_json).toContain("brighter");
    await approveAll(campaignId);
    expect((await listCreatives(campaignId)).map((c) => c.approved)).toEqual([1, 0, 0]);

    await recomputeSpend(campaignId);
    const campaign = (await getCampaign(campaignId))!;
    // The retake starts with fresh shots: only the two finished videos have spent anything.
    expect(campaign.monid_spend_micro).toBe(30_000 + 2 * 1000);
    expect(campaign.naive_spend_micro).toBe(2 * 3_200_000);
    const view = (await brandView(brandId))!;
    expect(view.campaign!.creatives.map((c) => c.id)).toEqual([first, retake]);
    expect(view.campaign!.creatives[0]).toMatchObject({ approved: true, videoUrl: null });
  });

  it("runs a tick that finds nothing to do and lets go of the lease", async () => {
    await tick();
    if (store().kind === "convex") expect(await store().lease.acquire("worker", "someone-else", 1000)).toBe(true);
  });
});

describe("the Convex functions", () => {
  it("refuse callers without the server secret", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(makeFunctionReference<"query">("rows:find"), { secret: "wrong".padEnd(40, "!"), table: "brands" })).rejects.toThrow(/Forbidden/);
    await expect(t.query(makeFunctionReference<"query">("rows:find"), { secret: SECRET, table: "nope" })).rejects.toThrow(/Unknown table/);
  });

  it("name stored files by key and replace them", async () => {
    const t = convexTest(schema, modules);
    const put = async (text: string) => {
      const id = await t.run((ctx) => ctx.storage.store(new Blob([text], { type: "video/mp4" })));
      await t.mutation(makeFunctionReference<"mutation">("files:record"), { secret: SECRET, key: "crv_1/final.mp4", storage_id: id, content_type: "video/mp4", size: text.length });
      return id;
    };
    const before = await put("first cut");
    await put("second cut");
    const file = await t.query(makeFunctionReference<"query">("files:get"), { secret: SECRET, key: "crv_1/final.mp4" });
    expect(file).toMatchObject({ size: "second cut".length, content_type: "video/mp4" });
    expect(await t.run((ctx) => ctx.storage.get(before))).toBeNull();
    expect(await t.query(makeFunctionReference<"query">("files:get"), { secret: SECRET, key: "crv_2/final.mp4" })).toBeNull();
  });
});

describe("the Convex worker schedule", () => {
  const ref = {
    insert: makeFunctionReference<"mutation">("rows:insert"),
    update: makeFunctionReference<"mutation">("rows:update"),
    continueTicking: makeFunctionReference<"mutation">("worker:continueTicking"),
    heartbeat: makeFunctionReference<"mutation">("worker:heartbeat"),
    kick: makeFunctionReference<"action">("worker:kick"),
  };
  const scheduled = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  const campaign = { id: "cmp_1", brand_id: "brd_1", status: "running", stage: "research", options_json: "{}", created_at: "t", updated_at: "t" };

  it("keeps ticking while a campaign is in flight, once at a time, and stops when it isn't", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(ref.continueTicking, { secret: SECRET, delay_ms: 10_000 })).toBe(false);
    await t.mutation(ref.insert, { secret: SECRET, table: "campaigns", row: campaign });
    expect(await t.mutation(ref.continueTicking, { secret: SECRET, delay_ms: 10_000 })).toBe(true);
    expect(await t.mutation(ref.continueTicking, { secret: SECRET, delay_ms: 10_000 })).toBe(false);
    expect(await scheduled(t)).toHaveLength(1);
    // The tick fires (without a site configured, it only clears the way for the next one).
    expect(await t.action(ref.kick, {})).toMatch(/not configured/);
    expect(await t.mutation(ref.continueTicking, { secret: SECRET, delay_ms: 10_000 })).toBe(true);
    await t.mutation(ref.update, { secret: SECRET, table: "campaigns", where: { id: "cmp_1" }, fields: { status: "review" } });
    await t.action(ref.kick, {});
    expect(await t.mutation(ref.continueTicking, { secret: SECRET, delay_ms: 10_000 })).toBe(false);
  });

  it("lets the heartbeat sleep when nothing waits, and wake for posts on their way", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(ref.heartbeat, {})).toBe("idle");
    const post = { id: "pst_1", creative_id: "crv_1", brand_id: "brd_1", idem: "i", platforms_json: "[]", status: "scheduled", created_at: new Date().toISOString(), updated_at: "t" };
    await t.mutation(ref.insert, { secret: SECRET, table: "posts", row: post });
    expect(await t.mutation(ref.heartbeat, {})).toBe("tick scheduled");
    expect(await t.mutation(ref.heartbeat, {})).toBe("a tick is already scheduled");
    // A scheduled post alone doesn't keep the fast chain going.
    await t.action(ref.kick, {});
    expect(await t.mutation(ref.continueTicking, { secret: SECRET, delay_ms: 10_000 })).toBe(false);
  });
});
