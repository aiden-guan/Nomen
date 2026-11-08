import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bannedNamesIn,
  bannedTopicsIn,
  type BrainrotScript,
  brainrotConcept,
  estimateBrainrot,
  inventedNumbers,
  lintBrainrot,
  normalizeBrainrot,
  pickBit,
  planBrainrot,
  siteOf,
  videoSeconds,
  writeBrainrot,
} from "@/lib/creative/brainrot";
import { type BrainrotDeps, makeBrainrot, neededSfx, OverBudget } from "@/lib/creative/brainrot-make";
import { editFfmpeg } from "@/lib/creative/edit";
import type { CreativeBrief, ProductBrief } from "@/lib/creative/types";
import { probe } from "@/lib/media";
import type { MonidRun } from "@/lib/monid";
import { isInternal, postingHold } from "@/lib/publish";
import type { Files } from "@/lib/store/types";

// The brainrot format: the writer's guard rails (no real people or other people's characters, no
// invented numbers, a stunt opener, the product at the end), the plan and the estimate, the
// campaign concept and its posting hold, and the maker end to end with fake providers and real
// ffmpeg: resuming without paying twice, the cost guard, the price probe and a re-render after QC.

const exec = promisify(execFile);
const ffmpeg = await editFfmpeg();

const product: ProductBrief = {
  name: "Monid",
  one_liner: "One balance for every tool your agent uses",
  kind: "software",
  audience: "agent builders",
  problem: "a sign-up per API",
  aha: "set up monid.ai/SKILL.md",
  features: [],
  claims: ["2900+ tools across 97+ providers", "Start with $1 in free credit.", "We killed the subscriptions."],
  proof: [],
  objections: [],
  offer: "Start with $1 in free credit.",
  voice: "dry",
  look: "",
  visuals: [],
};
const ctx = { product, site: "monid.ai", bit: "anthem" as const };

const raw = (over: Record<string, unknown> = {}) => ({
  title: "Monidino",
  hook: "POV: your agent found one balance 💀",
  characters: [
    { id: "a", name: "Monidino Saldolino", look: "a glossy pink piggy bank with octopus arms" },
    { id: "b", name: "Scrapelino", look: "a spider made of browser tabs" },
  ],
  music: { style: "goofy tarantella trap beat", hype: "", turn: 0 },
  narrator: "dramatic",
  shots: [
    { cast: ["a"], frame: "Monidino leaps off a rooftop into a pool", motion: "a huge cannonball splash", words: "Monidino Monidino Saldolino — one balance", keyword: "Saldolino", stamp: "+1000 aura", sfx: ["explosion", "nope"], fx: ["shake"], seconds: 3 },
    { cast: ["b"], frame: "Scrapelino on a beach", motion: "it scuttles", words: "Scrapelino eats 2900+ tools for breakfast", keyword: "tools", stamp: "MOGGED", sfx: ["vine_boom"], fx: ["zoom_punch"], seconds: 3 },
    { cast: ["a", "b"], frame: "the gang dancing", motion: "they dance", words: "we killed the subscriptioni, six seven", keyword: "subscriptioni", stamp: "6-7", sfx: ["airhorn"], fx: ["deep_fry"], seconds: 3 },
    { cast: ["a"], frame: "Monidino on a throne", motion: "it nods", words: "Monid, one balance, no subscriptions", keyword: "Monid", stamp: "", sfx: [], fx: [], seconds: 3 },
    { cast: ["a", "b"], frame: "fireworks", motion: "fireworks", words: "start with one dollar free credit", keyword: "free", stamp: "W", sfx: ["ding"], fx: ["flash"], seconds: 9 },
  ],
  end: { line: "Monid. One balance.", text: "start with $1 free credit" },
  caption: "chat is this real",
  hashtags: ["#brainrot", "ai agents"],
  ...over,
});

describe("the brainrot writer's guard rails", () => {
  it("normalizes: no emoji, known effects only, bounded lengths, the site on the end card", () => {
    const script = normalizeBrainrot(raw(), ctx);
    expect(script.hook).toBe("POV: your agent found one balance");
    expect(script.shots[0].sfx).toEqual(["explosion"]);
    expect(script.shots[0].stamp).toBe("+1000 AURA");
    expect(script.shots[0].words).toBe("Monidino Monidino Saldolino, one balance");
    expect(script.shots[4].seconds).toBe(6);
    expect(script.end.text).toBe("monid.ai start with $1 free credit");
    expect(script.hashtags).toEqual(["brainrot", "aiagents"]);
  });

  it("names no real people or other people's characters, and no off-limits topics", () => {
    expect(bannedNamesIn("Tung Tung Tung Sahur meets Skibidi")).toEqual(expect.arrayContaining(["tung tung", "sahur", "skibidi"]));
    expect(bannedNamesIn("a cameo by Diddy and Clavicular")).toEqual(expect.arrayContaining(["diddy", "clavicular"]));
    // Whole words only: a potato called Tater is not Andrew Tate, a beach island is fine, speedy is fine.
    expect(bannedNamesIn("Tater the potato runs at full speed to the island")).toEqual([]);
    expect(bannedTopicsIn("he has so much rizz")).toEqual(["rizz*"]);
    expect(bannedTopicsIn("trafficking jokes")).toEqual(["traffick*"]);
    expect(bannedTopicsIn("a grape, a gunwale and a bloodorange")).toEqual(["blood*"]);
  });

  it("allows meme numbers and the brief's numbers, flags invented ones", () => {
    const script = normalizeBrainrot(raw(), ctx);
    expect(inventedNumbers(script, product)).toEqual([]);
    script.shots[1].words = "saves you 400 dollars, 6-7, +5000 aura";
    expect(inventedNumbers(script, product)).toEqual(["400"]);
  });

  it("lints the rules: banned names, a stunt opener, the product at the end, 6-7 kept to a bit", () => {
    const good = normalizeBrainrot(raw(), ctx);
    expect(lintBrainrot(good, ctx)).toEqual([]);
    const bad = normalizeBrainrot(
      raw({
        shots: [
          { cast: [], frame: "Tralalero sits at a desk with a sign that says hello", motion: "he waves", words: "six seven six seven", keyword: "", stamp: "6-7", sfx: [], fx: [], seconds: 3 },
          { cast: [], frame: "a beach", motion: "", words: "6-7 6-7 six seven", keyword: "", stamp: "6-7", sfx: [], fx: [], seconds: 3 },
        ],
        end: { line: "bye", text: "" },
      }),
      ctx,
    );
    const issues = lintBrainrot(bad, ctx).join(" | ");
    expect(issues).toContain("tralalero");
    expect(issues).toContain("not an outrageous stunt");
    expect(issues).toContain("not named at the end");
    expect(issues).toContain("6-7 appears");
    expect(issues).toContain("asks for text in the picture");
    expect(issues).toContain("only 2 shots");
  });

  it("writes, lints and keeps the critic's revision when it fixes the draft", async () => {
    const draft = raw({ shots: raw().shots.map((s, i) => (i === 0 ? { ...s, frame: "Monidino sits on a couch", motion: "it sighs" } : s)) });
    const fixed = raw();
    const calls: string[] = [];
    const naive = {
      async message(input: { tools?: object[] }) {
        const tool = (input.tools?.[0] as { name?: string } | undefined)?.name ?? "";
        calls.push(tool);
        if (tool === "brainrot_script") return { content: [{ type: "tool_use", name: tool, input: draft }], stop_reason: "tool_use" };
        return { content: [{ type: "tool_use", name: tool, input: { score: 5, notes: ["the opener is not a stunt"], revised: fixed } }], stop_reason: "tool_use" };
      },
    };
    const script = await writeBrainrot(naive, ctx);
    expect(calls).toEqual(["brainrot_script", "brainrot_review"]);
    expect(script.shots[0].frame).toContain("leaps off a rooftop");
    expect(script.review?.rounds).toBe(2);
    expect(script.review?.notes).toContain("the opener is not a stunt");
  });

  it("picks the bit from the brief, else from the product", () => {
    expect(pickBit({ title: "x", angle: "an Italian brainrot song", hook_plan: "" })).toBe("anthem");
    expect(pickBit({ title: "x", angle: "fruit drama", hook_plan: "" })).toBe("melodrama");
    expect(pickBit({ title: "x", angle: "aura farming edit", hook_plan: "" })).toBe("aura");
    expect(["anthem", "melodrama", "aura"]).toContain(pickBit(null, "Mobilerun"));
  });
});

describe("the brainrot plan", () => {
  it("draws recurring characters once and every shot from them, with no text anywhere", () => {
    const plan = planBrainrot(normalizeBrainrot(raw(), ctx));
    expect(plan.characters.map((c) => c.id)).toEqual(["a", "b"]);
    expect(plan.shots[2].refs).toEqual(["a", "b"]);
    expect(plan.shots[0].still).toContain("exactly as in the reference image");
    for (const shot of plan.shots) {
      expect(shot.still).toMatch(/No text, no letters/);
      expect(shot.clip).toMatch(/No text, no captions/);
    }
  });

  it("snaps clip lengths to what the model renders, and prices the clips by the second", () => {
    expect(videoSeconds("google/veo-3.1-lite", 2.2)).toBe(4);
    expect(videoSeconds("google/veo-3.1-lite", 5.1)).toBe(6);
    expect(videoSeconds("google/veo-3.1-lite", 12)).toBe(8);
    expect(videoSeconds("kwaivgi/kling-v3.0-std", 6)).toBe(10);
    const estimate = estimateBrainrot(normalizeBrainrot(raw(), ctx), { perSecond: 0.1 });
    expect(estimate.usd.clips).toBeCloseTo(estimate.clips_seconds * 0.1, 3);
    expect(estimate.usd.total).toBeGreaterThan(estimate.usd.clips);
  });

  it("knows which sound effects a video needs", () => {
    const script = normalizeBrainrot(raw(), ctx);
    expect(neededSfx(script)).toEqual(expect.arrayContaining(["explosion", "vine_boom", "airhorn", "ding", "six_seven"]));
  });
});

describe("brainrot in a campaign", () => {
  const brief: CreativeBrief = {
    title: "Monidino",
    reference_id: "ref_x",
    role: "convert",
    metric: "sign_ups",
    format: "brainrot",
    angle: "anthem",
    audience: "",
    hook_plan: "",
    keep: [],
    change: [],
    visuals: [],
    creator: "",
    setting: "",
    platforms: [],
    caption: "",
    hashtags: ["x"],
    cta: "",
    why: "",
  };

  it("is a reach video, held from posting until a person clears it", () => {
    const concept = brainrotConcept(brief, normalizeBrainrot(raw(), ctx));
    expect(concept.internal).toBe(true);
    expect(concept.role).toBe("reach");
    expect(concept.metric).toBe("views");
    expect(concept.brief?.format).toBe("brainrot");
    expect(concept.inspired_by[0]).toContain("tiktok.com/@br.ai.nrot");
    expect(isInternal(concept)).toBe(true);
    expect(postingHold(concept)).toBe("brainrot ad: not cleared for posting");
    expect(postingHold({ ...concept, cleared: { at: "now", by: "Dylan", note: "ok" } })).toBeNull();
  });

  it("reads the site from the brand's URL", () => {
    expect(siteOf("https://www.monid.ai/pricing")).toBe("monid.ai");
    expect(siteOf("mobilerun.ai")).toBe("mobilerun.ai");
    expect(siteOf(null)).toBe("");
  });
});

// ---------- the maker, with fake providers ----------

function folderFiles(root: string): Files {
  const at = (key: string) => join(root, key);
  return {
    async putFile(key, path) {
      await mkdir(dirname(at(key)), { recursive: true });
      if (resolve(path) !== resolve(at(key))) await copyFile(path, at(key));
    },
    async saveUrl() {
      throw new Error("not used");
    },
    async exists(key) {
      return existsSync(at(key));
    },
    async localPath(key) {
      return at(key);
    },
    async url(key) {
      return at(key);
    },
  };
}

type Fakes = { deps: BrainrotDeps; count: Record<string, number>; failClip: Set<number> };

function fakes(dir: string, media: { clip: string; image: string; audio: string }, options: { clipCost?: number; failCheck?: number } = {}): Fakes {
  const count: Record<string, number> = {};
  const bump = (k: string) => (count[k] = (count[k] ?? 0) + 1);
  const failClip = new Set<number>();
  let images = 0;
  let videos = 0;
  const clipSeconds = new Map<string, number>();
  const deps: BrainrotDeps = {
    files: folderFiles(join(dir, "kept")),
    async fetchUrl(url, path) {
      await mkdir(dirname(path), { recursive: true });
      await copyFile(url.includes("clip") ? media.clip : url.includes("image") ? media.image : media.audio, path);
    },
    monid: {
      async run(provider: string, endpoint: string) {
        bump(`monid ${endpoint}`);
        return { runId: `r${Object.values(count).reduce((a, b) => a + b, 0)}`, status: "COMPLETED", output: { audio: { download_link: `https://fake.local/${endpoint.replace(/\W/g, "")}.mp3` } }, billing: { actualCost: { value: 2000, unit: "MICRO_DOLLAR" } } } as MonidRun;
      },
      async getRun() {
        throw new Error("never polled: runs finish at once");
      },
    },
    naive: {
      async message(input: { tools?: Array<{ name: string }> }) {
        const tool = input.tools?.[0]?.name ?? "";
        bump(`check ${tool}`);
        if (tool === "clip_checks") {
          const shots = [1, 2, 3, 4, 5].map((n) => ({ n, pass: n !== options.failCheck || (count[`check ${tool}`] ?? 0) > 1, issues: n === options.failCheck ? ["garbled letters on a sign"] : [], fix: n === options.failCheck ? "No signs anywhere." : "" }));
          return { content: [{ type: "tool_use", name: tool, input: { shots } }], stop_reason: "tool_use" };
        }
        return { content: [{ type: "tool_use", name: tool, input: { score: 7, safe: true, issues: [] } }], stop_reason: "tool_use" };
      },
      async generateImage() {
        bump("image");
        return { model: "fake", files: [{ id: `image-${++images}`, content_type: "image/png" }], cost_micro_usd: 40000 };
      },
      async fileUrl(id: string) {
        return { url: `https://fake.local/${id}`, expires_at: "" };
      },
      async generateVideo(input: { seconds?: number; prompt: string }) {
        bump("video");
        const id = `job-${++videos}`;
        clipSeconds.set(id, input.seconds ?? 4);
        return { id, status: "queued", model: "fake", result: null, error: null, cost_micro_usd: null };
      },
      async getMediaJob(id: string) {
        return { id, status: "completed", model: "fake", result: { files: [{ file_id: `clip-${id}`, content_type: "video/mp4" }] }, error: null, cost_micro_usd: Math.round((clipSeconds.get(id) ?? 4) * (options.clipCost ?? 0.1) * 1e6) };
      },
    } as unknown as BrainrotDeps["naive"],
  };
  return { deps, count, failClip };
}

describe.skipIf(!ffmpeg)("making a brainrot video (fake providers, real ffmpeg)", () => {
  let dir = "";
  const media = { clip: "", image: "", audio: "" };
  const script = (): BrainrotScript => normalizeBrainrot(raw(), ctx);
  const productWithPage = (): ProductBrief => ({ ...product, visuals: [{ id: "s1", kind: "screenshot", url: media.image, caption: "home", source: "capture:mobile:/", width: 430, height: 932 }] });
  const input = (over: Partial<Parameters<typeof makeBrainrot>[1]> = {}) => ({
    prefix: "crv_test",
    script: script(),
    product: productWithPage(),
    site: "monid.ai",
    videoModel: "google/veo-3.1-lite",
    videoPerSecond: 0.1,
    maxUsd: 4,
    idem: "test",
    pollMs: 1,
    ...over,
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "brainrot-make-"));
    const make = (...a: string[]) => exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", ...a]);
    media.clip = join(dir, "clip.mp4");
    media.image = join(dir, "image.png");
    media.audio = join(dir, "audio.mp3");
    await make("-f", "lavfi", "-i", "testsrc2=s=720x1280:r=24:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", media.clip);
    await make("-f", "lavfi", "-i", "color=c=orange:s=430x932", "-frames:v", "1", media.image);
    await make("-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=0.2", "-f", "lavfi", "-i", "sine=f=330:d=1.6", "-filter_complex", "[0][1]concat=n=2:v=0:a=1", media.audio);
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("makes the whole video, keeps every piece, and pays for nothing twice on a rerun", async () => {
    const f = fakes(join(dir, "a"), media);
    const result = await makeBrainrot(f.deps, input());
    expect(result.key).toBe("crv_test/final.mp4");
    expect(result.path && existsSync(result.path)).toBe(true);
    const info = await probe(result.path!);
    expect(info.width).toBe(1080);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeCloseTo(result.duration, 0);
    expect(f.count.video).toBe(5);
    expect(f.count.image).toBe(2 + 5);
    expect(f.count["monid /text-to-speech"]).toBe(5 + 1 + 1); // five lines, the end line, the 6-7 chant
    expect(f.count["monid /v1/music"]).toBe(1);
    expect(result.per_second).toBeCloseTo(0.1, 3);
    expect(result.qc).toEqual({ score: 7, safe: true, issues: [] });
    expect(result.shots.every((s) => s.status === "rendered")).toBe(true);
    // Every piece is kept by key; the sound effects once for every video.
    expect(existsSync(join(dir, "a", "kept", "crv_test", "final.mp4"))).toBe(true);
    expect(existsSync(join(dir, "a", "kept", "brainrot", "sfx", "vine_boom.mp3"))).toBe(true);

    const again = await makeBrainrot(f.deps, input());
    expect(again.key).toBe(result.key);
    expect(f.count.video).toBe(5);
    expect(f.count.image).toBe(7);
    expect(f.count["check clip_checks"]).toBe(1);
  }, 240_000);

  it("stops before paying when the estimate is over the cap", async () => {
    const f = fakes(join(dir, "b"), media);
    await expect(makeBrainrot(f.deps, input({ maxUsd: 0.2 }))).rejects.toBeInstanceOf(OverBudget);
    expect(f.count.video ?? 0).toBe(0);
    expect(f.count.image ?? 0).toBe(0);
  }, 60_000);

  it("probes the video model's price on the first clip, then guards the rest with it", async () => {
    const f = fakes(join(dir, "c"), media, { clipCost: 0.5 });
    const probed = await makeBrainrot(f.deps, input({ probe: true }));
    expect(probed.key).toBeNull();
    expect(f.count.video).toBe(1);
    expect(probed.per_second).toBeCloseTo(0.5, 3);
    // At $0.50 a second the rest no longer fits a $4 cap: nothing more is rendered.
    await expect(makeBrainrot(f.deps, input())).rejects.toBeInstanceOf(OverBudget);
    expect(f.count.video).toBe(1);
  }, 120_000);

  it("renders a clip that failed its check again, once, with the check's fix", async () => {
    const f = fakes(join(dir, "d"), media, { failCheck: 2 });
    const result = await makeBrainrot(f.deps, input());
    expect(f.count.video).toBe(6);
    expect(result.key).toBe("crv_test/final.mp4");
    expect(result.notes.join(" ")).toContain("clip 2: garbled letters on a sign");
  }, 240_000);
});
