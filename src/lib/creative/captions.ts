// Pure helpers for the edit engine: caption chunking, overlay wrapping, font metrics and the ASS
// subtitle document that ffmpeg burns in. Nothing here touches the disk or spawns a process, so all
// of it is unit-tested directly (tests/creative/captions.test.ts).

import type { EditTimeline } from "./types";

export type Caption = EditTimeline["captions"][number];

/** A chunk shorter than this flashes by too fast to read. */
export const MIN_CAPTION_SECONDS = 0.25;

// ---------- caption chunking ----------

/** Words a chunk should not end on: "the | new app" reads worse than "the new app". */
const STICKY = new Set(
  "a an the my your our their his her its this these those to of in on at for with from by and but or nor so if as i i'm i've i'd i'll we you they it's that's".split(" "),
);

const PHRASE_END = /[.,!?;:…]["'”’)]*$/;

/** Removes stage directions: "[pause]", "*laughs*" and short parentheticals like "(beat)". */
export function stripStageDirections(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/\(([^()]*)\)/g, (whole, inner: string) => (inner.trim().split(/\s+/).length <= 3 ? " " : whole))
    .replace(/\s+/g, " ")
    .trim();
}

/** How a word is shown in a caption: no trailing commas or periods, "?" and "!" kept. */
function cleanWord(word: string): string {
  let w = word.replace(/^["“”«»(]+|["“”«»)]+$/g, "");
  if (/^['‘].*['’]$/.test(w) && w.length > 2) w = w.slice(1, -1);
  // Keep the final period of an abbreviation ("U.S.", "e.g.").
  if (/\.[A-Za-z]/.test(w)) w = w.replace(/[,;:]+$/, "");
  else w = w.replace(/[.,;:…]+$/, "");
  return w;
}

/** Splits a spoken line into phrases (word lists) at punctuation and dashes. */
function phrases(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push(current);
    current = [];
  };
  const spaced = stripStageDirections(text).replace(/\s*[—–]\s*/g, " — ").replace(/\s+-{1,2}\s+/g, " — ");
  for (const token of spaced.split(/\s+/)) {
    if (!token) continue;
    if (!/[\p{L}\p{N}]/u.test(token)) {
      // Pure punctuation ("-", "...", "—") breaks the phrase and is dropped.
      flush();
      continue;
    }
    const word = cleanWord(token);
    if (word) current.push(word);
    if (PHRASE_END.test(token)) flush();
  }
  flush();
  return out;
}

const chars = (words: string[]) => words.join(" ").length;

/**
 * Splits one phrase into chunks of at most `maxWords` words (one more when they are all short),
 * choosing break points that avoid one-word chunks and chunks ending on "the", "to", "my"...
 */
function splitPhrase(words: string[], maxWords: number): string[][] {
  const n = words.length;
  const fits = (size: number, from: number) =>
    size <= maxWords || (size === maxWords + 1 && chars(words.slice(from, from + size)) <= 14);
  if (fits(n, 0)) return [words];
  // best[i] = cheapest way to chunk words[0..i)
  const best: Array<{ cost: number; prev: number }> = [{ cost: 0, prev: -1 }];
  for (let i = 1; i <= n; i++) {
    best[i] = { cost: Infinity, prev: -1 };
    for (let size = 1; size <= Math.min(i, maxWords + 1); size++) {
      const from = i - size;
      if (!fits(size, from) || best[from].cost === Infinity) continue;
      const last = words[i - 1].toLowerCase().replace(/[?!]+$/, "");
      const cost =
        best[from].cost +
        2 + // every chunk costs something, so fewer, fuller chunks win
        (size === 1 ? 2 : 0) +
        (i < n && STICKY.has(last) ? 4 : 0) +
        (size === maxWords + 1 ? 1 : 0);
      if (cost < best[i].cost) best[i] = { cost, prev: from };
    }
  }
  const chunks: string[][] = [];
  for (let i = n; i > 0; i = best[i].prev) chunks.unshift(words.slice(best[i].prev, i));
  return chunks;
}

/** Durations proportional to `weights` that sum to `total`, none shorter than `min`. */
function allocate(weights: number[], total: number, min: number): number[] {
  const fixed = weights.map(() => false);
  for (;;) {
    const freeWeight = weights.reduce((sum, w, i) => sum + (fixed[i] ? 0 : w), 0);
    const freeTime = total - min * fixed.filter(Boolean).length;
    let changed = false;
    const durations = weights.map((w, i) => {
      if (fixed[i]) return min;
      const d = (w / freeWeight) * freeTime;
      if (d < min) {
        fixed[i] = true;
        changed = true;
      }
      return d;
    });
    if (!changed) return durations;
    if (fixed.every(Boolean)) return weights.map(() => total / weights.length);
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Turns spoken segments (a line with its start and end) into on-screen caption chunks of 1-3 words
 * (4 when the words are short). Each chunk's time is proportional to its length in characters, no
 * chunk is shorter than MIN_CAPTION_SECONDS (chunks are merged when a segment is too short for all
 * of them), and chunks never overlap, even when the segments do.
 */
export function chunkCaptions(segments: Array<{ start: number; end: number; text: string }>, maxWords = 3): EditTimeline["captions"] {
  const out: EditTimeline["captions"] = [];
  const sorted = segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let floor = 0;
  for (const segment of sorted) {
    const start = Math.max(segment.start, floor);
    const end = segment.end;
    if (end - start < 0.05) continue;
    let chunks = phrases(segment.text).flatMap((p) => splitPhrase(p, Math.max(1, maxWords)));
    if (!chunks.length) continue;
    const slots = Math.max(1, Math.floor((end - start) / MIN_CAPTION_SECONDS + 1e-9));
    while (chunks.length > slots) {
      // Too many chunks for the time: merge the shortest neighbouring pair.
      let at = 0;
      for (let i = 1; i < chunks.length - 1; i++) {
        if (chars(chunks[i]) + chars(chunks[i + 1]) < chars(chunks[at]) + chars(chunks[at + 1])) at = i;
      }
      chunks = [...chunks.slice(0, at), [...chunks[at], ...chunks[at + 1]], ...chunks.slice(at + 2)];
    }
    const durations = allocate(
      chunks.map((c) => chars(c) + 1),
      end - start,
      Math.min(MIN_CAPTION_SECONDS, (end - start) / chunks.length),
    );
    let t = start;
    chunks.forEach((chunk, i) => {
      const from = t;
      t = i === chunks.length - 1 ? end : t + durations[i];
      out.push({ start: round3(from), end: round3(t), text: chunk.join(" ") });
    });
    floor = end;
  }
  return out;
}

// ---------- overlay wrapping ----------

function greedy(words: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Line breaks ("\n") for large on-screen text. Lines are balanced (the narrowest width that keeps
 * the same number of lines), explicit newlines are kept, and text that would need more than
 * `maxLines` lines is allowed wider lines instead (the renderer shrinks the font to fit).
 */
export function wrapOverlay(text: string, maxCharsPerLine = 22, maxLines = 3): string {
  const paragraphs = text
    .split(/\r?\n/)
    .map((p) => p.trim().split(/\s+/).filter(Boolean))
    .filter((p) => p.length);
  const wrapped = paragraphs.map((words) => {
    let width = Math.max(1, maxCharsPerLine);
    let lines = greedy(words, width);
    const budget = Math.max(1, maxLines - (paragraphs.length - 1));
    while (lines.length > budget && width < 400) lines = greedy(words, ++width);
    const longest = Math.max(...words.map((w) => w.length));
    const total = words.join(" ").length;
    for (let w = Math.max(longest, Math.ceil(total / lines.length)); w < width; w++) {
      const candidate = greedy(words, w);
      if (candidate.length === lines.length) return candidate;
    }
    return lines;
  });
  return wrapped.flat().join("\n");
}

// ---------- font metrics ----------

/** What toAss needs from a TrueType/OpenType font to size text the way libass will draw it. */
export type FontMetrics = {
  /** Family name libass matches the style's Fontname against (name table, ID 1). */
  family: string;
  unitsPerEm: number;
  /** OS/2 usWinAscent / usWinDescent. libass sizes fonts so that winAscent + winDescent = Fontsize. */
  ascent: number;
  descent: number;
  /** Height of capital letters (OS/2 sCapHeight), used to centre text optically in its box. */
  capHeight: number;
  /** Advance width (font units) per Unicode code point. */
  advances: Map<number, number>;
  /** Advance used for characters the font has no glyph for. */
  fallbackAdvance: number;
};

/** Reads the metrics libass uses from a TTF/OTF file's bytes (no shaping, no kerning). */
export function parseFontMetrics(bytes: Uint8Array): FontMetrics {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const tables = new Map<string, number>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) tables.set(tag(12 + i * 16), view.getUint32(12 + i * 16 + 8));
  const need = (name: string) => {
    const at = tables.get(name);
    if (at === undefined) throw new Error(`font has no ${name} table`);
    return at;
  };

  const unitsPerEm = view.getUint16(need("head") + 18);
  const hhea = need("hhea");
  const numberOfHMetrics = view.getUint16(hhea + 34);
  const os2 = tables.get("OS/2");
  const ascent = os2 !== undefined ? view.getUint16(os2 + 74) : view.getInt16(hhea + 4);
  const descent = os2 !== undefined ? view.getUint16(os2 + 76) : -view.getInt16(hhea + 6);
  const capHeight = os2 !== undefined && view.getUint16(os2) >= 2 ? view.getInt16(os2 + 88) : Math.round(unitsPerEm * 0.7);

  const hmtx = need("hmtx");
  const glyphAdvance = (glyph: number) => view.getUint16(hmtx + 4 * Math.min(glyph, numberOfHMetrics - 1));

  // cmap: prefer a full-repertoire (format 12) table, else the BMP (format 4) one.
  const cmap = need("cmap");
  const subtables: Array<{ platform: number; encoding: number; offset: number; format: number }> = [];
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const record = cmap + 4 + i * 8;
    const offset = cmap + view.getUint32(record + 4);
    subtables.push({ platform: view.getUint16(record), encoding: view.getUint16(record + 2), offset, format: view.getUint16(offset) });
  }
  const unicode = (s: (typeof subtables)[number]) => s.platform === 0 || (s.platform === 3 && (s.encoding === 1 || s.encoding === 10));
  const chosen = subtables.find((s) => unicode(s) && s.format === 12) ?? subtables.find((s) => unicode(s) && s.format === 4);
  if (!chosen) throw new Error("font has no Unicode cmap");
  const advances = new Map<number, number>();
  if (chosen.format === 4) {
    const segX2 = view.getUint16(chosen.offset + 6);
    const ends = chosen.offset + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const rangeOffsets = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = view.getUint16(ends + s * 2);
      const start = view.getUint16(starts + s * 2);
      const delta = view.getInt16(deltas + s * 2);
      const rangeOffset = view.getUint16(rangeOffsets + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let glyph: number;
        if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
        else {
          const at = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
          glyph = view.getUint16(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) advances.set(c, glyphAdvance(glyph));
      }
    }
  } else {
    const groups = view.getUint32(chosen.offset + 12);
    for (let g = 0; g < groups; g++) {
      const at = chosen.offset + 16 + g * 12;
      const start = view.getUint32(at);
      const end = view.getUint32(at + 4);
      const glyph = view.getUint32(at + 8);
      for (let c = start; c <= end && c - start < 0x10000; c++) advances.set(c, glyphAdvance(glyph + c - start));
    }
  }

  // name table: family (ID 1), Windows Unicode first, then Mac Roman.
  let family = "";
  const name = tables.get("name");
  if (name !== undefined) {
    const records = view.getUint16(name + 2);
    const strings = name + view.getUint16(name + 4);
    const found: Array<{ platform: number; text: string }> = [];
    for (let i = 0; i < records; i++) {
      const r = name + 6 + i * 12;
      if (view.getUint16(r + 6) !== 1) continue;
      const platform = view.getUint16(r);
      const length = view.getUint16(r + 8);
      const offset = strings + view.getUint16(r + 10);
      let text = "";
      if (platform === 3 || platform === 0) {
        for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(view.getUint16(offset + k));
      } else if (platform === 1) text = String.fromCharCode(...bytes.subarray(offset, offset + length));
      if (text) found.push({ platform, text });
    }
    family = (found.find((f) => f.platform === 3) ?? found[0])?.text ?? "";
  }

  return { family, unitsPerEm, ascent, descent, capHeight, advances, fallbackAdvance: advances.get(0x6e) ?? unitsPerEm * 0.55 };
}

/** Width in pixels of one line of text at ASS font size `fontSize`, as libass lays it out (minus kerning). */
export function textWidth(text: string, fontSize: number, metrics: FontMetrics): number {
  let units = 0;
  for (const ch of text) units += metrics.advances.get(ch.codePointAt(0) ?? 0) ?? metrics.fallbackAdvance;
  return (units * fontSize) / (metrics.ascent + metrics.descent);
}

/**
 * Breaks words into the fewest lines no wider than `maxWidth` (by `width`, in pixels), then
 * evens them out: the narrowest limit that still needs that many lines. A word wider than
 * `maxWidth` gets a line of its own.
 */
export function balanceLines(words: string[], maxWidth: number, width: (text: string) => number): string[] {
  const greedyPx = (limit: number) => {
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && width(candidate) > limit) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    return lines;
  };
  const lines = greedyPx(maxWidth);
  if (lines.length <= 1) return lines;
  let lo = Math.min(maxWidth, Math.max(...words.map(width)));
  let hi = maxWidth;
  for (let i = 0; i < 24 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (greedyPx(mid).length <= lines.length) hi = mid;
    else lo = mid;
  }
  return greedyPx(hi);
}

// ---------- ASS document ----------

/** ASS timestamp: H:MM:SS.cc (centiseconds). */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

/**
 * Makes arbitrary text safe inside an ASS Dialogue line: braces become the \{ \} escapes, a literal
 * backslash is followed by a zero-width word joiner so it can never start \N, \h or \{, and line
 * breaks become \N (or spaces when `newlines` is "space").
 */
export function escapeAssText(text: string, newlines: "break" | "space" = "break"): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\u2060")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\t/g, " ")
    .replace(/\n/g, newlines === "break" ? "\\N" : " ");
}

/** ASS colour: &HAABBGGRR, alpha 00 = opaque. */
function assColor(rgb: number, alpha = 0): string {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  return `&H${hex(alpha)}${hex(b)}${hex(g)}${hex(r)}`;
}

/** A rounded rectangle as an ASS vector drawing with its top-left corner at (0, 0). */
export function roundedRect(width: number, height: number, radius: number): string {
  const w = Math.round(width);
  const h = Math.round(height);
  const r = Math.max(0, Math.min(Math.round(radius), Math.floor(w / 2), Math.floor(h / 2)));
  const k = Math.round(r * 0.4477); // control-point inset for a circular quarter (1 - 0.5523)
  return [
    `m ${r} 0`,
    `l ${w - r} 0`,
    `b ${w - k} 0 ${w} ${k} ${w} ${r}`,
    `l ${w} ${h - r}`,
    `b ${w} ${h - k} ${w - k} ${h} ${w - r} ${h}`,
    `l ${r} ${h}`,
    `b ${k} ${h} 0 ${h - k} 0 ${h - r}`,
    `l 0 ${r}`,
    `b 0 ${k} ${k} 0 ${r} 0`,
  ].join(" ");
}

export type AssOptions = {
  width?: number;
  height?: number;
  /** Font family name for every style. Defaults to metrics.family, then "Poppins ExtraBold". */
  fontName?: string;
  /** Metrics of that font; used to size the overlay box and keep overlay lines inside the frame. */
  metrics?: FontMetrics;
  /**
   * When the screen is split (creator on top, product below). An overlay that is mostly shown
   * during a split moves from the top third, where it would cover the creator's face, to the seam.
   */
  splits?: Array<{ start: number; end: number }>;
  /** A reference's own caption look, for one-to-one remakes. Unset fields keep LOOK.caption. */
  caption?: CaptionStyle;
};

/**
 * How a reference styles its spoken captions, in px at 1080x1920: a remake copies it instead of the
 * house look (uppercase, slanted, a bigger size, a different height, the sticker next to them).
 */
export type CaptionStyle = {
  upper?: boolean;
  /** Slanted; libass slants the face itself when the font has no italic. */
  italic?: boolean;
  /** Fill colour, 0xRRGGBB. */
  color?: number;
  /** Black outline thickness in px; 0 for none. */
  outline?: number;
  shadow?: boolean;
  /** em size in px. */
  em?: number;
  /** Bottom of the caption block, as a fraction of the height. */
  bottom?: number;
  /** A round sticker drawn while captions show (a reference's emoji badge): centre and diameter in px. */
  badge?: { x: number; y: number; size: number; color: number; accent: number } | null;
};

/**
 * The look, at 1080x1920. Sizes are in pixels of the em square; toAss converts them to ASS font
 * sizes with the font's metrics, so a different font keeps roughly the same visual size.
 */
export const LOOK = {
  caption: {
    /** em size in px */
    em: 70,
    /** black outline thickness in px */
    outline: 7,
    /** soft drop shadow: offset and blur in px, opacity 0-1 */
    shadow: { dy: 5, blur: 7, opacity: 0.55 },
    /** bottom of the caption block, as a fraction of the height (one line sits at about 0.645) */
    bottom: 0.675,
    /** distance between baselines when a caption wraps, in em */
    leading: 1.12,
    side: 70,
    /** quick "pop" when each chunk appears: start scale (%) and duration (ms) */
    pop: { from: 88, ms: 90 },
  },
  overlay: {
    em: 58,
    /** distance between baselines, in em */
    leading: 1.28,
    /** vertical centre of the block, as a fraction of the height */
    center: 0.205,
    /** ...and during a split screen: on the seam between creator and product */
    splitCenter: 0.5,
    box: { opacity: 0.78, radius: 26, padX: 34, padY: 18 },
    /** the block (box included) never gets wider than this */
    maxWidth: 980,
    wrap: 22,
  },
};

/**
 * Builds the ASS subtitle document for a timeline: spoken captions (white, heavy black outline,
 * soft shadow, around 65% of the height) and overlays (white on a rounded dark box in the top third).
 */
export function toAss(timeline: Pick<EditTimeline, "captions" | "overlays">, options: AssOptions = {}): string {
  const W = options.width ?? 1080;
  const H = options.height ?? 1920;
  const scale = W / 1080;
  const metrics = options.metrics;
  const font = (options.fontName ?? metrics?.family) || "Poppins ExtraBold";
  // libass makes winAscent + winDescent equal to the font size; without metrics assume Poppins.
  const cell = metrics ? (metrics.ascent + metrics.descent) / metrics.unitsPerEm : 1.762;
  const fontSize = (em: number) => Math.round(em * scale * cell);
  const px = (n: number) => Math.round(n * scale);

  const style = options.caption ?? {};
  const cap = {
    ...LOOK.caption,
    ...(style.em ? { em: style.em } : {}),
    ...(style.outline !== undefined ? { outline: style.outline } : {}),
    ...(style.bottom ? { bottom: style.bottom } : {}),
  };
  const ov = LOOK.overlay;
  const capSize = fontSize(cap.em);
  const capMarginV = Math.round(H * (1 - cap.bottom));
  const white = assColor(0xffffff);
  const black = assColor(0x000000);
  const capFill = style.color !== undefined ? assColor(style.color) : white;
  const italic = style.italic ? -1 : 0;

  const header = [
    "[Script Info]",
    "; Generated by Nomen's edit engine (src/lib/creative/captions.ts)",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${font},${capSize},${capFill},${white},${black},${black},0,${italic},0,0,100,100,0,0,1,${px(cap.outline)},0,2,${px(cap.side)},${px(cap.side)},${capMarginV},1`,
    `Style: CaptionShadow,${font},${capSize},${assColor(0, 255 - Math.round(255 * cap.shadow.opacity))},${white},${assColor(0, 255 - Math.round(255 * cap.shadow.opacity))},${black},0,${italic},0,0,100,100,0,0,1,${px(cap.outline + 2)},0,2,${px(cap.side)},${px(cap.side)},${capMarginV - px(cap.shadow.dy)},1`,
    `Style: Overlay,${font},${fontSize(ov.em)},${white},${white},${black},${black},0,0,0,0,100,100,0,0,1,0,0,5,${px(40)},${px(40)},0,1`,
    `Style: OverlayBox,${font},${fontSize(ov.em)},${assColor(0x000000, 255 - Math.round(255 * ov.box.opacity))},${white},${black},${black},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  const dialogue = (layer: number, start: number, end: number, style: string, text: string) =>
    events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`);
  const valid = (e: { start: number; end: number }) =>
    Number.isFinite(e.start) && Number.isFinite(e.end) && Math.round(e.end * 100) > Math.round(e.start * 100);

  // Without metrics, assume an average advance of 0.62 em (heavy sans).
  const measure = (line: string, s: number) => (metrics ? textWidth(line, s, metrics) : (line.length * s * 0.62) / cell);
  const cx = Math.round(W / 2);

  // Captions are laid out here rather than by libass: libass spaces wrapped lines by winAscent +
  // winDescent (1.76 em for Poppins), far looser than real captions. Each line is its own event,
  // anchored bottom-centre (the style's alignment 2), the last line's box ending at LOOK.caption.bottom.
  const pop = `\\fscx${cap.pop.from}\\fscy${cap.pop.from}\\t(0,${cap.pop.ms},\\fscx100\\fscy100)`;
  const capMax = W - 2 * px(cap.side);
  const capPitch = (capSize / cell) * cap.leading;
  const capBottom = H * cap.bottom;
  for (const c of timeline.captions) {
    const words = (style.upper ? c.text.toUpperCase() : c.text).split(/\s+/).filter(Boolean);
    if (!words.length || !valid(c)) continue;
    const lines = balanceLines(words, capMax, (s) => measure(s, capSize) + 2 * px(cap.outline));
    lines.forEach((line, i) => {
      const y = capBottom - (lines.length - 1 - i) * capPitch;
      const text = escapeAssText(line, "space");
      if (style.shadow !== false) dialogue(0, c.start, c.end, "CaptionShadow", `{\\pos(${cx},${Math.round(y + px(cap.shadow.dy))})\\q2${pop}\\blur${px(cap.shadow.blur)}}${text}`);
      dialogue(1, c.start, c.end, "Caption", `{\\pos(${cx},${Math.round(y)})\\q2${pop}\\blur0.6}${text}`);
    });
  }

  // The reference's sticker next to its captions, shown from the first caption to the last.
  const valids = timeline.captions.filter(valid);
  if (style.badge && valids.length) {
    const { x, y, size, color, accent } = style.badge;
    const d = Math.max(8, px(size));
    const from = Math.min(...valids.map((c) => c.start));
    const to = Math.max(...valids.map((c) => c.end));
    const at = (cxp: number, cyp: number, dia: number) => `\\pos(${Math.round(cxp - dia / 2)},${Math.round(cyp - dia / 2)})`;
    dialogue(4, from, to, "OverlayBox", `{${at(px(x), px(y), d)}\\an7\\1c${assColor(color)}\\1a&H00&\\bord${Math.max(2, Math.round(d / 18))}\\3c${black}\\p1}${roundedRect(d, d, d / 2)}`);
    const dot = Math.round(d * 0.34);
    dialogue(5, from, to, "OverlayBox", `{${at(px(x) + d * 0.12, px(y) + d * 0.1, dot)}\\an7\\1c${assColor(accent)}\\1a&H00&\\bord0\\p1}${roundedRect(dot, dot, dot / 2)}`);
  }

  for (const o of timeline.overlays) {
    if (!o.text.trim() || !valid(o)) continue;
    let size = fontSize(ov.em);
    const lines = wrapOverlay(o.text, ov.wrap).split("\n");
    const padX = px(ov.box.padX);
    const padY = px(ov.box.padY);
    const maxWidth = px(ov.maxWidth);
    let widest = Math.max(...lines.map((l) => measure(l, size)));
    if (widest + 2 * padX > maxWidth) {
      size = Math.floor((size * (maxWidth - 2 * padX)) / widest);
      widest = Math.max(...lines.map((l) => measure(l, size)));
    }
    // libass spaces lines by winAscent + winDescent, which is loose for many fonts (1.76 em for
    // Poppins), so every line is its own event placed at a tighter, fixed pitch.
    const em = size / cell;
    const pitch = em * ov.leading;
    const boxW = Math.round(widest + 2 * padX);
    const boxH = Math.round(lines.length * pitch + 2 * padY);
    const split = (options.splits ?? []).reduce((sum, s) => sum + Math.max(0, Math.min(s.end, o.end) - Math.max(s.start, o.start)), 0);
    const cy = Math.round(H * (split > (o.end - o.start) / 2 ? ov.splitCenter : ov.center));
    const x0 = Math.round(cx - boxW / 2);
    const y0 = Math.round(cy - boxH / 2);
    dialogue(2, o.start, o.end, "OverlayBox", `{\\pos(${x0},${y0})\\p1}${roundedRect(boxW, boxH, px(ov.box.radius))}`);
    // \an5 centres a line's box (winAscent above the baseline, winDescent below), not its
    // capitals; shift each line so the capitals sit on the line's centre.
    const drop = metrics ? ((metrics.capHeight - (metrics.ascent - metrics.descent)) / 2) * (em / metrics.unitsPerEm) : 0;
    lines.forEach((line, i) => {
      const y = cy + (i - (lines.length - 1) / 2) * pitch + drop;
      dialogue(3, o.start, o.end, "Overlay", `{\\pos(${cx},${Math.round(y)})\\fs${size}\\q2}${escapeAssText(line, "space")}`);
    });
  }

  return [...header, ...events, ""].join("\n");
}
