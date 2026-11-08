// One-to-one remake: rebuilds a viral reference video from its own frames, shot for shot, with our
// presenter in place of the original person, our lines, and our product in its graphics. Everything
// else (layout, framing, moves, cuts, graphic placement and timing, caption look) is the reference's.
//
//   reference.mp4 + its breakdown + our lines (one per reference beat)
//     └─ analyzeReference ── a vision pass over sampled frames: full frame or a centre band with a
//          │                  blurred fill, the presenter per beat, every overlaid graphic, the captions
//          └─ planRemake ── beats → shots (split at cuts and at 8 s), each shot's line, prompts, and
//               │            every graphic → a screen request at its own box size
//               ├─ cleanFrame ── the reference frame at each shot's start with our persona in place of
//               │                 the person and every overlay removed (image edit + first-frame gate)
//               ├─ render ── Veo animates each clean frame with the reference's motion, speaking our line
//               ├─ graphics ── the screen builder makes ours, the same kind of element, about our product
//               └─ compose ── shots into the band, graphics at their boxes, blurred fill, captions
//
// Video models cannot re-voice existing footage with lip-sync (Gemini Omni, Seedance and Runway
// Aleph all failed at it), so the presenter is re-rendered per shot from a frame of the reference.
// Optional: silent shots of a visible presenter can be swapped on the reference footage itself (Mira).
//
// The pure helpers (layout parsing, shot planning, graphic requests, timing, ffmpeg arguments) are
// exported and unit-tested; `remakeVideo` runs the whole thing from local files and a Naive client,
// resuming from its work directory after a restart. Nothing here touches the database.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { ApiError } from "../http";
import { download, probe } from "../media";
import type { MediaJob, NaiveClient } from "../naive";
import { QC_MODEL, reviewFrame } from "../qc";
import { extractJson } from "../research";
import { type CaptionStyle, chunkCaptions, toAss } from "./captions";
import { DEFAULT_FONT, editFfmpeg, fontMetrics } from "./edit";
import { lookOnly, presenterOnly, SAFE, snapSeconds } from "./plan";
import { detectCuts } from "./references";
import { buildScreens } from "./screens";
import { beatWordBudget } from "./script";
import { parseSilences } from "./trim";
import type { BrandKit, EditTimeline, ProductBrief, ReferenceBeat, ReferenceBreakdown, ScreenClip, ScreenRequest } from "./types";

const exec = promisify(execFile);

export const OUT = { width: 1080, height: 1920, fps: 30 } as const;
export const REMAKE_VIDEO_MODEL = "google/veo-3.1";
/** The fastest Veo says a line reliably; a longer line gets a longer render and its beat runs a little long. */
const VEO_WPS = 3.6;
/** Shots shorter than this cost a 4 s render each for little: cuts closer together are merged. */
const MIN_SHOT = 2;
const MAX_SHOT = 8;
/** Image edits per shot: the first plus two remade after the first-frame gate sends them back. */
const FRAME_TRIES = 3;
const RENDER_TRIES = 2;
/** A render or swap still unfinished after this long is left for the next run to pick up (same keys). */
const POLL_LIMIT_MS = 30 * 60_000;

// ---------- the layout ----------

/** A rectangle as fractions (0-1) of its parent: the stage for presenter and graphics, the frame for captions. */
export type Box = { x: number; y: number; w: number; h: number };

export const GRAPHIC_KINDS = ["tweet", "social_post", "photo", "chart", "webcam", "text_card", "game_scene", "other"] as const;
export type GraphicKind = (typeof GRAPHIC_KINDS)[number];
export const ENTRANCES = ["pop", "slide_up", "slide_left", "slide_right", "fade", "cut"] as const;
export type Entrance = (typeof ENTRANCES)[number];

/** One element the reference's editor laid over the footage, with when and how it appeared. */
export type RemakeGraphic = { id: string; kind: GraphicKind; box: Box; start: number; end: number; shows: string; entrance: Entrance };

export type RemakeBeat = {
  n: number;
  start: number;
  end: number;
  presenter: {
    visible: boolean;
    speaking: boolean;
    /** Where the presenter is at the beat's start, on the stage; null when unknown. */
    box: Box | null;
    framing: string;
    /** Body motion only: where they move, how they gesture, jumps in size or position. */
    motion: string;
  };
};

export type CaptionLook = {
  upper: boolean;
  italic: boolean;
  /** "#RRGGBB" */
  color: string;
  outline: "none" | "thin" | "heavy";
  shadow: boolean;
  /** Words on screen at once. */
  words: number;
  /** Vertical centre of the caption line, as a fraction of the frame height. */
  center_y: number;
  /** Capital-letter height as a fraction of the frame height. */
  size: number;
  /** A sticker by the captions (an emoji badge), in fractions of the frame. */
  badge: { box: Box; color: string; accent: string; looks_like: string } | null;
};

/** How the reference is built, read from its frames. The stage is the band, or the whole frame. */
export type RemakeLayout = {
  frame: { kind: "full" } | { kind: "band"; band: Box };
  /** The filmed background alone: what the clean frames keep. */
  set: string;
  /** The original presenter's look, only to know whom to replace. */
  presenter: string;
  beats: RemakeBeat[];
  graphics: RemakeGraphic[];
  captions: CaptionLook;
};

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
const words = (text: string) => text.split(/\s+/).filter(Boolean);
const text = (value: unknown, max = 600) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
const fmt = (x: number) => String(Math.round(x * 10000) / 10000);

/** A box from a model's answer: fractions (or percentages), clamped inside its parent; null when unusable. */
export function readBox(raw: unknown): Box | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  let [x, y, w, h] = [num(o.x ?? o.left), num(o.y ?? o.top), num(o.w ?? o.width), num(o.h ?? o.height)];
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (Math.max(x, y, w, h) > 1.5) [x, y, w, h] = [x / 100, y / 100, w / 100, h / 100];
  x = clamp(x, 0, 1);
  y = clamp(y, 0, 1);
  w = clamp(w, 0, 1 - x);
  h = clamp(h, 0, 1 - y);
  if (w < 0.03 || h < 0.03) return null;
  return { x: round(x, 4), y: round(y, 4), w: round(w, 4), h: round(h, 4) };
}

/** A model's name for an overlay, mapped onto the kinds we can rebuild. */
export function graphicKind(raw: unknown): GraphicKind {
  const value = text(raw, 80).toLowerCase();
  if ((GRAPHIC_KINDS as readonly string[]).includes(value)) return value as GraphicKind;
  if (/tweet|twitter|\bx post|\bx\b/.test(value)) return "tweet";
  if (/linkedin|instagram|facebook|reddit|threads|post|comment/.test(value)) return "social_post";
  if (/chart|graph|bar|plot/.test(value)) return "chart";
  if (/webcam|facecam|video call|inset/.test(value)) return "webcam";
  if (/game|level|mario|pixel/.test(value)) return "game_scene";
  if (/photo|image|picture|selfie|billboard|video/.test(value)) return "photo";
  if (/text|title|label|card|quote/.test(value)) return "text_card";
  return "other";
}

const HEX = /^#?([0-9a-f]{6})$/i;
const hex = (value: unknown, fallback: string) => {
  const match = text(value, 9).match(HEX);
  return match ? `#${match[1].toUpperCase()}` : fallback;
};

/** The span a remake covers: every beat that starts before `until` (whole beats), or all of them. */
export function remakeSpan(beats: ReferenceBeat[], until?: number): { beats: ReferenceBeat[]; end: number } {
  const sorted = beats.filter((beat) => beat.end > beat.start).sort((a, b) => a.start - b.start);
  const kept = until && until > 0 ? sorted.filter((beat, i) => i === 0 || beat.start < until - 0.5) : sorted;
  return { beats: kept, end: kept.length ? kept[kept.length - 1].end : 0 };
}

/**
 * Validates the analyst's answer against the reference's beats: boxes clamped, kinds mapped,
 * graphics kept inside the remade span, one layout beat per reference beat (timed by the beat, not
 * the model), and the caption look filled from the breakdown's words where the model left it out.
 */
export function parseLayout(raw: unknown, context: { beats: ReferenceBeat[]; until: number; caption_style?: string }): RemakeLayout {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const frameRaw = (o.frame && typeof o.frame === "object" ? o.frame : {}) as Record<string, unknown>;
  const band = readBox(frameRaw.band);
  // A "band" that is most of the frame, or a sliver, is a misread: treat the frame as full.
  const frame: RemakeLayout["frame"] = frameRaw.kind === "band" && band && band.h >= 0.2 && band.h <= 0.92 && band.w >= 0.6 ? { kind: "band", band } : { kind: "full" };

  const rawBeats = Array.isArray(o.beats) ? (o.beats as Array<Record<string, unknown>>) : [];
  const beats: RemakeBeat[] = context.beats.map((beat, i) => {
    const r = rawBeats.find((b) => num(b?.n) === i + 1) ?? rawBeats[i] ?? {};
    return {
      n: i + 1,
      start: beat.start,
      end: beat.end,
      presenter: {
        visible: r.visible !== false,
        speaking: typeof r.speaking === "boolean" ? r.speaking : Boolean(beat.line),
        box: readBox(r.box),
        framing: text(r.framing, 80),
        motion: text(r.motion, 500),
      },
    };
  });

  const rawGraphics = Array.isArray(o.graphics) ? (o.graphics as Array<Record<string, unknown>>) : [];
  const graphics: RemakeGraphic[] = rawGraphics
    .map((g) => {
      const box = readBox(g?.box);
      const start = clamp(num(g?.start), 0, context.until);
      const end = clamp(num(g?.end), 0, context.until);
      if (!box || !Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.3) return null;
      const entrance = (ENTRANCES as readonly string[]).includes(text(g.entrance, 20)) ? (text(g.entrance, 20) as Entrance) : "pop";
      return { id: "", kind: graphicKind(g.kind), box, start: round(start), end: round(end), shows: text(g.shows ?? g.description, 400), entrance };
    })
    .filter((g): g is RemakeGraphic => Boolean(g))
    .sort((a, b) => a.start - b.start)
    .slice(0, 16)
    .map((g, i) => ({ ...g, id: `g${i + 1}` }));

  const c = (o.captions && typeof o.captions === "object" ? o.captions : {}) as Record<string, unknown>;
  const style = context.caption_style ?? "";
  const perChunk = Number(style.match(/(\d)\s*(?:-|to)\s*(\d)\s*words?/)?.[2] ?? style.match(/(\d)\s*words?/)?.[1] ?? 3);
  const badgeRaw = (c.badge && typeof c.badge === "object" ? c.badge : null) as Record<string, unknown> | null;
  const badgeBox = badgeRaw ? readBox(badgeRaw.box ?? badgeRaw) : null;
  const outline = text(c.outline, 10);
  const captions: CaptionLook = {
    upper: c.case === "upper" || (c.case === undefined && /upper|caps/i.test(style)),
    italic: c.italic === true || (c.italic === undefined && /italic|slant/i.test(style)),
    color: hex(c.color, "#FFFFFF"),
    outline: outline === "none" || outline === "thin" || outline === "heavy" ? outline : /no outline/i.test(style) ? "none" : "heavy",
    shadow: c.shadow !== false,
    words: clamp(Math.round(num(c.words) || perChunk || 3), 1, 5),
    center_y: round(clamp(num(c.center_y) || 0.67, 0.12, 0.92), 4),
    size: round(clamp(num(c.size) || 0.03, 0.012, 0.07), 4),
    badge: badgeBox ? { box: badgeBox, color: hex(badgeRaw?.color, "#FFD43B"), accent: hex(badgeRaw?.accent, "#E5383B"), looks_like: text(badgeRaw?.looks_like, 120) } : null,
  };
  return { frame, set: text(o.set, 300), presenter: text(o.presenter, 300), beats, graphics, captions };
}

// ---------- the plan ----------

/** Where the remade footage sits on the 1080x1920 frame, in px: the band, or the whole frame. */
export type Stage = { x: number; y: number; width: number; height: number; band: boolean };

export function stageOf(layout: Pick<RemakeLayout, "frame">): Stage {
  if (layout.frame.kind !== "band") return { x: 0, y: 0, width: OUT.width, height: OUT.height, band: false };
  const { band } = layout.frame;
  const width = even(band.w * OUT.width);
  const height = even(band.h * OUT.height);
  return { x: clamp(even(band.x * OUT.width), 0, OUT.width - width), y: clamp(even(band.y * OUT.height), 0, OUT.height - height), width, height, band: true };
}

/** What the image and video models render: Veo makes 16:9 or 9:16, so a band is padded to the nearer one. */
export const modelAspect = (stage: Pick<Stage, "width" | "height">): "16:9" | "9:16" => (stage.width >= stage.height ? "16:9" : "9:16");
/** The canvas a reference frame is padded onto before the image edit. */
export const canvasOf = (aspect: "16:9" | "9:16") => (aspect === "16:9" ? { width: 1344, height: 756 } : { width: 756, height: 1344 });

export type RemakeShot = {
  n: number;
  /** The reference beat it belongs to (1-based). */
  beat: number;
  /** The reference time span it remakes. */
  start: number;
  end: number;
  /** Seconds the video model renders: 4, 6 or 8. */
  seconds: number;
  line: string;
  /** veo: re-rendered from a clean frame; swap: the reference footage with the person swapped (silent); still: the clean set, no one in it. */
  mode: "veo" | "swap" | "still";
  presenter: boolean;
  /** When the reference frame for the clean first frame is taken (just past the cut). */
  frame_at: number;
  frame_prompt: string;
  video_prompt: string;
};

export type PlannedGraphic = RemakeGraphic & { request: ScreenRequest; px: { x: number; y: number; width: number; height: number } };

export type RemakePlan = { stage: Stage; aspect: "16:9" | "9:16"; until: number; shots: RemakeShot[]; graphics: PlannedGraphic[]; captions: CaptionLook };

/**
 * A beat's span cut into shots: at the reference's own cuts (a jump in framing or position needs a
 * first frame of its own), never shorter than MIN_SHOT, and longer stretches split evenly so no shot
 * runs past what the video model renders.
 */
export function splitSpan(span: { start: number; end: number }, cuts: number[], max = MAX_SHOT, min = MIN_SHOT): Array<{ start: number; end: number }> {
  const points = [span.start];
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (cut - points[points.length - 1] >= min && span.end - cut >= min) points.push(cut);
  }
  points.push(span.end);
  const pieces: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const n = Math.max(1, Math.ceil((b - a) / max - 1e-9));
    for (let k = 0; k < n; k++) pieces.push({ start: round(a + ((b - a) * k) / n), end: round(a + ((b - a) * (k + 1)) / n) });
  }
  return pieces;
}

/** A line shared across consecutive shots by their length, breaking at a phrase end when one is near. */
export function splitLine(line: string, durations: number[]): string[] {
  const w = words(line);
  if (durations.length <= 1) return [w.join(" ")];
  const total = durations.reduce((sum, d) => sum + d, 0) || 1;
  const out: string[] = [];
  let from = 0;
  let acc = 0;
  durations.forEach((d, i) => {
    if (i === durations.length - 1) {
      out.push(w.slice(from).join(" "));
      return;
    }
    acc += d;
    const target = Math.round((acc / total) * w.length);
    let best = target;
    let bestScore = Infinity;
    for (let c = Math.max(from, target - 2); c <= Math.min(w.length, target + 2); c++) {
      const score = Math.abs(c - target) + (c > 0 && /[.,!?;:]["')]*$/.test(w[c - 1]) ? 0 : 1.5);
      if (score < bestScore) [best, bestScore] = [c, score];
    }
    out.push(w.slice(from, best).join(" "));
    from = best;
  });
  return out;
}

const pronoun = (persona: string) => (/\b(woman|girl|she|her|female|lady)\b/i.test(persona) ? "She" : /\b(man|guy|he|his|male|boy)\b/i.test(persona) ? "He" : "They");

/** The image edit that turns a reference frame into a clean first frame of ours. */
export function cleanFramePrompt(input: { persona: string; set: string; presenter: boolean; padded: boolean; framing?: string; fix?: string }): string {
  return [
    "The first image is a frame from a video. Make a clean photo of the same moment.",
    `Keep exactly: the camera angle and framing, the background${input.set ? ` (${lookOnly(input.set)})` : ""}, the lighting${input.presenter ? ", and the person's pose, gesture, position and size in the frame" : ""}.`,
    input.presenter
      ? `The person becomes the person in the second image: their face, hair, skin, build and outfit (${lookOnly(input.persona)}), with the same pose and expression as the person in the first image${input.framing ? `, framed ${input.framing}` : ""}.`
      : "There is no one in it: an empty set.",
    "Remove everything that was laid over the footage in editing: all words, pictures and stickers. Where they were, the background continues.",
    input.padded ? "The strips at the left and right edges are blurred filler: replace them with the background continuing naturally." : "",
    "Nothing written anywhere, no lettering or logos on clothes or walls. Photorealistic, natural skin texture, evenly lit like the first image.",
    input.fix ? `A reviewer rejected the previous version. Fix exactly this: ${input.fix}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Veo's prompt for one shot: the reference's motion, our persona, our line, and the house rules. */
export function shotPrompt(input: { persona: string; set: string; aspect: "16:9" | "9:16"; motion: string; line: string; delivery: string; framing?: string; presenter?: boolean }): string {
  const who = pronoun(input.persona);
  if (input.presenter === false) {
    // Nobody on screen (the reference shows only its set or a full graphic here): only the voice is used.
    return [
      `${input.aspect === "16:9" ? "Horizontal 16:9" : "Vertical 9:16"} video: one continuous, still shot of the empty set in the first frame, from a camera locked off on a tripod. No one appears.`,
      input.line ? `A ${who === "She" ? "woman's" : who === "He" ? "man's" : ""} voice off camera says, fast and casual: "${input.line}"`.replace("A  voice", "A voice") : "Silence apart from room tone.",
      "The voice is the same in every shot of this video: same person, same pitch, same energy.",
      "Audio: voice close to the microphone, quiet room tone, no music.",
      SAFE,
    ].join(" ");
  }
  const motion = presenterOnly(input.motion);
  // Delivery notes keep the voice; their gesture notes ("always pointing") fight the calm-hands rule.
  const delivery = presenterOnly(input.delivery.replace(/\s*\b(at\s+)?(about\s+|~)?\d+\s*wpm\b/gi, ""))
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b(hands?|point\w*|gestur\w*|arms?)\b/i.test(sentence))
    .slice(0, 2)
    .join(" ");
  return [
    `${input.aspect === "16:9" ? "Horizontal 16:9" : "Vertical 9:16"} video: one continuous shot from a camera locked off on a tripod. No camera move, no zoom, no cut.`,
    `The first frame is exact: keep the set, the light, and the presenter's position and size${input.framing ? ` (${input.framing})` : ""} as they are in it.`,
    `${lookOnly(input.persona)}, in front of ${lookOnly(input.set) || "the same background"}.`,
    motion ? `What ${who.toLowerCase() === "they" ? "they do" : `${who.toLowerCase()} does`}: ${motion.replace(/\.$/, "")}.` : "",
    input.line
      ? `${who} says, fast and casual${delivery ? `, with this delivery: ${delivery.replace(/\.$/, "")}` : ""}: "${input.line}"`
      : `${who} does not speak.`,
    "The voice is the same in every shot of this video: same person, same pitch, same energy.",
    input.line ? "Every word is fully said before the clip ends." : "",
    "Natural hands with five fingers, moving naturally; no fast spins, no pointing at the lens.",
    "Audio: voice close to the microphone, quiet room tone, no music.",
    SAFE,
  ]
    .filter(Boolean)
    .join(" ");
}

const KIND_LOOK: Record<GraphicKind, string> = {
  tweet: "an X (Twitter) style post card: round avatar, display name and handle, the post text, and a reply, repost and like row",
  social_post: "a social post card in the reference's network style (e.g. LinkedIn): round avatar, name and one-line headline, the post text, an image area if the reference has one, and a reactions row",
  photo: "a photo card: one real picture of the product filling the card (use one of the product's real images from the brand kit or visuals; never draw a fake photo)",
  chart: "a chart card of the same type as the reference's (bars, line or pie) on a plain card with a short title and axis labels. Bars compare only what the facts state; label them, and show numbers only when the facts give them",
  webcam: "a video-call tile: a dark tile with a simple flat illustrated avatar (no realistic face) and a name label",
  text_card: "a text card with the reference's layout: a short headline and at most one supporting line",
  game_scene: "a flat pixel-art scene in the reference's layout (sky, ground, props), generic, with no game characters or trademarks",
  other: "the same kind of element as the reference's",
};

/** One reference graphic → our screen request: the same kind of element at the same size, about our product. */
export function graphicRequest(graphic: RemakeGraphic, context: { stage: Pick<Stage, "width" | "height">; line: string; product: Pick<ProductBrief, "name"> }): PlannedGraphic {
  const px = {
    x: even(graphic.box.x * context.stage.width),
    y: even(graphic.box.y * context.stage.height),
    width: even(graphic.box.w * context.stage.width),
    height: even(graphic.box.h * context.stage.height),
  };
  px.width = Math.min(px.width, context.stage.width - px.x);
  px.height = Math.min(px.height, context.stage.height - px.y);
  const brief = [
    `${KIND_LOOK[graphic.kind]}.`,
    graphic.shows ? `The reference's version shows: ${graphic.shows}.` : "",
    `Ours is the same kind of element, about ${context.product.name}, showing what this line says: "${context.line}".`,
    `Names, handles, quotes and numbers come only from the product facts: any account shown is ${context.product.name}'s own, and counts the facts do not give are left out.`,
    "It is placed on the video at exactly this size and fills it edge to edge.",
  ]
    .filter(Boolean)
    .join(" ");
  const request: ScreenRequest = {
    id: graphic.id,
    brief,
    line: context.line,
    seconds: round(Math.max(1, graphic.end - graphic.start + 0.5), 2),
    reference_visual: `${graphic.kind.replace(/_/g, " ")}: ${graphic.shows}`,
    size: "full",
    box: { width: px.width, height: px.height },
  };
  return { ...graphic, request, px };
}

/**
 * The remake's shots and graphics. Each reference beat becomes one or more shots (see splitSpan)
 * that share its line; a shot with a speaking or visible presenter is re-rendered on Veo, a silent
 * shot of a visible presenter can be swapped on the reference footage instead (`swapSilent`), and a
 * shot with no one in it and nothing said is the clean set as a still.
 */
export function planRemake(
  layout: RemakeLayout,
  input: { lines: string[]; cuts: number[]; until: number; persona: string; delivery: string; product: Pick<ProductBrief, "name">; swapSilent?: boolean },
): RemakePlan {
  const stage = stageOf(layout);
  const aspect = modelAspect(stage);
  const shots: RemakeShot[] = [];
  layout.beats.forEach((beat, i) => {
    const pieces = splitSpan(beat, input.cuts);
    const lines = splitLine(input.lines[i] ?? "", pieces.map((p) => p.end - p.start));
    pieces.forEach((piece, k) => {
      const line = lines[k] ?? "";
      const presenter = beat.presenter.visible;
      const mode: RemakeShot["mode"] = !line && !presenter ? "still" : !line && presenter && input.swapSilent ? "swap" : "veo";
      const span = piece.end - piece.start;
      const motion = [k > 0 ? "Continuing the same movement." : "", beat.presenter.motion].filter(Boolean).join(" ");
      shots.push({
        n: shots.length + 1,
        beat: beat.n,
        start: piece.start,
        end: piece.end,
        seconds: snapSeconds(Math.min(MAX_SHOT, Math.max(span, words(line).length / VEO_WPS) + 0.3)),
        line,
        mode,
        presenter,
        frame_at: round(piece.start + Math.min(0.15, span / 4)),
        frame_prompt: cleanFramePrompt({ persona: input.persona, set: layout.set, presenter, padded: stage.band && aspect === "16:9", framing: beat.presenter.framing }),
        video_prompt: shotPrompt({ persona: input.persona, set: layout.set, aspect, motion, line, delivery: input.delivery, framing: beat.presenter.framing, presenter }),
      });
    });
  });
  const lineAt = (start: number, end: number) =>
    layout.beats
      .map((beat, i) => ({ beat, line: input.lines[i] ?? "" }))
      .filter(({ beat, line }) => line && beat.start < end && beat.end > start)
      .map(({ line }) => line)
      .join(" ");
  const graphics = layout.graphics.map((graphic) => graphicRequest(graphic, { stage, line: lineAt(graphic.start, graphic.end), product: input.product }));
  return { stage, aspect, until: input.until, shots, graphics, captions: layout.captions };
}

// ---------- timing ----------

/** Where the speech is in a rendered clip: after its leading silence, before its trailing one. */
export function speechSpan(silences: Array<{ start: number; end: number }>, duration: number): { from: number; to: number } | null {
  if (!(duration > 0)) return null;
  const lead = silences.find((s) => s.start <= 0.15);
  const tail = [...silences].reverse().find((s) => s.end >= duration - 0.3);
  const from = lead ? Math.min(lead.end, duration) : 0;
  const to = tail && tail.start > from ? tail.start : duration;
  return to - from < 0.3 ? null : { from: round(from), to: round(to) };
}

/** A shot placed on the finished video: its reference span, its span on our timeline, and where in its clip it starts. */
export type Placed = { n: number; ref_start: number; ref_end: number; out_start: number; out_end: number; from: number; speech: { from: number; to: number } | null };

/**
 * Lays the shots end to end. Each keeps its reference length; a shot whose line runs longer gets the
 * extra time (the remake drifts a little rather than cutting a word), and the silence a render opens
 * with is skipped, as the reference cuts straight into speech.
 */
export function placeShots(shots: Array<Pick<RemakeShot, "n" | "start" | "end" | "line" | "mode">>, clips: Array<{ duration: number; speech: { from: number; to: number } | null }>): Placed[] {
  let at = 0;
  return shots.map((shot, i) => {
    const span = shot.end - shot.start;
    const clip = clips[i] ?? { duration: span, speech: null };
    let from = 0;
    let seconds = span;
    let speech: Placed["speech"] = null;
    if (shot.mode === "veo" && shot.line && clip.speech) {
      from = clamp(clip.speech.from - 0.08, 0, 0.6);
      seconds = Math.max(span, Math.min(clip.speech.to + 0.15, clip.duration) - from);
      speech = { from: round(Math.max(0, clip.speech.from - from)), to: round(Math.min(seconds, clip.speech.to - from)) };
    }
    const placed = { n: shot.n, ref_start: shot.start, ref_end: shot.end, out_start: round(at), out_end: round(at + seconds), from: round(from), speech };
    at += seconds;
    return placed;
  });
}

/** A reference time on our timeline, through the shot it falls in. */
export function mapTime(placed: Placed[], t: number): number {
  if (!placed.length) return t;
  for (const p of placed) {
    if (t <= p.ref_end + 1e-6) {
      const f = clamp((t - p.ref_start) / (p.ref_end - p.ref_start || 1), 0, 1);
      return round(p.out_start + f * (p.out_end - p.out_start));
    }
  }
  return placed[placed.length - 1].out_end;
}

/** Spoken captions: each shot's line over the time it is spoken, chunked like the reference's. */
export function remakeCaptions(shots: Array<Pick<RemakeShot, "line">>, placed: Placed[], wordsPerChunk: number): EditTimeline["captions"] {
  const segments = shots
    .map((shot, i) => {
      const p = placed[i];
      if (!shot.line || !p) return null;
      const from = p.out_start + (p.speech?.from ?? 0);
      const to = p.speech ? p.out_start + p.speech.to : p.out_end;
      return { start: round(from), end: round(Math.max(from + 0.3, to)), text: shot.line };
    })
    .filter((s): s is { start: number; end: number; text: string } => Boolean(s));
  return chunkCaptions(segments, wordsPerChunk);
}

/** The caption look in the units toAss takes (px at 1080x1920). */
export function captionStyle(look: CaptionLook): CaptionStyle {
  const em = clamp(Math.round((look.size * OUT.height) / 0.7), 44, 130);
  const color = (value: string) => Number.parseInt(value.replace("#", ""), 16);
  const badge = look.badge
    ? {
        x: Math.round((look.badge.box.x + look.badge.box.w / 2) * OUT.width),
        y: Math.round((look.badge.box.y + look.badge.box.h / 2) * OUT.height),
        size: clamp(Math.round(Math.max(look.badge.box.w * OUT.width, look.badge.box.h * OUT.height)), 40, 240),
        color: color(look.badge.color),
        accent: color(look.badge.accent),
      }
    : null;
  return {
    upper: look.upper,
    italic: look.italic,
    color: color(look.color),
    outline: look.outline === "none" ? 0 : look.outline === "thin" ? 4 : 8,
    shadow: look.shadow,
    em,
    bottom: round(clamp(look.center_y + look.size / 2 + 0.004, 0.2, 0.95), 4),
    badge,
  };
}

// ---------- ffmpeg arguments ----------

/** The reference frame at `at`, cropped to the stage and fitted onto the model's canvas over a blurred copy of itself. */
export function referenceFrameArgs(input: { reference: string; at: number; crop: { x: number; y: number; width: number; height: number } | null; canvas: { width: number; height: number }; out: string }): string[] {
  const { width: W, height: H } = input.canvas;
  const crop = input.crop ? `crop=${even(input.crop.width)}:${even(input.crop.height)}:${Math.round(input.crop.x)}:${Math.round(input.crop.y)},` : "";
  const graph = [
    `[0:v]${crop}setsar=1,split[a][b]`,
    `[b]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=24[bg]`,
    `[a]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgb24[out]`,
  ].join(";");
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", fmt(input.at), "-i", input.reference, "-frames:v", "1", "-filter_complex", graph, "-map", "[out]", input.out];
}

/** The reference footage of one shot, cropped to the stage, silent: what the person swap edits. */
export function referenceClipArgs(input: { reference: string; start: number; seconds: number; crop: { x: number; y: number; width: number; height: number } | null; out: string }): string[] {
  const crop = input.crop ? `crop=${even(input.crop.width)}:${even(input.crop.height)}:${Math.round(input.crop.x)}:${Math.round(input.crop.y)},` : "";
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", fmt(input.start), "-t", fmt(input.seconds), "-i", input.reference, "-vf", `${crop}setsar=1,format=yuv420p`, "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "16", input.out];
}

export type BandPiece = { path: string; kind: "video" | "image"; from: number; seconds: number; hasAudio: boolean };

/**
 * The shots cut together at stage size, with their audio: each cropped to the stage's aspect (the
 * centre of a padded render is the reference's composition), held on its last frame if it runs
 * short, and silent where it has no sound.
 */
export function bandArgs(pieces: BandPiece[], stage: Pick<Stage, "width" | "height">, out: string): string[] {
  const { fps } = OUT;
  const aspect = fmt(stage.width / stage.height);
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  const graph: string[] = [];
  const parts: string[] = [];
  let inputs = 0;
  pieces.forEach((piece, i) => {
    const frames = Math.max(1, Math.round(piece.seconds * fps));
    const seconds = fmt(frames / fps);
    const v = inputs++;
    if (piece.kind === "image") args.push("-loop", "1", "-t", fmt(piece.seconds + 0.5), "-i", piece.path);
    else args.push("-ss", fmt(piece.from), "-t", fmt(piece.seconds + 0.5), "-i", piece.path);
    graph.push(
      `[${v}:v]crop='min(iw,ih*${aspect})':'min(ih,iw/${aspect})',scale=${stage.width}:${stage.height}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=${fmt(piece.seconds + 1)},trim=end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`,
    );
    if (piece.kind === "video" && piece.hasAudio) {
      graph.push(`[${v}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=${seconds},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      const a = inputs++;
      args.push("-f", "lavfi", "-t", seconds, "-i", "anullsrc=r=48000:cl=stereo");
      graph.push(`[${a}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=end=${seconds},asetpts=PTS-STARTPTS[a${i}]`);
    }
    parts.push(`[v${i}][a${i}]`);
  });
  graph.push(`${parts.join("")}concat=n=${pieces.length}:v=1:a=1[v][a]`);
  return [...args, "-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out];
}

/** Overlay position expressions and fade-in length for a graphic's entrance, starting at `start`. */
export function entrance(kind: Entrance, x: number, y: number, start: number): { x: string; y: string; fade: number } {
  const back = `pow(1-min(1,max(0,(t-${fmt(start)})/0.3)),3)`;
  switch (kind) {
    case "slide_up":
      return { x: `${x}`, y: `${y}+90*${back}`, fade: 0.12 };
    case "slide_left":
      return { x: `${x}+140*${back}`, y: `${y}`, fade: 0.12 };
    case "slide_right":
      return { x: `${x}-140*${back}`, y: `${y}`, fade: 0.12 };
    case "pop":
      return { x: `${x}`, y: `${y}+30*${back}`, fade: 0.15 };
    case "fade":
      return { x: `${x}`, y: `${y}`, fade: 0.25 };
    default:
      return { x: `${x}`, y: `${y}`, fade: 0 };
  }
}

export type ComposeGraphic = { path: string; kind: "video" | "image"; start: number; end: number; x: number; y: number; width: number; height: number; entrance: Entrance };

/**
 * The finished frame: graphics over the band at their boxes for their windows, then (for a band
 * layout) the band over a blurred, zoomed copy of itself filling the frame, the way the reference's
 * editor built it, then the captions. `ass` is a file name in the working directory (cwd).
 */
export function composeArgs(input: { band: string; stage: Stage; duration: number; graphics: ComposeGraphic[]; ass: string | null; out: string }): string[] {
  const { fps, width: W, height: H } = OUT;
  const frames = Math.max(1, Math.round(input.duration * fps));
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", input.band];
  const graph = [`[0:v]fps=${fps},setsar=1,format=yuv420p[s0]`];
  input.graphics.forEach((g, k) => {
    const len = Math.max(1 / fps, g.end - g.start);
    const n = Math.max(1, Math.round(len * fps));
    if (g.kind === "image") args.push("-loop", "1", "-t", fmt(len + 1), "-i", g.path);
    else args.push("-i", g.path);
    const motion = entrance(g.entrance, g.x, g.y, g.start);
    const fade = motion.fade ? `,fade=t=in:st=0:d=${motion.fade}:alpha=1` : "";
    graph.push(
      `[${k + 1}:v]scale=${g.width}:${g.height}:flags=lanczos,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${fmt(len + 1)},trim=end_frame=${n},format=yuva420p${fade},setpts=PTS-STARTPTS+${fmt(g.start)}/TB[g${k}]`,
      `[s${k}][g${k}]overlay=x='${motion.x}':y='${motion.y}':eof_action=pass:enable='between(t,${fmt(g.start)},${fmt(g.end)})'[s${k + 1}]`,
    );
  });
  const last = `s${input.graphics.length}`;
  if (input.stage.band) {
    graph.push(
      `[${last}]split[fg][bgsrc]`,
      `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=30:steps=2,eq=brightness=-0.03[bg]`,
      `[bg][fg]overlay=${input.stage.x}:${input.stage.y}[full]`,
    );
  } else {
    graph.push(`[${last}]scale=${W}:${H}:flags=lanczos,setsar=1[full]`);
  }
  graph.push(input.ass ? `[full]ass=filename=${input.ass}:fontsdir=fonts,format=yuv420p,trim=end_frame=${frames}[vout]` : `[full]format=yuv420p,trim=end_frame=${frames}[vout]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[vout]", "-map", "0:a", "-t", fmt(frames / fps));
  args.push("-r", String(fps), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", input.out);
  return args;
}

// ---------- the analysis ----------

const BOX_SCHEMA = {
  type: "object",
  required: ["x", "y", "w", "h"],
  properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
  description: "Fractions 0-1: x and y of the top-left corner, then width and height.",
};

const LAYOUT_TOOL = {
  name: "remake_layout",
  description: "Record how the video is built, for a one-to-one remake.",
  input_schema: {
    type: "object",
    required: ["frame", "set", "presenter", "beats", "graphics", "captions"],
    properties: {
      frame: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["full", "band"], description: "band: the footage sits in a horizontal band across the frame, with blurred, zoomed copies filling above and below." },
          band: { ...BOX_SCHEMA, description: "For band: the band's box in fractions of the whole frame." },
        },
      },
      set: { type: "string", description: "The filmed background alone, without the person and without anything laid over it." },
      presenter: { type: "string", description: "The original presenter's look in a few words." },
      beats: {
        type: "array",
        items: {
          type: "object",
          required: ["n", "visible", "speaking", "framing", "motion"],
          properties: {
            n: { type: "integer" },
            visible: { type: "boolean" },
            speaking: { type: "boolean" },
            box: { ...BOX_SCHEMA, description: "The presenter at the beat's start, in fractions of the stage." },
            framing: { type: "string", description: "full-length, knees-up, waist-up, chest-up or close-up, and where on the stage (left third, centre, bottom-left corner)." },
            motion: { type: "string", description: "Body motion only, in order: where they stand and move to, how they gesture, lean or turn, jumps in size or position. No clothing, text or graphics." },
          },
        },
      },
      graphics: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "box", "start", "end", "shows", "entrance"],
          properties: {
            kind: { type: "string", enum: [...GRAPHIC_KINDS] },
            box: { ...BOX_SCHEMA, description: "In fractions of the stage." },
            start: { type: "number", description: "Seconds, when it first appears." },
            end: { type: "number", description: "Seconds, when it is gone." },
            shows: { type: "string", description: "What it shows, in one sentence." },
            entrance: { type: "string", enum: [...ENTRANCES] },
          },
        },
      },
      captions: {
        type: "object",
        required: ["case", "italic", "color", "outline", "shadow", "words", "center_y", "size"],
        properties: {
          case: { type: "string", enum: ["upper", "lower", "sentence"] },
          italic: { type: "boolean" },
          color: { type: "string", description: "#RRGGBB of the letters." },
          outline: { type: "string", enum: ["none", "thin", "heavy"] },
          shadow: { type: "boolean" },
          words: { type: "integer", description: "Words on screen at once." },
          center_y: { type: "number", description: "Vertical centre of the caption line, as a fraction of the whole frame's height." },
          size: { type: "number", description: "Height of a capital letter, as a fraction of the whole frame's height." },
          badge: {
            type: ["object", "null"],
            properties: { box: BOX_SCHEMA, color: { type: "string" }, accent: { type: "string" }, looks_like: { type: "string" } },
            description: "A sticker or emoji badge that sits by the captions, in fractions of the whole frame; null if none.",
          },
        },
      },
    },
  },
};

/** Naive's message API takes at most 12 images per request (found on the first live run). */
export const MAX_ANALYSIS_FRAMES = 12;

/** When to look at the reference: just after each beat starts, then evenly between, at most `max` frames. */
export function sampleTimes(beats: Array<Pick<ReferenceBeat, "start">>, end: number, max = MAX_ANALYSIS_FRAMES): number[] {
  const step = Math.max(0.75, end / Math.max(1, max - beats.length));
  const times = [...beats.map((b) => b.start + 0.25)];
  for (let t = 0.2; t < end - 0.1; t += step) times.push(t);
  const sorted = times.filter((t) => t >= 0 && t < end).sort((a, b) => a - b);
  const spaced = sorted.filter((t, i) => i === 0 || t - sorted[i - 1] >= 0.35);
  if (spaced.length <= max) return spaced.map((t) => round(t, 2));
  return Array.from({ length: max }, (_, i) => round(spaced[Math.round((i * (spaced.length - 1)) / (max - 1))], 2));
}

function layoutPrompt(breakdown: ReferenceBreakdown, beats: ReferenceBeat[], end: number) {
  return [
    `These are frames from a viral vertical video (0 to ${end.toFixed(1)} s), each labelled with its time. We will remake it one to one: the same layout, framing, moves, cuts, graphics and caption look, with a different presenter, different words and a different product. Describe how it is built, precisely enough for an editor to rebuild it.`,
    `Its beats, from the transcript:\n${JSON.stringify(beats.map((b, i) => ({ n: i + 1, start: b.start, end: b.end, line: b.line, visual: b.visual })))}`,
    `Notes from an earlier breakdown: format: ${breakdown.format}. Captions: ${breakdown.caption_style}.`,
    "- frame: band when the footage sits in a horizontal band across the middle of the 9:16 frame with a blurred, zoomed copy filling above and below (give the band's box in fractions of the whole frame); full when the footage fills the frame.",
    "- The stage is the band (or the whole frame for full). Every box except the captions' badge is in fractions of the stage: x and y of the top-left corner, then w and h, each 0 to 1.",
    "- set: the filmed background alone, without the person and without anything laid over it.",
    "- beats: for every beat n, whether the presenter is visible and speaking, their box at the beat's start (head to lowest visible point), their framing and place on the stage, and their motion during the beat in plain body terms. Mention any jump in their size or position.",
    "- graphics: every element laid over the footage in editing apart from the captions: posts, screenshots, photos, charts, webcam insets, text cards, game scenes, stickers. Give its kind, its box on the stage, when it appears and when it is gone (in seconds, from the frame labels), what it shows in one sentence, and how it enters. One entry per element per appearance.",
    "- captions: the spoken-word captions' case, slant, colour, outline and shadow, how many words show at once, the vertical centre of the caption line and the height of a capital letter as fractions of the whole frame's height, and any sticker or emoji badge beside them.",
    "Call the remake_layout tool once.",
  ].join("\n");
}

type Messenger = Pick<NaiveClient, "message">;

/** The vision pass: sampled frames of the reference (up to `end`) and its breakdown → its layout. */
export async function analyzeReference(naive: Messenger, input: { referencePath: string; breakdown: ReferenceBreakdown; beats: ReferenceBeat[]; end: number }): Promise<RemakeLayout> {
  const times = sampleTimes(input.beats, input.end);
  const frames: Array<{ t: number; jpeg: Buffer }> = [];
  for (const t of times) {
    const jpeg = await grabJpeg(input.referencePath, t, 360).catch(() => null);
    if (jpeg?.length) frames.push({ t, jpeg });
  }
  if (!frames.length) throw new Error("remake: no frames could be read from the reference");
  const content = [
    ...frames.flatMap(({ t, jpeg }) => [
      { type: "text", text: `t=${t.toFixed(2)} s` },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
    ]),
    { type: "text", text: layoutPrompt(input.breakdown, input.beats, input.end) },
  ];
  const context = { beats: input.beats, until: input.end, caption_style: input.breakdown.caption_style };
  const reply = await naive.message({ model: QC_MODEL, max_tokens: 6000, messages: [{ role: "user", content }], tools: [LAYOUT_TOOL] });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === LAYOUT_TOOL.name);
  let raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Record<string, unknown> | null;
  if (!raw?.frame) {
    const again = await naive.message({
      model: QC_MODEL,
      max_tokens: 6000,
      messages: [{ role: "user", content: [...content.slice(0, -1), { type: "text", text: `${layoutPrompt(input.breakdown, input.beats, input.end).replace("Call the remake_layout tool once.", "")}\nAnswer with only one JSON object with the keys frame, set, presenter, beats, graphics and captions.` }] }],
    });
    raw = extractJson(again.content.map((block) => block.text ?? "").join("\n")) as Record<string, unknown> | null;
    if (!raw?.frame) throw new ApiError("naive", 502, "layout_unreadable", "the reference analysis returned no layout");
  }
  return parseLayout(raw, context);
}

// ---------- running it ----------

export type RemakeClient = Pick<NaiveClient, "message" | "generateImage" | "generateVideo" | "getMediaJob" | "uploadFile" | "fileUrl"> & Partial<Pick<NaiveClient, "editVideo" | "getVideoEdit">>;

export type RemakeInput = {
  /** The reference video, local. */
  referencePath: string;
  breakdown: ReferenceBreakdown;
  /** Our line for each reference beat, in order ("" for a silent beat). */
  lines: string[];
  /** A photo of our presenter. */
  personaPath: string;
  /** Our presenter's look, in words (for prompts and the gate). */
  persona: string;
  /** The reference's delivery, for the voice. Defaults to the breakdown's. */
  delivery?: string;
  product: ProductBrief;
  kit: BrandKit | null;
  /** Where frames, renders, graphics and the manifest go; a rerun resumes from it. */
  workDir: string;
  outPath: string;
  /** Prefix of every Naive idempotency key: stable per video, so a rerun never pays twice. */
  idem: string;
  /** Remake only the beats that start before this many seconds (the live test does the first ~15 s). */
  until?: number;
  videoModel?: string;
  /** Swap the person on the reference footage for silent shots of a visible presenter (Mira, about $1.48 a shot). */
  swapSilent?: boolean;
  /** A spending cap: refuse, before any render, a plan with more seconds of video renders than this (about $0.40 each). */
  maxRenderSeconds?: number;
  /** Poll interval for renders (default 10 s). */
  pollMs?: number;
  onEvent?: (message: string) => void;
  /** Saves a Naive file locally (default: its signed link, downloaded). */
  fetchFile?: (fileId: string, path: string) => Promise<void>;
  /** Builds graphics (default: the screen builder, with headless Chrome). */
  buildGraphics?: (requests: ScreenRequest[], workDir: string) => Promise<{ clips: ScreenClip[]; failures: Array<{ id: string; error: string }> }>;
};

export type RemakeResult = { path: string; duration: number; layout: RemakeLayout; plan: RemakePlan; cost_micro: number; failures: string[] };

type ShotRecord = {
  key: string;
  ref_file?: string;
  frame_file?: string;
  frame_tries?: number;
  frame_fix?: string;
  frame_done?: boolean;
  job?: string;
  renders?: number;
  video?: string;
};

type Manifest = {
  layout?: RemakeLayout;
  persona_file?: string;
  persona_path?: string;
  shots: Record<string, ShotRecord>;
  graphics?: { key: string; clips: Array<{ id: string; kind: "video" | "image"; path: string }>; failures: Array<{ id: string; error: string }> };
  cost_micro: number;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/** The file a finished media job produced, whatever shape its result has. */
export function jobFile(job: unknown): string | null {
  const r = (job ?? {}) as { result?: { files?: Array<{ file_id?: string; id?: string }>; file_id?: string } | null; file_id?: string };
  return r.result?.files?.[0]?.file_id ?? r.result?.files?.[0]?.id ?? r.result?.file_id ?? r.file_id ?? null;
}

async function ffmpegBin(): Promise<string> {
  const bin = await editFfmpeg();
  if (!bin) throw new Error("No ffmpeg with libass found: install the ffmpeg-static package or set FFMPEG_PATH to an ffmpeg built with libass.");
  return bin;
}

async function run(args: string[], options: { cwd?: string } = {}) {
  try {
    await exec(await ffmpegBin(), args, { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`remake: ffmpeg failed${stderr ? `: ${stderr.slice(-1500)}` : ""}`);
  }
}

/** One frame of a video or an image as a JPEG `width` px wide. */
async function grabJpeg(path: string, at: number | null, width = 540): Promise<Buffer> {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (at !== null) args.push("-ss", fmt(at));
  args.push("-i", path, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", "-f", "mjpeg", "pipe:1");
  const { stdout } = await exec(await ffmpegBin(), args, { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

/** Where the speech sits in a clip, from ffmpeg's silencedetect. */
async function speechOf(path: string, duration: number): Promise<{ from: number; to: number } | null> {
  const { stderr } = await exec(await ffmpegBin(), ["-hide_banner", "-nostats", "-i", path, "-af", "silencedetect=noise=-32dB:d=0.3", "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 }).catch(
    (error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }),
  );
  return speechSpan(parseSilences(String(stderr), duration), duration);
}

const contentType = (path: string) => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4" })[extname(path).toLowerCase()] ?? "application/octet-stream";

/** A neutral portrait of our presenter, when the brand has none yet: the reference every clean frame swaps in. */
export function personaPrompt(persona: string): string {
  return [
    "A candid photograph of one person standing, from the knees up, facing the camera with a relaxed neutral expression, arms loose at their sides.",
    `${lookOnly(persona)}.`,
    "Plain light-grey studio background, soft even light. Photorealistic, natural skin texture. Nothing written anywhere, no logos or print on clothes.",
  ].join(" ");
}

/** Makes (once) the photo of our presenter that clean frames copy, when none was given. */
export async function ensurePersona(naive: Pick<NaiveClient, "generateImage" | "fileUrl">, input: { persona: string; path: string; idem: string; fetchFile?: (fileId: string, path: string) => Promise<void> }): Promise<{ path: string; cost_micro: number }> {
  if (existsSync(input.path)) return { path: input.path, cost_micro: 0 };
  const result = await naive.generateImage({ prompt: personaPrompt(input.persona), aspect_ratio: "9:16" }, `${input.idem}-persona`);
  const file = result.files[0];
  if (!file) throw new ApiError("naive", 502, "no_file", "the persona image came back empty");
  await mkdir(resolve(input.path, ".."), { recursive: true });
  await (input.fetchFile ?? (async (id: string, to: string) => void (await download((await naive.fileUrl(id)).url, to))))(file.id, input.path);
  return { path: input.path, cost_micro: result.cost_micro_usd ?? 0 };
}

/**
 * The whole remake from local files: analysis, plan, clean frames, renders, graphics and the cut.
 * Resumable: every step is cached in `workDir` (manifest.json) and every Naive call uses a stable
 * idempotency key, so a rerun after a crash, a restart or a retryable provider error (thrown as an
 * ApiError with `.retryable`) picks up where it stopped without paying again.
 */
export async function remakeVideo(naive: RemakeClient, input: RemakeInput): Promise<RemakeResult> {
  const workDir = resolve(input.workDir);
  for (const dir of ["frames", "shots", "graphics"]) await mkdir(join(workDir, dir), { recursive: true });
  const manifestPath = join(workDir, "manifest.json");
  const manifest: Manifest = existsSync(manifestPath) ? { shots: {}, cost_micro: 0, ...JSON.parse(await readFile(manifestPath, "utf8")) } : { shots: {}, cost_micro: 0 };
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(() => writeFile(manifestPath, JSON.stringify(manifest, null, 1))));
  const say = (message: string) => input.onEvent?.(message);
  const failures: string[] = [];
  const fetchFile = input.fetchFile ?? (async (fileId: string, path: string) => void (await download((await naive.fileUrl(fileId)).url, path)));
  const pollMs = input.pollMs ?? 10_000;

  const info = await probe(input.referencePath);
  if (!info.duration || !info.width) throw new Error(`remake: ${input.referencePath} is not a playable video`);
  const span = remakeSpan(input.breakdown.beats, input.until);
  if (!span.beats.length) throw new Error("remake: the reference breakdown has no beats");
  const end = Math.min(span.end, info.duration);

  // 1. How the reference is built.
  if (!manifest.layout || manifest.layout.beats.length !== span.beats.length) {
    say(`Reading the reference's layout from its frames (0-${end.toFixed(1)} s)`);
    manifest.layout = await analyzeReference(naive, { referencePath: input.referencePath, breakdown: input.breakdown, beats: span.beats, end });
    await save();
  }
  const layout = manifest.layout;

  // 2. The plan: shots split at the reference's own cuts.
  const cuts = await detectCuts(input.referencePath, 0.3, info.duration).catch(() => [] as number[]);
  const lines = span.beats.map((_, i) => input.lines[i] ?? "");
  const plan = planRemake(layout, {
    lines,
    cuts,
    until: end,
    persona: input.persona,
    delivery: input.delivery ?? input.breakdown.delivery,
    product: input.product,
    swapSilent: Boolean(input.swapSilent && naive.editVideo && naive.getVideoEdit),
  });
  await writeFile(join(workDir, "plan.json"), JSON.stringify(plan, null, 1));
  const renderSeconds = plan.shots.reduce((s, shot) => s + (shot.mode === "veo" ? shot.seconds : 0), 0);
  say(`Plan: ${plan.shots.length} shots (${renderSeconds} s of video renders), ${plan.graphics.length} graphics, ${layout.frame.kind === "band" ? "a centre band over a blurred fill" : "full frame"}`);
  if (input.maxRenderSeconds !== undefined && renderSeconds > input.maxRenderSeconds) {
    throw new Error(`remake: the plan needs ${renderSeconds} s of video renders, over the cap of ${input.maxRenderSeconds} s; see ${join(workDir, "plan.json")}`);
  }
  const records = plan.shots.map((shot) => {
    const key = hash([shot.start, shot.end, shot.line, shot.mode, shot.frame_prompt, shot.video_prompt]);
    const old = manifest.shots[shot.n];
    if (!old || old.key !== key) manifest.shots[shot.n] = { key };
    return manifest.shots[shot.n];
  });
  await save();

  // The stage in the reference's pixels, for frames and swap clips.
  const crop = layout.frame.kind === "band" ? { x: layout.frame.band.x * info.width, y: layout.frame.band.y * info.height, width: layout.frame.band.w * info.width, height: layout.frame.band.h * info.height } : null;

  // 3. Graphics build on the screen builder while the frames and renders run.
  const graphicsKey = hash(plan.graphics.map((g) => g.request));
  const graphicsJob = (async () => {
    if (!plan.graphics.length) return;
    if (manifest.graphics?.key === graphicsKey) return;
    const build =
      input.buildGraphics ??
      ((requests: ScreenRequest[], dir: string) => buildScreens(naive, requests, { product: input.product, kit: input.kit, style: input.breakdown.format }, { workDir: dir, render: { pushIn: 0 }, keepFailed: true }));
    say(`Building ${plan.graphics.length} graphics in the reference's places`);
    const result = await build(plan.graphics.map((g) => g.request), join(workDir, "graphics"));
    manifest.graphics = { key: graphicsKey, clips: result.clips.map(({ id, kind, path }) => ({ id, kind, path })), failures: result.failures.map(({ id, error }) => ({ id, error })) };
    await save();
  })();
  // Never left unhandled while the frames run; awaited (and its error rethrown) before the cut.
  graphicsJob.catch(() => undefined);

  // 4. Our presenter, uploaded once.
  const personaBytes = await readFile(input.personaPath);
  if (!manifest.persona_file || manifest.persona_path !== resolve(input.personaPath)) {
    manifest.persona_file = await naive.uploadFile(`${input.idem}-persona${extname(input.personaPath) || ".png"}`, contentType(input.personaPath), personaBytes);
    manifest.persona_path = resolve(input.personaPath);
    await save();
  }
  const personaJpeg = await grabJpeg(input.personaPath, null).catch(() => null);

  // 5. A clean first frame for every shot that needs one, gated before any render.
  const canvas = canvasOf(plan.aspect);
  const framed = plan.shots.filter((shot) => shot.mode !== "swap");
  await pool(framed, 3, async (shot) => {
    const rec = records[shot.n - 1];
    const refPng = join(workDir, "frames", `shot${shot.n}-reference.png`);
    const cleanPng = join(workDir, "frames", `shot${shot.n}-clean.png`);
    if (rec.frame_done && rec.frame_file && existsSync(cleanPng)) return;
    if (!existsSync(refPng)) await run(referenceFrameArgs({ reference: input.referencePath, at: shot.frame_at, crop, canvas, out: refPng }));
    rec.ref_file ??= await naive.uploadFile(`${input.idem}-shot${shot.n}-reference.png`, "image/png", await readFile(refPng));
    await save();
    const refJpeg = await grabJpeg(refPng, null);
    while (!rec.frame_done) {
      const tries = rec.frame_tries ?? 0;
      const prompt = cleanFramePrompt({ persona: input.persona, set: layout.set, presenter: shot.presenter, padded: plan.stage.band && plan.aspect === "16:9", framing: layout.beats[shot.beat - 1]?.presenter.framing, fix: rec.frame_fix });
      const image = await withInFlight(() =>
        naive.generateImage({ prompt, aspect_ratio: plan.aspect, image_urls: shot.presenter ? [rec.ref_file!, manifest.persona_file!] : [rec.ref_file!] }, `${input.idem}-shot${shot.n}-clean${tries ? `-g${tries}` : ""}-${rec.key}`),
      pollMs);
      const file = image.files[0];
      if (!file) throw new ApiError("naive", 502, "no_file", `shot ${shot.n}: the clean frame came back empty`);
      manifest.cost_micro += image.cost_micro_usd ?? 0;
      rec.frame_file = file.id;
      rec.frame_tries = tries + 1;
      await fetchFile(file.id, cleanPng);
      await save();
      let verdict: { pass: boolean; issues: string[] } = { pass: true, issues: [] };
      try {
        verdict = await reviewFrame(naive, { image: await grabJpeg(cleanPng, null), creator: input.persona, setting: layout.set, prompt, persona: shot.presenter ? personaJpeg : null, reference: refJpeg });
      } catch (error) {
        if (error instanceof ApiError && error.outOfCredits) throw error;
        // A check that cannot run (busy, unreadable) never holds the video up, as in production.
      }
      if (verdict.pass || rec.frame_tries >= FRAME_TRIES) {
        if (!verdict.pass) failures.push(`shot ${shot.n}: first frame kept after ${FRAME_TRIES} tries (${verdict.issues.join("; ").slice(0, 200)})`);
        rec.frame_done = true;
      } else {
        rec.frame_fix = verdict.issues.slice(0, 3).join(" ").replace(/(['"‘“])[^'"’”]{0,200}(['"’”])/g, "").slice(0, 500);
        say(`Shot ${shot.n}: remaking its first frame (${verdict.issues.join("; ").slice(0, 200)})`);
      }
      await save();
    }
  });

  // 6. Renders: Veo for presenter shots, Mira for swapped silent ones; all submitted, then polled.
  const model = input.videoModel ?? REMAKE_VIDEO_MODEL;
  const pending = new Set<number>();
  const submit = async (shot: RemakeShot) => {
    const rec = records[shot.n - 1];
    const renders = rec.renders ?? 0;
    if (renders >= RENDER_TRIES) throw new Error(`remake: shot ${shot.n} failed to render ${renders} times`);
    const key = `${input.idem}-shot${shot.n}-${shot.mode}${renders ? `-r${renders}` : ""}-${rec.key}`;
    if (shot.mode === "swap") {
      const clip = join(workDir, "shots", `shot${shot.n}-reference.mp4`);
      if (!existsSync(clip)) await run(referenceClipArgs({ reference: input.referencePath, start: shot.start, seconds: shot.end - shot.start, crop, out: clip }));
      const video = await naive.uploadFile(`${input.idem}-shot${shot.n}-reference.mp4`, "video/mp4", await readFile(clip));
      const prompt = `Replace the person on camera with the person in the reference photo: their face, hair, build and outfit (${lookOnly(input.persona)}). Keep everything else exactly as filmed: the same motion, gestures, expressions, framing, camera, background, lighting and timing.`;
      const job = await withInFlight(() => naive.editVideo!({ video, prompt, references: [manifest.persona_file!] }, key), pollMs);
      rec.job = job.id;
    } else {
      const job = await withInFlight(
        () => naive.generateVideo({ model, prompt: shot.video_prompt, seconds: shot.seconds, aspect_ratio: plan.aspect, image_urls: [rec.frame_file!] }, key),
        pollMs,
      );
      rec.job = job.id;
    }
    rec.renders = renders + 1;
    pending.add(shot.n);
    await save();
  };
  for (const shot of plan.shots) {
    const rec = records[shot.n - 1];
    if (shot.mode === "still" || (rec.video && existsSync(rec.video))) continue;
    if (rec.job) pending.add(shot.n);
    else await submit(shot);
  }
  if (pending.size) say(`Rendering ${pending.size} shots`);
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (pending.size) {
    if (Date.now() > deadline) throw new ApiError("naive", 504, "render_timeout", `remake: ${pending.size} renders still running; run again to pick them up`);
    for (const n of [...pending]) {
      const shot = plan.shots[n - 1];
      const rec = records[n - 1];
      const job: MediaJob = shot.mode === "swap" ? await naive.getVideoEdit!(rec.job!) : await naive.getMediaJob(rec.job!);
      if (job.status === "completed" && jobFile(job)) {
        manifest.cost_micro += job.cost_micro_usd ?? 0;
        const path = join(workDir, "shots", `shot${n}.mp4`);
        await fetchFile(jobFile(job)!, path);
        rec.video = path;
        pending.delete(n);
        say(`Shot ${n} rendered`);
        await save();
      } else if (job.status === "failed" || (job.status === "completed" && !jobFile(job))) {
        failures.push(`shot ${n}: render failed (${job.error?.message ?? "no file"})`);
        rec.job = undefined;
        pending.delete(n);
        await save();
        await submit(shot);
      }
    }
    if (pending.size) await sleep(pollMs);
  }

  // 7. Graphics must be done before the cut.
  await graphicsJob;
  for (const failure of manifest.graphics?.failures ?? []) failures.push(`graphic ${failure.id}: ${failure.error}`);

  // 8. The cut.
  say("Cutting the remake");
  const clips = await Promise.all(
    plan.shots.map(async (shot) => {
      const rec = records[shot.n - 1];
      if (shot.mode === "still") return { path: join(workDir, "frames", `shot${shot.n}-clean.png`), kind: "image" as const, duration: shot.end - shot.start, hasAudio: false, speech: null };
      const meta = await probe(rec.video!);
      const speech = shot.mode === "veo" && meta.hasAudio ? await speechOf(rec.video!, meta.duration) : null;
      return { path: rec.video!, kind: "video" as const, duration: meta.duration, hasAudio: meta.hasAudio && shot.mode === "veo", speech };
    }),
  );
  const placed = placeShots(plan.shots, clips);
  const duration = placed.length ? placed[placed.length - 1].out_end : 0;
  const bandPath = join(workDir, "band.mp4");
  await run(bandArgs(plan.shots.map((shot, i) => ({ path: clips[i].path, kind: clips[i].kind, from: placed[i].from, seconds: placed[i].out_end - placed[i].out_start, hasAudio: clips[i].hasAudio })), plan.stage, bandPath));

  const built = new Map((manifest.graphics?.clips ?? []).filter((clip) => existsSync(clip.path)).map((clip) => [clip.id, clip]));
  const graphics: ComposeGraphic[] = plan.graphics.flatMap((g) => {
    const clip = built.get(g.id);
    if (!clip) return [];
    const start = mapTime(placed, g.start);
    const stop = Math.min(duration, mapTime(placed, g.end));
    return stop - start >= 0.2 ? [{ path: clip.path, kind: clip.kind, start, end: stop, x: g.px.x, y: g.px.y, width: g.px.width, height: g.px.height, entrance: g.entrance }] : [];
  });

  const captions = remakeCaptions(plan.shots, placed, plan.captions.words);
  const work = await mkdtemp(join(workDir, "cut-"));
  try {
    let ass: string | null = null;
    if (captions.length) {
      const metrics = await fontMetrics(DEFAULT_FONT);
      await mkdir(join(work, "fonts"));
      await copyFile(DEFAULT_FONT, join(work, "fonts", basename(DEFAULT_FONT)));
      await writeFile(join(work, "captions.ass"), toAss({ captions, overlays: [] }, { width: OUT.width, height: OUT.height, metrics, caption: captionStyle(plan.captions) }), "utf8");
      ass = "captions.ass";
    }
    await mkdir(resolve(input.outPath, ".."), { recursive: true });
    await run(composeArgs({ band: bandPath, stage: plan.stage, duration, graphics, ass, out: resolve(input.outPath) }), { cwd: work });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await writeFile(join(workDir, "timeline.json"), JSON.stringify({ placed, graphics, captions }, null, 1));
  say(`Remake ready: ${duration.toFixed(1)} s`);
  return { path: resolve(input.outPath), duration, layout, plan, cost_micro: manifest.cost_micro, failures };
}

/** A request whose key is still being worked on at the provider: ask again with the same key until it lands. */
async function withInFlight<T>(call: () => Promise<T>, pollMs: number, tries = 30): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ApiError && error.inFlight) || i >= tries) throw error;
      await sleep(Math.max(pollMs, 1));
    }
  }
}

/** Runs `task` over `items`, `limit` at a time; the first error is thrown once all have settled. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item).catch((error: unknown) => void errors.push(error));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (errors.length) throw errors.find((error) => error instanceof ApiError && error.retryable) ?? errors[0];
}

/** The persona photo's file name in a work directory. */
export const personaFile = (workDir: string) => join(workDir, "persona.png");
