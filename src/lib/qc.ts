import type { NaiveClient } from "./naive";
import type { Concept, Shot, Strategy } from "./strategy";

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
    `The product should look like this: ${input.brand.product_look}`,
    `The creator should be: ${input.concept.creator}`,
    `The setting should be: ${input.concept.setting}`,
    `What should happen in this shot: ${input.shot.video_prompt}`,
    "Critical defects (any one fails the shot): the product is missing, malformed or its label is garbled or wrong; deformed hands, faces, teeth or eyes; extra or merging limbs or objects; the person changes identity between frames; gibberish text on screen; unsafe or off-brand content.",
    "Also judge: does it look like a real person filmed it on a phone, does the action match the brief, is the framing vertical and well composed.",
    "Be strict: a mediocre shot that would make the brand look cheap fails. Call the qc_verdict tool once.",
  ].join("\n");
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          ...input.frames.map((frame) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } })),
          { type: "text", text: `${rubric}\n\nThe prompt that produced it:\n${input.prompt}` },
        ],
      },
    ],
    tools: [VERDICT_TOOL],
  });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === VERDICT_TOOL.name);
  const raw = (call?.input ?? {}) as Partial<Verdict>;
  const score = Math.max(1, Math.min(10, Math.round(Number(raw.score) || 0)));
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((issue) => typeof issue === "string").slice(0, 6) : [];
  return { score, pass: Boolean(raw.pass) && score >= PASS_SCORE, issues, fix_prompt: typeof raw.fix_prompt === "string" ? raw.fix_prompt : "" };
}
