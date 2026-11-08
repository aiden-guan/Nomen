import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ImageResponse } from "next/og";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { db, newId, now } from "@/lib/db";
import { buildPackZip } from "@/lib/statics/pack";
import { advancePack, getPack, insertStaticAd, listStaticAds, packDir } from "@/lib/statics/pipeline";
import { imageSize } from "@/lib/statics/render";
import { PLACEMENTS } from "@/lib/statics/specs";
import { artDirection } from "@/lib/statics/study";
import type { Concept } from "@/lib/statics/writer";
import { crc32, zip } from "@/lib/zip";

// Offline: no provider keys, so production renders every size and skips the vision check.

function unzip(bytes: Buffer) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(dataStart, dataStart + size);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return files;
}

describe("zip", () => {
  it("writes entries any unzip can read back", () => {
    const files = unzip(zip([{ name: "a/readme.md", data: Buffer.from("hello ".repeat(50)) }, { name: "b/image.jpg", data: Buffer.from([1, 2, 3, 4]) }]));
    expect(files.get("a/readme.md")?.toString()).toBe("hello ".repeat(50));
    expect([...(files.get("b/image.jpg") ?? [])]).toEqual([1, 2, 3, 4]);
  });
});

describe("a static pack, end to end", () => {
  it("renders every placement and zips a ready-to-upload pack", { timeout: 180_000 }, async () => {
    const brandId = newId("brd");
    const campaignId = newId("cmp");
    const research = {
      domain: "monid.ai",
      brand: { name: "Monid", description: "Tools and APIs for AI agents.", slogan: "One skill unlocks 1,800+ tools & APIs for your agent.", industry: "Software", colors: ["#2d5bff", "#fafaf7", "#070707"], logo: null, socials: [], images: [] },
      site_excerpt: "Connect your agent to every tool it needs.",
      similar_sites: [],
      seo: { domain_rating: null, keywords: [] },
      videos: [],
      ads: [],
      reddit: [],
      aeo: [],
    };
    db().prepare("insert into brands (id, name, domain, url, created_at, updated_at) values (?, 'Monid', 'monid.ai', 'https://monid.ai', ?, ?)").run(brandId, now(), now());
    db()
      .prepare("insert into campaigns (id, brand_id, status, stage, options_json, research_json, created_at, updated_at) values (?, ?, 'review', 'review', '{}', ?, ?, ?)")
      .run(campaignId, brandId, JSON.stringify(research), now(), now());

    const packId = newId("spk");
    mkdirSync(join(packDir(packId), "assets"), { recursive: true });
    const shot = createElement("div", { style: { display: "flex", width: 1920, height: 1080, background: "#fafaf7", alignItems: "center", justifyContent: "center", fontSize: 96, fontWeight: 700 } }, "Connect your agent");
    writeFileSync(join(packDir(packId), "assets", "screenshot.png"), Buffer.from(await new ImageResponse(shot, { width: 1920, height: 1080 }).arrayBuffer()));
    const study = { art: artDirection({ scheme: "white", type_style: "geist", decoration: "none", cta_in_image: false, imagery: "product_ui", archetypes: ["product_ui", "editorial"] }), brand_identity: "", ads: [], patterns_md: "", studied: [], model: "anthropic/claude-opus-5.5", tokens: { input: 0, output: 0 } };
    const search = {
      rsa: { headlines: ["Tools for AI agents", "One skill, every tool", "Monid"], descriptions: ["Give your agent 1,800+ tools and APIs with one skill file.", "Pay per call from one balance."], path1: "agents", path2: "tools" },
      sitelinks: [],
      callouts: ["Pay per call"],
      snippet: { header: "Types", values: [] },
      display: { short_headlines: ["Every tool"], long_headline: "Connect your agent to every tool it needs", descriptions: ["Pay per call from one balance."], business_name: "Monid" },
      pmax: { headlines: ["Every tool", "One skill", "Monid"], long_headlines: [], descriptions: ["Pay per call.", "One balance."], business_name: "Monid" },
    };
    db()
      .prepare(
        `insert into static_packs (id, campaign_id, brand_id, status, stage, options_json, research_json, study_json, search_json, assets_json, created_at, updated_at)
         values (?, ?, ?, 'running', 'produce', '{"concepts":1}', ?, ?, ?, ?, ?, ?)`,
      )
      .run(packId, campaignId, brandId, JSON.stringify({ plan: { search_keywords: ["agent tools"] }, ads: [], search_ads: [], cases: [], screenshot: null, sources: { done: 0, total: 0 } }), JSON.stringify(study), JSON.stringify(search), JSON.stringify({ logo: null, screenshot: "assets/screenshot.png" }), now(), now());
    const concept: Concept = {
      archetype: "product_ui",
      scheme: "white",
      angle: "Show the product",
      copy: { headline: "Connect your agent to *every tool* it needs", subhead: "One skill file. Pay per call.", cta: "Get started" },
      visual: { kind: "screenshot", site_photo: -1, prompt: "" },
      meta: { primary_text: ["Give your agent 1,800+ tools with one skill file.", "Pay per call, from one balance."], headline: "Every tool, one skill", description: "Pay per call", cta: "Learn more" },
      x: { post: "One skill file gives your agent 1,800+ tools.", card_headline: "Every tool your agent needs" },
      reddit: { headline: "Does your agent really need a sign-up for every API?", cta: "Learn More" },
      inspired_by: [],
      why: "Real product UI wins in this category.",
      sources: ["One skill unlocks 1,800+ tools & APIs for your agent."],
    };
    insertStaticAd(packId, 0, concept);

    for (let i = 0; i < 6 && getPack(packId)?.status === "running"; i++) await advancePack(packId);
    expect(getPack(packId)?.status).toBe("ready");
    const [ad] = listStaticAds(packId);
    expect(ad.status).toBe("ready");
    expect(JSON.parse(ad.renders_json!).length).toBe(PLACEMENTS.length);

    const { bytes, count, name } = await buildPackZip(packId);
    expect(count).toBe(1);
    expect(name).toMatch(/^monid-static-ads-\d{4}-\d{2}-\d{2}\.zip$/);
    const files = unzip(bytes);
    const names = [...files.keys()];
    for (const placement of PLACEMENTS) {
      const file = names.find((n) => n.startsWith(`${placement.folder}/`) && n.includes(placement.id));
      expect(file, placement.id).toBeTruthy();
      const data = files.get(file!)!;
      expect(imageSize(data)).toMatchObject({ width: placement.width, height: placement.height });
      expect(data.length).toBeLessThanOrEqual(placement.maxBytes);
    }
    expect(names).toEqual(expect.arrayContaining(["README.md", "meta/ads.csv", "x/posts.csv", "reddit/ads.csv", "google-search/responsive-search-ad.csv", "google-display-pmax/text-assets.csv", "google-display-pmax/logos/logo-1x1.png", "google-display-pmax/logos/logo-4x1.png"]));
    const rsa = files.get("google-search/responsive-search-ad.csv")!.toString().split("\n");
    expect(rsa[0]).toMatch(/^Campaign,Ad group,Headline 1,Headline 2,/);
    expect(rsa[1]).toContain("Tools for AI agents");
    expect(files.get("x/posts.csv")!.toString()).not.toMatch(/#\w/);
    expect(files.get("README.md")!.toString()).toMatch(/No picture was made by an AI image model/);
    rmSync(packDir(packId), { recursive: true, force: true });
  });
});
