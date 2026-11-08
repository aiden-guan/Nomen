import { LIMITS, SNIPPET_HEADERS } from "./specs";

// Checks every line of ad copy before it reaches an image or an upload file: platform limits,
// Google's editorial rules, X's ban on hashtags, the phrases that make copy read as machine-written,
// and the facts. A number, quote, offer or terminal command must appear in the brand's own site
// text, or it does not ship.

/**
 * Phrases that mark copy as generic or machine-written. A phrase is allowed only when the brand's
 * own site uses it (Monid's slogan says "unlocks", for example).
 */
export const SLOP = [
  "unlock",
  "unleash",
  "supercharge",
  "revolutionize",
  "revolutionise",
  "elevate",
  "game-changer",
  "game changer",
  "seamless",
  "harness",
  "leverage",
  "cutting-edge",
  "next-level",
  "next level",
  "level up",
  "empower",
  "in today's",
  "look no further",
  "say goodbye",
  "say hello to",
  "transform your",
  "take your",
  "dive in",
  "delve",
  "embark",
  "journey",
  "the world of",
  "realm",
  "tapestry",
  "skyrocket",
  "effortless",
  "unparalleled",
  "best-in-class",
  "state-of-the-art",
  "one-stop",
  "all-in-one solution",
  "boost your",
  "magic",
  "ever-evolving",
  "fast-paced",
];

/** Lowercase, straight quotes, single spaces, no thousands separators: how facts are compared. */
export function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripEmoji(text: string) {
  return text.replace(/\p{Extended_Pictographic}/gu, "").replace(/[‍️]/g, "").replace(/\s{2,}/g, " ").trim();
}

/** Every number-like token: 1,800+ / 9g / $35 / 6.5x / 40%. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\$?\d[\d,]*(?:\.\d+)?(?:\+|%|x|×|k|m)?/gi)].map((m) => m[0]);
}

/** Numbers in the copy that the site text never states. */
export function unsupportedNumbers(copy: string, corpus: string): string[] {
  const site = normalize(corpus);
  return numbersIn(copy).filter((token) => {
    const bare = normalize(token).replace(/[+%x×km$]+$/i, "").replace(/^\$/, "");
    if (!bare || /^0+$/.test(bare)) return false;
    return !new RegExp(`(^|[^0-9.])${bare.replace(/[.]/g, "\\.")}([^0-9]|$)`).test(site);
  });
}

/** True when the passage appears in the site text, ignoring case, quotes, dashes and spacing. */
export function appearsIn(passage: string, corpus: string) {
  const p = normalize(passage).replace(/^["']+|["'.]+$/g, "");
  return p.length > 0 && normalize(corpus).includes(p);
}

export function slopIn(copy: string, corpus: string): string[] {
  const text = normalize(copy);
  const site = normalize(corpus);
  return SLOP.filter((phrase) => text.includes(phrase) && !site.includes(phrase));
}

/** Google's editorial rules, as far as they are published: see specs.ts for the sources. */
export function googleProblems(line: string, corpus: string): string[] {
  const problems: string[] = [];
  if (line.includes("!")) problems.push("exclamation mark");
  if (/\p{Extended_Pictographic}/u.test(line)) problems.push("emoji");
  if (/([!?.,*])\1/.test(line)) problems.push("repeated punctuation");
  if (/\+?\d[\d\s().-]{8,}\d/.test(line) && /\d{3}[\s.-]\d{3,4}/.test(line)) problems.push("phone number");
  const shouting = (line.match(/\b[A-Z]{4,}\b/g) ?? []).filter((word) => !corpus.includes(word));
  if (shouting.length) problems.push(`capitals: ${shouting.join(", ")}`);
  return problems;
}

export type Checked<T> = { value: T; problems: string[] };

/** Keeps lines that pass; reports the rest. Never truncates: a cut headline reads broken. */
export function keepValid(lines: string[], max: number, check: (line: string) => string[] = () => []): Checked<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  const value = lines
    .map((line) => stripEmoji(line ?? "").trim())
    .filter((line) => {
      if (!line) return false;
      const key = normalize(line);
      if (seen.has(key)) return false;
      seen.add(key);
      if (line.length > max) {
        problems.push(`"${line}" is ${line.length} characters (limit ${max})`);
        return false;
      }
      const found = check(line);
      if (found.length) {
        problems.push(`"${line}": ${found.join(", ")}`);
        return false;
      }
      return true;
    });
  return { value, problems };
}

export type SearchAssets = {
  rsa: { headlines: string[]; descriptions: string[]; path1: string; path2: string };
  sitelinks: Array<{ text: string; line1: string; line2: string }>;
  callouts: string[];
  snippet: { header: string; values: string[] };
  display: { short_headlines: string[]; long_headline: string; descriptions: string[]; business_name: string };
  pmax: { headlines: string[]; long_headlines: string[]; descriptions: string[]; business_name: string };
};

/** Validates Google text assets in place; returns what was dropped and why. */
export function checkSearchAssets(raw: SearchAssets, corpus: string): { assets: SearchAssets; problems: string[]; short: string[] } {
  const L = LIMITS;
  const g = (line: string) => [...googleProblems(line, corpus), ...slopIn(line, corpus).map((p) => `reads generic ("${p}")`), ...unsupportedNumbers(line, corpus).map((n) => `number not on the site: ${n}`)];
  const problems: string[] = [];
  const take = (lines: string[], max: number, count: number) => {
    const r = keepValid(lines, max, g);
    problems.push(...r.problems);
    return r.value.slice(0, count);
  };
  const path = (value: string) => stripEmoji(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, L.rsa.path);
  const sitelinks = (raw.sitelinks ?? [])
    .map((s) => ({ text: stripEmoji(s.text ?? ""), line1: stripEmoji(s.line1 ?? ""), line2: stripEmoji(s.line2 ?? "") }))
    .filter((s) => {
      const bad = [...g(s.text), ...g(s.line1), ...g(s.line2)];
      const tooLong = s.text.length > L.rsa.sitelinkText || s.line1.length > L.rsa.sitelinkLine || s.line2.length > L.rsa.sitelinkLine;
      const half = Boolean(s.line1) !== Boolean(s.line2);
      if (!s.text || bad.length || tooLong || half) {
        problems.push(`sitelink "${s.text}" dropped${tooLong ? " (too long)" : ""}${half ? " (needs both lines or none)" : ""}${bad.length ? `: ${bad.join(", ")}` : ""}`);
        return false;
      }
      return true;
    })
    .slice(0, 6);
  const header = (SNIPPET_HEADERS as readonly string[]).includes(raw.snippet?.header) ? raw.snippet.header : "Types";
  const assets: SearchAssets = {
    rsa: { headlines: take(raw.rsa?.headlines ?? [], L.rsa.headlines.chars, L.rsa.headlines.max), descriptions: take(raw.rsa?.descriptions ?? [], L.rsa.descriptions.chars, L.rsa.descriptions.max), path1: path(raw.rsa?.path1), path2: path(raw.rsa?.path2) },
    sitelinks,
    callouts: take(raw.callouts ?? [], L.rsa.callout, 10),
    snippet: { header, values: take(raw.snippet?.values ?? [], L.rsa.snippetValue, L.rsa.snippetValues.max) },
    display: {
      short_headlines: take(raw.display?.short_headlines ?? [], L.display.shortHeadlines.chars, L.display.shortHeadlines.max),
      long_headline: take([raw.display?.long_headline ?? ""], L.display.longHeadline, 1)[0] ?? "",
      descriptions: take(raw.display?.descriptions ?? [], L.display.descriptions.chars, L.display.descriptions.max),
      business_name: stripEmoji(raw.display?.business_name ?? "").slice(0, L.display.businessName),
    },
    pmax: {
      headlines: take(raw.pmax?.headlines ?? [], L.pmax.headlines.chars, L.pmax.headlines.max),
      long_headlines: take(raw.pmax?.long_headlines ?? [], L.pmax.longHeadlines.chars, L.pmax.longHeadlines.max),
      descriptions: take(raw.pmax?.descriptions ?? [], L.pmax.descriptions.chars, L.pmax.descriptions.max),
      business_name: stripEmoji(raw.pmax?.business_name ?? raw.display?.business_name ?? "").slice(0, L.pmax.businessName),
    },
  };
  if (assets.snippet.values.length < L.rsa.snippetValues.min) assets.snippet.values = [];
  const short: string[] = [];
  if (assets.rsa.headlines.length < L.rsa.headlines.min) short.push(`responsive search ad needs ${L.rsa.headlines.min} headlines, has ${assets.rsa.headlines.length}`);
  if (assets.rsa.descriptions.length < L.rsa.descriptions.min) short.push(`responsive search ad needs ${L.rsa.descriptions.min} descriptions, has ${assets.rsa.descriptions.length}`);
  if (assets.pmax.headlines.length < L.pmax.headlines.min) short.push(`Performance Max needs ${L.pmax.headlines.min} headlines, has ${assets.pmax.headlines.length}`);
  if (!assets.pmax.headlines.some((h) => h.length <= 15)) short.push("Performance Max asks for at least one headline of 15 characters or fewer");
  if (assets.pmax.descriptions.length < L.pmax.descriptions.min) short.push(`Performance Max needs ${L.pmax.descriptions.min} descriptions, has ${assets.pmax.descriptions.length}`);
  return { assets, problems, short };
}

/** X: hashtags are not allowed in promoted posts (since June 2025); a link counts 23 characters. */
export function cleanXPost(post: string) {
  const text = stripEmoji(post).replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "").replace(/\s{2,}/g, " ").trim();
  const weighted = text.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
  return { text, weighted };
}
