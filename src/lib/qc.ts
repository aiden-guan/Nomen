import { ApiError } from "./http";
import type { NaiveClient } from "./naive";
import { extractJson } from "./research";
import type { Concept, Shot, Strategy } from "./strategy";

export type Continuity = { checked: boolean; consistent: boolean; mismatched: number[]; note: string; rounds: number };

// Quality control: a vision model reviews frames of every rendered shot before a person sees it.

export type Verdict = { score: number; pass: boolean; issues: string[]; fix_prompt: string };

export const QC_MODEL = "anthropic/claude-sonnet-5.5";
export const PASS_SCORE = 7;

const VERDICT_TOOL = {
  name: "qc_verdict",
  description: "Record the quality verdict for this shot.",
  input_schema: {
    type: "object",
    required: ["score", "pass", "issues", "fix_prompt"],
    properties: {
      score: { type: "integer", description: "1-10. 9-10 indistinguishable from a real creator's video; 7-8 strong, minor flaws; 5-6 visibly AI or off-brief; 1-4 broken." },
      pass: { type: "boolean", description: "true only if score >= 7 and there is no critical defect." },
      issues: { type: "array", items: { type: "string" }, description: "Concrete defects seen in the frames, most severe first. Empty if none." },
      fix_prompt: {
        type: "string",
        description: "If it fails: the full rewritten video prompt that avoids every issue (same creator, setting, product and dialogue). If it passes: an empty string.",
      },
    },
  },
};

export async function reviewShot(
  naive: NaiveClient,
  input: { frames: Buffer[]; brand: Strategy["brand"]; concept: Concept; shot: Shot; shotNumber: number; prompt: string },
): Promise<Verdict> {
  const rubric = [
    `You are the last quality gate before a brand posts this ad. These are ${input.frames.length} frames, in order, from shot ${input.shotNumber} of "${input.concept.title}", a vertical UGC-style ad for ${input.brand.name}.`,
    `If the prompt puts the product in this shot, it should look like this: ${input.brand.product_look}. Many shots deliberately show only the creator (the real product is cut in during the edit): a product that is absent when the prompt does not ask for it is correct.`,
    `The creator should be: ${input.concept.creator}`,
    `The setting should be: ${input.concept.setting}`,
    `What should happen in this shot: ${input.shot.video_prompt}`,
    "Critical defects (any one fails the shot): the product is missing when the prompt puts it in the shot, or malformed, or its label is garbled or wrong; deformed hands, faces, teeth or eyes; extra or merging limbs or objects; the person changes identity between frames; heavy lens distortion; eyes closed for most of the shot; readable or gibberish text or a screen facing the camera; unsafe or off-brand content.",
    "Not critical (note it, do not fail for it): the person moves or reacts differently from the script but naturally and on message, a single natural blink, small framing differences. A re-render costs money, so fail only what a viewer would notice as fake or wrong.",
    "Judge whether it looks like a real person filmed it on a phone. Be strict about realism: a shot that would make the brand look cheap fails. Call the qc_verdict tool once.",
  ].join("\n");
  const images = input.frames.map((frame) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } }));
  const ask = (text: string, tools?: object[]) =>
    naive.message({ model: QC_MODEL, max_tokens: 1500, messages: [{ role: "user", content: [...images, { type: "text", text }] }], tools });

  let raw: Partial<Verdict> | null = null;
  try {
    const reply = await ask(`${rubric}\n\nThe prompt that produced it:\n${input.prompt}`, [VERDICT_TOOL]);
    raw = (reply.content.find((block) => block.type === "tool_use" && block.name === VERDICT_TOOL.name)?.input as Partial<Verdict> | undefined) ?? null;
  } catch (error) {
    if (!(error instanceof ApiError) || !/tool/i.test(error.message)) throw error;
  }
  if (!raw) {
    // The model fumbled the tool call: ask for the same verdict as plain JSON.
    const reply = await ask(
      `${rubric.replace("Call the qc_verdict tool once.", "")}\n\nThe prompt that produced it:\n${input.prompt}\n\nAnswer with only a JSON object: {"score": 1-10, "pass": true|false, "issues": ["..."], "fix_prompt": "the full rewritten prompt if it fails, else empty"}`,
    );
    raw = extractJson(reply.content.map((block) => block.text ?? "").join("\n")) as Partial<Verdict> | null;
    if (!raw) throw new ApiError("naive", 502, "qc_unreadable", "the quality check returned no verdict");
  }
  return toVerdict(raw);
}

/**
 * The first-frame gate: the still a shot is animated from, checked before the video model runs.
 * Every defect in it (wrong outfit, a phone interface, garbled text) is copied into a render that
 * costs dollars and then into every later shot that takes it as its identity; a new still costs cents.
 */
export async function reviewFrame(
  naive: NaiveClient,
  input: { image: Buffer; creator: string; setting: string; prompt: string; identity?: Buffer | null },
): Promise<{ pass: boolean; issues: string[] }> {
  const images = [input.image, ...(input.identity ? [input.identity] : [])].map((image) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") },
  }));
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          ...images,
          {
            type: "text",
            text: [
              "The first image is the opening frame of a vertical UGC-style video shot. A video model will animate it next, so every defect in it ends up in the video.",
              input.identity
                ? "The second image is shot 1 of the same video: the person, outfit and room must match it (that matters more than the wording below)."
                : `The person should be: ${input.creator}`,
              `The setting should be: ${input.setting}`,
              `The prompt it was made from:\n${input.prompt.slice(0, 1500)}`,
              "Fail it only for what a viewer would notice: any phone or app interface (status bar, clock, reply box, buttons, home bar); readable or garbled text, captions, cards or logos; a screen facing the camera; deformed face, eyes, teeth or hands; more than one person; clearly the wrong outfit or setting; a frame that does not look like a real phone photo.",
              'Answer with only JSON: {"pass": true|false, "issues": ["each defect, concretely, most severe first"]}',
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const raw = extractJson(reply.content.map((block) => block.text ?? "").join("\n")) as { pass?: unknown; issues?: unknown } | null;
  if (!raw) throw new ApiError("naive", 502, "qc_unreadable", "the frame check returned no verdict");
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((issue): issue is string => typeof issue === "string").slice(0, 4) : [];
  return { pass: raw.pass === true || (raw.pass !== false && issues.length === 0), issues };
}

/**
 * The cut check: one frame per shot, in order. A different person or place between shots is the
 * clearest tell of AI video, so any shot that does not match shot 1 is reported for a re-render.
 */
export async function reviewContinuity(naive: NaiveClient, input: { frames: Buffer[]; concept: Concept }): Promise<{ consistent: boolean; mismatched: number[]; note: string }> {
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          ...input.frames.map((frame) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } })),
          {
            type: "text",
            text: [
              `These are frames from shots 1 to ${input.frames.length} of one vertical ad, in order; they will be cut together.`,
              `Every shot must show the same person: ${input.concept.creator}`,
              `in the same place: ${input.concept.setting}`,
              "Compare each shot with shot 1: face, hair, skin, age, build, outfit and room. Small changes of angle, light or expression are fine; a different-looking person, outfit or room is not.",
              'Answer with only JSON: {"consistent": true|false, "mismatched_shots": [shot numbers that do not match shot 1], "note": "one sentence"}',
            ].join("\n"),
          },
        ],
      },
    ],
  });
  const raw = extractJson(reply.content.map((block) => block.text ?? "").join("\n")) as { consistent?: unknown; mismatched_shots?: unknown; note?: unknown } | null;
  if (!raw) throw new ApiError("naive", 502, "qc_unreadable", "the continuity check returned no verdict");
  const mismatched = Array.isArray(raw.mismatched_shots) ? raw.mismatched_shots.map(Number).filter((n) => Number.isInteger(n) && n > 1 && n <= input.frames.length) : [];
  return { consistent: raw.consistent === true && mismatched.length === 0, mismatched, note: typeof raw.note === "string" ? raw.note : "" };
}

function toVerdict(raw: Partial<Verdict>): Verdict {
  const score = Math.max(1, Math.min(10, Math.round(Number(raw.score) || 0)));
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((issue) => typeof issue === "string").slice(0, 6) : [];
  return { score, pass: Boolean(raw.pass) && score >= PASS_SCORE, issues, fix_prompt: typeof raw.fix_prompt === "string" ? raw.fix_prompt : "" };
}
