// The code-ad writer: the model writes the story and its shots (beats, gags, wall screens, callouts) from the creative
// brief, the product brief and a viral reference in any niche, then a critic scores it and rewrites it once if it falls
// short. Code checks keep it renderable (only gags and screens the engine knows, anchors that are really said) and true
// (claims and numbers from the brief only). ED Studio's build-genre formula (docs/BUILD.md there), cut to ad length.

import { ApiError } from "../http";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import { BANNED } from "../creative/script";
import type { BeatJob, CreativeBrief, ProductBrief, ReferenceBreakdown, Script, ScriptBeat } from "../creative/types";
import { norm, untag } from "./layout";
import { CALLOUT_STYLES, type CalloutStyle, type CodeAdBeat, type CodeAdStory, GAGS, type Gag, SCREEN_KINDS, type ScreenKind } from "./types";

/** Words per second the narrator comes out at: Adam on eleven_v3 reads ~2.1/s, sped up at most 1.3x (the Naïve sample: 85 words ran 29.5 s). */
export const WPS = 2.75;
const PASS = 8;

export type CodeAdContext = { product: ProductBrief; brief: CreativeBrief; reference: ReferenceBreakdown; targetSeconds: number; site?: string };

const GAG_MENU: Record<Gag, string> = {
  hack: "Gary types furiously at his laptop; the wall screen types the beat's terminal or chat lines. Setups: the naive way of doing the job.",
  explode: "the laptop blows up on the hit word (smoke, sparks, debris); Gary is blasted, charred, X eyes, hat off. A crash, a broken build, a bad deploy.",
  bury: "an avalanche of cardboard boxes printed with `labels` (TABS, API KEYS, INVOICES) buries Gary to the nose; spiral eyes, dizzy stars. Too much work, too many tools.",
  zap: "Gary touches the power strip: x-ray flicker, sparks, hair stands up. An integration that bites, a key that leaks.",
  money: "banknotes pour out of the wall screen and fly away while Gary grabs at them screaming; what the money bought (`labels`, 1-3: YACHT, ADS) arrives in printed boxes beside him. Costs, a surprise bill, spending gone wrong.",
  deliver: "the brand's crate (its colour and logo) drops in front of the desk and bursts open; the brand's little agent robot hops out with `labels[0]` on its sign. The product's entrance: use it on the beat that says 'So you use <product>'.",
  team: "more agent robots pop in, one per label in `labels` (2-5 short roles: EMAIL, VIDEO, ADS), and get to work around the office. Several agents, scale, parallel work.",
  approve: "a big button pops up on the desk; Gary slams it on the hit. labels[0] is the button: APPROVE (green) or DENY (red). Approvals, permissions, budgets, guardrails.",
  show: "the camera pushes in on the wall screen showing a real product visual (screen kind image) or the logo; Gary presents it like a weatherman. 'This is what it looks like.'",
  celebrate: "confetti, Gary jumps with his arms up, the robots spin. The payoff.",
  idle: "Gary just reacts. Use rarely: every beat should show something happening.",
};

const SCREEN_MENU: Record<ScreenKind, string> = {
  terminal: "commands typed at a prompt; lines starting with '> ' are the machine's answers. Up to 4 lines, at most 26 characters each.",
  chat: "lines[0] is the message you send, the next lines are the agent's replies. Up to 3 lines, at most 48 characters each.",
  image: "a real product visual: set visual_id to an id from <visuals>.",
  logo: "the brand card: logo, name and url.",
  error: "a red failure card: lines[0] is the title (2-3 words), lines[1] one short detail. Explode and zap beats switch to it on the hit by themselves.",
  dashboard: "a list of agents working, one per line (at most 22 characters each), with progress bars.",
  none: "keep whatever the screen showed before.",
};

const TOOL = {
  name: "code_ad",
  description: "Record the code ad, beat by beat.",
  input_schema: {
    type: "object",
    required: ["concept", "nameplate", "poster", "url", "beats"],
    properties: {
      concept: {
        type: "object",
        required: ["reference_id", "premise", "mechanic", "adaptation"],
        properties: {
          reference_id: { type: "string" },
          premise: { type: "string", description: "The reference's viral concept in one line, whatever its niche." },
          mechanic: { type: "string", description: "Its hook mechanic and escalation, as a reusable pattern." },
          adaptation: { type: "string", description: "How this ad carries that concept for the product, in one or two sentences." },
        },
      },
      nameplate: { type: "string", description: "Gary's nameplate on the desk, 2-4 words in caps, e.g. 'GARY · FOUNDER' or 'GARY · SOLO DEV'." },
      poster: { type: "string", description: "The poster on the office wall: the brand's own tagline, verbatim from the brief's claims, at most 7 words." },
      url: { type: "string", description: "The site the viewer goes to, as said and shown at the end, e.g. 'usenaive.ai'." },
      beats: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "say", "gag", "hit", "labels", "screen", "callouts"],
          properties: {
            id: { type: "string", description: "A short slug: hook, fail, fix, approvals, end." },
            say: { type: "string", description: "Exactly what the narrator says. At most one audio tag ([shouting], [excited], [whispers], [sarcastic]) at the start of a payoff line, with one CAPS word." },
            gag: { type: "string", enum: [...GAGS] },
            hit: { type: "string", description: "The word of `say` the gag lands on, spelled as in the line." },
            labels: { type: "array", items: { type: "string" }, description: "See the gag menu: box labels (bury), what the money bought (money), agent roles (deliver, team), the button (approve). Caps, 1-2 words each. Empty otherwise." },
            screen: {
              type: "object",
              required: ["kind"],
              properties: {
                kind: { type: "string", enum: [...SCREEN_KINDS] },
                lines: { type: "array", items: { type: "string" } },
                visual_id: { type: "string" },
                title: { type: "string" },
              },
            },
            callouts: {
              type: "array",
              items: {
                type: "object",
                required: ["at", "text", "style"],
                properties: {
                  at: { type: "string", description: "A word of `say`, spelled as in the line: the callout pops on it." },
                  text: { type: "string", description: "Caps. term/stamp: 1-3 words; label/money: up to 4 words; sfx: one comic word (BOOM, ZAP)." },
                  style: { type: "string", enum: [...CALLOUT_STYLES] },
                  until: { type: "string", description: "Optional: a later word of the line it stays up until." },
                },
              },
            },
          },
        },
      },
    },
  },
};

function writerSystem(target: number) {
  const words = Math.round(target * WPS);
  return [
    "You write code ads: 15-30 second vertical ads made entirely in code (3D animation rendered by a browser, no camera, no AI video), in the style of a viral 3D explainer series. A fast, funny narrator talks to the viewer as 'you' and tells a tiny story. On screen, Gary the Builder, a big-headed cartoon developer in a yellow hard hat, acts it out at his standing desk in a 3D office with a big wall screen behind him and his laptop in front of him. One spoken word at a time sits in the middle of the frame, and short callouts pop in: a yellow TERM for each of the product's feature names, orange labels for facts, green money, red stamps.",
    "",
    "The concept comes from the viral reference video below, which can be in any niche (an engineering explainer, a money story, a life hack, a simulation). Take its premise, its hook mechanic and its escalation, and carry them into this product's world: Gary does the job the naive way, it fails in a big, physical, funny way that hurts him, and the product is the fix. Never reuse the reference's words, jokes, people or claims.",
    "",
    "The formula (the build genre, cut to ad length):",
    "1. Hook, beat 1, spoken over action from the first frame: the dumbest possible version of the job, second person, one breath. 'You give an AI agent your credit card and one instruction: make money.'",
    "2. The failure, 1-2 beats: it goes wrong physically and Gary pays for it (explode, bury, zap, money), with a one-line roast.",
    "3. The fix, 2-3 beats: 'So you use <product>.' The product arrives (deliver), then one feature per beat: its real name from the brief as a term callout, one plain sentence on what it does, a quick joke. Show it (approve, team, show, hack).",
    "4. The payoff and the ask, the last beat: a callback to the hook, then one concrete step with the url, e.g. 'Pick a template at usenaive.ai.' Put the url in a label callout on its word (or on the last word).",
    `Length: about ${target} seconds, so ${words - 8}-${words + 6} words in all, in 5-8 beats of 5-18 words each. Every beat changes what is on screen.`,
    "",
    "Gags (what happens on screen; each beat has exactly one, landing on its hit word):",
    ...GAGS.map((g) => `- ${g}: ${GAG_MENU[g]}`),
    "Use each failure gag at most once, deliver exactly once, and end on celebrate (or show). Never the same gag twice in a row.",
    "",
    "The wall screen (what the computer shows, readable on a phone: few, short lines):",
    ...SCREEN_KINDS.map((k) => `- ${k}: ${SCREEN_MENU[k]}`),
    "Prefer real product visuals (image) on the beats that name a feature, when <visuals> has one that shows it. Use the product's real commands and UI words from the brief.",
    "",
    "Callouts: 1-2 per beat, never more than 3. A term on every feature beat (the feature's real name). `at` and `until` must be words of `say` exactly as spoken. Show what the callouts name: a thing the line jokes about is on screen (as a box label, a robot's role, a wall screen).",
    "",
    "Truth: every claim about the product, and every number, price or name of a feature, comes from the product brief (claims, features, proof, offer, code). Gary's failures may exaggerate, but give them no numbers. No personal history ('I've used it for months'), no results nobody measured, no competitors' names, no real people. Nothing crude.",
    "",
    "The narrator: punchy, deadpan, fast. Short sentences. Contrast is the joke: calm setups, then a payoff line yelled with an audio tag ([shouting] or [excited]) and one CAPS word, on 1-2 beats only. No ad-copy words (game changer, revolutionize, unlock, elevate, seamless, effortless, supercharge, streamline, leverage, all-in-one, cutting-edge, solution), no em dashes, no emojis.",
    "",
    "Call the code_ad tool once.",
  ].join("\n");
}

function contextBlock(ctx: CodeAdContext) {
  const { product, brief, reference } = ctx;
  return [
    `<product_brief>\n${JSON.stringify({ ...product, visuals: undefined })}\n</product_brief>`,
    `<visuals>\n${JSON.stringify(product.visuals.filter((v) => v.kind !== "video").map((v) => ({ id: v.id, kind: v.kind, caption: v.caption })))}\n</visuals>`,
    `<creative_brief>\n${JSON.stringify(brief)}\n</creative_brief>`,
    `<reference>\n${JSON.stringify({
      id: reference.id,
      url: reference.url,
      stats: { views: reference.views, followers: reference.followers, views_per_follower: reference.outlier },
      seconds: reference.duration,
      format: reference.format,
      hook: reference.hook,
      beats: reference.beats.map((b) => ({ t: `${b.start.toFixed(1)}-${b.end.toFixed(1)}s`, job: b.job, visual: b.visual, text: b.on_screen_text, line: b.line })),
      pacing: reference.pacing,
      why_it_works: reference.why_it_works,
    })}\n</reference>`,
    `The site: ${ctx.site || "(not given: use the product's name and 'link in bio')"}. Target length: about ${ctx.targetSeconds} seconds. Role: ${brief.role ?? "reach"} (judged on ${(brief.metric ?? "views").replace(/_/g, " ")}).${brief.role === "convert" ? ` End on this call to action: ${brief.cta || "the brief's offer"}.` : " Keep the ask soft and short."}`,
  ].join("\n\n");
}

// ---------- normalizing: only what the engine can render, anchors that are really said ----------

const clean = (value: unknown, max = 400) =>
  typeof value === "string"
    ? value
        .replace(/[—–]/g, ", ")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.!?])/g, "$1")
        .trim()
        .slice(0, max)
    : "";
const TAGS = /\[(shouting|excited|whispers|sarcastic|sighs|laughs)\]/gi;
const slug = (s: string, i: number) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) || `b${i + 1}`;

/** The words of a line as said (tags dropped), normalized for anchoring. */
const spoken = (say: string) => untag(say).split(/\s+/).map(norm).filter(Boolean);
/** A word of the line as it is spoken (edge punctuation dropped): what anchors store, so a reader sees real words. */
const said = (say: string, want: string) => untag(say).split(/\s+/).find((w) => norm(w) === norm(want))?.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "") ?? "";

function pickHit(say: string, hit: unknown): string {
  const words = spoken(say);
  const want = norm(String(hit ?? ""));
  if (want && words.includes(want)) return said(say, want);
  // the last word of 4+ letters, else the last word
  return said(say, [...words].reverse().find((w) => w.length >= 4) ?? words[words.length - 1] ?? "");
}

/** Makes the model's story renderable and safe: valid gags and screens, anchors that are said, at most one tag per line. */
export function normalizeStory(raw: unknown, ctx: CodeAdContext): CodeAdStory {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const visuals = new Set(ctx.product.visuals.filter((v) => v.kind !== "video").map((v) => v.id));
  const ids = new Set<string>();
  const list = Array.isArray(r.beats) ? (r.beats as Array<Record<string, unknown>>) : [];
  const beats: CodeAdBeat[] = list.slice(0, 9).map((b, i) => {
    let say = clean(b.say, 220);
    // one audio tag at most, at the start of the line
    const tags = say.match(TAGS) ?? [];
    say = `${tags[0] ? `${tags[0].toLowerCase()} ` : ""}${say.replace(TAGS, " ").replace(/\s{2,}/g, " ").trim()}`.trim();
    const gag: Gag = GAGS.includes(b.gag as Gag) ? (b.gag as Gag) : "idle";
    let id = slug(clean(b.id) || `b${i + 1}`, i);
    while (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const words = new Set(spoken(say));
    const s = (b.screen && typeof b.screen === "object" ? b.screen : {}) as Record<string, unknown>;
    let kind: ScreenKind = SCREEN_KINDS.includes(s.kind as ScreenKind) ? (s.kind as ScreenKind) : "none";
    const visualId = typeof s.visual_id === "string" && visuals.has(s.visual_id) ? s.visual_id : undefined;
    if (kind === "image" && !visualId) kind = "logo";
    const maxChars = kind === "terminal" ? 30 : kind === "chat" ? 56 : kind === "dashboard" ? 24 : 36;
    const lines = (Array.isArray(s.lines) ? s.lines : []).map((l) => clean(l, maxChars)).filter(Boolean).slice(0, kind === "chat" ? 3 : 4);
    const callouts = (Array.isArray(b.callouts) ? (b.callouts as Array<Record<string, unknown>>) : [])
      .map((c) => ({ at: said(say, String(c.at ?? "")), text: clean(c.text, 26).toUpperCase(), style: (CALLOUT_STYLES.includes(c.style as CalloutStyle) ? c.style : "label") as CalloutStyle, ...(typeof c.until === "string" && words.has(norm(c.until)) ? { until: said(say, c.until) } : {}) }))
      .filter((c) => c.text && c.at && words.has(norm(c.at)))
      .slice(0, 3);
    return {
      id,
      say,
      gag,
      hit: pickHit(say, b.hit),
      labels: (Array.isArray(b.labels) ? b.labels : []).map((l) => clean(l, 14).toUpperCase()).filter(Boolean).slice(0, 5),
      screen: { kind, ...(lines.length ? { lines } : {}), ...(kind === "image" ? { visual_id: visualId } : {}), ...(typeof s.title === "string" && s.title.trim() ? { title: clean(s.title, 24) } : {}) },
      callouts,
    };
  }).filter((b) => untag(b.say));
  // the ending names the site on screen: a label on the word that says it, else on the last word
  const url = (clean(r.url, 60) || ctx.site || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const last = beats[beats.length - 1];
  if (last && url && !last.callouts.some((c) => c.text.toLowerCase().includes(url.toLowerCase().split(".")[0]))) {
    const words = spoken(last.say);
    const at = words.find((w) => url.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(w) && w.length >= 3) ?? words[words.length - 1];
    if (at) last.callouts = [...last.callouts.filter((c) => c.style !== "label").slice(0, 2), { at: said(last.say, at), text: url.toUpperCase(), style: "label" }];
  }
  return {
    concept: {
      reference_id: ctx.reference.id,
      premise: clean((r.concept as Record<string, unknown> | undefined)?.premise),
      mechanic: clean((r.concept as Record<string, unknown> | undefined)?.mechanic),
      adaptation: clean((r.concept as Record<string, unknown> | undefined)?.adaptation),
    },
    beats,
    nameplate: clean(r.nameplate, 22).toUpperCase() || "GARY · FOUNDER",
    poster: clean(r.poster, 60) || ctx.product.claims[0] || ctx.product.one_liner,
    url,
  };
}

// ---------- the linter ----------

/** Everything code can check before the critic reads it. Empty means clean. */
export function lintStory(story: CodeAdStory, ctx: CodeAdContext): string[] {
  const issues: string[] = [];
  const all = story.beats.map((b) => untag(b.say)).join(" ");
  const count = all.split(/\s+/).filter(Boolean).length;
  const want = ctx.targetSeconds * WPS;
  if (story.beats.length < 4 || story.beats.length > 9) issues.push(`${story.beats.length} beats: write 5-8`);
  if (count > want * 1.25) issues.push(`${count} words is too long for ${ctx.targetSeconds} s (about ${Math.round(want)})`);
  if (count < want * 0.6) issues.push(`${count} words is too short for ${ctx.targetSeconds} s (about ${Math.round(want)})`);
  const text = `${all} ${story.beats.flatMap((b) => [...b.callouts.map((c) => c.text), ...(b.screen.lines ?? [])]).join(" ")}`.toLowerCase();
  const has = (phrase: string) => new RegExp(`\\b${phrase.replace(/[-?]/g, (c) => `\\${c}`)}`, "i").test(text);
  for (const phrase of BANNED) if (has(phrase)) issues.push(`ad phrase "${phrase}"`);
  // numbers only from the brief (the failures carry none)
  const briefText = JSON.stringify({ claims: ctx.product.claims, proof: ctx.product.proof, offer: ctx.product.offer, features: ctx.product.features, code: ctx.product.code, one_liner: ctx.product.one_liner }).toLowerCase().replace(/(\d),(?=\d{3})/g, "$1");
  for (const number of text.match(/\$?\d[\d,.]*\s*(?:%|x|k|m)?/gi) ?? []) {
    const digits = number.replace(/[^\d.]/g, "").replace(/\.$/, "");
    // the same number, not just its digits inside a longer one ("5" is in "2025")
    if (digits && !new RegExp(`(?<![\\d.])${digits.replace(".", "\\.")}(?![\\d])`).test(briefText)) issues.push(`the number "${number.trim()}" is not in the product brief`);
  }
  if (/\bi'?ve been using\b|\bmy results\b|\bsince i started\b/i.test(all)) issues.push("a personal-history claim");
  const name = norm(ctx.product.name).slice(0, 5);
  if (name && !norm(all).includes(name)) issues.push(`the narration never names ${ctx.product.name}`);
  if (!story.beats.some((b) => b.gag === "deliver")) issues.push("the product never arrives (no deliver beat)");
  if (!story.beats.some((b) => b.callouts.some((c) => c.style === "term"))) issues.push("no term callout names a feature");
  for (const [i, b] of story.beats.entries()) {
    const n = untag(b.say).split(/\s+/).filter(Boolean).length;
    if (n > 20) issues.push(`beat ${i + 1} is ${n} words: split it`);
    if (i > 0 && b.gag === story.beats[i - 1].gag) issues.push(`beats ${i} and ${i + 1} play the same gag (${b.gag})`);
  }
  const tagged = story.beats.filter((b) => /\[(shouting|excited)\]/i.test(b.say)).length;
  if (tagged > 3) issues.push(`${tagged} yelled lines: keep it to 1-2`);
  if (ctx.brief.role === "convert" && story.url && !text.includes(story.url.toLowerCase().split(".")[0])) issues.push("a convert ad must end on the site");
  return issues;
}

// ---------- the Script the rest of Nomen reads ----------

const JOB: Record<Gag, BeatJob> = { hack: "problem", explode: "agitate", bury: "agitate", zap: "agitate", money: "agitate", deliver: "reveal", team: "demo", approve: "demo", show: "demo", celebrate: "payoff", idle: "other" };

/** The story as a Script (the camp shows its lines; captions and QC read them), carrying the story itself. */
export function storyScript(story: CodeAdStory, review: Script["review"] = null): Script {
  const beats: ScriptBeat[] = story.beats.map((b, i) => {
    const line = untag(b.say);
    const tag = b.say.match(/^\[([a-z]+)\]/i)?.[1];
    return {
      n: i + 1,
      job: i === 0 ? "hook" : i === story.beats.length - 1 ? "cta" : JOB[b.gag],
      seconds: Math.max(1, Math.round((line.split(/\s+/).filter(Boolean).length / WPS) * 2) / 2),
      line,
      on_screen_text: b.callouts.map((c) => c.text).join(" · ").slice(0, 60),
      visual: "product",
      product_visual: b.screen.kind === "image" ? (b.screen.visual_id ?? null) : null,
      direction: `${b.gag}: ${GAG_MENU[b.gag].split(";")[0]}`,
      ...(tag ? { emotion: `[${tag.toLowerCase()}]` } : {}),
    };
  });
  return { beats, total_seconds: Math.round(beats.reduce((s, b) => s + b.seconds, 0) * 10) / 10, review, code_ad: story };
}

// ---------- writer + critic ----------

function readTool(reply: Awaited<ReturnType<NaiveClient["message"]>>, name: string): Record<string, unknown> | null {
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === name);
  return (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Record<string, unknown> | null;
}

const CRITIC_TOOL = {
  name: "code_ad_review",
  description: "Record the review and, if it falls short, the complete revised code ad.",
  input_schema: {
    type: "object",
    required: ["score", "notes", "revised"],
    properties: {
      score: { type: "integer", description: "1-10 overall. 8+ means ready to render." },
      notes: { type: "array", items: { type: "string" }, description: "The most important problems, worst first. Quote the line." },
      revised: { ...TOOL.input_schema, description: "If score < 8: the complete revised code ad (same schema as the writer's). If 8+: an empty object." },
    },
  },
};

/** Writes the code ad: a draft, the code checks, then one critic pass that rewrites it when it scores under 8. */
export async function writeCodeAd(naive: NaiveClient, ctx: CodeAdContext): Promise<{ story: CodeAdStory; script: Script }> {
  const user = `${contextBlock(ctx)}\n\nWrite the code ad for "${ctx.brief.title}".`;
  const reply = await naive.message({ model: QC_MODEL, max_tokens: 6000, system: writerSystem(ctx.targetSeconds), messages: [{ role: "user", content: user }], tools: [TOOL] });
  let story = normalizeStory(readTool(reply, TOOL.name), ctx);
  if (story.beats.length < 3) throw new ApiError("naive", 502, "code_ad_unreadable", "the code-ad writer returned no usable beats");

  const issues = lintStory(story, ctx);
  const system = [
    "You are the creative director of a viral 3D explainer channel that now makes 15-30 second ads for developer tools. You check a code ad's script before it is animated.",
    "Score it on: the hook (would it stop the scroll in the first second?), comedy (big physical failures that hurt Gary, a roast, a callback), clarity (after one watch, does a stranger know what the product does and why they'd want it?), truth (every product claim and number is in the brief), the concept (it carries the reference's premise and hook mechanic without its words), pacing (every beat shows something new; the right length) and the ending (a payoff, then one clear step with the url).",
    "Also check it renders: one gag per beat from the menu, hit words and callout anchors that are words of the line, short screen lines, at most 1-2 yelled lines.",
    `If the score is below ${PASS}, write the complete revised code ad that fixes every problem, by the writer's rules:\n\n${writerSystem(ctx.targetSeconds)}`,
  ].join("\n");
  const content = `${contextBlock(ctx)}\n\n<code_ad>\n${JSON.stringify(story)}\n</code_ad>\n\nAutomatic checks found: ${issues.length ? issues.join("; ") : "nothing"}.\n\nCall the code_ad_review tool once.`;
  let review: Script["review"] = { score: 0, notes: [...issues.map((i) => `lint: ${i}`), "critic unavailable"].slice(0, 10), rounds: 1 };
  try {
    const answer = await naive.message({ model: QC_MODEL, max_tokens: 9000, system, messages: [{ role: "user", content }], tools: [CRITIC_TOOL] });
    const raw = readTool(answer, CRITIC_TOOL.name);
    const score = Number(raw?.score);
    const notes = Array.isArray(raw?.notes) ? (raw.notes as unknown[]).filter((n): n is string => typeof n === "string").slice(0, 6) : [];
    if (score >= 1 && score <= 10) {
      review = { score: Math.round(score), notes: [...issues.map((i) => `lint: ${i}`), ...notes].slice(0, 10), rounds: 1 };
      const revised = raw?.revised && typeof raw.revised === "object" ? normalizeStory(raw.revised, ctx) : null;
      if (score < PASS && revised && revised.beats.length >= 3) {
        story = revised;
        const left = lintStory(story, ctx);
        review = { score: Math.round(score), notes: [...left.map((i) => `lint (after the rewrite): ${i}`), ...notes].slice(0, 10), rounds: 2 };
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.outOfCredits) throw error;
    // no review: keep the draft and say so honestly
  }
  return { story, script: storyScript(story, review) };
}
