import type { NaiveClient } from "../naive";
import { type Concept, conceptFrom } from "../strategy";
import { type Formula, formulaDigest } from "./formulas";
import { isTall, planProduction, presenterShot } from "./plan";
import { ASK, BANNED, CRITIC_TOOL, normalizeScript, runScriptRoom, TESTIMONIAL } from "./script";
import type { BeatJob, CreativeBrief, ProductBrief, ProductionPlan, ReferenceBreakdown, Script } from "./types";

// Organic videos: original scripts written in one of the campaign's winning formulas (formulas.ts),
// shaped for what AI video does well. One persona talks to a propped-up camera in short takes,
// one sentence each, always from the same still, with a jump cut and a punch-in between takes;
// every claim about the product is shown on its real screens. The one-to-one remakes are untouched.

// ---------- the persona ----------

/** One AI presenter, kept across videos: how she looks and sounds, and her stills (Naive files) by setting. */
export type Persona = { name: string; look: string; voice: string; stills: Array<{ setting: string; file_id: string; place: string }> };

/** The persona as one video uses her: one still, in one setting. */
export type PersonaStill = { name: string; setting: string; file_id: string; place: string; look: string; voice: string };

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** The `persona` setting (JSON) as a Persona, or undefined when it is unset or unusable. */
export function readPersona(json: string | null | undefined): Persona | undefined {
  if (!json?.trim()) return undefined;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const stills = (Array.isArray(raw.stills) ? raw.stills : [])
      .map((entry) => (entry ?? {}) as Record<string, unknown>)
      .map((entry) => ({ setting: text(entry.setting), file_id: text(entry.file_id), place: text(entry.place) }))
      .filter((still) => still.setting && /^fil_/.test(still.file_id));
    if (!stills.length) return undefined;
    return { name: text(raw.name) || "persona", look: text(raw.look), voice: text(raw.voice), stills };
  } catch {
    return undefined;
  }
}

/** The still a video is filmed in: the named setting, else the persona's first. */
export function personaFor(persona: Persona | undefined, setting?: string): PersonaStill | undefined {
  if (!persona?.stills.length) return undefined;
  const still = persona.stills.find((s) => s.setting === setting) ?? persona.stills[0];
  return { name: persona.name, setting: still.setting, file_id: still.file_id, place: still.place, look: persona.look, voice: persona.voice };
}

// ---------- the shape ----------

/** Every other take is punched in this much: the jump cut creators make in their own edits. */
export const PUNCH_IN = 1.12;
/** Kling's natural talking pace in a short take, in words per second (measured on its renders: 2.5-3.5). */
const TAKE_WPS = 3.2;
/** One take: at most this many words, said in at most this many seconds. */
const MAX_TAKE_WORDS = 20;
const MIN_TAKE = 3; // Kling's shortest
const MAX_TAKE = 10;
/** Organic videos run 12-20 s: every presenter second is rendered, and short takes are where AI video looks real. */
const MIN_SECONDS = 12;
const MAX_SECONDS = 20;
/** Product screens should fill this share of the runtime. */
const PRODUCT_SHARE = { min: 0.25, max: 0.6 } as const;
/** Jobs that say what the product does: shown on a screen, never only said to camera. */
const CLAIM_JOBS: BeatJob[] = ["demo", "proof", "reveal"];

const words = (line: string) => line.toLowerCase().replace(/[^\p{L}\p{N}'$%]+/gu, " ").trim().split(/\s+/).filter(Boolean);

/** A take's render length: the line at Kling's pace plus a little room, in whole seconds (it bills what is asked). */
export const takeSeconds = (line: string) => Math.min(MAX_TAKE, Math.max(MIN_TAKE, Math.ceil(words(line).length / TAKE_WPS + 0.7)));

/** How long an organic video should run: its formula's length, kept to 12-20 s. */
export const organicTarget = (formula: Pick<Formula, "pacing">) => Math.round(Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, formula.pacing.seconds || MAX_SECONDS)));

/**
 * The organic plan: one take per spoken beat, rendered from the persona's own still (no frame is
 * generated, so the face never changes), at the length its line needs. A take the product covers
 * for its whole length is marked `covered`; only its voice is heard. Product beats get screens as in
 * any plan, and the edit jump-cuts between takes, alternating the full frame and a punch-in.
 */
export function planOrganic(script: Script, brief: CreativeBrief, product: ProductBrief, persona?: PersonaStill, delivery = ""): ProductionPlan {
  const shotBrief: CreativeBrief = { ...brief, format: "talking_head_broll", ...(persona ? { creator: persona.look, setting: persona.place } : {}) };
  const base = planProduction(script, shotBrief, product, delivery);
  const aroll = script.beats
    .filter((beat) => beat.line)
    .map((beat, i) => {
      const shot = presenterShot(i + 1, [beat], shotBrief, product, delivery, persona?.voice);
      return {
        ...shot,
        seconds: Math.round((words(beat.line).length / TAKE_WPS) * 10) / 10,
        duration: takeSeconds(beat.line),
        ...(beat.visual === "product" ? { covered: true } : {}),
        // Every take starts from the same still: nothing is re-posed.
        ...(persona ? { pose: "" } : {}),
      };
    });
  return { ...base, format: "talking_head_broll", aroll, punch_in: PUNCH_IN };
}

// ---------- the script room ----------

export type OrganicContext = { product: ProductBrief; brief: CreativeBrief; formula: Formula; examples: ReferenceBreakdown[]; targetSeconds: number; persona?: PersonaStill };

function writerSystem() {
  return [
    "You write an original short vertical video for a product. It is built on a formula that already worked across several viral videos: you get the formula (its hook archetype and mechanic, its beat structure with each beat's job and share of the runtime, its pacing, proof device and call-to-action pattern) and the videos that back it. Use them for their structure, energy and rhythm. Never copy their words, claims, numbers, products, brand names or handles: the script is new, about this product, in its real facts.",
    "",
    "How it will be made, so write for it:",
    "- One AI presenter talks to a camera propped up at eye level, in short takes with a jump cut between them. Every beat is one take: one sentence, or two very short ones, 6 to 18 words, said in 3 to 7 seconds. Never more than 20 words in a beat. Every beat has a spoken line.",
    "- The presenter is on camera (visual \"creator\") for the hook and the emotional beats: the confession, the reaction, the doubt, the ask. Her direction is one small thing per take (a small nod, a half-smile, a raised eyebrow, leaning in a little), never pointing, waving, holding things or touching her face.",
    "- Every beat that says what the product does, or proves it, shows it instead (visual \"product\", with a `screen`): the product's real interface with the brief's exact names and wording, and what moves on it (text types in, a button is clicked, rows appear one by one). The presenter keeps talking over it. Product beats fill 30 to 50% of the runtime.",
    "- The first beat is the hook, on camera: the formula's hook mechanic applied to this product and angle, with on_screen_text (at most 8 words) that sharpens it.",
    "",
    "Sounding human:",
    "- Write the way a real creator talks: spoken, short sentences, contractions, plain words, a filler word where a person would use one (okay so, honestly, like). No ad copy: game changer, revolutionize, unlock, elevate, seamless, effortless, say goodbye to, introducing, look no further, next level, supercharge, streamline, empower, leverage, dive in, whether you're, must-have, all-in-one, cutting-edge, transform, journey, innovative, solution. No em dashes, no emojis.",
    "",
    "Facts:",
    "- Every claim, name and number comes from the product brief (its claims, features, offer and code). If the brief doesn't say it, don't say it. No money or income promises the brief does not make.",
    "- These videos are posted by the brand and labeled AI-generated. The presenter shows and explains the product; she never claims she used it, her results, how long she has had it, ratings or reviews. A formula's personal story (\"I found a way to\") becomes what the viewer can do (\"you can\").",
    "- No other brands or products by name, including the ones the backing videos show.",
    "",
    "The video's job (the creative brief's role):",
    "- convert: judged on sign-ups. Keep the formula's proof, and end on the brief's cta as one clear step, said the way a creator would say it.",
    "- reach: judged on views and shares. The ending stays soft (follow, comment, share), with no hard sell.",
    "",
    "Give every beat one voice tag in `emotion` for how it is said: [hushed], [excited], [deadpan], [matter-of-fact], [warm], [laughs].",
    "",
    "Call the script tool once with every beat.",
  ].join("\n");
}

function criticSystem() {
  return [
    "You are a short-form creative director who has watched ten thousand TikToks. You check original scripts before anything is filmed. Each is written on a proven formula (given, with the videos that back it) for a new product, and will be made by one AI presenter in short takes with the product's real screens as cutaways.",
    "Fail: a hook that does not stop the scroll or does not use the formula's mechanic; lines a real creator would not say out loud; ad copy; anything copied from the backing videos (their words, claims, numbers or brands); claims, names or numbers not in the product brief; any personal-history claim (past use, personal results, reviews); a beat too long for one take (more than one or two short sentences); a claim said to camera instead of shown on a screen; a screen that does not show what its line says; big gestures or props in a creator direction.",
    "Also judge the video's job (the role at the end of the brief). A convert video must keep the formula's proof and end on one clear call to action; a reach video stays soft, with no hard sell.",
    "If the overall score is below 8, write the complete revised script that fixes every problem, following the same rules as the writer (an original script in the formula, every claim true to the brief, one take per beat).",
  ].join("\n");
}

const ORGANIC_CRITIC_TOOL = {
  ...CRITIC_TOOL,
  input_schema: {
    ...CRITIC_TOOL.input_schema,
    properties: {
      ...CRITIC_TOOL.input_schema.properties,
      scores: {
        type: "object",
        required: ["sounds_human", "hook", "product_clarity", "fits_formula", "specificity", "does_its_job", "renders_well"],
        properties: {
          sounds_human: { type: "integer", description: "1-10: would a real creator say every line out loud like this?" },
          hook: { type: "integer", description: "1-10: does beat 1 use the formula's hook mechanic and stop the scroll?" },
          product_clarity: { type: "integer", description: "1-10: after watching, does a stranger know what the product is and why they'd want it?" },
          fits_formula: { type: "integer", description: "1-10: does it follow the formula's beats, pacing, proof device and ask, in new words?" },
          specificity: { type: "integer", description: "1-10: concrete details from the brief instead of generic claims?" },
          does_its_job: { type: "integer", description: "1-10, by the brief's role. convert: keeps the proof and ends on one clear call to action. reach: watchable and shareable with no hard sell." },
          renders_well: { type: "integer", description: "1-10: one short take per beat, the presenter on camera only for the hook and the emotional beats, every claim on a product screen, small calm directions." },
        },
      },
    },
  },
};

function contextBlock(ctx: OrganicContext) {
  const { product, brief, formula, examples } = ctx;
  return [
    `<product_brief>\n${JSON.stringify({ ...product, visuals: undefined })}\n</product_brief>`,
    `<visuals>\n${JSON.stringify(product.visuals.map((v) => ({ id: v.id, kind: v.kind, caption: v.caption, tall_page: isTall(v) || undefined })))}\n</visuals>`,
    `<creative_brief>\n${JSON.stringify(brief)}\n</creative_brief>`,
    `<formula>\n${JSON.stringify(formulaDigest([formula])[0])}\n</formula>`,
    `The videos behind the formula, for their structure, energy and rhythm only (never their words, claims or brands):\n<backing_videos>\n${JSON.stringify(
      examples.map((ref) => ({
        id: ref.id,
        seconds: ref.duration,
        hook: { line: ref.hook.line, on_screen_text: ref.hook.on_screen_text, mechanic: ref.hook.mechanic },
        beats: ref.beats.map((beat) => ({ t: `${beat.start.toFixed(1)}-${beat.end.toFixed(1)}s`, job: beat.job, shot: beat.shot, line: beat.line })),
        delivery: ref.delivery,
        why_it_works: ref.why_it_works,
      })),
    )}\n</backing_videos>`,
    ctx.persona ? `The presenter: ${ctx.persona.look}, filmed at ${ctx.persona.place}.` : "",
    `Target length: about ${ctx.targetSeconds} seconds, so ${Math.max(3, Math.round(ctx.targetSeconds / 5))} to ${Math.max(4, Math.round(ctx.targetSeconds / 3.5))} beats. Format: talking_head_broll. Role: ${brief.role ?? "reach"} (judged on ${(brief.metric ?? (brief.role === "convert" ? "link_clicks" : "views")).replace(/_/g, " ")}).`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Six words in a row from a backing video: copied, not written. */
function copiedRun(line: string, sources: string[][]): string | null {
  const ours = words(line);
  for (let i = 0; i + 6 <= ours.length; i++) {
    const run = ours.slice(i, i + 6).join(" ");
    if (sources.some((source) => ` ${source.join(" ")} `.includes(` ${run} `))) return run;
  }
  return null;
}

/** Everything a machine can check in an organic script. Empty means clean. */
export function lintOrganic(script: Script, ctx: OrganicContext): string[] {
  const issues: string[] = [];
  const spoken = script.beats.map((beat) => beat.line).join(" ");
  const allText = `${spoken} ${script.beats.map((b) => b.on_screen_text).join(" ")}`.toLowerCase();
  const has = (body: string, phrase: string) => new RegExp(`\\b${phrase.replace(/[-?]/g, (c) => `\\${c}`)}`, "i").test(body);

  // Original writing: no ad copy at all (an organic script has no reference voice to excuse it).
  for (const phrase of BANNED) if (has(allText, phrase)) issues.push(`AI/ad phrase "${phrase}"`);
  for (const pattern of TESTIMONIAL) if (pattern.test(spoken)) issues.push(`personal-history claim (${pattern.source}): replace it with a fact from the product brief`);
  if (/\p{Extended_Pictographic}/u.test(allText)) issues.push("emoji in the script");

  // Numbers come from the brief.
  const briefText = JSON.stringify({ claims: ctx.product.claims, proof: ctx.product.proof, offer: ctx.product.offer, features: ctx.product.features, one_liner: ctx.product.one_liner, code: ctx.product.code }).toLowerCase().replace(/(\d),(?=\d{3})/g, "$1");
  for (const number of spoken.match(/\$?\d[\d,.]*\s*(?:%|x|k|m)?/gi) ?? []) {
    const digits = number.replace(/[^\d.]/g, "");
    if (digits && !briefText.includes(digits)) issues.push(`the number "${number.trim()}" is not in the product brief`);
  }

  // The backing videos' people and words never carry over.
  const backingText = ctx.examples.map((ref) => `${ref.transcript} ${ref.hook.line} ${ref.beats.map((b) => b.line).join(" ")}`).join(" ").toLowerCase();
  const theirs = [...new Set([...ctx.examples.map((ref) => ref.author), ...[...backingText.matchAll(/@([\w.]{3,30})/g)].map((m) => m[1])])].filter(
    (name) => name && name.length > 2 && !ctx.product.name.toLowerCase().includes(name.toLowerCase()),
  );
  for (const name of theirs) if (has(allText, name.toLowerCase().replace(/\./g, "\\."))) issues.push(`mentions the reference's handle or name "${name}"`);
  const sources = ctx.examples.flatMap((ref) => [ref.transcript, ref.hook.line, ...ref.beats.map((b) => b.line)]).map(words).filter((w) => w.length >= 6);

  // One take per beat, the presenter on the hook, the claims on screens.
  for (const beat of script.beats) {
    const count = words(beat.line).length;
    if (!count) issues.push(`beat ${beat.n} says nothing: every take is a spoken line`);
    if (count > MAX_TAKE_WORDS) issues.push(`beat ${beat.n} runs ${count} words: one take is one or two short sentences (at most ${MAX_TAKE_WORDS} words)`);
    if (beat.visual === "creator" && CLAIM_JOBS.includes(beat.job)) issues.push(`beat ${beat.n} makes a claim on camera (${beat.job}): show it on a product screen while she talks`);
    const copied = copiedRun(beat.line, sources);
    if (copied) issues.push(`beat ${beat.n} copies "${copied}" from a backing video: write it new`);
    if (beat.on_screen_text && words(beat.on_screen_text).length > 10) issues.push(`beat ${beat.n} on-screen text is over 10 words`);
  }
  const first = script.beats[0];
  if (first && first.visual !== "creator") issues.push("the hook (beat 1) belongs on camera: the presenter says it to the lens");

  const total = script.total_seconds || 1;
  const share = script.beats.filter((beat) => beat.visual !== "creator").reduce((sum, beat) => sum + beat.seconds, 0) / total;
  if (share < PRODUCT_SHARE.min) issues.push(`the product is on screen for ${Math.round(share * 100)}% of the video: show the claims on product screens (aim for 30-50%)`);
  if (share > PRODUCT_SHARE.max) issues.push(`the product is on screen for ${Math.round(share * 100)}% of the video: keep the presenter on camera for the hook and the emotional beats (aim for 30-50%)`);
  if (Math.abs(script.total_seconds - ctx.targetSeconds) > 4) issues.push(`total ${script.total_seconds}s vs the target ${ctx.targetSeconds}s`);

  if ((ctx.brief.role ?? "reach") === "convert") {
    const last = script.beats[script.beats.length - 1];
    const asks = script.beats.some((beat) => beat.job === "cta") || (last !== undefined && ASK.test(`${last.line} ${last.on_screen_text}`));
    if (!asks) issues.push(`a convert video must end on a call to action (the brief's "${ctx.brief.cta || "cta"}"): no beat asks the viewer to act`);
  }
  return issues;
}

/** The organic script room: a writer in the formula, the linter above and a critic, as for remakes. */
export function writeOrganicScript(naive: NaiveClient, ctx: OrganicContext): Promise<Script> {
  return runScriptRoom(naive, {
    writer: writerSystem(),
    context: contextBlock(ctx),
    title: ctx.brief.title,
    normalize: (beats) => normalizeScript(beats, ctx),
    lint: (script) => lintOrganic(script, ctx),
    critic: { system: criticSystem(), tool: ORGANIC_CRITIC_TOOL },
  });
}

/** One organic video, written and planned: its formula, the videos behind it and its persona travel with it. */
export async function organicConcept(
  naive: NaiveClient,
  input: { product: ProductBrief; brief: CreativeBrief; formulas: Formula[]; breakdowns: ReferenceBreakdown[]; persona?: Persona },
): Promise<Concept> {
  const formula = input.formulas.find((f) => f.id === input.brief.formula_id) ?? input.formulas[0];
  if (!formula) throw new Error("An organic video needs a formula, and the campaign has none.");
  const examples = formula.references.map((id) => input.breakdowns.find((ref) => ref.id === id)).filter((ref): ref is ReferenceBreakdown => Boolean(ref));
  const persona = personaFor(input.persona, input.brief.persona_setting);
  const brief: CreativeBrief = { ...input.brief, mode: "organic", formula_id: formula.id, format: "talking_head_broll", ...(persona ? { persona_setting: persona.setting } : {}) };
  const ctx: OrganicContext = { product: input.product, brief, formula, examples, targetSeconds: organicTarget(formula), persona };
  const script = await writeOrganicScript(naive, ctx);
  const plan = planOrganic(script, brief, input.product, persona);
  return conceptFrom(brief, script, plan, undefined, input.product, { formula, persona });
}
