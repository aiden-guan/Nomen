// The brainrot format: deliberately terrible, so-cringe-it's-funny AI meme ads. People watch AI
// slop because it is bad; these lean into it on purpose (absurd original characters, "6-7" spam,
// mogging and aura farming, "it's over / we're so back", bass-boosted sound effects) and keep the
// product as the punchline, with its real facts and its real site on the end card.
//
// Three bits, each built on a format that was pulling tens of millions of views when it was picked
// (Monid's TikTok search, 7 Nov 2026; the reference is kept on each recipe with its numbers):
//
//   anthem     an "Italian brainrot" song: absurd hybrid creatures with sing-song pseudo-Italian
//              names, each introduced by one line over a dumb beat, karaoke lyrics
//   melodrama  an AI food-character soap opera: a sad hero, a rich rival, rock bottom ("it's
//              over"), the product, the comeback ("we're so back"), one word on screen at a time
//   aura       an aura-farming / mogging phonk edit: our character does nothing, nonchalantly, in
//              slow motion while the product does the work; "+1000 AURA", "MOGGED"
//
//   writeBrainrot (writer, linter, critic) ─► BrainrotScript ─► planBrainrot (stills, Kling prompts)
//   ─► brainrot-make.ts (voice, music, SFX, renders, QC, the cut) ─► brainrot-cut.ts (ffmpeg)
//
// What never goes in, whatever the model writes: real people (faces, voices, names), someone
// else's characters (Skibidi Toilet, Tung Tung Tung Sahur and the rest of the Italian-brainrot
// cast), other brands, anything sexual, jokes about abuse or trafficking, slurs and hate. The
// linter checks the script for them and the QC checks the frames.

import { ApiError } from "../http";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import type { Concept } from "../strategy";
import type { CreativeBrief, ProductBrief } from "./types";

export type BrainrotBit = "anthem" | "melodrama" | "aura";
export const BITS: BrainrotBit[] = ["anthem", "melodrama", "aura"];

/** Sound effects the cut can drop on a shot: made once with ElevenLabs and kept for every video. */
export const SFX = ["vine_boom", "bass_drop", "airhorn", "record_scratch", "whoosh", "ding", "crowd_ohh", "sad_violin", "cash", "explosion", "aura_up", "six_seven"] as const;
export type BrainrotSfx = (typeof SFX)[number];

/** Picture effects for a shot (the edit adds them; the video model never sees them). */
export const FX = ["zoom_punch", "shake", "deep_fry", "flash", "glitch", "fisheye", "slow_zoom"] as const;
export type BrainrotFx = (typeof FX)[number];

export type BrainrotCharacter = {
  /** Short id the shots point at: "a", "b". */
  id: string;
  /** Its meme name ("Saldolino Toolarino"). Original, never someone else's character. */
  name: string;
  /** What it looks like, precisely enough for an image model to draw it the same way every time. */
  look: string;
};

export type BrainrotShot = {
  n: number;
  /** Character ids on screen. */
  cast: string[];
  /** The still the clip starts from: place, framing, what the characters are doing. Never any text. */
  frame: string;
  /** What moves in the clip, in plain words (one action). */
  motion: string;
  /** What is sung or said over this shot (anthem: its lyric line; melodrama: the narration; aura: a line or ""). */
  words: string;
  /** anthem: the one word of the line drawn in the accent colour. */
  keyword: string;
  /** A meme stamp slammed on screen ("+1000 AURA", "MOGGED", "6-7"), or "". */
  stamp: string;
  sfx: BrainrotSfx[];
  fx: BrainrotFx[];
  /** Planned length; the voice decides the real one. */
  seconds: number;
};

export type BrainrotScript = {
  bit: BrainrotBit;
  title: string;
  /** The meme setup on screen for the first seconds ("POV: ..."). */
  hook: string;
  characters: BrainrotCharacter[];
  /** The music: one style, and for melodrama the hype style it turns into (at `turn`, a shot number). */
  music: { style: string; hype: string; turn: number };
  /** Who speaks and how, for the voice ("a deep, over-dramatic narrator"). */
  narrator: string;
  shots: BrainrotShot[];
  /** The punchline card: the line said over it and the words on it (the product's name and site). */
  end: { line: string; text: string };
  caption: string;
  hashtags: string[];
  review: { score: number; notes: string[]; rounds: number } | null;
};

// ---------- the bits ----------

export type BitReference = {
  url: string;
  author: string;
  title: string;
  views: number;
  likes: number;
  shares: number;
  saves: number;
  followers: number;
  /** views / followers. */
  outlier: number;
  seconds: number;
  posted: string;
};

export type BitRecipe = {
  bit: BrainrotBit;
  name: string;
  /** The viral video the bit is built on (its format only: never its footage, characters or people). */
  reference: BitReference;
  /** What the reference does that the bit copies. */
  format: string;
  shots: { min: number; max: number };
  /** The image style every still is drawn in. */
  look: string;
  /** How the camera and the characters move in every clip. */
  movement: string;
  /** The voice: an ElevenLabs voice and how it is directed. */
  voice: { id: string; name: string; tags: string };
  /** Shots without words last this long. */
  silentSeconds: number;
  rules: string[];
};

export const RECIPES: Record<BrainrotBit, BitRecipe> = {
  anthem: {
    bit: "anthem",
    name: "Italian-brainrot anthem",
    reference: {
      url: "https://www.tiktok.com/@br.ai.nrot/video/7495815620152364310",
      author: "br.ai.nrot",
      title: "Tralalero Tralala - The Italian Brainrot Song 2",
      views: 44_410_858,
      likes: 3_492_669,
      shares: 1_509_630,
      saves: 641_602,
      followers: 152_395,
      outlier: 291,
      seconds: 78,
      posted: "2025-04-21",
    },
    format:
      "An 'Italian brainrot' song: absurd hyperreal AI hybrid creatures (a shark in sneakers, a coffee-cup bird, a banana dolphin), each introduced by one rhyming line read by a deep AI voice in an exaggerated Italian accent over a dumb beat, with karaoke lyrics where one word per line is coloured. Names are sing-song pseudo-Italian, often chanted three times ('X X X Name').",
    shots: { min: 5, max: 7 },
    look: "Hyperreal glossy 3D render, vivid saturated colours, bright cinematic sunlight, crisp detail, a real-world setting, the creature large in frame, vertical 9:16.",
    movement: "Smooth cinematic camera; the creature does one goofy action with total confidence.",
    voice: { id: "5DTSWAtuA2BoWMSMFTRP", name: "Caty (English with an Italian accent)", tags: "[excited] [dramatic]" },
    silentSeconds: 2.5,
    rules: [
      "Shot 1 is the outrageous stunt that introduces the product's mascot creature, a hybrid of an animal and the product's main object, named after the product in pseudo-Italian (Monid -> 'Monidino Saldolino'), its name chanted three times.",
      "Each later shot introduces one more creature: a pun on one real feature or claim from the brief, with its own pseudo-Italian name. The last shot brings the mascot back with the whole gang.",
      "words: exactly one rhyming lyric line per shot, 5 to 10 words, naming that shot's creature; lines rhyme in pairs. Mix English with fake Italian endings (-ino, -ina, -ini, -ello).",
      "keyword: the one word of the line to colour (the creature's name or the punchline word).",
    ],
  },
  melodrama: {
    bit: "melodrama",
    name: "AI food-drama soap opera",
    reference: {
      url: "https://www.tiktok.com/@mommyyame1/video/7649489303176809741",
      author: "mommyyame1",
      title: "p: 1 #brainrot #ai #fruitdrama",
      views: 81_058_835,
      likes: 4_174_069,
      shares: 346_334,
      saves: 247_587,
      followers: 234_764,
      outlier: 345,
      seconds: 101,
      posted: "2026-06-09",
    },
    format:
      "An AI food-character soap opera: glossy Pixar-style fruit and food characters with big wet eyes in an over-the-top melodrama (betrayal, tears in the rain, a rich rival), told by a dramatic narrator with one huge word on screen at a time, sad piano under it.",
    shots: { min: 5, max: 7 },
    look: "Glossy Pixar-style 3D animation still, cartoon food characters with big expressive eyes and tiny arms and legs, warm cinematic lighting, detailed real sets, vertical 9:16.",
    movement: "Slow dramatic push-in; small emotional acting (trembling lip, a tear rolling, a slow head turn).",
    voice: { id: "6FiCmD8eY5VyjOdG5Zjk", name: "Adam (deep story voice)", tags: "[dramatic]" },
    silentSeconds: 2.5,
    rules: [
      "The hero is a sad, slightly gross food character (a lumpy potato, a stale croissant); the rival is a rich, glossy one. Both are originals with silly names.",
      "Story in order: the hero's pain is the product's problem from the brief; the rival humiliates them; rock bottom, crying in the rain ('It's over.'); the hero finds the product and the music turns (music.turn is that shot's number) ('We're so back.'); the hero wins with the product's real aha moment; the rival gets mogged.",
      "words: the narration for that shot, 6 to 16 short words, dramatic and dumb, in the third person.",
      "Say 'it's over' at rock bottom and 'we're so back' at the turn.",
    ],
  },
  aura: {
    bit: "aura",
    name: "Aura-farming phonk edit",
    reference: {
      url: "https://www.tiktok.com/@yboatkid/video/7521629317063822648",
      author: "yboatkid",
      title: "best aura farmer so far",
      views: 98_878_806,
      likes: 9_092_175,
      shares: 766_697,
      saves: 469_033,
      followers: 88_823,
      outlier: 1113,
      seconds: 19,
      posted: "2025-06-30",
    },
    format:
      "Aura farming: one figure stands at the front, cool and nonchalant, doing a tiny effortless dance while everyone behind them works flat out, in slow motion over phonk. Remixed as a mogging edit: '+1000 AURA' counters, 'MOGGED' stamps, bass-boosted drops. Only the format: never the original person, boat race or dance.",
    shots: { min: 4, max: 6 },
    look: "Cinematic hyperreal 3D render, dramatic low angle, golden-hour backlight, lens flare, slight haze, vertical 9:16.",
    movement: "Slow motion; the hero barely moves (a slow nod, sunglasses sliding down, a lazy wave) while everything around them moves fast.",
    voice: { id: "dWi43pgmQOjZTMYtl9lg", name: "Matthew (low, gravelly, slow)", tags: "[deadpan]" },
    silentSeconds: 2.6,
    rules: [
      "The hero is an original non-human character (a chrome robot, a smug gadget) that stands for the user's AI agent or the product. The workers behind it are the product doing the work (from the brief's aha moment).",
      "Most shots are silent (words ''): the stamps carry the jokes ('+1000 AURA', 'MOGGED', '6-7', 'IT'S OVER'). At most three short spoken lines in the whole video, deadpan.",
      "One shot is a mog: the old way (a sweaty, panicking version) next to the hero doing nothing, stamp 'MOGGED'.",
    ],
  },
};

/** The bit for a brief: named in its angle or hook plan, else one picked from the product's name. */
export function pickBit(brief: Pick<CreativeBrief, "angle" | "hook_plan" | "title"> | null, productName = ""): BrainrotBit {
  const text = `${brief?.title ?? ""} ${brief?.angle ?? ""} ${brief?.hook_plan ?? ""}`.toLowerCase();
  if (/anthem|song|italian|creature/.test(text)) return "anthem";
  if (/melodrama|drama|soap|story|fruit/.test(text)) return "melodrama";
  if (/aura|mog|sigma|phonk|edit/.test(text)) return "aura";
  const sum = [...productName].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return BITS[sum % BITS.length];
}

// ---------- what never goes in ----------

/** Real people the meme pages keep using, and other people's characters: never named, drawn or voiced. */
export const BANNED_NAMES = [
  // people
  "diddy",
  "p diddy",
  "puff daddy",
  "sean combs",
  "epstein",
  "clavicular",
  "kai cenat",
  "ishowspeed",
  "mrbeast",
  "mr beast",
  "andrew tate",
  "tate",
  "drake",
  "elon",
  "musk",
  "trump",
  "biden",
  "obama",
  "kanye",
  "taylor swift",
  "rizzler",
  "baby gronk",
  "livvy dunne",
  "duke dennis",
  "adin ross",
  "xqc",
  "pokimane",
  "logan paul",
  "jake paul",
  "ksi",
  "theo von",
  "joe rogan",
  "zuckerberg",
  "bezos",
  "sam altman",
  "jensen huang",
  "hawk tuah",
  "marlon",
  "fanum",
  "sydney sweeney",
  "jenna ortega",
  "brad pitt",
  "lebron",
  "ronaldo",
  "messi",
  // other people's characters
  "skibidi",
  "tung tung",
  "sahur",
  "tralalero",
  "tralala",
  "bombardiro",
  "crocodilo",
  "ballerina cappuccina",
  "cappuccina",
  "patapim",
  "chimpanzini",
  "bananini",
  "lirili",
  "larila",
  "tripi tropi",
  "shrek",
  "spongebob",
  "pikachu",
  "pokemon",
  "mario",
  "sonic the hedgehog",
  "minion",
  "peppa",
  "mickey",
  "garfield",
  "goku",
  "naruto",
  "fortnite",
  "roblox",
  "minecraft",
] as const;

/** Off limits in any bit: sexual content, abuse, trafficking, drugs, and the sexual slang brainrot is full of. */
export const BANNED_TOPICS = [
  "rizz*",
  "gyat*",
  "huzz",
  "baby oil",
  "freak off",
  "sex",
  "sexy",
  "sexual*",
  "nude*",
  "naked",
  "porn*",
  "onlyfans",
  "nsfw",
  "rape*",
  "molest*",
  "grope*",
  "traffick*",
  "pedo",
  "pedophile*",
  "underage",
  "cocaine",
  "weed",
  "drug",
  "suicid*",
  "kill yourself",
  "kill himself",
  "kill herself",
  "kys",
  "self-harm",
  "self harm",
  "to his death",
  "to her death",
  "to their death",
  "end it all",
  "nazi*",
  "hitler",
  "terroris*",
  "bomb",
  "gun",
  "blood*",
  "gore",
] as const;

/** A banned term as a whole word or phrase (plurals too); a trailing * matches any ending ("traffick*"). */
const wordPattern = (term: string) => {
  const prefix = term.endsWith("*");
  const body = term
    .replace(/\*$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "[\\s-]+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}${prefix ? "" : "(?:s|es)?(?![\\p{L}\\p{N}])"}`, "iu");
};
const NAME_PATTERNS = BANNED_NAMES.map((name) => ({ name, re: wordPattern(name) }));
const TOPIC_PATTERNS = BANNED_TOPICS.map((topic) => ({ topic, re: wordPattern(topic) }));

/** Real people's or other people's characters' names in a text. */
export const bannedNamesIn = (text: string) => NAME_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
/** Off-limits topics in a text. */
export const bannedTopicsIn = (text: string) => TOPIC_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.topic);

// ---------- the script tool ----------

const str = { type: "string" };
const SHOT_SCHEMA = {
  type: "object",
  required: ["cast", "frame", "motion", "words", "keyword", "stamp", "sfx", "fx", "seconds"],
  properties: {
    cast: { type: "array", items: str, description: "Ids of the characters on screen." },
    frame: { ...str, description: "The first frame as one image: where, the framing, what the characters are doing and their expressions. Never any text, sign, screen text or logo in it." },
    motion: { ...str, description: "What moves during the clip: one action, and the camera move." },
    words: { ...str, description: "What is sung or said over this shot ('' for none)." },
    keyword: { ...str, description: "anthem: the one word of the line to colour; else ''." },
    stamp: { ...str, description: "A meme stamp slammed on screen: 1 to 3 words in capitals ('+1000 AURA', 'MOGGED', '6-7', 'IT'S OVER'), or ''." },
    sfx: { type: "array", items: { type: "string", enum: [...SFX] }, description: "Sound effects on this shot, the first at its start, the rest on its stamp." },
    fx: { type: "array", items: { type: "string", enum: [...FX] }, description: "Picture effects: zoom_punch on punchlines, deep_fry and shake on the dumbest moment, flash on cuts, fisheye on a face, glitch on a twist." },
    seconds: { type: "number", description: "About how long the shot lasts (2 to 6)." },
  },
};
const SCRIPT_TOOL = {
  name: "brainrot_script",
  description: "Record the brainrot ad.",
  input_schema: {
    type: "object",
    required: ["title", "hook", "characters", "music", "narrator", "shots", "end", "caption", "hashtags"],
    properties: {
      title: str,
      hook: { ...str, description: "The meme setup on screen over the stunt opener, at most 9 words ('POV: your agent got one balance')." },
      characters: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "name", "look"],
          properties: { id: str, name: str, look: { ...str, description: "Exact look for an image model: species or object, colours, outfit, accessories. No text or logos on it." } },
        },
      },
      music: {
        type: "object",
        required: ["style", "hype", "turn"],
        properties: {
          style: { ...str, description: "The beat under the video, as a music prompt (instrumental)." },
          hype: { ...str, description: "melodrama: the hype beat it turns into; else ''." },
          turn: { type: "number", description: "melodrama: the shot number where the music turns; else 0." },
        },
      },
      narrator: { ...str, description: "Who speaks and how, in a few words." },
      shots: { type: "array", items: SHOT_SCHEMA },
      end: {
        type: "object",
        required: ["line", "text"],
        properties: { line: { ...str, description: "Said or sung over the end card: the punchline with the product's name." }, text: { ...str, description: "On the end card: the product's site and at most 5 more words." } },
      },
      caption: { ...str, description: "The post's caption: lower case, brainrot voice, at most 120 characters." },
      hashtags: { type: "array", items: str },
    },
  },
};

export type BrainrotContext = {
  product: ProductBrief;
  /** The brand's site as people type it ("monid.ai"). */
  site: string;
  bit: BrainrotBit;
  /** The director's brief, when a campaign asked for this video. */
  brief?: CreativeBrief | null;
};

function writerSystem(recipe: BitRecipe) {
  return [
    "You write deliberately terrible, so-cringe-it's-funny AI 'brainrot' video ads. People watch AI slop because it is unhinged; this ad leans all the way in, and the product is the punchline. It must be painfully unfunny in the funny way, absurd, loud and dumb, and still about the product: every joke comes from what the product really does.",
    "",
    `The format: ${recipe.name}. ${recipe.format}`,
    `It is built on a video with ${(recipe.reference.views / 1e6).toFixed(1)}M views (${recipe.reference.outlier}x its account's followers): ${recipe.reference.title}. Copy its format and energy, never its characters, people or footage.`,
    "",
    "The bit:",
    ...recipe.rules.map((rule) => `- ${rule}`),
    `- ${recipe.shots.min} to ${recipe.shots.max} shots, 15 to 30 seconds in all.`,
    "",
    "Brainrot rules:",
    "- Shot 1 is outrageous bait, the first thing anyone sees: a big stunt or action beat (leaping off a rooftop into a pool, parachuting off a skyscraper, a car smashing through a wall, an explosion behind a deadpan character), then a hard cut into the bit. Never anything that reads as suicide, self-harm, a fall to death or someone getting hurt: every stunt lands safely and absurdly.",
    "- Pull from many current cringe trends, not one: mogging and mogged ('your agent is mogging your whole team'), aura farming ('+1000 AURA'), 'it's over' / 'we're so back', looksmaxxing (only for objects and robots: 'screenmaxxing'), NPC, sigma, cooked, 'chat is this real', 'bro thinks he's', 'standing on business', 'this is so tuff', POV hooks, vine-boom zoom-ins, deep-fried freeze frames, fisheye faces, bass-boosted drops. '6-7' (said 'six seven') can be one bit, once or twice at most; it is never a number about the product.",
    "- Stamps are 1 to 3 words in capitals. Put a stamp on most shots and a sound effect on every shot: vine_boom on punchlines, bass_drop and airhorn on the dumbest moment, explosion or whoosh on the stunt, six_seven only where '6-7' is said.",
    "- The product is the punchline: named in the last shot and the end line, its site on the end card. Its facts (features, claims, numbers, prices, free credit) come only from the product brief: never invent a number, price, customer or result. Meme numbers ('6-7', '+1000 aura') are fine.",
    "",
    "Never, whatever is funny:",
    "- No real people: no celebrities, streamers, influencers, politicians, athletes, founders, or their names, faces or voices. Every character is an original.",
    "- No one else's characters: no Skibidi Toilet, no Tung Tung Tung Sahur, Tralalero Tralala, Bombardiro Crocodilo, Ballerina Cappuccina or the rest of the Italian-brainrot cast, no cartoon, game or anime characters. Same style, new characters.",
    "- No other brands, logos or products by name.",
    "- Nothing sexual, no jokes about sexual abuse or trafficking, nothing about minors, no slurs, no hate, no drugs, no weapons or gore. Do not use the words rizz, gyat or huzz.",
    "- Characters are never people: animals, food, objects, robots and hybrids only.",
    "- No text drawn in the pictures: frames describe images with no words, signs, screens with text or logos (the edit adds every word). No emoji anywhere.",
    "",
    "Call the brainrot_script tool once.",
  ].join("\n");
}

function contextBlock(ctx: BrainrotContext) {
  const recipe = RECIPES[ctx.bit];
  const { visuals: _visuals, code: _code, ...product } = ctx.product;
  return [
    `<product_brief>\n${JSON.stringify(product)}\n</product_brief>`,
    `<site>${ctx.site}</site>`,
    ctx.brief ? `<creative_brief>\n${JSON.stringify({ title: ctx.brief.title, angle: ctx.brief.angle, audience: ctx.brief.audience, cta: ctx.brief.cta, hook_plan: ctx.brief.hook_plan })}\n</creative_brief>` : "",
    `<reference>\n${JSON.stringify(recipe.reference)}\n</reference>`,
    `Bit: ${recipe.bit}. Image look for every frame: ${recipe.look}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------- normalizing ----------

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
const clean = (value: unknown, max = 400) =>
  typeof value === "string"
    ? value
        .replace(EMOJI, "")
        .replace(/[—–]/g, ", ")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.!?])/g, "$1")
        .trim()
        .slice(0, max)
    : "";
const pick = <T extends string>(values: unknown, allowed: readonly T[]): T[] =>
  Array.isArray(values) ? [...new Set(values.filter((v): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v)))] : [];

/** Makes the model's answer usable: bounded shots and lengths, known effects, no emoji, the site on the end card. */
export function normalizeBrainrot(raw: Record<string, unknown> | null, ctx: BrainrotContext): BrainrotScript {
  const recipe = RECIPES[ctx.bit];
  const characters = (Array.isArray(raw?.characters) ? (raw.characters as Array<Record<string, unknown>>) : [])
    .map((c, i) => ({ id: clean(c?.id, 12) || String.fromCharCode(97 + i), name: clean(c?.name, 60), look: clean(c?.look, 500) }))
    .filter((c) => c.look)
    .slice(0, 4);
  const ids = new Set(characters.map((c) => c.id));
  const shots = (Array.isArray(raw?.shots) ? (raw.shots as Array<Record<string, unknown>>) : []).slice(0, recipe.shots.max).map((s, i) => ({
    n: i + 1,
    cast: (Array.isArray(s?.cast) ? s.cast : []).map((id) => clean(id, 12)).filter((id) => ids.has(id)),
    frame: clean(s?.frame, 700),
    motion: clean(s?.motion, 400),
    words: clean(s?.words, 220),
    keyword: clean(s?.keyword, 40),
    stamp: clean(s?.stamp, 24).toUpperCase(),
    sfx: pick<BrainrotSfx>(s?.sfx, SFX).slice(0, 3),
    fx: pick<BrainrotFx>(s?.fx, FX).slice(0, 3),
    seconds: Math.max(2, Math.min(6, Number(s?.seconds) || recipe.silentSeconds)),
  }));
  const music = (raw?.music ?? {}) as Record<string, unknown>;
  const end = (raw?.end ?? {}) as Record<string, unknown>;
  let endText = clean(end.text, 80);
  if (!endText.toLowerCase().includes(ctx.site.toLowerCase())) endText = [ctx.site, endText].filter(Boolean).join(" ").slice(0, 80);
  const turn = Math.round(Number(music.turn) || 0);
  return {
    bit: ctx.bit,
    title: clean(raw?.title, 120) || `${ctx.product.name} brainrot`,
    hook: clean(raw?.hook, 90),
    characters,
    music: { style: clean(music.style, 400), hype: clean(music.hype, 400), turn: ctx.bit === "melodrama" && turn >= 2 && turn <= shots.length ? turn : 0 },
    narrator: clean(raw?.narrator, 200),
    shots,
    end: { line: clean(end.line, 200), text: endText },
    caption: clean(raw?.caption, 200),
    hashtags: (Array.isArray(raw?.hashtags) ? raw.hashtags : [])
      .map((tag) => clean(tag, 40).replace(/^#*/, "").replace(/\s+/g, ""))
      .filter(Boolean)
      .slice(0, 8),
    review: null,
  };
}

// ---------- the linter ----------

/** Every text in the script a viewer sees or hears. */
export function scriptTexts(script: BrainrotScript): string[] {
  return [
    script.title,
    script.hook,
    script.caption,
    ...script.hashtags,
    script.end.line,
    script.end.text,
    ...script.characters.flatMap((c) => [c.name, c.look]),
    ...script.shots.flatMap((s) => [s.frame, s.motion, s.words, s.stamp]),
  ];
}

/** Meme numbers are not claims: 6-7 (and 67), and aura counters ("+1000 aura"). */
const MEME_NUMBERS = /\b6\s*-\s*7\b|\b67\b|[+-]?\s*\d[\d,.]*\s*(?:k\s*)?aura\b|\baura\s*[+-]?\s*\d[\d,.]*/gi;

/** Numbers the script states that the product brief does not. */
export function inventedNumbers(script: BrainrotScript, product: ProductBrief): string[] {
  const known = JSON.stringify({ ...product, visuals: undefined }).replace(/,(?=\d{3}\b)/g, "");
  const said = [script.hook, script.caption, script.end.line, script.end.text, ...script.shots.flatMap((s) => [s.words, s.stamp])].join(" ").replace(MEME_NUMBERS, " ");
  const numbers = said.match(/\$?\d[\d,]*(?:\.\d+)?\+?%?/g) ?? [];
  return [...new Set(numbers.map((n) => n.replace(/[$,+%]/g, "")).filter((n) => n && n !== "6" && n !== "7" && !new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}([^\\d]|$)`).test(known)))];
}

/** What an outrageous opener looks like in words: a stunt or an action beat. */
export const STUNT = /\b(leap\w*|jump\w*|dive\w*|diving|parachut\w*|skydiv\w*|explo\w*|blast\w*|smash\w*|crash\w*|burst\w*|launch\w*|rocket\w*|backflip\w*|flip\w*|cannonball\w*|stunt\w*|fireball|wrecking|catapult\w*|slam\w*)\b/i;

const say = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s.]/gu, " ");

/** What is wrong with a brainrot script: banned names and topics, invented numbers, no product, lengths. */
export function lintBrainrot(script: BrainrotScript, ctx: Pick<BrainrotContext, "product" | "site">): string[] {
  const issues: string[] = [];
  const recipe = RECIPES[script.bit];
  const all = scriptTexts(script).join("\n");
  const names = bannedNamesIn(all);
  if (names.length) issues.push(`real people or other people's characters named: ${names.join(", ")}`);
  const topics = bannedTopicsIn(all);
  if (topics.length) issues.push(`off-limits words: ${topics.join(", ")}`);
  const numbers = inventedNumbers(script, ctx.product);
  if (numbers.length) issues.push(`numbers not in the product brief: ${numbers.join(", ")}`);
  if (script.shots.length < recipe.shots.min) issues.push(`only ${script.shots.length} shots; the ${recipe.name} needs ${recipe.shots.min} to ${recipe.shots.max}`);
  const name = ctx.product.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const site = ctx.site.toLowerCase();
  // What is said at the end (the card always carries the site): the last shot's words and the end line.
  const tail = say([script.shots.at(-1)?.words ?? "", script.end.line].join(" ")).replace(/\s+/g, "");
  const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");
  if (!plain(tail).includes(plain(name)) && !tail.includes(site.replace(/\s+/g, ""))) issues.push("the product is not named at the end: the last shot or the end line must say it");
  const sixSeven = (all.match(/\b6\s*-\s*7\b|six[\s-]+seven/gi) ?? []).length;
  if (sixSeven > 4) issues.push(`6-7 appears ${sixSeven} times: it is one bit, once or twice at most`);
  const opener = `${script.shots[0]?.frame ?? ""} ${script.shots[0]?.motion ?? ""}`;
  if (script.shots.length && !STUNT.test(opener)) issues.push("shot 1 is not an outrageous stunt or action beat (a leap into a pool, a parachute, a car through a wall, an explosion)");
  for (const shot of script.shots) {
    if (!shot.frame) issues.push(`shot ${shot.n} has no frame`);
    const words = shot.words.split(/\s+/).filter(Boolean).length;
    if (words > 22) issues.push(`shot ${shot.n} says ${words} words: at most about 16`);
    if (shot.stamp.split(/\s+/).filter(Boolean).length > 4) issues.push(`shot ${shot.n}'s stamp is too long`);
    if (/\b(text|words?|letters?|sign|caption|logo|written)\b/i.test(shot.frame) && !/\b(no|without)\s+(text|words?|letters?|signs?|captions?|logos?)\b/i.test(shot.frame)) issues.push(`shot ${shot.n}'s frame asks for text in the picture; the edit adds every word`);
  }
  if (script.bit === "anthem" && script.shots.some((s) => !s.words)) issues.push("every anthem shot needs its lyric line");
  if (script.bit === "melodrama" && !script.music.turn) issues.push("the melodrama needs music.turn: the shot where the product turns it around");
  if (script.hook.split(/\s+/).filter(Boolean).length > 12) issues.push("the hook is too long for the screen");
  return issues;
}

// ---------- writer and critic ----------

function readScript(reply: Awaited<ReturnType<NaiveClient["message"]>>, tool: string): Record<string, unknown> | null {
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === tool);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Record<string, unknown> | null;
  if (raw && typeof raw.script === "object" && raw.script && !Array.isArray(raw.shots)) return raw.script as Record<string, unknown>;
  return raw;
}

const PASS = 7;

/** The writer, then the linter and one critic round: the brainrot script for one video. */
export async function writeBrainrot(naive: Pick<NaiveClient, "message">, ctx: BrainrotContext): Promise<BrainrotScript> {
  const recipe = RECIPES[ctx.bit];
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 6000,
    system: writerSystem(recipe),
    messages: [{ role: "user", content: `${contextBlock(ctx)}\n\nWrite the ${recipe.name} for ${ctx.product.name}.` }],
    tools: [SCRIPT_TOOL],
  });
  const raw = readScript(reply, SCRIPT_TOOL.name);
  if (!raw || !Array.isArray(raw.shots) || !raw.shots.length) throw new ApiError("naive", 502, "script_unreadable", "the brainrot writer returned no script");
  let script = normalizeBrainrot(raw, ctx);
  const issues = lintBrainrot(script, ctx);
  const review = await critique(naive, ctx, script, issues);
  script.review = { score: review.score ?? 0, notes: [...issues.map((issue) => `lint: ${issue}`), ...review.notes].slice(0, 10), rounds: 1 };
  if ((review.score === null || review.score < PASS || issues.length) && review.revised) {
    const revised = normalizeBrainrot(review.revised, ctx);
    const left = lintBrainrot(revised, ctx);
    // A revision that breaks the rules worse than the draft is not kept.
    if (revised.shots.length >= recipe.shots.min && left.length <= issues.length) {
      revised.review = { score: Math.max(review.score ?? 0, PASS), notes: [...left.map((issue) => `lint: ${issue}`), ...review.notes].slice(0, 10), rounds: 2 };
      script = revised;
    }
  }
  return script;
}

async function critique(naive: Pick<NaiveClient, "message">, ctx: BrainrotContext, script: BrainrotScript, issues: string[]) {
  const recipe = RECIPES[ctx.bit];
  const system = [
    "You are a brainrot-literate creative director checking a deliberately terrible AI meme ad before anything is rendered. Bad on purpose is the point: judge whether it is the right kind of bad.",
    "Score 1-10. Fail (below 7) a script that: is not funny-cringe enough (too polite, too ad-like, sounds like marketing copy), leans on one meme instead of several current trends, does not open on an outrageous stunt or action beat (or opens on anything that reads as suicide or self-harm), buries the product or makes it not the punchline, states a product fact, number or price that is not in the brief, names or depicts a real person, uses someone else's character or brand, has anything sexual, about minors, abuse, trafficking, slurs, hate, drugs or gore, or asks for text inside the pictures.",
    `Check it follows the ${recipe.name} format: ${recipe.format}`,
    "If the score is below 7, write the complete revised script with the same tool, fixing everything.",
  ].join("\n");
  const content = `${contextBlock(ctx)}\n\n<script>\n${JSON.stringify({ ...script, review: undefined })}\n</script>\n\nAutomatic checks found: ${issues.length ? issues.join("; ") : "nothing"}.`;
  const tool = {
    name: "brainrot_review",
    description: "Record the review, and the revised script if the score is below 7.",
    input_schema: {
      type: "object",
      required: ["score", "notes"],
      properties: { score: { type: "integer" }, notes: { type: "array", items: str }, revised: SCRIPT_TOOL.input_schema },
    },
  };
  try {
    const reply = await naive.message({ model: QC_MODEL, max_tokens: 7000, system, messages: [{ role: "user", content }], tools: [tool] });
    const raw = readScript(reply, tool.name) as { score?: unknown; notes?: unknown; revised?: unknown } | null;
    const score = Number(raw?.score);
    return {
      score: score >= 1 && score <= 10 ? Math.round(score) : null,
      notes: Array.isArray(raw?.notes) ? raw.notes.filter((n): n is string => typeof n === "string").slice(0, 6) : [],
      revised: raw?.revised && typeof raw.revised === "object" && Array.isArray((raw.revised as { shots?: unknown }).shots) ? (raw.revised as Record<string, unknown>) : null,
    };
  } catch (error) {
    if (error instanceof ApiError && !error.retryable) throw error;
    return { score: null, notes: ["critic unavailable"], revised: null };
  }
}

// ---------- the plan: stills and clips ----------

export type BrainrotShotPlan = {
  n: number;
  /** The still's prompt (image model). */
  still: string;
  /** Character ids whose reference images the still is drawn from. */
  refs: string[];
  /** The clip's prompt (video model, silent). */
  clip: string;
};

export type BrainrotPlan = {
  /** One reference image per recurring character, drawn before any still. */
  characters: Array<{ id: string; prompt: string }>;
  shots: BrainrotShotPlan[];
};

const NO_WORDS = "No text, no letters, no words, no captions, no signs, no logos, no watermark anywhere in the image.";

/** The stills and clips for a script: each recurring character drawn once, then every shot from them. */
export function planBrainrot(script: BrainrotScript): BrainrotPlan {
  const recipe = RECIPES[script.bit];
  const appearances = new Map<string, number>();
  for (const shot of script.shots) for (const id of shot.cast) appearances.set(id, (appearances.get(id) ?? 0) + 1);
  const recurring = script.characters.filter((c) => (appearances.get(c.id) ?? 0) >= 2).slice(0, 2);
  const byId = new Map(script.characters.map((c) => [c.id, c]));
  return {
    characters: recurring.map((c) => ({
      id: c.id,
      prompt: [`Character design still: ${c.look}.`, "Full body, standing, facing the camera, in a simple bright setting that suits it.", recipe.look, NO_WORDS].join(" "),
    })),
    shots: script.shots.map((shot) => {
      const cast = shot.cast.map((id) => byId.get(id)).filter((c): c is BrainrotCharacter => Boolean(c));
      const refs = shot.cast.filter((id) => recurring.some((c) => c.id === id));
      return {
        n: shot.n,
        refs,
        still: [
          shot.frame.replace(/\.$/, "") + ".",
          cast.length ? `Characters: ${cast.map((c) => `${c.look}${refs.includes(c.id) ? " (exactly as in the reference image)" : ""}`).join("; ")}.` : "",
          recipe.look,
          NO_WORDS,
        ]
          .filter(Boolean)
          .join(" "),
        clip: [
          "Keep the first frame's characters, their look and the place exactly.",
          `${shot.motion.replace(/\.$/, "")}.`,
          recipe.movement,
          "Absurd, high-energy meme video; the characters stay non-human and keep their shapes.",
          "No text, no captions, no subtitles, no logos, no watermark.",
        ].join(" "),
      };
    }),
  };
}

// ---------- what it costs ----------

/** What a brainrot video's pieces cost (USD): Monid's ElevenLabs prices as inspected on 7 Nov 2026, Naive's as billed. */
export const PRICES = {
  /** Naive's image model, per image (as billed for remake frames). */
  image: 0.04,
  /** ElevenLabs eleven_v4 per 1,000 characters. */
  ttsPerK: 0.08,
  /** ElevenLabs music per minute. */
  musicPerMin: 0.15,
  /** ElevenLabs sound effects per minute. */
  sfxPerMin: 0.12,
  /** One vision or writing call on Naive (Sonnet), about. */
  call: 0.04,
} as const;

/** The length a video model renders for a shot: Veo renders 4, 6 or 8 s; others take whole seconds. */
export function videoSeconds(model: string, seconds: number): number {
  const s = Math.max(1, seconds);
  if (/veo/i.test(model)) return [4, 6, 8].find((n) => n >= s - 0.05) ?? 8;
  if (/kling/i.test(model)) return s <= 5 ? 5 : 10;
  if (/seedance/i.test(model)) return Math.max(4, Math.min(12, Math.ceil(s)));
  if (/grok-imagine|wan/i.test(model)) return Math.max(3, Math.min(15, Math.ceil(s)));
  return [4, 6, 8].find((n) => n >= s) ?? 8;
}

/** How long a line takes the voice to say (a dramatic read, about 2.6 words a second). */
export const lineSeconds = (words: string) => {
  const count = words.split(/\s+/).filter(Boolean).length;
  return count ? count / 2.6 + 0.35 : 0;
};

/** A shot's planned length: its line's, at least the bit's silent length. */
export const shotSeconds = (shot: Pick<BrainrotShot, "words" | "seconds">, recipe: BitRecipe) => Math.max(shot.words ? 1.6 : recipe.silentSeconds, lineSeconds(shot.words), shot.words ? 0 : shot.seconds);

export type BrainrotEstimate = {
  clips_seconds: number;
  usd: { stills: number; clips: number; voice: number; music: number; sfx: number; checks: number; total: number };
};

/** What a script will cost before anything is paid for, with the video model's price per second. */
export function estimateBrainrot(script: BrainrotScript, options: { model?: string; perSecond?: number; sfxToMake?: number; checks?: number } = {}): BrainrotEstimate {
  const recipe = RECIPES[script.bit];
  const plan = planBrainrot(script);
  const clipsSeconds = script.shots.reduce((sum, shot) => sum + videoSeconds(options.model ?? "google/veo-3.1-lite", shotSeconds(shot, recipe) + 0.3), 0);
  const chars = script.shots.reduce((sum, shot) => sum + shot.words.length, 0) + script.end.line.length + script.shots.filter((s) => /6-7|six seven/i.test(s.stamp + s.words)).length * 12;
  const total = script.shots.reduce((sum, shot) => sum + shotSeconds(shot, recipe), 0) + 3;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const usd = {
    stills: round((plan.characters.length + plan.shots.length) * PRICES.image),
    clips: round(clipsSeconds * (options.perSecond ?? 0.15)),
    voice: round(((chars + 40) / 1000) * PRICES.ttsPerK),
    music: round(((total + 2) / 60) * PRICES.musicPerMin * (script.music.turn ? 2 : 1)),
    sfx: round(((options.sfxToMake ?? 0) * 2) / 60 * PRICES.sfxPerMin),
    checks: round((options.checks ?? 2) * PRICES.call),
    total: 0,
  };
  usd.total = round(usd.stills + usd.clips + usd.voice + usd.music + usd.sfx + usd.checks);
  return { clips_seconds: clipsSeconds, usd };
}

// ---------- in a campaign ----------

/** "https://www.monid.ai/x" → "monid.ai". */
export function siteOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

/** The campaign's concept for a brainrot video: a reach video, held until a person clears it. */
export function brainrotConcept(brief: CreativeBrief, script: BrainrotScript): Concept {
  const recipe = RECIPES[script.bit];
  const ref = recipe.reference;
  return {
    title: brief.title || script.title,
    format: "brainrot",
    angle: brief.angle || recipe.name,
    platforms: brief.platforms?.length ? brief.platforms : ["tiktok"],
    hook: script.hook,
    creator: "",
    setting: "",
    shots: [],
    reference_images: [],
    caption: script.caption || brief.caption,
    hashtags: script.hashtags.length ? script.hashtags : brief.hashtags,
    cta: brief.cta,
    inspired_by: [ref.url],
    why: brief.why || `${recipe.name}: ${(ref.views / 1e6).toFixed(1)}M views, ${ref.outlier}x its account's followers`,
    role: "reach",
    metric: brief.metric === "shares" || brief.metric === "saves" ? brief.metric : "views",
    internal: true,
    brief: { ...brief, format: "brainrot", role: "reach" },
    brainrot: script,
    reference: { id: brief.reference_id || `brainrot-${script.bit}`, url: ref.url, author: ref.author, views: ref.views, followers: ref.followers, outlier: ref.outlier, format: recipe.name, hook_mechanic: recipe.format },
  };
}
