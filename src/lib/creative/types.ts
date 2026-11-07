// The creative engine's contract: the typed documents Nomen's agents hand to each other.
//
//   brand site ─► ProductBrief ─┐
//   research   ─► ReferenceCandidate[] ─► ReferenceBreakdown[] ─► CreativeBrief[] ─► Script[] ─► ProductionPlan ─► EditTimeline ─► final.mp4
//
// Every agent reads the documents before it and writes exactly one of these. Fields are plain
// words a person could check; nothing downstream has to guess what an upstream agent meant.

import type { Video } from "../research";

// ---------- what we sell ----------

export type ProductKind = "physical" | "software" | "service";

/** Something real we can put on screen: a product photo, a screenshot of the product, a clip from the site. */
export type ProductVisual = {
  /** Stable id within a campaign, e.g. "v1". Scripts point at visuals by this id. */
  id: string;
  kind: "photo" | "screenshot" | "video";
  /** A URL Nomen can download (https) or a local path under data/media once captured. */
  url: string;
  /** What is visible, in a few words: "pricing page, three plans", "the bottle on a white background". */
  caption: string;
  /** Where it came from: "site:/pricing", "brand profile", "capture:mobile". */
  source: string;
  /** Pixel size when known; a tall screenshot (height > 2 x width) can scroll in the edit. */
  width?: number;
  height?: number;
};

/** The product analyst's brief: everything a writer needs, in customers' words, with nothing invented. */
export type ProductBrief = {
  name: string;
  /** How a customer would describe it to a friend, one sentence. */
  one_liner: string;
  kind: ProductKind;
  audience: string;
  /** The problem in the customer's own words. */
  problem: string;
  /** The moment the product proves itself, as something you can show: "you paste a URL and 30 seconds later..." */
  aha: string;
  features: Array<{ name: string; what_it_does: string; how_to_show_it: string }>;
  /** Claims the site itself makes, close to verbatim. Writers may only claim what is here. */
  claims: string[];
  /** Numbers, customers, awards or press the site shows. */
  proof: string[];
  objections: string[];
  /** Pricing or offer as the site states it, or "". */
  offer: string;
  /** How the brand talks: "dry, technical, a bit funny". */
  voice: string;
  /** Physical: the product's look precisely enough for a video model. Software: what the main screen shows. */
  look: string;
  visuals: ProductVisual[];
};

// ---------- what already works ----------

/** A public video worth learning from, with why it was picked. Views alone are not enough. */
export type ReferenceCandidate = Video & {
  /** "competitor" (a competitor's own post), "category" (a search in the space), "adjacent" (a format that transfers), "ad". */
  origin: "competitor" | "category" | "adjacent" | "ad";
  score: {
    /** views / max(followers, 1000): how far it outran its account. > 3 is good, > 10 is a breakout. */
    outlier: number | null;
    /** (likes + comments + 2 x shares + 2 x saves) / views. */
    engagement: number;
    /** The ranking score, higher is better. */
    total: number;
    /** One line a person can read: "41x the account's followers, 9% engagement, 23 s". */
    why: string;
  };
};

export type BeatJob = "hook" | "problem" | "agitate" | "reveal" | "demo" | "proof" | "objection" | "payoff" | "cta" | "other";
export type ShotKind = "talking_head" | "product_closeup" | "screen" | "b_roll" | "text_only" | "reaction" | "split";

/** One beat of a reference video, read from its transcript and frames. */
export type ReferenceBeat = {
  start: number;
  end: number;
  job: BeatJob;
  shot: ShotKind;
  /** What the viewer sees. */
  visual: string;
  /** Text on screen during the beat, verbatim, or "". */
  on_screen_text: string;
  /** What is said during the beat, verbatim from the transcript, or "". */
  line: string;
};

/** The breakdown analyst's read of one reference: what it does second by second and why it works. */
export type ReferenceBreakdown = {
  id: string;
  url: string;
  platform: Video["platform"];
  author: string;
  views: number;
  followers: number | null;
  outlier: number | null;
  duration: number;
  /** The format in plain words: "talking head, cuts to the app every 3 s, captions". */
  format: string;
  hook: {
    line: string;
    on_screen_text: string;
    visual: string;
    /** The reusable mechanism: "calls out the viewer's job, then a claim that sounds wrong". */
    mechanic: string;
  };
  beats: ReferenceBeat[];
  pacing: { cuts: number; avg_shot_seconds: number; words_per_minute: number | null };
  /** "white bold, black outline, centre, 2-3 words at a time" or "none". */
  caption_style: string;
  /** How the person talks: register, energy, sentence length, filler words. */
  delivery: string;
  why_it_works: string;
  /** 0-10: how well this format carries the brand's product, with the reason. */
  fit: { score: number; reason: string };
  transcript: string;
};

// ---------- what we will make ----------

export type VideoFormat =
  /** A creator talks to camera; the edit cuts to the real product while they keep talking. */
  | "talking_head_broll"
  /** Creator on top, the product underneath, the whole time. */
  | "split_screen"
  /** No face: the product on screen, a voice-over, captions. */
  | "voiceover_demo"
  /** No voice: the product on screen with large on-screen text. */
  | "text_story";

/** The creative director's brief for one video: which winner it transplants and what changes. */
export type CreativeBrief = {
  title: string;
  /** ReferenceBreakdown.id this video is modeled on. */
  reference_id: string;
  format: VideoFormat;
  angle: string;
  /** Who it speaks to, from ProductBrief.audience or narrower. */
  audience: string;
  /** The reference's hook mechanic, restated for this product. */
  hook_plan: string;
  /** What stays the same as the reference: structure, pacing, framing, caption style. */
  keep: string[];
  /** What changes: the product, the claims, the audience, the setting. */
  change: string[];
  /** ProductVisual ids to show, in order of importance. */
  visuals: string[];
  /** The on-camera creator (formats with a face). One specific, ordinary-looking person. */
  creator: string;
  setting: string;
  platforms: string[];
  caption: string;
  hashtags: string[];
  cta: string;
  why: string;
};

/** One beat of our script, mirroring a reference beat. */
export type ScriptBeat = {
  n: number;
  job: BeatJob;
  /** Planned length in seconds. */
  seconds: number;
  /** What the creator (or voice-over) says. "" for a silent beat. */
  line: string;
  /** Large text on screen (the hook, a label), or "". Captions of the line are added separately. */
  on_screen_text: string;
  /** What fills the screen: the creator, the product, or both stacked. */
  visual: "creator" | "product" | "split";
  /** ProductVisual id for "product" and "split" beats. */
  product_visual: string | null;
  /** Creator: expression and small action. Product: the motion ("slow scroll down", "push in on the label"). */
  direction: string;
};

export type Script = {
  beats: ScriptBeat[];
  total_seconds: number;
  /** The script critic's last verdict. */
  review: { score: number; notes: string[]; rounds: number } | null;
};

// ---------- how it gets made ----------

/** One shot rendered by a video model: a creator saying one or more beats' lines. */
export type ARollShot = {
  n: number;
  /** ScriptBeat numbers this shot covers. */
  beats: number[];
  seconds: number;
  line: string;
  frame_prompt: string;
  video_prompt: string;
};

/** A real product asset placed on the timeline. */
export type BRollClip = {
  beat: number;
  visual_id: string;
  motion: "zoom_in" | "zoom_out" | "scroll_down" | "pan_left" | "pan_right" | "none";
};

export type ProductionPlan = {
  format: VideoFormat;
  aroll: ARollShot[];
  broll: BRollClip[];
  /** voiceover_demo: the line read by text-to-speech instead of a rendered creator. */
  voiceover: { text: string; voice: string } | null;
};

// ---------- the edit ----------

/** Everything the edit engine needs to cut one finished vertical video. All times in seconds. */
export type EditTimeline = {
  /** A-roll clips in order; their audio is the video's soundtrack unless `audio` says otherwise. */
  aroll: Array<{ path: string }>;
  /** A separate soundtrack (voice-over formats). When set, A-roll audio is ignored. */
  audio: { path: string } | null;
  /** What fills the screen and when. Gaps show the A-roll. */
  segments: Array<{
    start: number;
    end: number;
    layer: "aroll" | "broll" | "split";
    broll?: { path: string; kind: "image" | "video"; motion: BRollClip["motion"] };
  }>;
  /** Spoken-word captions, 1-4 words each. */
  captions: Array<{ start: number; end: number; text: string }>;
  /** Large text (the hook, labels), placed in the top third. */
  overlays: Array<{ start: number; end: number; text: string }>;
  /** Total length; defaults to the soundtrack's length. */
  duration?: number;
};
