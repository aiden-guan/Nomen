// Brand colors in, an ad palette out: which color fills a panel, which carries the call to action,
// and which text color reads on each, chosen by WCAG contrast rather than by eye.

export type Palette = {
  /** The brand's signature color: panels and big fields. */
  primary: string;
  onPrimary: string;
  /** A second brand color for the call to action and highlights. */
  accent: string;
  onAccent: string;
  /** Near-black from the brand's hue: dark panels and body text on light ground. */
  dark: string;
  onDark: string;
  /** A light ground tinted toward the brand. */
  light: string;
  onLight: string;
  /** Text on light ground that still carries the brand (headlines), when it has enough contrast. */
  brandText: string;
  /** Hairlines and muted surfaces on light ground. */
  muted: string;
};

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb | null {
  const match = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const value = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as Rgb;
}

export const rgbToHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

export function luminance(hex: string) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const hsl = (hex: string) => toHsl(hexToRgb(hex) ?? [0, 0, 0]);
const withLightness = (hex: string, l: number, s?: number) => {
  const [h, sat] = hsl(hex);
  return rgbToHex(fromHsl(h, s ?? sat, l));
};

/** White or the palette's near-black, whichever reads better on this background. */
export function textOn(background: string, dark = "#111111", light = "#ffffff") {
  return contrast(background, light) >= contrast(background, dark) ? light : dark;
}

/** How much a color reads as "a brand color": saturated, and neither near-white nor near-black. */
function brandness(hex: string) {
  const [, s, l] = hsl(hex);
  return s * (1 - Math.abs(l - 0.45) * 1.6);
}

/** Mix two colors; t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number) {
  const x = hexToRgb(a) ?? [0, 0, 0];
  const y = hexToRgb(b) ?? [0, 0, 0];
  return rgbToHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

export function palette(colors: string[]): Palette {
  const valid = [...new Set(colors.map((c) => c.trim().toLowerCase()).filter((c) => hexToRgb(c)))].map((c) => (c.length === 4 ? rgbToHex(hexToRgb(c)!) : c));
  const ranked = [...valid].sort((a, b) => brandness(b) - brandness(a));
  // Brand.dev lists colors by prominence; prefer the first one that reads as a real brand color.
  const primary = valid.find((c) => brandness(c) > 0.25) ?? ranked[0] ?? "#1f2937";
  const accentPick = ranked.find((c) => c !== primary && brandness(c) > 0.2 && contrast(c, primary) >= 1.6 && hueDistance(c, primary) > 25);
  const [ph, ps] = hsl(primary);
  // No second brand color: a lighter or deeper tone of the primary, so the palette stays on-brand.
  const accent = accentPick ?? (luminance(primary) > 0.35 ? withLightness(primary, 0.28, Math.min(1, ps + 0.1)) : withLightness(primary, 0.62, Math.min(1, ps + 0.1)));
  const darkest = valid.filter((c) => luminance(c) < 0.03).sort((a, b) => luminance(a) - luminance(b))[0];
  const dark = darkest ?? rgbToHex(fromHsl(ph, Math.min(ps, 0.45), 0.11));
  const light = rgbToHex(fromHsl(ph, Math.min(ps, 0.45), 0.965));
  const brandText = contrast(primary, light) >= 4.5 ? primary : contrast(accent, light) >= 4.5 ? accent : dark;
  return {
    primary,
    onPrimary: textOn(primary, dark),
    accent,
    onAccent: textOn(accent, dark),
    dark,
    onDark: "#ffffff",
    light,
    onLight: dark,
    brandText,
    muted: rgbToHex(fromHsl(ph, Math.min(ps, 0.18), 0.88)),
  };
}

function hueDistance(a: string, b: string) {
  const d = Math.abs(hsl(a)[0] - hsl(b)[0]) % 360;
  return d > 180 ? 360 - d : d;
}

/** rgba() of a hex color, for scrims and shadows. */
export function alpha(hex: string, a: number) {
  const [r, g, b] = hexToRgb(hex) ?? [0, 0, 0];
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
