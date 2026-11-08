// The brainrot cut: the clips back to back with hard cuts, the product's real site as the end card,
// meme text (the hook, karaoke lyrics, one huge word at a time, stamps slammed in at an angle), the
// voice over a ducked beat, sound effects on cue, bass-boosted drops, and the picture effects the
// format runs on (zoom punches, shake, deep fry, flash frames, an RGB glitch, a fisheye bulge).
//
//   buildCut (pure: script + measured assets → BrainrotCut) → brainrotAss + cutArgs → ffmpeg
//
// Everything is placed on one clock here, so the tests can check the timeline without ffmpeg.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { type BrainrotFx, type BrainrotScript, type BrainrotSfx, RECIPES } from "./brainrot";
import { assTime, balanceLines, escapeAssText, type FontMetrics, roundedRect, textWidth } from "./captions";
import { DEFAULT_FONT, editFfmpeg, fontMetrics } from "./edit";

const exec = promisify(execFile);

export const W = 1080;
export const H = 1920;
export const FPS = 30;

/** A clip on the cut: `seconds` long from `from`; a clip shorter than that (`length`) plays slowed down to fill it. */
export type CutClip = { path: string; seconds: number; from: number; length?: number };

export type CutText =
  | { kind: "hook"; start: number; end: number; text: string }
  | { kind: "word"; start: number; end: number; text: string }
  | { kind: "lyric"; start: number; end: number; text: string; keyword: string; color: number }
  | { kind: "line"; start: number; end: number; text: string }
  | { kind: "stamp"; start: number; end: number; text: string; color: number; tilt: number; y?: number }
  /** The funnel bit's diagram: row `index` of `count`, shown from its shot to the end card. */
  | { kind: "row"; start: number; end: number; index: number; count: number; value: string; label: string }
  | { kind: "end"; start: number; end: number; text: string; sub: string };

export type CutSound = { path: string; at: number; gain: number; bus: "voice" | "music" | "sfx"; seconds?: number; fadeOut?: number };
export type CutFx = { start: number; end: number; fx: BrainrotFx };

export type BrainrotCut = {
  clips: CutClip[];
  /** The end card: the mascot with the site over it (centred), or the product's page (from its top). */
  end: { image: string; seconds: number; anchor: "center" | "top" } | null;
  duration: number;
  texts: CutText[];
  sounds: CutSound[];
  fx: CutFx[];
  /** Bass-boosted, clipped stretches of the whole mix. */
  boosts: Array<{ start: number; end: number }>;
  /** Where each shot starts on the cut, for checks and the camp. */
  starts: number[];
};

export type CutInput = {
  script: BrainrotScript;
  /** Per shot, in order: its rendered clip and its voice line (null for a silent shot). */
  shots: Array<{ clip: string; voice: { path: string; seconds: number } | null; length?: number }>;
  endVoice: { path: string; seconds: number } | null;
  endImage: string | null;
  /** "center" for the mascot card (the default), "top" for a page screenshot. */
  endAnchor?: "center" | "top";
  music: { bed: string | null; hype: string | null };
  sfx: Partial<Record<BrainrotSfx, string>>;
  site: string;
};

/** The funnel diagram's layout at 1080x1920: where it starts (a fraction of the height), row size, bar lengths, colours. */
// A compact, opaque card at the very top (the hook is gone by the time the first row lands): the
// video model frames the creator bigger than asked, and a see-through card over a face read as a glitch.
export const FUNNEL = { top: 0.035, row: 88, gap: 10, left: 50, minBar: 90, step: 44, colors: [0xf2a7e6, 0x9a9aa0, 0xc7db6a, 0x7fd8ea, 0xb89af0, 0xf7b267] } as const;

/** The accent colours karaoke keywords and stamps cycle through (0xRRGGBB). */
export const ACCENTS = [0xffe600, 0x00e5ff, 0xff4fd8, 0x39ff14, 0xff8a00];

/** A stamp's colour from what it says: aura purple, mogged red, 6-7 yellow, it's over grey, so back green. */
export function stampColor(text: string, n: number): number {
  if (/aura/i.test(text)) return 0xb44cff;
  if (/mog/i.test(text)) return 0xff2d2d;
  if (/6\s*-\s*7|\b67\b/.test(text)) return 0xffe600;
  if (/over|cooked/i.test(text)) return 0x9aa7b8;
  if (/back|w\b/i.test(text)) return 0x39ff14;
  return ACCENTS[n % ACCENTS.length];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
/** Lead before a voice line starts in its shot, and the breath after it. */
const LEAD = 0.12;
const TAIL = 0.22;
/** The stunt opener runs at least this long, even when its line is short. */
const OPENER = 1.8;

/** How long each shot lasts on the cut: its voice line and a breath, or the bit's silent length. */
export function shotDurations(input: Pick<CutInput, "script" | "shots">): number[] {
  const recipe = RECIPES[input.script.bit];
  return input.script.shots.map((shot, i) => {
    const voice = input.shots[i]?.voice;
    const spoken = voice ? voice.seconds + LEAD + TAIL : 0;
    const floor = voice ? 1.5 : Math.max(1.6, Math.min(4.5, shot.seconds || recipe.silentSeconds));
    return round(Math.max(spoken, floor, i === 0 ? OPENER : 0));
  });
}

/**
 * Words spread over a stretch by their length (one huge word at a time, or chunks of up to `per`),
 * the chunks evened out so no word is left on its own ("twenty phones" / "thirty-one seconds").
 */
export function spreadWords(text: string, start: number, seconds: number, per = 1): Array<{ start: number; end: number; text: string }> {
  const words = text.split(/\s+/).filter(Boolean);
  const count = Math.ceil(words.length / Math.max(1, per));
  const chunks: string[] = [];
  for (let c = 0, at = 0; c < count; c++) {
    const size = Math.ceil((words.length - at) / (count - c));
    chunks.push(words.slice(at, at + size).join(" "));
    at += size;
  }
  if (!chunks.length || seconds <= 0) return [];
  const weights = chunks.map((c) => Math.max(2, c.replace(/[^\p{L}\p{N}]/gu, "").length) + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let at = start;
  return chunks.map((c, i) => {
    const length = (weights[i] / total) * seconds;
    const out = { start: round(at), end: round(at + length), text: c };
    at += length;
    return out;
  });
}

/** Where the stamp lands in a shot: on the punchline, a beat after the cut. */
const stampAt = (start: number, seconds: number) => round(start + Math.min(0.45, seconds * 0.3));

/** Every effect, text, sound and boost on one clock (pure: no files are read). */
export function buildCut(input: CutInput): BrainrotCut {
  const { script } = input;
  const durations = shotDurations(input);
  const starts: number[] = [];
  let at = 0;
  for (const d of durations) {
    starts.push(round(at));
    at += d;
  }
  const picture = round(at);
  const endSeconds = input.endImage ? round(Math.max(2.6, (input.endVoice?.seconds ?? 0) + 0.7)) : 0;
  const duration = round(picture + endSeconds);
  const texts: CutText[] = [];
  const sounds: CutSound[] = [];
  const fx: CutFx[] = [];
  const boosts: Array<{ start: number; end: number }> = [];
  const sfx = (name: BrainrotSfx, time: number, gain = 0.9) => {
    const path = input.sfx[name];
    if (path) sounds.push({ path, at: round(time), gain, bus: "sfx" });
  };

  if (script.hook) texts.push({ kind: "hook", start: 0, end: round(Math.min(durations[0] + (durations[1] ?? 0) * 0.5, 3.4)), text: script.hook });

  script.shots.forEach((shot, i) => {
    const start = starts[i];
    const seconds = durations[i];
    const end = round(start + seconds);
    const voice = input.shots[i]?.voice ?? null;
    if (voice) sounds.push({ path: voice.path, at: round(start + LEAD), gain: 1, bus: "voice" });
    const said = { start: round(start + LEAD), seconds: voice ? voice.seconds : seconds - LEAD };
    if (shot.words) {
      if (script.bit === "anthem") texts.push({ kind: "lyric", start: said.start, end: round(end - 0.02), text: shot.words, keyword: shot.keyword, color: ACCENTS[i % ACCENTS.length] });
      else if (script.bit === "melodrama") for (const w of spreadWords(shot.words, said.start, said.seconds, 1)) texts.push({ kind: "word", ...w });
      else for (const w of spreadWords(shot.words, said.start, said.seconds, 3)) texts.push({ kind: "line", ...w });
    }
    const hit = stampAt(start, seconds);
    // The funnel fills the top half, so its stamps land lower, over the creator.
    if (shot.stamp) texts.push({ kind: "stamp", start: hit, end: round(Math.min(end, hit + 1.4)), text: shot.stamp, color: stampColor(shot.stamp, i), tilt: i % 2 ? 7 : -7, ...(script.bit === "funnel" ? { y: 0.6 } : {}) });
    // The first effect lands on the cut, the rest on the stamp; "6-7" gets its chant.
    shot.sfx.forEach((name, k) => sfx(name, k === 0 ? start : hit, name === "airhorn" ? 0.6 : name === "six_seven" ? 0.85 : 0.9));
    if (/6\s*-\s*7|six\s+seven/i.test(`${shot.stamp} ${shot.words}`) && !shot.sfx.includes("six_seven") && !voice) sfx("six_seven", hit, 0.8);
    for (const kind of shot.fx) {
      if (kind === "zoom_punch") fx.push({ start: hit, end: round(Math.min(end, hit + 0.9)), fx: kind });
      else if (kind === "shake") fx.push({ start, end: round(Math.min(end, start + 1.2)), fx: kind });
      else if (kind === "deep_fry") fx.push({ start: hit, end: round(Math.min(end, hit + 1.4)), fx: kind });
      else if (kind === "flash") fx.push({ start, end: round(start + 0.08), fx: kind });
      else if (kind === "glitch") fx.push({ start, end: round(Math.min(end, start + 0.4)), fx: kind });
      else if (kind === "fisheye") fx.push({ start: hit, end: round(Math.min(end, hit + 1.1)), fx: kind });
      else fx.push({ start, end, fx: kind });
    }
    if (shot.sfx.some((name) => name === "bass_drop" || name === "airhorn" || name === "explosion") || shot.fx.includes("deep_fry")) boosts.push({ start: hit, end: round(Math.min(end, hit + 1.2)) });
  });

  // The funnel: each row from its shot (a beat after the cut) to the end card, a ding as it lands.
  const rows = script.bit === "funnel" ? (script.funnel ?? []) : [];
  rows.forEach((row, index) => {
    const at = round((starts[row.shot - 1] ?? 0) + 0.25);
    texts.push({ kind: "row", start: at, end: picture, index, count: rows.length, value: row.value, label: row.label });
    sfx("ding", at, 0.55);
  });

  // The stunt opener always hits hard: a flash on frame one and a shake under the hook.
  if (script.shots.length) {
    if (!fx.some((f) => f.start === 0 && f.fx === "flash")) fx.push({ start: 0, end: 0.08, fx: "flash" });
    if (!fx.some((f) => f.start < durations[0] && f.fx === "shake")) fx.push({ start: 0, end: round(Math.min(durations[0], 1.0)), fx: "shake" });
  }

  // melodrama: the sad bed until the turn, a record scratch, then the hype beat to the end.
  const turn = script.bit === "melodrama" && script.music.turn >= 2 && input.music.hype ? starts[script.music.turn - 1] : null;
  const level = script.bit === "aura" ? 0.85 : script.bit === "anthem" ? 0.6 : 0.5;
  if (input.music.bed) sounds.push({ path: input.music.bed, at: 0, gain: level, bus: "music", seconds: turn ?? duration, fadeOut: turn ? 0.15 : 0.6 });
  if (turn !== null && input.music.hype) {
    sounds.push({ path: input.music.hype, at: turn, gain: 0.75, bus: "music", seconds: round(duration - turn), fadeOut: 0.6 });
    sfx("record_scratch", Math.max(0, turn - 0.25), 0.9);
    boosts.push({ start: turn, end: round(turn + 1.0) });
  }

  if (input.endImage) {
    const start = picture;
    if (input.endVoice) sounds.push({ path: input.endVoice.path, at: round(start + 0.15), gain: 1, bus: "voice" });
    const sub = script.end.text
      .replace(new RegExp(input.site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "")
      .replace(/\s+/g, " ")
      .replace(/^[\s,.;:·•|/-]+|[\s,;:·•|/-]+$/g, "")
      .trim();
    texts.push({ kind: "end", start: round(start + 0.1), end: duration, text: input.site, sub });
    fx.push({ start, end: round(start + 0.08), fx: "flash" }, { start, end: round(start + 0.7), fx: "zoom_punch" }, { start: round(start + 0.7), end: duration, fx: "slow_zoom" });
    sfx("vine_boom", start, 1);
    boosts.push({ start, end: round(start + 0.8) });
  }

  return {
    clips: input.shots.map((s, i) => ({ path: s.clip, seconds: durations[i], from: 0, ...(s.length ? { length: s.length } : {}) })),
    end: input.endImage ? { image: input.endImage, seconds: endSeconds, anchor: input.endAnchor ?? "center" } : null,
    duration,
    texts,
    sounds,
    fx,
    boosts,
    starts,
  };
}

// ---------- text ----------

/** 0xRRGGBB as an ASS colour (&HAABBGGRR). */
export function assColor(rgb: number, alpha = 0): string {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  return `&H${hex(alpha)}${hex(rgb & 0xff)}${hex((rgb >> 8) & 0xff)}${hex((rgb >> 16) & 0xff)}&`;
}

const norm = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The cut's words as an ASS document: one style, every event placed and sized by its own override
 * tags (libass draws them over the effects, so text stays crisp in a deep-fried frame).
 */
export function brainrotAss(cut: Pick<BrainrotCut, "texts">, metrics?: FontMetrics, fontName = metrics?.family || "Poppins ExtraBold"): string {
  const cell = metrics ? (metrics.ascent + metrics.descent) / metrics.unitsPerEm : 1.762;
  const fs = (em: number) => Math.round(em * cell);
  const measure = (text: string, em: number) => (metrics ? textWidth(text, fs(em), metrics) : text.length * em * 0.62);
  const white = assColor(0xffffff);
  const black = assColor(0x000000);
  const events: string[] = [];
  const add = (layer: number, start: number, end: number, tags: string, text: string) => {
    if (!(end > start) || !text.trim()) return;
    events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},Meme,,0,0,0,,{${tags}}${text}`);
  };
  /** Lines of words no wider than `max` px at `em`, shrinking `em` until at most `lines` lines fit. */
  const layout = (words: string[], em: number, max: number, lines: number) => {
    let size = em;
    for (;;) {
      const out = balanceLines(words, max, (s) => measure(s, size));
      const widest = Math.max(...out.map((l) => measure(l, size)));
      if ((out.length <= lines && widest <= max) || size <= 34) return { lines: out, em: size };
      size = Math.floor(size * 0.9);
    }
  };
  const block = (words: string[], o: { em: number; max: number; lines: number; y: number; layer: number; start: number; end: number; tags: string; color?: (word: string) => string | null; outline: number; anchor: "top" | "center" | "bottom" }) => {
    const { lines, em } = layout(words, o.em, o.max, o.lines);
    const pitch = em * 1.12;
    const first = o.anchor === "top" ? o.y + pitch / 2 : o.anchor === "bottom" ? o.y - (lines.length - 0.5) * pitch : o.y - ((lines.length - 1) * pitch) / 2;
    lines.forEach((line, i) => {
      const text = line
        .split(" ")
        .map((word) => {
          const c = o.color?.(word);
          return c ? `{\\c${c}}${escapeAssText(word, "space")}{\\c${white}}` : escapeAssText(word, "space");
        })
        .join(" ");
      add(o.layer, o.start, o.end, `\\an5\\pos(${W / 2},${Math.round(first + i * pitch)})\\fs${fs(em)}\\bord${o.outline}${o.tags}`, text);
    });
  };

  for (const t of cut.texts) {
    const words = "text" in t ? t.text.split(/\s+/).filter(Boolean) : [];
    if (t.kind === "hook") block(words, { em: 66, max: 960, lines: 3, y: H * 0.1, layer: 6, start: t.start, end: t.end, tags: `\\shad5\\4c${black}\\fscx85\\fscy85\\t(0,120,\\fscx100\\fscy100)`, outline: 9, anchor: "top" });
    else if (t.kind === "lyric") {
      const key = norm(t.keyword);
      block(words, { em: 62, max: 980, lines: 3, y: H * 0.83, layer: 5, start: t.start, end: t.end, tags: "", outline: 6, anchor: "bottom", color: (w) => (key && norm(w) === key ? assColor(t.color) : null) });
    } else if (t.kind === "word") block([t.text.toUpperCase()], { em: 112, max: 980, lines: 1, y: H * 0.6, layer: 5, start: t.start, end: t.end, tags: "\\fscx125\\fscy125\\t(0,80,\\fscx100\\fscy100)", outline: 9, anchor: "center" });
    else if (t.kind === "line") block(t.text.toUpperCase().split(/\s+/), { em: 72, max: 960, lines: 2, y: H * 0.74, layer: 5, start: t.start, end: t.end, tags: "\\fscx115\\fscy115\\t(0,80,\\fscx100\\fscy100)", outline: 7, anchor: "center" });
    else if (t.kind === "stamp") {
      const em = Math.min(140, Math.floor((140 * 980) / Math.max(1, measure(t.text, 140))));
      add(7, t.start, t.end, `\\an5\\pos(${W / 2},${Math.round(H * (t.y ?? 0.37))})\\fs${fs(em)}\\bord11\\c${assColor(t.color)}\\3c${black}\\frz${t.tilt}\\fscx240\\fscy240\\t(0,110,\\fscx100\\fscy100)\\t(110,700,\\frz${Math.round(t.tilt * 0.4)})`, escapeAssText(t.text, "space"));
    } else if (t.kind === "row") {
      // The reference's look: pastel bars on a white panel, a big black number and a grey label beside each.
      const top = H * FUNNEL.top;
      const y = Math.round(top + t.index * (FUNNEL.row + FUNNEL.gap));
      // The card grows with the rows: as tall as the rows shown so far, until the next one lands.
      const next = cut.texts.find((o) => o.kind === "row" && o.index === t.index + 1);
      const panelH = Math.round((t.index + 1) * (FUNNEL.row + FUNNEL.gap) + 22);
      add(2, t.start, next ? next.start : t.end, `\\an7\\pos(30,${Math.round(top - 16)})\\p1\\bord0\\shad3\\4c${black}\\1c${white}${t.index === 0 ? "\\fad(150,0)" : ""}`, roundedRect(W - 60, panelH, 30));
      const width = Math.round(FUNNEL.minBar + (t.count - 1 - t.index) * FUNNEL.step);
      const color = FUNNEL.colors[t.index % FUNNEL.colors.length];
      add(3, t.start, t.end, `\\an7\\pos(${FUNNEL.left},${y})\\p1\\bord0\\shad0\\1c${assColor(color)}\\fscx0\\t(0,260,\\fscx100)`, roundedRect(width, FUNNEL.row, 18));
      const x = FUNNEL.left + width + 26;
      const room = W - 50 - x;
      const fit = (text: string, em: number) => Math.max(26, Math.min(em, Math.floor((em * room) / Math.max(1, measure(text, em)))));
      add(4, t.start + 0.15, t.end, `\\an4\\pos(${x},${Math.round(y + FUNNEL.row * 0.34)})\\fs${fs(fit(t.value, 66))}\\bord0\\shad0\\c${black}\\fad(120,0)`, escapeAssText(t.value, "space"));
      if (t.label) add(4, t.start + 0.2, t.end, `\\an4\\pos(${x},${Math.round(y + FUNNEL.row * 0.8)})\\fs${fs(fit(t.label, 38))}\\bord0\\shad0\\c${assColor(0x55555a)}\\fad(120,0)`, escapeAssText(t.label, "space"));
    } else if (t.kind === "end") {
      const em = Math.min(128, Math.floor((128 * 960) / Math.max(1, measure(t.text, 128))));
      add(8, t.start, t.end, `\\an5\\pos(${W / 2},${Math.round(H * 0.76)})\\fs${fs(em)}\\bord12\\shad5\\4c${black}\\c${white}\\fscx180\\fscy180\\t(0,120,\\fscx100\\fscy100)`, escapeAssText(t.text, "space"));
      if (t.sub) block(t.sub.toUpperCase().split(/\s+/), { em: 74, max: 960, lines: 2, y: H * 0.84, layer: 8, start: t.start + 0.25, end: t.end, tags: `\\c${assColor(0xffe600)}\\shad4\\4c${black}`, outline: 7, anchor: "top" });
    }
  }

  return [
    "[Script Info]",
    "; Generated by Nomen's brainrot cut (src/lib/creative/brainrot-cut.ts)",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Meme,${fontName},${fs(64)},${white},${white},${black},${black},0,0,0,0,100,100,0,0,1,7,0,5,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

// ---------- picture and sound ----------

const n3 = (x: number) => String(Math.round(x * 1000) / 1000);
const within = (windows: Array<{ start: number; end: number }>) => windows.map((w) => `between(t,${n3(w.start)},${n3(w.end)})`).join("+") || "0";

/**
 * The zoom at time `T` (an ffmpeg expression in `T`): punches jump in and ease back over their
 * window, slow zooms creep in. 1 outside every window.
 */
export function zoomExpr(fx: CutFx[], T = "(on/30)"): string {
  const parts = fx
    .filter((f) => f.fx === "zoom_punch" || f.fx === "slow_zoom" || f.fx === "fisheye")
    .map((f) =>
      f.fx === "zoom_punch"
        ? `between(${T},${n3(f.start)},${n3(f.end)})*(0.1+0.22*exp(-(${T}-${n3(f.start)})*5))`
        : f.fx === "fisheye"
          ? // The lens bulge samples up to 1 + k1 + k2 times further out at the corners: zoom in that much under it.
            `between(${T},${n3(f.start)},${n3(f.end)})*${n3(FISHEYE.k1 + FISHEYE.k2)}`
          : `between(${T},${n3(f.start)},${n3(f.end)})*0.12*(${T}-${n3(f.start)})/${n3(Math.max(0.1, f.end - f.start))}`,
    );
  return parts.length ? `1+${parts.join("+")}` : "1";
}

/** The most a clip is slowed down to fill its shot. */
export const SLOWEST = 1.35;

/** The fisheye bulge: barrel distortion over a matching zoom, so the middle swells and the frame stays full. */
export const FISHEYE = { k1: 0.38, k2: 0.17 } as const;

/** The ffmpeg arguments for a cut (run in a folder holding brainrot.ass and fonts/). */
export function cutArgs(cut: BrainrotCut, out: string, options: { ass: boolean } = { ass: true }): string[] {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  let inputs = 0;
  const input = (...a: string[]) => {
    args.push(...a);
    return inputs++;
  };
  const graph: string[] = [];
  const parts: string[] = [];

  cut.clips.forEach((clip, i) => {
    const v = input("-ss", n3(clip.from), "-i", resolve(clip.path));
    // A clip a little shorter than its shot plays in slow motion (on brand); the rest holds the last frame.
    const slow = clip.length && clip.length - clip.from < clip.seconds ? Math.min(SLOWEST, clip.seconds / Math.max(0.5, clip.length - clip.from)) : 1;
    graph.push(
      `[${v}:v]${slow > 1.001 ? `setpts=${n3(slow)}*(PTS-STARTPTS),` : ""}scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=8,trim=duration=${n3(clip.seconds)},setpts=PTS-STARTPTS[c${i}]`,
    );
    parts.push(`[c${i}]`);
  });
  if (cut.end) {
    const e = input("-loop", "1", "-framerate", String(FPS), "-t", n3(cut.end.seconds + 0.5), "-i", resolve(cut.end.image));
    // The page shown from its top (its header and name), slightly darkened at the bottom for the text.
    graph.push(
      `[${e}:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H}:(iw-${W})/2:${cut.end.anchor === "top" ? "0" : `(ih-${H})/2`},setsar=1,fps=${FPS},drawbox=x=0:y=${Math.round(H * 0.66)}:w=${W}:h=${Math.round(H * 0.34)}:color=black@0.5:t=fill,trim=duration=${n3(cut.end.seconds)},setpts=PTS-STARTPTS[cend]`,
    );
    parts.push("[cend]");
  }
  graph.push(`${parts.join("")}concat=n=${parts.length}:v=1:a=0,format=yuv420p[base]`);

  // Picture effects, in order: the fisheye's lens (the zoom after it crops its black corners away),
  // zoom, shake, deep fry, glitch, flash, then the words.
  const chain: string[] = [];
  const of = (kind: BrainrotFx) => cut.fx.filter((f) => f.fx === kind);
  if (of("fisheye").length) chain.push(`lenscorrection=k1=${FISHEYE.k1}:k2=${FISHEYE.k2}:enable='${within(of("fisheye"))}'`);
  const zoom = zoomExpr(cut.fx);
  if (zoom !== "1") chain.push(`zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`);
  if (of("shake").length) {
    const s = within(of("shake"));
    chain.push(`crop=w=${W - 56}:h=${H - 100}:x='28+26*sin(t*61)*(${s})':y='50+44*sin(t*47+1.3)*(${s})',scale=${W}:${H}:flags=bicubic`);
  }
  if (of("deep_fry").length) {
    const e = within(of("deep_fry"));
    chain.push(`eq=saturation=2.6:contrast=1.5:brightness=0.04:enable='${e}'`, `colorchannelmixer=rr=1.3:rg=0.12:gg=0.95:bb=0.72:enable='${e}'`, `unsharp=7:7:2.4:enable='${e}'`, `noise=alls=26:allf=t:enable='${e}'`);
  }
  if (of("glitch").length) chain.push(`rgbashift=rh=18:bh=-18:gv=8:enable='${within(of("glitch"))}'`);
  if (of("flash").length) chain.push(`eq=brightness=0.5:saturation=0.5:enable='${within(of("flash"))}'`);
  if (options.ass) chain.push("ass=filename=brainrot.ass:fontsdir=fonts");
  graph.push(`[base]${[...chain, "setsar=1", "format=yuv420p"].join(",")}[vout]`);

  // Sound: the voice, the beat ducked under it, the effects; bass-boosted drops on the whole mix.
  const buses: Record<CutSound["bus"], string[]> = { voice: [], music: [], sfx: [] };
  cut.sounds.forEach((sound, i) => {
    const a = input("-i", resolve(sound.path));
    const ms = Math.max(0, Math.round(sound.at * 1000));
    const trim = sound.seconds ? `,atrim=0:${n3(sound.seconds)}` : "";
    const fade = sound.seconds && sound.fadeOut ? `,afade=t=out:st=${n3(Math.max(0, sound.seconds - sound.fadeOut))}:d=${n3(sound.fadeOut)}` : "";
    graph.push(`[${a}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${trim}${fade},adelay=delays=${ms}:all=1,volume=${n3(sound.gain)}[s${i}]`);
    buses[sound.bus].push(`[s${i}]`);
  });
  const bus = (name: CutSound["bus"]) => {
    const list = buses[name];
    if (!list.length) graph.push(`anullsrc=r=48000:cl=stereo,atrim=end=${n3(cut.duration)}[${name}]`);
    else if (list.length === 1) graph.push(`${list[0]}anull[${name}]`);
    else graph.push(`${list.join("")}amix=inputs=${list.length}:normalize=0:duration=longest[${name}]`);
  };
  bus("voice");
  bus("music");
  bus("sfx");
  const boost = within(cut.boosts);
  graph.push(
    "[voice]asplit=2[vmix][vkey]",
    "[music][vkey]sidechaincompress=threshold=0.03:ratio=7:attack=12:release=320[ducked]",
    `[vmix][ducked][sfx]amix=inputs=3:normalize=0:duration=longest,${cut.boosts.length ? `bass=g=16:f=75:w=0.9:enable='${boost}',volume=2.2:enable='${boost}',asoftclip=type=tanh:enable='${boost}',` : ""}alimiter=limit=0.95,loudnorm=I=-14:TP=-1.2:LRA=18,aresample=48000,apad,atrim=end=${n3(cut.duration)}[aout]`,
  );

  args.push("-filter_complex", graph.join(";"), "-map", "[vout]", "-map", "[aout]", "-t", n3(cut.duration));
  args.push("-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p");
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", resolve(out));
  return args;
}

/** Renders a cut to `out` (1080x1920, 30 fps, H.264 + AAC). */
export async function renderCut(cut: BrainrotCut, out: string, options: { workDir?: string; fontPath?: string } = {}): Promise<string> {
  const bin = await editFfmpeg();
  if (!bin) throw new Error("No ffmpeg with libass found: install the ffmpeg-static package or set FFMPEG_PATH to an ffmpeg built with libass.");
  const fontPath = resolve(options.fontPath ?? DEFAULT_FONT);
  const scratch = resolve(options.workDir ?? dirname(out));
  await mkdir(scratch, { recursive: true });
  await mkdir(dirname(resolve(out)), { recursive: true });
  const work = await mkdtemp(join(scratch, "brainrot-cut-"));
  try {
    await mkdir(join(work, "fonts"));
    await copyFile(fontPath, join(work, "fonts", basename(fontPath)));
    await writeFile(join(work, "brainrot.ass"), brainrotAss(cut, await fontMetrics(fontPath)), "utf8");
    try {
      await exec(bin, cutArgs(cut, out), { cwd: work, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`brainrot cut: ffmpeg failed${stderr ? `: ${stderr.slice(-2000)}` : ""}`);
    }
    return resolve(out);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
