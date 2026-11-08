// A camp dispatch line, made scannable for the station panels: a short headline, the gist in a
// clause, the numbers that matter as chips, any list it carries as bullets, and the full line kept
// for when you open it. The lines come from all over the core (src/lib, logEvent), so this reads
// their shapes rather than knowing each one: "Label: rest", a video's "Title": rest, counts ("99
// short videos"), creators with their numbers ("@a 102.8M views", "243x the account's followers"),
// QC scores, platforms, "(dropped: a; b; c)" lists and "a; b; c" runs.

export type EventSummary = {
  headline: string;
  /** The gist, a clause long; null when the headline and chips say it. */
  lead: string | null;
  chips: string[];
  /** A list the line carries (label may be empty), if any. */
  list: { label: string; items: string[] } | null;
  /** True when the full line says more than what is shown. */
  more: boolean;
};

const LEAD_MAX = 120;
const ITEM_MAX = 110;
const CHIPS_MAX = 5;

const PLATFORMS: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", facebook: "Facebook", reddit: "Reddit" };

/** Shortened at a word, with an ellipsis. */
function clip(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).replace(/[,;:(\s]+$/, "")}…`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The first sentence of a text (quotes are kept whole). */
function firstSentence(text: string) {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "“" || c === "”") quoted = !quoted;
    else if (!quoted && /[.!?]/.test(c) && (i === text.length - 1 || text[i + 1] === " ")) return text.slice(0, i + 1);
  }
  return text;
}

/** Splits on ";" outside parentheses and quotes. */
function splitTop(text: string) {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && c === ";") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim().replace(/\.$/, "")).filter(Boolean);
}

export function summarizeEvent(message: string): EventSummary {
  const text = message.replace(/\s+/g, " ").trim();

  // 1. The headline, and the rest of the line.
  let headline: string;
  let rest: string;
  const title = text.match(/^"([^"]+)":?\s*(.*)$/);
  const check = text.match(/^Scout: format check, ([^:]+):\s*(.*)$/i);
  const label = text.match(/^([^:"]{2,70}?):\s+(.+)$/);
  if (title) {
    headline = `“${title[1]}”`;
    rest = title[2];
  } else if (check) {
    headline = "Format check";
    rest = `${capital(check[1].trim())}. ${check[2]}`;
  } else if (label) {
    // The label without its aside: "Breaking down 6 outlier videos beat by beat".
    headline = label[1].replace(/\s*\([^)]*\)\s*$/, "").trim();
    rest = label[2];
  } else {
    headline = firstSentence(text).replace(/\.$/, "");
    rest = text.slice(firstSentence(text).length).trim();
  }
  if (/^scout$/i.test(headline)) headline = "Scout's notes";

  // 2. A list it carries.
  let list: EventSummary["list"] = null;
  let lead: string | null = null;
  let body = rest;
  const aside = rest.match(/\((\w[\w\s]{0,20}):\s*((?:[^()]|\([^()]*\))*;(?:[^()]|\([^()]*\))*)\)/);
  const titles = [...rest.matchAll(/"([^"]+)"\s*\(([^:)]+)[:)]/g)];
  if (aside && splitTop(aside[2]).length >= 2) {
    list = { label: capital(aside[1].trim()), items: splitTop(aside[2]).map((item) => clip(item, ITEM_MAX)) };
    body = rest.replace(aside[0], "").trim();
  } else if (titles.length >= 2) {
    // Quoted titles with their format, or quoted searches with their platform.
    const balance = (s: string) => (s.split("(").length > s.split(")").length ? `${s})` : s);
    const isSearch = (m: RegExpMatchArray) => /^(tiktok|instagram|youtube|reels|shorts)$/i.test(m[2].trim());
    const searches = titles.filter(isSearch).length;
    list = { label: searches === titles.length ? "Searches" : searches ? "Videos and searches" : "Videos", items: titles.map((m) => `“${m[1]}” · ${balance(m[2].trim())}`) };
    // What comes before the first of them, a sentence long.
    body = rest.slice(0, titles[0].index).trim();
  } else {
    const parts = splitTop(rest);
    if (parts.length >= 2) {
      const listed = parts[0].startsWith("@") ? parts : parts.slice(1);
      if (!parts[0].startsWith("@")) lead = clip(firstSentence(parts[0]), LEAD_MAX);
      list = { label: "", items: listed.map((item) => clip(capital(item), ITEM_MAX)) };
      body = "";
    }
  }

  // 3. The numbers that matter.
  const chips: string[] = [];
  const add = (chip: string) => {
    if (!chips.includes(chip)) chips.push(chip);
  };
  if (/^(Post submitted|Posted to|Post scheduled)/i.test(text)) {
    for (const [key, name] of Object.entries(PLATFORMS)) if (new RegExp(`\\b${key}\\b`, "i").test(rest)) add(name);
  }
  // Creators, each once with all their numbers; unless the list already names them.
  const listsCreators = list?.items.some((item) => item.startsWith("@")) ?? false;
  if (!listsCreators) creatorChips(text).forEach(add);
  for (const m of text.matchAll(/(?<![\d/.])(\d[\d,.]*[KM]?)\s+(?:short |live |top |outlier |Reddit |search |phone-size )?(videos?|ads?|threads?|keywords?|briefs?|shots?|concepts?|posts?|screenshots?)\b/gi)) {
    add(`${m[1]} ${m[2].toLowerCase()}`);
  }
  for (const m of text.matchAll(/\b(\d+\/\d+) (sources?)\b/gi)) add(`${m[1]} ${m[2]}`);
  for (const m of text.matchAll(/\b(QC |critic )?(\d+(?:\.\d)?\/10)\b/g)) add(`${m[1] ? m[1].trim() + " " : ""}${m[2]}`);
  for (const m of text.matchAll(/\b(\d+) of (\d+)\b(?! sources)/g)) add(`${m[1]} of ${m[2]}`);

  // 4. The gist: the first sentence of what is left, unless the chips already say it.
  if (!lead && body) {
    const gist = firstSentence(body).trim();
    const numbers = gist.match(/\d[\d.,]*/g) ?? [];
    const covered = chips.length >= 3 && numbers.every((n) => chips.some((c) => c.includes(n)));
    if (gist.length > 2 && !gist.startsWith("@") && !covered) lead = clip(gist, LEAD_MAX);
  }

  const shown = [headline, lead ?? "", ...chips, ...(list?.items ?? [])].join(" ").length;
  return {
    headline: clip(headline, 80),
    lead,
    chips: chips.slice(0, CHIPS_MAX),
    list,
    more: text.length > shown + 30 || chips.length > CHIPS_MAX || (list?.items.some((i) => i.endsWith("…")) ?? false),
  };
}

/** The creators a text cites, each once with their numbers: "@a · 102.8M · 2457×". */
export function creatorChips(text: string): string[] {
  const creators = new Map<string, string[]>();
  const note = (handle: string, value: string) => {
    const values = creators.get(handle) ?? [];
    if (!values.includes(value)) values.push(value);
    creators.set(handle, values);
  };
  for (const m of text.matchAll(/@([\w.]+?)(?:'s [^()@]*?)?\s*\(?(\d[\d.,]*[KMB]?)\s*(?:views|plays)/gi)) note(m[1], m[2]);
  for (const m of text.matchAll(/@([\w.]+)\s+(\d[\d.,]*)x the account's followers/gi)) note(m[1], `${m[2]}×`);
  for (const m of text.matchAll(/@([\w.]+)\s+[\d.,]+[KMB]?\s+views on\s+[\d.,]+[KMB]?\s+followers\s*[,(]\s*(\d[\d.,]*)x\)?/gi)) note(m[1], `${m[2]}×`);
  return [...creators].map(([handle, values]) => `@${handle} · ${values.join(" · ")}`);
}

/** Repeats in a row become one line with a count ("Post submitted ×4"). */
export function collapseRepeats<T extends { message: string }>(events: T[]): Array<T & { times: number }> {
  const out: Array<T & { times: number }> = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last && last.message === event.message) last.times++;
    else out.push({ ...event, times: 1 });
  }
  return out;
}
