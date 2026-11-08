import type { NaiveClient } from "../naive";
import { extractJson, type ResearchPack } from "../research";
import { getBool, getSetting } from "../settings";
import type { Strategy } from "../strategy";
import { ARCHETYPES, type AdCopy, type Archetype, SCHEMES, type Scheme } from "./layouts";
import type { StaticResearch } from "./research";
import { LIMITS, META_CTAS, REDDIT_CTAS, SNIPPET_HEADERS } from "./specs";
import type { Study } from "./study";
import { appearsIn, checkSearchAssets, cleanXPost, type SearchAssets, slopIn, stripEmoji, unsupportedNumbers } from "./validate";

// The copywriter: concepts with their on-image copy and the copy each platform asks for, then the
// Google text assets. Two calls through Naive's model proxy, in parallel, each forced into a schema.
// Everything it returns is checked; a concept that fails is sent back once with the problems.

export type Concept = {
  archetype: Archetype;
  scheme: Scheme;
  angle: string;
  copy: AdCopy;
  visual: { kind: "screenshot" | "site_photo" | "generated" | "none"; site_photo: number; prompt: string };
  meta: { primary_text: string[]; headline: string; description: string; cta: string };
  x: { post: string; card_headline: string };
  reddit: { headline: string; cta: string };
  inspired_by: string[];
  why: string;
  sources: string[];
  problems?: string[];
};

export type WriterInput = {
  pack: ResearchPack;
  strategy: Strategy | null;
  research: StaticResearch;
  study: Study;
  concepts: number;
  hasScreenshot: boolean;
};

const RULES = `You write static ads for performance marketing teams: the copy on the image and the copy each platform asks for. Your ads must read as if the brand's best in-house team made them. Follow the art direction you are given: it comes from a study of the ads that perform best in this category.

Facts
- Every claim comes from the brand's own site text, which you are given. Put the exact supporting snippets in sources.
- A number (counts, prices, percentages, times) must appear in the site text exactly as you write it. Never invent statistics, prices, ratings, reviews, awards, customer names or results.
- quote: only words copied verbatim from the site, with the source the site gives. If the site has no quote, do not use the quote layout.
- offer: only an offer the site states, copied exactly. If none, do not use the offer layout.
- code: only commands that appear in the site text, each line starting with "$ ". Never invent output.
- chat: the prompt is something a customer would type; the reply says only what the site says the product does, with no invented results or numbers.
- Never name, show or disparage a competitor. In comparisons, label the other side generically ("Without {Brand}", "The usual way").

Craft
- One idea per ad. Headlines: 2 to 8 words, at most 60 characters, specific to this brand; a headline that would fit any brand is a failure. You may mark one key phrase of 1 to 3 words with *asterisks*; it is drawn in the brand color.
- Sentence case unless the art direction says otherwise. No exclamation marks in image copy. No emoji anywhere.
- Plain, concrete words. Never use: unlock, unleash, supercharge, revolutionize, elevate, game-changer, seamless, harness, leverage, cutting-edge, next-level, empower, transform your, take your, dive in, journey, effortless, skyrocket, magic, one-stop, best-in-class, state-of-the-art (unless the brand's own site uses the word).
- Make the concepts visually distinct from one another: different layouts, and alternate the ground between the main and the second scheme of the art direction.
- Pictures: "screenshot" shows the brand's real website in a browser window (software and online products); "site_photo" uses one of the brand's own photos by index; "none" is for type, stat, code, chat and comparison layouts; "generated" asks an image model for a photo and is only for physical products when no site photo fits. Never generate pictures of software, screens or people's faces.

Platforms
- Meta: two primary texts of at most 125 characters (the first sentence is the hook), a headline of at most 40 characters (27 reads best on Facebook), a description of at most 30, and one of the listed buttons.
- X: one post of 50 to 100 characters with one message; no hashtags (X does not allow them in ads). Card headline at most 70 characters.
- Reddit: a headline people would write themselves: conversational, a question or "you", at most 100 characters, different for every concept. Reddit users respond to plain talk, not slogans.`;

const S = { type: "string" } as const;
const SA = { type: "array", items: S } as const;

const CONCEPT_TOOL = {
  name: "static_concepts",
  description: "Record the static ad concepts.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["concepts"],
    properties: {
      concepts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "archetype", "scheme", "angle", "headline", "subhead", "eyebrow", "cta", "bullets", "stat_value", "stat_label", "quote_text", "quote_source",
            "comparison_theirs_label", "comparison_theirs", "comparison_ours", "offer", "fineprint", "code_title", "code_lines", "chat_prompt", "chat_reply",
            "visual", "site_photo", "image_prompt", "meta_primary_text", "meta_headline", "meta_description", "meta_cta", "x_post", "x_card_headline",
            "reddit_headline", "reddit_cta", "inspired_by", "why", "sources",
          ],
          properties: {
            archetype: { type: "string", enum: [...ARCHETYPES] },
            scheme: { type: "string", enum: [...SCHEMES] },
            angle: S,
            headline: S,
            subhead: { type: "string", description: "At most 110 characters, or empty." },
            eyebrow: { type: "string", description: "A short label (at most 24 characters), or empty." },
            cta: { type: "string", description: "Call to action, at most 18 characters, e.g. 'Get started'." },
            bullets: { ...SA, description: "benefits layout: exactly 3, each at most 38 characters; otherwise empty." },
            stat_value: { type: "string", description: "stat layout: the number as the site states it, at most 10 characters; otherwise empty." },
            stat_label: S,
            quote_text: S,
            quote_source: S,
            comparison_theirs_label: S,
            comparison_theirs: { ...SA, description: "comparison layout: 3 short items, at most 32 characters each." },
            comparison_ours: { ...SA, description: "comparison layout: 3 short items, at most 32 characters each." },
            offer: S,
            fineprint: S,
            code_title: S,
            code_lines: { ...SA, description: "code layout: commands copied from the site, each starting with '$ '." },
            chat_prompt: S,
            chat_reply: S,
            visual: { type: "string", enum: ["screenshot", "site_photo", "generated", "none"] },
            site_photo: { type: "integer", description: "Index of the site photo to use, or -1." },
            image_prompt: { type: "string", description: "Only for generated: a photographic brief with no text, logos or screens. Otherwise empty." },
            meta_primary_text: { ...SA, description: "Two primary texts, at most 125 characters each." },
            meta_headline: S,
            meta_description: S,
            meta_cta: { type: "string", enum: Object.keys(META_CTAS) },
            x_post: S,
            x_card_headline: S,
            reddit_headline: S,
            reddit_cta: { type: "string", enum: [...REDDIT_CTAS] },
            inspired_by: { type: "array", items: { type: "integer" }, description: "Numbers of the researched ads this concept learns from." },
            why: { type: "string", description: "Why this concept should perform, citing the research, in one or two sentences." },
            sources: { ...SA, description: "Exact snippets from the site text that support each claim." },
          },
        },
      },
    },
  },
};

const SEARCH_TOOL = {
  name: "google_text_assets",
  description: "Record the Google Ads text assets.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["rsa_headlines", "rsa_descriptions", "path1", "path2", "sitelinks", "callouts", "snippet_header", "snippet_values", "display_short_headlines", "display_long_headline", "display_descriptions", "business_name", "pmax_long_headlines"],
    properties: {
      rsa_headlines: { ...SA, description: "15 headlines, each at most 30 characters, unique, varied in length (several under 20), at least three containing the main keyword, one with the brand name. No exclamation marks." },
      rsa_descriptions: { ...SA, description: "4 descriptions, each at most 90 characters." },
      path1: { type: "string", description: "Display path, at most 15 characters, lowercase, no spaces." },
      path2: S,
      sitelinks: {
        type: "array",
        description: "4 sitelinks to real pages: text at most 25 characters, two description lines at most 35 each.",
        items: { type: "object", additionalProperties: false, required: ["text", "line1", "line2"], properties: { text: S, line1: S, line2: S } },
      },
      callouts: { ...SA, description: "6 callouts, each at most 25 characters, no exclamation marks." },
      snippet_header: { type: "string", enum: [...SNIPPET_HEADERS] },
      snippet_values: { ...SA, description: "3 to 6 values, each at most 25 characters." },
      display_short_headlines: { ...SA, description: "5 headlines, at most 30 characters each." },
      display_long_headline: { type: "string", description: "At most 90 characters." },
      display_descriptions: { ...SA, description: "5 descriptions, at most 90 characters each; make one 60 or fewer." },
      business_name: { type: "string", description: "At most 25 characters." },
      pmax_long_headlines: { ...SA, description: "5 long headlines, at most 90 characters each." },
    },
  },
};

/** The text every fact must come from: the site, its profile, and the strategist's site-sourced proof points. */
export function siteCorpus(pack: ResearchPack, strategy: Strategy | null) {
  return [pack.brand.name, pack.brand.slogan, pack.brand.description, pack.site_excerpt, ...(strategy?.brand.proof_points ?? []), ...(strategy?.brand.value_props ?? [])].filter(Boolean).join("\n");
}

function context(input: WriterInput) {
  const { pack, strategy, research, study } = input;
  const ads = research.ads.slice(0, 24).map((ad, i) => ({ n: i + 1, source: ad.source, role: ad.role, advertiser: ad.advertiser, headline: ad.headline, text: ad.text.slice(0, 220), cta: ad.cta, signal: ad.signal }));
  return [
    `Brand: ${pack.brand.name} (${pack.domain}). Slogan on the site: ${pack.brand.slogan || "none"}.`,
    `Site text (the only source of facts):\n<site>\n${pack.brand.description}\n\n${pack.site_excerpt.slice(0, 7000)}\n</site>`,
    strategy ? `The strategist's brief (built from the same site): ${JSON.stringify({ one_liner: strategy.brand.one_liner, value_props: strategy.brand.value_props, proof_points: strategy.brand.proof_points, tone: strategy.brand.tone, audience: strategy.audience.map((a) => ({ name: a.name, pains: a.pains })) })}` : "",
    `Site photos you may use as site_photo (by index): ${JSON.stringify(pack.brand.images.slice(0, 8).map((url, i) => ({ i, url })))}${input.hasScreenshot ? ". A screenshot of the homepage is available as visual 'screenshot'." : ". No screenshot is available."}`,
    `Art direction, from the study of the best-performing ads (follow it):\n${JSON.stringify(study.art)}\nThe brand on its own site: ${study.brand_identity}`,
    `What the study found:\n${study.patterns_md.slice(0, 5000)}`,
    `The researched ads, ranked by their published signals (cite them by n in inspired_by):\n${JSON.stringify(ads)}`,
    research.search_ads.length ? `Paid search ads competitors run on the category's searches:\n${JSON.stringify(research.search_ads.slice(0, 12))}` : "",
    research.cases.length ? `Agency case studies and breakdowns found on the web:\n${JSON.stringify(research.cases.slice(0, 5))}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function writeConcepts(naive: NaiveClient, input: WriterInput, fix?: { concepts: Concept[]; problems: string[][] }) {
  const model = getSetting("static_model");
  const ask = fix
    ? `These concepts failed the checks. Return ${fix.concepts.length} corrected concepts in the same order, fixing every problem listed and keeping what works.\n${JSON.stringify(fix.concepts.map((c, i) => ({ concept: { archetype: c.archetype, headline: c.copy.headline, angle: c.angle }, problems: fix.problems[i] })))}`
    : `Write ${input.concepts} concepts. Use the art direction's archetypes, best first, and make each concept a different layout.${getBool("static_ai_images") ? "" : " Generated pictures are switched off: use screenshot, site_photo or none."}`;
  const reply = await naive.messageStream({ model, max_tokens: 16000, system: RULES, messages: [{ role: "user", content: `${context(input)}\n\n${ask}\n\nCall the static_concepts tool exactly once.` }], tools: [CONCEPT_TOOL] });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === CONCEPT_TOOL.name);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as { concepts?: unknown[] } | null;
  const ids = input.research.ads.slice(0, 24).map((ad) => ad.id);
  return { concepts: (raw?.concepts ?? []).map((entry) => toConcept(entry, ids)), tokens: usage(reply.usage) };
}

export async function writeSearchAssets(naive: NaiveClient, input: WriterInput) {
  const model = getSetting("static_model");
  const keywords = [...(input.research.plan.search_keywords ?? []), ...input.pack.seo.keywords.slice(0, 8).map((k) => k.keyword)];
  const reply = await naive.messageStream(
    {
      model,
      max_tokens: 10000,
      system: `${RULES}\n\nGoogle: no exclamation marks, no emoji, no repeated punctuation, no words in capitals unless the brand writes them that way, no phone numbers. Sitelinks point at pages the site has.`,
      messages: [{ role: "user", content: `${context(input)}\n\nKeywords to win: ${JSON.stringify(keywords)}\n\nWrite the Google Ads text assets: a responsive search ad, sitelinks, callouts, a structured snippet, responsive display ad text and Performance Max long headlines. Call the google_text_assets tool exactly once.` }],
      tools: [SEARCH_TOOL],
    },
  );
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === SEARCH_TOOL.name);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Record<string, unknown> | null;
  const r = raw ?? {};
  const list = (key: string) => (Array.isArray(r[key]) ? (r[key] as unknown[]).map(String) : []);
  const assets: SearchAssets = {
    rsa: { headlines: list("rsa_headlines"), descriptions: list("rsa_descriptions"), path1: String(r.path1 ?? ""), path2: String(r.path2 ?? "") },
    sitelinks: (Array.isArray(r.sitelinks) ? r.sitelinks : []).map((s) => ({ text: String((s as Record<string, unknown>).text ?? ""), line1: String((s as Record<string, unknown>).line1 ?? ""), line2: String((s as Record<string, unknown>).line2 ?? "") })),
    callouts: list("callouts"),
    snippet: { header: String(r.snippet_header ?? "Types"), values: list("snippet_values") },
    display: { short_headlines: list("display_short_headlines"), long_headline: String(r.display_long_headline ?? ""), descriptions: list("display_descriptions"), business_name: String(r.business_name ?? input.pack.brand.name) },
    // Performance Max takes the same 30-character headlines as search, and the display descriptions.
    pmax: { headlines: list("rsa_headlines"), long_headlines: list("pmax_long_headlines"), descriptions: list("display_descriptions"), business_name: String(r.business_name ?? input.pack.brand.name) },
  };
  return { assets, tokens: usage(reply.usage) };
}

const usage = (u?: { input_tokens?: number; output_tokens?: number }) => ({ input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0 });

function toConcept(entry: unknown, adIds: string[]): Concept {
  const e = (entry ?? {}) as Record<string, unknown>;
  const s = (key: string) => stripEmoji(typeof e[key] === "string" ? (e[key] as string) : "");
  const list = (key: string) => (Array.isArray(e[key]) ? (e[key] as unknown[]).map((x) => stripEmoji(String(x))).filter(Boolean) : []);
  const archetype = (ARCHETYPES as readonly string[]).includes(s("archetype")) ? (s("archetype") as Archetype) : "editorial";
  const visualKind = ["screenshot", "site_photo", "generated", "none"].includes(s("visual")) ? (s("visual") as Concept["visual"]["kind"]) : "none";
  return {
    archetype,
    scheme: (SCHEMES as readonly string[]).includes(s("scheme")) ? (s("scheme") as Scheme) : "white",
    angle: s("angle"),
    copy: {
      headline: s("headline"),
      subhead: s("subhead") || undefined,
      eyebrow: s("eyebrow") || undefined,
      cta: s("cta") || "Learn more",
      bullets: list("bullets").slice(0, 3),
      stat: s("stat_value") ? { value: s("stat_value"), label: s("stat_label") } : undefined,
      quote: s("quote_text") ? { text: s("quote_text"), source: s("quote_source") } : undefined,
      comparison: list("comparison_ours").length ? { theirsLabel: s("comparison_theirs_label") || "The usual way", theirs: list("comparison_theirs").slice(0, 4), ours: list("comparison_ours").slice(0, 4) } : undefined,
      offer: s("offer") || undefined,
      fineprint: s("fineprint") || undefined,
      code: list("code_lines").length ? { title: s("code_title") || "terminal", lines: list("code_lines").slice(0, 8) } : undefined,
      chat: s("chat_prompt") ? { prompt: s("chat_prompt"), reply: [s("chat_reply")] } : undefined,
    },
    visual: { kind: visualKind, site_photo: Number.isInteger(e.site_photo) ? Number(e.site_photo) : -1, prompt: s("image_prompt") },
    meta: { primary_text: list("meta_primary_text").slice(0, 2), headline: s("meta_headline"), description: s("meta_description"), cta: META_CTAS[s("meta_cta")] ? s("meta_cta") : "Learn more" },
    x: { post: cleanXPost(s("x_post")).text, card_headline: s("x_card_headline") },
    reddit: { headline: s("reddit_headline"), cta: (REDDIT_CTAS as readonly string[]).includes(s("reddit_cta")) ? s("reddit_cta") : "Learn More" },
    inspired_by: (Array.isArray(e.inspired_by) ? e.inspired_by : []).map((n) => adIds[Number(n) - 1]).filter(Boolean),
    why: s("why"),
    sources: list("sources"),
  };
}

/**
 * Problems that would make a concept untrue, broken or off-spec. Fixable ones are sent back to the
 * writer once; whatever still fails is downgraded (a stat with an unsupported number becomes a
 * plain headline, for instance) rather than shipped.
 */
export function conceptProblems(c: Concept, corpus: string, opts: { hasScreenshot: boolean; photos: number }): string[] {
  const p: string[] = [];
  const onImage = [c.copy.headline, c.copy.subhead, c.copy.eyebrow, c.copy.cta, ...(c.copy.bullets ?? []), c.copy.stat?.value, c.copy.stat?.label, c.copy.offer, ...(c.copy.comparison?.ours ?? []), ...(c.copy.comparison?.theirs ?? []), c.copy.chat?.reply.join(" ")].filter(Boolean).join(" \n ");
  const social = [...c.meta.primary_text, c.meta.headline, c.meta.description, c.x.post, c.x.card_headline, c.reddit.headline].join(" \n ");
  for (const n of unsupportedNumbers(`${onImage}\n${social}`, corpus)) p.push(`the number ${n} is not on the site`);
  for (const phrase of slopIn(`${onImage}\n${social}`, corpus)) p.push(`"${phrase}" reads generic`);
  // Anything that looks like code (a call, a path) reads as a real API; it must be on the site.
  for (const token of codeTokens(onImage)) if (!appearsIn(token, corpus)) p.push(`"${token}" looks like code and is not on the site`);
  if (c.copy.code?.title && c.copy.code.title !== "terminal" && !appearsIn(c.copy.code.title, corpus)) p.push(`the terminal title "${c.copy.code.title}" is not on the site`);
  if (!c.copy.headline && c.archetype !== "quote") p.push("no headline");
  if (c.copy.headline.replace(/\*/g, "").length > 60) p.push(`headline is ${c.copy.headline.length} characters (limit 60)`);
  if ((c.copy.subhead ?? "").length > 110) p.push("subhead over 110 characters");
  if (c.copy.cta.length > 18) p.push("call to action over 18 characters");
  if (/!/.test(onImage)) p.push("exclamation mark on the image");
  if (c.archetype === "quote" && !(c.copy.quote && appearsIn(c.copy.quote.text, corpus))) p.push("the quote is not word for word from the site");
  if (c.archetype === "offer" && !(c.copy.offer && appearsIn(c.copy.offer, corpus))) p.push("the offer is not stated on the site");
  if (c.archetype === "stat" && !c.copy.stat?.value) p.push("stat layout without a number");
  if (c.archetype === "benefits" && (c.copy.bullets?.length ?? 0) < 3) p.push("benefits layout needs 3 bullets");
  if (c.archetype === "benefits" && (c.copy.bullets ?? []).some((b) => b.length > 38)) p.push("a bullet is over 38 characters");
  if (c.archetype === "comparison" && ((c.copy.comparison?.ours.length ?? 0) < 2 || (c.copy.comparison?.theirs.length ?? 0) < 2)) p.push("comparison needs at least 2 items a side");
  if (c.archetype === "code") {
    const lines = c.copy.code?.lines ?? [];
    if (!lines.length) p.push("code layout without commands");
    for (const line of lines) if (!appearsIn(line.replace(/^\$\s*/, ""), corpus)) p.push(`the line "${line}" is not on the site`);
  }
  if (c.archetype === "chat" && !c.copy.chat?.prompt) p.push("chat layout without a prompt");
  if (c.archetype === "product_ui" && !opts.hasScreenshot) p.push("product_ui needs the screenshot, which is missing");
  if (c.visual.kind === "site_photo" && (c.visual.site_photo < 0 || c.visual.site_photo >= opts.photos)) p.push("site_photo index does not exist");
  if (c.visual.kind === "screenshot" && !opts.hasScreenshot) p.push("no screenshot is available");
  if (c.meta.primary_text.some((t) => t.length > LIMITS.meta.primaryText)) p.push(`a Meta primary text is over ${LIMITS.meta.primaryText} characters`);
  if (c.meta.headline.length > LIMITS.meta.headline) p.push(`Meta headline over ${LIMITS.meta.headline} characters`);
  if (c.meta.description.length > LIMITS.meta.description) p.push(`Meta description over ${LIMITS.meta.description} characters`);
  if (cleanXPost(c.x.post).weighted > LIMITS.x.post) p.push("X post over 280 characters");
  if (c.x.card_headline.length > LIMITS.x.cardHeadline) p.push(`X card headline over ${LIMITS.x.cardHeadline} characters`);
  if (c.reddit.headline.length > LIMITS.reddit.headline) p.push("Reddit headline over 300 characters");
  return p;
}

/** Makes a concept safe when the writer could not fix it: drop what is unsupported, keep what is true. */
export function downgrade(c: Concept, corpus: string, opts: { hasScreenshot: boolean; photos: number }): Concept | null {
  const fixed: Concept = JSON.parse(JSON.stringify(c));
  const fails = (text?: string) => Boolean(text && unsupportedNumbers(text, corpus).length);
  if (!(fixed.copy.quote && appearsIn(fixed.copy.quote.text, corpus))) {
    if (fixed.archetype === "quote") fixed.archetype = "editorial";
    fixed.copy.quote = undefined;
  }
  if (!(fixed.copy.offer && appearsIn(fixed.copy.offer, corpus))) {
    if (fixed.archetype === "offer") fixed.archetype = "editorial";
    fixed.copy.offer = undefined;
    fixed.copy.fineprint = undefined;
  }
  if (!fixed.copy.stat?.value || fails(`${fixed.copy.stat.value} ${fixed.copy.stat.label}`)) {
    if (fixed.archetype === "stat") fixed.archetype = "editorial";
    fixed.copy.stat = undefined;
  }
  if (fixed.copy.comparison && [...fixed.copy.comparison.ours, ...fixed.copy.comparison.theirs].some((item) => fails(item))) {
    if (fixed.archetype === "comparison") fixed.archetype = "editorial";
    fixed.copy.comparison = undefined;
  }
  if (fixed.archetype === "code") {
    const lines = (fixed.copy.code?.lines ?? []).filter((line) => appearsIn(line.replace(/^\$\s*/, ""), corpus));
    if (lines.length) fixed.copy.code = { title: fixed.copy.code?.title, lines };
    else fixed.archetype = "editorial";
  }
  if (fixed.archetype === "product_ui" && !opts.hasScreenshot) fixed.archetype = "editorial";
  if (fixed.copy.code?.title && !appearsIn(fixed.copy.code.title, corpus)) fixed.copy.code = { ...fixed.copy.code, title: undefined };
  const invented = (text?: string) => Boolean(text && codeTokens(text).some((token) => !appearsIn(token, corpus)));
  if (invented(fixed.copy.eyebrow)) fixed.copy.eyebrow = undefined;
  if (invented(fixed.copy.subhead)) fixed.copy.subhead = undefined;
  if (fixed.visual.kind === "screenshot" && !opts.hasScreenshot) fixed.visual.kind = "none";
  if (fixed.visual.kind === "site_photo" && (fixed.visual.site_photo < 0 || fixed.visual.site_photo >= opts.photos)) fixed.visual.kind = "none";
  fixed.copy.subhead = fails(fixed.copy.subhead) ? undefined : fixed.copy.subhead;
  fixed.copy.bullets = (fixed.copy.bullets ?? []).filter((b) => !fails(b));
  fixed.meta.primary_text = fixed.meta.primary_text.filter((t) => !fails(t) && t.length <= LIMITS.meta.primaryText);
  if (fails(fixed.copy.headline) || !fixed.copy.headline || fixed.copy.headline.replace(/\*/g, "").length > 60) return null;
  const left = conceptProblems(fixed, corpus, opts).filter((problem) => !/reads generic/.test(problem));
  return left.length ? null : fixed;
}

/** Tokens that read as code: calls like monid.discover() and paths like ~/agents/bot. */
export function codeTokens(text: string): string[] {
  return [...text.matchAll(/[\w$.-]+\([^)\s]*\)|(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)+/g)].map((m) => m[0]);
}

export function checkAll(concepts: Concept[], corpus: string, opts: { hasScreenshot: boolean; photos: number }) {
  return concepts.map((c) => ({ ...c, problems: conceptProblems(c, corpus, opts) }));
}

export { checkSearchAssets };
