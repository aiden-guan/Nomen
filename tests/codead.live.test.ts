import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { makeCodeAd, prepareAd } from "@/lib/codeads/job";
import { contactSheet, renderStills, runQc } from "@/lib/codeads/render";
import { writeCodeAd } from "@/lib/codeads/story";
import type { CodeAdStory } from "@/lib/codeads/types";
import { getBrandKit } from "@/lib/creative/brandkit";
import { targetSeconds } from "@/lib/creative/script";
import { findChrome } from "@/lib/creative/screens";
import { ApiError } from "@/lib/http";
import type { CreativeBrief, ProductBrief, ReferenceBreakdown } from "@/lib/creative/types";
import { MonidClient } from "@/lib/monid";
import { NaiveClient } from "@/lib/naive";
import type { Files } from "@/lib/store/types";

// Opt-in runs of a code ad for a real campaign. They read the campaign read-only from data/nomen.db (NOMEN_DATA_DIR,
// e.g. the main checkout's data/) and write only into NOMEN_CODEAD_OUT (default: this checkout's data/codead-live/<tag>).
// Rendering is local and free (headless Chrome + WebGL, ffmpeg, python3 with numpy and scipy).
//
//   NOMEN_CODEAD_LIVE=story  …  the writer and critic write the story (Naive, ~$0.10-0.30) → <out>/story.json
//   NOMEN_CODEAD_LIVE=make   …  narrates (ElevenLabs on Monid, cents; NOMEN_CODEAD_VOICE=scratch for the free macOS voice),
//                               mixes, renders, checks the frames (Naive vision, cents) → <out>/final.mp4 + frames.jpg
//   NOMEN_CODEAD_LIVE=all    …  both
//   NOMEN_CODEAD_LIVE=page   …  only the page's folder (narration, story.json, cues.json) in <out>/work, for stills
//   NOMEN_CODEAD_LIVE=stills NOMEN_CODEAD_DIR=<an ad folder with story.json>   stills + a sheet, free
//
// Inputs: NOMEN_CODEAD_CAMPAIGN (default the Naïve campaign), NOMEN_CODEAD_REFERENCE (a breakdown id in it),
// NOMEN_CODEAD_STORY (use this CodeAdStory JSON instead of writing one), NOMEN_CODEAD_TAG, NOMEN_CODEAD_FPS (60),
// NOMEN_CODEAD_QC=off (no frame check, no Naive call).
// Keys: NAIVE_API_KEY and MONID_API_KEY, or .env.local next to the data folder.
//
//   NOMEN_DATA_DIR=/Users/dylan/Documents/GitHub/nomen/data NOMEN_CODEAD_LIVE=all npx vitest run tests/codead.live.test.ts

const mode = process.env.NOMEN_CODEAD_LIVE ?? "";
const CAMPAIGN = process.env.NOMEN_CODEAD_CAMPAIGN ?? "cmp_70daa9e79a4b42008d74";
// mplentg: "In six hours, it made $3,000": an AI given root access and one instruction, "make money" (644K views, 364x its followers)
const REFERENCE = process.env.NOMEN_CODEAD_REFERENCE ?? "ref_88a571100e";

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

function campaignInputs() {
  const data = resolve(process.env.NOMEN_DATA_DIR ?? join(process.cwd(), "data"));
  for (const file of [join(process.cwd(), ".env.local"), join(dirname(data), ".env.local")]) {
    if ((!process.env.NAIVE_API_KEY || !process.env.MONID_API_KEY) && existsSync(file)) process.loadEnvFile(file);
  }
  process.env.NOMEN_BRANDKITS_DIR = join(data, "brandkits");
  const db = new Database(join(data, "nomen.db"), { readonly: true, fileMustExist: true });
  const campaign = db.prepare("select brand_id, style_json from campaigns where id = ?").get(CAMPAIGN) as { brand_id: string; style_json: string };
  const brand = db.prepare("select name, domain, url from brands where id = ?").get(campaign.brand_id) as { name: string; domain: string; url: string };
  db.close();
  const style = JSON.parse(campaign.style_json) as { breakdowns: ReferenceBreakdown[]; product: ProductBrief };
  const reference = style.breakdowns.find((b) => b.id === REFERENCE);
  if (!reference) throw new Error(`${REFERENCE} is not in ${CAMPAIGN}`);
  // captured screenshots are kept by key under data/media
  const product: ProductBrief = { ...style.product, visuals: style.product.visuals.map((v) => (v.key && existsSync(join(data, "media", v.key)) ? { ...v, url: join(data, "media", v.key) } : v)) };
  return { data, brandId: campaign.brand_id, brand, product, reference, kit: getBrandKit(campaign.brand_id) };
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

const site = (brand: { domain: string; url: string }) => (brand.domain || brand.url).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

describe.skipIf(!["story", "make", "all", "page"].includes(mode))("code ad for a real campaign (live)", () => {
  it("writes and makes the ad", async () => {
    const input = campaignInputs();
    const tag = process.env.NOMEN_CODEAD_TAG ?? "v1";
    const out = resolve(process.env.NOMEN_CODEAD_OUT ?? join(process.cwd(), "data", "codead-live", `${input.product.name.normalize("NFD").replace(/[^\w]+/g, "").toLowerCase()}-${tag}`));
    await mkdir(out, { recursive: true });
    const log = (message: string) => console.log(`[code ad] ${message}`);
    const naive = process.env.NAIVE_API_KEY && process.env.NOMEN_CODEAD_QC !== "off" ? new NaiveClient(process.env.NAIVE_API_KEY) : null;
    const brief: CreativeBrief = {
      title: `How a credit card becomes a company (${input.product.name})`,
      reference_id: input.reference.id,
      role: "convert",
      metric: "link_clicks",
      format: "code_ad",
      angle: "An AI agent with your card and no rules is chaos; Naïve gives agents a company to run, with approvals and budgets.",
      audience: input.product.audience,
      hook_plan: `${input.reference.hook.mechanic} → the agent gets your card and one instruction: make money.`,
      keep: ["the premise: an AI given one instruction, 'make money'", "a result first, then the stages", "a failure stage before the win"],
      change: ["their AI and server → Gary's agent with a credit card", "their dollar figures → none (the failure is a joke, the facts are Naïve's)"],
      visuals: input.product.visuals.filter((v) => v.kind === "screenshot").map((v) => v.id),
      creator: "",
      setting: "",
      platforms: ["tiktok", "instagram", "youtube"],
      caption: "",
      hashtags: ["#AIagents", "#buildinpublic"],
      cta: `Pick a company template at ${site(input.brand)}`,
      why: `${input.reference.author}'s video got ${input.reference.views.toLocaleString("en-US")} views, ${Math.round(input.reference.outlier ?? 0)}x its followers.`,
    };
    const target = targetSeconds(input.reference, "code_ad");

    let story: CodeAdStory;
    const storyPath = join(out, "story.json");
    if (process.env.NOMEN_CODEAD_STORY) story = JSON.parse(await readFile(process.env.NOMEN_CODEAD_STORY, "utf8")) as CodeAdStory;
    else if ((mode === "make" || mode === "page") && existsSync(storyPath)) story = JSON.parse(await readFile(storyPath, "utf8")) as CodeAdStory;
    else {
      expect(naive, "NAIVE_API_KEY is needed to write the story").toBeTruthy();
      const written = await patient(() => writeCodeAd(naive!, { product: input.product, brief, reference: input.reference, targetSeconds: target, site: site(input.brand) }), log);
      story = written.story;
      await writeFile(storyPath, JSON.stringify(story, null, 1));
      await writeFile(join(out, "script.json"), JSON.stringify(written.script, null, 1));
      log(`story: ${story.beats.length} beats, critic ${written.script.review?.score ?? "?"}/10 (${written.script.review?.notes.join(" | ") ?? ""})`);
      for (const b of story.beats) log(`  ${b.id.padEnd(10)} ${b.gag.padEnd(9)} ${b.say}`);
    }
    if (mode === "story") return;

    const chrome = findChrome();
    expect(chrome, "install Google Chrome or set CHROME_PATH").toBeTruthy();
    const voice = process.env.NOMEN_CODEAD_VOICE === "scratch" || !process.env.MONID_API_KEY ? "scratch" : "eleven";
    const adInput: Parameters<typeof makeCodeAd>[0] = {
      prefix: "codead",
      story,
      product: input.product,
      kit: input.kit,
      brandName: input.product.name,
      site: story.url || site(input.brand),
      narrator: voice === "eleven" ? { kind: "eleven", monid: new MonidClient(process.env.MONID_API_KEY!) } : { kind: "scratch" },
      files: folderFiles(join(out, "kept")),
      dir: join(out, "work"),
      chrome: chrome!,
      targetSeconds: target,
      naive,
      fps: Number(process.env.NOMEN_CODEAD_FPS) || 60,
      log,
    };
    if (mode === "page") {
      const page = await prepareAd(adInput);
      log(`page ready: ${join(out, "work")} (${page.story.duration.toFixed(1)} s); stills: NOMEN_CODEAD_LIVE=stills NOMEN_CODEAD_DIR=${join(out, "work")}`);
      return;
    }
    const made = await makeCodeAd(adInput);
    await copyFile(made.path, join(out, "final.mp4"));
    await copyFile(made.sheet, join(out, "frames.jpg"));
    await writeFile(join(out, "made.json"), JSON.stringify({ duration: made.duration, spend_usd: made.spendMicro / 1e6, qc: made.qc, notes: made.notes, reference: { id: input.reference.id, url: input.reference.url, author: input.reference.author, views: input.reference.views, followers: input.reference.followers } }, null, 1));
    log(`final ${join(out, "final.mp4")} (${made.duration.toFixed(1)} s), narrator $${(made.spendMicro / 1e6).toFixed(3)}, QC ${made.qc ? `${made.qc.score}/10 ${made.qc.issues.join(" | ")}` : "not run"}`);
    if (made.notes.length) log(`notes: ${made.notes.join(" | ")}`);
    expect(made.duration).toBeGreaterThan(8);
  }, 3_600_000);
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
