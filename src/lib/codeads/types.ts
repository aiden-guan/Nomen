// Code ads: fast, narrated, product-first 15-30 s ads made entirely in code, in ED Studio's build genre (a cartoon developer
// in a 3D dollhouse office, one gliding camera take, one spoken word at a time, yellow term callouts, a synthesized score).
//
//   CreativeBrief (format "code_ad") ─► story.ts (the model writes a CodeAdStory from the brief, the product and a viral
//   reference in any niche) ─► narrate.ts (one voice clip per beat, word times) ─► layout.ts (story.json for the page)
//   ─► cues.ts (cue sheet) ─► synth.py (music + foley + the voice) ─► render.ts (headless Chrome, WebGL) ─► final.mp4
//
// The beats are the whole video: each says one line, plays one gag from a fixed list (engine/codead.js knows how to
// animate each) and puts one picture on the office's wall screen.

/** What happens on screen during a beat (engine/codead.js animates each). */
export const GAGS = ["hack", "explode", "bury", "zap", "money", "deliver", "team", "approve", "show", "celebrate", "idle"] as const;
export type Gag = (typeof GAGS)[number];

/** A word or phrase on screen next to the spoken word: term (the feature's name, yellow), label (a fact, orange), money (green), stamp (red, slammed), sfx (a small comic word). */
export const CALLOUT_STYLES = ["term", "label", "money", "stamp", "sfx"] as const;
export type CalloutStyle = (typeof CALLOUT_STYLES)[number];

/** What the wall screen shows: a terminal, a chat, a real product visual, the brand card, a red error, a list of agents working. */
export const SCREEN_KINDS = ["terminal", "chat", "image", "logo", "error", "dashboard", "none"] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

export type CodeAdScreen = {
  kind: ScreenKind;
  /** terminal: commands ("> " lines are output); chat: your message, then the agent's replies; error: the title, then details; dashboard: one agent per line. */
  lines?: string[];
  /** image: a ProductVisual id from the product brief. */
  visual_id?: string;
  title?: string;
};

export type CodeAdCallout = {
  /** The spoken word it appears on (must be a word of the beat's line). */
  at: string;
  text: string;
  style: CalloutStyle;
  /** Stays up until this later word of the same beat (else to the end of the beat). */
  until?: string;
  /** Which occurrence of `at`, when it is said more than once. */
  nth?: number;
};

export type CodeAdBeat = {
  id: string;
  /** What the narrator says. May carry one ElevenLabs audio tag ([shouting], [excited], [whispers], [sarcastic]); tags are not shown or timed. */
  say: string;
  gag: Gag;
  /** The word of `say` the gag lands on (the explosion, the crate landing, the button slam). */
  hit: string;
  /** bury: what the boxes say ("TABS", "API KEYS"); team: one role per new agent ("EMAIL", "VIDEO"); deliver: the agent's role; approve: the button ("APPROVE" or "DENY"). */
  labels: string[];
  screen: CodeAdScreen;
  callouts: CodeAdCallout[];
};

/** The developer on screen: a heavyset dev in a hoodie and glasses, or a sharp, handsome one. They rotate between videos. */
export const HEROES = ["geek", "mogger"] as const;
export type Hero = (typeof HEROES)[number];

export type CodeAdStory = {
  /** Who plays the developer (engine/codead.js HEROES). */
  hero?: Hero;
  /**
   * The viral video this ad borrows its concept from (any niche: an engineering explainer, a money story, a sim), and
   * how: its premise and hook mechanic, and how they carry this product. The words are never theirs.
   */
  concept: { reference_id: string; premise: string; mechanic: string; adaptation: string };
  beats: CodeAdBeat[];
  /** On the developer's desk: "DEV · FOUNDER". */
  nameplate: string;
  /** The poster on the office wall: the brand's own tagline. */
  poster: string;
  /** The url said and shown at the end ("usenaive.ai"). */
  url: string;
};

/** The brand as the page draws it: colours and the files under /ad/. */
export type CodeAdBrand = {
  name: string;
  url: string;
  /** /ad/... paths (served from the ad's folder), or null. */
  logo: string | null;
  logoOnLight: string | null;
  font: string | null;
  fontFamily: string | null;
  colors: { screenBg: string; screenFg: string; accent: string; crate: string; robot: string; eye: string; sign: string; wall: string };
};

/** One voiced beat: its clip's place in voice.wav and its words, in seconds of voice.wav. */
export type VoicedBeat = { id: string; t0: number; t1: number; words: Array<{ w: string; t0: number; t1: number }> };
export type Voiced = { provider: "eleven" | "naive" | "scratch"; duration: number; beats: VoicedBeat[] };
