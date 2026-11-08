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
  /**
   * The store's file key of a captured copy ("visuals-cmp_…/site-pricing.png"). On a serverless host
   * the local path is gone on the next tick; production fetches the file again by this key.
   */
  key?: string;
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
  /** From the brand's linked code (read-only scan): real commands, screens and UI text, for accurate scripts and screens. */
  code?: { commands: string[]; screens: Array<{ route: string; summary: string }>; ui_strings: string[] };
};

// ---------- what already works ----------

/**
 * What a video is for in a campaign. "reach" videos earn views and shares (judged on views and
 * shares); "convert" videos make the viewer act (judged on link clicks and sign-ups). Campaigns mix
 * both, the way performance teams split awareness and conversion creative.
 */
export type FunnelRole = "reach" | "convert";

/** A public video worth learning from, with why it was picked. Views alone are not enough. */
export type ReferenceCandidate = Video & {
  /**
   * "competitor" (a competitor's own post), "category" (a search in the space), "adjacent" (a format
   * that transfers), "benchmark" (a brand or creator famous for viral short-form, e.g. Cluely or
   * MrBeast: judged on raw virality, not on beating its account), "ad" (a paid ad from an ad
   * library: judged on how long the advertiser kept paying for it).
   */
  origin: "competitor" | "category" | "adjacent" | "benchmark" | "ad";
  score: {
    /** views / max(followers, 1000): how far it outran its account. > 3 is good, > 10 is a breakout. */
    outlier: number | null;
    /** (likes + comments + 2 x shares + 2 x saves) / views. */
    engagement: number;
    /** The reach score, which ranks candidates: higher is better. */
    total: number;
    /** One line a person can read: "41x the account's followers, 9% engagement, 23 s". */
    why: string;
    /** 0-10: public evidence that the video sells, not just that it was seen (see conversionOf). */
    conversion?: number;
    /** "convert" for ads and videos with strong conversion evidence, else "reach". */
    role?: FunnelRole;
    /** The named signals behind `conversion`: "ran 94 days", "saves per like 2.1x the pool's". */
    signals?: string[];
    /** How cleanly the footage clone can remake it: a prior from the caption and length (see cloneabilityPrior). */
    cloneability?: Cloneability;
  };
};

/**
 * The parts of a cloneability score. The metadata prior uses base, face_format, green_screen,
 * several_people, moving, music, hands, tied and length; the breakdown's read uses people, face,
 * takes, camera, set, audio, script, product, overlays and length.
 */
export type CloneComponent =
  | "base"
  | "face_format"
  | "green_screen"
  | "several_people"
  | "moving"
  | "music"
  | "hands"
  | "tied"
  | "people"
  | "face"
  | "takes"
  | "camera"
  | "set"
  | "audio"
  | "script"
  | "product"
  | "overlays"
  | "length";

/**
 * How faithfully the footage clone can remake a reference one-to-one (0-10): a lookalike AI persona
 * performs the original's exact motion (one person, continuous takes), the original audio is
 * re-voiced and graphics and captions are replaced in place. See src/lib/creative/cloneability.ts.
 */
export type Cloneability = {
  score: number;
  /** "metadata": guessed from the caption and length before anyone watched it; "breakdown": read from its frames, cuts and transcript. */
  basis: "metadata" | "breakdown";
  /** Every component with its points, so a person (or the director) can see why. */
  parts: Array<{ name: CloneComponent; points: number; signal: string }>;
};

/** What the breakdown analyst saw of a reference's footage that decides whether the clone can reproduce it. */
export type FootageRead = {
  /** Different people on camera over the whole video (one person in two outfits counts once). */
  people: number;
  /** Share of the video (0-1) with a face and mouth visible, talking to the lens. */
  face_to_camera: number;
  /** static: a propped-up phone or tripod; handheld: held, small sway; moving: walking, panning, following action. */
  camera: "static" | "handheld" | "moving";
  /** plain: a room, desk, car or wall; green_screen: a person over a keyed picture; location: a real place; crowd: other people around. */
  set: "plain" | "green_screen" | "location" | "crowd";
  /** none; brief: held up or shown for a moment; close_up: hands using the product in close-up. */
  product: "none" | "brief" | "close_up";
  /** none; separable: captions, text boxes, stickers or screenshots laid over; baked: text tracked to objects or behind the person. */
  overlays: "none" | "separable" | "baked";
  /** What carries the sound: one voice (speech), a narrator over footage (voiceover), music only, people talking to each other (dialogue), a song, or none. */
  audio: "speech" | "voiceover" | "music_only" | "dialogue" | "song" | "none";
  /** template: a hook, claim and ask that would carry another product; tied: depends on a specific event, person, place or trend. */
  script: "template" | "tied";
  /** The hardest thing for one AI performer copying the original's motion to reproduce, in one sentence. */
  hardest: string;
};

/** The direct-response structure a video follows, as performance teams name them. */
export type SellingStructure =
  | "problem_solution"
  | "demo"
  | "testimonial"
  | "review"
  | "before_after"
  | "us_vs_them"
  | "listicle"
  | "founder_story"
  | "objection_handling"
  | "tutorial"
  | "skit"
  | "reaction"
  | "trend"
  | "story"
  | "other";

/** How a reference sells, read from its transcript and frames, so a remake can keep its selling beats. */
export type ConversionAnatomy = {
  /** What the video itself is built to do. */
  role: FunnelRole;
  structure: SellingStructure;
  /** The pain it names, quoted, or "". */
  problem: string;
  /** What it offers as proof (a result on screen, a number, a demo, a review), quoted or described, or "". */
  proof: string;
  /** Price, discount, free tier or trial as said or shown, or "". */
  offer: string;
  /** The call to action word for word ("comment AGENT and I'll send it", "link in bio"), or "". */
  cta: string;
  /** The objection it answers ("is it worth it?") and how, or "". */
  objection: string;
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
  /** The lane it came from (an "ad" has no view count). */
  origin?: ReferenceCandidate["origin"];
  /** reach or convert: convert when it is an ad, its numbers show conversion evidence, or the video is built to sell. */
  role?: FunnelRole;
  /** The candidate's conversion evidence (0-10) and the signals behind it. */
  conversion?: { score: number; signals: string[] };
  /** Its selling beats (problem, proof, offer, call to action), for remakes that must convert. */
  anatomy?: ConversionAnatomy;
  /** What its footage is made of, as the footage clone needs to know it (people, face, camera, set, sound). */
  footage?: FootageRead;
  /** How cleanly the footage clone can remake it, from `footage`, the cuts and the length. */
  cloneability?: Cloneability;
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
  | "text_story"
  /** Product graphics full screen, the presenter in a small rounded window (the dev-tutorial look). */
  | "presenter_inset"
  /** No face: a phone filming a computer monitor while a voice walks through the product (the screen-walkthrough look). */
  | "filmed_screen";

/** The creative director's brief for one video: which viral video it remakes and what changes for this product. */
/** What a video is judged on once posted: reach videos on attention, convert videos on action. */
export type SuccessMetric = "views" | "shares" | "saves" | "link_clicks" | "sign_ups" | "purchases";

export type CreativeBrief = {
  title: string;
  /** ReferenceBreakdown.id this video is modeled on. */
  reference_id: string;
  /** Its job in the campaign. Missing on briefs written before campaigns were planned as a mix. */
  role?: FunnelRole;
  /** The number this video is judged on (reach: views, shares, saves; convert: link clicks, sign-ups, purchases). */
  metric?: SuccessMetric;
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
  /** What fills the screen: the creator, the product, both stacked, or the product with the presenter inset. */
  visual: "creator" | "product" | "split" | "inset";
  /** ProductVisual id for "product" and "split" beats. */
  product_visual: string | null;
  /**
   * A screen to build for this beat instead of (or when there is no) fitting real visual: what the
   * graphic shows, in plain words, styled like the reference's matching beat. Built by the screen builder.
   */
  screen?: string;
  /** Creator: expression and small action. Product: the motion ("slow scroll down", "push in on the label"). */
  direction: string;
  /**
   * How the line is said, as voice tags from the reference's delivery: "[excited]", "[smug]",
   * "[laughs]". A presenter that voices itself gets them as an emotion arc in words.
   */
  emotion?: string;
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
  /** The shot's one gentle action: a later shot's first frame is shot 1's still re-posed to it, in the same place. */
  pose?: string;
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
  /** Formats without a creator: the line read by text-to-speech instead of a rendered creator. */
  voiceover: { text: string; voice: string } | null;
  /** Screens the screen builder renders before the edit; their clips are B-roll visual ids `screen:<id>`. */
  screens?: ScreenRequest[];
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
    layer: "aroll" | "broll" | "split" | "inset" | "filmed";
    broll?: { path: string; kind: "image" | "video"; motion: BRollClip["motion"] };
    /** filmed: the photo of a monitor the visual is composited into, and where its screen is. */
    plate?: FilmedPlate;
  }>;
  /** Spoken-word captions, 1-4 words each. */
  captions: Array<{ start: number; end: number; text: string }>;
  /** Large text (the hook, labels), placed in the top third. */
  overlays: Array<{ start: number; end: number; text: string }>;
  /** Total length; defaults to the soundtrack's length. */
  duration?: number;
};

/** A point in image pixels (x right, y down). */
export type Point = { x: number; y: number };

/** A screen's four corners in image pixels, clockwise from the top left: TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];

/**
 * filmed_screen's backdrop: one photo of a desktop monitor taken with a phone, its display solid
 * green, and the display's corners in that photo. The edit warps each screen into the quad.
 */
export type FilmedPlate = { path: string; quad: Quad };

// ---------- the brand kit (assets the brand gives us) ----------

/** One file the brand uploaded or Nomen found in its repo. */
export type BrandAsset = {
  /** Stable id within the brand, e.g. "a3". */
  id: string;
  kind: "logo" | "icon" | "screenshot" | "image" | "video" | "font" | "doc";
  /** Absolute path under data/brandkits/<brandId>/. */
  path: string;
  /** Where it came from: "upload" or "repo:<path in repo>". */
  source: string;
  /** What is visible or what it is, in a few words (filled by a vision pass for images). */
  caption: string;
  width?: number;
  height?: number;
  bytes: number;
};

/** What a read-only scan of the brand's code found (never executed). */
export type RepoScan = {
  /** "github:owner/repo" or "local:/path". */
  origin: string;
  scanned_at: string;
  name: string;
  description: string;
  /** README, first ~4k characters. */
  readme: string;
  /** Brand colors from Tailwind config, CSS variables or theme files, most used first. */
  colors: Array<{ name: string; hex: string; source: string }>;
  /** Font families the app uses (and bundled font files, as assets). */
  fonts: string[];
  /** Commands a user runs, from README code blocks, package.json bin/scripts or docs: "npx monid init". */
  commands: string[];
  /** The app's main screens: route or page names with a one-line summary each. */
  screens: Array<{ route: string; summary: string; file: string }>;
  /** Key UI components worth recreating on screen, with short source excerpts (styles, structure). */
  components: Array<{ name: string; file: string; excerpt: string }>;
  /** Real strings that appear in the product (button labels, headings, sample data), for realistic screens. */
  ui_strings: string[];
};

/** Everything the brand gave us, merged: uploaded assets, repo assets and the repo scan. */
export type BrandKit = {
  brand_id: string;
  updated_at: string;
  assets: BrandAsset[];
  repo: RepoScan | null;
};

// ---------- generated screens (the screen builder) ----------

/** One beat's on-screen graphic, to be built from the brand kit and product facts. */
export type ScreenRequest = {
  /** Unique within a video, e.g. "crv_x-b3". */
  id: string;
  /** What the viewer should see, in plain words: "a terminal where `set up monid.ai/SKILL.md` is typed and the agent replies 'connected: 2900+ tools'". */
  brief: string;
  /** The spoken line it accompanies (for timing and emphasis). */
  line: string;
  seconds: number;
  /** How the reference's matching beat looked, from its breakdown, so the screen copies its style. */
  reference_visual: string;
  /** Full screen (1080x1920), the half a split layout gives it (1080x960), or a desktop monitor (1440x900) that filmed_screen films with a phone. */
  size: "full" | "half" | "desktop";
};

/** A rendered screen: a short clip (or a still when it does not move) ready for the edit. */
export type ScreenClip = {
  id: string;
  kind: "video" | "image";
  path: string;
  seconds: number;
  /** The HTML that produced it, kept for debugging and re-renders. */
  html_path: string;
};
