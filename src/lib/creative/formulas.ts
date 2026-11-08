import { ApiError } from "../http";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import { JOBS } from "./script";
import type { BeatJob, FunnelRole, ProductBrief, ReferenceBreakdown } from "./types";

// Formula extraction, for organic videos: the reusable patterns behind a campaign's reference
// videos (hook archetype, beat structure, pacing, proof device, call to action), each backed by the
// references that follow it. A model names the patterns and cites reference ids; code keeps only
// ids it knows and attaches their real numbers, so the evidence behind a formula is never invented.

/** One beat of a formula: its job, its share of the runtime, and whether the person or the product fills the screen. */
export type FormulaBeat = { job: BeatJob; share: number; does: string; on_screen: "presenter" | "product" };

/** The numbers behind a formula, copied from its references' breakdowns. */
export type FormulaEvidence = {
  references: Array<{ id: string; url: string; author: string; views: number | null; outlier: number | null; conversion: number | null; signals: string[]; role: FunnelRole }>;
  videos: number;
  /** Views summed over the references that publish them (ads publish none). */
  total_views: number;
  best_outlier: number | null;
  best_conversion: number | null;
  /** One line a person can check: "2 videos, 682K views, 228-243x their accounts' followers; converts up to 2.9/10 (...)". */
  summary: string;
};

/** A winning formula: what a creator could reuse to make an original video for another product. */
export type Formula = {
  /** "f1", "f2"…, strongest evidence first. */
  id: string;
  name: string;
  role: FunnelRole;
  hook: {
    /** The hook type in a few words: "forbidden secret", "result first", "callout". */
    archetype: string;
    /** Why it stops the scroll. */
    mechanic: string;
    /** The hook as a fill-in sentence with [slots], never one reference's own words or claims. */
    template: string;
    examples: Array<{ ref: string; line: string; text: string }>;
  };
  beats: FormulaBeat[];
  pacing: { seconds: number; words_per_minute: number | null; cut_every_seconds: number; note: string };
  proof_device: string;
  cta_pattern: string;
  why_it_works: string;
  /** How one AI presenter in short takes and the product's real screens carry it, and what to leave out. */
  ai_notes: string;
  /** What never to copy from the references. */
  avoid: string[];
  /** The ReferenceBreakdown ids that back it. */
  references: string[];
  evidence: FormulaEvidence;
};

const MAX_FORMULAS = 5;
/** Jobs the presenter carries (said to camera); the rest are shown on the product's screens. */
const PRESENTER_JOBS: BeatJob[] = ["hook", "problem", "agitate", "objection", "cta", "other"];

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
const median = (values: number[]) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const compact = (n: number) => (n >= 1_000_000 ? `${round(n / 1_000_000)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

// ---------- evidence ----------

/** What the references behind a formula prove, from their breakdowns' own numbers. */
export function evidenceOf(backing: ReferenceBreakdown[]): FormulaEvidence {
  const references = backing.map((ref) => ({
    id: ref.id,
    url: ref.url,
    author: ref.author,
    // An ad library publishes no views.
    views: ref.origin === "ad" ? null : ref.views,
    outlier: ref.outlier ?? null,
    conversion: ref.conversion?.score ?? null,
    signals: ref.conversion?.signals ?? [],
    role: ref.role ?? "reach",
  }));
  const views = references.map((r) => r.views ?? 0);
  const outliers = references.map((r) => r.outlier).filter((v): v is number => typeof v === "number");
  const conversions = references.map((r) => r.conversion).filter((v): v is number => typeof v === "number");
  const total = views.reduce((sum, v) => sum + v, 0);
  const best_outlier = outliers.length ? Math.max(...outliers) : null;
  const best_conversion = conversions.length ? Math.max(...conversions) : null;
  const n = references.length;
  const ads = references.filter((r) => r.views === null).length;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts = [ads === n ? `${plural(n, "paid ad")} (no public views)` : `${plural(n, "video")}${ads ? ` (${ads} a paid ad)` : ""}`];
  if (total > 0) parts.push(`${compact(total)} views`);
  if (outliers.length) {
    const low = Math.round(Math.min(...outliers));
    const high = Math.round(Math.max(...outliers));
    parts.push(`${low === high ? high : `${low}-${high}`}x ${n === 1 ? "its account's" : "their accounts'"} followers`);
  }
  let summary = parts.join(", ");
  if (best_conversion !== null) {
    const best = references.find((r) => r.conversion === best_conversion)!;
    summary += `; converts ${n > 1 ? "up to " : ""}${round(best_conversion)}/10${best.signals.length ? ` (${best.signals.join(", ")})` : ""}`;
  }
  return { references, videos: n, total_views: total, best_outlier, best_conversion, summary };
}

/** How strongly the evidence backs a formula: more videos, conversion evidence, then reach. */
const strength = (evidence: FormulaEvidence) => evidence.videos + (evidence.best_conversion ?? 0) / 2 + Math.log10(evidence.total_views + 1) / 2;

// ---------- normalizing ----------

/** A formula's beats: valid jobs only, the hook first, the call to action last, shares adding up to one. */
function normalizeBeats(raw: unknown, hookMechanic: string): FormulaBeat[] {
  const beats: FormulaBeat[] = (Array.isArray(raw) ? raw : [])
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => JOBS.includes(entry.job as BeatJob))
    .map((entry) => {
      const job = entry.job as BeatJob;
      const onScreen = entry.on_screen === "presenter" || entry.on_screen === "product" ? entry.on_screen : PRESENTER_JOBS.includes(job) ? "presenter" : "product";
      return { job, share: positive(entry.share) ?? 1, does: text(entry.does), on_screen: onScreen };
    });
  const hooks = beats.filter((b) => b.job === "hook").slice(0, 1);
  const ctas = beats.filter((b) => b.job === "cta");
  const middle = beats.filter((b) => b.job !== "hook" && b.job !== "cta");
  const hook = hooks[0] ?? { job: "hook" as const, share: 1, does: hookMechanic, on_screen: "presenter" as const };
  const ordered = [{ ...hook, on_screen: "presenter" as const }, ...middle, ...ctas];
  const total = ordered.reduce((sum, b) => sum + b.share, 0) || 1;
  return ordered.map((b) => ({ ...b, share: round(b.share / total, 3) }));
}

function majorityRole(backing: ReferenceBreakdown[]): FunnelRole {
  const converts = backing.filter((ref) => (ref.role ?? "reach") === "convert").length;
  return converts * 2 >= backing.length && converts > 0 ? "convert" : "reach";
}

function pacingOf(raw: Record<string, unknown>, backing: ReferenceBreakdown[]): Formula["pacing"] {
  return {
    seconds: round(positive(raw.seconds) ?? median(backing.map((ref) => ref.duration)) ?? 20),
    words_per_minute: positive(raw.words_per_minute) ?? median(backing.map((ref) => ref.pacing.words_per_minute ?? NaN)),
    cut_every_seconds: round(positive(raw.cut_every_seconds) ?? median(backing.map((ref) => ref.pacing.avg_shot_seconds)) ?? 4),
    note: text(raw.note),
  };
}

/** The model's formulas made safe: known references only, real evidence, strongest first, ids f1… */
export function normalizeFormulas(raw: unknown, breakdowns: ReferenceBreakdown[]): Formula[] {
  const byId = new Map(breakdowns.map((ref) => [ref.id, ref]));
  const record = (raw ?? {}) as { formulas?: unknown };
  const list = Array.isArray(record.formulas) ? record.formulas : Array.isArray(raw) ? raw : [];
  const formulas: Formula[] = [];
  for (const entry of list) {
    const f = (entry ?? {}) as Record<string, unknown>;
    const references = [...new Set(strings(f.references))].filter((id) => byId.has(id));
    const name = text(f.name);
    if (!references.length || !name) continue;
    const backing = references.map((id) => byId.get(id)!);
    const hook = (f.hook ?? {}) as Record<string, unknown>;
    const mechanic = text(hook.mechanic) || backing[0].hook.mechanic;
    const examples = (Array.isArray(hook.examples) ? hook.examples : [])
      .map((e) => (e ?? {}) as Record<string, unknown>)
      .filter((e) => references.includes(text(e.ref)))
      .map((e) => ({ ref: text(e.ref), line: text(e.line), text: text(e.text) }));
    formulas.push({
      id: "",
      name,
      role: f.role === "reach" || f.role === "convert" ? f.role : majorityRole(backing),
      hook: {
        archetype: text(hook.archetype) || "hook",
        mechanic,
        template: text(hook.template),
        examples: examples.length ? examples : backing.map((ref) => ({ ref: ref.id, line: ref.hook.line, text: ref.hook.on_screen_text })),
      },
      beats: normalizeBeats(f.beats, mechanic),
      pacing: pacingOf((f.pacing ?? {}) as Record<string, unknown>, backing),
      proof_device: text(f.proof_device),
      cta_pattern: text(f.cta_pattern) || "none",
      why_it_works: text(f.why_it_works),
      ai_notes: text(f.ai_notes),
      avoid: strings(f.avoid),
      references,
      evidence: evidenceOf(backing),
    });
  }
  return rank(formulas);
}

function rank(formulas: Formula[]): Formula[] {
  return formulas
    .map((formula, i) => ({ formula, i }))
    .sort((a, b) => strength(b.formula.evidence) - strength(a.formula.evidence) || a.i - b.i)
    .slice(0, MAX_FORMULAS)
    .map(({ formula }, i) => ({ ...formula, id: `f${i + 1}` }));
}

// ---------- the fallback ----------

const STRUCTURE_NAMES: Record<string, string> = {
  problem_solution: "Problem, then the fix",
  demo: "Show it working",
  testimonial: "Testimonial",
  review: "Honest review",
  before_after: "Before and after",
  us_vs_them: "Us versus them",
  listicle: "List of reasons",
  founder_story: "Founder story",
  objection_handling: "Answer the doubt",
  tutorial: "Steps on screen",
  skit: "Skit",
  reaction: "Reaction",
  trend: "Trend",
  story: "Story with a result",
  other: "Format",
};

/** Without a model: one formula per selling structure, shaped like its strongest reference. */
export function fallbackFormulas(breakdowns: ReferenceBreakdown[]): Formula[] {
  const groups = new Map<string, ReferenceBreakdown[]>();
  for (const ref of breakdowns) {
    const key = ref.anatomy?.structure ?? "other";
    groups.set(key, [...(groups.get(key) ?? []), ref]);
  }
  const formulas: Formula[] = [...groups.entries()].map(([structure, backing]) => {
    const best = [...backing].sort((a, b) => b.views - a.views)[0];
    const presenterShots = new Set(["talking_head", "reaction"]);
    const beats = normalizeBeats(
      best.beats.map((beat) => ({ job: beat.job, share: Math.max(0.5, beat.end - beat.start), does: beat.visual || beat.line, on_screen: presenterShots.has(beat.shot) ? "presenter" : "product" })),
      best.hook.mechanic,
    );
    return {
      id: "",
      name: STRUCTURE_NAMES[structure] ?? "Format",
      role: majorityRole(backing),
      hook: { archetype: structure.replace(/_/g, " "), mechanic: best.hook.mechanic, template: "", examples: backing.map((ref) => ({ ref: ref.id, line: ref.hook.line, text: ref.hook.on_screen_text })) },
      beats,
      pacing: pacingOf({}, backing),
      proof_device: best.anatomy?.proof ?? "",
      cta_pattern: best.anatomy?.cta || "none",
      why_it_works: best.why_it_works,
      ai_notes: "One presenter to camera for the hook and the ask; what the product does shown on its real screens.",
      avoid: ["the references' own claims, numbers, brands and handles"],
      references: backing.map((ref) => ref.id),
      evidence: evidenceOf(backing),
    };
  });
  return rank(formulas);
}

// ---------- the model ----------

const FORMULA_TOOL = {
  name: "formulas",
  description: "Record the reusable formulas behind the reference videos.",
  input_schema: {
    type: "object",
    required: ["formulas"],
    properties: {
      formulas: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "role", "hook", "beats", "pacing", "proof_device", "cta_pattern", "why_it_works", "ai_notes", "avoid", "references"],
          properties: {
            name: { type: "string", description: "A short name a strategist would use, e.g. 'The reluctant insider', 'Result first'." },
            role: { type: "string", enum: ["reach", "convert"], description: "What its backing videos prove: reach (views far above the account) or convert (they sell)." },
            hook: {
              type: "object",
              required: ["archetype", "mechanic", "template", "examples"],
              properties: {
                archetype: { type: "string", description: "The hook type in two to four words: forbidden secret, result first, callout, myth bust, series title, equation, POV." },
                mechanic: { type: "string", description: "Why it stops the scroll, in one sentence." },
                template: { type: "string", description: "The hook as a fill-in sentence with [slots] for any product. Never one reference's own words, claims, numbers or brands." },
                examples: {
                  type: "array",
                  items: { type: "object", required: ["ref", "line", "text"], properties: { ref: { type: "string" }, line: { type: "string" }, text: { type: "string" } } },
                  description: "The backing references' own hooks, quoted: the spoken line and the on-screen text.",
                },
              },
            },
            beats: {
              type: "array",
              description: "The beat structure in order, starting with the hook: each beat's job, its share of the runtime (relative numbers), what it does, and whether the person (presenter) or the product fills the screen.",
              items: {
                type: "object",
                required: ["job", "share", "does", "on_screen"],
                properties: { job: { type: "string", enum: JOBS }, share: { type: "number" }, does: { type: "string" }, on_screen: { type: "string", enum: ["presenter", "product"] } },
              },
            },
            pacing: {
              type: "object",
              required: ["seconds", "words_per_minute", "cut_every_seconds", "note"],
              properties: { seconds: { type: "number" }, words_per_minute: { type: ["number", "null"] }, cut_every_seconds: { type: "number" }, note: { type: "string" } },
            },
            proof_device: { type: "string", description: "How it proves the claim: a live demo of the result, a number on screen, a before and after, a dashboard." },
            cta_pattern: { type: "string", description: "How it asks, as a pattern ('comment a keyword for the link', 'the steps are the ask', 'name the product, point to the bio'), or 'none'." },
            why_it_works: { type: "string" },
            ai_notes: {
              type: "string",
              description: "How one AI presenter talking to a propped-up camera in short takes, plus the product's real screens as cutaways, can carry it: what to keep, and what of the references' footage to leave out.",
            },
            avoid: { type: "array", items: { type: "string" }, description: "What never to copy: the references' claims, numbers, brands and handles, and anything only a real person could say." },
            references: { type: "array", items: { type: "string" }, description: "The ids of the reference videos that follow this formula." },
          },
        },
      },
    },
  },
};

function formulaSystem() {
  return [
    "You are a short-form video strategist. You read breakdowns of reference videos that already worked and find the reusable formulas behind them: patterns a creator could reuse to make an original video for a different product.",
    "A formula is a hook archetype and its mechanic, a beat structure (each beat's job, its share of the runtime, and whether the person or the product fills the screen), the pacing, the proof device and the call-to-action pattern.",
    "",
    "- Find 3 to 5 formulas. Prefer patterns several references share. A single reference earns its own formula only when its evidence is strong: views far above its account, or conversion evidence.",
    "- Back every formula with the ids of the references that follow it. A reference may back more than one formula.",
    "- The template and the beats describe the pattern, never one video's content: no reference's claims, numbers, brand names, products or handles.",
    "- role: convert when its backing videos sell (role convert, conversion evidence, an ask), else reach.",
    "- ai_notes: Nomen renders these with one AI presenter talking to a propped-up camera in short takes (5 to 8 seconds, one gentle action, hands still) and the product's real screens as cutaways. Say how the formula fits that, and what of the references' footage to leave out (several people, a moving camera, hands working things, big gestures).",
    "",
    "Call the formulas tool once.",
  ].join("\n");
}

/** What the formula analyst reads of each reference: numbers, hook, beats and how it sells; no raw transcript. */
function referencesFor(breakdowns: ReferenceBreakdown[]) {
  return breakdowns.map((ref) => ({
    id: ref.id,
    url: ref.url,
    author: ref.author,
    views: ref.origin === "ad" ? "unknown (paid ad)" : ref.views,
    followers: ref.followers,
    views_per_follower: ref.outlier,
    role: ref.role ?? "reach",
    conversion_evidence: ref.conversion ? `${ref.conversion.score}/10${ref.conversion.signals.length ? `: ${ref.conversion.signals.join(", ")}` : ""}` : "none recorded",
    seconds: ref.duration,
    format: ref.format,
    hook: ref.hook,
    beats: ref.beats.map((beat) => ({ t: `${beat.start.toFixed(1)}-${beat.end.toFixed(1)}s`, job: beat.job, shot: beat.shot, line: beat.line, text: beat.on_screen_text })),
    pacing: ref.pacing,
    delivery: ref.delivery,
    why_it_works: ref.why_it_works,
    ...(ref.anatomy ? { how_it_sells: ref.anatomy } : {}),
  }));
}

/**
 * The campaign's winning formulas: one model call over the breakdowns, checked against them. A
 * busy provider is left to the caller to retry; an answer with nothing usable falls back to one
 * formula per selling structure, so organic videos never wait on it.
 */
export async function extractFormulas(naive: Pick<NaiveClient, "message">, breakdowns: ReferenceBreakdown[], product: Pick<ProductBrief, "name" | "one_liner" | "kind">): Promise<Formula[]> {
  if (!breakdowns.length) return [];
  try {
    const reply = await naive.message({
      model: QC_MODEL,
      max_tokens: 8000,
      system: formulaSystem(),
      messages: [
        {
          role: "user",
          content: `The product these formulas will carry (for judging what transfers; formulas stay product-agnostic):\n<product>\n${JSON.stringify({ name: product.name, one_liner: product.one_liner, kind: product.kind })}\n</product>\n\nThe reference videos:\n<references>\n${JSON.stringify(referencesFor(breakdowns))}\n</references>`,
        },
      ],
      tools: [FORMULA_TOOL],
    });
    const call = reply.content.find((block) => block.type === "tool_use" && block.name === FORMULA_TOOL.name);
    const raw = call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"));
    const formulas = normalizeFormulas(raw, breakdowns);
    return formulas.length ? formulas : fallbackFormulas(breakdowns);
  } catch (error) {
    if (error instanceof ApiError && error.retryable) throw error;
    return fallbackFormulas(breakdowns);
  }
}

/** What the director reads of the formulas: the pattern, its backing and its numbers. */
export function formulaDigest(formulas: Formula[]) {
  return formulas.map((f) => ({
    id: f.id,
    name: f.name,
    role: f.role,
    backed_by: f.evidence.summary,
    references: f.evidence.references.map((r) => ({ id: r.id, url: r.url, author: r.author, views: r.views ?? "unknown (paid ad)", views_per_follower: r.outlier, conversion: r.conversion, signals: r.signals, role: r.role })),
    hook: { archetype: f.hook.archetype, mechanic: f.hook.mechanic, template: f.hook.template },
    beats: f.beats.map((b) => ({ job: b.job, share: `${Math.round(b.share * 100)}%`, does: b.does, on_screen: b.on_screen })),
    pacing: f.pacing,
    proof_device: f.proof_device,
    cta_pattern: f.cta_pattern,
    why_it_works: f.why_it_works,
    ai_notes: f.ai_notes,
    avoid: f.avoid,
  }));
}
