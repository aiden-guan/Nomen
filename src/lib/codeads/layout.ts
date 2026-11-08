// story.json for the page: the narration's beats and words on the clock, the callouts anchored to their words, and the
// ad's beats with absolute times (ported from ED Studio's tools/narrate.py `layout`, plus the code-ad block).

import type { CodeAdBrand, CodeAdStory, Voiced } from "./types";

/** ElevenLabs audio tags ("[shouting]") steer the delivery; they are never shown or timed. */
const TAG = /\[[^\]]*\]/g;
export const untag = (s: string) => (s ?? "").replace(TAG, " ").replace(/\s{2,}/g, " ").trim();
/** A word as the anchors match it: lower case letters and digits only, accents dropped ("Naïve" → "naive"). */
export const norm = (token: string) => token.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** A spoken token as the caption shows it: no edge punctuation (keeps $ and %), first letter capitalized. */
export function display(token: string) {
  const t = token.replace(/^[^\w$]+|[^\w%]+$/gu, "");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/** The page's look (ED Studio 026's build look: neutral tone mapping, light bloom and grain). */
export const LOOK = { exposure: 1.1, bloom: 0.12, fill: 0.45, toneMapping: "neutral", vignette: 0.14, grain: 0.012, warm: 0.3, saturation: 1.08, lift: 0.01 };

/**
 * Where the callouts sit, as a fraction of the frame height. ED Studio's build reels stack them above the faces (its
 * dioramas have sky up there); a code ad's top third is the wall screen, so they go to the lower third, over the desk
 * and the floor, below the one-word caption (52 %).
 */
export const BANDS = { term: 0.69, money: 0.735, label: 0.775, stamp: 0.63, sfx: 0.62 } as const;

export type StoryJson = {
  mode: "build";
  duration: number;
  fps: number;
  motionBlur: number;
  look: typeof LOOK;
  beats: Record<string, { t0: number; t1: number; s0: number; s1: number; i: number; w: Array<[string, number, number]> }>;
  order: string[];
  words: Array<{ w: string; t0: number; t1: number }>;
  callouts: Array<{ text: string; style: string; t0: number; t1: number; y?: number; pos?: [number, number] }>;
  codead: {
    brand: CodeAdBrand;
    nameplate: string;
    poster: string;
    beats: Array<{ id: string; gag: string; t0: number; t1: number; s0: number; s1: number; hit: number; screen: { kind: string; lines?: string[]; image?: string; title?: string }; labels: string[]; label: string }>;
  };
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Lays the voiced narration out as the page's story.json. `images` maps a beat's visual_id to its /ad/ path. Callouts
 * whose anchor word was not said are dropped and listed in `notes`.
 */
export function layoutStory(story: CodeAdStory, voiced: Voiced, brand: CodeAdBrand, images: Record<string, string>, options: { fps?: number; motionBlur?: number; joinLen?: number } = {}): { story: StoryJson; notes: string[] } {
  const dur = voiced.duration;
  const notes: string[] = [];
  const beats: StoryJson["beats"] = {};
  const order: string[] = [];
  let words: Array<{ w: string; t0: number; t1: number; p?: boolean; join?: boolean }> = [];
  const callouts: StoryJson["callouts"] = [];
  const codeBeats: StoryJson["codead"]["beats"] = [];
  voiced.beats.forEach((vb, i) => {
    const next = voiced.beats[i + 1];
    const t0 = i === 0 ? 0 : vb.t0;
    const t1 = next ? next.t0 : dur;
    const sb = story.beats.find((b) => b.id === vb.id);
    beats[vb.id] = { t0: r3(t0), t1: r3(t1), s0: vb.t0, s1: vb.t1, i, w: vb.words.map((w) => [norm(w.w), w.t0, w.t1]) };
    order.push(vb.id);
    for (const w of vb.words) {
      const d = display(w.w);
      // 'p': the word ends a clause ("it," "Gary."): captions never join across it
      if (d) words.push({ w: d, t0: w.t0, t1: w.t1, p: /[.,!?:;]["')]*$/.test(w.w.trim()) });
    }
    if (!sb) return;
    for (const c of sb.callouts) {
      const hits = vb.words.map((w, k) => (norm(w.w) === norm(c.at) ? k : -1)).filter((k) => k >= 0);
      const k = hits[(c.nth ?? 1) - 1];
      if (k === undefined) {
        notes.push(`beat "${vb.id}": callout "${c.text}" dropped, its word "${c.at}" is not in the line`);
        continue;
      }
      const a = vb.words[k].t0 - 0.04;
      let e = t1 + 0.25;
      if (c.until) {
        const u = vb.words.findIndex((w, j) => j >= k && norm(w.w) === norm(c.until!));
        if (u >= 0) e = vb.words[u].t1 + 0.3;
      }
      e = Math.min(e, t1 + 0.1, dur);
      // long enough to read: a term or a fact 1.3 s (ED Studio's terms stay up ~1.5-2 s), a stamp or a comic word 0.8 s
      const least = c.style === "stamp" || c.style === "sfx" ? 0.8 : 1.3;
      if (e - a < least) e = Math.min(dur, a + least);
      callouts.push({ text: c.text, style: c.style, t0: r3(a), t1: r3(e), ...(c.style === "sfx" ? { pos: [0.5, BANDS.sfx] as [number, number] } : { y: BANDS[c.style] }) });
    }
    const hitWord = vb.words.find((w) => norm(w.w) === norm(sb.hit));
    if (!hitWord) notes.push(`beat "${vb.id}": the gag's word "${sb.hit}" is not in the line; it lands mid-line`);
    const hit = hitWord ? hitWord.t0 : vb.t0 + 0.55 * (vb.t1 - vb.t0);
    const label = sb.gag === "approve" ? (sb.labels[0] ?? "APPROVE") : (sb.labels[0] ?? "");
    const screen = sb.screen.kind === "image" ? (images[sb.screen.visual_id ?? ""] ? { kind: "image", image: images[sb.screen.visual_id ?? ""] } : { kind: "logo" }) : { kind: sb.screen.kind, ...(sb.screen.lines?.length ? { lines: sb.screen.lines } : {}), ...(sb.screen.title ? { title: sb.screen.title } : {}) };
    codeBeats.push({ id: vb.id, gag: sb.gag, t0: r3(t0), t1: r3(t1), s0: vb.t0, s1: vb.t1, hit: r3(hit), screen, labels: sb.labels, label });
  });
  // a word shown for < 0.12 s (a fast "a", "to") joins the next one in one caption instead of flashing, never across a clause
  const joinLen = options.joinLen ?? 4;
  const merged: typeof words = [];
  words.forEach((w, k) => {
    const prev = merged[merged.length - 1];
    if (prev?.join && w.t0 - prev.t1 < 0.25) {
      prev.w = `${prev.w} ${w.w}`;
      prev.t1 = w.t1;
      prev.join = false;
      prev.p = w.p;
      return;
    }
    const item = { ...w };
    merged.push(item);
    const nextT0 = words[k + 1]?.t0 ?? dur;
    if (nextT0 - w.t0 < 0.12 && w.w.length <= joinLen && k + 1 < words.length && !w.p) item.join = true;
  });
  // a caption word stays up until the next one starts (no blank flicker inside a sentence), at most 0.35 s past its end
  words = merged.map((w, k) => {
    const nextT0 = merged[k + 1]?.t0 ?? dur;
    return { w: w.w, t0: r3(w.t0), t1: r3(nextT0 - w.t1 > 0.12 ? Math.min(nextT0, w.t1 + 0.35) : nextT0) };
  });
  return {
    story: {
      mode: "build",
      duration: r3(dur),
      fps: options.fps ?? 60,
      motionBlur: options.motionBlur ?? 2,
      look: LOOK,
      beats,
      order,
      words,
      callouts,
      codead: { brand, nameplate: story.nameplate, poster: story.poster, beats: codeBeats },
    },
    notes,
  };
}
