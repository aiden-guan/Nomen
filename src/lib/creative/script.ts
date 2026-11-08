import { ApiError } from "../http";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import { isTall } from "./plan";
import type { BeatJob, CreativeBrief, ProductBrief, ReferenceBreakdown, Script, ScriptBeat } from "./types";

// The script room: a writer remakes a proven viral video for our product, as close to it as the truth allows, a linter
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
          hook: { type: "integer", description: "1-10: does beat 1 keep the reference's hook (its words and mechanic) and stop the scroll as well?" },
          product_clarity: { type: "integer", description: "1-10: after watching, does a stranger know what the product is and why they'd want it?" },
          fidelity_to_reference: { type: "integer", description: "1-10: how close is it to the reference: same hook, beats, timing, wording, shots and delivery, changed only where the product requires it?" },
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
    "You remake proven viral short videos for a new product. You are given one reference video that already went viral, broken down beat by beat with its exact transcript, and a product. Your job is to replicate that video as closely as possible so it earns the same retention: same hook, same beats, same lines, same timing, same shots, same on-screen text style and delivery, with an AI creator in place of the original person. Change only what has to change to make it about this product and true.",
    "",
    "How to replicate:",
    "- Keep the reference's beats one for one: the same number of beats, in the same order, with the same jobs and the same seconds per beat (round to 0.5 s).",
    "- If the target length is shorter than the reference, tighten it: keep the hook word for word, the beat order, and the call to action; merge or trim the middle beats (fewer steps in a list, shorter explanations). Never cut the hook.",
    "- Keep the hook word for word where you can. Swap only the parts that are about their product or topic for this product's equivalent. \"POV: you just found the app that does your taxes in 5 minutes\" becomes \"POV: you just found the API that pays for every tool your agent uses\".",
    "- Keep every line's wording, sentence shape, length and slang. Swap their product, their features and their specifics for this product's, using the product brief. If a line is generic (\"wait for it\", \"this is insane\", \"okay so\"), keep it exactly.",
    "- Keep their on-screen text the same way: same wording and style, product details swapped.",
    "- Keep their delivery: energy, pace, pauses, filler words. If they talk fast, you talk fast.",
    "- Keep their visuals: where they show their product, an app screen or a demo, show this product's matching visual. Where they are on camera, the creator is on camera doing the same action with the same expression.",
    "",
    "What never carries over:",
    "- Their claims about themselves or their product. If the reference says \"this saved me $400\" or \"I've used it for 6 months\", that is not true of this product: replace it with a real fact from the product brief that plays the same role (a number, a feature, the price, the free tier). These ads are posted by the brand on its own accounts and labeled AI-generated, so the speaker never claims a personal history with the product, personal results, ratings or reviews.",
    "- Every factual claim, number and price must come from the brief's claims, proof, offer or features. If the brief doesn't say it, don't say it.",
    "- Their brand names, handles, people's names and other brands' trademarks.",
    "",
    "Sounding human:",
    "- If the reference doesn't use them, avoid ad-copy and AI phrases: game changer, revolutionize, unlock, elevate, seamless, effortless, say goodbye to, introducing, look no further, next level, supercharge, streamline, empower, leverage, dive in, whether you're, must-have, all-in-one, cutting-edge, transform, journey, innovative, solution. No em dashes, no emojis.",
    "",
    "Showing the product:",
    "- Real footage of the product exists only as the listed visuals (ids like p1, s2). Every beat where the reference cuts away to a product, a screen or a demo shows this product's best-matching visual. If the reference never cuts away, still show the product on the beat that names what it does.",
    "- Creator beats: the reference's action and expression, kept small and calm (video models distort big gestures): no pointing at the lens, no thumbs up, no fast head turns, no hands near the face.",
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
    max_tokens: 8000,
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
    if (review.score === null) {
      // No usable review: keep the draft and say so honestly rather than inventing a score.
      script.review = { score: 0, notes: [...issues.map((issue) => `lint: ${issue}`), "critic unavailable: no review came back"].slice(0, 10), rounds: round };
      break;
    }
    script.review = { score: review.score, notes: [...issues.map((issue) => `lint: ${issue}`), ...review.notes].slice(0, 10), rounds: round };
    if (review.score >= PASS && issues.length === 0) break;
    if (!review.revised.length) break;
    const revised = normalizeScript(review.revised, ctx);
    revised.review = script.review;
    script = revised;
  }
  return script;
}

async function critique(naive: NaiveClient, ctx: ScriptContext, script: Script, issues: string[]): Promise<{ score: number | null; notes: string[]; revised: Array<Partial<ScriptBeat>> }> {
  const system = [
    "You are a short-form creative director who has watched ten thousand TikToks. You check remakes of viral videos before anything is filmed. The goal is a remake so close to the reference that it earns the same retention, adapted to a new product.",
    "Compare the script to the reference beat by beat. Fail: beats that drift from the reference (different order, timing, jobs or shots), a hook that changed more than it had to, lines rewritten into different words when the reference's wording could have stayed, anything that sounds like an ad instead of the reference's voice, product beats whose visual doesn't match the words, claims or numbers not in the product brief, any personal-history claim (past use, personal results, reviews) carried over from the reference, and lines too long to say in their beat's seconds.",
    "If the overall score is below 8, write the complete revised script that fixes every problem, following the same rules as the writer (replicate the reference as closely as possible, swap only what must change for this product, keep every claim true to the brief, fit each line in its seconds).",
  ].join("\n");
  const content = `${contextBlock(ctx)}\n\n<script>\n${JSON.stringify(script.beats)}\n</script>\n\nAutomatic checks found: ${issues.length ? issues.join("; ") : "nothing"}.`;
  const ask = (extra: string, tools?: object[]) => naive.message({ model: QC_MODEL, max_tokens: 10000, system: `${system}\n${extra}`, messages: [{ role: "user", content }], tools });

  type Review = { score?: unknown; scores?: unknown; notes?: unknown; revised_beats?: unknown } | null;
  const reply = await ask("Call the script_review tool once.", [CRITIC_TOOL]);
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === CRITIC_TOOL.name);
  let raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Review;
  if (!raw || (raw.score === undefined && raw.scores === undefined)) {
    // A cut-off or fumbled tool call: ask once more for plain JSON.
    const again = await ask('Answer with only a JSON object: {"score": 1-10, "notes": ["..."], "revised_beats": [ ...the full revised script if score < 8, else empty ]}');
    raw = extractJson(again.content.map((block) => block.text ?? "").join("\n")) as Review;
  }
  const subScores = raw?.scores && typeof raw.scores === "object" ? Object.values(raw.scores as Record<string, unknown>).map(Number).filter((n) => n >= 1 && n <= 10) : [];
  const direct = Number(raw?.score);
  const score = direct >= 1 && direct <= 10 ? Math.round(direct) : subScores.length ? Math.round(Math.min(...subScores)) : null;
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

/** Everything a machine can check before a person (or a critic) reads it. Empty means clean. */
export function lintScript(script: Script, ctx: ScriptContext): string[] {
  const issues: string[] = [];
  const spoken = script.beats.map((beat) => beat.line).join(" ");
  const allText = `${spoken} ${script.beats.map((b) => b.on_screen_text).join(" ")}`.toLowerCase();
  const reference = ctx.reference;
  const referenceText = `${reference.transcript} ${reference.beats.map((b) => `${b.line} ${b.on_screen_text}`).join(" ")}`.toLowerCase();
  const has = (text: string, phrase: string) => new RegExp(`\\b${phrase.replace(/[-?]/g, (c) => `\\${c}`)}`, "i").test(text);

  // Ad-copy phrases are out, unless the viral reference itself says them (then they're its voice).
  for (const phrase of BANNED) if (has(allText, phrase) && !has(referenceText, phrase)) issues.push(`AI/ad phrase "${phrase}" (not in the reference)`);
  for (const pattern of TESTIMONIAL) if (pattern.test(spoken)) issues.push(`personal-history claim (${pattern.source}): replace it with a fact from the product brief`);
  if (/\p{Extended_Pictographic}/u.test(allText)) issues.push("emoji in the script");

  // Numbers must come from the brief: a number carried over from the reference is their claim, not ours.
  const briefText = JSON.stringify({ claims: ctx.product.claims, proof: ctx.product.proof, offer: ctx.product.offer, features: ctx.product.features, one_liner: ctx.product.one_liner }).toLowerCase().replace(/(\d),(?=\d{3})/g, "$1");
  for (const number of spoken.match(/\$?\d[\d,.]*\s*(?:%|x|k|m)?/gi) ?? []) {
    const digits = number.replace(/[^\d.]/g, "");
    if (digits && !briefText.includes(digits)) issues.push(`the number "${number.trim()}" is not in the product brief`);
  }

  // Their names and handles never carry over.
  const theirs = [reference.author, ...[...referenceText.matchAll(/@([\w.]{3,30})/g)].map((m) => m[1])].filter((name) => name && name.length > 2 && !ctx.product.name.toLowerCase().includes(name.toLowerCase()));
  for (const name of theirs) if (has(allText, name.toLowerCase())) issues.push(`mentions the reference's handle or name "${name}"`);

  // Replication: same beats, same timing.
  if (reference.beats.length) {
    // A remake shortened for cost may merge middle beats, but never add any.
    const shortened = reference.duration > ctx.targetSeconds + 4;
    const drift = shortened ? script.beats.length > reference.beats.length + 1 || script.beats.length < 3 : Math.abs(script.beats.length - reference.beats.length) > 1;
    if (drift) issues.push(`${script.beats.length} beats vs the reference's ${reference.beats.length}: keep its beats one for one${shortened ? " (merging middle beats is fine when shortening)" : ""}`);
    const refHook = reference.beats[0];
    const hook = script.beats[0];
    if (refHook && hook && Math.abs(hook.seconds - (refHook.end - refHook.start)) > 1.5) issues.push(`hook beat is ${hook.seconds}s vs the reference's ${(refHook.end - refHook.start).toFixed(1)}s`);
  }

  // Pace: as fast as the reference, not faster than a person can say it.
  const referenceWps = reference.pacing.words_per_minute ? reference.pacing.words_per_minute / 60 : 2.8;
  const maxWps = Math.max(3.4, referenceWps * 1.15);
  for (const beat of script.beats) {
    const count = words(beat.line).length;
    if (count && count / beat.seconds > maxWps) issues.push(`beat ${beat.n} is too fast: ${count} words in ${beat.seconds}s`);
    if (words(beat.on_screen_text).length > 12) issues.push(`beat ${beat.n} on-screen text is over 12 words`);
  }

  // The product has to appear: on every beat where the reference cut away, and at least once.
  if (ctx.product.visuals.length && ctx.brief.format === "talking_head_broll") {
    if (!script.beats.some((b) => b.visual !== "creator")) issues.push("the product is never on screen");
    const cutaways = reference.beats.filter((b) => b.shot !== "talking_head" && b.shot !== "reaction").length;
    const ours = script.beats.filter((b) => b.visual !== "creator").length;
    if (cutaways > ours + 1) issues.push(`the reference cuts away ${cutaways} times, this script shows the product ${ours} times`);
  }
  if (Math.abs(script.total_seconds - ctx.targetSeconds) > 4) issues.push(`total ${script.total_seconds}s vs the reference's ${ctx.targetSeconds}s`);
  return issues;
}

/**
 * How long the remake should run: the reference's own length, capped for render cost. A face costs
 * about $0.40 per second to render, so remakes with a presenter stop at 24 s; faceless ones at 40 s.
 */
export function targetSeconds(reference: Pick<ReferenceBreakdown, "duration">, format: CreativeBrief["format"] = "voiceover_demo") {
  const cap = format === "talking_head_broll" || format === "split_screen" ? 24 : 40;
  return Math.round(Math.min(cap, Math.max(8, reference.duration || 18)));
}
