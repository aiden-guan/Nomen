// One-to-one remake: the reference video itself, with only the people, the voice and the product
// content changed. Its footage, framing, cuts, timing, motion, set, music and effects, graphic
// places and caption style stay; the script keeps its words except the product facts.
//
//   reference.mp4 + its breakdown + our script (one line per reference beat, with its emotion)
//     └─ analyzeReference ─ a vision pass: band or full frame, the segments and their kinds
//          │                (talking head, stitch, screen walkthrough, b-roll, graphic), the main
//          │                person's place or cut-out, every graphic, every text overlay, the captions
//          ├─ layers and takes (clone.ts) ─ per segment kind, split at each layer's real cuts
//          ├─ the cost guard ─ an estimate before anything is paid for; over the cap, it stops
//          ├─ the voice, first (dub.ts) ─ stems, word timings, an emotional read on the reference's
//          │    timing (the co-host reads a stitched creator's words), mixed over the bed
//          ├─ the presenter (presenter.ts) ─ per take: a twin frame, then the model that re-performs
//          │    it (Kling motion control, a speaking video model, or an audio-driven one fed our voice)
//          ├─ filmed monitors ─ our product's screens tracked into the reference's footage (or a plate)
//          ├─ graphics ─ the screen builder makes ours, the same kind of element at the same box
//          ├─ the cut ─ segments on the stage, cut-outs keyed in, graphics at their boxes, the blurred
//          │    fill, text overlays and word captions in the reference's style, our soundtrack
//          └─ the check ─ our frames against the reference's (framing, the same people, no originals)
//
// Everything paid for is kept by key in the store's files (`<prefix>/remake/…`) with a manifest, so
// a rerun after a crash, a restart or a busy provider pays for nothing twice. Remakes are internal:
// publishing refuses them unless a person clears them (publish.ts).

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { ApiError } from "../http";
import { download, probe, scratchDir } from "../media";
import { hostFile, type MonidRunner } from "../monid";
import type { NaiveClient } from "../naive";
import { type CloneVerdict, QC_MODEL, reviewClone, reviewFrame } from "../qc";
import { extractJson } from "../research";
import type { Files } from "../store/types";
import { type CaptionStyle, escapeAssText, toAss } from "./captions";
import {
  chunkTakes,
  type CloneLayer,
  type CostEstimate,
  cornerTimes,
  CUT_DIFF,
  estimateCost,
  fitChunk,
  ffmpeg,
  frameArgs,
  grabGrey,
  grabJpeg,
  GREEN_GATE,
  keyFilter,
  cornerColor,
  layersOf,
  motionClipArgs,
  parseQuads,
  type QuadKey,
  quadsUsable,
  readScreenCorners,
  type Rect,
  regionDiff,
  RENDER_TRIES,
  snapSegments,
  splitTakes,
  toReference,
  trackedScreenArgs,
  TWIN_TRIES,
  twinPrompt,
  voiceStats,
  warpKeys,
} from "./clone";
import { type AudioRecord, demucs, makeVoice, referenceAudio, renderVoice, type RenderVoice, sliceArgs, soundArgs, stemsPython, timeOurBeats, timeOurWords, type Voice, type VoiceMode, voiceMode, type VoicePiece } from "./dub";
import { DEFAULT_FONT, FINISHED_ENCODE, fontMetrics, PICTURE_FINISH, renderTimeline } from "./edit";
import { CHARACTER_STYLE, genderOf, type Persona } from "./persona";
import { decodeRgb, makePlate, newPlateRecord, type PlateRecord } from "./plate";
import { presenterOnly } from "./plan";
import { type Presenter, type PresenterInput, presenterFor, type RenderRecord, renderPresenter } from "./presenter";
import { detectCuts } from "./references";
import { buildScreens } from "./screens";
import type { BrandKit, EditTimeline, ProductBrief, ReferenceBeat, ReferenceBreakdown, ScreenClip, ScreenRequest } from "./types";
import { diffWords, type TimedWord, tokens } from "./words";

export const OUT = { width: 1080, height: 1920, fps: 30 } as const;

// ---------- the layout ----------

/** A rectangle as fractions (0-1) of its parent: the stage for people and graphics, the frame for text and captions. */
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

/** What a stretch of the reference is made of; each kind has its own clone strategy (clone.ts). */
export const SEGMENT_KINDS = ["talking_head", "stitch", "screen_walkthrough", "broll", "graphic"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export type RemakeSegment = {
  n: number;
  start: number;
  end: number;
  kind: SegmentKind;
  shows: string;
  presenter: {
    /** The main person on the stage at the segment's start (talking head); null when unknown. */
    box: Box | null;
    /** The main person as a cut-out over other footage (a stitch, a filmed screen), on the stage. */
    inset: Box | null;
    /** That cut-out is green-screened: no frame or background of its own. */
    green: boolean;
  };
  /** stitch: the other creator's look, whom the co-host replaces. */
  other: string;
  /** screen_walkthrough: what the monitor shows over the segment. */
  screen: string;
};

/** A text-only overlay (a hook title, a series line), kept in its place and style with our words. */
export type TextOverlay = {
  id: string;
  /** The reference's words as shown, line by line. */
  lines: string[];
  /** In fractions of the whole frame. */
  box: Box;
  start: number;
  end: number;
  color: string;
  outline: "none" | "thin" | "heavy";
  shadow: boolean;
  /** "#RRGGBB" of a box behind the text, or null. */
  background: string | null;
  /** Capital-letter height as a fraction of the frame height. */
  size: number;
};

export type CaptionLook = {
  case: "upper" | "lower" | "sentence";
  italic: boolean;
  /** "#RRGGBB" */
  color: string;
  outline: "none" | "thin" | "heavy";
  shadow: boolean;
  /** Words on screen at once (1 for word-by-word captions). */
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
  /** The filmed background alone: what twin frames keep. */
  set: string;
  /** The original main person's look, only to know whom to replace. */
  presenter: string;
  beats: RemakeBeat[];
  segments: RemakeSegment[];
  graphics: RemakeGraphic[];
  texts: TextOverlay[];
  captions: CaptionLook;
};

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
const text = (value: unknown, max = 600) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
const fmt = (x: number) => String(Math.round(x * 10000) / 10000);
const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12);

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

/** A model's name for a segment, mapped onto the kinds we clone. */
export function segmentKind(raw: unknown): SegmentKind {
  const value = text(raw, 80).toLowerCase().replace(/[\s-]+/g, "_");
  if ((SEGMENT_KINDS as readonly string[]).includes(value)) return value as SegmentKind;
  if (/stitch|duet|reaction|other_creator/.test(value)) return "stitch";
  if (/graphic|slide|card|screenshot|full_screen|text/.test(value)) return "graphic";
  if (/screen|monitor|walkthrough|demo|computer|laptop/.test(value)) return "screen_walkthrough";
  if (/b_?roll|footage|scenery|cutaway/.test(value)) return "broll";
  return "talking_head";
}

const HEX = /^#?([0-9a-f]{6})$/i;
const hex = (value: unknown, fallback: string) => {
  const match = text(value, 9).match(HEX);
  return match ? `#${match[1].toUpperCase()}` : fallback;
};
const outlineOf = (value: unknown, fallback: "none" | "thin" | "heavy") => {
  const v = text(value, 10);
  return v === "none" || v === "thin" || v === "heavy" ? v : fallback;
};

/** The span a remake covers: every beat that starts before `until` (whole beats), or all of them. */
export function remakeSpan(beats: ReferenceBeat[], until?: number): { beats: ReferenceBeat[]; end: number } {
  const sorted = beats.filter((beat) => beat.end > beat.start).sort((a, b) => a.start - b.start);
  const kept = until && until > 0 ? sorted.filter((beat, i) => i === 0 || beat.start < until - 0.5) : sorted;
  return { beats: kept, end: kept.length ? kept[kept.length - 1].end : 0 };
}

/**
 * The segments as the model gave them, made to tile 0..until: sorted, edges meeting halfway
 * where they overlap or leave a gap, slivers merged into the one before. Without any, the whole
 * span is one talking head (the presenter-led video most references are).
 */
export function tileSegments(raw: Array<Omit<RemakeSegment, "n">>, until: number): RemakeSegment[] {
  const sorted = raw.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Array<Omit<RemakeSegment, "n">> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.end - Math.max(s.start, last.start) < 0.3) continue;
    if (last) {
      const edge = round((last.end + s.start) / 2);
      last.end = edge;
      out.push({ ...s, start: edge });
    } else out.push({ ...s });
  }
  if (!out.length) out.push({ start: 0, end: until, kind: "talking_head", shows: "", presenter: { box: null, inset: null, green: false }, other: "", screen: "" });
  out[0].start = 0;
  out[out.length - 1].end = until;
  const merged: Array<Omit<RemakeSegment, "n">> = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.end - s.start < 0.3) last.end = s.end;
    else merged.push(s);
  }
  return merged.map((s, i) => ({ ...s, start: round(s.start), end: round(s.end), n: i + 1 }));
}

/**
 * Validates the analyst's answer against the reference's beats: boxes clamped, kinds mapped,
 * graphics and texts kept inside the remade span, one layout beat per reference beat (timed by the
 * beat, not the model), segments tiling the span, and the caption look filled from the breakdown's
 * words where the model left it out.
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

  const rawSegments = Array.isArray(o.segments) ? (o.segments as Array<Record<string, unknown>>) : [];
  const segments = tileSegments(
    rawSegments
      .map((s) => {
        const inset = readBox(s?.presenter_inset);
        return {
          start: clamp(num(s?.start), 0, context.until),
          end: clamp(num(s?.end), 0, context.until),
          kind: segmentKind(s?.kind),
          shows: text(s?.shows, 300),
          presenter: { box: readBox(s?.presenter_box), inset, green: Boolean(inset) && s?.green_screen !== false },
          other: text(s?.other_person, 200),
          screen: text(s?.screen_shows, 400),
        };
      })
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)),
    context.until,
  );

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

  const rawTexts = Array.isArray(o.texts) ? (o.texts as Array<Record<string, unknown>>) : [];
  const texts: TextOverlay[] = rawTexts
    .map((t) => {
      const box = readBox(t?.box);
      const start = clamp(num(t?.start), 0, context.until);
      const end = clamp(num(t?.end), 0, context.until);
      const lines = (Array.isArray(t?.lines) ? (t.lines as unknown[]).map((l) => text(l, 120)) : text(t?.text, 300).split(/\s*\n\s*|\s*\/\s*/)).filter(Boolean).slice(0, 5);
      if (!box || !lines.length || !Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.3) return null;
      const background = t?.background ? hex(t.background, "") : "";
      return {
        id: "",
        lines,
        box,
        start: round(start),
        end: round(end),
        color: hex(t.color, "#FFFFFF"),
        outline: outlineOf(t.outline, "none"),
        shadow: t.shadow !== false,
        background: background || null,
        size: round(clamp(num(t.size) || 0.022, 0.008, 0.06), 4),
      };
    })
    .filter((t): t is TextOverlay => Boolean(t))
    .sort((a, b) => a.start - b.start)
    .slice(0, 8)
    .map((t, i) => ({ ...t, id: `t${i + 1}` }));

  const c = (o.captions && typeof o.captions === "object" ? o.captions : {}) as Record<string, unknown>;
  const style = context.caption_style ?? "";
  const perChunk = Number(style.match(/(\d)\s*(?:-|to)\s*(\d)\s*words?/)?.[2] ?? style.match(/(\d)\s*words?/)?.[1] ?? (/word[- ]by[- ]word|one word/i.test(style) ? 1 : 3));
  const badgeRaw = (c.badge && typeof c.badge === "object" ? c.badge : null) as Record<string, unknown> | null;
  const badgeBox = badgeRaw ? readBox(badgeRaw.box ?? badgeRaw) : null;
  const named = text(c.case, 10);
  const captions: CaptionLook = {
    case: named === "upper" || named === "lower" || named === "sentence" ? named : /upper|caps/i.test(style) ? "upper" : /lower ?case/i.test(style) ? "lower" : "sentence",
    italic: c.italic === true || (c.italic === undefined && /italic|slant/i.test(style)),
    color: hex(c.color, "#FFFFFF"),
    outline: outlineOf(c.outline, /no outline/i.test(style) ? "none" : "heavy"),
    shadow: c.shadow !== false,
    words: clamp(Math.round(num(c.words) || perChunk || 3), 1, 5),
    center_y: round(clamp(num(c.center_y) || 0.67, 0.12, 0.92), 4),
    size: round(clamp(num(c.size) || 0.03, 0.012, 0.07), 4),
    badge: badgeBox ? { box: badgeBox, color: hex(badgeRaw?.color, "#FFD43B"), accent: hex(badgeRaw?.accent, "#E5383B"), looks_like: text(badgeRaw?.looks_like, 120) } : null,
  };
  return { frame, set: text(o.set, 300), presenter: text(o.presenter, 300), beats, segments, graphics, texts, captions };
}

// ---------- the stage ----------

/** Where the remade footage sits on the 1080x1920 frame, in px: the band, or the whole frame. */
export type Stage = { x: number; y: number; width: number; height: number; band: boolean };

export function stageOf(layout: Pick<RemakeLayout, "frame">): Stage {
  if (layout.frame.kind !== "band") return { x: 0, y: 0, width: OUT.width, height: OUT.height, band: false };
  const { band } = layout.frame;
  const width = even(band.w * OUT.width);
  const height = even(band.h * OUT.height);
  return { x: clamp(even(band.x * OUT.width), 0, OUT.width - width), y: clamp(even(band.y * OUT.height), 0, OUT.height - height), width, height, band: true };
}

// ---------- graphics ----------

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

export type PlannedGraphic = RemakeGraphic & { request: ScreenRequest; px: { x: number; y: number; width: number; height: number } };

/** One reference graphic → our screen request: the same kind of element at the same size, about our product. */
/** A graphic on screen for less than this at the end of the remade span is dropped. */
const MIN_GRAPHIC_SECONDS = 1.5;

/**
 * The graphics as they will be seen in the remake: each ends by the span's end, and one that would
 * only flash on in the last moment (its reference version runs on past where we stop) is dropped,
 * so the video never ends on a half-played animation.
 */
export function fitGraphics<T extends { start: number; end: number }>(graphics: T[], spanEnd: number): T[] {
  return graphics
    .map((g) => ({ ...g, end: Math.min(g.end, spanEnd) }))
    .filter((g) => g.end - g.start >= MIN_GRAPHIC_SECONDS || g.end < spanEnd - 0.05);
}

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
    // Its animation is timed to the seconds it is actually on screen, so it finishes and holds
    // before the cut (with +0.5 s it was still moving when the video ended).
    seconds: round(Math.max(1, graphic.end - graphic.start), 2),
    reference_visual: `${graphic.kind.replace(/_/g, " ")}: ${graphic.shows}`,
    size: "full",
    box: { width: px.width, height: px.height },
  };
  return { ...graphic, request, px };
}

/** Our words said between two reference times (from the script's lines, by beat). */
export function lineAt(beats: Array<Pick<ReferenceBeat, "start" | "end">>, lines: string[], start: number, end: number): string {
  return beats
    .map((beat, i) => ({ beat, line: lines[i] ?? "" }))
    .filter(({ beat, line }) => line && beat.start < end && beat.end > start)
    .map(({ line }) => line)
    .join(" ");
}

/** A full-stage graphic for a segment: the reference's own graphic segment, or our equivalent for one that could not be cloned. */
export function stageGraphic(id: string, input: { stage: Pick<Stage, "width" | "height">; seconds: number; line: string; shows: string; product: Pick<ProductBrief, "name" | "one_liner"> }): ScreenRequest {
  return {
    id,
    brief: [
      `A full-frame graphic about ${input.product.name} (${input.product.one_liner}) for what is said here: "${input.line}".`,
      input.shows ? `The reference showed: ${input.shows}. Make the same kind of picture, about this product.` : "Show the product doing what the line says, with its real UI or words.",
      "It fills the whole frame. Nothing about any other brand.",
    ].join(" "),
    line: input.line,
    seconds: round(Math.max(1, input.seconds + 0.3), 2),
    reference_visual: input.shows,
    size: "full",
    box: { width: input.stage.width, height: input.stage.height },
  };
}

// ---------- captions and text overlays ----------

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
    upper: look.case === "upper",
    lower: look.case === "lower",
    italic: look.italic,
    color: color(look.color),
    outline: look.outline === "none" ? 0 : look.outline === "thin" ? 4 : 8,
    shadow: look.shadow,
    em,
    bottom: round(clamp(look.center_y + look.size / 2 + 0.004, 0.2, 0.95), 4),
    badge,
  };
}

/**
 * Spoken captions from our words on the reference's clock, `per` words at a time (1 for the
 * word-by-word look). Each shows from its first word until the next one starts, or briefly after
 * its last word when a pause follows.
 */
export function wordCaptions(words: TimedWord[], per: number, end: number): EditTimeline["captions"] {
  const size = Math.max(1, per);
  const chunks: Array<{ start: number; last: number; text: string }> = [];
  for (let i = 0; i < words.length; i += size) {
    const group = words.slice(i, i + size);
    chunks.push({ start: group[0].start, last: group[group.length - 1].end, text: group.map((w) => w.text.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%!?]+$/gu, "")).join(" ") });
  }
  return chunks
    .map((c, i) => {
      const next = chunks[i + 1]?.start ?? end;
      const until = Math.min(end, next - c.last > 0.6 ? c.last + 0.25 : next);
      return { start: round(c.start), end: round(Math.max(c.start + 0.12, until)), text: c.text };
    })
    .filter((c) => c.text && c.start < end);
}

/**
 * Our words for a text overlay, broken where the reference breaks its lines: each reference line
 * ends after the word it ends on in ours (a swapped word ends the line its original did). With no
 * words in common, the lines are balanced by length instead. Emoji are dropped (the font has none).
 */
export function overlayLines(ours: string, reference: string[]): string[] {
  const strip = (s: string) => s.replace(/\p{Extended_Pictographic}|️/gu, "");
  const words = tokens(strip(ours));
  if (!words.length) return [];
  const refLines = reference.map((line) => tokens(strip(line))).filter((line) => line.length);
  const refWords = refLines.flat();
  const stretches = diffWords(refWords, words);
  // Where each reference word's line ends in ours: through same stretches word for word, a changed stretch as a whole.
  const ourEnd = (refIndex: number) => {
    const s = stretches.find((x) => refIndex >= x.a[0] && refIndex < x.a[1]);
    if (!s) return words.length;
    return s.same ? s.b[0] + (refIndex - s.a[0]) + 1 : s.b[1];
  };
  if (refLines.length > 1 && stretches.some((s) => s.same)) {
    const lines: string[] = [];
    let from = 0;
    let seen = 0;
    refLines.forEach((line, i) => {
      seen += line.length;
      const to = i === refLines.length - 1 ? words.length : Math.max(from, Math.min(words.length, ourEnd(seen - 1)));
      if (to > from) lines.push(words.slice(from, to).join(" "));
      from = to;
    });
    if (lines.length) return lines;
  }
  const count = clamp(refLines.length, 1, words.length);
  const total = words.join(" ").length;
  const lines: string[] = [];
  let line: string[] = [];
  for (const word of words) {
    if (line.length && count - lines.length > 1 && [...line, word].join(" ").length > total / count + 3) {
      lines.push(line.join(" "));
      line = [];
    }
    line.push(word);
  }
  if (line.length) lines.push(line.join(" "));
  return lines;
}

const assColour = (hexColour: string, alpha = 0) => {
  const v = hexColour.replace("#", "").padStart(6, "0");
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}`.toUpperCase().replace("&H", "&H");
};

/**
 * The text overlays as an ASS file: each at its reference box (centred on the box, from its top),
 * at its letter size, colour, outline, shadow and background box, with our words.
 */
export function textsAss(items: Array<{ overlay: TextOverlay; lines: string[] }>, fontName = "Poppins ExtraBold"): string {
  const time = (s: number) => {
    const cs = Math.max(0, Math.round(s * 100));
    return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
  };
  const events = items.map(({ overlay, lines }) => {
    const size = Math.round((overlay.size * OUT.height) / 0.7);
    const x = Math.round((overlay.box.x + overlay.box.w / 2) * OUT.width);
    const y = Math.round(overlay.box.y * OUT.height);
    const border = overlay.background ? `\\3c${assColour(overlay.background)}\\bord${Math.round(size * 0.18)}` : overlay.outline === "none" ? "\\bord0" : `\\3c&H000000&\\bord${overlay.outline === "thin" ? 3 : 7}`;
    const shadow = overlay.shadow ? `\\shad${Math.max(2, Math.round(size * 0.06))}\\4c&H000000&\\4a&H80&` : "\\shad0";
    const body = lines.map((line) => escapeAssText(line, "space")).join("\\N");
    return `Dialogue: 2,${time(overlay.start)},${time(overlay.end)},${overlay.background ? "Boxed" : "Text"},,0,0,0,,{\\an8\\pos(${x},${y})\\fs${size}\\1c${assColour(overlay.color)}${border}${shadow}}${body}`;
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${OUT.width}`,
    `PlayResY: ${OUT.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Text,${fontName},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,2,8,20,20,0,1`,
    `Style: Boxed,${fontName},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,8,0,8,20,20,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** Which script line a text overlay belongs to: the beat it starts in. */
export function overlayBeat(overlay: Pick<TextOverlay, "start">, beats: Array<Pick<ReferenceBeat, "start" | "end">>): number {
  const i = beats.findIndex((beat) => overlay.start >= beat.start - 0.05 && overlay.start < beat.end);
  return i >= 0 ? i : 0;
}

// ---------- ffmpeg arguments for the cut ----------

/**
 * One stretch of the stage: `seconds` of a clip (or a still) from `from`, played `speed` times as
 * fast (a render whose line ran long), cover-fitted to the stage, optionally cropped first.
 */
export type StagePiece = { path: string; kind: "video" | "image"; from: number; seconds: number; crop?: Rect; speed?: number };

/** The stage, silent: every piece cover-fitted to it, held on its last frame if short, cut together. */
export function stageArgs(pieces: StagePiece[], stage: Pick<Stage, "width" | "height">, out: string): string[] {
  const { fps } = OUT;
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  const graph: string[] = [];
  pieces.forEach((piece, i) => {
    const frames = Math.max(1, Math.round(piece.seconds * fps));
    const speed = piece.speed ?? 1;
    if (piece.kind === "image") args.push("-loop", "1", "-t", fmt(piece.seconds + 0.5), "-i", piece.path);
    else args.push("-ss", fmt(piece.from), "-t", fmt(piece.seconds * speed + 0.5), "-i", piece.path);
    const crop = piece.crop ? `crop=${piece.crop.width}:${piece.crop.height}:${piece.crop.x}:${piece.crop.y},` : "";
    const faster = Math.abs(speed - 1) > 1e-3 ? `setpts=(PTS-STARTPTS)/${fmt(speed)},` : "";
    graph.push(
      `[${i}:v]${crop}${faster}scale=${stage.width}:${stage.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${stage.width}:${stage.height},setsar=1,fps=${fps},format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=${fmt(piece.seconds + 1)},trim=end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`,
    );
  });
  graph.push(`${pieces.map((_, i) => `[v${i}]`).join("")}concat=n=${pieces.length}:v=1:a=0[v]`);
  return [...args, "-filter_complex", graph.join(";"), "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", out];
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
/** A green-screen render keyed onto the stage (our host's cut-out), from `from` in the clip at `speed`. */
export type ComposeInset = { path: string; start: number; end: number; x: number; y: number; width: number; height: number; key: string; from?: number; speed?: number };

/**
 * The finished frame: the cut-outs keyed in, the graphics at their boxes for their windows, then
 * (for a band layout) the stage over a blurred, zoomed copy of itself filling the frame, the way
 * the reference's editor built it, the picture finish (`finish`, edit.ts) under the text overlays
 * and captions, over the soundtrack. `ass` files are names in the working directory (cwd).
 */
export function composeArgs(input: { stage: string; audio: string; place: Stage; duration: number; insets: ComposeInset[]; graphics: ComposeGraphic[]; ass: string[]; finish?: boolean; out: string }): string[] {
  const { fps, width: W, height: H } = OUT;
  const frames = Math.max(1, Math.round(input.duration * fps));
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", input.stage, "-i", input.audio];
  const graph = [`[0:v]fps=${fps},setsar=1,format=yuv420p[s0]`];
  let at = 0;
  let next = 2;
  input.insets.forEach((inset) => {
    const len = Math.max(1 / fps, inset.end - inset.start);
    const speed = inset.speed ?? 1;
    args.push("-ss", fmt(inset.from ?? 0), "-t", fmt(len * speed + 1), "-i", inset.path);
    const faster = Math.abs(speed - 1) > 1e-3 ? `setpts=(PTS-STARTPTS)/${fmt(speed)},` : "";
    graph.push(
      `[${next}:v]${faster}scale=${inset.width}:${inset.height}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p,${keyFilter(inset.key)},format=yuva420p,tpad=stop_mode=clone:stop_duration=${fmt(len + 1)},trim=end_frame=${Math.max(1, Math.round(len * fps))},setpts=PTS-STARTPTS+${fmt(inset.start)}/TB[k${at}]`,
      `[s${at}][k${at}]overlay=x=${inset.x}:y=${inset.y}:eof_action=pass:enable='between(t,${fmt(inset.start)},${fmt(inset.end)})'[s${at + 1}]`,
    );
    at++;
    next++;
  });
  input.graphics.forEach((g) => {
    const len = Math.max(1 / fps, g.end - g.start);
    if (g.kind === "image") args.push("-loop", "1", "-t", fmt(len + 1), "-i", g.path);
    else args.push("-i", g.path);
    const motion = entrance(g.entrance, g.x, g.y, g.start);
    const fade = motion.fade ? `,fade=t=in:st=0:d=${motion.fade}:alpha=1` : "";
    graph.push(
      `[${next}:v]scale=${g.width}:${g.height}:flags=lanczos,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${fmt(len + 1)},trim=end_frame=${Math.max(1, Math.round(len * fps))},format=yuva420p${fade},setpts=PTS-STARTPTS+${fmt(g.start)}/TB[g${at}]`,
      `[s${at}][g${at}]overlay=x='${motion.x}':y='${motion.y}':eof_action=pass:enable='between(t,${fmt(g.start)},${fmt(g.end)})'[s${at + 1}]`,
    );
    at++;
    next++;
  });
  const last = `s${at}`;
  if (input.place.band) {
    graph.push(
      `[${last}]split[fg][bgsrc]`,
      `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=30:steps=2,eq=brightness=-0.03[bg]`,
      `[bg][fg]overlay=${input.place.x}:${input.place.y}[full]`,
    );
  } else {
    graph.push(`[${last}]scale=${W}:${H}:flags=lanczos,setsar=1[full]`);
  }
  const subs = input.ass.map((file) => `ass=filename=${file}:fontsdir=fonts`).join(",");
  graph.push(`[full]${input.finish ? `${PICTURE_FINISH},` : ""}${subs ? `${subs},` : ""}format=yuv420p,trim=end_frame=${frames}[vout]`);
  graph.push(`[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=${fmt(frames / fps)}[aout]`);
  args.push("-filter_complex", graph.join(";"), "-map", "[vout]", "-map", "[aout]", "-t", fmt(frames / fps));
  args.push("-r", String(fps), "-c:v", "libx264", "-preset", "medium", ...(input.finish ? FINISHED_ENCODE : ["-crf", "18"]), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", input.out);
  return args;
}

/** The screens a filmed monitor shows, cut together at the monitor's 1440x900 for `seconds`. */
export function screenStreamArgs(pieces: Array<{ path: string; kind: "video" | "image"; seconds: number }>, out: string): string[] {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  const graph: string[] = [];
  pieces.forEach((piece, i) => {
    const frames = Math.max(1, Math.round(piece.seconds * OUT.fps));
    if (piece.kind === "image") args.push("-loop", "1", "-t", fmt(piece.seconds + 0.5), "-i", piece.path);
    else args.push("-i", piece.path);
    graph.push(
      `[${i}:v]scale=1440:900:force_original_aspect_ratio=decrease:flags=lanczos,pad=1440:900:(ow-iw)/2:(oh-ih)/2:color=0x101014,setsar=1,fps=${OUT.fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=${fmt(piece.seconds + 1)},trim=end_frame=${frames},setpts=PTS-STARTPTS[p${i}]`,
    );
  });
  graph.push(`${pieces.map((_, i) => `[p${i}]`).join("")}concat=n=${pieces.length}:v=1:a=0[v]`);
  return [...args, "-filter_complex", graph.join(";"), "-map", "[v]", "-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p", out];
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
    required: ["frame", "set", "presenter", "beats", "segments", "graphics", "texts", "captions"],
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
      presenter: { type: "string", description: "The main person's look in a few words." },
      beats: {
        type: "array",
        items: {
          type: "object",
          required: ["n", "visible", "speaking", "framing", "motion"],
          properties: {
            n: { type: "integer" },
            visible: { type: "boolean" },
            speaking: { type: "boolean" },
            box: { ...BOX_SCHEMA, description: "The main person at the beat's start, in fractions of the stage." },
            framing: { type: "string", description: "full-length, knees-up, waist-up, chest-up or close-up, and where on the stage (left third, centre, bottom-left corner)." },
            motion: { type: "string", description: "Body motion only, in order: where they stand and move to, how they gesture, lean or turn, what they hold, jumps in size or position. No clothing, text or graphics." },
          },
        },
      },
      segments: {
        type: "array",
        description: "The video split into continuous stretches by what is on screen, covering it from start to end.",
        items: {
          type: "object",
          required: ["start", "end", "kind", "shows"],
          properties: {
            start: { type: "number" },
            end: { type: "number" },
            kind: { type: "string", enum: [...SEGMENT_KINDS] },
            shows: { type: "string", description: "What is on screen, in one sentence." },
            presenter_box: { ...BOX_SCHEMA, description: "talking_head: the main person at the segment's start, in fractions of the stage." },
            presenter_inset: { ...BOX_SCHEMA, description: "When the main person appears as a cut-out over other footage (a stitch, a filmed screen): the cut-out's box, in fractions of the stage. Omit otherwise." },
            green_screen: { type: "boolean", description: "The cut-out has no frame or background of its own (the main person was green-screened over the footage)." },
            other_person: { type: "string", description: "stitch: the other creator's look in a few words (age, hair, clothes)." },
            screen_shows: { type: "string", description: "screen_walkthrough: what the filmed monitor shows over the segment, in order (which site or app, which pages, what is clicked or typed)." },
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
      texts: {
        type: "array",
        items: {
          type: "object",
          required: ["lines", "box", "start", "end", "color", "outline", "shadow", "size"],
          properties: {
            lines: { type: "array", items: { type: "string" }, description: "The words exactly as shown, one entry per line." },
            box: { ...BOX_SCHEMA, description: "In fractions of the whole frame." },
            start: { type: "number" },
            end: { type: "number" },
            color: { type: "string", description: "#RRGGBB of the letters." },
            outline: { type: "string", enum: ["none", "thin", "heavy"] },
            shadow: { type: "boolean" },
            background: { type: ["string", "null"], description: "#RRGGBB of a box behind the text, or null." },
            size: { type: "number", description: "Height of a capital letter, as a fraction of the whole frame's height." },
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
          words: { type: "integer", description: "How many words show at once (1 for word-by-word)." },
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
    `These are frames from a viral vertical video (0 to ${end.toFixed(1)} s), each labelled with its time. We will remake it one to one: the same layout, segments, framing, moves, cuts, graphics, text overlays and caption look, with different people, different product words and a different product. Describe how it is built, precisely enough for an editor to rebuild it.`,
    `Its beats, from the transcript:\n${JSON.stringify(beats.map((b, i) => ({ n: i + 1, start: b.start, end: b.end, line: b.line, on_screen_text: b.on_screen_text, visual: b.visual })))}`,
    `Notes from an earlier breakdown: format: ${breakdown.format}. Captions: ${breakdown.caption_style}.`,
    "- frame: band when the footage sits in a horizontal band across the middle of the 9:16 frame with a blurred, zoomed copy filling above and below (give the band's box in fractions of the whole frame); full when the footage fills the frame.",
    "- The stage is the band (or the whole frame for full). Boxes of people, segments and graphics are in fractions of the stage; boxes of texts and the captions' badge are in fractions of the whole frame. x and y of the top-left corner, then w and h, each 0 to 1.",
    "- set: the filmed background alone, without the person and without anything laid over it. presenter: the main person (the creator whose video it is).",
    "- beats: for every beat n, whether the main person is visible and speaking, their box at the beat's start, their framing and place on the stage, and their motion during the beat in plain body terms (what they hold, too).",
    "- segments: split the whole video into continuous stretches by what is on screen, covering 0 to the end with no gaps: talking_head (the main person talking to the camera), stitch (another creator's clip, usually with the main person as a small cut-out over it), screen_walkthrough (a phone filming a computer monitor or laptop, usually with the main person as a cut-out over it), broll (footage with nobody in it), graphic (a full-screen graphic, slide or screenshot). For each: its times, kind, what it shows, the main person's box (talking head), the main person's cut-out box and whether it is green-screened (no frame or background of its own) when they appear as a cut-out over other footage, the other creator's look (stitch), and what the monitor shows (screen walkthrough).",
    "- graphics: every element laid over the footage in editing apart from the captions, the text overlays and the main person's cut-out: posts, screenshots, photos, charts, webcam insets, text cards on a card background, game scenes, stickers. Give its kind, its box on the stage, when it appears and when it is gone (from the frame labels), what it shows in one sentence, and how it enters. One entry per element per appearance.",
    "- texts: every text-only overlay that is not a spoken-word caption (a hook title at the top, a label, a series line such as 'Part 67'): its words exactly as shown, line by line, its box in fractions of the whole frame, when it shows, its colour, outline, shadow, the colour of a box behind it if any, and the height of a capital letter as a fraction of the frame's height.",
    "- captions: the spoken-word captions' case, slant, colour, outline and shadow, how many words show at once (1 for word-by-word), the vertical centre of the caption line and the height of a capital letter as fractions of the whole frame's height, and any sticker or emoji badge beside them.",
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
  const reply = await naive.message({ model: QC_MODEL, max_tokens: 8000, messages: [{ role: "user", content }], tools: [LAYOUT_TOOL] });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === LAYOUT_TOOL.name);
  let raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Record<string, unknown> | null;
  if (!raw?.frame) {
    const again = await naive.message({
      model: QC_MODEL,
      max_tokens: 8000,
      messages: [{ role: "user", content: [...content.slice(0, -1), { type: "text", text: `${layoutPrompt(input.breakdown, input.beats, input.end).replace("Call the remake_layout tool once.", "")}\nAnswer with only one JSON object with the keys frame, set, presenter, beats, segments, graphics, texts and captions.` }] }],
    });
    raw = extractJson(again.content.map((block) => block.text ?? "").join("\n")) as Record<string, unknown> | null;
    if (!raw?.frame) throw new ApiError("naive", 502, "layout_unreadable", "the reference analysis returned no layout");
  }
  return parseLayout(raw, context);
}

// ---------- running it ----------

/**
 * What the remake's steps share: the store's files under the remake's prefix, a scratch folder,
 * public links, spend and the manifest. dub.ts and presenter.ts take it too.
 */
export type Work = {
  files: Files;
  dir: string;
  pollMs: number;
  say(message: string): void;
  spend(provider: "naive" | "monid", micro: number): void;
  /** Keeps a local file under `<prefix>/remake/<name>`; returns its key. */
  keep(name: string, path: string, type: string): Promise<string>;
  /** A local copy of a kept file, or null when it is not kept. */
  local(key: string | null | undefined): Promise<string | null>;
  /** A public link to a local file, for the providers (Monid's file store, a day). */
  host(path: string, type: string): Promise<string>;
  fetch(url: string, path: string): Promise<void>;
  save(): Promise<void>;
};

/**
 * Naive answers "at capacity" in bursts. A remake makes dozens of calls over several minutes, so
 * each call waits out a busy answer (5 s doubling to 1 min, about 5 minutes in all) instead of
 * failing the whole remake. Paid calls carry idempotency keys, so a retry never pays twice.
 */
export function patient<T extends object>(client: T, delaysMs: number[] = [5, 10, 20, 40, 60, 60, 60, 60].map((s) => s * 1000)): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await value.apply(target, args);
          } catch (error) {
            if (!(error instanceof ApiError && error.retryable && !error.inFlight) || attempt >= delaysMs.length) throw error;
            await sleep(delaysMs[attempt]);
          }
        }
      };
    },
  });
}

export type RemakeNaive = Pick<NaiveClient, "message" | "generateImage" | "fileUrl" | "generateVideo" | "getMediaJob">;

export type RemakeDeps = {
  naive: RemakeNaive;
  monid: MonidRunner;
  files: Files;
  /** The presenter step (default: the `presenter` input's name, else Kling motion control). */
  presenter?: Presenter;
  /** Saves a link to a local path (default: download). */
  fetchUrl?: (url: string, path: string) => Promise<unknown>;
  /** A public link for a local file (default: Monid's file store). */
  host?: (path: string, contentType: string, name: string) => Promise<string>;
  /** Splits voice from bed (default: Demucs when set up, else none). */
  separate?: ((input: string, outDir: string) => Promise<{ voice: string; bed: string }>) | null;
  /** Builds graphics and screens (default: the screen builder, with headless Chrome). */
  buildGraphics?: (requests: ScreenRequest[], workDir: string) => Promise<{ clips: ScreenClip[]; failures: Array<{ id: string; error: string; retryable?: boolean }> }>;
  /** Waits before building again the graphics that failed only because the model was busy (default 20, 45 and 90 s). */
  busyWaitsMs?: number[];
};

/** One line of the script per reference beat, with how it is said and the on-screen text. */
export type RemakeLine = { line: string; emotion: string; on_screen_text: string };

export type PersonaHandle = { persona: Persona; portrait: string };

export type RemakeInput = {
  /** Key prefix of everything kept: the creative's id ("crv_…"). The cut is `<prefix>/final.mp4`. */
  prefix: string;
  referencePath: string;
  breakdown: ReferenceBreakdown;
  lines: RemakeLine[];
  host: PersonaHandle;
  /** The co-host, made (once per brand) only when a segment stitches in another creator. */
  cohost?: (otherLook: string) => Promise<PersonaHandle & { cost_micro: number }>;
  product: ProductBrief;
  kit: BrandKit | null;
  /** The product's site as it is shown on the closing card ("monid.ai"). */
  site?: string | null;
  /** Remake only the beats that start before this many seconds (the live tests do the first 8-12 s). */
  until?: number;
  /** The cost guard: refuse, before paying for anything, an estimate over this (USD). */
  maxUsd: number;
  /** The presenter's name when `deps.presenter` is not given ("kling-native", "kling-motion", "naive:<model>"). */
  presenter?: string;
  /** Our voice, for presenters that do not voice themselves and for stretches no render says. */
  voice: VoiceMode | "auto";
  /** Each render's own voice passed through speech-to-speech into the persona's one voice (keeps the render's timing). */
  voiceMatch?: boolean;
  /** The picture and sound finish (contrast, grain, the voice chain, ducking, loudness); off for an A/B. */
  finish?: boolean;
  /** Filmed monitors: tracked into the reference's footage, a plate, or tracked when the corners hold up. */
  screens?: "auto" | "track" | "plate";
  /** Prefix of every idempotency key: stable per video, so a rerun never pays twice. */
  idem: string;
  /** Personas still to make for this remake (their portraits count in the estimate). */
  personasToMake?: number;
  pollMs?: number;
  onEvent?: (message: string) => void;
  onProgress?: (progress: RemakeProgress) => void | Promise<void>;
};

/** One render as the UI shows it ("Take n"): who, when, how far along, and what it cost. */
export type TakeView = { n: number; layer: string; role: "host" | "cohost" | null; inset: boolean; start: number; end: number; status: "pending" | "framed" | "rendering" | "rendered" | "failed"; frame_key: string | null; naive_micro: number; monid_micro: number; error: string | null };
export type RemakeProgress = { takes: TakeView[]; spend: { naive_micro: number; monid_micro: number }; estimate: CostEstimate | null };

/** How each render's own voice came out, to compare them: pitch and level, before and after speech-to-speech. */
export type VoiceReport = { render: string; role: "host" | "cohost"; words: number; words_per_s: number | null; pitch_hz: number | null; level_db: number; matched: { pitch_hz: number | null; level_db: number } | null; speed: number; cut: boolean };

export type RemakeResult = {
  key: string;
  path: string;
  poster_key: string | null;
  duration: number;
  layout: RemakeLayout;
  layers: CloneLayer[];
  estimate: CostEstimate;
  spend: { naive_micro: number; monid_micro: number };
  qc: CloneVerdict | null;
  voices: VoiceReport[];
  notes: string[];
};

/** A remake whose estimate is over its cap: it stops before anything is paid for. */
export class OverBudget extends Error {}

type TakeRecord = { key: string; frame_key?: string; frame_tries?: number; frame_fix?: string; frame_done?: boolean; frame_micro?: number; render: RenderRecord; voice?: RenderVoice; failed?: string };
type ScreenRecord = { key: string; mode?: "track" | "plate"; reason?: string; clip_key?: string; plate?: PlateRecord; plate_key?: string };

type Manifest = {
  version: 3;
  layout?: RemakeLayout;
  cuts?: number[];
  /** Scene changes at a lower threshold, used only to move a take's first frame past a cut. */
  soft_cuts?: number[];
  real?: Record<string, number[]>;
  estimate?: CostEstimate;
  audio: AudioRecord;
  /** Per render ("s1-c1"): its twin frame, its presenter job and clip, its own voice. */
  takes: Record<string, TakeRecord>;
  screens: Record<string, ScreenRecord>;
  graphics?: { key: string; clips: Array<{ id: string; kind: "video" | "image"; key: string; hash?: string }>; failures: Array<{ id: string; error: string; retryable?: boolean; hash?: string }> };
  hosted: Record<string, { url: string; at: number }>;
  fallbacks: Record<string, string>;
  qc?: CloneVerdict | null;
  spend: { naive_micro: number; monid_micro: number };
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const busy = (f: { error: string; retryable?: boolean }) => Boolean(f.retryable) || /at capacity|rate.?limit|busy|timed? ?out/i.test(f.error);

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

/** Runs `task` over `items`, `limit` at a time; once all have settled, the first busy-provider error (else the first error) is thrown. */
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

/** Errors that must stop the remake now (and be retried later), rather than send one segment to its fallback. */
const stopping = (error: unknown) => error instanceof ApiError && (error.retryable || error.outOfCredits);

/** Words said between two times, as one line. */
/** Time kept after the last word of the video's final take, so the plug isn't clipped by the end. */
const FINAL_BREATH = 0.7;
/** How long the closing card with the product's site shows at the end. */
const END_CARD_SECONDS = 1.4;

/**
 * The picture for the closing card: the product's homepage capture, else its first screenshot,
 * else its first picture. A local path, a store key or a link.
 */
export function endCardVisual(product: Pick<ProductBrief, "visuals">): { url: string; key?: string } | null {
  const shots = product.visuals.filter((v) => v.kind === "screenshot");
  const home = shots.find((v) => /home/i.test(`${v.caption ?? ""} ${v.url}`));
  const pick = home ?? shots[0] ?? product.visuals.find((v) => v.kind === "photo") ?? null;
  return pick ? { url: pick.url, ...(pick.key ? { key: pick.key } : {}) } : null;
}

const drawtextSafe = (text: string) => text.replace(/\\/g, "\\\\").replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/%/g, "\\%");

/**
 * ffmpeg arguments for the closing card: the site's picture as a card near the top over a blurred,
 * darkened copy of itself filling the frame, and the site's address under it.
 */
export function endCardArgs(o: { image: string; site: string | null; font: string; width: number; height: number; out: string }): string[] {
  const { width: W, height: H } = o;
  const cardW = 2 * Math.round((W * 0.84) / 2);
  const cardH = 2 * Math.round((H * 0.5) / 2);
  const top = Math.round(H * 0.12);
  const filter = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:2,eq=brightness=-0.35[bg]`,
    `[0:v]scale=${cardW}:-2,crop=${cardW}:'min(ih,${cardH})':0:0[card]`,
    `[bg][card]overlay=(W-w)/2:${top}${o.site ? "[v0]" : "[v]"}`,
    ...(o.site ? [`[v0]drawtext=fontfile='${o.font}':text='${drawtextSafe(o.site)}':fontcolor=white:fontsize=${Math.round(H * 0.05)}:x=(w-text_w)/2:y=${top + cardH + Math.round(H * 0.05)}:borderw=5:bordercolor=black@0.55[v]`] : []),
  ];
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", o.image, "-filter_complex", filter.join(";"), "-map", "[v]", "-frames:v", "1", o.out];
}

async function endCard(work: Work, input: Pick<RemakeInput, "product" | "site">, dir: string): Promise<string | null> {
  const visual = endCardVisual(input.product);
  if (!visual) return null;
  let image = visual.key ? await work.local(visual.key) : null;
  if (!image && existsSync(visual.url)) image = visual.url;
  if (!image && /^https?:\/\//.test(visual.url)) {
    image = join(dir, "end-card-source.png");
    await work.fetch(visual.url, image);
  }
  if (!image) return null;
  const out = join(dir, "end-card.png");
  await ffmpeg(endCardArgs({ image, site: input.site?.trim() || null, font: DEFAULT_FONT, width: OUT.width, height: OUT.height, out }));
  return out;
}

/**
 * Where a take's first frame is grabbed: just after a cut that comes at or soon after its planned
 * time. The layout's segment times are approximate, and a frame grabbed before the cut shows the
 * previous shot (Jordan's stitch: the frame at 3.12 s still showed her face filling the frame, so
 * her cut-out was made as an extreme close-up of her mouth).
 */
export function afterCut(take: { start: number; end: number; frame_at: number }, cuts: number[]): number {
  const cut = cuts.find((c) => c >= take.frame_at - 0.05 && c <= Math.min(take.end - 0.2, take.start + 1.2));
  return cut === undefined ? take.frame_at : round(Math.min(take.end - 0.1, cut + 0.12));
}

const wordsIn = (words: TimedWord[], start: number, end: number) =>
  words
    .filter((w) => w.start >= start - 0.05 && w.start < end - 0.05)
    .map((w) => w.text)
    .join(" ");

/**
 * The whole remake: analysis, layers, takes and renders, the cost guard, the reference's sound,
 * the presenter per render (with its own voice, or ours made first), filmed monitors, graphics, the
 * cut and the check. Resumable from the manifest in the store's files; a busy provider throws a
 * retryable ApiError, and the next run picks up where this stopped.
 */
export async function remakeVideo(deps: RemakeDeps, input: RemakeInput): Promise<RemakeResult> {
  const naive = patient(deps.naive);
  const files = deps.files;
  const prefix = `${input.prefix}/remake`;
  const manifestKey = `${prefix}/manifest.json`;
  const dir = join(scratchDir(), `remake-${input.prefix}`);
  await mkdir(dir, { recursive: true });
  const say = (message: string) => input.onEvent?.(message);
  const pollMs = input.pollMs ?? 10_000;
  const finish = input.finish !== false;
  const notes: string[] = [];

  const loaded = (await files.exists(manifestKey)) ? (JSON.parse(await readFile(await files.localPath(manifestKey), "utf8")) as Partial<Manifest>) : {};
  const manifest: Manifest = { version: 3, audio: {}, takes: {}, screens: {}, hosted: {}, fallbacks: {}, spend: { naive_micro: 0, monid_micro: 0 }, ...(loaded.version === 3 ? loaded : {}) };
  let saving = Promise.resolve();
  const save = () =>
    (saving = saving.then(async () => {
      const path = join(dir, "manifest.json");
      await writeFile(path, JSON.stringify(manifest));
      await files.putFile(manifestKey, path, "application/json");
    }));
  const fetchUrl = deps.fetchUrl ?? download;
  const host = deps.host ?? (async (path: string, type: string, name: string) => hostFile(deps.monid, await readFile(path), name, type));
  const work: Work = {
    files,
    dir,
    pollMs,
    say,
    spend(provider, micro) {
      manifest.spend[provider === "naive" ? "naive_micro" : "monid_micro"] += Math.max(0, Math.round(micro || 0));
    },
    async keep(name, path, type) {
      const key = `${prefix}/${name}`;
      await files.putFile(key, path, type);
      return key;
    },
    async local(key) {
      if (!key || !(await files.exists(key))) return null;
      const path = await files.localPath(key).catch(() => null);
      return path && existsSync(path) ? path : null;
    },
    async host(path, type) {
      const id = createHash("sha1").update(await readFile(path)).digest("hex").slice(0, 16);
      const cached = manifest.hosted[id];
      if (cached && Date.now() - cached.at < 20 * 3600_000) return cached.url;
      const url = await host(path, type, `${input.idem}-${id}-${basename(path)}`);
      manifest.hosted[id] = { url, at: Date.now() };
      return url;
    },
    async fetch(url, path) {
      await mkdir(join(path, ".."), { recursive: true });
      await fetchUrl(url, path);
    },
    save,
  };
  const presenter = deps.presenter ?? presenterFor(input.presenter ?? "kling-native", { naive, monid: deps.monid });

  const info = await probe(input.referencePath);
  if (!info.duration || !info.width) throw new Error(`remake: ${input.referencePath} is not a playable video`);
  const span = remakeSpan(input.breakdown.beats, input.until);
  if (!span.beats.length) throw new Error("remake: the reference breakdown has no beats");
  const end = round(Math.min(span.end, info.duration), 3);
  const lines = span.beats.map((_, i) => input.lines[i] ?? { line: "", emotion: "", on_screen_text: "" });

  // 1. How the reference is built.
  if (!manifest.layout || manifest.layout.beats.length !== span.beats.length || !manifest.layout.segments) {
    say(`Reading the reference's layout and segments from its frames (0-${end.toFixed(1)} s)`);
    manifest.layout = await analyzeReference(naive, { referencePath: input.referencePath, breakdown: input.breakdown, beats: span.beats, end });
    manifest.real = undefined;
    await save();
  }
  const layout = manifest.layout;
  const stage = stageOf(layout);
  const stageRef = toReference({ x: 0, y: 0, width: stage.width, height: stage.height }, stage, info);

  // 2. The reference's scene changes, the segments snapped onto them, and each layer's own cuts.
  manifest.cuts ??= (await detectCuts(input.referencePath, 0.3, info.duration).catch(() => [] as number[])).filter((c) => c < end);
  const cuts = manifest.cuts;
  // Softer cuts too, for where each take's first frame is grabbed: a cut between two similar shots
  // (Jordan's talking head to her stitch, scene score 0.16) is under the segment threshold.
  manifest.soft_cuts ??= (await detectCuts(input.referencePath, 0.1, info.duration).catch(() => [] as number[])).filter((c) => c < end);
  const softCuts = manifest.soft_cuts;
  const segments = snapSegments(layout.segments, cuts);
  const layers = layersOf({ segments }, stage, presenter.ratios);
  if (!manifest.real) {
    const greyW = 96;
    const greyH = Math.max(2, 2 * Math.round((greyW * stage.height) / stage.width / 2));
    const pairs = new Map<number, { a: Uint8Array; b: Uint8Array }>();
    for (const t of cuts) {
      const pair = await Promise.all([grabGrey(input.referencePath, t - 0.1, greyW, greyH, stageRef), grabGrey(input.referencePath, t + 0.1, greyW, greyH, stageRef)]).catch(() => null);
      if (pair) pairs.set(t, { a: pair[0], b: pair[1] });
    }
    const frac = (r: Rect): Box => ({ x: r.x / stage.width, y: r.y / stage.height, w: r.width / stage.width, h: r.height / stage.height });
    const captionStrip: Box = { x: 0, y: clamp((layout.captions.center_y * OUT.height - stage.y) / stage.height - (2 * layout.captions.size * OUT.height) / stage.height, 0, 1), w: 1, h: clamp((4 * layout.captions.size * OUT.height) / stage.height, 0, 1) };
    manifest.real = {};
    for (const layer of layers) {
      if (layer.kind !== "clone" && layer.kind !== "screen") continue;
      const segment = segments.find((s) => s.n === layer.segment)!;
      manifest.real[layer.id] = cuts.filter((t) => {
        if (t <= layer.start + 0.3 || t >= layer.end - 0.3) return false;
        const pair = pairs.get(t);
        if (!pair) return true;
        // Whatever else changes at that moment (a graphic popping in, the captions, a cut-out) is not this layer's footage.
        const drop = [
          ...layout.graphics.filter((g) => g.start - 1 <= t && t <= g.end + 1).map((g) => g.box),
          ...layer.blank.map(frac),
          ...(!layer.inset && segment.presenter.inset ? [segment.presenter.inset] : []),
          captionStrip,
        ];
        return regionDiff(pair.a, pair.b, greyW, greyH, [frac(layer.crop)], drop) > CUT_DIFF;
      });
    }
    await save();
  }
  for (const layer of layers) {
    if (layer.kind !== "clone") continue;
    layer.takes = splitTakes(layer, manifest.real[layer.id] ?? [], 0.6, presenter.price.maxSeconds);
    layer.chunks = chunkTakes(layer.takes, presenter.price.maxSeconds, presenter.multiShot);
  }

  // 3. Graphics and the screens the filmed monitors show.
  const scriptLines = lines.map((l) => l.line);
  const planned = fitGraphics(layout.graphics, span.end).map((g) => graphicRequest(g, { stage, line: lineAt(span.beats, scriptLines, g.start, g.end), product: input.product }));
  const requests: ScreenRequest[] = [...planned.map((g) => g.request)];
  for (const layer of layers) {
    const segment = segments.find((s) => s.n === layer.segment)!;
    if (layer.kind === "graphic") requests.push(stageGraphic(layer.id, { stage, seconds: layer.end - layer.start, line: lineAt(span.beats, scriptLines, layer.start, layer.end), shows: segment.shows, product: input.product }));
    if (layer.kind === "screen") requests.push(...screenRequests(layer, segment, span.beats, scriptLines, input.product));
  }

  // 4. The cost guard: nothing is paid for until the estimate is under the cap.
  const needsCohost = layers.some((l) => l.role === "cohost");
  const estimate = estimateCost(
    layers,
    { name: presenter.name, ...presenter.price },
    { personas: (input.personasToMake ?? 0) + (needsCohost ? 1 : 0), graphics: requests.length, plates: layers.filter((l) => l.kind === "screen").length, padSeconds: presenter.voice === "own" ? 0.6 : 0 },
  );
  manifest.estimate = estimate;
  await save();
  const renders = layers
    .filter((l) => l.kind === "clone")
    .flatMap((layer) => layer.chunks.map((chunk) => ({ layer, chunk, id: `${layer.id}-c${chunk.n}` })))
    .sort((a, b) => a.chunk.start - b.chunk.start || Number(a.layer.inset) - Number(b.layer.inset))
    .map((entry, i) => ({ ...entry, n: i + 1 }));
  say(
    `Plan: ${segments.map((s) => `${s.kind.replace(/_/g, " ")} ${s.start.toFixed(1)}-${s.end.toFixed(1)} s`).join(", ")}; ${renders.length} renders on ${presenter.name} (${estimate.presenter_seconds} s billed), ${requests.length} graphics and screens; about $${estimate.usd.total.toFixed(2)}`,
  );
  if (estimate.usd.total > input.maxUsd) throw new OverBudget(`remake: estimated $${estimate.usd.total.toFixed(2)} (${presenter.name} $${estimate.usd.presenter.toFixed(2)} for ${estimate.presenter_seconds} s) is over the cap of $${input.maxUsd.toFixed(2)}; raise remake_max_usd to run it`);

  const progress = async () => {
    const takes: TakeView[] = renders.map(({ layer, chunk, id, n }) => {
      const rec = manifest.takes[id];
      const status: TakeView["status"] = rec?.failed ? "failed" : rec?.render?.clip_key ? "rendered" : rec?.render?.job ? "rendering" : rec?.frame_done || (rec && !presenter.needs.frame) ? "framed" : "pending";
      const rendered = rec?.render?.cost_micro ?? 0;
      const naiveRender = rec?.render?.job?.provider === "naive" || (presenter.name.startsWith("naive:") && rendered > 0);
      return { n, layer: layer.id, role: layer.role, inset: layer.inset, start: chunk.start, end: chunk.end, status, frame_key: rec?.frame_key ?? null, naive_micro: (rec?.frame_micro ?? 0) + (naiveRender ? rendered : 0), monid_micro: naiveRender ? 0 : rendered, error: rec?.failed ?? rec?.render?.error ?? null };
    });
    await input.onProgress?.({ takes, spend: { ...manifest.spend }, estimate });
  };
  await progress();

  // 5. Graphics build in the background while the sound and the renders run.
  const graphicsJob = buildGraphics(work, deps, manifest, requests, input).catch((error: unknown) => {
    if (stopping(error)) throw error;
    notes.push(`graphics: ${error instanceof Error ? error.message : String(error)}`);
  });
  graphicsJob.catch(() => undefined);

  // 6. The people: the host is given; the co-host is made when a stitch needs one.
  const cohost = needsCohost && input.cohost ? await input.cohost(segments.find((s) => s.kind === "stitch")?.other ?? "") : null;
  if (cohost?.cost_micro) work.spend("naive", cohost.cost_micro);
  const hostPerson = { handle: input.host, url: await work.host(input.host.portrait, "image/png"), jpeg: await grabJpeg(input.host.portrait, null).catch(() => null) };
  const cohostPerson = cohost ? { handle: cohost as PersonaHandle, url: await work.host(cohost.portrait, "image/png"), jpeg: await grabJpeg(cohost.portrait, null).catch(() => null) } : hostPerson;
  const personFor = (layer: CloneLayer) => (layer.role === "cohost" ? cohostPerson : hostPerson);

  // 7. The reference's sound: the bed, and when each word is said. Our words land on its clock.
  const separate = deps.separate === undefined ? ((python) => (python ? (file: string, out: string) => demucs(python, file, out) : null))(stemsPython()) : deps.separate;
  const reference = await referenceAudio(work, deps.monid, manifest.audio, { reference: input.referencePath, end, separate });
  notes.push(...(manifest.audio.notes ?? []).filter((n) => !notes.includes(n)));
  const ourWords = timeOurBeats(reference.words, lines.map((l, i) => ({ line: l.line, start: span.beats[i].start, end: span.beats[i].end })));
  const voiceInput = {
    reference: input.referencePath,
    end,
    lines: lines.map((l, i) => ({ text: l.line, emotion: l.emotion, start: span.beats[i].start, end: span.beats[i].end })),
    host: input.host.persona.voice.id,
    others: cohost ? segments.filter((s) => s.kind === "stitch").map((s) => ({ start: s.start, end: s.end, voiceId: cohost.persona.voice.id })) : [],
    mode: voiceMode(input.voice, input.host.persona.gender, genderOf(layout.presenter)),
    delivery: input.breakdown.delivery,
    separate,
  };
  // A presenter that does not voice itself gets our voice first (an audio-driven one lip-syncs to it).
  let voice: Voice | null = presenter.voice === "own" ? null : await makeVoice(work, deps.monid, manifest.audio, voiceInput);
  if (voice) notes.push(...voice.notes.filter((n) => !notes.includes(n)));
  await progress();

  // 8. The presenter, render by render: the twin frame first, then the model.
  await pool(renders, 3, async ({ layer, chunk, id, n }) => {
    if (manifest.fallbacks[layer.id]) return;
    const person = personFor(layer);
    const who = person.handle;
    const speaks = layer.speaks;
    const line = speaks ? wordsIn(ourWords, chunk.start, chunk.end) : "";
    const key = hash([layer.crop, layer.ratio, layer.blank, chunk.takes.map((t) => [t.start, t.end]), who.persona.portrait_key, who.persona.description, presenter.name, line, presenter.needs.audio ? manifest.audio.made_hash : null]);
    if (manifest.takes[id]?.key !== key) manifest.takes[id] = { key, render: {} };
    const rec = manifest.takes[id];
    if (rec.failed) return;
    try {
      const seconds = round(chunk.end - chunk.start);
      const crop = toReference(layer.crop, stage, info);
      const blank = layer.blank.map((b) => {
        const r = toReference(b, stage, info);
        return { ...r, x: r.x - crop.x, y: r.y - crop.y };
      });
      const first = { ...chunk.takes[0], frame_at: afterCut(chunk.takes[0], softCuts) };
      let frameUrl: string | null = null;
      if (presenter.needs.frame) frameUrl = await twinFrame(work, naive, rec, { reference: input.referencePath, take: first, crop, blank, layer, layout, who, portraitUrl: person.url, portraitJpeg: person.jpeg, uiKey: `${input.prefix}/shot${n}-frame.png`, idem: `${input.idem}-${id}-${key}` });
      let motionUrl: string | null = null;
      if (presenter.needs.motion) {
        const clip = join(dir, `${id}-motion.mp4`);
        await ffmpeg(motionClipArgs({ reference: input.referencePath, start: chunk.start, seconds, crop, blank, minSeconds: presenter.price.minSeconds, out: clip }));
        motionUrl = await work.host(clip, "video/mp4");
      }
      let audioUrl: string | null = null;
      if (presenter.needs.audio && voice) {
        const slice = join(dir, `${id}-voice.wav`);
        await ffmpeg(sliceArgs(voice.voice, chunk.start, seconds, presenter.price.minSeconds, slice));
        audioUrl = await work.host(slice, "audio/wav");
      }
      const beatAt = (t: number) => Math.max(0, span.beats.findIndex((b) => t >= b.start - 0.05 && t < b.end));
      const emotion = [...new Set(span.beats.map((b, i) => (b.start < chunk.end && b.end > chunk.start ? lines[i].emotion : "")).filter(Boolean))].slice(0, 3).join(" ");
      const shots = chunk.takes.map((take) => {
        const beat = layout.beats[beatAt(take.start)];
        return { seconds: round(take.end - take.start, 2), framing: beat?.presenter.framing ?? "", action: presenterOnly(beat?.presenter.motion ?? "") };
      });
      const presenterInput: PresenterInput = {
        seconds,
        ratio: layer.ratio,
        green: layer.inset,
        persona: { description: who.persona.description, gender: who.persona.gender, portraitUrl: person.url },
        frameUrl,
        motionUrl,
        audioUrl,
        line,
        emotion,
        action: shots[0]?.action ?? "",
        shots,
      };
      await renderPresenter(work, presenter, presenterInput, rec.render, { key: `takes/${id}.mp4`, idem: `${input.idem}-${id}-${key}`, tries: RENDER_TRIES });
      say(`Take ${n} (${layer.role === "cohost" ? "co-host" : layer.inset ? "host cut-out" : "host"}, ${chunk.start.toFixed(1)}-${chunk.end.toFixed(1)} s, ${chunk.takes.length} shot${chunk.takes.length > 1 ? "s" : ""}) rendered`);
    } catch (error) {
      if (stopping(error)) throw error;
      rec.failed = error instanceof Error ? error.message : String(error);
      manifest.fallbacks[layer.id] = `take ${n}: ${rec.failed}`;
      say(`Take ${n} could not be rendered (${rec.failed.slice(0, 200)}); ${layer.inset ? "the cut-out is left out" : "the segment cuts to our own graphic"}`);
    } finally {
      await save();
      await progress();
    }
  });

  // 9. Graphics, then the filmed monitors (they show the screens the builder made).
  await graphicsJob;
  const built = new Map<string, { kind: "video" | "image"; path: string }>();
  for (const clip of manifest.graphics?.clips ?? []) {
    const path = await work.local(clip.key);
    if (path) built.set(clip.id, { kind: clip.kind, path });
  }
  for (const failure of manifest.graphics?.failures ?? []) notes.push(`graphic ${failure.id}: ${failure.error}`);
  for (const layer of layers.filter((l) => l.kind === "screen")) {
    const segment = segments.find((s) => s.n === layer.segment)!;
    try {
      const path = await filmedMonitor(work, naive, manifest, { layer, segment, layout, stage, stageRef, reference: input.referencePath, built, product: input.product, mode: input.screens ?? "auto", cuts: manifest.real?.[layer.id] ?? [], idem: `${input.idem}-${layer.id}` });
      if (!path) manifest.fallbacks[layer.id] ??= "the filmed monitor could not be rebuilt";
    } catch (error) {
      if (stopping(error)) throw error;
      manifest.fallbacks[layer.id] = `the filmed monitor: ${error instanceof Error ? error.message : String(error)}`;
    }
    await save();
  }

  // 10. Our own equivalent for every base layer that could not be cloned: a product graphic.
  const fallbackRequests = layers
    .filter((l) => !l.inset && (manifest.fallbacks[l.id] || (l.kind === "graphic" && !built.has(l.id))))
    .map((l) => stageGraphic(`fb-${l.id}`, { stage, seconds: l.end - l.start, line: lineAt(span.beats, scriptLines, l.start, l.end), shows: "", product: input.product }));
  if (fallbackRequests.length) {
    await buildGraphics(work, deps, manifest, [...requests, ...fallbackRequests], input).catch((error: unknown) => {
      if (stopping(error)) throw error;
    });
    for (const clip of manifest.graphics?.clips ?? []) {
      const path = built.has(clip.id) ? null : await work.local(clip.key);
      if (path) built.set(clip.id, { kind: clip.kind, path });
    }
  }
  for (const [layer, reason] of Object.entries(manifest.fallbacks)) notes.push(`${layer}: ${reason}`);

  // 11. The voices. A presenter with its own voice: each render's voice for its stretch, its lead-in
  // skipped and a long line sped up (picture with it), timed by speech-to-text; our read only for
  // stretches no render says. Otherwise our voice for the whole piece.
  const fits = new Map<string, { from: number; speed: number }>();
  const pieces: VoicePiece[] = [];
  const captionWords: TimedWord[] = [];
  const voices: VoiceReport[] = [];
  if (presenter.voice === "own") {
    const covered: Array<{ start: number; end: number }> = [];
    for (const { layer, chunk, id } of renders) {
      const rec = manifest.takes[id];
      const clip = await work.local(rec?.render.clip_key);
      if (!clip || manifest.fallbacks[layer.id] || !layer.speaks) continue;
      const len = round(chunk.end - chunk.start);
      const person = personFor(layer);
      const said = await renderVoice(work, deps.monid, (rec.voice ??= {}), { clip, id, matchVoice: input.voiceMatch ? person.handle.persona.voice.id : null, voiceStats });
      const speech = said.words.length ? { from: said.words[0].start, to: said.words[said.words.length - 1].end } : null;
      const refFirst = ourWords.find((w) => w.start >= chunk.start - 0.05 && w.start < chunk.end);
      const fit = fitChunk({ duration: (await probe(clip)).duration, speech }, { length: len, speechFrom: refFirst ? refFirst.start - chunk.start : null }, chunk.end >= end - 0.05 ? FINAL_BREATH : undefined);
      fits.set(id, fit);
      if (fit.cut) notes.push(`${id}: the line ran past ${len.toFixed(1)} s even at 1.25x; its end is cut`);
      pieces.push({ path: said.audio, from: fit.from, seconds: len, speed: fit.speed, at: chunk.start });
      covered.push({ start: chunk.start, end: chunk.end });
      // Captions spell our script's words, timed by what the render said: speech-to-text mishears
      // product names ("monid.ai/SKILL.md" came back as "Monday/Skilldad").
      const meant = wordsIn(ourWords, chunk.start, chunk.end);
      for (const w of said.words.length && meant ? timeOurWords(said.words, meant) : said.words) {
        const at = (w.start - fit.from) / fit.speed;
        if (at < -0.05 || at >= len) continue;
        captionWords.push({ text: w.text, start: round(chunk.start + Math.max(0, at)), end: round(chunk.start + Math.min(len, (w.end - fit.from) / fit.speed)) });
      }
      voices.push({ render: id, role: layer.role === "cohost" ? "cohost" : "host", words: said.words.length, words_per_s: speech && speech.to > speech.from ? round(said.words.length / (speech.to - speech.from), 2) : null, pitch_hz: rec.voice?.stats?.pitch_hz ?? null, level_db: rec.voice?.stats?.level_db ?? 0, matched: rec.voice?.matched_stats ?? null, speed: fit.speed, cut: fit.cut });
      await save();
    }
    // Words the reference says where no render speaks (a voice-over over a screen, say): our read for those stretches.
    const inside = (t: number) => covered.some((c) => t >= c.start - 0.05 && t < c.end);
    const uncovered = ourWords.filter((w) => !inside(w.start));
    if (uncovered.length) {
      voice = await makeVoice(work, deps.monid, manifest.audio, voiceInput);
      notes.push(...voice.notes.filter((n) => !notes.includes(n)));
      const stretches: Array<{ start: number; end: number }> = [];
      for (const w of voice.ours.filter((o) => !inside(o.start))) {
        const last = stretches[stretches.length - 1];
        if (last && w.start - last.end < 0.4) last.end = w.end;
        else stretches.push({ start: w.start, end: w.end });
        captionWords.push(w);
      }
      for (const s of stretches) {
        const from = Math.max(0, s.start - 0.08);
        pieces.push({ path: voice.voice, from, seconds: round(Math.min(end, s.end + 0.15) - from), speed: 1, at: from });
      }
    }
  } else if (voice) {
    pieces.push({ path: voice.voice, from: 0, seconds: end, speed: 1, at: 0 });
    captionWords.push(...voice.ours);
  }
  captionWords.sort((a, b) => a.start - b.start);

  // 12. The cut.
  say("Cutting the remake");
  const stagePieces: StagePiece[] = [];
  const darkStill = join(dir, "dark.png");
  if (!existsSync(darkStill)) await ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x101014:s=${stage.width}x${stage.height}`, "-frames:v", "1", darkStill]);
  for (const layer of layers.filter((l) => !l.inset).sort((a, b) => a.start - b.start)) {
    const len = round(layer.end - layer.start);
    const fallback = built.get(`fb-${layer.id}`);
    if (layer.kind === "clone" && !manifest.fallbacks[layer.id]) {
      for (const chunk of layer.chunks) {
        const id = `${layer.id}-c${chunk.n}`;
        const clip = await work.local(manifest.takes[id]?.render.clip_key);
        if (!clip) throw new Error(`remake: render ${id} has no clip`);
        const fit = fits.get(id) ?? { from: 0, speed: 1 };
        stagePieces.push({ path: clip, kind: "video", from: fit.from, seconds: round(chunk.end - chunk.start), speed: fit.speed });
      }
    } else if (layer.kind === "keep") {
      stagePieces.push({ path: input.referencePath, kind: "video", from: layer.start, seconds: len, crop: stageRef });
    } else if (layer.kind === "screen" && !manifest.fallbacks[layer.id] && (await work.local(manifest.screens[layer.id]?.clip_key))) {
      stagePieces.push({ path: (await work.local(manifest.screens[layer.id].clip_key))!, kind: "video", from: 0, seconds: len });
    } else if (layer.kind === "graphic" && built.get(layer.id)) {
      const g = built.get(layer.id)!;
      stagePieces.push({ path: g.path, kind: g.kind, from: 0, seconds: len });
    } else if (fallback) {
      stagePieces.push({ path: fallback.path, kind: fallback.kind, from: 0, seconds: len });
    } else {
      // Never the original person: with nothing of ours to show, the stage goes dark under the captions.
      stagePieces.push({ path: darkStill, kind: "image", from: 0, seconds: len });
      notes.push(`${layer.id}: nothing to show, left dark`);
    }
  }
  const stagePath = join(dir, "stage.mp4");
  await ffmpeg(stageArgs(stagePieces, stage, stagePath));

  const insets: ComposeInset[] = [];
  for (const layer of layers.filter((l) => l.inset && !manifest.fallbacks[l.id])) {
    for (const chunk of layer.chunks) {
      const id = `${layer.id}-c${chunk.n}`;
      const clip = await work.local(manifest.takes[id]?.render.clip_key);
      if (!clip) continue;
      const first = await decodeRgb(clip).catch(() => null);
      const fit = fits.get(id) ?? { from: 0, speed: 1 };
      insets.push({ path: clip, start: chunk.start, end: chunk.end, x: layer.crop.x, y: layer.crop.y, width: layer.crop.width, height: layer.crop.height, key: first ? cornerColor(first.rgb, first.width, first.height) : "0x00B140", from: fit.from, speed: fit.speed });
    }
  }
  const graphics: ComposeGraphic[] = planned.flatMap((g) => {
    const clip = built.get(g.id);
    return clip && Math.min(end, g.end) - g.start >= 0.2 ? [{ path: clip.path, kind: clip.kind, start: g.start, end: Math.min(end, g.end), x: g.px.x, y: g.px.y, width: g.px.width, height: g.px.height, entrance: g.entrance }] : [];
  });

  // The closing card: the product's own site over the end of the last line (Dylan: "make sure the
  // plug is good... flash their site or the product").
  const card = await endCard(work, input, dir).catch((error: unknown) => {
    notes.push(`end card skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (card && end > END_CARD_SECONDS + 1) graphics.push({ path: card, kind: "image", start: round(end - END_CARD_SECONDS), end, x: 0, y: 0, width: OUT.width, height: OUT.height, entrance: "fade" });

  const soundtrack = join(dir, "soundtrack.wav");
  await ffmpeg(soundArgs({ voices: pieces, bed: reference.bed, duration: end, finish, out: soundtrack }));

  const cut = join(dir, "cut");
  await rm(cut, { recursive: true, force: true });
  await mkdir(join(cut, "fonts"), { recursive: true });
  await copyFile(DEFAULT_FONT, join(cut, "fonts", basename(DEFAULT_FONT)));
  const ass: string[] = [];
  const texts = layout.texts
    .map((overlay) => ({ overlay, lines: overlayLines(lines[overlayBeat(overlay, span.beats)]?.on_screen_text ?? "", overlay.lines) }))
    .filter((t) => t.lines.length && t.overlay.start < end)
    .map((t) => ({ ...t, overlay: { ...t.overlay, end: Math.min(end, t.overlay.end) } }));
  const skipped = layout.texts.length - texts.length;
  if (skipped > 0) notes.push(`${skipped} text overlay${skipped > 1 ? "s" : ""} left out: the script gave no on-screen text for ${skipped > 1 ? "their beats" : "its beat"}`);
  if (texts.length) {
    await writeFile(join(cut, "texts.ass"), textsAss(texts), "utf8");
    ass.push("texts.ass");
  }
  const captions = wordCaptions(captionWords, layout.captions.words, end);
  if (captions.length) {
    const metrics = await fontMetrics(DEFAULT_FONT);
    await writeFile(join(cut, "captions.ass"), toAss({ captions, overlays: [] }, { width: OUT.width, height: OUT.height, metrics, caption: captionStyle(layout.captions) }), "utf8");
    ass.push("captions.ass");
  }
  const finalPath = join(dir, "final.mp4");
  await ffmpeg(composeArgs({ stage: stagePath, audio: soundtrack, place: stage, duration: end, insets, graphics, ass, finish, out: finalPath }), { cwd: cut });

  // 13. The check: our frames against the reference's at the same moments.
  try {
    manifest.qc = await checkClone(naive, { reference: input.referencePath, ours: finalPath, stage, stageRef, layers, host: hostPerson.jpeg, cohost: cohost ? cohostPerson.jpeg : null });
    if (manifest.qc && !manifest.qc.pass) notes.push(`check: ${manifest.qc.score}/10 ${manifest.qc.issues.slice(0, 2).join("; ")}`);
  } catch (error) {
    if (error instanceof ApiError && error.outOfCredits) throw error;
    notes.push(`check skipped: ${error instanceof Error ? error.message : String(error)}`);
    manifest.qc = null;
  }

  const key = `${input.prefix}/final.mp4`;
  await files.putFile(key, finalPath, "video/mp4");
  const poster = join(dir, "poster.png");
  let posterKey: string | null = null;
  try {
    await ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-ss", fmt(Math.min(1, end / 2)), "-i", finalPath, "-frames:v", "1", "-vf", "scale=540:-2", poster]);
    posterKey = `${input.prefix}/shot0-frame.png`;
    await files.putFile(posterKey, poster, "image/png");
  } catch {
    posterKey = null;
  }
  await save();
  await progress();
  say(`Remake ready: ${end.toFixed(1)} s, $${((manifest.spend.naive_micro + manifest.spend.monid_micro) / 1e6).toFixed(2)} spent`);
  return { key, path: finalPath, poster_key: posterKey, duration: end, layout, layers, estimate, spend: { ...manifest.spend }, qc: manifest.qc ?? null, voices, notes };
}

/** The desktop screens a filmed monitor shows: one per beat it spans, our product's real UI for what is said. */
function screenRequests(layer: CloneLayer, segment: RemakeSegment, beats: ReferenceBeat[], lines: string[], product: ProductBrief): ScreenRequest[] {
  return beats
    .map((beat, i) => ({ beat, i, from: Math.max(beat.start, layer.start), to: Math.min(beat.end, layer.end) }))
    .filter((b) => b.to - b.from >= 0.4)
    .map(({ i, from, to }) => ({
      id: `${layer.id}-b${i + 1}`,
      brief: `What a computer monitor shows while this is said: "${lines[i] ?? ""}". ${product.name}'s own app, site or terminal as a real desktop window, with its real wording and commands.${segment.screen ? ` The reference's monitor showed: ${segment.screen}. Show this product's equivalent step.` : ""}`,
      line: lines[i] ?? "",
      seconds: round(to - from + 0.4, 2),
      reference_visual: segment.screen || segment.shows,
      size: "desktop" as const,
    }));
}

/**
 * Builds the graphics and screens not built yet, keeping each by key. A request that changed (a
 * new script line) is built again; one that failed only because the model was busy is tried again.
 */
async function buildGraphics(work: Work, deps: RemakeDeps, manifest: Manifest, requests: ScreenRequest[], input: Pick<RemakeInput, "product" | "kit" | "breakdown">) {
  if (!requests.length) return;
  const wanted = new Map(requests.map((r) => [r.id, hash([r.brief, r.line, r.size, r.box, r.seconds])]));
  const before = manifest.graphics ?? { key: "", clips: [], failures: [] };
  const current = <T extends { id: string; hash?: string }>(entry: T) => wanted.get(entry.id) === entry.hash;
  const settled = new Set([...before.clips.filter(current).map((c) => c.id), ...before.failures.filter((f) => current(f) && !busy(f)).map((f) => f.id)]);
  const todo = requests.filter((r) => !settled.has(r.id));
  if (!todo.length) return;
  work.say(`Building ${todo.length} graphics and screens in the reference's places`);
  const dir = join(work.dir, "graphics");
  await mkdir(dir, { recursive: true });
  const build = deps.buildGraphics ?? ((list: ScreenRequest[], at: string) => buildScreens(deps.naive, list, { product: input.product, kit: input.kit, style: input.breakdown.format }, { workDir: at, render: { pushIn: 0 }, keepFailed: true }));
  const result = await build(todo, dir);
  // A graphic that failed only because the model was busy is built again in this run, after a
  // wait: left for a rerun, the Cluely remake went out without its opening LinkedIn card.
  for (const wait of deps.busyWaitsMs ?? [20_000, 45_000, 90_000]) {
    const again = todo.filter((r) => result.failures.some((f) => f.id === r.id && busy(f)));
    if (!again.length) break;
    work.say(`The model was busy for ${again.length} graphic${again.length === 1 ? "" : "s"}: trying again in ${Math.round(wait / 1000)} s`);
    await new Promise((done) => setTimeout(done, wait));
    const retry = await build(again, dir);
    result.failures = [...result.failures.filter((f) => !again.some((r) => r.id === f.id)), ...retry.failures];
    result.clips = [...result.clips.filter((c) => !again.some((r) => r.id === c.id)), ...retry.clips];
  }
  const redone = new Set(todo.map((r) => r.id));
  const kept = await Promise.all(
    result.clips.map(async (clip) => ({ id: clip.id, kind: clip.kind, hash: wanted.get(clip.id), key: await work.keep(`graphics/${basename(clip.path)}`, clip.path, clip.kind === "video" ? "video/mp4" : "image/png") })),
  );
  manifest.graphics = {
    key: hash([...wanted.values()]),
    clips: [...before.clips.filter((c) => !redone.has(c.id)), ...kept],
    failures: [...before.failures.filter((f) => !redone.has(f.id)), ...result.failures.map((f) => ({ id: f.id, error: f.error, hash: wanted.get(f.id), ...(f.retryable ? { retryable: true } : {}) }))],
  };
  await work.save();
}

/**
 * The twin frame of one take: the reference frame cropped to the layer, with our person in the
 * same pose, size and place (on green for a cut-out), checked by the first-frame gate and remade
 * with its notes up to TWIN_TRIES. Kept as the UI's frame for the take. Returns its public link.
 */
async function twinFrame(
  work: Work,
  naive: RemakeNaive,
  rec: TakeRecord,
  o: { reference: string; take: { frame_at: number }; crop: Rect; blank: Rect[]; layer: CloneLayer; layout: RemakeLayout; who: PersonaHandle; portraitUrl: string; portraitJpeg: Buffer | null; uiKey: string; idem: string },
): Promise<string> {
  const twin = join(work.dir, `${basename(o.uiKey, ".png")}-twin.png`);
  if (rec.frame_done && rec.frame_key) {
    const kept = await work.local(rec.frame_key);
    if (kept) return work.host(kept, "image/png");
  }
  const refPng = join(work.dir, `${basename(o.uiKey, ".png")}-reference.png`);
  await ffmpeg(frameArgs({ reference: o.reference, at: o.take.frame_at, crop: o.crop, blank: o.blank, out: refPng }));
  const refUrl = await work.host(refPng, "image/png");
  const refJpeg = await grabJpeg(refPng, null).catch(() => null);
  while (!rec.frame_done) {
    const tries = rec.frame_tries ?? 0;
    const prompt = twinPrompt({ look: o.who.persona.description, gender: o.who.persona.gender, set: o.layout.set, green: o.layer.inset, blanked: o.layer.blank.length > 0, fix: rec.frame_fix });
    // A prebuilt character renders its own face; our own persona is the second image.
    const character = o.who.persona.character ? { character: o.who.persona.character, style: CHARACTER_STYLE } : {};
    const image = await withInFlight(() => naive.generateImage({ prompt, aspect_ratio: o.layer.ratio, image_urls: [refUrl, o.portraitUrl], ...character }, `${o.idem}-twin${tries ? `-g${tries}` : ""}`), work.pollMs);
    const file = image.files[0];
    if (!file) throw new ApiError("naive", 502, "no_file", "the twin frame came back empty");
    work.spend("naive", image.cost_micro_usd ?? 0);
    rec.frame_micro = (rec.frame_micro ?? 0) + (image.cost_micro_usd ?? 0);
    rec.frame_tries = tries + 1;
    await work.fetch((await naive.fileUrl(file.id)).url, twin);
    await work.files.putFile(o.uiKey, twin, "image/png");
    rec.frame_key = o.uiKey;
    let verdict: { pass: boolean; issues: string[] } = { pass: true, issues: [] };
    try {
      verdict = await reviewFrame(naive, { image: await grabJpeg(twin, null), creator: o.who.persona.description, setting: o.layer.inset ? "a flat green screen" : o.layout.set, prompt, persona: o.portraitJpeg, reference: refJpeg, expect: o.layer.inset ? GREEN_GATE : undefined });
    } catch (error) {
      if (error instanceof ApiError && error.outOfCredits) throw error;
      // A check that cannot run (busy, unreadable) never holds the video up, as in production.
    }
    if (verdict.pass || rec.frame_tries >= TWIN_TRIES) {
      rec.frame_done = true;
    } else {
      rec.frame_fix = verdict.issues.slice(0, 3).join(" ").replace(/(['"‘“])[^'"’”]{0,200}(['"’”])/g, "").slice(0, 500);
      work.say(`Remaking a twin frame (${verdict.issues.join("; ").slice(0, 200)})`);
    }
    await work.save();
  }
  return work.host(twin, "image/png");
}

/**
 * A filmed-monitor segment, stage size: the reference's own footage with our screens tracked into
 * its display (when the corners hold up), else the filmed_screen plate with hand-held motion.
 * Returns the clip's local path, or null when neither works.
 */
async function filmedMonitor(
  work: Work,
  naive: RemakeNaive,
  manifest: Manifest,
  o: { layer: CloneLayer; segment: RemakeSegment; layout: RemakeLayout; stage: Stage; stageRef: Rect; reference: string; built: Map<string, { kind: "video" | "image"; path: string }>; product: ProductBrief; mode: "auto" | "track" | "plate"; cuts: number[]; idem: string },
): Promise<string | null> {
  const { layer, segment, stage } = o;
  const seconds = round(layer.end - layer.start);
  // What the monitor shows: our screens by beat; without them, the product's captured pages.
  const ids = [...o.built.keys()].filter((id) => id.startsWith(`${layer.id}-b`)).sort((a, b) => Number(a.split("-b")[1]) - Number(b.split("-b")[1]));
  let content = ids.map((id) => ({ path: o.built.get(id)!.path, kind: o.built.get(id)!.kind }));
  if (!content.length) content = o.product.visuals.filter((v) => !/^https?:/.test(v.url) && existsSync(v.url) && v.kind !== "video").slice(0, 3).map((v) => ({ path: v.url, kind: "image" as const }));
  if (!content.length) return null;
  const pieces = content.map((c) => ({ ...c, seconds: round(seconds / content.length) }));
  const key = hash([layer.id, layer.start, layer.end, o.mode, pieces.map((p) => basename(p.path))]);
  const rec = (manifest.screens[layer.id] = manifest.screens[layer.id]?.key === key ? manifest.screens[layer.id] : { key });
  const kept = await work.local(rec.clip_key);
  if (kept) return kept;
  const stream = join(work.dir, `${layer.id}-screens.mp4`);
  await ffmpeg(screenStreamArgs(pieces, stream));

  if (o.mode !== "plate") {
    const times = cornerTimes(layer, o.cuts);
    const frames: Array<{ t: number; jpeg: Buffer }> = [];
    for (const t of times) {
      const jpeg = await grabJpeg(o.reference, t, 720, o.stageRef).catch(() => null);
      if (jpeg?.length) frames.push({ t, jpeg });
    }
    let keys: QuadKey[] = [];
    let usable = { ok: false, reason: "no frames" };
    if (frames.length) {
      keys = parseQuads(await readScreenCorners(naive, frames, QC_MODEL), stage);
      usable = quadsUsable(keys, frames.length, stage, o.cuts);
    }
    if (usable.ok) {
      const out = join(work.dir, `${layer.id}-tracked.mp4`);
      const cover = [
        ...(segment.presenter.inset ? [{ x: Math.round(segment.presenter.inset.x * stage.width), y: Math.round(segment.presenter.inset.y * stage.height), width: even(segment.presenter.inset.w * stage.width), height: even(segment.presenter.inset.h * stage.height) }] : []),
      ].filter((r) => r.width > 4 && r.height > 4 && r.x + r.width <= stage.width && r.y + r.height <= stage.height);
      await ffmpeg(trackedScreenArgs({ reference: o.reference, start: layer.start, seconds, crop: o.stageRef, size: stage, screen: stream, keys: warpKeys(keys, layer.start, OUT.fps, o.cuts), cover, out }));
      rec.mode = "track";
      rec.clip_key = await work.keep(`screens/${layer.id}.mp4`, out, "video/mp4");
      await work.save();
      return out;
    }
    rec.reason = usable.reason;
    work.say(`The filmed monitor's corners don't hold up (${usable.reason}); using a monitor plate instead`);
  }

  // The fallback: filmed_screen's plate, our screens warped into its display, hand-held motion.
  const plate: PlateRecord = (rec.plate ??= newPlateRecord());
  // makePlate moves the record on; read its status fresh rather than as a check narrowed it.
  const status = (): PlateRecord["status"] => plate.status;
  const plateDir = join(work.dir, `${layer.id}-plate`);
  await mkdir(plateDir, { recursive: true });
  if (status() === "pending") {
    const before = plate.cost_micro;
    await makePlate(naive, plate, { dir: plateDir, key: o.idem, setting: segment.shows, fetchTo: (url, path) => work.fetch(url, path) });
    work.spend("naive", plate.cost_micro - before);
    if (status() === "ready" && plate.plate) rec.plate_key = await work.keep(`screens/${layer.id}-plate.png`, plate.plate.path, "image/png");
    await work.save();
  }
  const platePath = await work.local(rec.plate_key);
  if (status() !== "ready" || !plate.plate || !platePath) return null;
  const out = join(work.dir, `${layer.id}-plate.mp4`);
  let at = 0;
  const timeline: EditTimeline = {
    aroll: [],
    audio: null,
    segments: pieces.map((p) => {
      const segmentOut = { start: round(at), end: round(at + p.seconds), layer: "filmed" as const, broll: { path: p.path, kind: p.kind, motion: "none" as const }, plate: { path: platePath, quad: plate.plate!.quad } };
      at += p.seconds;
      return segmentOut;
    }),
    captions: [],
    overlays: [],
    duration: seconds,
  };
  await renderTimeline(timeline, out, { workDir: plateDir });
  rec.mode = "plate";
  rec.clip_key = await work.keep(`screens/${layer.id}.mp4`, out, "video/mp4");
  await work.save();
  return out;
}

/** The final check: one moment per take or segment (at most five), ours against the reference's, with our people's portraits. */
async function checkClone(naive: Pick<NaiveClient, "message">, o: { reference: string; ours: string; stage: Stage; stageRef: Rect; layers: CloneLayer[]; host: Buffer | null; cohost: Buffer | null }): Promise<CloneVerdict | null> {
  if (!o.host) return null;
  const moments = o.layers
    .filter((l) => !l.inset)
    .flatMap((l) => (l.takes.length ? l.takes.map((t) => ({ t: (t.start + t.end) / 2, what: `${l.kind === "clone" ? (l.role === "cohost" ? "co-host" : "host") : l.kind}` })) : [{ t: (l.start + l.end) / 2, what: l.kind }]))
    .slice(0, 5);
  const ourStage = { x: o.stage.x, y: o.stage.y, width: o.stage.width, height: o.stage.height };
  const pairs = [];
  for (const m of moments) {
    const [reference, ours] = await Promise.all([grabJpeg(o.reference, m.t, 400, o.stageRef), grabJpeg(o.ours, m.t, 400, ourStage)]);
    pairs.push({ t: m.t, reference, ours, what: m.what });
  }
  return pairs.length ? reviewClone(naive, { pairs, host: o.host, cohost: o.cohost }) : null;
}

/** Whether a reference video file is usable (size, not a stub), for callers that download it. */
export const playable = (path: string) => existsSync(path) && statSync(path).size > 10_000;
