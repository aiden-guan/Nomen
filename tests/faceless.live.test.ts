import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { getBrandKit } from "@/lib/creative/brandkit";
import { PHONE_EQ } from "@/lib/creative/dub";
import { editFfmpeg } from "@/lib/creative/edit";
import type { Gender, Persona } from "@/lib/creative/persona";
import { breakdownReference, referenceId, scoreCandidates } from "@/lib/creative/references";
import { type DeviceDisplay, OverBudget, type PersonaHandle, patient, remakeSpan, remakeVideo } from "@/lib/creative/remake";
import { writeScript } from "@/lib/creative/script";
import type { CreativeBrief, ProductBrief, ReferenceBreakdown, Script } from "@/lib/creative/types";
import { MonidClient } from "@/lib/monid";
import { NaiveClient } from "@/lib/naive";
import type { Video } from "@/lib/research";
import type { Files } from "@/lib/store/types";

// Live, paid runs of faceless one-to-one remakes: no face to fake, so the reference's own footage
// (a filmed laptop or monitor), its graphics' places, its text and its music stay, and only the
// product content and the voice change. Internal only: results stay in
// data/media/remake-live/faceless/ and are never posted. Reads the campaigns read-only.
//
//   NOMEN_FACELESS_LIVE=1 npx vitest run tests/faceless.live.test.ts -t vqgts        (Mobilerun)
//   NOMEN_FACELESS_LIVE=1 npx vitest run tests/faceless.live.test.ts -t aiwithni     (Monid)
//   NOMEN_FACELESS_LIVE=1 npx vitest run tests/faceless.live.test.ts -t elevenlabs   (Naive)
//   NOMEN_FACELESS_LIVE=1 npx vitest run tests/faceless.live.test.ts -t risingpower  (Mobilerun; no Monid at all)
//   NOMEN_FACELESS_LIVE=dry ...   (checks the inputs, pays nothing)
//
// Set NOMEN_DATA_DIR to a data folder holding nomen.db, brandkits/ and media/references/<file>
// (a copy of the app's is best). Keys from NAIVE_API_KEY / MONID_API_KEY or .env.local. A rerun
// resumes from the kept files; NOMEN_REMAKE_TAG starts a fresh take. A reference that was never
// broken down is broken down once and kept as breakdown.json next to the output.

const mode = process.env.NOMEN_FACELESS_LIVE;
const live = mode === "1" || mode === "dry";
const exec = promisify(execFile);

type Case = {
  name: string;
  /** The campaign whose product brief the video is about. */
  campaign: string;
  /** Where the reference's breakdown is (a campaign's style_json), or the pack video to break down. */
  reference: { campaign: string; id: string } | { campaign: string; url: string };
  file: string;
  maxUsd: number;
  /** The voice-over: an ElevenLabs voice matched to the reference's narrator (a Naive voice with `speech: "naive"`). */
  narrator: { id: string; name: string; gender: Gender };
  /** Speech through Naive's own models (no ElevenLabs on Monid). */
  speech?: "naive";
  /** The display the reference films when it is not a computer's. */
  display?: DeviceDisplay;
  /** A filter on our voice (PHONE_EQ when the reference's voice comes out of a phone). */
  voiceEq?: string;
  /** "keep": the reference's own screen stays (it is generic); only the sound and the caption change. */
  screens?: "keep";
  brief: Omit<CreativeBrief, "reference_id" | "format" | "creator" | "setting" | "visuals">;
  stats: string;
};

const MOBILERUN = "cmp_8258fde751824aeba97f";
const MONID = "cmp_f98819d8b08f46a7a422";
const NAIVE = "cmp_70daa9e79a4b42008d74";

const CASES: Case[] = [
  {
    // @vqgts: a phone filming a laptop in a dim room, one lowercase label per shot over a song,
    // "type mqs in comments for link". 600K views on 2.1K followers, 19K saves.
    name: "vqgts",
    campaign: MOBILERUN,
    reference: { campaign: MOBILERUN, url: "https://www.tiktok.com/@vqgts/video/7684015707402603806" },
    file: "vqgts-original.mp4",
    maxUsd: 3,
    // The reference reads its labels in a flat young female text-to-speech voice (about 220 Hz).
    narrator: { id: "roYauZ4bOLAKvVZTPLre", name: "Lena", gender: "female" },
    stats: "600,634 views · 2,114 followers (284x) · 38,586 likes · 19,037 saves · 2,945 shares · 17.5 s · comment-for-link CTA",
    brief: {
      title: "Best website for AI agents",
      role: "convert",
      metric: "link_clicks",
      angle: "Mobilerun shown the way a student shows off a must-have website: one thing it has per shot, then the comment-for-link ask.",
      audience: "Developers building AI agents and app teams who test on phones",
      hook_plan: "The same all-caps hype label over the laptop (BEST WEBSITE FOR ...!!), then one short lowercase label per shot naming one real thing Mobilerun has.",
      keep: ["the handheld shots of a laptop screen in a dim room", "one short lowercase label per shot in the same place and style", "the song", "the comment-for-link ending"],
      change: ["the laptop shows Mobilerun's real web app instead of the school website", "each label names one real Mobilerun feature", "the comment keyword becomes mobilerun"],
      platforms: ["tiktok"],
      caption: "type mobilerun in comments for link",
      hashtags: ["#aiagents", "#mobilerun", "#devtools"],
      cta: "type mobilerun in comments for link",
      why: "A faceless filmed laptop with text labels keeps the reference's real footage, so the clone looks real; the comment-for-link ask is this niche's strongest conversion mechanic.",
    },
  },
  {
    // @ai.with.ni: a phone filming a monitor while he talks through a beginner setup, one step per
    // shot, word-by-word captions, "comment ready". 1.2M views on 11.7K followers, 41K saves.
    name: "aiwithni",
    campaign: MONID,
    reference: { campaign: MONID, id: "ref_119a19b980" },
    file: "ai-with-ni-original.mp4",
    maxUsd: 4,
    narrator: { id: "3iY0r3RaYmOh6WfIwMIH", name: "Matt", gender: "male" },
    stats: "1,225,093 views · 11,720 followers (105x) · 50,585 likes · 41,267 saves · 3,213 shares · 63 s · comment-keyword CTA",
    brief: {
      title: "The actual setup that gives your agent every tool",
      role: "convert",
      metric: "sign_ups",
      angle: "Everyone talks about AI agents using tools, nobody shows the setup: Monid's real setup, step by step, on a filmed monitor.",
      audience: "Developers and builders who run AI agents and are tired of signing up for every API",
      hook_plan: "The same gap hook (everyone talks about X, but nobody shows you the actual setup that makes it work) over the finished state on screen, then a beginner promise.",
      keep: ["the handheld phone filming a monitor", "one step per shot with plain ordinals (the first step, the next step, once that's done)", "the fast casual voice-over with its fillers", "the word-by-word captions", "the comment-ready ending"],
      change: ["the steps are Monid's: monid.ai, the $1 free credit, the one setup line pasted into the agent, monid.discover and monid.run", "the monitor shows Monid's site, terminal and agent chat"],
      platforms: ["tiktok"],
      caption: "Comment READY and I'll show you what your agent can do with it",
      hashtags: ["#aiagents", "#monid", "#claudecode"],
      cta: "comment ready",
      why: "41K saves on 50K likes and a comment-keyword ask: the strongest save signal in the Monid pack, and a faceless filmed screen keeps the real footage.",
    },
  },
  {
    // ElevenLabs' Meta ad: a calm voice-over over soft motion graphics (orbs, a typed prompt, an
    // agent's reply pill, a phone message, guardrail toggles). Ran 44 days with 5 variants.
    name: "elevenlabs",
    campaign: NAIVE,
    reference: { campaign: NAIVE, id: "ref_593aea417a" },
    file: "elevenlabs-ad-original.mp4",
    maxUsd: 4,
    narrator: { id: "sfJopaWaOtauCD3HKX6Q", name: "Arthur", gender: "male" },
    stats: "Meta ad · running 44 days · 5 ads use this creative · Learn more button · 60 s · 1:1",
    brief: {
      title: "Meet Naïve",
      role: "convert",
      metric: "sign_ups",
      angle: "The same calm premise-gap-reveal ad: everyone sees what AI agents could do; running a company with them takes the right team, tools and rules. Meet Naïve.",
      audience: "Founders and solo operators who want a business run by AI agents",
      hook_plan: "The same broad premise line over a slow abstract opener, the gap in one sentence, then the product name as the answer.",
      keep: ["the calm, polished voice-over and its pauses", "the abstract motion-graphic look and its order of scenes", "the agent speaking its own lines inside the demo", "the controls section before the call to action", "the end card"],
      change: ["the product is Naïve: company templates, deploy, agent teams, approvals, budgets in one file", "the agent's lines are Naïve agents' real work (a video queued for review, a spend waiting for approval)"],
      platforms: ["tiktok", "instagram"],
      caption: "Pick a company template, deploy it, and a team of AI agents runs it.",
      hashtags: ["#aiagents", "#naive", "#startup"],
      cta: "deploy your first company with Naïve today",
      why: "An ad that kept running 44 days with 5 variants is the best public proof it pays; voice-over over graphics is fully rebuildable with our own UI.",
    },
  },
  {
    // @risingpower__: one hand-held shot of a desk IP phone ringing with "Claude" as the caller; a
    // hand answers and a synthetic voice reads a test report through its speaker; one static caption.
    // 769K views on 313 followers. Ours: the same footage, our agent on the phone's display, the report
    // about Mobilerun's real phones. Voice through Naive (the Monid wallet is empty).
    name: "risingpower",
    campaign: MOBILERUN,
    reference: { campaign: MOBILERUN, id: "ref_3c6a101cca" },
    file: "risingpower-original.mp4",
    maxUsd: 3,
    narrator: { id: "fable", name: "Fable", gender: "male" },
    speech: "naive",
    display: { describe: "the desk phone's small backlit display (a Yealink-style IP phone screen), not the computer monitor at the top edge", width: 960, height: 720 },
    voiceEq: PHONE_EQ,
    // Dylan: a phone ringing looks the same for any product; keep its own display, change the voice and caption.
    screens: "keep",
    stats: "769,397 views · 313 followers (769x) · 63,982 likes · 7,036 saves · 14,268 shares · 16.7 s",
    brief: {
      title: "My agent calls me when the phone tests pass",
      role: "reach",
      metric: "shares",
      angle: "The creator's agent phones him from the terminal when its job is done; here the job is testing our app on real phones with Mobilerun.",
      audience: "Developers building AI agents and app teams who test on phones",
      hook_plan: "The same static premise caption over the ringing desk phone, our agent's name on its display, then the agent's calm status report.",
      keep: ["the one hand-held shot of the desk phone, the hand answering, the timing", "the static three-line caption in black on white boxes", "the calm, polite synthetic voice and its sign-off"],
      change: ["the caller on the phone's display is our agent", "the report is about Mobilerun: the checkout test ran on twenty real phones and all twenty passed in thirty-one seconds"],
      platforms: ["tiktok"],
      caption: "my agent calls me when the tests on real phones are done",
      hashtags: ["#aiagents", "#mobilerun", "#devtools"],
      cta: "",
      why: "769x its follower count and 14K shares: a faceless object shot whose own footage stays, with only the phone's display and the voice changed.",
    },
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

/** The narrator as the remake's host: a voice, with no portrait (nobody is on screen). */
function narrator(c: Case): PersonaHandle {
  const persona: Persona = { brand_id: `live-${c.name}`, role: "host", description: `${c.narrator.name}, the voice-over (never on screen)`, gender: c.narrator.gender, voice: { id: c.narrator.id, name: c.narrator.name, gender: c.narrator.gender, source: "default" }, portrait_key: "", cost_micro: 0, created_at: new Date().toISOString() };
  return { persona, portrait: "" };
}

describe.skipIf(!live)("faceless one-to-one remakes (live, paid)", () => {
  for (const c of CASES) {
    it(`remakes ${c.name} faceless`, async () => {
      const data = resolve(process.env.NOMEN_DATA_DIR ?? join(process.cwd(), "data"));
      for (const file of [join(process.cwd(), ".env.local"), join(dirname(data), ".env.local")]) {
        if ((!process.env.NAIVE_API_KEY || !process.env.MONID_API_KEY) && existsSync(file)) process.loadEnvFile(file);
      }
      process.env.NOMEN_BRANDKITS_DIR = join(data, "brandkits");
      const log = (message: string) => console.log(`[faceless ${c.name}] ${message}`);
      const tag = process.env.NOMEN_REMAKE_TAG ?? "v1";
      const out = join(data, "media", "remake-live", "faceless", `${c.name}-${tag}`);
      mkdirSync(out, { recursive: true });

      // Read-only: the product brief, the breakdown (or the pack video to break down), the brand.
      const db = new Database(join(data, "nomen.db"), { readonly: true, fileMustExist: true });
      const read = (id: string) => db.prepare("select brand_id, research_json, style_json from campaigns where id = ?").get(id) as { brand_id: string; research_json: string; style_json: string };
      const campaign = read(c.campaign);
      const source = read(c.reference.campaign);
      db.close();
      const style = JSON.parse(campaign.style_json) as { product: ProductBrief };
      const referencePath = join(data, "media", "references", c.file);
      expect(existsSync(referencePath), `save the reference as ${referencePath}`).toBe(true);
      // Visuals kept under media/ (captures) or brandkits/ are read from this data folder.
      const local = (url: string, key?: string) => (key && existsSync(join(data, "media", key)) ? join(data, "media", key) : url.replace(/^.*\/data\/(brandkits|media)\//, `${data}/$1/`));
      const product: ProductBrief = { ...style.product, visuals: style.product.visuals.map((v) => ({ ...v, url: existsSync(local(v.url, v.key)) ? local(v.url, v.key) : v.url })) };
      const kit = getBrandKit(campaign.brand_id);

      if (mode === "dry") {
        log(`reference ${referencePath}; product ${product.name}; kit ${kit.assets.length} assets; visuals ${product.visuals.filter((v) => existsSync(v.url)).length}/${product.visuals.length} on disk`);
        log(`keys: Naive ${process.env.NAIVE_API_KEY ? "found" : "MISSING"}, Monid ${process.env.MONID_API_KEY ? "found" : "MISSING"}; output ${out}`);
        return;
      }
      expect(process.env.NAIVE_API_KEY, "NAIVE_API_KEY is not set and no .env.local was found").toBeTruthy();
      expect(process.env.MONID_API_KEY, "MONID_API_KEY is not set and no .env.local was found").toBeTruthy();
      // Naive answers "at capacity" in bursts: every call here waits it out, as the remake's own do.
      const naive = patient(new NaiveClient());
      const monid = new MonidClient();

      // The breakdown: from the campaign, or made once from the pack's video (kept as breakdown.json).
      let breakdown: ReferenceBreakdown;
      const breakdownPath = join(out, "breakdown.json");
      if ("id" in c.reference) {
        const ref = c.reference;
        breakdown = (JSON.parse(source.style_json) as { breakdowns: ReferenceBreakdown[] }).breakdowns.find((b) => b.id === ref.id)!;
        expect(breakdown, `${ref.id} is not in ${ref.campaign}`).toBeTruthy();
      } else if (existsSync(breakdownPath)) {
        breakdown = JSON.parse(await readFile(breakdownPath, "utf8")) as ReferenceBreakdown;
      } else {
        const url = c.reference.url;
        const video = (JSON.parse(source.research_json) as { videos: Video[] }).videos.find((v) => v.url === url);
        expect(video, `${url} is not in ${c.reference.campaign}'s research`).toBeTruthy();
        const [candidate] = scoreCandidates([video!], () => "category");
        log(`breaking down ${url} (${referenceId(url)})`);
        breakdown = await breakdownReference(naive, { ...candidate, media_url: referencePath }, { workDir: join(out, "breakdown-work"), brand: { name: product.name, one_liner: product.one_liner, kind: product.kind }, sceneThreshold: 0.12 });
        await writeFile(breakdownPath, JSON.stringify(breakdown, null, 1));
      }
      for (const beat of breakdown.beats) log(`reference beat ${beat.start}-${beat.end}: ${beat.line || "(no words)"}${beat.on_screen_text ? ` | on screen: ${beat.on_screen_text}` : ""}`);

      // Our lines, one per reference beat (cached: edit script.json to change them).
      const span = remakeSpan(breakdown.beats);
      const scriptPath = join(out, "script.json");
      let script: Script;
      if (existsSync(scriptPath)) script = JSON.parse(await readFile(scriptPath, "utf8")) as Script;
      else {
        log("writing our lines (remake mode: the reference's words and labels, our product facts)");
        const brief: CreativeBrief = { ...c.brief, reference_id: breakdown.id, format: "remake", creator: "", setting: "", visuals: [] };
        script = await writeScript(naive, { product, brief, reference: { ...breakdown, beats: span.beats, duration: span.end }, targetSeconds: Math.round(span.end) });
        await writeFile(scriptPath, JSON.stringify(script, null, 1));
      }
      for (const beat of script.beats) log(`beat ${beat.n} (${beat.seconds}s) ${beat.emotion ?? ""} ${beat.line}${beat.on_screen_text ? ` | on screen: ${beat.on_screen_text}` : ""}`);

      try {
        const result = await remakeVideo(
          { naive, monid, files: folderFiles(join(out, "kept")), ...(c.speech === "naive" ? { naiveSpeech: naive } : {}) },
          {
            prefix: `faceless-${c.name}`,
            referencePath,
            breakdown,
            lines: script.beats.map((beat) => ({ line: beat.line, emotion: beat.emotion ?? "", on_screen_text: beat.on_screen_text })),
            host: narrator(c),
            product,
            kit: kit.assets.length || kit.repo ? kit : null,
            maxUsd: Number(process.env.NOMEN_REMAKE_MAX_USD ?? c.maxUsd),
            voice: "fresh",
            display: c.display,
            voiceEq: c.voiceEq,
            screens: c.screens,
            finish: process.env.NOMEN_REMAKE_FINISH !== "0",
            idem: `faceless-live-${c.name}-${tag}`,
            onEvent: log,
          },
        );

        // The clone, its contact sheets, and the reference beside it (always shown together).
        const ffmpeg = (await editFfmpeg())!;
        const final = join(out, `${c.name}-clone.mp4`);
        await copyFile(result.path, final);
        const cols = Math.min(20, Math.ceil(result.duration / 2));
        const every = result.duration / cols;
        const compare = join(out, `${c.name}-compare.jpg`);
        const side = join(out, `${c.name}-side-by-side.mp4`);
        await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-t", String(result.duration), "-i", referencePath, "-i", final, "-filter_complex", `[0:v]fps=1/${every.toFixed(3)},scale=216:384:force_original_aspect_ratio=decrease,pad=216:384:(ow-iw)/2:(oh-ih)/2,tile=${cols}x1[a];[1:v]fps=1/${every.toFixed(3)},scale=216:384,tile=${cols}x1[b];[a][b]vstack`, "-frames:v", "1", compare]);
        await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", referencePath, "-i", final, "-filter_complex", "[0:v]scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[a];[1:v]scale=540:960,setsar=1,fps=30[b];[a][b]hstack,format=yuv420p[v]", "-map", "[v]", "-map", "1:a", "-t", String(result.duration), "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", side]);
        const report = {
          case: c.name,
          reference: { file: referencePath, url: breakdown.url, stats: c.stats },
          clone: final,
          side_by_side: side,
          compare,
          seconds: result.duration,
          segments: result.layout.segments.map((s) => `${s.kind} ${s.start}-${s.end}`),
          estimate_usd: result.estimate.usd,
          spent_usd: { naive: result.spend.naive_micro / 1e6, monid: result.spend.monid_micro / 1e6 },
          notes: result.notes,
        };
        await writeFile(join(out, "report.json"), JSON.stringify(report, null, 1));
        console.log(JSON.stringify(report, null, 1));
        expect(existsSync(final)).toBe(true);
      } catch (error) {
        if (error instanceof OverBudget) log(`over the cap: ${error.message}`);
        throw error;
      }
    }, 90 * 60_000);
  }
});
