// Word-level helpers for one-to-one remakes. A remake keeps the reference's spoken words and
// changes only the product facts, so the script linter and the dub both need to know which words
// changed, where they sat in time, and how many syllables they had (the presenter's lips follow
// the original mouth, so a replaced phrase should take about as many syllables as the old one).

export type TimedWord = { text: string; start: number; end: number };

/** A word reduced for matching: lower case, letters and digits only ("$400,000" and "400000" match). */
export function normWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The spoken words of a line, punctuation kept on each word (for display), empty bits dropped. */
export function tokens(text: string): string[] {
  return text
    .replace(/[—–]/g, " ")
    .split(/\s+/)
    .filter((token) => normWord(token) !== "");
}

/** One stretch of a word-level diff: half-open index ranges into `a` and `b`. */
export type Stretch = { same: boolean; a: [number, number]; b: [number, number] };

/**
 * The longest-common-subsequence diff of two word lists, as alternating same and changed
 * stretches (consecutive changes merged). Quadratic, which is fine for a short video's words.
 */
export function diffWords(a: string[], b: string[]): Stretch[] {
  const x = a.map(normWord);
  const y = b.map(normWord);
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: Stretch[] = [];
  const push = (same: boolean, i: number, j: number, di: number, dj: number) => {
    const last = out[out.length - 1];
    if (last && last.same === same) {
      last.a[1] += di;
      last.b[1] += dj;
    } else out.push({ same, a: [i, i + di], b: [j, j + dj] });
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      push(true, i, j, 1, 1);
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      push(false, i, j, 0, 1);
      j++;
    } else {
      push(false, i, j, 1, 0);
      i++;
    }
  }
  return out;
}

// ---------- syllables ----------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A whole number as it is said: 400000 → "four hundred thousand". */
export function numberWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  n = Math.floor(n);
  if (n < 20) return ONES[n];
  if (n < 100) return [TENS[Math.floor(n / 10)], n % 10 ? ONES[n % 10] : ""].filter(Boolean).join(" ");
  if (n < 1000) return [ONES[Math.floor(n / 100)], "hundred", n % 100 ? numberWords(n % 100) : ""].filter(Boolean).join(" ");
  for (const [size, name] of [
    [1e9, "billion"],
    [1e6, "million"],
    [1e3, "thousand"],
  ] as const) {
    if (n >= size) return [numberWords(Math.floor(n / size)), name, n % size ? numberWords(n % size) : ""].filter(Boolean).join(" ");
  }
  return "";
}

/** How a token with digits is said: "$400,000" → "four hundred thousand dollars", "2,900+" → "two thousand nine hundred plus". */
export function spoken(token: string): string {
  const match = token.match(/^([$€£]?)(\d[\d,]*)(?:\.(\d+))?\s*([kmb%+x]|k\+|m\+)?/i);
  if (!match) return token;
  const [, currency, whole, decimal, suffix] = match;
  const parts = [numberWords(Number(whole.replace(/,/g, "")))];
  if (decimal) parts.push("point", ...decimal.split("").map((d) => ONES[Number(d)]));
  const unit = (suffix ?? "").toLowerCase();
  if (unit.startsWith("k")) parts.push("thousand");
  if (unit.startsWith("m")) parts.push("million");
  if (unit === "b") parts.push("billion");
  if (unit === "%") parts.push("percent");
  if (unit === "x") parts.push("times");
  if (unit.endsWith("+")) parts.push("plus");
  if (currency) parts.push(currency === "$" ? "dollars" : currency === "€" ? "euros" : "pounds");
  const rest = token.slice(match[0].length).replace(/[^\p{L}]+/gu, "");
  return [...parts, rest].filter(Boolean).join(" ");
}

/**
 * Syllables in one word, by the usual English heuristic (vowel groups, minus a silent final e),
 * with numbers counted as they are said. Close enough to compare a phrase with the one it replaces.
 */
export function syllables(word: string): number {
  if (/\d/.test(word)) {
    // Split letters from numbers first ("v1" → "v" + "1"): a token spoken() can't read comes back
    // unchanged, still with its digits, and counting it again recursed forever (the Jordan remake).
    const parts = word.match(/[$€£]?\d[\d,]*(?:\.\d+)?(?:k\+|m\+|[kmb%+x])?|[^\d$€£]+/gi) ?? [];
    return parts.reduce((sum, part) => sum + (/\d/.test(part) ? spoken(part).split(/\s+/).filter((w) => !/\d/.test(w)).reduce((n, w) => n + syllables(w), 0) : syllables(part)), 0);
  }
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w
    .replace(/(?:[^laeiouy]es|[^laeiouy]e)$/, (end) => end.slice(0, 1))
    .replace(/([^aeiouytdr])ed$/, "$1")
    .replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]+/g)?.length ?? 0;
  return Math.max(1, groups);
}

/** Syllables in a phrase. */
export function phraseSyllables(text: string): number {
  return tokens(text).reduce((sum, token) => sum + syllables(token), 0);
}
