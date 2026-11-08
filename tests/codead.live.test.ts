import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { makeCodeAd, prepareAd } from "@/lib/codeads/job";
import { ADAM_V3, type Narrator } from "@/lib/codeads/narrate";
import { contactSheet, renderStills, runQc } from "@/lib/codeads/render";
import { writeCodeAd } from "@/lib/codeads/story";
import type { CodeAdStory, Hero } from "@/lib/codeads/types";
import { getBrandKit } from "@/lib/creative/brandkit";
import { targetSeconds } from "@/lib/creative/script";
import { findChrome } from "@/lib/creative/screens";
import type { CreativeBrief, FunnelRole, ProductBrief, ReferenceBreakdown } from "@/lib/creative/types";
import { ApiError } from "@/lib/http";
import { MonidClient } from "@/lib/monid";
import { NaiveClient } from "@/lib/naive";
import type { Files } from "@/lib/store/types";

// Opt-in runs of code ads for real campaigns. They read each campaign read-only from data/nomen.db (NOMEN_DATA_DIR,
// e.g. the main checkout's data/) and write only into this checkout's data/codead-live/<name>/ (or NOMEN_CODEAD_OUT).
// Rendering is local and free (headless Chrome + WebGL, ffmpeg, python3 with numpy and scipy).
//
//   NOMEN_CODEAD_LIVE=all    …  the Naïve case: writer + critic (Naive, ~$0.10), narration (ElevenLabs on Monid, ~$0.04),
//                               mix, render, frame check (Naive vision, cents) → final.mp4 + frames.jpg
//   NOMEN_CODEAD_LIVE=story | make | page   …  only the story / the ad from the saved story / the page folder for stills
//   NOMEN_CODEAD_LIVE=batch  …  every case in CASES (NOMEN_CODEAD_CASES=name,name picks some), one after another
//   NOMEN_CODEAD_LIVE=stills NOMEN_CODEAD_DIR=<an ad folder with story.json>   stills + a sheet, free
//
// Options: NOMEN_CODEAD_HERO (geek | mogger), NOMEN_CODEAD_NARRATOR=v3 (ED Studio's dramatic Adam read),
// NOMEN_CODEAD_VOICE=scratch (the free macOS voice), NOMEN_CODEAD_TARGET (seconds), NOMEN_CODEAD_STORY (a CodeAdStory
// JSON to use as it is), NOMEN_CODEAD_TAG, NOMEN_CODEAD_FPS (60), NOMEN_CODEAD_QC=off (no frame check).
// Keys: NAIVE_API_KEY and MONID_API_KEY, or .env.local next to the data folder.
//
//   NOMEN_DATA_DIR=/Users/dylan/Documents/GitHub/nomen/data NOMEN_CODEAD_LIVE=batch npx vitest run tests/codead.live.test.ts

const mode = process.env.NOMEN_CODEAD_LIVE ?? "";

type Case = {
  name: string;
  campaign: string;
  /** The breakdown whose concept the ad borrows (any niche). */
  reference: string;
  hero: Hero;
  title: string;
  role: FunnelRole;
  angle: string;
  hook_plan: string;
  cta: string;
  /** Use this saved story instead of writing one, and this narrator (re-renders). */
  story?: string;
  narrator?: "v3";
  target?: number;
};

const NAIVE = "cmp_70daa9e79a4b42008d74", MONID = "cmp_f98819d8b08f46a7a422", MOBILERUN = "cmp_8258fde751824aeba97f";

const CASES: Case[] = [
  // The first sample (mplentg's "I Let AI Run My Side Hustle": an AI given one instruction, make money), re-rendered with
  // a developer in place of the builder, a little faster, on its kept story and voice.
  ...(["geek", "mogger"] as const).map((hero): Case => ({ name: `naive-dare-${hero}`, campaign: NAIVE, reference: "ref_88a571100e", hero, title: "How a credit card becomes a company", role: "convert", angle: "", hook_plan: "", cta: "Pick a company template at usenaive.ai", story: "data/codead-live/naive-v3/story.json", narrator: "v3", target: 24 })),
  {
    name: "naive-shorts",
    campaign: NAIVE,
    reference: "ref_29a74e567d", // zachhh.mp4: "Shorts + Claude = $528/day", a numbered three-step tutorial (1.3M views)
    hero: "geek",
    title: "A short-form channel in three steps",
    role: "convert",
    angle: "A short-form video channel run by an agent team, in three steps: pick Naïve's Short Form template, deploy it, watch the first session brief, script and generate a video.",
    hook_plan: "The reference's two-logos-plus-a-promise card and numbered steps, for Naïve's Short Form template.",
    cta: "Deploy the Short Form template at usenaive.ai",
  },
  {
    name: "naive-rules",
    campaign: NAIVE,
    reference: "ref_593aea417a", // ElevenLabs' agents ad: "Every enterprise sees the potential of AI agents" (ran 44 days)
    hero: "mogger",
    title: "Agents you can trust with a company",
    role: "convert",
    angle: "Everyone sees what AI agents could do; nobody trusts them with money or customers. Naïve: each agent gets its own identity, policy lives in one committed file, and anything that costs money waits for your yes.",
    hook_plan: "The reference's flattering premise with an unspoken 'but', answered by the product's guardrails.",
    cta: "Build your company with agents at usenaive.ai",
  },
  {
    name: "monid-setup",
    campaign: MONID,
    reference: "ref_119a19b980", // ai.with.ni: "Everyone talks about vibe coding, but nobody shows you the actual setup" (1.2M views)
    hero: "geek",
    title: "The one-line setup nobody shows you",
    role: "convert",
    angle: "Everyone talks about AI agents; nobody shows the setup that gives them tools. One line, 'set up monid.ai/SKILL.md', and the agent finds, compares and pays for 2900+ tools from one balance.",
    hook_plan: "The reference's gap hook ('nobody shows you the actual setup'), then the setup shown step by step.",
    cta: "Start with $1 in free credit at monid.ai",
  },
  {
    name: "monid-subscriptions",
    campaign: MONID,
    reference: "ref_39fbf885ae", // Cluely: "We spent $400,000 on these billboards" (628K views)
    hero: "mogger",
    title: "We killed the subscriptions",
    role: "reach",
    angle: "Your agent needs a dozen APIs, and each one wants a sign-up, a key and a subscription. Monid gives the agent one balance and pay-per-call access to every tool.",
    hook_plan: "The reference's big-spend opener, as the pile of keys and subscriptions an agent needs, then Monid's one balance.",
    cta: "Start with $1 in free credit at monid.ai",
  },
  {
    name: "mobilerun-phone",
    campaign: MOBILERUN,
    reference: "ref_3c6a101cca", // risingpower__: an old desk phone ringing because an AI agent is calling (769K views)
    hero: "geek",
    title: "Give your agent a phone",
    role: "convert",
    angle: "Your agent can write code but it can't use a phone. Mobilerun gives it a real cloud phone it can tap, swipe and type on: describe the task in plain language and it runs.",
    hook_plan: "The reference's odd pairing of a phone and an AI agent, flipped: the agent finally gets a phone of its own.",
    cta: "Start free at mobilerun.ai",
  },
  {
    name: "mobilerun-fleet",
    campaign: MOBILERUN,
    reference: "ref_3c6a101cca",
    hero: "mogger",
    title: "Test it on twenty phones at once",
    role: "convert",
    angle: "Testing on one phone at a time is slow. Mobilerun runs your task on a fleet of real cloud phones at once, with a live view of every step.",
    hook_plan: "The reference's curiosity hook (an everyday phone doing something unexpected), scaled up to a whole fleet.",
    cta: "Start free at mobilerun.ai",
  },
];

/** The store's files in a folder of their own, so a live run never touches the app's media. */
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

function loadKeys() {
  const data = resolve(process.env.NOMEN_DATA_DIR ?? join(process.cwd(), "data"));
  for (const file of [join(process.cwd(), ".env.local"), join(dirname(data), ".env.local")]) {
    if ((!process.env.NAIVE_API_KEY || !process.env.MONID_API_KEY) && existsSync(file)) process.loadEnvFile(file);
  }
  process.env.NOMEN_BRANDKITS_DIR = join(data, "brandkits");
  return data;
}

function campaignInputs(data: string, campaignId: string, referenceId: string) {
  const db = new Database(join(data, "nomen.db"), { readonly: true, fileMustExist: true });
  const campaign = db.prepare("select brand_id, style_json from campaigns where id = ?").get(campaignId) as { brand_id: string; style_json: string };
  const brand = db.prepare("select name, domain, url from brands where id = ?").get(campaign.brand_id) as { name: string; domain: string; url: string };
  db.close();
  const style = JSON.parse(campaign.style_json) as { breakdowns: ReferenceBreakdown[]; product: ProductBrief };
  const reference = style.breakdowns.find((b) => b.id === referenceId);
  if (!reference) throw new Error(`${referenceId} is not in ${campaignId}`);
  // captured screenshots are kept by key under data/media
  const product: ProductBrief = { ...style.product, visuals: style.product.visuals.map((v) => (v.key && existsSync(join(data, "media", v.key)) ? { ...v, url: join(data, "media", v.key) } : v)) };
  return { brandId: campaign.brand_id, brand, product, reference, kit: getBrandKit(campaign.brand_id) };
}

/** Naive answers "at capacity" (429) at busy times: wait it out, as the worker does on its next tick. */
async function patient<T>(work: () => Promise<T>, log: (message: string) => void, tries = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ApiError && error.retryable) || i >= tries) throw error;
      log(`busy (${error.message}); trying again in ${15 * i} s`);
      await new Promise((done) => setTimeout(done, 15_000 * i));
    }
  }
}

const siteOf = (brand: { domain: string; url: string }) => (brand.domain || brand.url).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

function briefFor(c: Case, input: ReturnType<typeof campaignInputs>): CreativeBrief {
  return {
    title: c.title,
    reference_id: input.reference.id,
    role: c.role,
    metric: c.role === "convert" ? "link_clicks" : "views",
    format: "code_ad",
    angle: c.angle,
    audience: input.product.audience,
    hook_plan: c.hook_plan || input.reference.hook.mechanic,
    keep: ["the reference's premise and hook mechanic"],
    change: ["the product, its real features and offer"],
    visuals: input.product.visuals.filter((v) => v.kind === "screenshot").map((v) => v.id),
    creator: "",
    setting: "",
    platforms: ["tiktok", "instagram", "youtube"],
    caption: "",
    hashtags: [],
    cta: c.cta,
    why: `${input.reference.author}'s video got ${input.reference.views.toLocaleString("en-US")} views${input.reference.outlier ? `, ${Math.round(input.reference.outlier)}x its followers` : ""}.`,
  };
}

/** Writes (or reuses) the case's story and makes the ad into `out`. */
async function runCase(c: Case, data: string, out: string, stage: "story" | "make" | "page" | "all", log: (message: string) => void) {
  await mkdir(out, { recursive: true });
  const input = campaignInputs(data, c.campaign, c.reference);
  const naive = process.env.NAIVE_API_KEY ? new NaiveClient(process.env.NAIVE_API_KEY) : null;
  const target = Number(process.env.NOMEN_CODEAD_TARGET) || c.target || targetSeconds(input.reference, "code_ad");
  const storyPath = join(out, "story.json");
  let story: CodeAdStory;
  const given = process.env.NOMEN_CODEAD_STORY ?? c.story;
  if (given) story = JSON.parse(await readFile(given, "utf8")) as CodeAdStory;
  else if (stage !== "all" && stage !== "story" && existsSync(storyPath)) story = JSON.parse(await readFile(storyPath, "utf8")) as CodeAdStory;
  else {
    expect(naive, "NAIVE_API_KEY is needed to write the story").toBeTruthy();
    const written = await patient(() => writeCodeAd(naive!, { product: input.product, brief: briefFor(c, input), reference: input.reference, targetSeconds: target, site: siteOf(input.brand) }), log);
    story = written.story;
    await writeFile(join(out, "script.json"), JSON.stringify(written.script, null, 1));
    log(`story: ${story.beats.length} beats, ${story.hero ?? "?"}, critic ${written.script.review?.score ?? "?"}/10 (${written.script.review?.notes.join(" | ").slice(0, 600) ?? ""})`);
    for (const b of story.beats) log(`  ${b.id.padEnd(10)} ${b.gag.padEnd(9)} ${b.say}`);
  }
  story = { ...story, hero: (process.env.NOMEN_CODEAD_HERO as Hero | undefined) ?? c.hero ?? story.hero };
  await writeFile(storyPath, JSON.stringify(story, null, 1));
  if (stage === "story") return;

  const chrome = findChrome();
  expect(chrome, "install Google Chrome or set CHROME_PATH").toBeTruthy();
  const voice = process.env.NOMEN_CODEAD_VOICE === "scratch" || !process.env.MONID_API_KEY ? "scratch" : "eleven";
  const v3 = (process.env.NOMEN_CODEAD_NARRATOR ?? c.narrator) === "v3";
  const narrator: Narrator = voice === "eleven" ? { kind: "eleven", monid: new MonidClient(process.env.MONID_API_KEY!), ...(v3 ? { model: ADAM_V3.model, settings: ADAM_V3.settings } : {}) } : { kind: "scratch" };
  const adInput: Parameters<typeof makeCodeAd>[0] = {
    prefix: "codead",
    story,
    product: input.product,
    kit: input.kit,
    brandName: input.product.name,
    site: story.url || siteOf(input.brand),
    narrator,
    // a re-render keeps the voice clips its story was voiced with (they are paid for once)
    files: folderFiles(join(c.story ? dirname(resolve(c.story)) : out, "kept")),
    dir: join(out, "work"),
    chrome: chrome!,
    targetSeconds: target,
    naive: process.env.NOMEN_CODEAD_QC === "off" ? null : naive,
    fps: Number(process.env.NOMEN_CODEAD_FPS) || 60,
    log,
  };
  if (stage === "page") {
    const page = await prepareAd(adInput);
    log(`page ready: ${join(out, "work")} (${page.story.duration.toFixed(1)} s); stills: NOMEN_CODEAD_LIVE=stills NOMEN_CODEAD_DIR=${join(out, "work")}`);
    return;
  }
  const made = await makeCodeAd(adInput);
  await copyFile(made.path, join(out, "final.mp4"));
  await copyFile(made.sheet, join(out, "frames.jpg"));
  await writeFile(join(out, "made.json"), JSON.stringify({ duration: made.duration, hero: story.hero, spend_usd: made.spendMicro / 1e6, qc: made.qc, notes: made.notes, reference: { id: input.reference.id, url: input.reference.url, author: input.reference.author, views: input.reference.views, followers: input.reference.followers } }, null, 1));
  log(`final ${join(out, "final.mp4")} (${made.duration.toFixed(1)} s), narrator $${(made.spendMicro / 1e6).toFixed(3)}, QC ${made.qc ? `${made.qc.score}/10 ${made.qc.issues.join(" | ").slice(0, 600)}` : "not run"}`);
  if (made.notes.length) log(`notes: ${made.notes.join(" | ")}`);
  expect(made.duration).toBeGreaterThan(8);
}

const outFor = (name: string) => resolve(process.env.NOMEN_CODEAD_OUT ?? join(process.cwd(), "data", "codead-live", name));

describe.skipIf(!["story", "make", "all", "page"].includes(mode))("a code ad for the Naïve campaign (live)", () => {
  it("writes and makes the ad", async () => {
    const data = loadKeys();
    const log = (message: string) => console.log(`[code ad] ${message}`);
    const c: Case = { name: "naive", campaign: process.env.NOMEN_CODEAD_CAMPAIGN ?? NAIVE, reference: process.env.NOMEN_CODEAD_REFERENCE ?? "ref_88a571100e", hero: (process.env.NOMEN_CODEAD_HERO as Hero) ?? "geek", title: "How a credit card becomes a company", role: "convert", angle: "An AI agent with your card and no rules is chaos; Naïve gives agents a company to run, with approvals and budgets.", hook_plan: "", cta: "Pick a company template at usenaive.ai" };
    await runCase(c, data, outFor(`naive-${process.env.NOMEN_CODEAD_TAG ?? "v1"}`), mode as "story" | "make" | "page" | "all", log);
  }, 3_600_000);
});

describe.skipIf(mode !== "batch")("code ads for the sponsor brands (live batch)", () => {
  it("makes every case", async () => {
    const data = loadKeys();
    const pick = (process.env.NOMEN_CODEAD_CASES ?? "").split(",").filter(Boolean);
    const failures: string[] = [];
    for (const c of CASES.filter((c) => !pick.length || pick.includes(c.name))) {
      const log = (message: string) => console.log(`[${c.name}] ${message}`);
      try {
        await runCase(c, data, outFor(c.name), "all", log);
      } catch (error) {
        failures.push(`${c.name}: ${error instanceof Error ? error.message : String(error)}`);
        log(`failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 14_400_000);
});

describe.skipIf(mode !== "stills")("code ad stills (local, free)", () => {
  it("renders stills and a sheet", async () => {
    const dir = process.env.NOMEN_CODEAD_DIR!;
    const chrome = findChrome();
    expect(chrome, "install Google Chrome or set CHROME_PATH").toBeTruthy();
    const times = (process.env.NOMEN_CODEAD_TIMES ?? "0.5,2.5,4.4,5.8,7,8.6,9.6,11,13.5,15.4,17,19,21,23").split(",").map(Number);
    const stills = await renderStills(dir, chrome!, times, join(dir, "stills"));
    console.log(await contactSheet(stills, join(dir, "stills", "_sheet.jpg"), Math.min(7, stills.length)));
    if (process.env.NOMEN_CODEAD_QC) console.log((await runQc(dir, chrome!)).join("\n") || "qc: clean");
  }, 600_000);
});
