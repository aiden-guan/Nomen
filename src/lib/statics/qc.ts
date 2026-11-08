import { ApiError } from "../http";
import type { NaiveClient } from "../naive";
import { extractJson } from "../research";
import { getSetting } from "../settings";
import type { Concept } from "./writer";

// The last look before a person sees a static ad: the finished images, as they will run.

export type StaticVerdict = { score: number; pass: boolean; issues: string[]; fix: "none" | "visual" | "copy"; tokens: { input: number; output: number } };

const QC_TOOL = {
  name: "static_qc",
  description: "Record the quality verdict for this ad.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["score", "pass", "issues", "fix"],
    properties: {
      score: { type: "integer", description: "1-10. 9-10: indistinguishable from the brand's best in-house work. 7-8: ready to run, minor nits. 5-6: visibly templated or flawed. 1-4: broken." },
      pass: { type: "boolean", description: "true only if score >= 7 and nothing below is wrong." },
      issues: { type: "array", items: { type: "string" }, description: "Concrete problems, most severe first. Empty if none." },
      fix: { type: "string", enum: ["none", "visual", "copy"], description: "What would fix the worst problem: a new picture, different copy, or nothing." },
    },
  },
};

export async function reviewStatic(naive: NaiveClient, input: { images: Buffer[]; concept: Concept; brandName: string }): Promise<StaticVerdict> {
  const rubric = [
    `These are two sizes of the same static ad for ${input.brandName}, exactly as they will be uploaded: a 4:5 feed image and a 1.91:1 landscape image. Concept: ${input.concept.angle || input.concept.archetype}.`,
    "You are the last check before a performance team runs it. Fail it (pass false) for any of these: text that is cut off, overlapping, too small or low-contrast to read on a phone; garbled, misspelled or invented letters inside the picture; a deformed product, hands or face; a screenshot or picture that looks broken, empty or unrelated; a claim that looks invented; anything that makes the brand look cheap, templated or machine-made.",
    "Do not fail it for taste: a restrained, minimal design with lots of space is intended.",
    "Call the static_qc tool exactly once.",
  ].join("\n");
  const content = [...input.images.map((image) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") } })), { type: "text", text: rubric }];
  let raw: Partial<StaticVerdict> | null = null;
  let tokens = { input: 0, output: 0 };
  try {
    const reply = await naive.messageStream({ model: getSetting("static_model"), max_tokens: 4000, messages: [{ role: "user", content }], tools: [QC_TOOL] });
    tokens = { input: reply.usage?.input_tokens ?? 0, output: reply.usage?.output_tokens ?? 0 };
    const call = reply.content.find((block) => block.type === "tool_use" && block.name === QC_TOOL.name);
    raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Partial<StaticVerdict> | null;
  } catch (error) {
    if (!(error instanceof ApiError) || !/tool/i.test(error.message)) throw error;
  }
  if (!raw) throw new ApiError("naive", 502, "qc_unreadable", "the static ad check returned no verdict");
  const score = Math.max(1, Math.min(10, Math.round(Number(raw.score) || 0)));
  return {
    score,
    pass: Boolean(raw.pass) && score >= 7,
    issues: Array.isArray(raw.issues) ? raw.issues.filter((i) => typeof i === "string").slice(0, 6) : [],
    fix: raw.fix === "visual" || raw.fix === "copy" ? raw.fix : "none",
    tokens,
  };
}
