import { download } from "../media";
import type { NaiveClient } from "../naive";
import { extractJson } from "../research";
import { getSetting } from "../settings";
import { TYPE_STYLES, type TypeStyle } from "./fonts";
import { ARCHETYPES, type Archetype, type Look, SCHEMES, type Scheme } from "./layouts";
import { normalizeImage } from "./render";
import { type StaticAd, type StaticResearch, studySet } from "./research";

// The ad study: a vision model looks at the brand's own site and at the best-performing static ads
// the research found, and writes down what wins. Its art direction is not advice for a person: the
// writer and the renderer follow it field by field, so the research decides how the ads look.

export type ArtDirection = {
  scheme: Scheme;
  /** A second ground for variety: Meta reports visually distinct creatives perform better. */
  alt_scheme: Scheme;
  type_style: TypeStyle;
  decoration: Look["decoration"];
  cta_in_image: boolean;
  imagery: "product_ui" | "photo" | "type" | "data";
  archetypes: Archetype[];
  headline_case: "sentence" | "title" | "upper";
  notes: string;
};

export type StudiedAd = { id: string; archetype: string; headline: string; what_it_does: string; why_it_works: string };

export type Study = { art: ArtDirection; brand_identity: string; ads: StudiedAd[]; patterns_md: string; studied: string[]; model: string; tokens: { input: number; output: number } };

const STUDY_TOOL = {
  name: "ad_study",
  description: "Record the study of these ads and the art direction for the brand's new static ads.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["brand_identity", "ads", "art_direction", "patterns_md"],
    properties: {
      brand_identity: { type: "string", description: "How the brand presents itself on its own site (image 1): ground color, headline typeface and weight, accent use, recurring motifs. Two or three sentences." },
      ads: {
        type: "array",
        description: "One entry per ad image after the site screenshot, in order.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["n", "archetype", "headline", "what_it_does", "why_it_works"],
          properties: {
            n: { type: "integer", description: "The ad's number as labeled." },
            archetype: { type: "string", enum: [...ARCHETYPES, "other"] },
            headline: { type: "string", description: "The main words on the image, verbatim; empty if none." },
            what_it_does: { type: "string", description: "Layout, ground, type, imagery, amount of text, one sentence." },
            why_it_works: { type: "string", description: "Why its signals suggest it performs, one sentence." },
          },
        },
      },
      art_direction: {
        type: "object",
        additionalProperties: false,
        required: ["scheme", "alt_scheme", "type_style", "decoration", "cta_in_image", "imagery", "archetypes", "headline_case", "notes"],
        properties: {
          scheme: { type: "string", enum: [...SCHEMES], description: "Main ground. white/cream/black are neutral grounds; brand is the brand's main color; light is a pale tint of it; dark is a near-black from its hue." },
          alt_scheme: { type: "string", enum: [...SCHEMES], description: "A second ground, different from scheme, for variety across the set." },
          type_style: { type: "string", enum: Object.keys(TYPE_STYLES), description: "serif: refined editorial serif (Newsreader). geist: clean modern grotesk (Geist), like most software brands. modern: heavy Inter. grotesk: characterful heavy grotesk. bold: condensed all-caps. editorial: high-contrast fashion serif. friendly: rounded." },
          decoration: { type: "string", enum: ["none", "subtle", "bold"], description: "none: flat, hairlines, no shadows or stickers (clean software and AI brands). subtle: soft shadows. bold: promotional energy." },
          cta_in_image: { type: "boolean", description: "Whether winning ads in this category draw a call-to-action button inside the image." },
          imagery: { type: "string", enum: ["product_ui", "photo", "type", "data"], description: "What carries the winning images: real product UI and screenshots, photography, typography alone, or numbers and charts." },
          archetypes: { type: "array", items: { type: "string", enum: [...ARCHETYPES] }, description: "4-6 layouts to use for this brand, best first, chosen from what wins in these ads and what the brand can truthfully show." },
          headline_case: { type: "string", enum: ["sentence", "title", "upper"] },
          notes: { type: "string", description: "Concrete direction in two or three sentences: what to keep, what to avoid." },
        },
      },
      patterns_md: { type: "string", description: "Markdown: '## What wins here' (patterns the strongest ads share, citing ads by number) and '## Rules for new statics' (concrete, reusable rules)." },
    },
  },
};

export async function studyStatics(naive: NaiveClient, input: { research: StaticResearch; brandName: string; category: string; screenshotPath: string | null; tmpDir: string }): Promise<Study> {
  const picks = studySet(input.research);
  const content: unknown[] = [];
  const studied: string[] = [];
  let n = 0;
  if (input.screenshotPath) {
    try {
      const { readFile } = await import("node:fs/promises");
      const image = await normalizeImage(await readFile(input.screenshotPath), { maxSide: 1400 });
      content.push({ type: "text", text: `Image 1: ${input.brandName}'s own website (homepage, as a visitor sees it).` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.bytes.toString("base64") } });
    } catch {
      // study the ads alone
    }
  }
  for (const ad of picks) {
    try {
      const path = await download(ad.image!, `${input.tmpDir}/${ad.id.replace(/[^a-z0-9-]/gi, "_")}`);
      const { readFile } = await import("node:fs/promises");
      const image = await normalizeImage(await readFile(path), { maxSide: 1100 });
      n++;
      content.push({ type: "text", text: describe(n, ad) });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.bytes.toString("base64") } });
      studied.push(ad.id);
    } catch {
      // an expired or refused link: study the others
    }
  }
  content.push({
    type: "text",
    text: [
      `You are the creative director for ${input.brandName} (${input.category}). Above are ${input.screenshotPath ? "the brand's own site, then " : ""}${n} static ads that the research ranked highest by the signals ad libraries and X publish (impression rank, days running, versions, views, engagement). Ads are labeled with their role: the brand itself, a direct competitor, a category leader, or other advertisers in the category.`,
      "Study them as a performance creative strategist: which layouts, grounds, type, imagery and amount of text the strongest ones use.",
      "Then set the art direction for the brand's new static ads. Keep it true to the brand's own identity (image 1) and to what wins in this category. If the category's best ads are clean software or AI ads (neutral grounds, real product UI, restrained type, no stickers or stock-photo people), say so: decoration none, imagery product_ui or type.",
      "Never direct anyone to copy another brand's words, people, characters or trademarks: describe formats.",
      "Call the ad_study tool exactly once.",
    ].join("\n"),
  });
  const model = getSetting("static_model");
  const reply = await naive.messageStream({ model, max_tokens: 8000, messages: [{ role: "user", content }], tools: [STUDY_TOOL] });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === STUDY_TOOL.name);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Record<string, unknown> | null;
  if (!raw) throw new Error("the ad study returned nothing readable");
  return {
    art: artDirection(raw.art_direction),
    brand_identity: typeof raw.brand_identity === "string" ? raw.brand_identity : "",
    ads: (Array.isArray(raw.ads) ? raw.ads : []).map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const index = Number(e.n) - 1;
      return { id: studied[index] ?? "", archetype: String(e.archetype ?? ""), headline: String(e.headline ?? ""), what_it_does: String(e.what_it_does ?? ""), why_it_works: String(e.why_it_works ?? "") };
    }).filter((ad) => ad.id),
    patterns_md: typeof raw.patterns_md === "string" ? raw.patterns_md : "",
    studied,
    model,
    tokens: { input: reply.usage?.input_tokens ?? 0, output: reply.usage?.output_tokens ?? 0 },
  };
}

function describe(n: number, ad: StaticAd) {
  const role = { brand: "the brand's own post", competitor: "a direct competitor", leader: "a category leader", category: "another advertiser in the category" }[ad.role];
  const where = { meta: "Meta ad library", x: "X post", google: "Google display ad", linkedin: "LinkedIn ad" }[ad.source];
  return `Ad ${n}: ${where}, ${role} (${ad.advertiser}). Signals: ${ad.signal || "none published"}.${ad.text ? ` Post text: ${ad.text.slice(0, 200)}` : ""}`;
}

/** A safe, complete art direction from whatever the model returned. */
export function artDirection(value: unknown): ArtDirection {
  const v = (value ?? {}) as Record<string, unknown>;
  const pickOne = <T extends string>(x: unknown, allowed: readonly T[], fallback: T): T => (typeof x === "string" && (allowed as readonly string[]).includes(x) ? (x as T) : fallback);
  const scheme = pickOne(v.scheme, SCHEMES, "white");
  let alt = pickOne(v.alt_scheme, SCHEMES, scheme === "black" ? "white" : "black");
  if (alt === scheme) alt = scheme === "black" ? "white" : "black";
  const archetypes = (Array.isArray(v.archetypes) ? v.archetypes : []).filter((a): a is Archetype => (ARCHETYPES as readonly string[]).includes(String(a)));
  return {
    scheme,
    alt_scheme: alt,
    type_style: pickOne(v.type_style, Object.keys(TYPE_STYLES) as TypeStyle[], "geist"),
    decoration: pickOne(v.decoration, ["none", "subtle", "bold"] as const, "none"),
    cta_in_image: typeof v.cta_in_image === "boolean" ? v.cta_in_image : false,
    imagery: pickOne(v.imagery, ["product_ui", "photo", "type", "data"] as const, "type"),
    archetypes: [...new Set(archetypes)].slice(0, 6).length ? [...new Set(archetypes)].slice(0, 6) : ["editorial", "product_ui", "stat", "comparison"],
    headline_case: pickOne(v.headline_case, ["sentence", "title", "upper"] as const, "sentence"),
    notes: typeof v.notes === "string" ? v.notes.slice(0, 600) : "",
  };
}
