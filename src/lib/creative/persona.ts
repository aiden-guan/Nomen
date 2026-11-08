// The brand's recurring people for one-to-one remakes. A remake swaps the reference's person for a
// lookalike of the same type who is clearly someone else, and every clip of every remake must be
// the same person, so each persona is made once per brand (a portrait from a description the
// director writes, or a default) and kept in the store's files with the voice chosen for it:
//
//   "brd_…/persona.json" and "brd_…/persona.png"  the host: our presenter in every remake
//   "brd_…/cohost.json"  and "brd_…/cohost.png"   the co-host: who plays another creator the
//                                                  reference stitched in
//
// Kept by key like production's files, so a later tick on another machine finds the same person.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ApiError } from "../http";
import { download, scratchDir } from "../media";
import { type MonidRunner, runCostMicro, runToEnd } from "../monid";
import type { NaiveClient } from "../naive";
import type { Files } from "../store/types";
import { lookOnly } from "./plan";

export type Gender = "female" | "male";
export type PersonaRole = "host" | "cohost";

export type PersonaVoice = { id: string; name: string; gender: Gender | null; source: "voices" | "default" };

export type Persona = {
  brand_id: string;
  role?: PersonaRole;
  /** What the person looks like, in words (prompts and checks use it). */
  description: string;
  gender: Gender | null;
  voice: PersonaVoice;
  /** The portrait's file key. */
  portrait_key: string;
  /** A prebuilt Naive character (chr_…) this persona is: every image of them is rendered with it. */
  character?: string;
  /** What making it cost, once (micro-USD). */
  cost_micro: number;
  created_at: string;
};

const stem = (role: PersonaRole) => (role === "host" ? "persona" : "cohost");
export const personaKey = (brandId: string, role: PersonaRole = "host") => `${brandId}/${stem(role)}.json`;
export const portraitKey = (brandId: string, role: PersonaRole = "host") => `${brandId}/${stem(role)}.png`;

/** Used when the director wrote no presenter: a casual young creator, plainly dressed. */
export const DEFAULT_PERSONA = "A woman in her mid-twenties with long dark hair and natural makeup, in a plain black hoodie: a casual, confident social-media creator.";
/** Used when the layout could not say who the stitched creator is. */
export const DEFAULT_COHOST = "A man in his early twenties with short dark curly hair, in a plain white t-shirt: a casual creator.";

/** The ElevenLabs voices the top UGC tools use, first choice first (Lena is labelled for UGC ads). */
export const UGC_VOICES: Voice[] = [
  { voice_id: "roYauZ4bOLAKvVZTPLre", name: "Lena", labels: { gender: "female", age: "young", accent: "american", use_case: "ugc ads, social media", description: "natural, casual" }, category: "premade" },
  { voice_id: "6u6JbqKdaQy89ENzLSju", name: "Brielle", labels: { gender: "female", age: "young", accent: "american", use_case: "social media", description: "natural, confident" } },
  { voice_id: "3iY0r3RaYmOh6WfIwMIH", name: "Matt", labels: { gender: "male", age: "young", accent: "american", use_case: "ugc ads, social media", description: "natural, casual" }, category: "premade" },
  { voice_id: "sfJopaWaOtauCD3HKX6Q", name: "Arthur", labels: { gender: "male", age: "middle aged", accent: "american", use_case: "social media", description: "warm, confident" } },
];

/** The first choice per gender, when nothing else is known. */
export const DEFAULT_VOICES: Record<Gender, { id: string; name: string }> = {
  female: { id: "roYauZ4bOLAKvVZTPLre", name: "Lena" },
  male: { id: "3iY0r3RaYmOh6WfIwMIH", name: "Matt" },
};

/** Naive's prebuilt characters: ready to use, no training, no cost (naive/channel-template-ai-influencer). */
export const PREBUILT_CHARACTERS: Record<string, string> = {
  "Priya Raman": "chr_bb1xr9kn5tav3nqbgq5w2p8g61",
  "Maya Elusing": "chr_e0tgbzd9kqfrfrzzs33bsxh89f",
  "Hank Delgado": "chr_b3nnct3kvsv4d17eb14dhqfhhv",
  "Ava Lindqvist": "chr_4sq1wcpx4jygj46wqspp4z8d5a",
  "Marcus Bell": "chr_bpg78xxfgmtrshbx2nv2nx5f62",
  "Theo Park": "chr_ry84wq63nwd3nd2j615m4j7svx",
};

/** The look a character's stills are rendered in: a talking-to-camera selfie reads as real UGC. */
export const CHARACTER_STYLE = "Candid selfie";

/** Whom a description is about: the first gendered word decides; null when it says neither. */
export function genderOf(text: string): Gender | null {
  const female = text.search(/\b(woman|women|girl|female|she|her|lady|mom|mother)\b/i);
  const male = text.search(/\b(man|men|guy|male|he|his|him|boy|dude|dad|father)\b/i);
  if (female < 0 && male < 0) return null;
  if (female < 0) return "male";
  if (male < 0) return "female";
  return female < male ? "female" : "male";
}

/** How old a description sounds, in the voice library's terms (young unless it says otherwise). */
export function ageOf(description: string): "young" | "middle_aged" | "old" {
  if (/\b(sixties|seventies|60s|70s|elderly|grand(ma|pa|mother|father))\b/i.test(description)) return "old";
  if (/\b(forties|fifties|40s|50s|middle[- ]aged)\b/i.test(description)) return "middle_aged";
  return "young";
}

/**
 * The co-host's description: someone of the same type as the creator the reference stitched in,
 * clearly not them (the portrait model makes a new face from words alone).
 */
export function cohostDescription(otherLook: string): string {
  const look = lookOnly(otherLook) || otherLook.trim();
  return look ? `${look}; a different person of the same type, not anyone real` : DEFAULT_COHOST;
}

/** The portrait: chest-up to the camera, plain wall, plain clothes, nothing written anywhere. */
export function portraitPrompt(description: string): string {
  return [
    `Candid vertical phone photo of ${lookOnly(description) || description}.`,
    "Chest-up, facing the camera with a relaxed, confident half-smile, plain light wall behind, soft daylight.",
    "Plain clothes with no text, logo or print. Photorealistic, natural skin texture, nothing written anywhere.",
  ].join(" ");
}

export type Voice = { voice_id: string; name: string; labels?: Record<string, string>; category?: string; description?: string };

/** The voices in a voice-list answer, whatever it is wrapped in. */
export function readVoices(output: unknown): Voice[] {
  const o = (output ?? {}) as Record<string, unknown>;
  const list = Array.isArray(output) ? output : Array.isArray(o.voices) ? o.voices : Array.isArray(o.data) ? o.data : [];
  return (list as Array<Record<string, unknown>>)
    .filter((v) => typeof v?.voice_id === "string")
    .map((v) => ({
      voice_id: String(v.voice_id),
      name: String(v.name ?? ""),
      labels: v.labels && typeof v.labels === "object" ? (v.labels as Record<string, string>) : {},
      category: typeof v.category === "string" ? v.category : undefined,
      description: typeof v.description === "string" ? v.description : undefined,
    }));
}

/** The vibe words a description and a voice can share. */
const VIBES = ["confident", "energetic", "upbeat", "calm", "warm", "deep", "raspy", "playful", "casual", "friendly", "bold", "smooth", "sassy", "chill", "intense", "excited"];

/**
 * The voice that fits the persona: the same gender and age, American, made for conversational or
 * social-media speech, and sharing the description's vibe words. Null when no voice of that gender
 * is listed.
 */
export function pickVoice(voices: Voice[], gender: Gender | null, description = ""): Voice | null {
  const age = ageOf(description);
  const vibes = VIBES.filter((vibe) => new RegExp(`\\b${vibe}`, "i").test(description));
  const score = (v: Voice) => {
    const labels = Object.fromEntries(Object.entries(v.labels ?? {}).map(([k, value]) => [k.toLowerCase(), String(value).toLowerCase()]));
    const text = `${v.name} ${v.description ?? ""} ${Object.values(labels).join(" ")}`.toLowerCase();
    const theirs = (labels.age ?? "").replace(/[\s-]+/g, "_");
    let s = 0;
    if (theirs && theirs.startsWith(age.split("_")[0])) s += 3;
    else if (theirs.startsWith("old") && age !== "old") s -= 2;
    if (/american/.test(labels.accent ?? "")) s += 2;
    for (const cue of ["social media", "conversational", "casual", "natural"]) if (text.includes(cue)) s += 1;
    for (const vibe of vibes) if (text.includes(vibe)) s += 1;
    if (/news|narrat|audiobook|meditat|elderly|villain|robot|whisper/.test(text)) s -= 1;
    if (v.category === "premade") s += 0.5;
    return s;
  };
  const fits = voices.filter((v) => !gender || (v.labels?.gender ?? "").toLowerCase() === gender);
  return fits.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * The persona's one voice: from the UGC voices, the persona's gender, age and vibe (a voice list
 * from ElevenLabs can be passed instead). It is used wherever ElevenLabs speaks for the persona:
 * speech-to-speech that evens out Kling's voice across renders, and reads where no render speaks.
 */
export function chooseVoice(gender: Gender | null, description: string, voices: Voice[] = UGC_VOICES): PersonaVoice {
  const best = pickVoice(voices, gender, description) ?? pickVoice(UGC_VOICES, gender, description);
  if (best) return { id: best.voice_id, name: best.name, gender, source: voices === UGC_VOICES ? "default" : "voices" };
  const fallback = DEFAULT_VOICES[gender ?? "female"];
  return { ...fallback, gender: gender ?? "female", source: "default" };
}

export type PersonaDeps = {
  naive: Pick<NaiveClient, "generateImage" | "fileUrl">;
  files: Files;
  /** Saves a link to a local file (default: download). */
  fetchUrl?: (url: string, path: string) => Promise<unknown>;
};

/** The brand's persona in a role, with a local copy of its portrait; null before it is made. */
export async function loadPersona(files: Files, brandId: string, role: PersonaRole = "host"): Promise<{ persona: Persona; portrait: string } | null> {
  if (!(await files.exists(personaKey(brandId, role))) || !(await files.exists(portraitKey(brandId, role)))) return null;
  const persona = JSON.parse(await readFile(await files.localPath(personaKey(brandId, role)), "utf8")) as Persona;
  return { persona, portrait: await files.localPath(persona.portrait_key || portraitKey(brandId, role)) };
}

/**
 * The brand's persona in a role: loaded when it exists, else made once and kept. Either one of
 * Naive's prebuilt characters (`character`, chr_…: its face in a candid still), or our own portrait
 * from `description` (the director's presenter, or the stitched creator's type for the co-host) or
 * the default. Training a character of a real face needs the person's consent, so it is never done
 * here. `cost_micro` is what this call spent.
 */
export async function ensurePersona(deps: PersonaDeps, input: { brandId: string; role?: PersonaRole; description?: string | null; character?: string | null }): Promise<{ persona: Persona; portrait: string; cost_micro: number }> {
  const role = input.role ?? "host";
  const existing = await loadPersona(deps.files, input.brandId, role);
  if (existing) return { ...existing, cost_micro: 0 };
  const character = input.character?.trim().startsWith("chr_") ? input.character.trim() : undefined;
  const description = input.description?.trim() || (character ? `${Object.keys(PREBUILT_CHARACTERS).find((name) => PREBUILT_CHARACTERS[name] === character) ?? "the character"}, a creator` : role === "host" ? DEFAULT_PERSONA : DEFAULT_COHOST);
  const gender = genderOf(description);
  const dir = join(scratchDir(), `persona-${input.brandId}-${role}`);
  await mkdir(dir, { recursive: true });
  try {
    const key = `${input.brandId}-${role}-${createHash("sha1").update(`${character ?? ""}${description}`).digest("hex").slice(0, 10)}`;
    const image = await deps.naive.generateImage({ prompt: portraitPrompt(description), aspect_ratio: "3:4", ...(character ? { character, style: CHARACTER_STYLE } : {}) }, key);
    const file = image.files[0];
    if (!file) throw new ApiError("naive", 502, "no_file", "the persona portrait came back empty");
    const local = join(dir, `${stem(role)}.png`);
    await (deps.fetchUrl ?? download)((await deps.naive.fileUrl(file.id)).url, local);
    await deps.files.putFile(portraitKey(input.brandId, role), local, "image/png");
    const persona: Persona = {
      brand_id: input.brandId,
      role,
      description,
      gender,
      voice: chooseVoice(gender, description),
      portrait_key: portraitKey(input.brandId, role),
      ...(character ? { character } : {}),
      cost_micro: image.cost_micro_usd ?? 0,
      created_at: new Date().toISOString(),
    };
    const json = join(dir, `${stem(role)}.json`);
    await writeFile(json, JSON.stringify(persona, null, 1));
    await deps.files.putFile(personaKey(input.brandId, role), json, "application/json");
    return { persona, portrait: await deps.files.localPath(portraitKey(input.brandId, role)), cost_micro: persona.cost_micro };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
