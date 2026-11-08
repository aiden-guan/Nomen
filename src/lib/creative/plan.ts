import type { ARollShot, BRollClip, CreativeBrief, EditTimeline, FilmedPlate, ProductBrief, ProductionPlan, ProductVisual, ReferenceBeat, ScreenRequest, Script, ScriptBeat } from "./types";

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

/** Formats with an AI presenter on camera (rendered by a video model); the others are voiced by text-to-speech. */
export const usesCreator = (format: CreativeBrief["format"]) => format === "talking_head_broll" || format === "split_screen" || format === "presenter_inset";

export const screenVisualId = (requestId: string) => `screen:${requestId}`;

/** The screen brief for a graphic beat the writer gave no screen: show what its line says. */
export function screenFromLine(line: string, still?: { caption: string }, desktop = false): string {
  return [
    desktop
      ? `Show what the computer monitor shows while this line is said, as one real desktop window (a terminal, code editor, browser or the product's own app): "${line}".`
      : `Show what this line says as one clear on-screen graphic: "${line}".`,
    "Use the product's real names, commands, numbers and UI from the brief, and nothing the line does not say.",
    still ? `It may build on this real visual: ${still.caption}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function planProduction(script: Script, brief: CreativeBrief, product: ProductBrief, delivery = "", referenceBeats: ReferenceBeat[] = []): ProductionPlan {
  const visuals = new Map(product.visuals.map((v) => [v.id, v]));
  const filmed = brief.format === "filmed_screen";
  const broll: BRollClip[] = [];
  const screens: ScreenRequest[] = [];
  let photoTurn = 0;
  const used = new Map<string, number>();
  let previous: string | undefined;
  script.beats.forEach((beat, i) => {
    if (beat.visual === "creator") {
      previous = undefined;
      return;
    }
    const still = beat.product_visual ? visuals.get(beat.product_visual) : undefined;
    // The references change the graphic on almost every line. A beat with no visual, or one that
    // would show the same still as the beat before it (or a third time), gets a screen of its own
    // line instead; the still stays as its fallback if the build fails.
    // For software and services, a site photo or logo in a graphic beat is a blurred-edge letterbox;
    // a screen built around it looks like the product. Screenshots and clips stay.
    // A banner-shaped image (a 1920x330 diagram) is a thin strip in any panel, and in the monid.ai
    // run filled four split beats with grey. Both get a screen built around them instead.
    const wide = Boolean(still?.width && still?.height && still.width / still.height > 2);
    const weakStill = Boolean(still) && (wide || (still?.kind === "photo" && product.kind !== "physical"));
    const stale = !still || weakStill || still.id === previous || (used.get(still.id) ?? 0) >= 2;
    // A filmed screen shows what the monitor shows on every line: a phone screenshot on a desktop
    // monitor looks wrong, so every spoken beat gets a desktop screen of its own.
    const brief = beat.screen ?? ((stale || filmed) && beat.line ? screenFromLine(beat.line, still, filmed) : "");
    // A built screen wins over a still: it shows what the product does, the way the reference did.
    if (brief) {
      previous = undefined;
      const request: ScreenRequest = {
        id: `b${beat.n}`,
        brief,
        line: beat.line,
        seconds: beat.seconds,
        reference_visual: [referenceBeats[i]?.visual, referenceBeats[i]?.on_screen_text ? `on-screen text: "${referenceBeats[i]!.on_screen_text}"` : ""].filter(Boolean).join("; "),
        size: filmed ? "desktop" : beat.visual === "split" ? "half" : "full",
      };
      screens.push(request);
      broll.push({ beat: beat.n, visual_id: screenVisualId(request.id), motion: "none" });
      return;
    }
    if (!still) return;
    previous = still.id;
    used.set(still.id, (used.get(still.id) ?? 0) + 1);
    broll.push({ beat: beat.n, visual_id: still.id, motion: motionFor(still, beat, photoTurn++) });
  });

  if (!usesCreator(brief.format)) {
    const text = script.beats.map((beat) => beat.line).filter(Boolean).join(" ");
    return { format: brief.format, aroll: [], broll, voiceover: text ? { text, voice: "" } : null, screens };
  }
  return { format: brief.format, aroll: groupShots(script).map((beats, i) => presenterShot(i + 1, beats, brief, product, delivery)), broll, voiceover: null, screens };
}

function motionFor(visual: ProductVisual, beat: ScriptBeat, turn: number): BRollClip["motion"] {
  if (/scroll/i.test(beat.direction) || isTall(visual)) return "scroll_down";
  if (/pan/i.test(beat.direction)) return turn % 2 ? "pan_left" : "pan_right";
  if (/zoom out|pull back/i.test(beat.direction)) return "zoom_out";
  if (visual.kind === "video") return "none";
  return turn % 2 ? "zoom_out" : "zoom_in";
}

/** How long a beat really takes on camera: its planned seconds, or longer if its line needs it. */
export const speakSeconds = (beat: Pick<ScriptBeat, "seconds" | "line">) => Math.max(beat.seconds, beat.line.split(/\s+/).filter(Boolean).length / SPEAK_WPS);
/** A fast but clear talker. Video models drop the end of a line that is faster than this. */
const SPEAK_WPS = 3.4;

/** Consecutive beats packed into shots of at most 8 s of speech, never splitting a beat. */
export function groupShots(script: Script): ScriptBeat[][] {
  const shots: ScriptBeat[][] = [];
  let current: ScriptBeat[] = [];
  let seconds = 0;
  for (const beat of script.beats) {
    const length = speakSeconds(beat);
    if (current.length && seconds + length > MAX_SHOT) {
      shots.push(current);
      current = [];
      seconds = 0;
    }
    current.push(beat);
    seconds += length;
  }
  if (current.length) shots.push(current);
  return shots;
}

export const snapSeconds = (seconds: number) => SHOT_LENGTHS.find((length) => length >= seconds - 0.25) ?? MAX_SHOT;

/**
 * Only what the presenter does. Scripts often describe the whole edit in a direction ("top half: tool
 * cards; karaoke caption at the split"); a video model given that draws garbled captions and fake
 * UI. The edit adds every card, caption and screen afterwards, so those sentences are dropped.
 */
export function presenterOnly(text: string) {
  const EDIT = /\b(cards?|captions?|subtitles?|karaoke|text|labels?|split|inset|top half|bottom half|top:|bottom:|overlay|logo|timer|bar|checklist|homepage|website|screen|ui|graphics?|ring|highlight\w*|command|cursor|scroll\w*|zoom\w*|pan|b-roll|cutaway|visual|wpm|words per minute)\b/i;
  return text
    .split(/(?<=[.!?])\s+|;\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !EDIT.test(sentence))
    .join(" ")
    .replace(/\.\./g, ".")
    .trim();
}

/**
 * The presenter's or the setting's description, for a prompt. Unlike directions, these are mostly
 * look ("plain black hoodie with no logo"), so only the clauses that are edit directions go, and
 * "no logo"-style wording is dropped from its clause instead of taking the whole outfit with it.
 */
export function lookOnly(text: string) {
  const EDIT = /\b(cards?|captions?|subtitles?|karaoke|labels?|split|inset|top half|bottom half|overlay|timer|checklist|homepage|website|screens?|screenshots?|ui|graphics?|cursor|b-roll|cutaway|visual|wpm|words per minute)\b/i;
  return text
    .replace(/,?\s*\b(with\s+)?(no|without)\s+(visible\s+)?(logos?|text|branding|print|graphics?)\b/gi, "")
    .split(/(?<=[.!?])\s+|[;,]\s*/)
    .map((clause) => clause.trim().replace(/[.!?]+$/, ""))
    .filter((clause) => clause && !EDIT.test(clause))
    .join(", ");
}

function pronoun(creator: string) {
  if (/\b(woman|girl|she|her|female|lady)\b/i.test(creator)) return "She";
  if (/\b(man|guy|he|his|male|boy)\b/i.test(creator)) return "He";
  return "They";
}

export const SAFE =
  "Photorealistic, natural skin texture with pores, natural teeth and eyes, realistic hands. No on-screen text, no captions, no logos, no readable screens or monitors facing the camera; any laptop is closed or seen from behind.";

/** How every presenter prompt ends: video models draw words they are not told to leave out. */
export const NO_TEXT = "No subtitles, no on-screen text.";

const ARC_WORDS: Record<string, string> = { laughs: "a short genuine laugh", laugh: "a short genuine laugh", sighs: "a small sigh", sigh: "a small sigh", whispers: "dropping to a whisper", whisper: "dropping to a whisper" };

/**
 * A line's audio tags as an emotion arc in words, for a video model that voices the line itself:
 * ["[excited]", "[smug]", "[laughs]"] → "excited at the start, then smug, then a short genuine laugh at the end".
 */
export function emotionArc(tags: string[]): string {
  const moods = tags
    .flatMap((t) => t.split(/[\],[;]+/))
    .map((t) => t.replace(/[^\p{L}\s-]/gu, "").trim().toLowerCase())
    .filter(Boolean)
    .map((t) => ARC_WORDS[t] ?? t)
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 4);
  if (!moods.length) return "relaxed and natural";
  if (moods.length === 1) return moods[0];
  return moods.map((m, i) => (i === 0 ? `${m} at the start` : i === moods.length - 1 ? `then ${m} at the end` : `then ${m}`)).join(", ");
}

/**
 * The talking-head recipe that won the head-to-head (Kling 3.0 voicing the line itself): a real
 * creator talking into a propped-up phone, one gentle action, hands down, the body mostly still,
 * nothing about the person's looks (the first frame carries the face), ending on the no-text line.
 */
export function creatorDirection(input: { who: "She" | "He" | "They"; arc: string; action?: string; line?: string; listening?: boolean; green?: boolean; voice?: string }): string {
  const { who } = input;
  const s = (verb: string) => (who === "They" ? verb : `${verb}s`);
  const possessive = who === "She" ? "Her" : who === "He" ? "His" : "Their";
  return [
    input.listening
      ? `${who} ${s("listen")} and ${s("react")} like a real creator watching a clip: a small nod, a raised eyebrow, a half-smile, mouth closed, not speaking.`
      : `${who} ${s("talk")} straight into the camera like a real TikTok creator: ${input.arc}.`,
    input.action ? `One gentle action: ${input.action.replace(/\.$/, "")}.` : "",
    `Natural micro-expressions, eyebrow raises, small head tilts, natural blinking, eye contact with the lens${input.listening ? "." : ", mouth movements that match every word."}`,
    "Hands relaxed and mostly below the frame, the body mostly still; no pointing, no thumbs-up, no head turns past a slight angle.",
    `Real phone-camera look: natural daylight, slight sensor noise, no studio lighting, no music.${input.green ? " The background stays one flat chroma-key green." : ""}`,
    // A persona's voice, described the same way in every take, so the takes sound like one person.
    input.voice && input.line && !input.listening ? `${possessive} voice: ${input.voice.replace(/\.$/, "")}.` : "",
    input.line && !input.listening ? `${who} ${s("say")}: "${input.line}"` : "",
    NO_TEXT,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The first frame's recipe: a camera propped at eye level an arm's length away, mid-sentence, a lived-in
 * real place. Say "camera", never "phone": image models draw a phone's interface when a prompt names one.
 */
export const FRAME_LOOK =
  "Vertical 9:16 candid photo, filmed by a camera propped up at eye level about an arm's length away: chest-up, centred, looking into the lens, mouth slightly open mid-sentence. Natural daylight, natural skin texture with pores, slight grain, imperfect real-world lighting. No text anywhere.";

/** The camera holds still, as a phone propped up on a desk does. */
const CAMERA_STILL = "The camera is propped up and stays still apart from a very slight natural shake; never an arm's-length selfie, no arm reaching toward the lens.";

/** One presenter shot: the frame and video prompts for a creator saying `beats`' lines (the recipe above). */
export function presenterShot(n: number, beats: ScriptBeat[], brief: CreativeBrief, product: ProductBrief, delivery: string, personaVoice?: string): ARollShot {
  const who = pronoun(brief.creator);
  const line = beats.map((beat) => beat.line).filter(Boolean).join(" ");
  const directions = beats
    .filter((beat) => beat.visual !== "product")
    .map((beat) => presenterOnly(beat.direction))
    .filter(Boolean);
  const voice = presenterOnly(delivery);
  const holdsProduct = product.kind === "physical" && beats.some((beat) => beat.visual === "creator" && /hold|show|pick up|bottle|box|pack/i.test(beat.direction));
  const productLine = holdsProduct && product.look ? ` ${who} holds the product steadily at chest height, label toward the camera: ${product.look}.` : "";
  const seconds = snapSeconds(beats.reduce((sum, beat) => sum + speakSeconds(beat), 0));
  // The line's emotion arc: the script's tags per beat, else the reference's delivery notes.
  const tags = beats.map((beat) => beat.emotion ?? "").filter(Boolean);
  const arc = tags.length ? emotionArc(tags) : voice.replace(/\.$/, "").toLowerCase() || "relaxed and natural";
  // One gentle action per take: the first direction's first sentence that is not a big gesture.
  const action =
    directions
      .flatMap((d) => d.split(/(?<=[.!?])\s+/))
      .map((s) => s.trim().replace(/[.!?]+$/, "").replace(/^then\s+/i, ""))
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .find((s) => s && !/\b(point\w*|thumbs?|waves?|turns? (?:away|around)|spins?)\b/i.test(s)) ?? "";
  return {
    n,
    beats: beats.map((beat) => beat.n),
    seconds,
    line,
    pose: action,
    frame_prompt: [
      // Name the look and say nothing about phones or apps: image models draw what a prompt names,
      // even after "no".
      FRAME_LOOK,
      `${lookOnly(brief.creator)}.`,
      `A lived-in real place: ${lookOnly(brief.setting) || "their own room, with everyday things around"}.`,
      productLine.trim(),
      "Natural everyday exposure, not cinematic, no shallow-depth-of-field blur. A plain full-bleed photograph with nothing drawn or written over it.",
    ]
      .filter(Boolean)
      .join(" "),
    // The first frame carries the face, the outfit and the place: the video prompt only says what
    // happens, in the recipe that won the head-to-head (Veo takes it as well).
    video_prompt: [
      "A single full-frame shot of the presenter only: no split screen, no inset, no on-screen graphics or cards.",
      productLine.trim(),
      CAMERA_STILL,
      SAFE,
      // Last, as in the head-to-head: the direction, then the line, then the no-text line.
      creatorDirection({ who, arc, action, line, listening: !line, ...(personaVoice ? { voice: personaVoice } : {}) }),
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
  /** filmed_screen: the monitor photo every visual is filmed on. Without one, visuals fill the frame. */
  plate?: FilmedPlate | null;
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
  const plate = plan.format === "filmed_screen" ? (assets.plate ?? null) : null;
  const segments: EditTimeline["segments"] = [];
  const captionSegments: Array<{ start: number; end: number; text: string }> = [];
  const overlays: EditTimeline["overlays"] = [];
  let lastVisual: { path: string; kind: "image" | "video" } | null = null;

  for (const beat of script.beats) {
    const time = times.get(beat.n);
    if (!time) continue;
    const clip = motion.get(beat.n);
    // A screen that failed to build falls back to the beat's real visual, if it has one.
    const visual = (clip ? assets.visuals.get(clip.visual_id) : undefined) ?? (beat.product_visual ? assets.visuals.get(beat.product_visual) : undefined);
    const noCreator = plan.aroll.length === 0;
    const shown: { path: string; kind: "image" | "video" } | null = visual ?? (noCreator ? lastVisual : null);
    if (shown && (beat.visual !== "creator" || noCreator)) {
      segments.push({
        start: time.start,
        end: time.end,
        layer: plate ? "filmed" : beat.visual === "split" && !noCreator ? "split" : beat.visual === "inset" && !noCreator ? "inset" : "broll",
        // On a filmed monitor the camera moves, so the picture on it holds still.
        broll: { path: shown.path, kind: shown.kind, motion: plate ? "none" : (clip?.motion ?? "zoom_in") },
        ...(plate ? { plate } : {}),
      });
      lastVisual = shown;
    }
    if (beat.line) captionSegments.push({ start: time.start, end: time.end, text: beat.line });
    if (beat.on_screen_text) overlays.push({ start: time.start, end: Math.min(time.end, time.start + 3.5), text: beat.on_screen_text });
  }

  const withCaptions = plan.format !== "text_story";
  let seen = 0;
  const duration = plan.aroll.length ? assets.aroll.reduce((sum, clip) => sum + clip.duration, 0) : (assets.voiceover?.duration ?? script.total_seconds);
  return {
    // Jump cuts (organic plans): every other take on camera punched in, so no two in a row match.
    // A covered take is never seen, so it does not count.
    aroll: assets.aroll.map((clip, i) => {
      if (!plan.punch_in) return { path: clip.path };
      if (plan.aroll[i]?.covered) return { path: clip.path, zoom: 1 };
      return { path: clip.path, zoom: seen++ % 2 ? plan.punch_in : 1 };
    }),
    audio: plan.aroll.length ? null : assets.voiceover ? { path: assets.voiceover.path } : null,
    segments,
    captions: withCaptions ? chunk(captionSegments) : [],
    overlays,
    duration,
  };
}
