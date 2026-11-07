import type { ARollShot, BRollClip, CreativeBrief, EditTimeline, ProductBrief, ProductionPlan, ProductVisual, Script, ScriptBeat } from "./types";

// The shot planner: turns a script into what gets rendered (A-roll shots of the creator, real
// product visuals for B-roll, or a voice-over) and, once those exist, into the edit timeline.
//
// In a talking-head ad the creator's rendered audio is the whole soundtrack, so the creator says
// every line on camera; the edit then covers product beats with real product footage while the
// voice keeps going (a B-roll cutaway). Video models only render 4, 6 or 8 seconds per shot.

export const SHOT_LENGTHS = [4, 6, 8] as const;
const MAX_SHOT = 8;

/** Taller than a phone screen (a full-page capture): worth scrolling. A one-screen phone capture is not. */
export const isTall = (visual: Pick<ProductVisual, "width" | "height">) => Boolean(visual.width && visual.height && visual.height > visual.width * 2.4);

const usesCreator = (format: CreativeBrief["format"]) => format === "talking_head_broll" || format === "split_screen";

export function planProduction(script: Script, brief: CreativeBrief, product: ProductBrief): ProductionPlan {
  const visuals = new Map(product.visuals.map((v) => [v.id, v]));
  const broll: BRollClip[] = [];
  let photoTurn = 0;
  for (const beat of script.beats) {
    if (beat.visual === "creator" || !beat.product_visual) continue;
    const visual = visuals.get(beat.product_visual);
    if (!visual) continue;
    broll.push({ beat: beat.n, visual_id: visual.id, motion: motionFor(visual, beat, photoTurn++) });
  }

  if (!usesCreator(brief.format)) {
    const text = script.beats.map((beat) => beat.line).filter(Boolean).join(" ");
    return { format: brief.format, aroll: [], broll, voiceover: text ? { text, voice: "" } : null };
  }
  return { format: brief.format, aroll: groupShots(script).map((beats, i) => arollShot(i + 1, beats, brief, product)), broll, voiceover: null };
}

function motionFor(visual: ProductVisual, beat: ScriptBeat, turn: number): BRollClip["motion"] {
  if (/scroll/i.test(beat.direction) || isTall(visual)) return "scroll_down";
  if (/pan/i.test(beat.direction)) return turn % 2 ? "pan_left" : "pan_right";
  if (/zoom out|pull back/i.test(beat.direction)) return "zoom_out";
  if (visual.kind === "video") return "none";
  return turn % 2 ? "zoom_out" : "zoom_in";
}

/** Consecutive beats packed into shots of at most 8 s, never splitting a beat. */
export function groupShots(script: Script): ScriptBeat[][] {
  const shots: ScriptBeat[][] = [];
  let current: ScriptBeat[] = [];
  let seconds = 0;
  for (const beat of script.beats) {
    if (current.length && seconds + beat.seconds > MAX_SHOT) {
      shots.push(current);
      current = [];
      seconds = 0;
    }
    current.push(beat);
    seconds += beat.seconds;
  }
  if (current.length) shots.push(current);
  return shots;
}

export const snapSeconds = (seconds: number) => SHOT_LENGTHS.find((length) => length >= seconds - 0.25) ?? MAX_SHOT;

function pronoun(creator: string) {
  if (/\b(woman|girl|she|her|female|lady)\b/i.test(creator)) return "She";
  if (/\b(man|guy|he|his|male|boy)\b/i.test(creator)) return "He";
  return "They";
}

const CAMERA =
  "The phone is propped up on a stable surface at eye level, about an arm and a half away, and stays still apart from a very slight natural shake. Chest-up framing with the face centered and a little headroom. Never an arm's-length selfie: no arm or hand reaching toward the lens.";
const CALM =
  "Keep the action small and natural: talking to camera, a slight smile, a small nod, a raised eyebrow, leaning back. No pointing, no thumbs-up, no gestures toward the lens, no fast head turns, hands low and relaxed or out of frame. Eyes on the lens while talking.";
const SAFE =
  "Photorealistic, natural skin texture with pores, natural teeth and eyes, realistic hands. No on-screen text, no captions, no logos, no readable screens or monitors facing the camera; any laptop is closed or seen from behind.";

function arollShot(n: number, beats: ScriptBeat[], brief: CreativeBrief, product: ProductBrief): ARollShot {
  const who = pronoun(brief.creator);
  const line = beats.map((beat) => beat.line).filter(Boolean).join(" ");
  const directions = beats
    .filter((beat) => beat.visual !== "product")
    .map((beat) => beat.direction)
    .filter(Boolean)
    .join(" Then ");
  const holdsProduct = product.kind === "physical" && beats.some((beat) => beat.visual === "creator" && /hold|show|pick up|bottle|box|pack/i.test(beat.direction));
  const productLine = holdsProduct && product.look ? ` ${who} holds the product steadily at chest height, label toward the camera: ${product.look}.` : "";
  const seconds = snapSeconds(beats.reduce((sum, beat) => sum + beat.seconds, 0));
  return {
    n,
    beats: beats.map((beat) => beat.n),
    seconds,
    line,
    frame_prompt: [
      "Vertical 9:16 photo taken on a phone propped up at eye level, about an arm and a half away. Chest-up, face centered, looking into the lens, mouth closed, relaxed.",
      `${brief.creator}.`,
      `${brief.setting}.`,
      productLine.trim(),
      "Natural phone-camera exposure, not cinematic, no shallow-depth-of-field blur. Photorealistic, natural skin texture. No readable text, no screens facing the camera, no logos.",
    ]
      .filter(Boolean)
      .join(" "),
    video_prompt: [
      "Vertical 9:16 smartphone video, UGC style.",
      CAMERA,
      `${brief.creator}, in ${brief.setting}.`,
      directions ? `${directions}.` : "",
      productLine.trim(),
      line ? `${who} says, in a natural, conversational voice that matches this delivery (${brief.angle}): "${line}"` : `${who} reacts silently.`,
      "Speak at a relaxed, natural pace with normal pauses; the words must be fully said before the clip ends.",
      CALM,
      "Audio: voice close to the microphone, quiet room tone, no music.",
      SAFE,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

// ---------- the timeline ----------

export type RenderedAssets = {
  /** Rendered A-roll, in plan order, with measured durations. */
  aroll: Array<{ path: string; duration: number }>;
  /** Voice-over audio for formats without a creator. */
  voiceover: { path: string; duration: number } | null;
  /** Local copies of product visuals by id. */
  visuals: Map<string, { path: string; kind: "image" | "video" }>;
};

/** Beat start/end times on the finished video. */
export function beatTimes(script: Script, plan: ProductionPlan, assets: RenderedAssets): Array<{ n: number; start: number; end: number }> {
  const times: Array<{ n: number; start: number; end: number }> = [];
  if (plan.aroll.length) {
    let offset = 0;
    plan.aroll.forEach((shot, i) => {
      const duration = assets.aroll[i]?.duration || shot.seconds;
      const beats = script.beats.filter((beat) => shot.beats.includes(beat.n));
      const planned = beats.reduce((sum, beat) => sum + beat.seconds, 0) || 1;
      let at = offset;
      for (const beat of beats) {
        const length = (beat.seconds / planned) * duration;
        times.push({ n: beat.n, start: at, end: at + length });
        at += length;
      }
      offset += duration;
    });
    return times;
  }
  // Voice-over: spread the audio over beats by how much each one says (silent beats get their planned time).
  const total = assets.voiceover?.duration || script.total_seconds;
  const weight = (beat: ScriptBeat) => Math.max(beat.line.split(/\s+/).filter(Boolean).length, 0) || beat.seconds * 2.5;
  const sum = script.beats.reduce((acc, beat) => acc + weight(beat), 0) || 1;
  let at = 0;
  for (const beat of script.beats) {
    const length = (weight(beat) / sum) * total;
    times.push({ n: beat.n, start: at, end: at + length });
    at += length;
  }
  return times;
}

/**
 * The edit: A-roll (or voice-over) as the soundtrack, product beats covered by real product
 * footage, split beats stacked, the hook and labels as large text, and the spoken words as
 * captions. `chunk` turns per-beat lines into short caption chunks.
 */
export function buildTimeline(
  script: Script,
  plan: ProductionPlan,
  assets: RenderedAssets,
  chunk: (segments: Array<{ start: number; end: number; text: string }>) => EditTimeline["captions"] = (segments) => segments,
): EditTimeline {
  const times = new Map(beatTimes(script, plan, assets).map((t) => [t.n, t]));
  const motion = new Map(plan.broll.map((clip) => [clip.beat, clip]));
  const segments: EditTimeline["segments"] = [];
  const captionSegments: Array<{ start: number; end: number; text: string }> = [];
  const overlays: EditTimeline["overlays"] = [];
  let lastVisual: { path: string; kind: "image" | "video" } | null = null;

  for (const beat of script.beats) {
    const time = times.get(beat.n);
    if (!time) continue;
    const clip = motion.get(beat.n);
    const visual = clip ? assets.visuals.get(clip.visual_id) : beat.product_visual ? assets.visuals.get(beat.product_visual) : undefined;
    const noCreator = plan.aroll.length === 0;
    const shown: { path: string; kind: "image" | "video" } | null = visual ?? (noCreator ? lastVisual : null);
    if (shown && (beat.visual !== "creator" || noCreator)) {
      segments.push({
        start: time.start,
        end: time.end,
        layer: beat.visual === "split" && !noCreator ? "split" : "broll",
        broll: { path: shown.path, kind: shown.kind, motion: clip?.motion ?? "zoom_in" },
      });
      lastVisual = shown;
    }
    if (beat.line) captionSegments.push({ start: time.start, end: time.end, text: beat.line });
    if (beat.on_screen_text) overlays.push({ start: time.start, end: Math.min(time.end, time.start + 3.5), text: beat.on_screen_text });
  }

  const withCaptions = plan.format !== "text_story";
  const duration = plan.aroll.length ? assets.aroll.reduce((sum, clip) => sum + clip.duration, 0) : (assets.voiceover?.duration ?? script.total_seconds);
  return {
    aroll: assets.aroll.map((clip) => ({ path: clip.path })),
    audio: plan.aroll.length ? null : assets.voiceover ? { path: assets.voiceover.path } : null,
    segments,
    captions: withCaptions ? chunk(captionSegments) : [],
    overlays,
    duration,
  };
}
