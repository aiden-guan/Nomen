import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ApiError } from "../http";
import { download, ffmpegPath } from "../media";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson, type ResearchPack } from "../research";
import type { BrandKit, ProductBrief, ProductKind, ProductVisual } from "./types";

const exec = promisify(execFile);

// The product analyst: reads the brand's own site (and looks at its images) and writes the brief
// every writer works from. Claims come only from the site; images are sorted into the ones that
// actually show the product (usable on screen) and the ones that don't.

const MAX_IMAGES = 8;

const BRIEF_TOOL = {
  name: "product_brief",
  description: "Record the product brief.",
  input_schema: {
    type: "object",
    required: ["name", "one_liner", "kind", "audience", "problem", "aha", "features", "claims", "proof", "objections", "offer", "voice", "look", "images"],
    properties: {
      name: { type: "string" },
      one_liner: { type: "string", description: "How a customer would describe it to a friend, one plain sentence, no marketing words." },
      kind: { type: "string", enum: ["physical", "software", "service"], description: "physical = a thing you hold; software = an app, API, SaaS or dev tool; service = done for you." },
      audience: { type: "string", description: "Who buys it, specifically (role, situation), one sentence." },
      problem: { type: "string", description: "The problem in the buyer's own words, as they would complain about it." },
      aha: { type: "string", description: "The moment the product proves itself, described as something you could film or screen-record." },
      features: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          required: ["name", "what_it_does", "how_to_show_it"],
          properties: {
            name: { type: "string" },
            what_it_does: { type: "string", description: "Plain words, what it does for the buyer." },
            how_to_show_it: { type: "string", description: "What would be on screen to show it: a screenshot of which page, the product doing what." },
          },
        },
      },
      claims: { type: "array", items: { type: "string" }, description: "Claims the site itself makes, close to verbatim. Only what the text says." },
      proof: { type: "array", items: { type: "string" }, description: "Numbers, customer names, awards or press that appear in the text. Empty if none." },
      objections: { type: "array", items: { type: "string" }, description: "2-4 reasons a buyer would hesitate." },
      offer: { type: "string", description: "Price, free tier or offer exactly as the site states it, or empty." },
      voice: { type: "string", description: "How the brand talks, in a few words." },
      look: { type: "string", description: "Physical: the product's shape, size, colors, label and materials precisely enough to draw. Software: what its main screen or page shows. Service: what the customer sees." },
      images: {
        type: "array",
        description: "One entry per numbered image you were shown.",
        items: {
          type: "object",
          required: ["index", "shows_product", "caption"],
          properties: {
            index: { type: "integer" },
            shows_product: { type: "boolean", description: "true if the product itself (or its real UI) is clearly visible and it would make sense on screen in an ad." },
            caption: { type: "string", description: "What is visible, in a few words." },
          },
        },
      },
    },
  },
};

type RawBrief = Omit<ProductBrief, "visuals"> & { images: Array<{ index: number; shows_product: boolean; caption: string }> };

/** Downloads up to 8 site images and shrinks them to JPEGs a vision model can take. */
async function loadImages(urls: string[], dir: string): Promise<Array<{ url: string; data: string }>> {
  const bin = await ffmpegPath();
  if (!bin) return [];
  await mkdir(dir, { recursive: true });
  const loaded: Array<{ url: string; data: string }> = [];
  for (const [i, url] of urls.slice(0, MAX_IMAGES).entries()) {
    try {
      const raw = await download(url, join(dir, `img${i}`));
      const out = join(dir, `img${i}.jpg`);
      await exec(bin, ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", out]);
      loaded.push({ url, data: (await readFile(out)).toString("base64") });
    } catch {
      // a broken or blocked image: skip it
    }
  }
  return loaded;
}

export async function analyzeProduct(naive: NaiveClient, pack: ResearchPack, workDir: string, kit: BrandKit | null = null): Promise<ProductBrief> {
  return withBrandKit(await analyzeSite(naive, pack, workDir, kit), kit);
}

/**
 * The brand kit's assets join the visuals (real screenshots, product shots, demo clips, logos) and
 * its code scan adds the product's real commands, screens and UI text.
 */
export function withBrandKit(brief: ProductBrief, kit: BrandKit | null): ProductBrief {
  if (!kit) return brief;
  const kinds: Record<string, ProductVisual["kind"] | null> = { screenshot: "screenshot", image: "photo", video: "video", logo: "photo", icon: null, font: null, doc: null };
  const fromKit: ProductVisual[] = [];
  for (const asset of kit.assets) {
    const kind = kinds[asset.kind];
    if (!kind) continue;
    fromKit.push({
      id: `k${fromKit.length + 1}`,
      kind,
      url: asset.path,
      caption: asset.kind === "logo" ? `the ${brief.name} logo${asset.caption ? `: ${asset.caption}` : ""}` : asset.caption || asset.kind,
      source: `brandkit:${asset.source}`,
      ...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {}),
    });
    if (fromKit.length >= 24) break;
  }
  const repo = kit.repo;
  return {
    ...brief,
    // The brand's own assets first: they beat anything scraped from the site.
    visuals: [...fromKit, ...brief.visuals],
    ...(repo ? { code: { commands: repo.commands.slice(0, 15), screens: repo.screens.slice(0, 15).map(({ route, summary }) => ({ route, summary })), ui_strings: repo.ui_strings.slice(0, 80) } } : {}),
  };
}

async function analyzeSite(naive: NaiveClient, pack: ResearchPack, workDir: string, kit: BrandKit | null): Promise<ProductBrief> {
  const images = await loadImages(pack.brand.images, join(workDir, "product-images")).catch(() => []);
  try {
    const content: unknown[] = [];
    images.forEach((image, i) => {
      content.push({ type: "text", text: `Image ${i}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.data } });
    });
    content.push({
      type: "text",
      text: [
        `Website: ${pack.domain}`,
        `Brand profile: ${JSON.stringify({ name: pack.brand.name, description: pack.brand.description, slogan: pack.brand.slogan, industry: pack.brand.industry })}`,
        `Top search keywords: ${pack.seo.keywords.slice(0, 10).map((k) => k.keyword).join(", ") || "unknown"}`,
        `What buyers say on Reddit: ${JSON.stringify(pack.reddit.slice(0, 6).map((post) => ({ title: post.title, text: post.text.slice(0, 200) })))}`,
        `The site's own words:\n<site>\n${pack.site_excerpt.slice(0, 7000)}\n</site>`,
        ...(kit?.repo
          ? [
              `The product's own code (a read-only scan of its repository; facts here are as reliable as the site):\n<code>\n${JSON.stringify({
                name: kit.repo.name,
                description: kit.repo.description,
                readme: kit.repo.readme.slice(0, 3500),
                commands: kit.repo.commands,
                screens: kit.repo.screens.map(({ route, summary }) => ({ route, summary })),
                ui_strings: kit.repo.ui_strings.slice(0, 60),
              })}\n</code>`,
            ]
          : []),
        images.length ? `You were shown ${images.length} images from the site, numbered from 0.` : "No images were available.",
      ].join("\n\n"),
    });
    const system = [
      "You are the product analyst for a short-form video team. Writers will script ads from your brief alone, so it must be accurate, concrete and in the buyer's words.",
      "Only state what the site, the product's code and the images support. Never invent numbers, features, customers, prices or results; leave a field short or empty rather than guess. When the code shows the real commands or screens, use them in aha, features and how_to_show_it.",
      "Write like a person explaining it to a friend, not like the site's marketing. Call the product_brief tool once.",
    ].join("\n");
    let reply;
    try {
      reply = await naive.message({ model: QC_MODEL, max_tokens: 3000, system, messages: [{ role: "user", content }], tools: [BRIEF_TOOL] });
    } catch (error) {
      // Naive's proxy sometimes rejects the model's tool call as malformed, and retrying the same request
      // fails the same way (the mobilerun.ai study failed six times in a row): ask for plain JSON instead.
      if (!(error instanceof ApiError && /malformed tool call/i.test(error.message))) throw error;
      reply = await naive.message({
        model: QC_MODEL,
        max_tokens: 3000,
        system: system.replace("Call the product_brief tool once.", "Answer with only one JSON object, no other text."),
        messages: [{ role: "user", content: [...content, { type: "text", text: `Answer with only a JSON object with these fields: ${Object.keys(BRIEF_TOOL.input_schema.properties).join(", ")} (features: [{name, what_it_does, how_to_show_it}]; images: [{index, shows_product, caption}]).` }] }],
      });
    }
    const call = reply.content.find((block) => block.type === "tool_use" && block.name === BRIEF_TOOL.name);
    const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Partial<RawBrief> | null;
    if (!raw) throw new ApiError("naive", 502, "brief_unreadable", "the product analyst returned no brief");
    return toBrief(raw, pack, images.map((image) => image.url));
  } catch (error) {
    if (error instanceof ApiError && error.retryable) throw error;
    return fallbackBrief(pack);
  } finally {
    await rm(join(workDir, "product-images"), { recursive: true, force: true }).catch(() => undefined);
  }
}

const strings = (value: unknown, max = 8) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, max) : [];
const text = (value: unknown, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback);

export function toBrief(raw: Partial<RawBrief>, pack: ResearchPack, shownUrls: string[]): ProductBrief {
  const kind: ProductKind = raw.kind === "physical" || raw.kind === "software" || raw.kind === "service" ? raw.kind : guessKind(pack);
  const visuals: ProductVisual[] = [];
  for (const image of Array.isArray(raw.images) ? raw.images : []) {
    const url = shownUrls[Number(image?.index)];
    if (!url || !image?.shows_product) continue;
    visuals.push({ id: `p${visuals.length + 1}`, kind: "photo", url, caption: text(image.caption, "product photo"), source: "site" });
  }
  return {
    name: text(raw.name, pack.brand.name),
    one_liner: text(raw.one_liner, pack.brand.description),
    kind,
    audience: text(raw.audience),
    problem: text(raw.problem),
    aha: text(raw.aha),
    features: (Array.isArray(raw.features) ? raw.features : [])
      .filter((f) => f && typeof f.name === "string")
      .slice(0, 6)
      .map((f) => ({ name: text(f.name), what_it_does: text(f.what_it_does), how_to_show_it: text(f.how_to_show_it) })),
    claims: strings(raw.claims, 10),
    proof: strings(raw.proof, 6),
    objections: strings(raw.objections, 4),
    offer: text(raw.offer),
    voice: text(raw.voice, "plain and direct"),
    look: text(raw.look),
    visuals,
  };
}

function guessKind(pack: ResearchPack): ProductKind {
  const haystack = `${pack.brand.industry} ${pack.brand.description} ${pack.site_excerpt.slice(0, 2000)}`.toLowerCase();
  if (/\b(api|sdk|saas|software|platform|app|developer|dashboard|cli|agent|integration)\b/.test(haystack)) return "software";
  if (/\b(agency|consult|service|done for you|we help)\b/.test(haystack)) return "service";
  return "physical";
}

export function fallbackBrief(pack: ResearchPack): ProductBrief {
  return {
    name: pack.brand.name,
    one_liner: pack.brand.description || pack.brand.slogan,
    kind: guessKind(pack),
    audience: "",
    problem: "",
    aha: "",
    features: [],
    claims: [pack.brand.slogan, pack.brand.description].filter(Boolean),
    proof: [],
    objections: [],
    offer: "",
    voice: "plain and direct",
    look: "",
    visuals: pack.brand.images.slice(0, 4).map((url, i) => ({ id: `p${i + 1}`, kind: "photo" as const, url, caption: "image from the site", source: "site" })),
  };
}
