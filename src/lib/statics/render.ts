import { spawn } from "node:child_process";
import { ImageResponse } from "next/og";
import { ffmpegPath } from "../media";
import { rendererFonts } from "./fonts";
import { type AdInput, type LogoAsset, renderLayout, renderLogoTile, type VisualAsset } from "./layouts";

// Turning layouts into files: next/og (Satori + Resvg) draws the PNG, ffmpeg makes the JPEG that
// ad platforms prefer for photos, and incoming pictures are normalized before they are drawn.

export async function renderPng(input: AdInput, width: number, height: number): Promise<Buffer> {
  const response = new ImageResponse(renderLayout(input, width, height), { width, height, fonts: rendererFonts() });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || bytes.toString("latin1", 1, 4) !== "PNG") throw new Error("the ad renderer returned no image");
  return bytes;
}

export async function renderLogoPng(input: AdInput, width: number, height: number): Promise<Buffer> {
  const response = new ImageResponse(renderLogoTile(input, width, height), { width, height, fonts: rendererFonts() });
  return Buffer.from(await response.arrayBuffer());
}

/**
 * An ad as a JPEG under the placement's file-size limit: high quality first, a step down only if
 * a busy photo needs it. Without ffmpeg the PNG is kept (it is still within most limits).
 */
export async function renderAdFile(input: AdInput, width: number, height: number, maxBytes: number): Promise<{ bytes: Buffer; ext: "jpg" | "png" }> {
  const png = await renderPng(input, width, height);
  for (const quality of [2, 3, 5, 8]) {
    const jpg = await toJpeg(png, quality);
    if (!jpg) break;
    if (jpg.length <= maxBytes) return { bytes: jpg, ext: "jpg" };
  }
  return { bytes: png, ext: "png" };
}

/** A PNG as a high-quality JPEG with full-resolution color, so small colored type stays crisp. */
export async function toJpeg(png: Buffer, quality = 2): Promise<Buffer | null> {
  const bin = await ffmpegPath();
  if (!bin) return null;
  return pipe(bin, ["-hide_banner", "-loglevel", "error", "-f", "png_pipe", "-i", "pipe:0", "-q:v", String(quality), "-pix_fmt", "yuvj444p", "-f", "mjpeg", "pipe:1"], png);
}

/**
 * Any picture (PNG, JPEG, WebP, GIF) re-encoded to what the renderer reads best: JPEG for photos,
 * PNG when transparency matters, no larger than maxSide on its long edge.
 */
export async function normalizeImage(bytes: Buffer, opts: { maxSide?: number; keepAlpha?: boolean } = {}): Promise<{ bytes: Buffer; type: "image/jpeg" | "image/png"; width: number; height: number }> {
  const bin = await ffmpegPath();
  const size = imageSize(bytes);
  if (!bin) {
    // Without ffmpeg only PNG and JPEG can be drawn; pass them through as they are.
    if (size && (size.type === "png" || size.type === "jpeg")) return { bytes, type: size.type === "png" ? "image/png" : "image/jpeg", width: size.width, height: size.height };
    throw new Error("ffmpeg is needed to read this image format");
  }
  const max = opts.maxSide ?? 1600;
  const scale = `scale='if(gt(iw,ih),min(${max},iw),-2)':'if(gt(iw,ih),-2,min(${max},ih))':flags=lanczos`;
  const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-vf", scale];
  const out = opts.keepAlpha
    ? await pipe(bin, [...args, "-pix_fmt", "rgba", "-f", "image2pipe", "-c:v", "png", "pipe:1"], bytes)
    : await pipe(bin, [...args, "-q:v", "2", "-pix_fmt", "yuvj444p", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], bytes);
  const outSize = imageSize(out);
  if (!outSize) throw new Error("could not read the converted image");
  return { bytes: out, type: opts.keepAlpha ? "image/png" : "image/jpeg", width: outSize.width, height: outSize.height };
}

export const dataUri = (bytes: Buffer, type: string) => `data:${type};base64,${bytes.toString("base64")}`;

export async function visualAsset(bytes: Buffer): Promise<VisualAsset & { bytes: Buffer }> {
  const image = await normalizeImage(bytes, { maxSide: 1600 });
  return { src: dataUri(image.bytes, image.type), width: image.width, height: image.height, bytes: image.bytes };
}

/**
 * A logo ready to draw: PNG with its transparency, plus whether its ink is dark or light and
 * whether it carries its own opaque background, read from its pixels.
 */
export async function logoAsset(bytes: Buffer, hint?: string): Promise<LogoAsset> {
  let png = bytes;
  if (/^\s*(<\?xml|<svg)/i.test(bytes.subarray(0, 300).toString("utf8"))) png = await rasterizeSvg(bytes.toString("utf8"));
  const image = await normalizeImage(png, { maxSide: 1200, keepAlpha: true });
  const tone = await inkTone(image.bytes);
  const opaque = tone ? tone.opaque : hint === "has_opaque_background";
  const [white, black] = opaque ? [null, null] : await Promise.all([knockout(image.bytes, "255"), knockout(image.bytes, "17")]);
  return {
    src: dataUri(image.bytes, image.type),
    width: image.width,
    height: image.height,
    tone: tone?.tone ?? (hint === "dark" ? "light" : "dark"),
    opaque,
    white: white ? dataUri(white, "image/png") : undefined,
    black: black ? dataUri(black, "image/png") : undefined,
  };
}

/** An SVG logo drawn to a PNG at a size large enough for any placement. */
async function rasterizeSvg(svg: string): Promise<Buffer> {
  const box = svg.match(/viewBox="\s*[\d.\-]+[\s,]+[\d.\-]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/);
  const w0 = Number(box?.[1] ?? svg.match(/\swidth="([\d.]+)/)?.[1] ?? 400);
  const h0 = Number(box?.[2] ?? svg.match(/\sheight="([\d.]+)/)?.[1] ?? 120);
  const scale = 1200 / Math.max(w0, h0);
  const width = Math.round(w0 * scale);
  const height = Math.round(h0 * scale);
  const { createElement } = await import("react");
  const el = createElement("div", { style: { display: "flex", width, height } }, createElement("img", { src: dataUri(Buffer.from(svg), "image/svg+xml"), width, height }));
  return Buffer.from(await new ImageResponse(el, { width, height }).arrayBuffer());
}

/** The logo's shape filled with one gray level (255 white, 17 near-black), keeping its transparency. */
async function knockout(png: Buffer, level: string): Promise<Buffer | null> {
  const bin = await ffmpegPath();
  if (!bin) return null;
  try {
    return await pipe(bin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", `format=rgba,geq=r='${level}':g='${level}':b='${level}':a='alpha(X,Y)'`, "-f", "image2pipe", "-c:v", "png", "pipe:1"], png);
  } catch {
    return null;
  }
}

/** Average luminance of a logo's visible pixels, and whether it fills its whole box. */
async function inkTone(png: Buffer): Promise<{ tone: "dark" | "light"; opaque: boolean } | null> {
  const bin = await ffmpegPath();
  if (!bin) return null;
  try {
    const raw = await pipe(bin, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "scale=32:32:flags=area", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], png);
    let weight = 0;
    let lum = 0;
    let opaquePixels = 0;
    const corners: number[] = [];
    for (let i = 0; i + 3 < raw.length; i += 4) {
      const a = raw[i + 3] / 255;
      if (a > 0.98) opaquePixels++;
      const l = (0.2126 * raw[i] + 0.7152 * raw[i + 1] + 0.0722 * raw[i + 2]) / 255;
      const px = i / 4;
      if (px === 0 || px === 31 || px === 32 * 31 || px === 32 * 32 - 1) corners.push(l);
      weight += a;
      lum += a * l;
    }
    const pixels = raw.length / 4;
    const opaque = opaquePixels / pixels > 0.97;
    if (opaque) {
      // A logo on a tile: the tile is what meets the ad, so its corners decide.
      const corner = corners.reduce((s, x) => s + x, 0) / Math.max(1, corners.length);
      return { tone: corner < 0.5 ? "dark" : "light", opaque: true };
    }
    return { tone: weight && lum / weight > 0.62 ? "light" : "dark", opaque: false };
  } catch {
    return null;
  }
}

function pipe(bin: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg: ${Buffer.concat(err).toString("utf8").trim().slice(0, 300) || `exit ${code}`}`));
    });
    child.stdin.on("error", () => undefined); // ffmpeg may close stdin early on a bad input; close reports it
    child.stdin.end(input);
  });
}

/** Pixel size and type from the first bytes of a PNG, JPEG, GIF or WebP file. */
export function imageSize(bytes: Buffer): { type: "png" | "jpeg" | "gif" | "webp"; width: number; height: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { type: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length > 10 && bytes.toString("latin1", 0, 3) === "GIF") return { type: "gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length > 30 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    const chunk = bytes.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { type: "webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { type: "webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = bytes.readUInt32LE(21);
      return { type: "webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at++;
        continue;
      }
      const marker = bytes[at + 1];
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpeg", width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}
