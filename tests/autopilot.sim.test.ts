import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeNaive, NAIVE_BASE, postOut } from "./fake-naive";

// One autopilot cycle on a copy of a real database, with Naive faked at the network: a brand's
// campaign finishes, its video is scheduled and posted, its stats come in, and the next campaign
// starts within the weekly budget with those stats in the creative director's brief. Nothing
// leaves the machine and the database given is never written (the run works on a copy of it).
//
//   NOMEN_SIM_DB=data/nomen-e2e.db NOMEN_SIM_BRAND=brd_… NOMEN_SIM_CAMPAIGN=cmp_… \
//     npx vitest run tests/autopilot.sim.test.ts
//
// NOMEN_SIM_OUT=<folder> keeps the activity log and the director's brief from the run.

const source = process.env.NOMEN_SIM_DB ?? "";
const brandId = process.env.NOMEN_SIM_BRAND ?? "";
const campaignId = process.env.NOMEN_SIM_CAMPAIGN ?? "";
const M = 1_000_000;

describe.skipIf(!source || !brandId || !campaignId)("autopilot on a copy of a real database (simulation)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nomen-sim-"));
  const fake = fakeNaive();

  beforeAll(() => {
    const copy = join(dir, "sim.db");
    copyFileSync(source, copy);
    process.env.NOMEN_DB_PATH = copy;
    globalThis.__nomenDb = undefined;
    globalThis.__nomenStore = undefined;
    vi.stubEnv("NAIVE_API_KEY", "sk_test_simulation");
    vi.stubEnv("NAIVE_BASE_URL", NAIVE_BASE);
    vi.stubEnv("MONID_API_KEY", "");
    vi.stubGlobal("fetch", fake.fetchStub);
    fake.state.accounts = [
      { id: "acc_tt", platform: "tiktok", username: "naive.sim" },
      { id: "acc_yt", platform: "youtube", username: "Naive (sim)" },
    ];
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    globalThis.__nomenDb?.close();
    globalThis.__nomenDb = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("finishes, posts, reads the stats, and starts the next campaign with them in the director's brief", async () => {
    const { store } = await import("@/lib/db");
    const { advanceLoop, saveLoop, DEFAULT_LOOP, loopView } = await import("@/lib/loop");
    const { advanceCampaign } = await import("@/lib/pipeline");
    const { advancePosts } = await import("@/lib/publish");
    const started = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(started);

    // The brand's accounts are connected (faked), autopilot is on with automatic posting, and the
    // campaign's last video is done: anything still rendering in the copy is marked failed.
    await store().update("brands", { id: brandId }, { identity_id: "idn_sim", social_activated: 1 });
    await saveLoop(brandId, { ...DEFAULT_LOOP, enabled: true, weekly_budget_micro: 200 * M, cadence_days: 1, autopost: true });
    await store().update("creatives", { campaign_id: campaignId, status: { in: ["queued", "producing"] } }, { status: "failed", error: "simulation: still rendering on the live server" });
    await store().update("campaigns", { id: campaignId }, { status: "running", stage: "production", error: null });
    const ready = await store().find<{ id: string; concept_json: string }>("creatives", { campaign_id: campaignId, status: "ready", rejected: 0 });
    expect(ready.length).toBeGreaterThan(0);

    // 1. Production is done: review, then autopost approves and schedules the videos.
    await advanceCampaign(campaignId);
    await advancePosts();
    const queued = await store().find<{ id: string; status: string; scheduled_at: string; platforms_json: string }>("posts", { brand_id: brandId });
    expect(queued.map((p) => p.status)).toEqual(ready.map(() => "scheduled"));
    expect(fake.calls(/\/social\/posts$/, "POST")[0].body).toMatchObject({ ai_generated: true });
    await advanceLoop(new Date());

    // 2. The last post goes out at its slot; a few minutes later its stats come in.
    const last = queued.map((p) => Date.parse(p.scheduled_at)).sort().at(-1)!;
    vi.setSystemTime(last + 5 * 60_000);
    for (const post of fake.state.posts.values()) postOut(post, `https://www.tiktok.com/@naive.sim/video/${post.id}`);
    await advancePosts();
    fake.state.analytics = { data: { tiktok: { analytics: { videoViews: 18_400, likeCount: 960, commentsCount: 41, shareCount: 77 } }, youtube: { analytics: { views: 2_100, likes: 64, comments: 5 } } } };
    vi.setSystemTime(last + 10 * 60_000);
    await advancePosts();
    const posted = await store().find<{ status: string; analytics_json: string | null }>("posts", { brand_id: brandId });
    expect(posted.every((p) => p.status === "posted" && p.analytics_json)).toBe(true);

    // 3. A day on, the cadence is up and the budget has room: the next campaign starts.
    vi.setSystemTime(last + 24 * 3600_000 + 10 * 60_000);
    const before = (await store().find("campaigns", { brand_id: brandId })).length;
    await advanceLoop(new Date());
    const campaigns = await store().find<{ id: string; status: string; created_at: string }>("campaigns", { brand_id: brandId }, { order: [["created_at", "asc"]] });
    expect(campaigns).toHaveLength(before + 1);
    const next = campaigns.at(-1)!;
    expect(next.status).toBe("running");
    const view = await loopView(brandId, new Date());

    // 4. Its research done (the last campaign's, standing in), the director's brief carries the stats.
    const [prior] = await store().find<{ research_json: string; style_json: string | null }>("campaigns", { id: campaignId }, { limit: 1 });
    await store().update("campaigns", { id: next.id }, { stage: "strategy", research_json: prior.research_json, style_json: prior.style_json });
    await advanceCampaign(next.id);
    const message = String(fake.state.sessions[0]?.message ?? "");
    const past = JSON.parse(message.match(/<past_results>\n(.*)\n<\/past_results>/s)?.[1] ?? "[]") as Array<Record<string, unknown>>;
    expect(past.length).toBe(ready.length);
    expect(past[0]).toMatchObject({ status: "posted", stats: { views: 20_500, likes: 1_024, comments: 46, shares: 77 } });

    const log = (await store().events({ brand_id: brandId, limit: 40 })).reverse().filter((e) => e.ts >= started.toISOString());
    const out = process.env.NOMEN_SIM_OUT;
    if (out) {
      writeFileSync(join(out, "autopilot-sim-log.txt"), log.map((e) => `${e.ts} ${e.level.padEnd(5)} ${e.message}`).join("\n") + "\n");
      writeFileSync(join(out, "autopilot-sim-director-message.txt"), message);
      writeFileSync(join(out, "autopilot-sim-loop.json"), JSON.stringify({ loop: view, past_results: past }, null, 2));
    }
  }, 120_000);
});
