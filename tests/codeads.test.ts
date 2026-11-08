import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCues } from "@/lib/codeads/cues";
import { advanceCodeAd, brandFor, cannotRender, heroFor, sheetTimes, svgInk } from "@/lib/codeads/job";
import { display, layoutStory, norm, untag } from "@/lib/codeads/layout";
import { compressPauses, estimateWords, SR, syllables, trimClip } from "@/lib/codeads/narrate";
import { type CodeAdContext, lintStory, normalizeStory, storyScript } from "@/lib/codeads/story";
import type { CodeAdBrand, CodeAdStory, Voiced } from "@/lib/codeads/types";
import { planProduction } from "@/lib/creative/plan";
import { targetSeconds, writeScript } from "@/lib/creative/script";
import type { BrandKit, CreativeBrief, ProductBrief, ReferenceBreakdown } from "@/lib/creative/types";
import { save } from "@/lib/db";
import type { NaiveClient } from "@/lib/naive";
import { createBrand, listCreatives, startCampaign } from "@/lib/pipeline";
import { insertCreative, type ProductionContext } from "@/lib/production";
import { useStore } from "@/lib/store";
import { sqliteStore } from "@/lib/store/sqlite";
import type { Files } from "@/lib/store/types";
import { type Concept, conceptFrom, FORMATS, normalizeStrategy } from "@/lib/strategy";

// Code ads: the story the model writes is checked into something the engine can animate, laid out on the narration's
// clock, given a cue sheet, and made by the production hook (which says plainly where it cannot render).

const product: ProductBrief = {
  name: "Naïve",
  one_liner: "A team of AI agents runs a business for you.",
  kind: "software",
  audience: "solo founders",
  problem: "too much work",
  aha: "deploy a template",
  features: [{ name: "Human approvals", what_it_does: "Sensitive actions wait for your yes.", how_to_show_it: "the Approvals queue" }],
  claims: ["Pick a template, deploy it, watch the first session run.", "You approve anything that costs money.", "In the next decade, agents will run entire companies."],
  proof: [],
  objections: [],
  offer: "",
  voice: "terse",
  look: "black and white",
  visuals: [{ id: "s1", kind: "screenshot", url: "https://example.com/s1.png", caption: "home", source: "capture" }],
};
const reference = { id: "ref_x", url: "https://www.tiktok.com/@a/video/1", author: "a", views: 600000, followers: 1700, outlier: 360, duration: 54, format: "explainer", hook: { line: "In six hours it made money.", on_screen_text: "", visual: "", mechanic: "result first" }, beats: [], pacing: { cuts: 10, avg_shot_seconds: 3, words_per_minute: 180 }, caption_style: "", delivery: "", why_it_works: "", fit: { score: 7, reason: "" }, transcript: "", platform: "tiktok" } as ReferenceBreakdown;
const brief = { title: "Card to company", reference_id: "ref_x", role: "convert", metric: "link_clicks", format: "code_ad", angle: "", audience: "", hook_plan: "", keep: [], change: [], visuals: [], creator: "", setting: "", platforms: ["tiktok"], caption: "", hashtags: [], cta: "Pick a template at usenaive.ai", why: "" } as CreativeBrief;
const ctx: CodeAdContext = { product, brief, reference, targetSeconds: 24, site: "usenaive.ai" };

const raw = {
  concept: { reference_id: "ref_x", premise: "An AI told to make money", mechanic: "result first", adaptation: "Gary's agent" },
  nameplate: "gary · founder",
  poster: "Build Your Dream Company with Agents",
  url: "https://usenaive.ai/",
  beats: [
    { id: "Hook!", say: "You give an AI agent your card and one instruction: make money.", gag: "hack", hit: "money", labels: [], screen: { kind: "terminal", lines: ["agent --goal 'make money' and a lot more text than fits"] }, callouts: [{ at: "card", text: "your card", style: "label" }] },
    { id: "fail", say: "[shouting] [excited] It buys rubber ducks. Your card is a FOUNTAIN.", gag: "money", hit: "fountain", labels: [], screen: { kind: "none" }, callouts: [{ at: "geyser", text: "nope", style: "stamp" }] },
    { id: "fix", say: "So you use Naïve. Pick a template, deploy it.", gag: "deliver", hit: "naive", labels: ["agent"], screen: { kind: "image", visual_id: "s9" }, callouts: [{ at: "Template", text: "Company templates", style: "term", until: "deploy" }] },
    { id: "end", say: "Congratulations, you built a company — go to usenaive.ai.", gag: "dance", hit: "nowhere", labels: [], screen: { kind: "logo" }, callouts: [] },
  ],
};

describe("the code-ad story", () => {
  it("keeps only what the engine can render, anchored on words that are really said", () => {
    const story = normalizeStory(raw, ctx);
    expect(story.beats.map((b) => b.id)).toEqual(["hook", "fail", "fix", "end"]);
    expect(story.nameplate).toBe("GARY · FOUNDER");
    expect(story.url).toBe("usenaive.ai");
    const [hook, fail, fix, end] = story.beats;
    expect(hook.screen.lines![0].length).toBeLessThanOrEqual(30);
    expect(hook.callouts[0]).toMatchObject({ at: "card", text: "YOUR CARD", style: "label" });
    // one audio tag, at the start; a callout on a word the line never says is dropped
    expect(fail.say).toBe("[shouting] It buys rubber ducks. Your card is a FOUNTAIN.");
    expect(fail.callouts).toEqual([]);
    // the hit and anchors are the words as spoken (accents and all); an unknown visual becomes the logo card
    expect(fix.hit).toBe("Naïve");
    expect(fix.screen).toEqual({ kind: "logo" });
    expect(fix.callouts[0]).toMatchObject({ at: "template", until: "deploy" });
    expect(fix.labels).toEqual(["AGENT"]);
    // an unknown gag idles, a hit that is not said lands on the last long word, the url gets its label
    expect(end.gag).toBe("idle");
    expect(end.say).not.toContain("—");
    expect(end.hit).toBe("usenaive.ai");
    expect(end.callouts.at(-1)).toMatchObject({ at: "usenaive.ai", text: "USENAIVE.AI", style: "label" });
  });

  it("flags what a person would catch: invented numbers, no product, ad copy, repeats, length", () => {
    const story = normalizeStory(raw, ctx);
    expect(lintStory(story, ctx)).toEqual([expect.stringMatching(/38 words is too short for 24 s/), expect.stringMatching(/1 lines carry audio tags/)]);
    const bad: CodeAdStory = {
      ...story,
      beats: [
        { ...story.beats[0], say: "You save 5 hours a day with this game changer.", callouts: [] },
        { ...story.beats[0], id: "again", say: "It costs $2,025 a month.", callouts: [] },
      ],
    };
    const issues = lintStory(bad, ctx);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/"5" is not in the product brief/),
        expect.stringMatching(/"\$2,025" is not in the product brief/),
        expect.stringMatching(/ad phrase "game changer"/),
        expect.stringMatching(/never names Naïve/),
        expect.stringMatching(/no deliver beat/),
        expect.stringMatching(/same gag/),
        expect.stringMatching(/no term callout/),
        expect.stringMatching(/too short/),
      ]),
    );
  });

  it("becomes a Script the rest of Nomen reads, carrying the story", () => {
    const story = normalizeStory(raw, ctx);
    const script = storyScript(story, { score: 8, notes: [], rounds: 1 });
    expect(script.code_ad).toBe(story);
    expect(script.beats.map((b) => b.job)).toEqual(["hook", "agitate", "reveal", "cta"]);
    expect(script.beats[1]).toMatchObject({ line: "It buys rubber ducks. Your card is a FOUNTAIN.", emotion: "[shouting]", visual: "product" });
    expect(script.total_seconds).toBeGreaterThan(5);
  });
});

describe("the format in the pipeline", () => {
  it("is one the director can choose, with no shots to render and an ad-length target", () => {
    expect(FORMATS).toContain("code_ad");
    const strategy = normalizeStrategy({ campaign: { briefs: [{ ...brief }] } }, { concepts: 1, shotsPerConcept: 1, secondsPerShot: 4, videoModel: "x" }, { referenceIds: ["ref_x"], visualIds: [] });
    expect(strategy.campaign.briefs![0].format).toBe("code_ad");
    expect(targetSeconds({ duration: 54 }, "code_ad")).toBe(24);
    expect(targetSeconds({ duration: 12 }, "code_ad")).toBe(18);
    const script = storyScript(normalizeStory(raw, ctx));
    const plan = planProduction(script, brief, product);
    expect(plan).toEqual({ format: "code_ad", aroll: [], broll: [], voiceover: null, screens: [] });
    const concept = conceptFrom(brief, script, plan, reference, product);
    expect(concept).toMatchObject({ format: "code ad", shots: [] });
    expect(concept.internal).toBeUndefined();
  });

  it("sends a code_ad brief to the code-ad writer and critic", async () => {
    const calls: string[] = [];
    const naive = {
      async message(input: { tools?: Array<{ name: string }> }) {
        const tool = input.tools?.[0]?.name ?? "";
        calls.push(tool);
        if (tool === "code_ad") return { content: [{ type: "tool_use", name: "code_ad", input: raw }] };
        return { content: [{ type: "tool_use", name: "code_ad_review", input: { score: 9, notes: ["tight"], revised: {} } }] };
      },
    } as unknown as NaiveClient;
    const script = await writeScript(naive, { product, brief, reference, targetSeconds: 24 });
    expect(calls).toEqual(["code_ad", "code_ad_review"]);
    expect(script.code_ad?.beats).toHaveLength(4);
    expect(script.review).toMatchObject({ score: 9, rounds: 1 });
  });
});

describe("narration timing", () => {
  it("counts syllables and shows words the way captions do", () => {
    expect(syllables("congratulations")).toBe(5);
    expect(syllables("make")).toBe(1);
    expect(syllables("625")).toBeCloseTo(5.8);
    expect(norm("Naïve,")).toBe("naive");
    expect(display("“money.”")).toBe("Money");
    expect(untag("[shouting] It buys  ducks")).toBe("It buys ducks");
  });

  it("splits a clip's phrases at its pauses and its words by syllables", () => {
    // 0.5 s silence, phrase one 1.0 s, a 0.3 s pause, phrase two 1.0 s, 0.4 s silence
    const tone = (s: number) => Array.from({ length: Math.round(s * SR) }, (_, i) => 0.4 * Math.sin((i * 2 * Math.PI * 220) / SR));
    const quiet = (s: number) => Array.from({ length: Math.round(s * SR) }, () => 0);
    const x = Float32Array.from([...quiet(0.5), ...tone(1.0), ...quiet(0.3), ...tone(1.0), ...quiet(0.4)]);
    const words = estimateWords("Make money, fast cars.", x);
    expect(words.map((w) => w.w)).toEqual(["Make", "money,", "fast", "cars."]);
    expect(words[0].t0).toBeCloseTo(0.5, 1);
    expect(words[1].t1).toBeCloseTo(1.5, 1);
    expect(words[2].t0).toBeCloseTo(1.8, 1);
    // a 0.3 s breath inside the line comes down to about 0.12 s; the edges are left to trimClip
    expect(compressPauses(x).length / SR).toBeCloseTo((x.length / SR) - 0.18, 1);
    expect(compressPauses(x, 0.5).length).toBe(x.length);
    const trimmed = trimClip(x, words);
    expect(trimmed.x.length / SR).toBeCloseTo(2.38, 1);
    expect(trimmed.words[0].t0).toBeCloseTo(0.04, 1);
  });
});

const brand: CodeAdBrand = { name: "Naïve", url: "usenaive.ai", logo: null, logoOnLight: null, font: null, fontFamily: null, colors: { screenBg: "#212121", screenFg: "#ececec", accent: "#d29922", crate: "#0a0a0a", robot: "#1f2228", eye: "#d29922", sign: "#d29922", wall: "#3a414d" } };
const voiced: Voiced = {
  provider: "scratch",
  duration: 9,
  beats: [
    { id: "hook", t0: 0.06, t1: 2.5, words: ["You", "give", "an", "AI", "agent", "your", "card", "and", "one", "instruction:", "make", "money."].map((w, i) => ({ w, t0: 0.06 + i * 0.2, t1: 0.06 + i * 0.2 + 0.18 })) },
    { id: "fail", t0: 2.6, t1: 4.6, words: ["It", "buys", "rubber", "ducks.", "Your", "card", "is", "a", "FOUNTAIN."].map((w, i) => ({ w, t0: 2.6 + i * 0.22, t1: 2.6 + i * 0.22 + 0.2 })) },
    { id: "fix", t0: 4.7, t1: 6.6, words: ["So", "you", "use", "Naïve.", "Pick", "a", "template,", "deploy", "it."].map((w, i) => ({ w, t0: 4.7 + i * 0.21, t1: 4.7 + i * 0.21 + 0.19 })) },
    { id: "end", t0: 6.7, t1: 7.6, words: ["Go", "to", "usenaive.ai."].map((w, i) => ({ w, t0: 6.7 + i * 0.3, t1: 6.7 + i * 0.3 + 0.28 })) },
  ],
};

describe("the page's story.json", () => {
  it("puts beats, words, callouts and gags on the narration's clock", () => {
    const story = normalizeStory(raw, ctx);
    story.beats[1].callouts = [{ at: "ducks", text: "RUBBER DUCKS", style: "stamp" }, { at: "card", text: "MAXED", style: "sfx" }, { at: "unsaid", text: "X", style: "sfx" }];
    const { story: page, notes } = layoutStory(story, voiced, brand, { s1: "/ad/visual-s1.png" });
    expect(page.order).toEqual(["hook", "fail", "fix", "end"]);
    expect(page.beats.hook).toMatchObject({ t0: 0, t1: 2.6, s0: 0.06, s1: 2.5 });
    expect(page.beats.end.t1).toBe(9);
    expect(page.words[0]).toMatchObject({ w: "You", t0: 0.06 });
    expect(page.words.find((w) => w.w === "Naïve")).toBeTruthy();
    // callouts sit in the lower third (the wall screen has the top)
    expect(page.callouts.find((c) => c.text === "RUBBER DUCKS")).toMatchObject({ style: "stamp", t0: 2.6 + 3 * 0.22 - 0.04, y: 0.63 });
    expect(page.callouts.every((c) => (c.y ?? c.pos?.[1] ?? 0) > 0.55)).toBe(true);
    // two callouts up at once take different bands
    for (const a of page.callouts) for (const b of page.callouts) if (a !== b && a.t0 < b.t1 && b.t0 < a.t1) expect(Math.abs((a.y ?? a.pos![1]) - (b.y ?? b.pos![1]))).toBeGreaterThanOrEqual(0.065);
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/"X" dropped/)]));
    const fix = page.codead.beats.find((b) => b.id === "fix")!;
    expect(fix).toMatchObject({ gag: "deliver", hit: 4.7 + 3 * 0.21, labels: ["AGENT"], screen: { kind: "logo" } });
    expect(page.codead.beats[0].screen).toMatchObject({ kind: "terminal" });
    expect(page.codead.brand.name).toBe("Naïve");
    expect(sheetTimes(page, 6)).toHaveLength(6);
  });

  it("casts the lead (Chad, unless an older story named its developer); never Gary on the nameplate", () => {
    const story = normalizeStory({ ...raw, nameplate: "GARY · SOLO FOUNDER" }, ctx);
    expect(story).toMatchObject({ hero: "chad", scene: "office" });
    expect(heroFor({ ...story, hero: undefined }, "crv_a")).toBe("chad");
    expect(heroFor({ ...story, hero: "mogger" }, "crv_a")).toBe("mogger");
    const { story: page } = layoutStory(story, voiced, brand, {});
    expect(page.codead).toMatchObject({ hero: "chad", scene: "office", nameplate: "DEV · SOLO FOUNDER" });
    expect(page.codead.rival).toBeUndefined();
    expect(page.codead.beats.every((b) => b.who === "hero")).toBe(true);
  });

  it("stages a versus ad: the rival plays the old way's problems, the lead plays the product and the ending", () => {
    const vs = normalizeStory({ ...raw, rival: { name: "diy agents" }, beats: raw.beats.map((b, i) => ({ ...b, who: i === 2 ? "hero" : "rival" })) }, ctx);
    expect(vs).toMatchObject({ scene: "versus", rival: { name: "DIY AGENTS" } });
    // the hack and the money are his; a product gag (deliver) and the last beat stay the lead's
    expect(vs.beats.map((b) => b.who ?? "hero")).toEqual(["rival", "rival", "hero", "hero"]);
    const { story: page } = layoutStory(vs, voiced, brand, {});
    expect(page.codead).toMatchObject({ scene: "versus", rival: { name: "DIY AGENTS" } });
    expect(page.codead.beats.map((b) => b.who)).toEqual(["rival", "rival", "hero", "hero"]);
    // a scene asked for wins over the writer's; a versus ad with no rival beat is flagged
    expect(normalizeStory({ ...raw, scene: "gym" }, { ...ctx, scene: "stage" }).scene).toBe("stage");
    expect(normalizeStory({ ...raw, scene: "rooftop" }, ctx).scene).toBe("rooftop");
    expect(lintStory({ ...vs, beats: vs.beats.map((b) => ({ ...b, who: "hero" as const })) }, ctx)).toEqual(expect.arrayContaining([expect.stringMatching(/no rival beat/)]));
  });

  it("gives each scene its own sound: a keynote's applause on the payoff, gym clanks, surf at the pool, a basement drone", () => {
    const withEnd = { ...raw, beats: [...raw.beats.slice(0, 3), { ...raw.beats[3], gag: "celebrate" }] };
    const cuesFor = (scene: string, extra: Record<string, unknown> = {}) => buildCues(layoutStory(normalizeStory({ ...withEnd, scene, ...extra }, ctx), voiced, brand, {}).story, "test");
    const stage = cuesFor("stage");
    expect(stage.ambience.map((a) => a.sound)).toEqual(expect.arrayContaining(["crowd_cheer", "applause"]));
    expect(stage.ambience.find((a) => a.sound === "applause")!.t0).toBeGreaterThan(5);
    expect(cuesFor("gym").events.filter((e) => e.sound === "metal_clang").length).toBeGreaterThan(1);
    expect(cuesFor("rooftop").ambience.map((a) => a.sound)).toContain("surf");
    expect(cuesFor("versus", { rival: { name: "the old way" } }).ambience.map((a) => a.sound)).toContain("cabin_hum");
    expect(cuesFor("office").ambience.map((a) => a.sound)).toEqual(["room_tone", "city_day", "fan"]);
  });

  it("scores it like ED Studio's build reels: music from beat 2, a ta-da on every term, foley per gag, the narrator on top", () => {
    const story = normalizeStory(raw, ctx);
    const { story: page } = layoutStory(story, voiced, brand, {});
    const cues = buildCues(page, "test");
    expect(cues.music.sections[0].t0).toBeCloseTo(2.58, 2);
    const term = page.callouts.find((c) => c.style === "term")!;
    expect(cues.music.mallet_melody.filter(([t]) => Math.abs(t - term.t0) < 0.3).map(([, m]) => m)).toEqual([77, 81, 84]);
    expect(cues.events.map((e) => e.sound)).toEqual(expect.arrayContaining(["keyboard_type", "blanket_rustle", "giant_step", "wood_snap"]));
    expect(cues.voice).toMatchObject({ file: "voice.wav", duck_db: -9 });
    expect(cues.target_lufs).toBe(-14);
    expect(cues.events.every((e) => e.t >= 0 && e.t < page.duration)).toBe(true);
  });
});

describe("the brand on screen", () => {
  it("reads an SVG logo's ink and the kit's colours", async () => {
    expect(svgInk('<svg><circle fill="#fbf9f6"/><circle fill="#fbf9f6"/><rect fill="#000000"/></svg>')).toBe("#fbf9f6");
    const dir = await mkdtemp(join(tmpdir(), "nomen-codead-brand-"));
    try {
      const logo = join(dir, "logo-src.svg");
      await writeFile(logo, '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1" fill="#fbf9f6"/></svg>');
      const kit: BrandKit = {
        brand_id: "b",
        updated_at: "",
        assets: [{ id: "a1", kind: "logo", path: logo, source: "upload", caption: "logo", bytes: 10 }],
        repo: { origin: "", scanned_at: "", name: "", description: "", readme: "", colors: [{ name: "background", hex: "#212121", source: "" }, { name: "foreground", hex: "#ececec", source: "" }, { name: "amber", hex: "#d29922", source: "" }], fonts: [], commands: [], screens: [], components: [], ui_strings: [] },
      };
      const out = await brandFor({ name: "Naïve", site: "usenaive.ai", kit, product, dir });
      expect(out.colors).toMatchObject({ screenBg: "#212121", screenFg: "#ececec", accent: "#d29922" });
      expect(out.logo).toBe("/ad/logo-dark.svg");
      expect(existsSync(join(dir, "logo-dark.svg"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

let root = "";
function folderFiles(dir: string): Files {
  const at = (key: string) => join(dir, key);
  return {
    async putFile(key, path) {
      await mkdir(dirname(at(key)), { recursive: true });
      await copyFile(path, at(key));
    },
    async saveUrl() {
      throw new Error("no network");
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

describe("the code ad in production", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "nomen-codead-job-"));
    useStore({ ...sqliteStore(), files: folderFiles(join(root, "kept")) });
  });
  afterAll(async () => {
    useStore(undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("says plainly that a serverless host cannot render it, and fails a concept with no story", async () => {
    const brandId = await createBrand("codead-job.example");
    const campaignId = await startCampaign(brandId, { concepts: 2, shotsPerConcept: 1, secondsPerShot: 4, videoModel: "google/veo-3.1", learnStyle: false });
    const story = normalizeStory(raw, ctx);
    const script = storyScript(story);
    const concept = conceptFrom(brief, script, planProduction(script, brief, product), reference, product) as Concept;
    const ctxP = { campaignId, brandId, naive: null, monid: null, naiveOut: () => false, markNaiveOut: async () => undefined, strategy: {}, product } as unknown as ProductionContext;

    const was = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
      expect(cannotRender()).toMatch(/serverless host/);
      await insertCreative(campaignId, 0, concept);
      const [row] = await listCreatives(campaignId);
      await advanceCodeAd(ctxP, row, concept);
      const [failed] = await listCreatives(campaignId);
      expect(failed).toMatchObject({ status: "failed" });
      expect(failed.error).toMatch(/run the worker locally/);
    } finally {
      if (was === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = was;
    }

    const bare = { ...concept, script: { ...script, code_ad: undefined } } as Concept;
    const id = await insertCreative(campaignId, 1, bare);
    const rows = await listCreatives(campaignId);
    await advanceCodeAd(ctxP, rows.find((r) => r.id === id)!, bare);
    expect((await listCreatives(campaignId)).find((r) => r.id === id)).toMatchObject({ status: "failed", error: "the code ad has no story (script.code_ad)" });
    await save("campaigns", campaignId, { status: "stopped" });
  });
});
