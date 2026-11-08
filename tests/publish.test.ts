import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as campaignPost } from "@/app/api/campaigns/[id]/route";
import { now, store } from "@/lib/db";
import { advanceLoop, saveLoop, DEFAULT_LOOP } from "@/lib/loop";
import { advanceCampaign, getCampaign } from "@/lib/pipeline";
import { advancePosts, type PostRow, postStats, publishCampaign } from "@/lib/publish";
import { compactResearch } from "@/lib/research";
import { useStore } from "@/lib/store";
import { sqliteConnection, sqliteStore } from "@/lib/store/sqlite";
import type { Files } from "@/lib/store/types";
import { brandView } from "@/lib/views";
import { fakeNaive, NAIVE_BASE, postOut } from "./fake-naive";

// Everything after "a video is ready": queueing, uploading the cut, posting, following the post,
// its stats, and the autopilot's next campaign. Real code throughout; only Naive's HTTP is faked.

const BRAND = "brd_post";
const CAMPAIGN = "cmp_post";
const T0 = Date.parse("2026-11-08T05:00:00.000Z");
const M = 1_000_000;
const CUT = Buffer.from("a finished cut, as bytes");

let root = "";
let fake: ReturnType<typeof fakeNaive>;

/** The store's files in a temp folder, the way production keeps the cut ("crv_…/final.mp4"). */
function tempFiles(dir: string): Files {
  const at = (key: string) => join(dir, key);
  return {
    async putFile(key, path) {
      await mkdir(dirname(at(key)), { recursive: true });
      await copyFile(path, at(key));
    },
    async saveUrl() {
      throw new Error("no downloads in this test");
    },
    async exists(key) {
      return existsSync(at(key));
    },
    async localPath(key) {
      return at(key);
    },
    async url(key) {
      return existsSync(at(key)) ? `/api/media/${key}` : null;
    },
  };
}

async function storeCut(creativeId: string) {
  const path = join(root, `${creativeId}-cut.mp4`);
  await writeFile(path, CUT);
  await store().files.putFile(`${creativeId}/final.mp4`, path, "video/mp4");
  return `${creativeId}/final.mp4`;
}

async function setCampaign(fields: Record<string, unknown>) {
  await store().update("campaigns", { id: CAMPAIGN }, fields);
}

let idx = 0;
type CreativeFields = { id?: string; status?: string; approved?: number; final_file_id?: string | null; final_key?: string | null; final_external_url?: string | null; platforms?: string[]; concept?: Record<string, unknown>; campaign?: string };
async function addCreative(fields: CreativeFields = {}) {
  const id = fields.id ?? `crv_${++idx}`;
  await store().insert("creatives", {
    id,
    campaign_id: fields.campaign ?? CAMPAIGN,
    idx: idx,
    generation: 1,
    concept_json: JSON.stringify(fields.concept ?? { title: "Deploy a company in 3 steps", format: "talking_head_broll", hook: "I gave an agent $3 and one skill file" }),
    shots_json: "[]",
    status: fields.status ?? "ready",
    caption: "Three steps to a running company.",
    platforms_json: JSON.stringify(fields.platforms ?? ["tiktok"]),
    approved: fields.approved ?? 1,
    rejected: 0,
    final_file_id: fields.final_file_id ?? null,
    final_key: fields.final_key ?? null,
    final_external_url: fields.final_external_url ?? null,
    created_at: now(),
    updated_at: now(),
  });
  return id;
}

const posts = () => store().find<PostRow>("posts", {}, { order: [["created_at", "asc"]] });
const creative = async (id: string) => (await store().find<{ final_file_id: string | null }>("creatives", { id }, { limit: 1 }))[0];
const messages = async () => (await store().events({ brand_id: BRAND, limit: 100 })).map((e) => e.message);
const creates = () => fake.calls(/\/social\/posts$/, "POST");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nomen-publish-"));
});
afterAll(async () => {
  useStore(undefined);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  const db = sqliteConnection();
  for (const table of ["events", "posts", "creatives", "monid_runs", "campaigns", "brand_loops", "brands", "settings"]) db.prepare(`delete from ${table}`).run();
  useStore({ ...sqliteStore(), files: tempFiles(join(root, `files-${Math.random().toString(36).slice(2)}`)) });
  vi.stubEnv("NAIVE_API_KEY", "sk_test_publish");
  vi.stubEnv("NAIVE_BASE_URL", NAIVE_BASE);
  fake = fakeNaive();
  fake.state.accounts = [{ id: "acc_tt", platform: "tiktok", username: "naive.agents" }];
  vi.stubGlobal("fetch", fake.fetchStub);
  await store().insert("brands", { id: BRAND, name: "Naïve", domain: "usenaive.ai", url: "https://usenaive.ai", identity_id: "idn_naive", social_activated: 1, created_at: now(), updated_at: now() });
  await store().insert("campaigns", {
    id: CAMPAIGN,
    brand_id: BRAND,
    status: "review",
    stage: "review",
    options_json: JSON.stringify({ concepts: 2, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1", learnStyle: false }),
    created_at: now(),
    updated_at: now(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("publishCampaign", () => {
  it("queues an approved video whose upload to Naive failed during production, from its stored cut", async () => {
    const id = await addCreative({ final_key: await storeCut("crv_cut") });
    expect(await publishCampaign(CAMPAIGN, "now")).toEqual({ queued: 1, skipped: [] });
    expect(await posts()).toMatchObject([{ creative_id: id, status: "pending", platforms_json: '["tiktok"]', scheduled_at: null }]);
  });

  it("never queues an internal remake, even approved, and says why", async () => {
    await addCreative({ final_file_id: "fil_a", concept: { title: "Remake", internal: true } });
    await expect(publishCampaign(CAMPAIGN, "now")).rejects.toThrow("internal remakes");
    expect(await posts()).toEqual([]);

    // A remake brief without the flag is held too; a regular video next to them goes out alone.
    await addCreative({ final_file_id: "fil_b", concept: { title: "Remake 2", brief: { format: "remake" } } });
    const regular = await addCreative({ final_file_id: "fil_c" });
    expect(await publishCampaign(CAMPAIGN, "now")).toMatchObject({ queued: 1 });
    expect((await posts()).map((p) => p.creative_id)).toEqual([regular]);
    expect(await messages()).toContainEqual(expect.stringContaining("Held back 2 internal remakes"));
  });

  it("posts an internal remake once a named person cleared it", async () => {
    const id = await addCreative({ final_file_id: "fil_a", concept: { title: "Remake", internal: true, cleared: { at: now(), by: "Dylan", note: "licensed from the creator" } } });
    expect(await publishCampaign(CAMPAIGN, "now")).toMatchObject({ queued: 1 });
    expect((await posts())[0].creative_id).toBe(id);
  });

  it("leaves a campaign running while its other videos are still being made", async () => {
    await setCampaign({ status: "running", stage: "production" });
    await addCreative({ final_file_id: "fil_a" });
    await addCreative({ status: "producing", approved: 0 });
    await publishCampaign(CAMPAIGN, "now");
    expect((await getCampaign(CAMPAIGN))!.status).toBe("running");
  });

  it("moves a reviewed campaign to publishing", async () => {
    await addCreative({ final_file_id: "fil_a" });
    await publishCampaign(CAMPAIGN, "now");
    expect((await getCampaign(CAMPAIGN))!.status).toBe("publishing");
  });

  it("posts only the chosen video to the chosen network, privately when asked", async () => {
    fake.state.accounts = [
      { id: "acc_tt", platform: "tiktok", username: "naive.agents" },
      { id: "acc_yt", platform: "youtube", username: "Naive" },
    ];
    const chosen = await addCreative({ final_file_id: "fil_a", platforms: ["tiktok", "youtube"] });
    await addCreative({ final_file_id: "fil_b" });
    expect(await publishCampaign(CAMPAIGN, "now", { creativeIds: [chosen], platforms: ["youtube"], visibility: "private" })).toEqual({ queued: 1, skipped: [] });
    await advancePosts();
    expect(creates()).toHaveLength(1);
    expect(creates()[0].body).toMatchObject({ platforms: ["youtube"], file_ids: ["fil_a"], visibility: "private", ai_generated: true });
  });

  it("refuses a private post on a network that only posts publicly", async () => {
    await addCreative({ final_file_id: "fil_a" });
    await expect(publishCampaign(CAMPAIGN, "now", { platforms: ["tiktok"], visibility: "private" })).rejects.toThrow(/YouTube/);
    expect(await posts()).toEqual([]);
  });

  it("refuses a network the brand has not connected", async () => {
    await addCreative({ final_file_id: "fil_a" });
    await expect(publishCampaign(CAMPAIGN, "now", { platforms: ["youtube"] })).rejects.toThrow(/YouTube/);
  });
});

describe("the publish action", () => {
  const publish = (payload: unknown) => campaignPost(new Request(`http://localhost/api/campaigns/${CAMPAIGN}`, { method: "POST", body: JSON.stringify(payload) }), { params: Promise.resolve({ id: CAMPAIGN }) });

  it("passes the chosen video, network and visibility through", async () => {
    fake.state.accounts = [
      { id: "acc_tt", platform: "tiktok", username: "naive.agents" },
      { id: "acc_yt", platform: "youtube", username: "Naive" },
    ];
    const chosen = await addCreative({ final_file_id: "fil_a" });
    await addCreative({ final_file_id: "fil_b" });
    const response = await publish({ action: "publish", mode: "now", creativeIds: [chosen], platforms: ["youtube"], visibility: "private" });
    expect(await response.json()).toEqual({ queued: 1, skipped: [] });
    expect(await posts()).toMatchObject([{ creative_id: chosen, platforms_json: '["youtube"]', result_json: '{"request":{"visibility":"private"}}' }]);
  });

  it("refuses a visibility it does not know", async () => {
    await addCreative({ final_file_id: "fil_a" });
    const response = await publish({ action: "publish", mode: "now", visibility: "secret" });
    expect(response.status).toBe(400);
    expect(await posts()).toEqual([]);
  });
});

describe("advancePosts", () => {
  it("uploads the stored cut first when production could not, and posts that file", async () => {
    const id = await addCreative({ final_key: await storeCut("crv_cut") });
    await publishCampaign(CAMPAIGN, "now");
    await advancePosts();
    expect(fake.calls(/^\/v1\/files\/uploads$/)).toHaveLength(1);
    expect(fake.calls(/^https:\/\/upload\.test\//, "PUT")[0].body).toEqual({ bytes: CUT.length });
    expect(creates()[0].body).toMatchObject({ file_ids: ["fil_up1"], platforms: ["tiktok"], ai_generated: true });
    expect((await creative(id)).final_file_id).toBe("fil_up1");
    expect((await posts())[0]).toMatchObject({ status: "processing", naive_post_id: "spo_1", error: null });
  });

  it("waits out Naive being at capacity on the upload, then posts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await addCreative({ final_key: await storeCut("crv_cut") });
    await publishCampaign(CAMPAIGN, "now");
    fake.state.busy.upload = 1;

    await advancePosts();
    expect((await posts())[0]).toMatchObject({ status: "pending", error: expect.stringContaining("at capacity") });
    expect(creates()).toHaveLength(0);

    // The worker ticks every few seconds; it leaves a busy Naive alone for a while.
    vi.setSystemTime(T0 + 5_000);
    await advancePosts();
    expect(fake.calls(/^\/v1\/files\/uploads$/)).toHaveLength(1);

    vi.setSystemTime(T0 + 61_000);
    await advancePosts();
    expect(fake.calls(/^\/v1\/files\/uploads$/)).toHaveLength(2);
    expect((await posts())[0]).toMatchObject({ status: "processing", error: null });
  });

  it("retries a post Naive was too busy to take, with the same idempotency key and body", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await addCreative({ final_file_id: "fil_a" });
    await publishCampaign(CAMPAIGN, "now");
    fake.state.busy.createPost = 1;
    await advancePosts();
    vi.setSystemTime(T0 + 61_000);
    await advancePosts();
    const [first, second] = creates();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.body).toEqual(first.body);
    expect((await posts())[0]).toMatchObject({ status: "processing", naive_post_id: "spo_1", error: null });
  });

  it("follows a post until it is out, then reads its link and stats for the camp", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await addCreative({ final_file_id: "fil_a" });
    await publishCampaign(CAMPAIGN, "now");
    await advancePosts();
    postOut(fake.state.posts.get("spo_1")!, "https://www.tiktok.com/@naive.agents/video/1");

    vi.setSystemTime(T0 + 61_000);
    await advancePosts();
    expect((await posts())[0].status).toBe("posted");
    expect(await messages()).toContainEqual("Posted to TikTok: https://www.tiktok.com/@naive.agents/video/1");

    fake.state.analytics = { data: { tiktok: { id: "1", analytics: { videoViews: 1200, likeCount: 40, commentsCount: 3, shareCount: 2 } } } };
    vi.setSystemTime(T0 + 122_000);
    await advancePosts();
    const [post] = (await brandView(BRAND))!.campaign!.posts;
    expect(post).toMatchObject({ status: "posted", url: "https://www.tiktok.com/@naive.agents/video/1", stats: { views: 1200, likes: 40, comments: 3, shares: 2 } });
    expect((await getCampaign(CAMPAIGN))!.status).toBe("live");
  });

  it("says so when a post is out the moment it is submitted", async () => {
    fake.state.createdStatus = "posted";
    await addCreative({ final_file_id: "fil_a" });
    await publishCampaign(CAMPAIGN, "now");
    await advancePosts();
    expect((await posts())[0].status).toBe("posted");
    expect(await messages()).toContainEqual("Posted to TikTok");
  });

  it("leaves a scheduled post alone until it is due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0); // 05:00 UTC: the day's slot is 16:00
    await addCreative({ final_file_id: "fil_a" });
    await publishCampaign(CAMPAIGN, "daily");
    await advancePosts();
    expect((await posts())[0].status).toBe("scheduled");
    const reads = () => fake.calls(/\/social\/posts\/spo_1$/, "GET");

    vi.setSystemTime(Date.parse("2026-11-08T12:00:00.000Z"));
    await advancePosts();
    expect(reads()).toHaveLength(0);

    vi.setSystemTime(Date.parse("2026-11-08T16:01:00.000Z"));
    await advancePosts();
    expect(reads()).toHaveLength(1);
  });

  it("stops a queued internal remake before it reaches Naive", async () => {
    const id = await addCreative({ final_file_id: "fil_a", concept: { title: "Remake", brief: { format: "remake" } } });
    await store().insert("posts", { id: "pst_old", creative_id: id, brand_id: BRAND, idem: "pst_old-publish", platforms_json: '["tiktok"]', status: "pending", created_at: now(), updated_at: now() });
    await advancePosts();
    expect(creates()).toHaveLength(0);
    expect((await posts())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("internal remake") });
  });

  it("keeps the network's reason when a post fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await addCreative({ final_file_id: "fil_a" });
    await publishCampaign(CAMPAIGN, "now");
    await advancePosts();
    Object.assign(fake.state.posts.get("spo_1")!, { status: "failed", error: "tiktok: the video is shorter than 3 seconds" });
    vi.setSystemTime(T0 + 61_000);
    await advancePosts();
    expect((await posts())[0]).toMatchObject({ status: "failed", error: "tiktok: the video is shorter than 3 seconds" });
  });
});

describe("postStats", () => {
  it("adds up each network's numbers from Naive's provider-shaped analytics", () => {
    const analytics = { data: { tiktok: { analytics: { videoViews: 1000, likeCount: 30, commentsCount: 2, shareCount: 1 } }, youtube: { analytics: { views: 200, likes: 10, comments: 1 } } } };
    expect(postStats({ analytics_json: JSON.stringify(analytics), result_json: null })).toEqual({ url: null, views: 1200, likes: 40, comments: 3, shares: 1 });
  });

  it("takes a total over the breakdown under it, so nothing is counted twice", () => {
    const analytics = { data: { views: 500, likes: 9, daily: [{ views: 200, likes: 4 }, { views: 300, likes: 5 }] } };
    expect(postStats({ analytics_json: JSON.stringify(analytics), result_json: null })).toEqual({ url: null, views: 500, likes: 9 });
  });

  it("takes the latest snapshot of each network's running totals, the way bundle.social keeps them", () => {
    // Naive's social provider stores one snapshot of lifetime totals per refresh (about daily).
    const snap = (profilePostId: string, createdAt: string, views: number, likes: number) => ({ id: `${profilePostId}-${createdAt}`, profilePostId, impressions: views * 2, impressionsUnique: views, views, viewsUnique: views, likes, dislikes: 0, comments: 1, shares: 0, saves: 0, raw: { like_count: likes }, forced: false, createdAt });
    const analytics = {
      data: {
        tiktok: { post: { id: "p1", status: "POSTED" }, items: [snap("pp_tt", "2026-11-08T17:00:00Z", 100, 5), snap("pp_tt", "2026-11-09T17:00:00Z", 340, 12)] },
        youtube: { post: { id: "p1", status: "POSTED" }, items: [snap("pp_yt", "2026-11-09T17:00:00Z", 60, 2), snap("pp_yt", "2026-11-08T17:00:00Z", 20, 1)] },
      },
    };
    expect(postStats({ analytics_json: JSON.stringify(analytics), result_json: null })).toEqual({ url: null, views: 400, likes: 14, comments: 2, shares: 0, saves: 0 });
  });

  it("falls back to the post's own metrics and link", () => {
    const post = { id: "spo_1", status: "posted", url: "https://youtu.be/x", metrics: { views: 12, likes: 1, comments: 0 } };
    expect(postStats({ analytics_json: null, result_json: JSON.stringify(post) })).toEqual({ url: "https://youtu.be/x", views: 12, likes: 1, comments: 0 });
  });
});

describe("autopilot, one full cycle", () => {
  it("posts a finished campaign, reads its stats, and starts the next one within budget with them in the director's message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    // A brand with autopilot on: $300 a week, a campaign a day, finished videos posted without a person.
    await saveLoop(BRAND, { ...DEFAULT_LOOP, enabled: true, weekly_budget_micro: 300 * M, cadence_days: 1, autopost: true });
    await setCampaign({ status: "running", stage: "production", created_at: new Date(T0 - 2 * 86_400_000).toISOString(), strategy_json: JSON.stringify({ brand: {}, campaign: { concepts: [] } }) });
    await addCreative({ approved: 0, final_key: await storeCut("crv_done"), concept: { title: "We gave an agent $3", format: "talking_head_broll", hook: "I gave an AI agent $3 and one skill file" } });

    // Production is done: the worker moves it to review, and autopost approves and schedules it.
    await advanceCampaign(CAMPAIGN);
    expect((await posts())[0]).toMatchObject({ status: "pending", scheduled_at: "2026-11-08T16:00:00.000Z" });
    await advancePosts();
    expect(creates()[0].body).toMatchObject({ scheduled_at: "2026-11-08T16:00:00.000Z", file_ids: ["fil_up1"], ai_generated: true });
    await advanceLoop(new Date());
    expect((await store().find("campaigns", { brand_id: BRAND })).length).toBe(1);
    expect(await messages()).toContainEqual(expect.stringContaining("Waiting for the last scheduled post (2026-11-08 16:00 UTC)"));

    // The post goes out at 16:00; its stats come in.
    vi.setSystemTime(Date.parse("2026-11-08T16:05:00.000Z"));
    postOut(fake.state.posts.get("spo_1")!, "https://www.tiktok.com/@naive.agents/video/9");
    await advancePosts();
    fake.state.analytics = { data: { tiktok: { analytics: { videoViews: 4321, likeCount: 210, commentsCount: 17, shareCount: 9 } } } };
    vi.setSystemTime(Date.parse("2026-11-08T16:10:00.000Z"));
    await advancePosts();
    expect((await posts())[0]).toMatchObject({ status: "posted", analytics_json: expect.stringContaining("4321") });

    // The cadence is up and the week's budget has room: autopilot starts the next campaign.
    vi.setSystemTime(Date.parse("2026-11-09T16:10:00.000Z"));
    await advanceLoop(new Date());
    const next = (await store().find<{ id: string; status: string }>("campaigns", { brand_id: BRAND }, { order: [["created_at", "asc"]] }))[1];
    expect(next).toMatchObject({ status: "running" });
    expect(await messages()).toContainEqual(expect.stringMatching(/^Autopilot started campaign 2\..*fits the \$300\.00 weekly budget/));

    // Its research done, the director's brief carries what the first campaign's post did.
    await store().update("campaigns", { id: next.id }, { stage: "strategy", research_json: JSON.stringify(compactResearch("usenaive.ai", [], null)) });
    await advanceCampaign(next.id);
    const message = String(fake.state.sessions[0]?.message ?? "");
    const past = JSON.parse(message.match(/<past_results>\n(.*)\n<\/past_results>/s)?.[1] ?? "[]");
    expect(past).toEqual([
      expect.objectContaining({ title: "We gave an agent $3", hook: "I gave an AI agent $3 and one skill file", platforms: ["tiktok"], status: "posted", url: "https://www.tiktok.com/@naive.agents/video/9", stats: { views: 4321, likes: 210, comments: 17, shares: 9 } }),
    ]);
  });
});
