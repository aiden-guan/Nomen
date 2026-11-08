import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db, parse } from "../db";
import type { ResearchPack } from "../research";
import { zip, type ZipEntry } from "../zip";
import { adDir, getPack, listStaticAds, packDir, type Render, type VisualState } from "./pipeline";
import type { StaticResearch } from "./research";
import { LIMITS, META_CTAS, PLACEMENTS, SPEC_SOURCES } from "./specs";
import type { Study } from "./study";
import type { SearchAssets } from "./validate";
import type { Concept } from "./writer";

// The download: one folder per platform with the images at the exact sizes, the copy in the
// columns each platform's upload or import screen asks for, and a README that says how to upload
// it and what research it came from.

const csv = (rows: Array<Array<string | number>>) =>
  `${rows.map((row) => row.map((cell) => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell))).join(",")).join("\n")}\n`;

const slug = (text: string) => text.toLowerCase().replace(/\*/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ad";
const plain = (text: string) => text.replace(/\*/g, "");

export async function buildPackZip(packId: string): Promise<{ name: string; bytes: Buffer; count: number }> {
  const pack = getPack(packId);
  if (!pack) throw new Error("No such pack");
  const campaign = db().prepare("select research_json from campaigns where id = ?").get(pack.campaign_id) as { research_json: string | null };
  const researchPack = parse<ResearchPack | null>(campaign.research_json, null);
  if (!researchPack) throw new Error("This campaign has no research");
  const research = parse<StaticResearch | null>(pack.research_json, null);
  const study = parse<Study | null>(pack.study_json, null);
  const search = parse<(SearchAssets & { problems?: string[]; short?: string[] }) | null>(pack.search_json, null);
  const all = listStaticAds(packId).filter((ad) => !ad.rejected && ad.status === "ready");
  const approved = all.filter((ad) => ad.approved);
  const ads = approved.length ? approved : all;
  if (ads.length === 0) throw new Error("No static ads are ready yet");

  const brand = researchPack.brand.name;
  const url = `https://${researchPack.domain}`;
  const entries: ZipEntry[] = [];
  const metaRows: Array<Array<string | number>> = [["Ad Name", "Image", "Placement", "Body", "Body (second version)", "Title", "Link Description", "Link", "Call to Action"]];
  const xRows: Array<Array<string | number>> = [["Ad name", "Image", "Post text", "Website card headline", "Website URL"]];
  const redditRows: Array<Array<string | number>> = [["Ad name", "Image", "Headline", "Call to action", "Destination URL"]];
  const conceptLines: string[] = [];
  let generated = 0;

  for (const [i, ad] of ads.entries()) {
    const concept = parse<Concept>(ad.concept_json, null as unknown as Concept);
    const renders = parse<Render[]>(ad.renders_json, []);
    const visual = parse<VisualState | null>(ad.visual_json, null);
    if (visual?.kind === "generated" && visual.file) generated++;
    const name = `${String(i + 1).padStart(2, "0")}-${slug(concept.copy.headline || concept.archetype)}`;
    for (const r of renders) {
      const placement = PLACEMENTS.find((p) => p.id === r.placement);
      const path = join(adDir(packId, ad.id), r.file);
      if (!placement || !existsSync(path)) continue;
      const file = `${name}-${r.placement}.${r.file.split(".").pop()}`;
      entries.push({ name: `${placement.folder}/${file}`, data: await readFile(path) });
      if (placement.platform === "meta") metaRows.push([`${brand} ${name} ${placement.id}`.slice(0, 35), file, placement.label, concept.meta.primary_text[0] ?? "", concept.meta.primary_text[1] ?? "", concept.meta.headline, concept.meta.description, url, META_CTAS[concept.meta.cta] ?? "LEARN_MORE"]);
      if (placement.platform === "x") xRows.push([name, file, concept.x.post, concept.x.card_headline, url]);
      if (placement.platform === "reddit") redditRows.push([name, file, concept.reddit.headline, concept.reddit.cta, url]);
    }
    const qc = parse<{ score: number } | null>(ad.qc_json, null);
    conceptLines.push(
      `### ${i + 1}. ${plain(concept.copy.headline || concept.archetype)}\n\n- Layout: ${concept.archetype} on ${concept.scheme}; picture: ${visual?.kind ?? "none"}${qc ? `; quality check ${qc.score}/10` : ""}\n- Angle: ${concept.angle}\n- Why: ${concept.why}${concept.inspired_by.length ? `\n- Learns from: ${concept.inspired_by.map((id) => research?.ads.find((a) => a.id === id)).filter(Boolean).map((a) => `[${a!.advertiser}](${a!.url})${a!.signal ? ` (${a!.signal})` : ""}`).join(", ")}` : ""}${concept.sources.length ? `\n- Supported by the site: ${concept.sources.map((s) => `"${s}"`).join("; ")}` : ""}`,
    );
  }

  entries.push({ name: "meta/ads.csv", data: Buffer.from(csv(metaRows)) });
  entries.push({ name: "x/posts.csv", data: Buffer.from(csv(xRows)) });
  entries.push({ name: "reddit/ads.csv", data: Buffer.from(csv(redditRows)) });

  for (const logo of ["logo-1x1.png", "logo-4x1.png"]) {
    const path = join(packDir(packId), "logos", logo);
    if (existsSync(path)) entries.push({ name: `google-display-pmax/logos/${logo}`, data: await readFile(path) });
  }

  if (search) {
    const campaignName = `${brand} - Search`;
    const adGroup = research?.plan.search_keywords[0] ?? "Core";
    const header = ["Campaign", "Ad group", ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `Description ${i + 1}`), "Path 1", "Path 2", "Final URL", "Status"];
    const row = [campaignName, adGroup, ...Array.from({ length: 15 }, (_, i) => search.rsa.headlines[i] ?? ""), ...Array.from({ length: 4 }, (_, i) => search.rsa.descriptions[i] ?? ""), search.rsa.path1, search.rsa.path2, url, "Paused"];
    entries.push({ name: "google-search/responsive-search-ad.csv", data: Buffer.from(csv([header, row])) });
    entries.push({ name: "google-search/sitelinks.csv", data: Buffer.from(csv([["Sitelink text", "Description line 1", "Description line 2", "Final URL"], ...search.sitelinks.map((s) => [s.text, s.line1, s.line2, url])])) });
    entries.push({ name: "google-search/callouts.csv", data: Buffer.from(csv([["Callout text"], ...search.callouts.map((c) => [c])])) });
    if (search.snippet.values.length) entries.push({ name: "google-search/structured-snippet.csv", data: Buffer.from(csv([["Header", "Values"], [search.snippet.header, search.snippet.values.join("; ")]])) });
    const text: Array<Array<string | number>> = [["Asset", "Text", "Characters", "Limit"]];
    search.display.short_headlines.forEach((h) => text.push(["Display headline", h, h.length, LIMITS.display.shortHeadlines.chars]));
    if (search.display.long_headline) text.push(["Display long headline", search.display.long_headline, search.display.long_headline.length, LIMITS.display.longHeadline]);
    search.display.descriptions.forEach((d) => text.push(["Display and Performance Max description", d, d.length, LIMITS.display.descriptions.chars]));
    search.pmax.headlines.forEach((h) => text.push(["Performance Max headline", h, h.length, LIMITS.pmax.headlines.chars]));
    search.pmax.long_headlines.forEach((h) => text.push(["Performance Max long headline", h, h.length, LIMITS.pmax.longHeadlines.chars]));
    text.push(["Business name", search.display.business_name || brand, (search.display.business_name || brand).length, LIMITS.display.businessName]);
    entries.push({ name: "google-display-pmax/text-assets.csv", data: Buffer.from(csv(text)) });
  }

  entries.push({ name: "README.md", data: Buffer.from(readme({ brand, url, conceptLines, research, study, search, generated, count: ads.length, approvedOnly: approved.length > 0 })) });
  const date = new Date().toISOString().slice(0, 10);
  return { name: `${slug(brand)}-static-ads-${date}.zip`, bytes: zip(entries), count: ads.length };
}

function readme(input: { brand: string; url: string; conceptLines: string[]; research: StaticResearch | null; study: Study | null; search: (SearchAssets & { problems?: string[]; short?: string[] }) | null; generated: number; count: number; approvedOnly: boolean }) {
  const { brand, research, study, search } = input;
  const studied = (study?.studied ?? []).map((id) => research?.ads.find((a) => a.id === id)).filter(Boolean);
  const placements = PLACEMENTS.map((p) => `| ${p.platform} | \`${p.folder}/\` | ${p.label} | ${p.width}×${p.height} | ${Math.round(p.maxBytes / 1024 / 1024 * 10) / 10} MB | [source](${p.source}) |`).join("\n");
  return `# ${brand} static ad pack

${input.count} ${input.approvedOnly ? "approved " : ""}concepts, each rendered at every size Google, Meta, X and Reddit recommend, with the copy each platform asks for. Made by Nomen on ${new Date().toISOString().slice(0, 10)}.

## What is in each folder

- \`meta/\`: Facebook and Instagram images (4:5 feed, 1:1, 9:16 Stories and Reels with Meta's safe zones kept clear) and \`ads.csv\` with the primary text, headline, description and button for each image, in Ads Manager's column names. In Ads Manager, create a single-image ad and upload the image; or bulk-import with the sheet after adding your Page and ad set columns ([Meta's import guide](${SPEC_SOURCES.metaBulk})).
- \`x/\`: 1:1 and 1.91:1 images and \`posts.csv\` with the post text (no hashtags: X does not allow them in ads) and the website card headline.
- \`reddit/\`: 4:5, 4:3 and 1:1 images under Reddit's 3 MB limit and \`ads.csv\` with a headline and button per ad.
- \`google-search/\`: \`responsive-search-ad.csv\` in Google Ads Editor's import columns (Account > Import > From file; the ad imports paused), plus sitelinks, callouts and a structured snippet. Set each sitelink to the page it describes.
- \`google-display-pmax/\`: \`images/\` holds pictures with no text on them, as Google's display guidance asks (responsive display ads, Demand Gen and Performance Max); \`designed-for-pmax/\` holds the designed versions for Performance Max asset groups, without drawn buttons; \`logos/\` holds the 1:1 and 4:1 logos; \`text-assets.csv\` holds the headlines, long headlines and descriptions with their character counts.

## The concepts

${input.conceptLines.join("\n\n")}

## How the ads were made

1. **Research.** Nomen pulled ${research?.sources.done ?? 0} of ${research?.sources.total ?? 0} sources: image ads in Meta's ad library ranked by impressions, competitors' and category leaders' image posts on X with their views and engagement, Google display ads from the Ads Transparency Center, the paid search ads on ${research?.plan.search_keywords.map((k) => `"${k}"`).join(" and ") || "the category's searches"}${research?.plan.b2b ? ", LinkedIn's ad library" : ""}, agency case studies and a screenshot of ${input.url}. Ad libraries do not publish results for commercial ads, so ads are ranked by the signals they do publish: impression rank, days running, number of versions, and on X views and engagement.
2. **Study.** A vision model looked at the brand's own site and the ${studied.length} best-ranked ads and set the art direction below.
3. **Copy.** Every number, quote, offer and command in the copy was checked against the brand's own site text; lines that failed were rewritten or dropped. Google text was checked for its editorial rules (no exclamation marks, emoji, repeated punctuation or shouting capitals).
4. **Images.** Every size is drawn from the same layout with real fonts, so the type is exact and sharp.${input.generated ? ` ${input.generated} concept${input.generated > 1 ? "s use" : " uses"} a picture made with an AI image model; check it before running.` : " No picture was made by an AI image model: the pictures are the brand's own site and photos."} A vision check looked at the finished 4:5 and 1.91:1 images of every concept.

${study ? `### Art direction\n\n- Ground: ${study.art.scheme} (second ground: ${study.art.alt_scheme}); type: ${study.art.type_style}; decoration: ${study.art.decoration}; button in the image: ${study.art.cta_in_image ? "yes" : "no"}; imagery: ${study.art.imagery.replace("_", " ")}\n- ${study.art.notes}\n- The brand on its own site: ${study.brand_identity}\n\n${study.patterns_md}\n` : ""}
### Ads studied

${studied.map((a, i) => `${i + 1}. [${a!.advertiser}](${a!.url}) on ${a!.source}${a!.signal ? `: ${a!.signal}` : ""}`).join("\n") || "None had downloadable images."}

${research?.cases.length ? `### Case studies found\n\n${research.cases.map((c) => `- [${c.title}](${c.url})`).join("\n")}\n` : ""}
${search?.short?.length ? `### Google assets to complete\n\n${search.short.map((s) => `- ${s}`).join("\n")}\n` : ""}
## Specs used

Checked against each platform's own help pages on 2026-11-08.

| Platform | Folder | Placement | Pixels | Max file | Source |
| --- | --- | --- | --- | --- | --- |
${placements}

Text limits: Google responsive search ads take 3-15 headlines of 30 characters and 2-4 descriptions of 90 ([source](${SPEC_SOURCES.rsa})); Meta shows 125 characters of primary text and a 40-character headline on Instagram feed ([source](${SPEC_SOURCES.metaFeed})); X posts are 280 weighted characters and card headlines 70 ([source](${SPEC_SOURCES.xCounting})); Reddit headlines are up to 300 characters, 100 or fewer recommended ([source](${SPEC_SOURCES.reddit})).
`;
}
