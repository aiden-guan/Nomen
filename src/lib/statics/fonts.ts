import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

// The fonts static ads are set in, and exact text measurement. Satori (inside next/og) lays text
// out but cannot report how big it is, so headlines are measured here from the font's own glyph
// widths, broken into balanced lines and sized to fill their box before anything is rendered.

export type FamilyId = "inter" | "bricolage" | "anton" | "playfair" | "dmsans" | "nunito" | "geist" | "newsreader" | "mono";

const FAMILIES: Record<FamilyId, { name: string; file: string; weights: number[] }> = {
  inter: { name: "Inter", file: "inter", weights: [400, 500, 600, 700, 800] },
  bricolage: { name: "Bricolage Grotesque", file: "bricolage-grotesque", weights: [700, 800] },
  anton: { name: "Anton", file: "anton", weights: [400] },
  playfair: { name: "Playfair Display", file: "playfair-display", weights: [600, 700, 800] },
  dmsans: { name: "DM Sans", file: "dm-sans", weights: [400, 500, 700] },
  nunito: { name: "Nunito", file: "nunito", weights: [600, 800, 900] },
  geist: { name: "Geist", file: "geist", weights: [400, 500, 600, 700] },
  newsreader: { name: "Newsreader", file: "newsreader", weights: [400, 500, 600] },
  mono: { name: "Geist Mono", file: "geist-mono", weights: [400, 500] },
};

/**
 * Heading and body pairings. The ad study picks one from what wins in the category: the restrained
 * serif and Geist looks match the software and AI brands that advertise on X; the louder ones suit
 * consumer goods.
 */
export const TYPE_STYLES = {
  serif: { heading: { family: "newsreader", weight: 500 }, body: { family: "geist", weight: 400 }, uppercase: false, tracking: -0.02 },
  geist: { heading: { family: "geist", weight: 600 }, body: { family: "geist", weight: 400 }, uppercase: false, tracking: -0.045 },
  modern: { heading: { family: "inter", weight: 800 }, body: { family: "inter", weight: 500 }, uppercase: false, tracking: -0.035 },
  grotesk: { heading: { family: "bricolage", weight: 800 }, body: { family: "inter", weight: 500 }, uppercase: false, tracking: -0.03 },
  bold: { heading: { family: "anton", weight: 400 }, body: { family: "inter", weight: 500 }, uppercase: true, tracking: 0 },
  editorial: { heading: { family: "playfair", weight: 700 }, body: { family: "dmsans", weight: 500 }, uppercase: false, tracking: -0.015 },
  friendly: { heading: { family: "nunito", weight: 900 }, body: { family: "nunito", weight: 600 }, uppercase: false, tracking: -0.02 },
} as const satisfies Record<string, { heading: Face; body: Face; uppercase: boolean; tracking: number }>;

export const MONO: Face = { family: "mono", weight: 400 };

export type TypeStyle = keyof typeof TYPE_STYLES;
export type Face = { family: FamilyId; weight: number };

type Metrics = { unitsPerEm: number; advance: (codePoint: number) => number | null };

const fontDir = () => join(process.cwd(), "assets", "fonts");
const loaded = new Map<string, { data: Buffer; metrics: Metrics }>();

function load(family: FamilyId, weight: number) {
  const spec = FAMILIES[family];
  const w = spec.weights.reduce((best, x) => (Math.abs(x - weight) < Math.abs(best - weight) ? x : best), spec.weights[0]);
  const key = `${family}-${w}`;
  let entry = loaded.get(key);
  if (!entry) {
    const data = readFileSync(join(fontDir(), `${spec.file}-latin-${w}-normal.woff`));
    entry = { data, metrics: readMetrics(data) };
    loaded.set(key, entry);
  }
  return { ...entry, weight: w, name: spec.name };
}

/** CSS font-family name of a family, as the fonts are registered with the renderer. */
export const familyName = (family: FamilyId) => FAMILIES[family].name;

let fontList: Array<{ name: string; data: ArrayBuffer; weight: 400 | 500 | 600 | 700 | 800 | 900; style: "normal" }> | null = null;

/** Every bundled face, in the shape next/og takes. The same array is reused so it is parsed once. */
export function rendererFonts() {
  if (!fontList) {
    fontList = [];
    for (const family of Object.keys(FAMILIES) as FamilyId[]) {
      for (const weight of FAMILIES[family].weights) {
        const { data, name } = load(family, weight);
        const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        fontList.push({ name, data: copy, weight: weight as 400, style: "normal" });
      }
    }
  }
  return fontList;
}

// ---------- measuring ----------

/** Width of a string in pixels, set in this face at this size. Unknown glyphs count as an "M". */
export function textWidth(text: string, face: Face, size: number, trackingEm = 0) {
  const { metrics } = load(face.family, face.weight);
  let units = 0;
  const fallback = metrics.advance(77) ?? metrics.unitsPerEm * 0.8;
  for (const char of text) units += metrics.advance(char.codePointAt(0)!) ?? fallback;
  const chars = [...text].length;
  // A hair of slack: Satori applies kerning, which only ever makes a Latin line narrower.
  return ((units / metrics.unitsPerEm) * size + trackingEm * size * chars) * 1.01;
}

/** True when every character of the text has a glyph in this face. */
export function hasGlyphs(text: string, face: Face) {
  const { metrics } = load(face.family, face.weight);
  for (const char of text) if (!/\s/.test(char) && metrics.advance(char.codePointAt(0)!) === null) return false;
  return true;
}

export type FitOptions = {
  face: Face;
  maxWidth: number;
  maxHeight: number;
  maxSize: number;
  minSize: number;
  maxLines: number;
  lineHeight: number;
  trackingEm?: number;
  /** Balanced lines read as designed; body copy fills greedily instead. */
  balance?: boolean;
};

export type Fitted = { size: number; lines: string[]; width: number; height: number; overflow: boolean };

/**
 * The largest size at which the text fits the box in at most maxLines lines, with its line
 * breaks. If it cannot fit even at minSize, the last line is cut with an ellipsis and
 * `overflow` is set, so callers can shorten the copy instead of shipping a cramped ad.
 */
export function fitText(text: string, opts: FitOptions): Fitted {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { size: opts.minSize, lines: [], width: 0, height: 0, overflow: false };
  const tryAt = (size: number) => {
    const lines = breakLines(words, opts.face, size, opts.maxWidth, opts.maxLines, opts.trackingEm ?? 0, opts.balance ?? true);
    if (!lines) return null;
    const height = lines.length * size * opts.lineHeight;
    return height <= opts.maxHeight ? lines : null;
  };
  let lo = Math.floor(opts.minSize);
  let hi = Math.floor(opts.maxSize);
  let best: { size: number; lines: string[] } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = tryAt(mid);
    if (lines) {
      best = { size: mid, lines };
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best) {
    const width = Math.max(...best.lines.map((line) => textWidth(line, opts.face, best!.size, opts.trackingEm)));
    return { ...best, width, height: best.lines.length * best.size * opts.lineHeight, overflow: false };
  }
  // Does not fit: take the smallest size, fill greedily and cut what is left over.
  const size = Math.floor(opts.minSize);
  const lines = greedy(words, opts.face, size, opts.maxWidth, opts.trackingEm ?? 0);
  const fitLines = Math.max(1, Math.min(opts.maxLines, Math.floor(opts.maxHeight / (size * opts.lineHeight))));
  const kept = lines.slice(0, fitLines);
  if (lines.length > fitLines) kept[kept.length - 1] = ellipsize(kept[kept.length - 1], opts.face, size, opts.maxWidth, opts.trackingEm ?? 0);
  const width = Math.max(...kept.map((line) => textWidth(line, opts.face, size, opts.trackingEm)));
  return { size, lines: kept, width, height: kept.length * size * opts.lineHeight, overflow: true };
}

function greedy(words: string[], face: Face, size: number, maxWidth: number, tracking: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || textWidth(candidate, face, size, tracking) <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Line breaks with every line inside maxWidth; balanced to the narrowest widest line. */
function breakLines(words: string[], face: Face, size: number, maxWidth: number, maxLines: number, tracking: number, balance: boolean): string[] | null {
  if (words.some((word) => textWidth(word, face, size, tracking) > maxWidth)) return null;
  const lines = greedy(words, face, size, maxWidth, tracking);
  if (lines.length > maxLines) return null;
  if (!balance || lines.length < 2 || words.length > 24 || (lines.length > 4 && words.length > 16)) return lines;
  // Same number of lines as greedy, with breaks chosen the way a typesetter would: lines of even
  // length, a break after a full stop or comma when there is one, and never a line that ends on
  // "the", "to" or the first word of the next sentence.
  const k = lines.length;
  let best: { lines: string[]; cost: number } | null = null;
  const walk = (start: number, remaining: number, acc: string[], widest: number, penalty: number) => {
    if (remaining === 1) {
      const last = words.slice(start).join(" ");
      const w = textWidth(last, face, size, tracking);
      if (w > maxWidth) return;
      const cost = Math.max(widest, w) * (1 + penalty);
      if (!best || cost < best.cost) best = { lines: [...acc, last], cost };
      return;
    }
    for (let end = start + 1; end <= words.length - (remaining - 1); end++) {
      const line = words.slice(start, end).join(" ");
      const w = textWidth(line, face, size, tracking);
      if (w > maxWidth) break;
      walk(end, remaining - 1, [...acc, line], Math.max(widest, w), penalty + breakPenalty(words, end));
    }
  };
  walk(0, k, [], 0, 0);
  return best ? (best as { lines: string[] }).lines : lines;
}

const WEAK_ENDINGS = new Set(["a", "an", "the", "to", "of", "and", "or", "for", "in", "on", "at", "by", "with", "it", "its", "your", "our", "my", "is", "are", "be", "no", "not", "&"]);

/** The cost of breaking the line before words[end]: negative where a break reads naturally. */
function breakPenalty(words: string[], end: number) {
  const last = words[end - 1] ?? "";
  const before = words[end - 2] ?? "";
  let penalty = 0;
  if (/[.!?:;,—–]$/.test(last)) penalty -= /[.!?:;]$/.test(last) ? 0.12 : 0.06;
  if (WEAK_ENDINGS.has(last.toLowerCase().replace(/[^a-z&]/g, ""))) penalty += 0.25;
  // A line that ends on the first word of the next sentence ("…the task. It").
  if (/[.!?]$/.test(before)) penalty += 0.3;
  return penalty;
}

function ellipsize(line: string, face: Face, size: number, maxWidth: number, tracking: number) {
  let words = line.split(" ");
  while (words.length > 1 && textWidth(`${words.join(" ")}…`, face, size, tracking) > maxWidth) words = words.slice(0, -1);
  return `${words.join(" ").replace(/[,.;:!?-]+$/, "")}…`;
}

// ---------- reading the font file ----------

/** Glyph advance widths from a WOFF 1.0 or TrueType/OpenType file: the head, hhea, hmtx and cmap tables. */
export function readMetrics(file: Buffer): Metrics {
  const tables = sfntTables(file);
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const cmap = tables.get("cmap");
  if (!head || !hhea || !hmtx || !cmap) throw new Error("font is missing a metrics table");
  const unitsPerEm = head.readUInt16BE(18);
  const numberOfHMetrics = hhea.readUInt16BE(34);
  const glyphOf = cmapLookup(cmap);
  const cache = new Map<number, number | null>();
  return {
    unitsPerEm,
    advance(codePoint: number) {
      let value = cache.get(codePoint);
      if (value === undefined) {
        const glyph = glyphOf(codePoint);
        value = glyph === 0 ? null : hmtx.readUInt16BE(4 * Math.min(glyph, numberOfHMetrics - 1));
        cache.set(codePoint, value);
      }
      return value;
    },
  };
}

function sfntTables(file: Buffer) {
  const tables = new Map<string, Buffer>();
  if (file.toString("latin1", 0, 4) === "wOFF") {
    const count = file.readUInt16BE(12);
    for (let i = 0; i < count; i++) {
      const at = 44 + i * 20;
      const tag = file.toString("latin1", at, at + 4);
      const offset = file.readUInt32BE(at + 4);
      const compressed = file.readUInt32BE(at + 8);
      const original = file.readUInt32BE(at + 12);
      const raw = file.subarray(offset, offset + compressed);
      tables.set(tag, compressed < original ? inflateSync(raw) : Buffer.from(raw));
    }
  } else {
    const count = file.readUInt16BE(4);
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      tables.set(file.toString("latin1", at, at + 4), file.subarray(file.readUInt32BE(at + 8), file.readUInt32BE(at + 8) + file.readUInt32BE(at + 12)));
    }
  }
  return tables;
}

/** Code point to glyph id, from the Unicode cmap subtable (format 12 if present, else format 4). */
function cmapLookup(cmap: Buffer): (codePoint: number) => number {
  const count = cmap.readUInt16BE(2);
  let chosen: { offset: number; format: number } | null = null;
  for (let i = 0; i < count; i++) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    const offset = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    if (!chosen || (format === 12 && chosen.format !== 12)) chosen = { offset, format };
  }
  if (!chosen) return () => 0;
  const base = chosen.offset;
  if (chosen.format === 12) {
    const groups = cmap.readUInt32BE(base + 12);
    return (codePoint) => {
      for (let g = 0; g < groups; g++) {
        const at = base + 16 + g * 12;
        const start = cmap.readUInt32BE(at);
        if (codePoint < start) return 0;
        if (codePoint <= cmap.readUInt32BE(at + 4)) return cmap.readUInt32BE(at + 8) + (codePoint - start);
      }
      return 0;
    };
  }
  const segX2 = cmap.readUInt16BE(base + 6);
  const ends = base + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let i = 0; i < segX2 / 2; i++) {
      if (codePoint > cmap.readUInt16BE(ends + i * 2)) continue;
      const start = cmap.readUInt16BE(starts + i * 2);
      if (codePoint < start) return 0;
      const delta = cmap.readInt16BE(deltas + i * 2);
      const range = cmap.readUInt16BE(ranges + i * 2);
      if (range === 0) return (codePoint + delta) & 0xffff;
      const glyph = cmap.readUInt16BE(ranges + i * 2 + range + (codePoint - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}
