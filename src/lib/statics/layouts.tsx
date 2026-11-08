import type { ReactElement, ReactNode } from "react";
import { alpha, contrast, mix, type Palette, textOn } from "./color";
import { type Face, familyName, type Fitted, fitText, MONO, textWidth, TYPE_STYLES, type TypeStyle } from "./fonts";

// The ad layouts. Each archetype is drawn for every shape (square, portrait 4:5, story 9:16,
// landscape 1.91:1 and 4:3) at any pixel size. Text is measured and broken into lines before it is
// drawn, so headlines fill their space without overflowing. The art direction from the ad study
// sets the look: the ground, the type, how much decoration, and whether the image carries a call
// to action at all.

export const ARCHETYPES = ["editorial", "product_ui", "code", "chat", "stat", "comparison", "benefits", "quote", "hero", "statement", "offer", "native"] as const;
export type Archetype = (typeof ARCHETYPES)[number];
export const SCHEMES = ["white", "cream", "black", "brand", "light", "dark"] as const;
export type Scheme = (typeof SCHEMES)[number];
export type Shape = "square" | "portrait" | "story" | "landscape";

export type AdCopy = {
  headline: string;
  subhead?: string;
  cta: string;
  eyebrow?: string;
  bullets?: string[];
  stat?: { value: string; label: string };
  quote?: { text: string; source: string };
  comparison?: { ours: string[]; theirs: string[]; theirsLabel: string };
  offer?: string;
  /** Terminal lines; a line starting with "$ " is a command, the rest is output. */
  code?: { title?: string; lines: string[] };
  chat?: { prompt: string; reply: string[] };
  /** Small print, e.g. the terms behind an offer, copied from the site. */
  fineprint?: string;
};

export type LogoAsset = { src: string; width: number; height: number; tone: "dark" | "light"; opaque: boolean; white?: string; black?: string };
export type VisualAsset = { src: string; width: number; height: number };

export type Look = {
  /** none: flat, hairlines only (the clean tech look); subtle: soft shadows; bold: promo energy. */
  decoration: "none" | "subtle" | "bold";
  /** Whether the image carries a call-to-action button. X and Reddit add their own. */
  cta: boolean;
};

export type AdInput = {
  archetype: Archetype;
  copy: AdCopy;
  type: TypeStyle;
  palette: Palette;
  scheme: Scheme;
  brandName: string;
  domain?: string;
  logo: LogoAsset | null;
  visual: VisualAsset | null;
  /** A screenshot is framed as a browser window; a photo is cropped edge to edge. */
  visualKind?: "photo" | "screenshot";
  look?: Look;
  /** Draw only the picture, with no text on it (Google asks for one such image per ratio). */
  textFree?: boolean;
};

export function shapeOf(width: number, height: number): Shape {
  const ratio = width / height;
  if (ratio > 1.2) return "landscape";
  if (ratio > 0.95) return "square";
  if (ratio > 0.7) return "portrait";
  return "story";
}

/** Meta's guidance for 9:16 stories and reels: keep the top 14%, bottom 35% and 6% each side free of text and logos. */
export const STORY_SAFE = { top: 0.14, bottom: 0.35, side: 0.06 };

type Ground = { bg: string; fg: string; headline: string; sub: string; ctaBg: string; ctaFg: string; dark: boolean; line: string; card: string; emphasis?: string };

function ground(p: Palette, scheme: Scheme): Ground {
  const neutral = (bg: string, dark: boolean): Ground => {
    const fg = dark ? "#f5f5f4" : "#111111";
    const ctaBg = dark ? "#ffffff" : contrast(p.primary, bg) >= 3 ? p.primary : "#111111";
    return { bg, fg, headline: fg, sub: alpha(fg, dark ? 0.76 : 0.66), ctaBg, ctaFg: textOn(ctaBg, "#111111"), dark, line: alpha(fg, dark ? 0.16 : 0.1), card: dark ? "#161616" : "#ffffff" };
  };
  if (scheme === "white") return neutral("#ffffff", false);
  if (scheme === "cream") return { ...neutral("#f4f1ea", false), card: "#fbfaf6" };
  if (scheme === "black") return neutral("#0a0a0a", true);
  if (scheme === "brand") {
    const accentWorks = contrast(p.accent, p.primary) >= 1.7;
    const ctaBg = accentWorks ? p.accent : p.onPrimary;
    const dark = p.onPrimary === "#ffffff";
    return { bg: p.primary, fg: p.onPrimary, headline: p.onPrimary, sub: alpha(p.onPrimary, 0.84), ctaBg, ctaFg: accentWorks ? p.onAccent : p.primary, dark, line: alpha(p.onPrimary, 0.2), card: dark ? alpha("#ffffff", 0.1) : alpha("#000000", 0.06) };
  }
  if (scheme === "dark") {
    const ctaBg = contrast(p.accent, p.dark) >= contrast(p.primary, p.dark) ? p.accent : p.primary;
    const headline = contrast(p.accent, p.dark) >= 4.5 && p.accent !== ctaBg ? p.accent : "#ffffff";
    return { bg: p.dark, fg: "#ffffff", headline, sub: alpha("#ffffff", 0.78), ctaBg, ctaFg: textOn(ctaBg, p.dark), dark: true, line: alpha("#ffffff", 0.16), card: alpha("#ffffff", 0.08) };
  }
  return { bg: p.light, fg: p.onLight, headline: p.brandText, sub: alpha(p.dark, 0.76), ctaBg: p.primary, ctaFg: p.onPrimary, dark: false, line: alpha(p.dark, 0.12), card: "#ffffff" };
}

type Ctx = {
  w: number;
  h: number;
  shape: Shape;
  /** Design units to pixels: layouts are drawn on a 1080-wide (or 1200-wide landscape) grid. */
  u: (n: number) => number;
  input: AdInput;
  look: Look;
  g: Ground;
  heading: Face;
  body: Face;
  upper: boolean;
  tracking: number;
  /** The region text may use: the whole canvas less padding, or a story's safe band. */
  band: { top: number; bottom: number; left: number; right: number };
};

const DEFAULT_LOOK: Look = { decoration: "subtle", cta: true };

/** The picture as a photo, or null when the picture is a screenshot (those are only ever framed). */
const photoOf = (input: AdInput) => (input.visualKind === "screenshot" ? null : input.visual);

export function renderLayout(input: AdInput, w: number, h: number): ReactElement {
  const shape = shapeOf(w, h);
  const style = TYPE_STYLES[input.type] ?? TYPE_STYLES.modern;
  // Landscape layouts are drawn on a 1200-wide grid; a 4:3 canvas is taller, so it scales by height.
  const scale = shape === "landscape" ? Math.min(w / 1200, h / 628) : w / 1080;
  const u = (n: number) => Math.round(n * scale);
  const pad = u(shape === "landscape" ? 56 : 72);
  const band =
    shape === "story"
      ? { top: Math.round(h * STORY_SAFE.top) + u(16), bottom: Math.round(h * (1 - STORY_SAFE.bottom)) - u(16), left: Math.max(pad, Math.round(w * STORY_SAFE.side)), right: w - Math.max(pad, Math.round(w * STORY_SAFE.side)) }
      : { top: pad, bottom: h - pad, left: pad, right: w - pad };
  const g = ground(input.palette, input.scheme);
  // Marked words take the brand color when it reads on this ground, else the accent, else nothing.
  const p = input.palette;
  g.emphasis = [p.primary, p.accent].find((color) => color.toLowerCase() !== g.headline.toLowerCase() && contrast(color, g.bg) >= 3) ?? undefined;
  const ctx: Ctx = { w, h, shape, u, input, look: input.look ?? DEFAULT_LOOK, g, heading: style.heading, body: style.body, upper: style.uppercase, tracking: style.tracking, band };
  if (input.archetype !== "product_ui" && !input.textFree) ctx.input = { ...input, visual: photoOf(input) };
  let draw = LAYOUTS[input.archetype] ?? LAYOUTS.editorial;
  // Layouts that need something they do not have fall back to one that does not.
  if ((input.archetype === "hero" || input.archetype === "native") && !ctx.input.visual) draw = LAYOUTS.editorial;
  if (input.archetype === "product_ui" && !input.visual) draw = LAYOUTS.editorial;
  if (input.archetype === "code" && !input.copy.code?.lines.length) draw = LAYOUTS.editorial;
  if (input.archetype === "chat" && !input.copy.chat?.prompt) draw = LAYOUTS.editorial;
  if (input.textFree) draw = textFree;
  return (
    <div style={{ display: "flex", position: "relative", width: w, height: h, background: ctx.g.bg, overflow: "hidden", fontFamily: familyName(style.body.family) }}>
      {draw(ctx)}
    </div>
  );
}

/** Google's logo assets: the logo alone, centered on white with room around it. */
export function renderLogoTile(input: AdInput, w: number, h: number): ReactElement {
  const style = TYPE_STYLES[input.type] ?? TYPE_STYLES.modern;
  const scale = Math.min(w, h * 4) / 1200;
  const ctx: Ctx = {
    w,
    h,
    shape: "square",
    u: (n) => Math.round(n * scale),
    input,
    look: { decoration: "none", cta: false },
    g: ground(input.palette, "white"),
    heading: style.heading,
    body: style.body,
    upper: false,
    tracking: style.tracking,
    band: { top: 0, bottom: h, left: 0, right: w },
  };
  const wide = w / h > 2;
  const logo = input.logo;
  // A square mark fills the square logo on its own; Google shows the business name beside it.
  if (!wide && logo && logo.width / logo.height < 1.4) {
    const side = Math.round(Math.min(w, h) * 0.62);
    return (
      <div style={{ display: "flex", width: w, height: h, background: "#ffffff", alignItems: "center", justifyContent: "center" }}>
        <img src={logo.opaque || logo.tone === "dark" ? logo.src : (logo.black ?? logo.src)} width={side} height={side} style={{ borderRadius: logo.opaque ? Math.round(side * 0.22) : 0 }} />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", width: w, height: h, background: "#ffffff", alignItems: "center", justifyContent: "center", fontFamily: familyName(style.body.family) }}>
      <Logo c={ctx} maxWidth={Math.round(w * (wide ? 0.82 : 0.7))} maxHeight={Math.round(h * (wide ? 0.56 : 0.34))} onDark={false} align="center" />
    </div>
  );
}

// ---------- building blocks ----------

/** Satori rejects style keys whose value is undefined, so optional values are dropped first. */
function css(style: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined && value !== null && value !== false)) as Record<string, string | number>;
}

type TextSpec = { text: string; face: Face; maxWidth: number; maxHeight: number; maxSize: number; minSize: number; maxLines: number; lineHeight: number; tracking?: number; upper?: boolean; balance?: boolean };
/** `emphasis` holds the indexes of words the copy marked with *asterisks*, drawn in the accent color. */
type Fit = Fitted & { spec: TextSpec; emphasis: Set<number> };

/** Splits "*every tool*"-style marks off the text and remembers which words they covered. */
export function parseEmphasis(text: string): { plain: string; emphasis: Set<number> } {
  const emphasis = new Set<number>();
  const words: string[] = [];
  let inside = false;
  for (const raw of text.trim().split(/\s+/)) {
    let word = raw;
    const opens = word.startsWith("*");
    if (opens) word = word.slice(1);
    const closes = word.endsWith("*") || /\*[.,!?;:]+$/.test(word);
    word = word.replace(/\*(?=[.,!?;:]*$)/, "");
    if (opens) inside = true;
    if (inside && word) emphasis.add(words.length);
    if (closes) inside = false;
    if (word) words.push(word.replace(/\*/g, ""));
  }
  return { plain: words.join(" "), emphasis };
}

function fit(spec: TextSpec): Fit {
  const { plain, emphasis } = parseEmphasis(spec.text);
  const text = spec.upper ? plain.toUpperCase() : plain;
  return { ...fitText(text, { face: spec.face, maxWidth: spec.maxWidth, maxHeight: spec.maxHeight, maxSize: spec.maxSize, minSize: spec.minSize, maxLines: spec.maxLines, lineHeight: spec.lineHeight, trackingEm: spec.tracking ?? 0, balance: spec.balance }), spec, emphasis };
}

function Lines({ f, color, align = "left", accent }: { f: Fit; color: string; align?: "left" | "center"; accent?: string }) {
  let index = 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "center" ? "center" : "flex-start" }}>
      {f.lines.map((line, i) => {
        const words = line.split(" ");
        const start = index;
        index += words.length;
        const style = {
          display: "flex",
          fontFamily: familyName(f.spec.face.family),
          fontWeight: f.spec.face.weight,
          fontSize: f.size,
          lineHeight: `${Math.round(f.size * f.spec.lineHeight)}px`,
          height: Math.round(f.size * f.spec.lineHeight),
          letterSpacing: `${((f.spec.tracking ?? 0) * f.size).toFixed(2)}px`,
          color,
          whiteSpace: "nowrap",
        } as const;
        if (!accent || f.emphasis.size === 0 || !words.some((_, k) => f.emphasis.has(start + k))) return <div key={i} style={style}>{line}</div>;
        // Runs of plain and emphasized words; spaces are kept with whiteSpace: pre.
        const runs: Array<{ text: string; on: boolean }> = [];
        words.forEach((word, k) => {
          const on = f.emphasis.has(start + k);
          const last = runs[runs.length - 1];
          const piece = k < words.length - 1 ? `${word} ` : word;
          if (last && last.on === on) last.text += piece;
          else runs.push({ text: piece, on });
        });
        return (
          <div key={i} style={style}>
            {runs.map((run, k) => (
              <div key={k} style={{ display: "flex", whiteSpace: "pre", color: run.on ? accent : color }}>{run.text}</div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function headline(c: Ctx, text: string, box: { width: number; height: number; max: number; min?: number; lines?: number; lineHeight?: number }) {
  const serif = c.heading.family === "newsreader" || c.heading.family === "playfair";
  return fit({
    text,
    face: c.heading,
    maxWidth: box.width,
    maxHeight: box.height,
    maxSize: box.max,
    minSize: box.min ?? Math.round(box.max * 0.42),
    maxLines: box.lines ?? 3,
    lineHeight: box.lineHeight ?? (c.upper ? 0.98 : serif ? 1.08 : 1.04),
    tracking: c.tracking,
    upper: c.upper,
  });
}

function bodyText(c: Ctx, text: string, box: { width: number; height: number; max: number; lines?: number; min?: number; weight?: number; face?: Face; lineHeight?: number }) {
  return fit({
    text,
    face: box.face ?? { family: c.body.family, weight: box.weight ?? c.body.weight },
    maxWidth: box.width,
    maxHeight: box.height,
    maxSize: box.max,
    minSize: box.min ?? Math.round(box.max * 0.72),
    maxLines: box.lines ?? 3,
    lineHeight: box.lineHeight ?? 1.32,
    tracking: -0.005,
    // Short lines (subheads, labels) are balanced so no word is left alone on the last line.
    balance: text.length <= 140,
  });
}

const shadow = (c: Ctx, strength = 1) => (c.look.decoration === "none" ? undefined : `0 ${c.u(18 * strength)}px ${c.u(48 * strength)}px ${alpha("#000000", c.look.decoration === "bold" ? 0.22 : 0.12)}`);

/** Height an eyebrow takes, with its margin, so stacked layouts can measure themselves. */
const eyebrowHeight = (c: Ctx) => c.u(c.shape === "landscape" ? 19 : 24) * (c.look.decoration === "none" ? 1.7 : 1.2) + c.u(c.look.decoration === "none" ? 26 : 18);

function Eyebrow({ c, text, color, align = "left" }: { c: Ctx; text: string; color: string; align?: "left" | "center" }) {
  const size = c.u(c.shape === "landscape" ? 19 : 24);
  if (c.look.decoration === "none") {
    // A quiet label in a hairline pill, the way software launches mark "Beta" or "New".
    return (
      <div style={{ display: "flex", justifyContent: align === "center" ? "center" : "flex-start", marginBottom: c.u(26) }}>
        <div style={{ display: "flex", padding: `${Math.round(size * 0.35)}px ${Math.round(size * 0.75)}px`, borderRadius: size * 2, border: `${Math.max(1, c.u(1.5))}px solid ${c.g.line}`, fontSize: size, fontWeight: 500, color, fontFamily: familyName(c.body.family) }}>{text}</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: align === "center" ? "center" : "flex-start", fontFamily: familyName(c.body.family), fontWeight: 700, fontSize: size, letterSpacing: `${(size * 0.14).toFixed(1)}px`, color, marginBottom: c.u(18) }}>
      {text.toUpperCase()}
    </div>
  );
}

function Arrow({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M5 12h13M13 6l6 6-6 6" stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check({ size, color, bg }: { size: number; color: string; bg: string }) {
  return (
    <div style={{ display: "flex", width: size, height: size, borderRadius: size, background: bg, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24">
        <path d="M4.5 12.5l5 5L19.5 7" stroke={color} strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Cross({ size, color, bg }: { size: number; color: string; bg: string }) {
  return (
    <div style={{ display: "flex", width: size, height: size, borderRadius: size, background: bg, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24">
        <path d="M6 6l12 12M18 6L6 18" stroke={color} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function Cta({ c, bg, fg, scale = 1 }: { c: Ctx; bg?: string; fg?: string; scale?: number }) {
  const size = Math.round(c.u(c.shape === "landscape" ? 23 : 30) * scale);
  const height = Math.round(size * 2.5);
  const flat = c.look.decoration === "none";
  return (
    <div
      style={css({
        display: "flex",
        alignItems: "center",
        height,
        paddingLeft: Math.round(size * 1.15),
        paddingRight: Math.round(size * 0.95),
        borderRadius: flat ? Math.round(height * 0.28) : height,
        background: bg ?? c.g.ctaBg,
        color: fg ?? c.g.ctaFg,
        fontFamily: familyName(c.body.family),
        fontWeight: flat ? 500 : 700,
        fontSize: size,
        letterSpacing: `${(-0.01 * size).toFixed(2)}px`,
        boxShadow: flat ? undefined : `0 ${Math.round(size * 0.25)}px ${Math.round(size * 0.9)}px ${alpha("#000000", 0.12)}`,
      })}
    >
      <div style={{ display: "flex", marginRight: Math.round(size * 0.42) }}>{c.input.copy.cta.trim()}</div>
      <Arrow size={Math.round(size * 1.0)} color={fg ?? c.g.ctaFg} />
    </div>
  );
}

/** The call to action when the look carries one, else the brand's web address, set small. */
function Action({ c, scale = 1, align = "left" }: { c: Ctx; scale?: number; align?: "left" | "center" }) {
  if (c.look.cta) return <div style={{ display: "flex", justifyContent: align === "center" ? "center" : "flex-start" }}><Cta c={c} scale={scale} /></div>;
  if (!c.input.domain) return <div style={{ display: "flex" }} />;
  const size = Math.round(c.u(c.shape === "landscape" ? 19 : 25) * scale);
  return (
    <div style={{ display: "flex", justifyContent: align === "center" ? "center" : "flex-start", fontFamily: familyName(c.body.family), fontSize: size, fontWeight: 500, color: c.g.sub }}>
      {c.input.domain}
    </div>
  );
}

/**
 * The brand's logo, sized into a box. A logo whose ink would vanish on this ground is swapped for
 * its knockout (all white or all black); a logo on its own tile keeps the tile.
 */
function Logo({ c, maxWidth, maxHeight, onDark, align = "left" }: { c: Ctx; maxWidth: number; maxHeight: number; onDark?: boolean; align?: "left" | "center" }) {
  const dark = onDark ?? c.g.dark;
  const logo = c.input.logo;
  if (!logo) {
    const size = Math.round(maxHeight * 0.7);
    return (
      <div style={{ display: "flex", justifyContent: align === "center" ? "center" : "flex-start", fontFamily: familyName(c.heading.family), fontWeight: c.heading.weight, fontSize: size, color: dark ? "#ffffff" : "#111111", letterSpacing: `${(-0.03 * size).toFixed(1)}px` }}>
        {c.input.brandName}
      </div>
    );
  }
  const ratio = logo.width / logo.height;
  // Wide wordmarks are capped by width, compact marks by height: they read at a similar size.
  let height = ratio > 3.2 ? maxHeight * 0.78 : maxHeight;
  let width = height * ratio;
  if (width > maxWidth) {
    width = maxWidth;
    height = width / ratio;
  }
  let src = logo.src;
  let pill = false;
  if (!logo.opaque) {
    if (dark && logo.tone === "dark") (logo.white ? (src = logo.white) : (pill = true));
    if (!dark && logo.tone === "light") (logo.black ? (src = logo.black) : (pill = true));
  }
  const pad = Math.round(height * 0.3);
  // A square mark alone does not say who the ad is from: set the name beside it, like a lockup.
  if (ratio < 1.4) {
    const mark = Math.round(Math.min(maxHeight, maxWidth) * 0.92);
    const size = Math.round(mark * 0.66);
    // A dark tile on a dark ground would disappear: give it a hairline edge.
    const edge = logo.opaque && dark && logo.tone === "dark" ? `${Math.max(1, Math.round(mark * 0.04))}px solid ${alpha("#ffffff", 0.28)}` : undefined;
    const markImg = <img src={src} width={mark} height={mark} style={css({ borderRadius: logo.opaque ? Math.round(mark * 0.22) : 0, border: edge })} />;
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: align === "center" ? "center" : "flex-start" }}>
        {pill ? <div style={{ display: "flex", padding: Math.round(mark * 0.12), borderRadius: Math.round(mark * 0.3), background: logo.tone === "dark" ? "#ffffff" : "#111111" }}>{markImg}</div> : markImg}
        <div style={{ display: "flex", marginLeft: Math.round(mark * 0.32), fontFamily: familyName(c.body.family), fontWeight: 600, fontSize: size, letterSpacing: `${(-0.02 * size).toFixed(1)}px`, color: dark ? "#ffffff" : "#111111" }}>
          {c.input.brandName}
        </div>
      </div>
    );
  }
  const img = <img src={src} width={Math.round(width)} height={Math.round(height)} style={{ borderRadius: logo.opaque ? Math.round(height * 0.2) : 0 }} />;
  return (
    <div style={{ display: "flex", justifyContent: align === "center" ? "center" : "flex-start" }}>
      {pill ? <div style={{ display: "flex", padding: `${pad}px ${Math.round(pad * 1.5)}px`, borderRadius: height, background: logo.tone === "dark" ? "#ffffff" : "#111111" }}>{img}</div> : img}
    </div>
  );
}

function Visual({ c, width, height, radius = 0, lift = false }: { c: Ctx; width: number; height: number; radius?: number; lift?: boolean }) {
  const v = c.input.visual;
  if (!v) return <div style={{ display: "flex", width, height, borderRadius: radius, background: mix(c.input.palette.primary, "#ffffff", 0.7) }} />;
  return (
    <div style={css({ display: "flex", width, height, borderRadius: radius, overflow: "hidden", boxShadow: lift ? shadow(c) : undefined, flexShrink: 0 })}>
      <img src={v.src} width={width} height={height} style={{ objectFit: "cover", width, height }} />
    </div>
  );
}

/**
 * A screenshot in a plain browser window: three dots and the address. The picture is fitted to
 * the window's width, so nothing is cut at the sides; a tall window shows more of the page.
 */
function Window({ c, width, height, radius }: { c: Ctx; width: number; height: number; radius?: number }) {
  const v = c.input.visual;
  const r = radius ?? c.u(20);
  const bar = Math.max(c.u(40), Math.round(width * 0.045));
  const dot = Math.round(bar * 0.26);
  const chrome = c.g.dark ? "#1c1c1e" : "#f3f3f2";
  const imgH = height - bar;
  const scaledH = v ? Math.round((v.height / v.width) * width) : imgH;
  return (
    <div style={css({ display: "flex", flexDirection: "column", width, height, borderRadius: r, overflow: "hidden", border: `${Math.max(1, c.u(1.5))}px solid ${c.g.dark ? alpha("#ffffff", 0.16) : alpha("#000000", 0.12)}`, background: chrome, boxShadow: c.look.decoration === "none" ? undefined : shadow(c, 1.2), flexShrink: 0 })}>
      <div style={{ display: "flex", alignItems: "center", height: bar, paddingLeft: Math.round(bar * 0.5), flexShrink: 0 }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
          <div key={color} style={{ display: "flex", width: dot, height: dot, borderRadius: dot, background: c.look.decoration === "none" ? alpha(c.g.dark ? "#ffffff" : "#000000", 0.18) : color, marginRight: Math.round(dot * 0.7) }} />
        ))}
        {c.input.domain && (
          <div style={{ display: "flex", marginLeft: Math.round(bar * 0.6), height: Math.round(bar * 0.56), alignItems: "center", paddingLeft: Math.round(bar * 0.4), paddingRight: Math.round(bar * 0.4), borderRadius: Math.round(bar * 0.16), background: c.g.dark ? alpha("#ffffff", 0.08) : alpha("#000000", 0.05), fontSize: Math.round(bar * 0.34), color: c.g.dark ? alpha("#ffffff", 0.6) : alpha("#000000", 0.55), fontFamily: familyName(c.body.family) }}>
            {c.input.domain}
          </div>
        )}
      </div>
      <div style={{ display: "flex", width, height: imgH, overflow: "hidden", background: "#ffffff", alignItems: "flex-start" }}>
        {v && <img src={v.src} width={width} height={scaledH} style={{ width, height: scaledH }} />}
      </div>
    </div>
  );
}

/** How a terminal of this width lays out: type size, line height and its natural height. */
function terminalMetrics(c: Ctx, width: number) {
  const lines = (c.input.copy.code?.lines ?? []).slice(0, 9);
  const bar = Math.max(c.u(36), Math.round(width * 0.05));
  const pad = Math.round(width * 0.05);
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  const cap = c.u((c.shape === "landscape" ? 0.8 : 1) * (lines.length <= 2 ? 40 : lines.length <= 4 ? 34 : 28));
  const size = Math.max(Math.round(c.u(13)), Math.min(cap, Math.floor(((width - pad * 2) / Math.max(1, textWidth(longest, MONO, 100))) * 100)));
  const lineH = Math.round(size * 1.55);
  const height = bar + Math.max(pad * 1.6 + lines.length * lineH, Math.round(width * (c.shape === "landscape" ? 0.34 : 0.3)));
  return { lines, bar, pad, size, lineH, height };
}

/** A terminal window: commands in the accent color after a $, output dimmed, nothing wraps. */
function Terminal({ c, width, maxHeight }: { c: Ctx; width: number; maxHeight: number }) {
  const code = c.input.copy.code ?? { lines: [] };
  const { lines, bar, pad, size, lineH, height: natural } = terminalMetrics(c, width);
  const height = Math.min(maxHeight, natural);
  const bg = c.g.dark ? (c.input.scheme === "black" ? "#141414" : alpha("#000000", 0.35)) : "#0e0e10";
  const accent = contrast(c.input.palette.accent, "#0e0e10") >= 4 ? c.input.palette.accent : contrast(c.input.palette.primary, "#0e0e10") >= 4 ? c.input.palette.primary : "#7ee787";
  const fits = (line: string) => (textWidth(line, MONO, size) <= width - pad * 2 ? line : `${line.slice(0, Math.max(4, Math.floor(((width - pad * 2) / textWidth(line, MONO, size)) * line.length) - 1))}…`);
  const title = code.title && code.title !== "terminal" ? code.title : c.input.domain;
  return (
    <div style={css({ display: "flex", flexDirection: "column", width, height, borderRadius: c.u(18), background: bg, border: `${Math.max(1, c.u(1.5))}px solid ${alpha("#ffffff", 0.1)}`, boxShadow: shadow(c, 1.1), overflow: "hidden", flexShrink: 0 })}>
      <div style={{ display: "flex", alignItems: "center", height: bar, paddingLeft: Math.round(bar * 0.5), borderBottom: `${Math.max(1, c.u(1))}px solid ${alpha("#ffffff", 0.08)}` }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: "flex", width: Math.round(bar * 0.24), height: Math.round(bar * 0.24), borderRadius: bar, background: alpha("#ffffff", 0.22), marginRight: Math.round(bar * 0.18) }} />
        ))}
        {title && <div style={{ display: "flex", marginLeft: Math.round(bar * 0.4), fontFamily: familyName(MONO.family), fontSize: Math.round(bar * 0.38), color: alpha("#ffffff", 0.6) }}>{title}</div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: lines.length <= 2 ? "center" : "flex-start", padding: `${Math.round(pad * 0.8)}px ${pad}px` }}>
        {lines.map((line, i) => {
          const command = line.startsWith("$ ");
          return (
            <div key={i} style={{ display: "flex", height: lineH, alignItems: "center", fontFamily: familyName(MONO.family), fontWeight: command ? 500 : 400, fontSize: size, color: command ? "#ffffff" : alpha("#ffffff", 0.62), whiteSpace: "nowrap" }}>
              {command ? (
                <>
                  <div style={{ display: "flex", color: accent, marginRight: Math.round(size * 0.6) }}>$</div>
                  <div style={{ display: "flex" }}>{fits(line.slice(2))}</div>
                </>
              ) : (
                <div style={{ display: "flex" }}>{fits(line) || " "}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The prompt and reply of a chat, fitted to a width, with the height they need. */
function chatParts(c: Ctx, width: number, maxHeight: number) {
  const chat = c.input.copy.chat ?? { prompt: "", reply: [] };
  const size = c.u(c.shape === "landscape" ? 22 : c.shape === "story" ? 30 : 34);
  const prompt = bodyText(c, chat.prompt, { width: width * 0.72 - size * 1.6, height: size * 5, max: size, lines: 3, weight: 500 });
  const replyH = Math.max(size * 3, maxHeight - prompt.height - size * 4);
  const reply = bodyText(c, chat.reply.join(" "), { width: width - size * 3.2, height: replyH, max: size, lines: 7 });
  const height = prompt.height + size * 1.2 + size * 1.3 + Math.max(reply.height, size * 1.5);
  return { size, prompt, reply, height };
}

/** A prompt and the product's answer, the way a chat app shows them. */
function Chat({ c, width, maxHeight }: { c: Ctx; width: number; maxHeight: number }) {
  const { size, prompt, reply } = chatParts(c, width, maxHeight);
  const bubbleBg = c.g.dark ? alpha("#ffffff", 0.1) : "#efefef";
  const avatar = Math.round(size * 1.5);
  return (
    <div style={{ display: "flex", flexDirection: "column", width }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div style={{ display: "flex", padding: `${Math.round(size * 0.6)}px ${Math.round(size * 0.85)}px`, borderRadius: Math.round(size * 1.1), background: bubbleBg }}>
          <Lines f={prompt} color={c.g.fg} />
        </div>
      </div>
      <div style={{ display: "flex", marginTop: Math.round(size * 1.3) }}>
        <div style={{ display: "flex", width: avatar, height: avatar, borderRadius: avatar, background: c.input.palette.primary, alignItems: "center", justifyContent: "center", flexShrink: 0, color: c.input.palette.onPrimary, fontSize: Math.round(avatar * 0.5), fontWeight: 700, fontFamily: familyName(c.body.family) }}>
          {c.input.brandName.slice(0, 1).toUpperCase()}
        </div>
        <div style={{ display: "flex", marginLeft: Math.round(size * 0.8), marginTop: Math.round(size * 0.05) }}>
          <Lines f={reply} color={c.g.fg} />
        </div>
      </div>
    </div>
  );
}

/** Positioned box. Satori draws right/bottom anchors unreliably, so everything anchors top-left. */
function Abs({ children, top, left, width, height }: { children: ReactNode; top: number; left: number; width?: number; height?: number }) {
  return <div style={css({ display: "flex", flexDirection: "column", position: "absolute", top, left, width, height })}>{children}</div>;
}

const storyLogo = (c: Ctx) => (
  <Abs top={Math.round(c.h * STORY_SAFE.top) - c.u(96)} left={0} width={c.w}>
    <Logo c={c} maxWidth={c.u(240)} maxHeight={c.u(56)} align="center" />
  </Abs>
);

/**
 * Vertical shapes: the logo at the top, the action at the bottom, and in between a stack of
 * blocks of known height set at the optical center (a little above the middle), so a short ad
 * does not crowd the top and leave the bottom empty.
 */
function stack(c: Ctx, blocks: Array<{ height: number; node: ReactNode; gap?: number }>, opts: { align?: "left" | "center"; actionScale?: number } = {}) {
  const { u, band } = c;
  const story = c.shape === "story";
  const width = band.right - band.left;
  const logoH = story ? 0 : u(96);
  const actionH = story ? u(110) : u(c.look.cta ? 92 : 52);
  const top = band.top + logoH;
  const bottom = band.bottom - actionH;
  const total = blocks.reduce((sum, b, i) => sum + b.height + (i ? (b.gap ?? u(40)) : 0), 0);
  const offset = Math.max(0, Math.round((bottom - top - total) * 0.42));
  let y = top + offset;
  return (
    <>
      {story ? storyLogo(c) : <Abs top={band.top} left={band.left} width={width}><Logo c={c} maxWidth={u(200)} maxHeight={u(46)} align={opts.align} /></Abs>}
      {blocks.map((b, i) => {
        if (i) y += b.gap ?? u(40);
        const node = <Abs key={i} top={Math.round(y)} left={band.left} width={width}>{b.node}</Abs>;
        y += b.height;
        return node;
      })}
      <Abs top={band.bottom - (story ? u(90) : u(c.look.cta ? 76 : 34))} left={band.left} width={width}>
        <Action c={c} align={opts.align} scale={story ? 1.15 : (opts.actionScale ?? 1)} />
      </Abs>
    </>
  );
}

/** The copy block (eyebrow, headline, subhead) for a stacked layout, with its measured height. */
function copyBlock(c: Ctx, opts: { max: number; lines?: number; width?: number; heightShare?: number; align?: "left" | "center"; subMax?: number }) {
  const { u, band, input, g } = c;
  const width = opts.width ?? band.right - band.left;
  const room = (band.bottom - band.top) * (opts.heightShare ?? 0.34);
  const head = headline(c, input.copy.headline, { width, height: room, max: opts.max, lines: opts.lines ?? 3 });
  const sub = input.copy.subhead ? bodyText(c, input.copy.subhead, { width: Math.min(width, u(860)), height: u(96), max: opts.subMax ?? u(c.shape === "square" ? 28 : 30), lines: 2 }) : null;
  const eyebrow = input.copy.eyebrow ? eyebrowHeight(c) : 0;
  const align = opts.align ?? "left";
  const height = eyebrow + head.height + (sub ? u(20) + sub.height : 0);
  const node = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "center" ? "center" : "flex-start" }}>
      {input.copy.eyebrow && <Eyebrow c={c} text={input.copy.eyebrow} color={g.sub} align={align} />}
      <Lines f={head} color={g.headline} align={align} accent={g.emphasis} />
      {sub && <div style={{ display: "flex", marginTop: u(20) }}><Lines f={sub} color={g.sub} align={align} /></div>}
    </div>
  );
  return { height, node, head };
}

/**
 * The frame for the software looks: copy, then the product (window, terminal or chat), as a
 * balanced stack in vertical shapes; copy left and product right in landscape. With no
 * decoration, a product window may run off the bottom edge like a launch screenshot.
 */
function productFrame(c: Ctx, media: (box: { width: number; height: number }) => ReactElement, opts: { natural: (width: number) => number; bleed?: boolean; center?: boolean }) {
  const { w, h, u, g, input, band } = c;
  if (c.shape === "landscape") {
    const textW = Math.round((w - band.left) * 0.42);
    const mediaLeft = band.left + textW + u(44);
    const mediaW = w - mediaLeft - (opts.bleed ? 0 : band.left);
    const head = headline(c, input.copy.headline, { width: textW, height: h * 0.44, max: u(58), lines: 4 });
    const sub = input.copy.subhead ? bodyText(c, input.copy.subhead, { width: textW, height: u(84), max: u(22), lines: 3 }) : null;
    const room = opts.bleed ? h - band.top : h - band.top * 2;
    const mediaH = opts.bleed ? room : Math.min(room, opts.natural(mediaW));
    return (
      <>
        <Abs top={band.top} left={band.left} width={textW} height={h - band.top * 2}>
          <Logo c={c} maxWidth={u(170)} maxHeight={u(40)} />
          <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
            <Lines f={head} color={g.headline} accent={g.emphasis} />
            {sub && <div style={{ display: "flex", marginTop: u(16) }}><Lines f={sub} color={g.sub} /></div>}
          </div>
          <Action c={c} />
        </Abs>
        <Abs top={opts.bleed ? band.top : band.top + Math.round((room - mediaH) / 2)} left={mediaLeft} width={mediaW} height={mediaH}>
          {media({ width: mediaW, height: mediaH })}
        </Abs>
      </>
    );
  }
  const width = band.right - band.left;
  const align = opts.center ? "center" : "left";
  const copy = copyBlock(c, { max: u(c.shape === "square" ? 72 : 84), lines: 3, heightShare: c.shape === "square" ? 0.2 : 0.24, align });
  if (opts.bleed && c.shape !== "story") {
    // Copy at the top, the window running off the bottom edge.
    const top = band.top + u(96);
    const mediaTop = top + copy.height + u(c.shape === "square" ? 44 : 60);
    const mediaW = w - band.left;
    return (
      <>
        <Abs top={band.top} left={band.left} width={width}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width }}>
            <Logo c={c} maxWidth={u(200)} maxHeight={u(46)} />
            <Action c={c} />
          </div>
        </Abs>
        <Abs top={top} left={band.left} width={width}>{copy.node}</Abs>
        <Abs top={mediaTop} left={band.left} width={mediaW} height={h - mediaTop}>
          {media({ width: mediaW, height: h - mediaTop + u(40) })}
        </Abs>
      </>
    );
  }
  const room = band.bottom - band.top - u(96) - u(110) - copy.height - u(56);
  const mediaH = Math.max(u(120), Math.min(room, opts.natural(width)));
  return stack(c, [copy, { height: mediaH, gap: u(c.shape === "square" ? 40 : 56), node: <div style={{ display: "flex", width, justifyContent: align === "center" ? "center" : "flex-start" }}>{media({ width, height: mediaH })}</div> }], { align });
}

/** The picture alone, for platforms that ask for images without text on them. */
function textFree(c: Ctx): ReactElement {
  const { w, h, u } = c;
  if (c.input.visualKind === "screenshot") {
    const ww = Math.round(w * (c.shape === "landscape" ? 0.86 : 0.88));
    const v = c.input.visual;
    const natural = v ? Math.round((v.height / v.width) * ww) + Math.max(u(40), Math.round(ww * 0.045)) : ww;
    const wh = Math.round(Math.min(h * 0.86, natural));
    return <Abs top={Math.round((h - wh) / 2)} left={Math.round((w - ww) / 2)}><Window c={c} width={ww} height={wh} radius={u(18)} /></Abs>;
  }
  return <Abs top={0} left={0}><Visual c={c} width={w} height={h} /></Abs>;
}

// ---------- layouts ----------

const LAYOUTS: Record<Archetype, (c: Ctx) => ReactElement> = {
  /** One sentence, set well, with room around it: the restrained launch post. */
  editorial(c) {
    const { w, h, u, g, input, band } = c;
    const center = c.shape !== "landscape";
    const textW = band.right - band.left - (c.shape === "landscape" ? u(120) : u(40));
    const max = u(c.shape === "landscape" ? 76 : c.shape === "square" ? 104 : 112);
    const head = headline(c, input.copy.headline, { width: textW, height: (band.bottom - band.top) * (c.shape === "landscape" ? 0.5 : 0.42), max, lines: 4, min: u(40) });
    const sub = input.copy.subhead ? bodyText(c, input.copy.subhead, { width: Math.min(textW, u(c.shape === "landscape" ? 760 : 800)), height: u(96), max: u(c.shape === "landscape" ? 24 : 30), lines: 2 }) : null;
    const blockH = head.height + (sub ? sub.height + u(24) : 0) + (input.copy.eyebrow ? eyebrowHeight(c) : 0);
    const mid = c.shape === "story" ? band.top + (band.bottom - band.top - blockH) / 2 : (h - blockH) / 2 - u(c.shape === "landscape" ? 6 : 20);
    return (
      <>
        {c.shape === "story" ? storyLogo(c) : (
          <Abs top={band.top} left={band.left} width={band.right - band.left}><Logo c={c} maxWidth={u(c.shape === "landscape" ? 170 : 210)} maxHeight={u(c.shape === "landscape" ? 40 : 48)} align={c.shape === "landscape" ? "left" : "center"} /></Abs>
        )}
        <Abs top={Math.round(mid)} left={center ? Math.round((w - textW) / 2) : band.left} width={textW}>
          {input.copy.eyebrow && <Eyebrow c={c} text={input.copy.eyebrow} color={g.sub} align={center ? "center" : "left"} />}
          <Lines f={head} color={g.headline} align={center ? "center" : "left"} accent={g.emphasis} />
          {sub && <div style={{ display: "flex", justifyContent: center ? "center" : "flex-start", marginTop: u(24) }}><Lines f={sub} color={g.sub} align={center ? "center" : "left"} /></div>}
        </Abs>
        <Abs top={c.shape === "story" ? band.bottom - u(90) : band.bottom - u(c.look.cta ? 76 : 34)} left={band.left} width={band.right - band.left}>
          <Action c={c} align={c.shape === "landscape" ? "left" : "center"} scale={c.shape === "story" ? 1.15 : 1} />
        </Abs>
      </>
    );
  },

  /** The real website in a browser window, under a one-line claim. */
  product_ui(c) {
    const v = c.input.visual;
    const natural = (width: number) => (v ? Math.round((v.height / v.width) * width) : Math.round(width * 0.6)) + Math.max(c.u(40), Math.round(width * 0.045));
    return productFrame(c, ({ width, height }) => <Window c={c} width={width} height={height} />, { natural, bleed: c.look.decoration === "none" && c.shape !== "story", center: c.shape === "story" });
  },

  /** A command and its output, copied from the brand's own docs. */
  code(c) {
    return productFrame(c, ({ width, height }) => <Terminal c={c} width={width} maxHeight={height} />, { natural: (width) => terminalMetrics(c, width).height, center: c.shape === "story" });
  },

  /** A question someone would ask and what the product answers. */
  chat(c) {
    return productFrame(c, ({ width, height }) => <Chat c={c} width={width} maxHeight={height} />, { natural: (width) => chatParts(c, width, c.h).height });
  },

  /** One number from the site, set huge, with what it means. */
  stat(c) {
    const { w, h, u, g, input, band } = c;
    const p = input.palette;
    const stat = input.copy.stat ?? { value: "", label: "" };
    const statColor = c.look.decoration === "none" ? g.headline : contrast(p.accent, g.bg) >= 3 ? p.accent : g.headline;
    const statFit = (width: number, height: number, max: number) =>
      fit({ text: stat.value, face: c.heading, maxWidth: width, maxHeight: height, maxSize: max, minSize: Math.round(max * 0.3), maxLines: 1, lineHeight: 1.0, tracking: c.upper ? 0 : -0.05, upper: c.upper });
    if (c.shape === "landscape") {
      const imgW = input.visual ? Math.round(w * 0.36) : 0;
      const textW = w - imgW - band.left * 2;
      const value = statFit(textW, u(210), u(200));
      const label = bodyText(c, stat.label, { width: textW, height: u(70), max: u(28), lines: 2, weight: 500 });
      const head = headline(c, input.copy.headline, { width: textW, height: u(84), max: u(34), lines: 2 });
      return (
        <>
          {input.visual && <Abs top={0} left={w - imgW} width={imgW} height={h}><Visual c={c} width={imgW} height={h} /></Abs>}
          <Abs top={band.top} left={band.left} width={textW} height={h - band.top * 2}>
            <Logo c={c} maxWidth={u(170)} maxHeight={u(40)} />
            <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
              <Lines f={head} color={g.headline} accent={g.emphasis} />
              <div style={{ display: "flex", marginTop: u(6) }}><Lines f={value} color={statColor} /></div>
              <Lines f={label} color={g.sub} />
            </div>
            <Action c={c} />
          </Abs>
        </>
      );
    }
    const width = band.right - band.left;
    const head = headline(c, input.copy.headline, { width, height: u(c.shape === "square" ? 150 : 200), max: u(70), lines: 3 });
    const side = Math.round(width * 0.38);
    const value = statFit(width * (input.visual ? 0.58 : 0.92), u(360), u(c.shape === "square" ? 300 : 340));
    const label = bodyText(c, stat.label, { width: width * (input.visual ? 0.58 : 0.9), height: u(100), max: u(38), lines: 2, weight: 500 });
    const figure = (
      <div style={{ display: "flex", width, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <Lines f={value} color={statColor} />
          <div style={{ display: "flex", marginTop: u(10) }}><Lines f={label} color={g.sub} /></div>
        </div>
        {input.visual && <Visual c={c} width={side} height={side} radius={u(24)} lift />}
      </div>
    );
    const figureH = Math.max(value.height + u(10) + label.height, input.visual ? side : 0);
    return stack(c, [
      { height: head.height, node: <Lines f={head} color={g.headline} accent={g.emphasis} /> },
      { height: figureH, gap: u(c.shape === "square" ? 36 : 48), node: figure },
    ]);
  },

  /** Two columns, the old way against this brand. Never names a competitor. */
  comparison(c) {
    const { w, h, u, g, input, band } = c;
    const p = input.palette;
    const cmp = input.copy.comparison ?? { ours: [], theirs: [], theirsLabel: "The usual way" };
    const rows = Math.min(4, cmp.ours.length, cmp.theirs.length);
    const flat = c.look.decoration === "none";
    const neutralGround = ["white", "cream", "black"].includes(input.scheme);
    const oursBg = flat ? g.card : g.dark || input.scheme === "brand" ? p.light : p.primary;
    const oursFg = flat ? g.fg : textOn(oursBg, p.dark);
    const theirsBg = flat ? "transparent" : g.dark ? alpha("#ffffff", 0.08) : alpha(p.dark, 0.06);
    const theirsFg = g.dark ? alpha("#ffffff", 0.6) : alpha("#111111", 0.5);
    const markBg = neutralGround ? (contrast(p.primary, g.card) >= 3 ? p.primary : "#111111") : p.accent === oursBg ? p.primary : p.accent;
    const column = (title: string, items: string[], ours: boolean, width: number, size: number) => {
      const titleFit = bodyText(c, title, { width: width - size * 2, height: size * 1.5, max: Math.round(size * 1.0), lines: 1, weight: 600, min: Math.round(size * 0.7) });
      return (
        <div style={css({ display: "flex", flexDirection: "column", width, borderRadius: u(22), background: ours ? oursBg : theirsBg, border: flat ? `${Math.max(1, u(1.5))}px solid ${g.line}` : undefined, padding: Math.round(size * 1.05), boxShadow: ours && !flat ? shadow(c) : undefined })}>
          <div style={{ display: "flex", marginBottom: Math.round(size * 0.9) }}><Lines f={titleFit} color={ours ? oursFg : theirsFg} /></div>
          {items.slice(0, rows).map((item, i) => {
            const f = bodyText(c, item, { width: width - size * 3.7, height: size * 2.8, max: size, lines: 2, weight: ours ? 500 : 400 });
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", marginTop: i ? Math.round(size * 0.8) : 0 }}>
                {ours ? <Check size={Math.round(size * 1.15)} color={textOn(markBg, "#111111")} bg={markBg} /> : <Cross size={Math.round(size * 1.15)} color={theirsFg} bg={g.dark ? alpha("#ffffff", 0.1) : alpha("#000000", 0.06)} />}
                <div style={{ display: "flex", marginLeft: Math.round(size * 0.55) }}><Lines f={f} color={ours ? oursFg : theirsFg} /></div>
              </div>
            );
          })}
        </div>
      );
    };
    // A column's height: padding, title, rows of up to two lines each.
    const columnHeight = (size: number) => Math.round(size * 2.1 + size * 1.5 + size * 0.9 + rows * size * 1.32 * 1.4 + Math.max(0, rows - 1) * size * 0.8);
    if (c.shape === "landscape") {
      const head = headline(c, input.copy.headline, { width: w - band.left * 2 - u(220), height: u(120), max: u(52), lines: 2 });
      const colW = Math.round((w - band.left * 2 - u(20)) / 2);
      return (
        <Abs top={band.top} left={band.left} width={w - band.left * 2} height={h - band.top * 2}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <Lines f={head} color={g.headline} accent={g.emphasis} />
            <Logo c={c} maxWidth={u(160)} maxHeight={u(40)} />
          </div>
          <div style={{ display: "flex", flexGrow: 1, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "flex-start" }}>
              {column(cmp.theirsLabel, cmp.theirs, false, colW, u(21))}
              <div style={{ display: "flex", width: u(20) }} />
              {column(input.brandName, cmp.ours, true, colW, u(21))}
            </div>
          </div>
        </Abs>
      );
    }
    const width = band.right - band.left;
    const head = headline(c, input.copy.headline, { width, height: c.shape === "square" ? u(180) : u(250), max: u(84), lines: c.shape === "square" ? 2 : 3 });
    const colW = Math.round((width - u(24)) / 2);
    const size = u(c.shape === "square" ? 31 : c.shape === "story" ? 32 : 36);
    const columns = (
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        {column(cmp.theirsLabel, cmp.theirs, false, colW, size)}
        <div style={{ display: "flex", width: u(24) }} />
        {column(input.brandName, cmp.ours, true, colW, size)}
      </div>
    );
    return stack(c, [
      { height: head.height, node: <Lines f={head} color={g.headline} accent={g.emphasis} /> },
      { height: columnHeight(size), gap: u(44), node: columns },
    ]);
  },

  /** Headline, the product, and three benefits with check marks. */
  benefits(c) {
    const { w, h, u, g, input, band } = c;
    const bullets = (input.copy.bullets ?? []).filter(Boolean).slice(0, 3);
    const neutralGround = ["white", "cream", "black"].includes(input.scheme);
    const checkBg = neutralGround ? (contrast(input.palette.primary, g.bg) >= 3 ? input.palette.primary : g.fg) : contrast(input.palette.primary, g.bg) >= 1.8 ? input.palette.primary : input.palette.accent;
    const list = (width: number, size: number, gap: number) => (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {bullets.map((item, i) => {
          const f = bodyText(c, item, { width: width - size * 1.9, height: size * 2.8, max: size, lines: 2, weight: 500 });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", marginTop: i ? gap : 0 }}>
              <Check size={Math.round(size * 1.2)} color={textOn(checkBg, "#111111")} bg={checkBg} />
              <div style={{ display: "flex", marginLeft: Math.round(size * 0.6) }}><Lines f={f} color={g.fg} /></div>
            </div>
          );
        })}
      </div>
    );
    const listHeight = (size: number, gap: number) => Math.round(bullets.length * size * 1.32 * 1.6 + Math.max(0, bullets.length - 1) * gap);
    if (c.shape === "landscape") {
      const imgW = input.visual ? Math.round(w * 0.4) : 0;
      const textW = w - imgW - band.left * 2;
      const head = headline(c, input.copy.headline, { width: textW, height: u(150), max: u(56), lines: 2 });
      return (
        <>
          {input.visual && <Abs top={0} left={0} width={imgW} height={h}><Visual c={c} width={imgW} height={h} /></Abs>}
          <Abs top={band.top} left={imgW + band.left} width={textW} height={h - band.top * 2}>
            <Lines f={head} color={g.headline} accent={g.emphasis} />
            <div style={{ display: "flex", flexGrow: 1, alignItems: "center" }}>{list(textW, u(24), u(14))}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Action c={c} />
              <Logo c={c} maxWidth={u(150)} maxHeight={u(40)} />
            </div>
          </Abs>
        </>
      );
    }
    const width = band.right - band.left;
    if (c.shape === "story" || !input.visual) {
      const head = headline(c, input.copy.headline, { width, height: u(230), max: u(c.shape === "story" ? 92 : 88), lines: 3 });
      const side = Math.min(u(460), Math.round((band.bottom - band.top) * 0.34));
      const size = u(c.shape === "story" ? 36 : 38);
      const blocks: Array<{ height: number; node: ReactNode; gap?: number }> = [{ height: head.height, node: <Lines f={head} color={g.headline} accent={g.emphasis} /> }];
      if (input.visual) blocks.push({ height: side, gap: u(32), node: <div style={{ display: "flex", width, justifyContent: "center" }}><Visual c={c} width={side} height={side} radius={u(28)} lift /></div> });
      blocks.push({ height: listHeight(size, u(22)), gap: u(44), node: list(width, size, u(22)) });
      return stack(c, blocks);
    }
    const head = headline(c, input.copy.headline, { width, height: c.shape === "portrait" ? u(250) : u(190), max: u(88), lines: c.shape === "portrait" ? 3 : 2 });
    const footer = u(90);
    const midTop = band.top + head.height + u(40);
    const midH = h - midTop - band.top - footer - u(36);
    const imgW = Math.round(width * 0.46);
    return (
      <>
        <Abs top={band.top} left={band.left} width={width}><Lines f={head} color={g.headline} accent={g.emphasis} /></Abs>
        <Abs top={midTop} left={band.left} width={width} height={midH}>
          <div style={{ display: "flex", width, height: midH, alignItems: "center" }}>
            <Visual c={c} width={imgW} height={midH} radius={u(24)} />
            <div style={{ display: "flex", marginLeft: u(40) }}>{list(width - imgW - u(40), u(c.shape === "portrait" ? 33 : 30), u(26))}</div>
          </div>
        </Abs>
        <Abs top={h - band.top - footer} left={band.left} width={width} height={footer}>
          <div style={{ display: "flex", width, height: footer, alignItems: "center", justifyContent: "space-between" }}>
            <Action c={c} />
            <Logo c={c} maxWidth={u(200)} maxHeight={u(48)} />
          </div>
        </Abs>
      </>
    );
  },

  /** A quote copied word for word from the brand's site or press, with its source. */
  quote(c) {
    const { w, h, u, g, input, band } = c;
    const q = input.copy.quote ?? { text: input.copy.headline, source: "" };
    const markColor = c.look.decoration === "none" ? alpha(g.fg, 0.3) : contrast(input.palette.accent, g.bg) >= 2 ? input.palette.accent : g.headline;
    const quoteFace: Face = c.heading.family === "anton" ? { family: "newsreader", weight: 500 } : c.heading;
    const quoteFit = (width: number, height: number, max: number, lines: number) =>
      fit({ text: `“${q.text.replace(/^["“”]+|["“”]+$/g, "")}”`, face: quoteFace, maxWidth: width, maxHeight: height, maxSize: max, minSize: Math.round(max * 0.45), maxLines: lines, lineHeight: 1.14, tracking: -0.02 });
    const Mark = ({ size }: { size: number }) => (
      <svg width={size} height={size * 0.8} viewBox="0 0 40 32">
        <path d="M0 32V19C0 8.5 5.4 2.2 16 0l2 4.2C12 6 9.3 9.6 9 14.4h8V32H0zm22 0V19C22 8.5 27.4 2.2 38 0l2 4.2C34 6 31.3 9.6 31 14.4h8V32H22z" fill={markColor} />
      </svg>
    );
    if (c.shape === "landscape") {
      const imgW = input.visual ? Math.round(w * 0.38) : 0;
      const textW = w - imgW - band.left * 2;
      const body = quoteFit(textW, h * 0.5, u(48), 4);
      const src = bodyText(c, `— ${q.source}`, { width: textW, height: u(40), max: u(21), lines: 1, weight: 500 });
      return (
        <>
          {input.visual && <Abs top={0} left={0} width={imgW} height={h}><Visual c={c} width={imgW} height={h} /></Abs>}
          <Abs top={band.top} left={imgW + band.left} width={textW} height={h - band.top * 2}>
            <Mark size={u(50)} />
            <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
              <Lines f={body} color={g.headline} />
              <div style={{ display: "flex", marginTop: u(14) }}><Lines f={src} color={g.sub} /></div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Action c={c} />
              <Logo c={c} maxWidth={u(150)} maxHeight={u(38)} />
            </div>
          </Abs>
        </>
      );
    }
    const width = band.right - band.left;
    const visualH = input.visual ? Math.round((band.bottom - band.top) * (c.shape === "square" ? 0.26 : 0.3)) : 0;
    const body = quoteFit(width, band.bottom - band.top - visualH - u(380), u(c.shape === "square" ? 74 : 82), 6);
    const src = bodyText(c, `— ${q.source}`, { width, height: u(50), max: u(29), lines: 1, weight: 500 });
    const blocks: Array<{ height: number; node: ReactNode; gap?: number }> = [
      { height: u(64), node: <Mark size={u(80)} /> },
      { height: body.height, gap: u(30), node: <Lines f={body} color={g.headline} /> },
      { height: src.height, gap: u(22), node: <Lines f={src} color={g.sub} /> },
    ];
    if (input.visual) blocks.push({ height: visualH, gap: u(40), node: <Visual c={c} width={visualH} height={visualH} radius={u(24)} lift /> });
    return stack(c, blocks);
  },

  /** Product photo on top, a solid panel with the headline and call to action below. */
  hero(c) {
    const { w, h, u, g, input, band } = c;
    if (c.shape === "landscape") {
      const imgW = Math.round(w * 0.47);
      const textW = w - imgW - band.left * 2;
      const head = headline(c, input.copy.headline, { width: textW, height: h * 0.46, max: u(70), lines: 3 });
      const sub = input.copy.subhead ? bodyText(c, input.copy.subhead, { width: textW, height: u(70), max: u(24), lines: 2 }) : null;
      return (
        <>
          <Abs top={0} left={w - imgW} width={imgW} height={h}><Visual c={c} width={imgW} height={h} /></Abs>
          <Abs top={band.top} left={band.left} width={textW} height={h - band.top * 2}>
            <Logo c={c} maxWidth={u(190)} maxHeight={u(48)} />
            <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
              <Lines f={head} color={g.headline} accent={g.emphasis} />
              {sub && <div style={{ display: "flex", marginTop: u(14) }}><Lines f={sub} color={g.sub} /></div>}
            </div>
            <Action c={c} />
          </Abs>
        </>
      );
    }
    if (c.shape === "story") {
      const width = band.right - band.left;
      const head = headline(c, input.copy.headline, { width, height: u(230), max: u(98), lines: 3 });
      const imgSide = Math.min(w - u(160), band.bottom - band.top - head.height - u(220));
      return (
        <>
          {storyLogo(c)}
          <Abs top={band.top} left={band.left} width={width} height={band.bottom - band.top}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              {input.copy.eyebrow && <Eyebrow c={c} text={input.copy.eyebrow} color={g.sub} align="center" />}
              <Lines f={head} color={g.headline} align="center" accent={g.emphasis} />
            </div>
            <div style={{ display: "flex", flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
              <Visual c={c} width={imgSide} height={imgSide} radius={u(32)} lift />
            </div>
            <Action c={c} scale={1.15} align="center" />
          </Abs>
        </>
      );
    }
    const imgH = Math.round(h * (c.shape === "portrait" ? 0.6 : 0.62));
    const panelH = h - imgH;
    const pad = band.left;
    const textW = w - pad * 2;
    const hasSub = Boolean(input.copy.subhead) && c.shape === "portrait";
    const head = headline(c, input.copy.headline, { width: textW, height: panelH - pad * 2 - u(96) - (hasSub ? u(90) : 0), max: u(94), lines: c.shape === "portrait" ? 3 : 2 });
    const sub = hasSub ? bodyText(c, input.copy.subhead!, { width: textW, height: u(80), max: u(30), lines: 2 }) : null;
    return (
      <>
        <Abs top={0} left={0} width={w} height={imgH}><Visual c={c} width={w} height={imgH} /></Abs>
        <Abs top={Math.round(pad * 0.75)} left={Math.round(pad * 0.75)}><Logo c={c} maxWidth={u(220)} maxHeight={u(54)} onDark={false} /></Abs>
        <Abs top={imgH} left={0} width={w} height={panelH}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: w, height: panelH, padding: pad }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <Lines f={head} color={g.headline} accent={g.emphasis} />
              {sub && <div style={{ display: "flex", marginTop: u(16) }}><Lines f={sub} color={g.sub} /></div>}
            </div>
            <Action c={c} />
          </div>
        </Abs>
      </>
    );
  },

  /** A bold claim set big, with the product as a supporting picture when there is one. */
  statement(c) {
    const { w, h, u, g, input, band } = c;
    const hasVisual = Boolean(input.visual);
    if (c.shape === "landscape") {
      const imgSide = hasVisual ? h - band.top * 2 : 0;
      const textW = w - band.left * 2 - (hasVisual ? imgSide + u(40) : 0);
      const sub = input.copy.subhead ? bodyText(c, input.copy.subhead, { width: textW, height: u(70), max: u(24), lines: 2 }) : null;
      const head = headline(c, input.copy.headline, { width: textW, height: h * (sub ? 0.46 : 0.58), max: u(96), lines: 3 });
      return (
        <>
          <Abs top={band.top} left={band.left} width={textW} height={h - band.top * 2}>
            <Logo c={c} maxWidth={u(180)} maxHeight={u(46)} />
            <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
              {input.copy.eyebrow && <Eyebrow c={c} text={input.copy.eyebrow} color={g.sub} />}
              <Lines f={head} color={g.headline} accent={g.emphasis} />
              {sub && <div style={{ display: "flex", marginTop: u(14) }}><Lines f={sub} color={g.sub} /></div>}
            </div>
            <Action c={c} />
          </Abs>
          {hasVisual && <Abs top={band.top} left={w - band.left - imgSide} width={imgSide} height={imgSide}><Visual c={c} width={imgSide} height={imgSide} radius={u(24)} lift /></Abs>}
        </>
      );
    }
    if (!hasVisual) {
      // Type alone: the claim set large, as a balanced block.
      const copy = copyBlock(c, { max: u(c.upper ? 180 : 140), lines: 4, heightShare: c.shape === "square" ? 0.5 : 0.46 });
      return stack(c, [copy]);
    }
    const width = band.right - band.left;
    const footer = u(100);
    const visualH = Math.round((band.bottom - band.top) * (c.shape === "story" ? 0.34 : c.shape === "portrait" ? 0.34 : 0.3));
    const headH = band.bottom - band.top - footer - visualH - u(110) - (input.copy.subhead ? u(90) : 0) - (c.shape === "story" ? 0 : u(90));
    const head = headline(c, input.copy.headline, { width, height: headH, max: u(c.upper ? 180 : 140), lines: 4, min: u(46) });
    const sub = input.copy.subhead ? bodyText(c, input.copy.subhead, { width, height: u(84), max: u(31), lines: 2 }) : null;
    return (
      <>
        {c.shape === "story" && storyLogo(c)}
        <Abs top={band.top} left={band.left} width={width} height={band.bottom - band.top}>
          {c.shape !== "story" && <div style={{ display: "flex", marginBottom: u(36) }}><Logo c={c} maxWidth={u(220)} maxHeight={u(52)} /></div>}
          {input.copy.eyebrow && <Eyebrow c={c} text={input.copy.eyebrow} color={g.sub} />}
          <Lines f={head} color={g.headline} accent={g.emphasis} />
          {sub && <div style={{ display: "flex", marginTop: u(24) }}><Lines f={sub} color={g.sub} /></div>}
          <div style={{ display: "flex", flexGrow: 1 }} />
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
            <Action c={c} scale={c.shape === "story" ? 1.15 : 1} />
            <Visual c={c} width={visualH} height={visualH} radius={u(24)} lift />
          </div>
        </Abs>
      </>
    );
  },

  /** An offer the site really makes, in a badge, over the product. */
  offer(c) {
    const { w, h, u, g, input, band } = c;
    const p = input.palette;
    const badgeBg = contrast(p.accent, g.bg) >= 1.6 ? p.accent : g.dark ? "#ffffff" : p.dark;
    const badgeFg = textOn(badgeBg, p.dark);
    const offer = input.copy.offer ?? input.copy.headline;
    const Badge = ({ width, max }: { width: number; max: number }) => {
      const f = fit({ text: offer, face: c.heading, maxWidth: width - max * 0.9, maxHeight: max * 2.4, maxSize: max, minSize: Math.round(max * 0.45), maxLines: 2, lineHeight: 1.0, tracking: c.tracking, upper: c.upper });
      return (
        <div style={css({ display: "flex", padding: `${Math.round(max * 0.36)}px ${Math.round(max * 0.5)}px`, borderRadius: Math.round(max * 0.32), background: badgeBg, transform: c.look.decoration === "bold" ? "rotate(-2.5deg)" : undefined, boxShadow: shadow(c, 0.8) })}>
          <Lines f={f} color={badgeFg} align="center" />
        </div>
      );
    };
    if (c.shape === "landscape") {
      const imgW = Math.round(w * 0.46);
      const textW = w - imgW - band.left * 2;
      const head = headline(c, input.copy.headline, { width: textW, height: u(130), max: u(50), lines: 2 });
      return (
        <>
          <Abs top={0} left={w - imgW} width={imgW} height={h}><Visual c={c} width={imgW} height={h} /></Abs>
          <Abs top={band.top} left={band.left} width={textW} height={h - band.top * 2}>
            <Logo c={c} maxWidth={u(170)} maxHeight={u(42)} />
            <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
              <div style={{ display: "flex", marginBottom: u(22) }}><Badge width={textW} max={u(50)} /></div>
              <Lines f={head} color={g.headline} accent={g.emphasis} />
            </div>
            <Action c={c} />
          </Abs>
        </>
      );
    }
    const width = band.right - band.left;
    const imgSide = Math.min(width, c.shape === "square" ? Math.round(h * 0.5) : c.shape === "portrait" ? Math.round(h * 0.47) : Math.round((band.bottom - band.top) * 0.5));
    const head = headline(c, input.copy.headline, { width, height: u(c.shape === "square" ? 150 : 200), max: u(78), lines: 2 });
    return (
      <>
        {c.shape === "story" && storyLogo(c)}
        <Abs top={band.top} left={band.left} width={width} height={band.bottom - band.top}>
          <Lines f={head} color={g.headline} accent={g.emphasis} />
          <div style={{ display: "flex", flexGrow: 1, alignItems: "center", justifyContent: "center", position: "relative" }}>
            <Visual c={c} width={imgSide} height={imgSide} radius={u(28)} lift />
            <div style={{ display: "flex", position: "absolute", top: u(c.shape === "square" ? 4 : 20), left: Math.round(width * 0.5) }}><Badge width={Math.round(width * 0.5)} max={u(c.shape === "square" ? 48 : 56)} /></div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Action c={c} scale={c.shape === "story" ? 1.15 : 1} />
            {c.shape !== "story" && <Logo c={c} maxWidth={u(200)} maxHeight={u(48)} />}
          </div>
          {input.copy.fineprint && <div style={{ display: "flex", marginTop: u(14), fontSize: u(18), color: g.sub, fontFamily: familyName(c.body.family) }}>{input.copy.fineprint.slice(0, 110)}</div>}
        </Abs>
      </>
    );
  },

  /** A real-feeling photo with one caption box, the way people post: made for feeds like Reddit. */
  native(c) {
    const { w, h, u, input, band } = c;
    const p = input.palette;
    const caption = (width: number, max: number) =>
      fit({ text: input.copy.headline, face: { family: c.body.family === "nunito" ? "nunito" : "inter", weight: 700 }, maxWidth: width, maxHeight: max * 4.2, maxSize: max, minSize: Math.round(max * 0.6), maxLines: 3, lineHeight: 1.18, tracking: -0.012 });
    const Box = ({ width, max }: { width: number; max: number }) => {
      const f = caption(width - max * 1.4, max);
      return (
        <div style={{ display: "flex", padding: `${Math.round(max * 0.5)}px ${Math.round(max * 0.7)}px`, borderRadius: Math.round(max * 0.45), background: "#ffffff", boxShadow: `0 ${u(10)}px ${u(30)}px ${alpha("#000000", 0.18)}` }}>
          <Lines f={f} color="#111111" align="center" />
        </div>
      );
    };
    const brandTag = (
      <div style={{ display: "flex", alignItems: "center", padding: `${u(10)}px ${u(18)}px`, borderRadius: u(40), background: alpha("#000000", 0.45) }}>
        <div style={{ display: "flex", width: u(14), height: u(14), borderRadius: u(14), background: p.primary, marginRight: u(10) }} />
        <div style={{ display: "flex", fontSize: u(22), fontWeight: 600, color: "#ffffff", fontFamily: familyName(c.body.family) }}>{input.brandName}</div>
      </div>
    );
    if (c.shape === "landscape") {
      const imgW = Math.min(h, Math.round(w * 0.5));
      return (
        <>
          <Abs top={0} left={0} width={w} height={h}><div style={{ display: "flex", width: w, height: h, background: mix(p.dark, "#000000", 0.4) }} /></Abs>
          <Abs top={0} left={0} width={imgW} height={h}><Visual c={c} width={imgW} height={h} /></Abs>
          <Abs top={0} left={imgW} width={w - imgW} height={h}>
            <div style={{ display: "flex", flexDirection: "column", width: w - imgW, height: h, padding: u(40), justifyContent: "center", alignItems: "center" }}>
              <Box width={w - imgW - u(80)} max={u(30)} />
              <div style={{ display: "flex", marginTop: u(26) }}>{brandTag}</div>
            </div>
          </Abs>
        </>
      );
    }
    if (c.shape === "square") {
      return (
        <>
          <Abs top={0} left={0} width={w} height={h}><Visual c={c} width={w} height={h} /></Abs>
          <Abs top={u(150)} left={u(90)} width={w - u(180)}><div style={{ display: "flex", justifyContent: "center" }}><Box width={w - u(180)} max={u(46)} /></div></Abs>
          <Abs top={h - u(36) - u(50)} left={u(36)}>{brandTag}</Abs>
        </>
      );
    }
    const side = w;
    const top = Math.round((h - side) / 2);
    return (
      <>
        <Abs top={0} left={0} width={w} height={h}><div style={{ display: "flex", width: w, height: h, background: mix(p.dark, "#000000", 0.35) }} /></Abs>
        <Abs top={top} left={0} width={side} height={side}><Visual c={c} width={side} height={side} /></Abs>
        <Abs top={c.shape === "story" ? band.top + u(30) : top + u(70)} left={u(90)} width={w - u(180)}><div style={{ display: "flex", justifyContent: "center" }}><Box width={w - u(180)} max={u(46)} /></div></Abs>
        <Abs top={c.shape === "story" ? band.bottom - u(60) : top + side - u(80)} left={u(36)}>{brandTag}</Abs>
      </>
    );
  },
};
