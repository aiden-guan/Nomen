import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as phonePostsRoute, POST as postThroughPhoneRoute } from "@/app/api/phones/posts/route";
import { now, store } from "@/lib/db";
import { advancePhones } from "@/lib/phones";
import { runNow } from "@/lib/phones/service";
import { getPhonePost, getSession, listPhonePosts, listSessions, saveLink } from "@/lib/phones/store";
import { useStore } from "@/lib/store";
import { sqliteStore } from "@/lib/store/sqlite";
import type { Files } from "@/lib/store/types";
import { events, fakeMobilerun, resetDb } from "./fake-mobilerun";

// "Post through phone": one finished video, copied onto the brand's phone and posted by
// Mobilerun's phone agent in the TikTok app. Real engine and store; only Mobilerun is faked.

const BRAND = "brand_acme";
const CAMPAIGN = "cmp_acme";
const PHONE = "dev_ready_1";
const T0 = new Date("2026-11-07T18:00:00.000Z");
const CUT = Buffer.from("the finished cut, as bytes");

let root = "";
let mr: ReturnType<typeof fakeMobilerun>;

const advanceClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const stops = () => mr.callsTo("POST", new RegExp(`^/devices/${PHONE}/stop$`));
const creates = () => mr.callsTo("POST", /^\/tasks$/);
const uploads = () => mr.callsTo("POST", /\/files$/);
const phoneState = () => mr.devices.get(PHONE)!.state;
const onlyPost = () => {
  const posts = listPhonePosts(BRAND);
  expect(posts).toHaveLength(1);
  return posts[0];
};

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

/** A finished, approved video with its cut in the store. */
async function addVideo(fields: { id?: string; approved?: number; concept?: Record<string, unknown> } = {}) {
  const id = fields.id ?? "crv_glow";
  const path = join(root, `${id}-cut.mp4`);
  await writeFile(path, CUT);
  await store().files.putFile(`${id}/final.mp4`, path, "video/mp4");
  await store().insert("creatives", {
    id,
    campaign_id: CAMPAIGN,
    idx: 1,
    generation: 1,
    concept_json: JSON.stringify(fields.concept ?? { title: "Glass skin in 3 steps", format: "talking_head_broll" }),
    shots_json: "[]",
    status: "ready",
    caption: "Three steps to glass skin.\n\n#skincare #glowup",
    platforms_json: JSON.stringify(["tiktok"]),
    approved: fields.approved ?? 1,
    rejected: 0,
    final_file_id: null,
    final_key: `${id}/final.mp4`,
    final_external_url: null,
    created_at: now(),
    updated_at: now(),
  });
  return id;
}

/** The camp's "Post through phone" button. */
async function postThroughPhone(creativeId: string) {
  const response = await postThroughPhoneRoute(
    new Request("http://localhost/api/phones/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ creativeId }) }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nomen-phone-posts-"));
});
afterAll(async () => {
  useStore(undefined);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("MOBILERUN_API_KEY", "dr_sk_test");
  mr = fakeMobilerun();
  vi.stubGlobal("fetch", mr.fetchMock);
  useStore({ ...sqliteStore(), files: tempFiles(join(root, `files-${Math.random().toString(36).slice(2)}`)) });
  resetDb();
  mr.addDevice({ id: PHONE, state: "ready" });
  saveLink({ brandId: BRAND, deviceId: PHONE, topics: ["skincare routines"], vpnCountry: "US", accounts: [{ platform: "tiktok", credentialName: "acme-tiktok" }] });
  await store().insert("campaigns", { id: CAMPAIGN, brand_id: BRAND, status: "review", stage: "review", options_json: "{}", created_at: now(), updated_at: now() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("posting a video through the brand's phone", () => {
  it("copies the cut onto the phone, has the agent post it in TikTok, then parks the phone", async () => {
    const id = await addVideo();
    const queued = await postThroughPhone(id);
    expect(queued.status).toBe(200);
    const post = onlyPost();
    expect(post).toMatchObject({ creative_id: id, device_id: PHONE, status: "pending" });
    expect(mr.fetchMock).not.toHaveBeenCalled();

    await advancePhones();
    // The cut is on the phone, whole and under the post's own name, before the agent starts.
    const fileName = `nomen-${post.id}.mp4`;
    expect(mr.fileAt(PHONE, `/DCIM/Camera/${fileName}`)?.bytes.equals(CUT)).toBe(true);
    expect(uploads()[0].upload).toMatchObject({ name: fileName, type: "video/mp4", size: CUT.length });
    expect(mr.calls.findIndex((call) => call.upload)).toBeLessThan(mr.calls.findIndex((call) => call.path === "/tasks"));

    const [create] = creates();
    expect(create.headers["idempotency-key"]).toBe(post.id);
    expect(create.body).toMatchObject({
      deviceId: PHONE,
      apps: ["com.zhiliaoapp.musically"],
      credentials: [{ packageName: "com.zhiliaoapp.musically", credentialNames: ["acme-tiktok"] }],
      vpnCountry: "US",
      recordingEnabled: true,
      outputSchema: { type: "object", required: expect.arrayContaining(["posted", "postUrl", "aiLabel", "reason"]) },
    });
    const brief = String(create.body?.task);
    expect(brief).toContain(fileName);
    expect(brief).toContain("Three steps to glass skin. #skincare #glowup #AIgenerated");
    expect(brief).toMatch(/AI-generated content/);
    expect(getPhonePost(post.id)!.status).toBe("running");

    advanceClock(11_000);
    mr.finishTask(getPhonePost(post.id)!.task_id!, {
      message: "Posted the video.",
      output: { posted: true, postUrl: "https://www.tiktok.com/@acmeskin/video/7301", aiLabel: true, reason: "" },
    });
    await advancePhones();
    expect(getPhonePost(post.id)).toMatchObject({ status: "posted", post_url: "https://www.tiktok.com/@acmeskin/video/7301" });
    expect(events().some((e) => e.level === "info" && /Phones: posted “Glass skin in 3 steps” on TikTok through the brand's phone: https:\/\/www\.tiktok\.com\/@acmeskin\/video\/7301/.test(e.message))).toBe(true);
    expect(stops()).toHaveLength(1);
    expect(phoneState()).toBe("stopped");

    // The camp sees it, with its link.
    const listed = await phonePostsRoute(new Request(`http://localhost/api/phones/posts?brandId=${BRAND}`));
    expect(await listed.json()).toMatchObject({ ready: true, posts: [{ creativeId: id, title: "Glass skin in 3 steps", status: "posted", url: "https://www.tiktok.com/@acmeskin/video/7301" }] });

    // A posted video is not posted twice.
    const again = await postThroughPhone(id);
    expect(again.status).toBe(409);
    expect(listPhonePosts(BRAND)).toHaveLength(1);
  });

  it("tries a failed upload again before any task starts", async () => {
    await postThroughPhone(await addVideo());
    const post = onlyPost();
    mr.failNext("POST", /\/files$/, 503, { title: "Service Unavailable", status: 503, detail: "storage busy", errors: [] });
    await expect(advancePhones()).resolves.toBeUndefined();
    expect(getPhonePost(post.id)).toMatchObject({ status: "waiting", error: "Couldn't reach Mobilerun. Trying again shortly." });
    expect(creates()).toHaveLength(0);
    expect(stops()).toHaveLength(0);

    advanceClock(31_000);
    await advancePhones();
    expect(mr.fileAt(PHONE, `/DCIM/Camera/nomen-${post.id}.mp4`)).toBeDefined();
    expect(getPhonePost(post.id)).toMatchObject({ status: "running", error: null });
    expect(creates()).toHaveLength(1);
  });

  it("copies the video again when it didn't arrive whole", async () => {
    await postThroughPhone(await addVideo());
    const post = onlyPost();
    mr.truncateNextUpload();
    await advancePhones();
    expect(getPhonePost(post.id)).toMatchObject({ status: "waiting", uploaded_at: null });
    expect(creates()).toHaveLength(0);

    advanceClock(31_000);
    await advancePhones();
    expect(uploads()).toHaveLength(2);
    expect(mr.fileAt(PHONE, `/DCIM/Camera/nomen-${post.id}.mp4`)?.bytes.equals(CUT)).toBe(true);
    expect(getPhonePost(post.id)!.status).toBe("running");
  });

  it("fails the post, with no task, when Mobilerun refuses the upload", async () => {
    await postThroughPhone(await addVideo());
    mr.failNext("POST", /\/files$/, 413, { title: "Payload Too Large", status: 413, detail: "file too large", errors: [] });
    await advancePhones();
    expect(onlyPost()).toMatchObject({ status: "failed", message: "Mobilerun refused the request: file too large" });
    expect(creates()).toHaveLength(0);
    expect(phoneState()).toBe("stopped");
  });

  it("reports a post the agent couldn't make, and never posts it again by itself", async () => {
    const id = await addVideo();
    await postThroughPhone(id);
    await advancePhones();
    const post = onlyPost();
    advanceClock(11_000);
    mr.finishTask(post.task_id!, {
      succeeded: false,
      message: "Stopped: verification code",
      output: { posted: false, postUrl: "", aiLabel: false, reason: "TikTok asked for a verification code." },
    });
    await advancePhones();
    expect(onlyPost()).toMatchObject({ status: "failed", message: "Not posted: TikTok asked for a verification code." });
    expect(events().some((e) => e.level === "warn" && /wasn't posted/.test(e.message))).toBe(true);
    expect(phoneState()).toBe("stopped");

    advanceClock(10 * 60_000);
    await advancePhones();
    expect(creates()).toHaveLength(1);

    // A person can try again.
    expect((await postThroughPhone(id)).status).toBe(200);
  });

  it("refuses to post an internal remake", async () => {
    const id = await addVideo({ concept: { title: "Remake of a creator's video", format: "remake", internal: true } });
    const refused = await postThroughPhone(id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/internal remake: not cleared for posting/);
    expect(listPhonePosts(BRAND)).toHaveLength(0);
    expect(mr.fetchMock).not.toHaveBeenCalled();
  });

  it("stops a queued post whose video was held after it was queued", async () => {
    const id = await addVideo();
    await postThroughPhone(id);
    await store().update("creatives", { id }, { concept_json: JSON.stringify({ title: "Glass skin in 3 steps", format: "remake", internal: true }) });
    await advancePhones();
    expect(onlyPost()).toMatchObject({ status: "failed", message: expect.stringMatching(/internal remake: not cleared for posting/) });
    expect(uploads()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it("removes earlier Nomen videos from the phone, and keeps the phone's own files", async () => {
    mr.putFile(PHONE, "/DCIM/Camera/nomen-php_earlier.mp4");
    mr.putFile(PHONE, "/DCIM/Camera/IMG_0001.jpg");
    await postThroughPhone(await addVideo());
    await advancePhones();
    const post = onlyPost();
    expect(mr.fileAt(PHONE, "/DCIM/Camera/nomen-php_earlier.mp4")).toBeUndefined();
    expect(mr.fileAt(PHONE, "/DCIM/Camera/IMG_0001.jpg")).toBeDefined();
    expect(mr.fileAt(PHONE, `/DCIM/Camera/nomen-${post.id}.mp4`)).toBeDefined();
  });

  it("uses the DCIM folder on a phone without a Camera folder", async () => {
    mr.removeDir(PHONE, "/DCIM/Camera");
    await postThroughPhone(await addVideo());
    await advancePhones();
    const post = onlyPost();
    expect(mr.fileAt(PHONE, `/DCIM/nomen-${post.id}.mp4`)).toBeDefined();
    expect(post.status).toBe("running");
  });

  it("stays out of the camp on a deployment without the local database", async () => {
    // On Vercel the store is Convex and the worker never runs phones, so nothing may be queued there.
    useStore({ ...sqliteStore(), kind: "convex" as const, files: tempFiles(join(root, "convex-files")) });
    const listed = await phonePostsRoute(new Request(`http://localhost/api/phones/posts?brandId=${BRAND}`));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ available: false, ready: false, posts: [] });
    const refused = await postThroughPhone("crv_glow");
    expect(refused.status).toBe(400);
  });

  it("takes turns with warm-up sessions on the phone", async () => {
    await runNow({ brandId: BRAND });
    await advancePhones();
    const [session] = listSessions(BRAND);
    expect(getSession(session.id)!.status).toBe("running");

    // The post waits for the warm-up instead of copying anything onto a busy phone.
    await postThroughPhone(await addVideo());
    advanceClock(11_000);
    await advancePhones();
    expect(onlyPost()).toMatchObject({ status: "pending", message: "Waiting for the phone's current session to finish." });
    expect(uploads()).toHaveLength(0);

    // The warm-up ends; the phone stays on because the post is next.
    mr.finishTask(getSession(session.id)!.task_id!, { message: "done" });
    advanceClock(11_000);
    await advancePhones();
    expect(getSession(session.id)!.status).toBe("succeeded");
    expect(stops()).toHaveLength(0);
    advanceClock(21_000);
    await advancePhones();
    expect(onlyPost().status).toBe("running");

    // And a warm-up queued now waits for the post.
    await runNow({ brandId: BRAND });
    advanceClock(11_000);
    await advancePhones();
    const [next] = listSessions(BRAND);
    expect(getSession(next.id)).toMatchObject({ status: "pending", message: "Waiting for the phone's current session to finish." });
  });
});
