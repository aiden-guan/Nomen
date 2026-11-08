import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { palette } from "@/lib/statics/color";
import { fitText, hasGlyphs, textWidth } from "@/lib/statics/fonts";
import { type AdCopy, type AdInput, ARCHETYPES, type Archetype, type Look, type LogoAsset, parseEmphasis, type Scheme, type VisualAsset } from "@/lib/statics/layouts";
import type { TypeStyle } from "@/lib/statics/fonts";
import { dataUri, imageSize, logoAsset, renderPng, visualAsset } from "@/lib/statics/render";

// Renders every layout at every shape. Set NOMEN_PREVIEW_DIR to write the PNGs somewhere you can
// look at them, and NOMEN_PREVIEW_ASSETS to a folder with visual.(png|jpg) and logo.png to use a
// real product photo and logo instead of the synthetic ones.

const SIZES: Array<[number, number]> = [
  [1080, 1080],
  [1440, 1800],
  [1440, 2560],
  [1200, 628],
  [1440, 1080],
];

const COPY: Record<Archetype, AdCopy> = {
  editorial: { headline: "A new kind of *soda*", subhead: "Prebiotics, plant fiber and botanicals in every can.", cta: "Shop now", eyebrow: "New flavors" },
  product_ui: { headline: "Your favorite flavors, delivered", cta: "Shop now" },
  code: { headline: "Soda, as code", cta: "Learn more", code: { title: "terminal", lines: ["$ order --flavor vintage-cola", "Added 12 cans to your cart"] } },
  chat: { headline: "Ask for a flavor", cta: "Shop now", chat: { prompt: "Which flavor tastes most like classic root beer?", reply: ["Classic Root Beer is made to taste like the soda you grew up with."] } },
  hero: { headline: "The feel-good soda with 9g of fiber", subhead: "Classic flavors, 5g of sugar or less.", cta: "Shop now", eyebrow: "Prebiotic soda" },
  benefits: { headline: "Everything you miss about soda", cta: "Try the variety pack", bullets: ["9g of plant fiber", "2–5g of sugar", "Real fruit juice and botanicals"] },
  comparison: { headline: "Soda, rethought", cta: "Shop now", comparison: { theirsLabel: "Regular soda", theirs: ["39g of sugar", "No fiber", "Artificial colors"], ours: ["2–5g of sugar", "9g of fiber", "Plant-based ingredients"] } },
  statement: { headline: "A new kind of soda", subhead: "Prebiotics, plant fiber and botanicals in every can.", cta: "Find your flavor", eyebrow: "Olipop" },
  stat: { headline: "Fiber you can actually taste the fun in", cta: "Shop now", stat: { value: "9g", label: "of plant fiber per can" } },
  quote: { headline: "", cta: "Shop now", quote: { text: "It tastes like the soda I grew up with, minus the sugar crash.", source: "Customer review on drinkolipop.com" } },
  offer: { headline: "Stock up on your favorites", cta: "Shop the bundle", offer: "Free shipping over $35", fineprint: "Contiguous US only." },
  native: { headline: "ok the vintage cola one is actually so good", cta: "Learn more" },
};

async function syntheticVisual(): Promise<VisualAsset> {
  const el = createElement(
    "div",
    { style: { display: "flex", width: 1024, height: 1024, background: "linear-gradient(135deg, #f6d365 0%, #fda085 100%)", alignItems: "center", justifyContent: "center" } },
    createElement("div", { style: { display: "flex", width: 420, height: 640, borderRadius: 60, background: "#2b7a4b" } }),
  );
  const bytes = Buffer.from(await new ImageResponse(el, { width: 1024, height: 1024 }).arrayBuffer());
  return { src: dataUri(bytes, "image/png"), width: 1024, height: 1024 };
}

const SYNTHETIC_LOGO: LogoAsset = {
  src: dataUri(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 80"><rect width="300" height="80" rx="16" fill="none"/><circle cx="40" cy="40" r="28" fill="#034638"/><rect x="84" y="22" width="190" height="36" rx="8" fill="#034638"/></svg>'), "image/svg+xml"),
  width: 300,
  height: 80,
  tone: "dark",
  opaque: false,
};

type Preset = { name: string; domain?: string; colors: string[]; types?: TypeStyle[]; schemes?: Scheme[]; look?: Look; visualKind?: "photo" | "screenshot"; copy?: Partial<Record<Archetype, AdCopy>> };

async function assets(): Promise<{ visual: VisualAsset; logo: LogoAsset; preset: Preset }> {
  const dir = process.env.NOMEN_PREVIEW_ASSETS;
  const olipop: Preset = { name: "Olipop", colors: ["#034638", "#3a3a3a", "#d776a5", "#5a0c3a"] };
  if (dir) {
    const visualFile = ["visual.jpg", "visual.png"].map((name) => join(dir, name)).find(existsSync);
    const logoFile = ["logo.png", "logo.svg"].map((name) => join(dir, name)).find(existsSync);
    const presetFile = join(dir, "brand.json");
    const preset = existsSync(presetFile) ? (JSON.parse(readFileSync(presetFile, "utf8")) as Preset) : olipop;
    if (visualFile && logoFile) return { visual: await visualAsset(readFileSync(visualFile)), logo: await logoAsset(readFileSync(logoFile)), preset };
  }
  return { visual: await syntheticVisual(), logo: SYNTHETIC_LOGO, preset: olipop };
}

describe("text measurement", () => {
  it("measures wider text as wider and bigger text as bigger", () => {
    const face = { family: "inter" as const, weight: 800 };
    expect(textWidth("WWWW", face, 40)).toBeGreaterThan(textWidth("iiii", face, 40));
    expect(textWidth("Soda", face, 80)).toBeCloseTo(textWidth("Soda", face, 40) * 2, 0);
  });

  it("fits a headline inside its box, in balanced lines", () => {
    const face = { family: "inter" as const, weight: 800 };
    const fitted = fitText("The feel-good soda with 9g of fiber", { face, maxWidth: 900, maxHeight: 260, maxSize: 140, minSize: 40, maxLines: 3, lineHeight: 1.05 });
    expect(fitted.overflow).toBe(false);
    expect(fitted.height).toBeLessThanOrEqual(260);
    for (const line of fitted.lines) expect(textWidth(line, face, fitted.size)).toBeLessThanOrEqual(900);
    const widths = fitted.lines.map((line) => textWidth(line, face, fitted.size));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(900 * 0.45);
  });

  it("reports overflow instead of drawing outside the box", () => {
    const face = { family: "anton" as const, weight: 400 };
    const fitted = fitText("An extremely long headline that cannot possibly fit into a tiny box at any reasonable size", { face, maxWidth: 200, maxHeight: 60, maxSize: 60, minSize: 30, maxLines: 1, lineHeight: 1 });
    expect(fitted.overflow).toBe(true);
    expect(fitted.lines.length).toBe(1);
  });

  it("knows which characters the bundled fonts can draw", () => {
    expect(hasGlyphs("Free shipping — over $35, “really”", { family: "inter", weight: 500 })).toBe(true);
    expect(hasGlyphs("→ ✓", { family: "inter", weight: 500 })).toBe(false);
  });
});

describe("emphasis marks", () => {
  it("strips the marks and remembers which words they covered", () => {
    const { plain, emphasis } = parseEmphasis("Connect your agent to *every tool* it needs.");
    expect(plain).toBe("Connect your agent to every tool it needs.");
    expect([...emphasis]).toEqual([4, 5]);
  });

  it("handles a mark that ends before punctuation", () => {
    const { plain, emphasis } = parseEmphasis("Built for *agents*.");
    expect(plain).toBe("Built for agents.");
    expect([...emphasis]).toEqual([2]);
  });
});

describe("palette", () => {
  it("builds readable pairs from brand colors", () => {
    const p = palette(["#034638", "#3a3a3a", "#d776a5", "#5a0c3a"]);
    expect(p.primary).toBe("#034638");
    expect(p.onPrimary).toBe("#ffffff");
    expect(p.accent).not.toBe(p.primary);
  });

  it("copes with a brand that only has black and white", () => {
    const p = palette(["#000000", "#ffffff"]);
    expect(p.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(p.onPrimary).toMatch(/^#/);
  });
});

describe("layouts", () => {
  it("renders every archetype at every shape at the exact pixel size", { timeout: 120_000 }, async () => {
    const { visual, logo, preset } = await assets();
    const out = process.env.NOMEN_PREVIEW_DIR;
    if (out) mkdirSync(out, { recursive: true });
    const schemes: Scheme[] = preset.schemes ?? ["brand", "light", "dark"];
    const types: TypeStyle[] = preset.types ?? ["grotesk", "bold", "modern", "editorial", "friendly", "serif", "geist"];
    let n = 0;
    for (const archetype of ARCHETYPES) {
      const input: AdInput = {
        archetype,
        copy: preset.copy?.[archetype] ?? COPY[archetype],
        type: types[n % types.length],
        palette: palette(preset.colors),
        scheme: schemes[n % schemes.length],
        brandName: preset.name,
        domain: preset.domain,
        logo,
        visual,
        visualKind: preset.visualKind ?? (archetype === "product_ui" ? "screenshot" : "photo"),
        look: preset.look,
      };
      n++;
      for (const [w, h] of SIZES) {
        const png = await renderPng(input, w, h);
        expect(imageSize(png)).toMatchObject({ type: "png", width: w, height: h });
        if (out) writeFileSync(join(out, `${archetype}-${w}x${h}.png`), png);
      }
    }
  });
});
