import { ApiError } from "../http";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import { isTall } from "./plan";
import type { BeatJob, CreativeBrief, ProductBrief, ReferenceBreakdown, Script, ScriptBeat } from "./types";

// The script room: a writer transplants a proven video's structure onto our product, a linter
// catches what makes scripts sound like AI, and a critic sends weak drafts back. The reference's
// mechanics are kept (beats, timing, hook, rhythm, delivery); its words, people and footage never are.

export const JOBS: BeatJob[] = ["hook", "problem", "agitate", "reveal", "demo", "proof", "objection", "payoff", "cta", "other"];
const PASS = 8;
const MAX_ROUNDS = 2;

/** Phrases that mark a script as AI-written or ad copy. Real creators don't talk like this. */
export const BANNED = [
  "game changer",
  "game-changer",
  "revolutionize",
  "revolutionary",
  "unlock",
  "unleash",
  "elevate",
  "seamless",
  "seamlessly",
  "effortless",
  "effortlessly",
  "say goodbye to",
  "say hello to",
  "introducing",
  "look no further",
  "take it to the next level",
  "next level",
  "supercharge",
  "streamline",
  "empower",
  "harness",
  "leverage",
  "dive in",
  "let's dive",
  "in today's",
  "fast-paced",
  "whether you're",
  "you won't believe",
  "trust me",
  "life-changing",
  "changed my life",
  "must-have",
  "boost your",
  "level up",
  "all-in-one",
  "cutting-edge",
  "state-of-the-art",
  "best-kept secret",
  "the secret to",
  "here's the thing",
  "tired of",
  "imagine a world",
  "without further ado",
  "the best part?",
  "it's that simple",
  "it's that easy",
  "but wait",
  "transform your",
  "journey",
  "delve",
  "robust",
  "innovative",
  "solution",
  "hassle-free",
] as const;

/** Things only a real customer could say; the brand's AI creator must not claim them. */
const TESTIMONIAL = [/\bi'?ve been using\b/i, /\bfor (?:the past |the last )?\d+\s*(?:days|weeks|months|years)\b/i, /\bmy results\b/i, /\bsince i started\b/i, /\bi lost \d/i, /\bi saved \$?\d/i, /\bi made \$?\d/i];

const SCRIPT_TOOL = {
  name: "script",
  description: "Record the script, beat by beat.",
  input_schema: {
    type: "object",
    required: ["beats"],
    properties: {
      beats: {
        type: "array",
        items: {
          type: "object",
          required: ["n", "job", "seconds", "line", "on_screen_text", "visual", "product_visual", "direction"],
          properties: {
            n: { type: "integer" },
            job: { type: "string", enum: JOBS },
            seconds: { type: "number", description: "Planned length, 1-8." },
            line: { type: "string", description: "Exactly what is said out loud. Empty for a silent beat." },
            on_screen_text: { type: "string", description: "Large text on screen (the hook, a label), max 8 words, or empty. Not a caption of the line." },
            visual: { type: "string", enum: ["creator", "product", "split"] },
            product_visual: { type: ["string", "null"], description: "A visual id from the list for product and split beats; null for creator beats." },
            direction: { type: "string", description: "Creator beats: expression and one small action. Product beats: the motion, e.g. 'slow scroll down the pricing page'." },
          },
        },
      },
    },
  },
};

const CRITIC_TOOL = {
  name: "script_review",
  description: "Record the review and, if it falls short, a full revised script.",
  input_schema: {
    type: "object",
    required: ["scores", "score", "notes", "revised_beats"],
    properties: {
      scores: {
        type: "object",
        required: ["sounds_human", "hook", "product_clarity", "fidelity_to_reference", "specificity"],
        properties: {
          sounds_human: { type: "integer", description: "1-10: would a real creator say every line out loud like this?" },
          hook: { type: "integer", description: "1-10: does beat 1 stop the scroll as well as the reference's hook?" },
          product_clarity: { type: "integer", description: "1-10: after watching, does a stranger know what the product is and why they'd want it?" },
          fidelity_to_reference: { type: "integer", description: "1-10: same structure, timing, rhythm and delivery as the reference (with new words)?" },
          specificity: { type: "integer", description: "1-10: concrete details from the brief instead of generic claims?" },
        },
      },
      score: { type: "integer", description: "Overall 1-10. 8+ means ready to film." },
      notes: { type: "array", items: { type: "string" }, description: "The most important problems, worst first. Quote the line." },
      revised_beats: { type: "array", items: SCRIPT_TOOL.input_schema.properties.beats.items, description: "If score < 8: the complete revised script. If 8+: empty." },
    },
  },
};

export type ScriptContext = { product: ProductBrief; brief: CreativeBrief; reference: ReferenceBreakdown; targetSeconds: number };

// ---------- the writer ----------

function writerSystem() {
  return [
    "You write short-form video scripts that sound like a real person talking into their phone. You work by transplanting a proven video onto a new product: the reference's structure, timing, hook mechanic, sentence rhythm and delivery stay; the topic, words and product are ours.",
    "",
    "How to transplant:",
    "- Mirror the reference beat by beat: the same jobs in the same order (hook, problem, demo...), similar seconds per beat, the same hook mechanic, the same kind of sentences (if the reference talks in short fragments, so do you; if it asks a question first, so do you).",
    "- Match its delivery: register, energy, how casual it is. If it uses on-screen text for the hook, write on-screen text too.",
    "- Never reuse more than four words in a row from the reference's lines or on-screen text. New words, same mechanics.",
    "",
    "How real people talk:",
    "- Contractions, fragments, plain words. One idea per sentence. Concrete nouns and numbers from the brief. A little filler is fine where a person would use it (\"okay so\", \"honestly\", \"wait\"), at most once per video.",
    "- Never use ad-copy or AI phrases: game changer, revolutionize, unlock, elevate, seamless, effortless, say goodbye to, introducing, look no further, next level, supercharge, streamline, empower, leverage, dive in, whether you're, you won't believe, trust me, must-have, all-in-one, cutting-edge, the secret to, here's the thing, tired of, imagine, the best part, it's that simple, but wait, transform, journey, innovative, solution.",
    "- No em dashes, no emojis, at most one exclamation mark in the whole script.",
    "- Speak at 2.3-3.0 words per second (a 6 second beat is 14-18 words at most). The hook line is at most 12 words and lands in the first 3 seconds; don't open with the brand name.",
    "",
    "Truth:",
    "- These ads are posted by the brand on its own accounts and labeled AI-generated. The speaker can show, explain and react to the product; they never claim a personal history with it: no \"I've been using it for months\", no personal results, no ratings or reviews.",
    "- Every factual claim, number and price must come from the brief's claims, proof, offer or features. If the brief doesn't say it, don't say it.",
    "",
    "Showing the product:",
    "- Real footage of the product exists only as the listed visuals (ids like p1, s2). Put the product on screen whenever the line is about what it does: at least 40% of the video's seconds must be product or split beats, and the demo or reveal beats must show the visual that matches the words.",
    "- Creator beats are for the hook, the problem and reactions. Their direction is one small, calm action and an expression (a slight smile, a raised eyebrow, a small nod, leaning back). No pointing at the lens, no thumbs up, no fast head turns, no hands near the face.",
    "- Format rules: voiceover_demo and text_story use only product beats (no creator); split_screen uses only split beats; talking_head_broll mixes creator and product beats.",
    "",
    "Call the script tool once with every beat.",
  ].join("\n");
}

function contextBlock(ctx: ScriptContext) {
  const { product, brief, reference } = ctx;
  return [
    `<product_brief>\n${JSON.stringify({ ...product, visuals: undefined })}\n</product_brief>`,
    `<visuals>\n${JSON.stringify(product.visuals.map((v) => ({ id: v.id, kind: v.kind, caption: v.caption, tall_page: isTall(v) || undefined })))}\n</visuals>`,
    `<creative_brief>\n${JSON.stringify(brief)}\n</creative_brief>`,
    `<reference>\n${JSON.stringify({
      url: reference.url,
      stats: { views: reference.views, followers: reference.followers, views_per_follower: reference.outlier },
      duration: reference.duration,
      format: reference.format,
      hook: reference.hook,
      beats: reference.beats,
      pacing: reference.pacing,
      delivery: reference.delivery,
      caption_style: reference.caption_style,
      why_it_works: reference.why_it_works,
    })}\n</reference>`,
    `Target length: about ${ctx.targetSeconds} seconds. Format: ${brief.format}.`,
  ].join("\n\n");
}

export async function writeScript(naive: NaiveClient, ctx: ScriptContext): Promise<Script> {
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 3000,
    system: writerSystem(),
    messages: [{ role: "user", content: `${contextBlock(ctx)}\n\nWrite the script for "${ctx.brief.title}".` }],
    tools: [SCRIPT_TOOL],
  });
  const beats = readBeats(reply, SCRIPT_TOOL.name, "beats");
  if (!beats.length) throw new ApiError("naive", 502, "script_unreadable", "the writer returned no script");
  let script = normalizeScript(beats, ctx);

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const issues = lintScript(script, ctx);
    const review = await critique(naive, ctx, script, issues);
    script.review = { score: review.score, notes: [...issues.map((issue) => `lint: ${issue}`), ...review.notes].slice(0, 10), rounds: round };
    if (review.score >= PASS && issues.length === 0) break;
    if (!review.revised.length) break;
    const revised = normalizeScript(review.revised, ctx);
    revised.review = script.review;
    script = revised;
  }
  return script;
}

async function critique(naive: NaiveClient, ctx: ScriptContext, script: Script, issues: string[]) {
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 3000,
    system: [
      "You are a short-form creative director who has watched ten thousand TikToks. You review scripts before anything is filmed. You are strict: most AI-written scripts sound like ads, and ads get scrolled past.",
      "Read every line out loud in your head. Fail anything a real person wouldn't say, anything generic that could sell any product, a hook weaker than the reference's, product beats whose visual doesn't match the words, and claims not in the product brief.",
      "If the overall score is below 8, write the complete revised script that fixes every problem, following the same rules as the writer (transplant the reference's mechanics with new words, 2.3-3.0 words per second, product on screen for at least 40% of the time, no personal-history claims). Call the script_review tool once.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: `${contextBlock(ctx)}\n\n<script>\n${JSON.stringify(script.beats)}\n</script>\n\nAutomatic checks found: ${issues.length ? issues.join("; ") : "nothing"}.`,
      },
    ],
    tools: [CRITIC_TOOL],
  });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === CRITIC_TOOL.name);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as { score?: unknown; notes?: unknown; revised_beats?: unknown } | null;
  const score = Math.max(1, Math.min(10, Math.round(Number(raw?.score) || 0)));
  const notes = Array.isArray(raw?.notes) ? raw.notes.filter((n): n is string => typeof n === "string").slice(0, 6) : [];
  const revised = Array.isArray(raw?.revised_beats) ? (raw.revised_beats as Array<Partial<ScriptBeat>>) : [];
  return { score, notes, revised };
}

function readBeats(reply: Awaited<ReturnType<NaiveClient["message"]>>, tool: string, field: string): Array<Partial<ScriptBeat>> {
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === tool);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Record<string, unknown> | null;
  const beats = raw?.[field];
  return Array.isArray(beats) ? (beats as Array<Partial<ScriptBeat>>) : [];
}

// ---------- normalizing ----------

const clean = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/[—–]/g, ", ")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.!?])/g, "$1")
        .trim()
    : "";

/** Makes the model's beats renderable: numbered, valid jobs and visuals, 1-8 s, format rules applied. */
export function normalizeScript(beats: Array<Partial<ScriptBeat>>, ctx: ScriptContext): Script {
  const ids = new Set(ctx.product.visuals.map((v) => v.id));
  const fallbackVisual = ctx.brief.visuals.find((id) => ids.has(id)) ?? ctx.product.visuals[0]?.id ?? null;
  const out: ScriptBeat[] = beats.slice(0, 12).map((beat, i) => {
    let visual: ScriptBeat["visual"] = beat.visual === "product" || beat.visual === "split" ? beat.visual : "creator";
    if (ctx.brief.format === "voiceover_demo" || ctx.brief.format === "text_story") visual = "product";
    if (ctx.brief.format === "split_screen") visual = "split";
    let productVisual = typeof beat.product_visual === "string" && ids.has(beat.product_visual) ? beat.product_visual : null;
    if (visual !== "creator" && !productVisual) productVisual = fallbackVisual;
    if (visual !== "creator" && !productVisual) visual = "creator"; // no footage at all: the creator carries it
    const seconds = Math.min(8, Math.max(1, Math.round((Number(beat.seconds) || 3) * 2) / 2));
    return {
      n: i + 1,
      job: JOBS.includes(beat.job as BeatJob) ? (beat.job as BeatJob) : i === 0 ? "hook" : "other",
      seconds,
      line: clean(beat.line),
      on_screen_text: clean(beat.on_screen_text).split(" ").slice(0, 10).join(" "),
      visual,
      product_visual: visual === "creator" ? null : productVisual,
      direction: clean(beat.direction),
    };
  });
  return { beats: out, total_seconds: out.reduce((sum, beat) => sum + beat.seconds, 0), review: null };
}

// ---------- the linter ----------

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}'$%]+/gu, " ").trim().split(/\s+/).filter(Boolean);

function ngrams(text: string, n: number) {
  const list = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= list.length; i++) out.add(list.slice(i, i + n).join(" "));
  return out;
}

/** Everything a machine can check before a person (or a critic) reads it. Empty means clean. */
export function lintScript(script: Script, ctx: ScriptContext): string[] {
  const issues: string[] = [];
  const spoken = script.beats.map((beat) => beat.line).join(" ");
  const allText = `${spoken} ${script.beats.map((b) => b.on_screen_text).join(" ")}`.toLowerCase();

  for (const phrase of BANNED) if (new RegExp(`\\b${phrase.replace(/[-?]/g, (c) => `\\${c}`)}`, "i").test(allText)) issues.push(`AI/ad phrase "${phrase}"`);
  for (const pattern of TESTIMONIAL) if (pattern.test(spoken)) issues.push(`personal-history claim (${pattern.source}): the creator can't claim past use or results`);
  if (/\p{Extended_Pictographic}/u.test(allText)) issues.push("emoji in the script");
  if ((spoken.match(/!/g) ?? []).length > 1) issues.push("more than one exclamation mark");

  // New words: no run of 5+ words lifted from the reference.
  const referenceText = `${ctx.reference.transcript} ${ctx.reference.beats.map((b) => `${b.line} ${b.on_screen_text}`).join(" ")}`;
  const lifted = [...ngrams(allText, 5)].filter((gram) => ngrams(referenceText, 5).has(gram));
  if (lifted.length) issues.push(`copies the reference word for word: "${lifted[0]}"`);

  // Numbers must come from the brief.
  const briefText = JSON.stringify({ claims: ctx.product.claims, proof: ctx.product.proof, offer: ctx.product.offer, features: ctx.product.features, one_liner: ctx.product.one_liner }).toLowerCase().replace(/(\d),(?=\d{3})/g, "$1");
  for (const number of spoken.match(/\$?\d[\d,.]*\s*(?:%|x|k|m)?/gi) ?? []) {
    const digits = number.replace(/[^\d.]/g, "");
    if (digits && !briefText.includes(digits)) issues.push(`the number "${number.trim()}" is not in the product brief`);
  }

  const first = script.beats[0];
  if (first) {
    if (words(first.line).length > 12) issues.push(`hook line is ${words(first.line).length} words (max 12)`);
    if (first.seconds > 3.5) issues.push(`hook beat is ${first.seconds}s (keep it under 3.5s)`);
    const name = ctx.product.name.toLowerCase();
    if (name && words(first.line).slice(0, 3).join(" ").includes(name)) issues.push("the hook opens with the brand name");
  }
  for (const beat of script.beats) {
    const count = words(beat.line).length;
    if (count && count / beat.seconds > 3.4) issues.push(`beat ${beat.n} is too fast: ${count} words in ${beat.seconds}s`);
    if (words(beat.on_screen_text).length > 8) issues.push(`beat ${beat.n} on-screen text is over 8 words`);
  }

  if (ctx.brief.format === "talking_head_broll") {
    const productSeconds = script.beats.filter((b) => b.visual !== "creator").reduce((sum, b) => sum + b.seconds, 0);
    if (ctx.product.visuals.length && productSeconds < script.total_seconds * 0.4) issues.push(`the product is on screen for ${Math.round(productSeconds)}s of ${script.total_seconds}s (needs 40%)`);
  }
  if (Math.abs(script.total_seconds - ctx.targetSeconds) > 4) issues.push(`total ${script.total_seconds}s vs target ${ctx.targetSeconds}s`);
  if (!script.beats.some((b) => b.job === "cta")) issues.push("no call to action beat");
  return issues;
}

/** How long the video should run: the reference's length, kept to 12-30 s. */
export function targetSeconds(reference: Pick<ReferenceBreakdown, "duration">) {
  return Math.round(Math.min(30, Math.max(12, reference.duration || 18)));
}
