import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { editFfmpeg, renderTimeline } from "@/lib/creative/edit";
import { creatorDirection, emotionArc, NO_TEXT, planProduction } from "@/lib/creative/plan";
import type { CreativeBrief, ProductBrief, Script } from "@/lib/creative/types";
import { probe } from "@/lib/media";
import { createBrand, listCreatives, startCampaign } from "@/lib/pipeline";
import { advanceCreative, insertCreative, type ProductionContext } from "@/lib/production";
import { setSetting } from "@/lib/settings";
import { conceptFrom } from "@/lib/strategy";

// The regular presenter path: Kling 3.0 voicing the line itself is the default engine, the shot
// prompts follow the recipe that won the head-to-head, later frames are shot 1's still re-posed,
// and the final render gets the picture and sound finish.

const exec = promisify(execFile);

const product: ProductBrief = {
  name: "Monid",
  one_liner: "One balance for every tool your agent uses",
  kind: "software",
  audience: "agent builders",
  problem: "a sign-up per tool",
  aha: "one skill file",
  features: [],
  claims: [],
  proof: [],
  objections: [],
  offer: "",
  voice: "plain",
  look: "",
  visuals: [],
};

const brief: CreativeBrief = {
  title: "One link",
  reference_id: "",
  format: "talking_head_broll",
  angle: "",
  audience: "",
  hook_plan: "",
  keep: [],
  change: [],
  visuals: [],
  creator: "A woman in her early twenties with long dark hair, plain black hoodie with no logo",
  setting: "her bedroom with fairy lights",
  platforms: ["tiktok"],
  caption: "",
  hashtags: [],
  cta: "",
  why: "",
};

const script: Script = {
  beats: [
    { n: 1, job: "hook", seconds: 6, line: "Okay, I'm genuinely upset nobody told me about this sooner, because it would have saved me so many hours last month.", on_screen_text: "", visual: "creator", product_visual: null, direction: "Points at the lens. Then leans toward the camera with a raised eyebrow.", emotion: "[excited]" },
    { n: 2, job: "reveal", seconds: 4, line: "You give your agent one link, and it can use thousands of tools.", on_screen_text: "", visual: "creator", product_visual: null, direction: "Settles back and smiles.", emotion: "[smug]" },
  ],
  total_seconds: 7,
  review: null,
};

describe("the presenter recipe", () => {
  it("turns tags into an emotion arc in words", () => {
    expect(emotionArc(["[excited]", "[smug]", "[laughs]"])).toBe("excited at the start, then smug, then a short genuine laugh at the end");
    expect(emotionArc(["[deadpan]"])).toBe("deadpan");
    expect(emotionArc([])).toBe("relaxed and natural");
  });

  it("writes shots as a real creator talking: one gentle action, no looks, no text", () => {
    const plan = planProduction(script, brief, product);
    const shot = plan.aroll[0];
    expect(plan.aroll).toHaveLength(2);
    expect(shot.video_prompt).toContain("She talks straight into the camera like a real TikTok creator: excited.");
    // The big gesture is dropped; the first gentle one is kept.
    expect(shot.video_prompt).toContain("One gentle action: Leans toward the camera with a raised eyebrow.");
    expect(shot.video_prompt).not.toMatch(/Points at the lens/);
    expect(shot.video_prompt).toContain(`She says: "${script.beats[0].line}" ${NO_TEXT}`);
    expect(shot.video_prompt).toContain("Hands relaxed and mostly below the frame");
    expect(shot.video_prompt).not.toMatch(/long dark hair|black hoodie|fairy lights/);
    expect(shot.video_prompt.endsWith(NO_TEXT)).toBe(true);
    expect(shot.frame_prompt).toContain("mouth slightly open mid-sentence");
    expect(shot.frame_prompt).toContain("long dark hair");
    expect(shot.frame_prompt).toContain("A lived-in real place: her bedroom with fairy lights");
    expect(shot.pose).toBe("Leans toward the camera with a raised eyebrow");
    expect(creatorDirection({ who: "He", arc: "calm", listening: true })).toMatch(/^He listens and reacts like a real creator watching a clip/);
  });
});

describe("the presenter engine in production", () => {
  it("renders presenter shots on Kling 3.0 with its own voice, a second long, and re-poses later frames from shot 1", async () => {
    const brandId = await createBrand("kling.example");
    const campaignId = await startCampaign(brandId, { concepts: 1, shotsPerConcept: 2, secondsPerShot: 4, videoModel: "google/veo-3.1", learnStyle: false });
    const plan = planProduction(script, brief, product);
    const concept = conceptFrom(brief, script, plan, undefined, product);
    expect(concept.shots.map((s) => s.pose)).toEqual(["Leans toward the camera with a raised eyebrow", "Settles back and smiles"]);
    const id = await insertCreative(campaignId, 0, concept);

    const images: Array<{ prompt: string; image_urls?: string[] }> = [];
    const runs: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const naive = {
      generateImage: async (input: { prompt: string; image_urls?: string[] }) => {
        images.push(input);
        return { model: "fake", files: [{ id: `fil_${images.length}`, content_type: "image/png" }], cost_micro_usd: 40_000 };
      },
      fileUrl: async (fileId: string) => ({ url: `https://files.invalid/${fileId}.png`, expires_at: "" }),
      generateVideo: async () => {
        throw new Error("the Naive video model is not the engine");
      },
      message: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"pass": true, "issues": []}' }] }),
    };
    const monid = {
      run: async (_provider: string, endpoint: string, input: { body?: Record<string, unknown> }) => {
        runs.push({ endpoint, body: input.body ?? {} });
        return { runId: `run_${runs.length}`, status: "RUNNING" as const };
      },
      getRun: async (runId: string) => ({ runId, status: "RUNNING" as const }),
    };
    const ctx = { campaignId, brandId, naive, monid, naiveOut: () => false, markNaiveOut: async () => undefined, strategy: { brand: {} } } as unknown as ProductionContext;
    for (let tick = 0; tick < 3; tick++) {
      const [row] = await listCreatives(campaignId);
      await advanceCreative(ctx, row);
    }
    expect(runs.map((r) => r.endpoint)).toEqual(["/v1/video/kling-3.0-i2v", "/v1/video/kling-3.0-i2v"]);
    expect(runs[0].body).toMatchObject({ audio: "native", multi_shot: false, resolution: "1080p", media: [{ type: "first_frame", url: "https://files.invalid/fil_1.png" }] });
    expect(runs[0].body.duration).toBe(Math.ceil(plan.aroll[0].seconds + 1));
    // Shot 2's frame is shot 1's still with only the pose changed.
    expect(images[1].image_urls?.[0]).toBe("fil_1");
    expect(images[1].prompt).toMatch(/^The first reference image is shot 1 of this video\. Make the same photo again/);
    expect(images[1].prompt).toContain("Only the pose and expression change: Settles back and smiles.");
    const [row] = await listCreatives(campaignId);
    expect(JSON.parse(row.shots_json).map((s: { provider: string; status: string }) => [s.provider, s.status])).toEqual([
      ["monid", "rendering"],
      ["monid", "rendering"],
    ]);
    // presenter_engine "naive" sends shots to the Naive video model again.
    await setSetting("presenter_engine", "naive");
    try {
      const second = await insertCreative(campaignId, 1, concept);
      const calls: string[] = [];
      const veo = { ...naive, generateVideo: async () => (calls.push("veo"), { id: "med_1", status: "queued", model: "google/veo-3.1", result: null, error: null, cost_micro_usd: null }) };
      const rows = await listCreatives(campaignId);
      await advanceCreative({ ...ctx, naive: veo } as unknown as ProductionContext, rows.find((r) => r.id === second)!);
      expect(calls).toEqual(["veo", "veo"]);
    } finally {
      await setSetting("presenter_engine", "kling-3.0");
    }
    expect(id).toMatch(/^crv_/);
  });
});

const ffmpeg = await editFfmpeg();

describe.skipIf(!ffmpeg)("the finish", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomen-finish-"));
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, "take.mp4")]);
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("finishes the picture and the voice when asked, and leaves them alone when not", async () => {
    const timeline = { aroll: [{ path: join(dir, "take.mp4") }], audio: null, segments: [], captions: [{ start: 0.1, end: 1.5, text: "one link" }], overlays: [] };
    const finished = join(dir, "finished.mp4");
    const plain = join(dir, "plain.mp4");
    await renderTimeline(timeline, finished, { workDir: dir, finish: true });
    await renderTimeline(timeline, plain, { workDir: dir });
    for (const out of [finished, plain]) {
      expect(existsSync(out)).toBe(true);
      const info = await probe(out);
      expect(info).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
      expect(info.duration).toBeCloseTo(2, 0);
    }
  }, 120_000);
});
