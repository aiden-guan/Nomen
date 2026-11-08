import type { Video } from "../research";
import type { CloneComponent, Cloneability, FootageRead, ReferenceBeat } from "./types";

// Cloneability: how faithfully Nomen can remake a reference one-to-one from its own footage. The
// footage clone has a lookalike AI persona perform the original's exact motion (Kling 3.0 Motion
// Control: one person, single continuous takes), re-voices the original audio, and replaces graphics
// and captions in place. One person talking to a propped-up phone in a plain room is what it does
// best, and it is also the UGC format with the most return; several people, a camera that walks,
// real locations and crowds, hands working a product in close-up, and songs or dialogue are what it
// cannot reproduce. A video that went viral but cannot be cloned is not a reference we can use.

/** Below this, a reference is picked only as a last resort: when nothing cloneable is left. */
export const CLONE_GATE = 4;
/** At or above this, the clone has most of what it needs; the director says why when it remakes anything below. */
export const CLONE_EASY = 6;

/**
 * What one cloneability point is worth when picking, in each lane's own currency: reach-score points
 * (which spread over about 30 points between a flop and a breakout) and conversion points (0-10). At
 * these weights, face-to-camera UGC (about 9) beats an unknown format (5) by 6 reach points, about
 * the gap between a 3x and a 9x outlier, and by 2 conversion points.
 */
export const CLONE_WEIGHT = { reach: 1.5, convert: 0.5 } as const;

/** The length past which every second costs, as in the reach score: each take is one more to clone. */
const SHORT_SECONDS = 45;

type Part = Cloneability["parts"][number];

// ---------- the prior, from metadata ----------

/** Captions of the face-to-camera formats that convert: testimonials, "I tried X", storytime, POV, reactions, green-screen commentary. */
const FACE_FORMAT =
  /\bstory ?time\b|\bpov\b|\bi (?:tried|tested)\b|\breview\b|\brant\b|\bhot take\b|\bunpopular opinion\b|\bpsa\b|\btestimonial\b|\bthings i wish i (?:knew|had known)\b|\blet me tell you\b|\breplying to @|\breply to @|#talkingheads?\b|#ugc(?:creator|content)?\b|\bgreen ?screen\b|\breact(?:ion|ing)\b|\bmy (?:honest )?(?:thoughts|opinion|take)\b|\bhonest (?:opinion|thoughts)\b|\bwhy i (?:switched|stopped|quit|use|love|hate)\b/i;
const GREEN_SCREEN = /\bgreen ?screen\b/i;
/** Duets, stitches, interviews, podcasts, couples and families: more than one person on camera. */
const SEVERAL_PEOPLE =
  /\bduet\b|\bstitch\b|\binterview\b|\bpodcast\b|\bmy (?:boyfriend|girlfriend|husband|wife|bf|gf|fianc[eé]e?|mom|mum|dad|parents|sister|brother|friends?|bestie|bff|roommates?|coworkers?|boss|kids?|son|daughter|team|grandma|grandpa)\b|\bcouples?\b|\bfamily\b|\bprank(?:ed|ing|s)?\b|\b(?:ft|feat)\.?\s*@\w|\bwith @\w|\bw\/\s*@\w|\bwe (?:tried|tested)\b/i;
/** Vlogs, travel, the gym, events: a camera that walks through real places. */
const MOVING =
  /\bvlog\b|\bday in (?:the|my) life\b|\bditl\b|\btravel(?:ing|ling)?\b|\b(?:road ?)?trip\b|\b(?:come|walk) with me\b|\bgym\b|\bworkout\b|\bfestival\b|\bconcert\b|\bhik(?:e|ing)\b|\bairport\b|\bstreet\b|\bmarathon\b|\bvacation\b/i;
/** Lip-syncs, dances, songs and trends: the sound is music the clone cannot re-voice. */
const MUSIC = /\blip ?sync(?:ing)?\b|\bdanc(?:e|ing)\b|\bchoreo(?:graphy)?\b|\bsinging\b|\bsong\b|\bchallenge\b|\bremix\b|\btrend\b/i;
/** Unboxings, ASMR, recipes, makeup: hands working a product in close-up. */
const HANDS =
  /\bunbox(?:ing)?\b|\basmr\b|\brecipe\b|\bcook(?:ing)?\b|\bhow to make\b|\bgrwm\b|\bget ready with me\b|\bmakeup\b|\bskin ?care routine\b|\bsatisfying\b|\bdiy\b|\bswatch(?:es)?\b|\bpour(?:ing)?\b|\bassembl(?:e|ing|y)\b|\bhaul\b/i;
/** News, drama and series: a script tied to an event, a person or an earlier part. */
const TIED = /\bnews\b|\bbreaking\b|\bpart \d+\b|\bpt\.? ?\d+\b|\bdrama\b|\bexposed\b|\belection\b|\blawsuit\b|\bupdate on\b/i;

/**
 * Cloneability before anyone has watched the video, from what research already has: the caption
 * and the length. It starts at 5 (format unknown) and moves with the caption's cues:
 *
 *   face_format     +2    a face-to-camera format: storytime, POV, "I tried", review, rant, hot take,
 *                         a reply to a comment, a reaction, green screen, #talkinghead, #ugc
 *   green_screen    +0.5  green screen: the set is a picture, so it rebuilds exactly
 *   several_people  -2.5  a duet, stitch, interview, podcast, prank, "my boyfriend", "ft. @", "we tried"
 *   moving          -1.5  a vlog, day in the life, travel, the gym, a concert, the street
 *   music           -1.5  a lip-sync, dance, song, challenge or trend
 *   hands           -1    an unboxing, ASMR, recipe, makeup, GRWM, a haul
 *   tied            -0.5  news, drama, "part 2": tied to an event, a person or a series
 *   length          past 45 s, -(s - 45) / 15, at most -2
 *
 * Each cue counts once, quoted in its signal; the score is clamped to 0-10. At most 7.5: only the
 * breakdown, which sees the frames, can call a video an easy clone.
 */
export function cloneabilityPrior(video: Pick<Video, "caption" | "duration">): Cloneability {
  const caption = video.caption ?? "";
  const parts: Part[] = [{ name: "base", points: 5, signal: "not watched yet: 5 to start" }];
  const cue = (name: CloneComponent, pattern: RegExp, points: number, label: string) => {
    const match = caption.match(pattern);
    if (match) parts.push({ name, points, signal: `${label} ("${match[0].trim()}")` });
  };
  cue("face_format", FACE_FORMAT, 2, "caption names a face-to-camera format");
  cue("green_screen", GREEN_SCREEN, 0.5, "green screen: the set is a picture");
  cue("several_people", SEVERAL_PEOPLE, -2.5, "caption suggests several people");
  cue("moving", MOVING, -1.5, "caption suggests a moving camera or real locations");
  cue("music", MUSIC, -1.5, "caption suggests a song or dance");
  cue("hands", HANDS, -1, "caption suggests hands on a product in close-up");
  cue("tied", TIED, -0.5, "caption suggests a script tied to an event or series");
  const length = lengthPart(video.duration);
  if (length) parts.push(length);
  return finish("metadata", parts);
}

// ---------- the read, from the breakdown ----------

/**
 * Cloneability from the breakdown: what the vision model saw in the frames (FootageRead), the cuts
 * ffmpeg detected, whether anyone speaks, and the length. Seven components that add up to 10 for
 * the ideal reference (one person talking to a propped-up phone in a plain room, in long takes, with
 * a script that would carry any product), less what the clone cannot reproduce:
 *
 *   people    0-2.5  one person 2.5; nobody (screens, text, product) 1.5; two 0.5; three or more 0
 *   face      0-2    2 x the share of the video with a face and mouth talking to the lens
 *   takes     0-1.5  cuts per 10 s: 1.5 at 2 or fewer, 0 at 6 or more (rapid jump cuts), linear between
 *   camera    0-1    propped-up phone or tripod 1; handheld 0.5; moving (walking, panning) 0
 *   set       0-1    plain room or green screen 1; a real location 0.3; a crowd 0
 *   audio     0-1.5  one voice 1.5; a voice-over 1; music only or silence 0.5; dialogue or a song 0
 *                    (claimed speech with no words in the transcript counts as music only)
 *   script    0-0.5  a template (hook, claim, ask) 0.5; tied to an event or person 0
 *   product   -1.5   hands using the product in close-up; -0.5 held up briefly
 *   overlays  -1     text or graphics baked into the footage (captions laid over are replaced in place: 0)
 *   length    past 45 s, -(s - 45) / 15, at most -2
 *
 * Clamped to 0-10. Every component is named with its points, so the director can say why.
 */
export function cloneabilityOf(input: { footage: FootageRead; duration: number; cuts: number; speech: boolean }): Cloneability {
  const { footage, duration } = input;
  const parts: Part[] = [];
  const add = (name: CloneComponent, points: number, signal: string) => parts.push({ name, points: round(points, 2), signal });

  const people = footage.people;
  if (people === 1) add("people", 2.5, "one person on camera");
  else if (people <= 0) add("people", 1.5, "nobody on camera: screens, text or product");
  else if (people === 2) add("people", 0.5, "two people on camera (the clone performs one)");
  else add("people", 0, `${people} people on camera (the clone performs one)`);

  if (people > 0) {
    const share = clamp(footage.face_to_camera, 0, 1);
    add("face", 2 * share, `face and mouth to camera ${Math.round(share * 100)}% of the time`);
  } else {
    add("face", 0, "no face to camera");
  }

  const perTen = duration > 0 ? (input.cuts / duration) * 10 : 0;
  const takes = 1.5 * clamp((6 - perTen) / 4, 0, 1);
  add("takes", takes, `${perTen.toFixed(1)} cuts per 10 s${perTen <= 2 ? ": long continuous takes" : perTen >= 6 ? ": rapid jump cuts" : ""}`);

  add("camera", { static: 1, handheld: 0.5, moving: 0 }[footage.camera], { static: "propped-up phone or tripod", handheld: "handheld camera", moving: "moving camera (walking, panning)" }[footage.camera]);
  add("set", { plain: 1, green_screen: 1, location: 0.3, crowd: 0 }[footage.set], { plain: "plain set", green_screen: "green screen", location: "a real location", crowd: "other people in the background" }[footage.set]);

  const spoken = footage.audio === "speech" || footage.audio === "voiceover" || footage.audio === "dialogue";
  const audio = spoken && !input.speech ? "music_only" : footage.audio;
  add(
    "audio",
    { speech: 1.5, voiceover: 1, music_only: 0.5, none: 0.5, dialogue: 0, song: 0 }[audio],
    {
      speech: "one voice talking: re-voiced line for line",
      voiceover: "a voice-over",
      music_only: "music only, no speech",
      none: "no sound",
      dialogue: "people talking to each other",
      song: "a song or lyrics carry it",
    }[audio],
  );
  add("script", footage.script === "template" ? 0.5 : 0, footage.script === "template" ? "a template script: hook, claim, ask" : "the script is tied to a specific event or person");

  if (footage.product === "close_up") add("product", -1.5, "hands using the product in close-up");
  else if (footage.product === "brief") add("product", -0.5, "the product held up briefly");
  if (footage.overlays === "baked") add("overlays", -1, "text or graphics baked into the footage");
  const length = lengthPart(duration);
  if (length) parts.push(length);
  return finish("breakdown", parts);
}

/** The JSON Schema of the breakdown tool's `clone` block: what the vision model records about the footage. */
export const CLONE_SCHEMA = {
  type: "object",
  required: ["people", "face_to_camera", "camera", "set", "product", "overlays", "audio", "script", "hardest"],
  description:
    "What the footage is made of, for the team's footage clone: a lookalike AI presenter performs the original's exact motion (it needs one person, in continuous takes), the original audio is re-voiced, and graphics and captions are replaced in place. Judge from the frames and the transcript.",
  properties: {
    people: { type: "integer", minimum: 0, description: "How many different people appear on camera over the whole video. The same person in two outfits or roles counts once; passers-by in the background do not count (see set). 0 if nobody appears." },
    face_to_camera: { type: "number", minimum: 0, maximum: 1, description: "The share of the video (0-1) in which a face and mouth are clearly visible and talking or reacting to the lens. Screens, B-roll, text, profiles and backs of heads do not count." },
    camera: { type: "string", enum: ["static", "handheld", "moving"], description: "static: a propped-up phone, tripod or locked-off shot; handheld: held, with small sway; moving: walking, panning or following action." },
    set: { type: "string", enum: ["plain", "green_screen", "location", "crowd"], description: "plain: a room, desk, car seat or wall; green_screen: a person over a keyed picture or screenshot; location: a real recognisable place (a store, gym, street, venue); crowd: other people around them." },
    product: { type: "string", enum: ["none", "brief", "close_up"], description: "none: no physical product handled; brief: held up or shown for a moment; close_up: hands using it in close-up for several seconds (opening, pouring, applying, assembling)." },
    overlays: { type: "string", enum: ["none", "separable", "baked"], description: "none; separable: captions, text boxes, stickers or screenshots laid flat over the footage; baked: text or graphics tracked to objects, behind the person, or drawn into the footage." },
    audio: { type: "string", enum: ["speech", "voiceover", "music_only", "dialogue", "song", "none"], description: "What carries the sound: speech (one person talking, maybe over quiet music), voiceover (a narrator over footage), music_only, dialogue (two or more people talking to each other), song (lyrics or a lip-sync carry it), none." },
    script: { type: "string", enum: ["template", "tied"], description: "template: a hook, claim and ask that would carry another product (a review, tips, 'I tried', a POV, a rant, a story about a problem); tied: depends on a specific news event, a real named person, a place, a trend sound or an earlier video." },
    hardest: { type: "string", description: "One sentence: the hardest thing for one AI presenter copying the original's motion to reproduce, or 'nothing hard' for one person talking to a static camera." },
  },
} as const;

const CAMERAS: FootageRead["camera"][] = ["static", "handheld", "moving"];
const SETS: FootageRead["set"][] = ["plain", "green_screen", "location", "crowd"];
const PRODUCTS: FootageRead["product"][] = ["none", "brief", "close_up"];
const OVERLAYS: FootageRead["overlays"][] = ["none", "separable", "baked"];
const AUDIO: FootageRead["audio"][] = ["speech", "voiceover", "music_only", "dialogue", "song", "none"];

/**
 * The model's `clone` block, made safe: counts and shares clamped, unknown words mapped to the middle
 * of each scale. A missing face share comes from the beats (talking-head and reaction time). No
 * block at all is undefined: the candidate keeps its metadata prior.
 */
export function readFootage(raw: unknown, beats: Pick<ReferenceBeat, "start" | "end" | "shot">[]): FootageRead | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const clone = raw as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: T[], fallback: T): T => (allowed as string[]).includes(String(value)) ? (value as T) : fallback;
  const people = Number(clone.people);
  const share = Number(clone.face_to_camera);
  const faces = faceShare(beats);
  return {
    people: Number.isFinite(people) ? clamp(Math.round(people), 0, 20) : faces > 0 ? 1 : 0,
    face_to_camera: Number.isFinite(share) ? clamp(share, 0, 1) : faces,
    camera: pick(clone.camera, CAMERAS, "handheld"),
    set: pick(clone.set, SETS, "plain"),
    product: pick(clone.product, PRODUCTS, "none"),
    overlays: pick(clone.overlays, OVERLAYS, "separable"),
    audio: pick(clone.audio, AUDIO, "speech"),
    script: pick(clone.script, ["template", "tied"], "template"),
    hardest: typeof clone.hardest === "string" ? clone.hardest.trim().slice(0, 240) : "",
  };
}

/** The share of the video on a face: talking-head and reaction beats in full, a split screen at half. */
export function faceShare(beats: Pick<ReferenceBeat, "start" | "end" | "shot">[]): number {
  const total = beats.reduce((sum, beat) => sum + Math.max(0, beat.end - beat.start), 0);
  if (!(total > 0)) return 0;
  const face = beats.reduce((sum, beat) => sum + Math.max(0, beat.end - beat.start) * (beat.shot === "talking_head" || beat.shot === "reaction" ? 1 : beat.shot === "split" ? 0.5 : 0), 0);
  return round(face / total, 2);
}

// ---------- picking and showing ----------

/** A candidate's cloneability: the breakdown's or the scored prior, else (scored before cloneability) the prior from its caption and length. */
export function cloneOf(candidate: Pick<Video, "caption" | "duration"> & { score: { cloneability?: Cloneability } }): number {
  return candidate.score.cloneability?.score ?? cloneabilityPrior(candidate).score;
}

/** At or above the gate: the clone can reproduce it. */
export function cloneable(candidate: Parameters<typeof cloneOf>[0]): boolean {
  return cloneOf(candidate) >= CLONE_GATE;
}

/** Each part as a person reads it: "one person on camera +2.5". */
export function cloneSignals(clone: Cloneability): string[] {
  return clone.parts.map((part) => (part.name === "base" ? part.signal : `${part.signal} ${signed(part.points)}`));
}

/** One line for an agent's prompt: "8.5/10 from its frames: one person on camera +2.5, ...". */
export function cloneLine(clone: Cloneability): string {
  return `${clone.score}/10 ${clone.basis === "metadata" ? "guessed from the caption and length" : "from its frames"}: ${cloneSignals(clone).join(", ")}`;
}

function lengthPart(duration: number | null): Part | null {
  if (duration === null || !Number.isFinite(duration) || duration <= SHORT_SECONDS) return null;
  return { name: "length", points: -round(Math.min(2, (duration - SHORT_SECONDS) / 15), 2), signal: `${Math.round(duration)} s: past 45 s, every take is more to clone` };
}

function finish(basis: Cloneability["basis"], parts: Part[]): Cloneability {
  const total = parts.reduce((sum, part) => sum + part.points, 0);
  return { score: round(clamp(total, 0, 10), 1), basis, parts };
}

function signed(points: number) {
  const value = round(points, 1);
  return value < 0 ? `${value}` : `+${value}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
