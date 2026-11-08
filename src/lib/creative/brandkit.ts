// Brand kit intake: the files a brand hands Nomen (uploads) and what a read-only scan of its code
// finds, so the video agents can show the real product instead of two website screenshots.
//
//   data/brandkits/<brandId>/kit.json   the BrandKit, plus a private index (content hashes, vision state)
//   data/brandkits/<brandId>/files/     the assets, named "<asset id>-<clean name>"
//
// Uploaded files and repositories are untrusted data. Nothing here executes them or hands them to a
// shell: git runs through execFile with fixed arguments, symlinks are never followed, an uploaded
// file's name never becomes a path, and the clone is deleted after the scan.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as FS, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent, now, store } from "../db";
import { ffmpegPath, probe } from "../media";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import type { BrandAsset, BrandKit, RepoScan } from "./types";

// ---------- limits ----------

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ASSETS = 60;
/** Directory entries visited in a repo before the walk stops. */
export const MAX_REPO_FILES = 20_000;
/** Bytes read from a repo (text for the scan and the assets copied in). */
export const MAX_REPO_READ = 200 * 1024 * 1024;
/** A checkout bigger than this is refused (the clone itself is bounded by the timeout). */
const MAX_CHECKOUT_BYTES = 1024 * 1024 * 1024;
export const CLONE_TIMEOUT_MS = 90_000;
/** Assets a scan copies in at most; uploads keep the rest of the 60. */
const MAX_REPO_ASSETS = 40;
/** Images per vision request. */
const CAPTION_BATCH = 12;
const CAPTION_PER_PASS = 36;

export type AssetKind = BrandAsset["kind"];
export type SkippedFile = { name: string; reason: string };
export type IntakeResult = { kit: BrandKit; added: BrandAsset[]; skipped: SkippedFile[] };

/** An error the API answers as `{ error }` with this status. Messages are written for the brand. */
export class BrandKitError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- file types ----------

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"]);
const RASTER_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "avif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v"]);
const FONT_EXT = new Set(["ttf", "otf", "woff", "woff2"]);
const DOC_EXT = new Set(["pdf", "md", "markdown"]);

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
};

export const SUPPORTED_EXTENSIONS = [...IMAGE_EXT, ...VIDEO_EXT, ...FONT_EXT, ...DOC_EXT];

export const extOf = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export const contentTypeOf = (path: string) => CONTENT_TYPES[extOf(path)] ?? "application/octet-stream";

function baseKind(ext: string): AssetKind | null {
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (FONT_EXT.has(ext)) return "font";
  if (DOC_EXT.has(ext)) return "doc";
  return null;
}

/**
 * What an asset is, from its path, extension and pixel size. Order matters: favicons before logos,
 * logos before icons, names before shapes. The vision pass corrects the obvious misses later.
 */
export function classifyAsset(relPath: string, size?: { width?: number; height?: number } | null, hints: { readmeRef?: boolean } = {}): AssetKind | null {
  const parts = relPath.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  const file = parts.at(-1) ?? "";
  const ext = extOf(file);
  const base = baseKind(ext);
  if (base !== "image") return base;
  const stem = file.slice(0, file.length - ext.length - 1);
  const folders = parts.slice(0, -1);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const ratio = width && height ? width / height : 1;

  if (ext === "ico" || /favicon|apple-touch-icon|apple-icon|android-chrome|mstile|safari-pinned-tab|app-?icon/.test(stem)) return "icon";
  if (/logo|wordmark|brandmark|(^|[^a-z])(brand|mark)([^a-z]|$)/.test(stem)) return "logo";
  if (/(^|[^a-z])icons?([^a-z]|$)/.test(stem)) return "icon";
  if (ext === "svg" && folders.some((folder) => /brand|logo|identity/.test(folder))) return "logo";
  if (/screenshot|screen|(^|[^a-z])shots?([^a-z]|$)|demo/.test(stem)) return "screenshot";
  if (width && height && Math.max(width, height) <= 256 && Math.abs(width - height) <= Math.max(width, height) * 0.1) return "icon";
  if (hints.readmeRef && ext !== "svg") return "screenshot";
  const docsFolder = folders.some((folder) => /^(docs?|screenshots?|screens)$/.test(folder));
  if (docsFolder && ext !== "svg" && Math.min(width, height) >= 300 && (ratio >= 1.3 || ratio <= 0.77)) return "screenshot";
  return "image";
}

/** A readable default caption from the file name ("logo dark", "Inter Bold (font)"); the vision pass replaces it for images. */
function defaultCaption(relPath: string, kind: AssetKind) {
  const file = relPath.split("/").pop() ?? "";
  const ext = extOf(file);
  const stem = ext ? file.slice(0, -(ext.length + 1)) : file;
  const words = stem
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s\-_.+@]+/)
    .filter((word) => word && !/^[0-9a-f]{8,}$/i.test(word) && !/^\d{3,}$/.test(word))
    .join(" ")
    .slice(0, 80);
  const label = kind === "doc" ? (ext === "pdf" ? "PDF" : "document") : kind;
  if (!words) return label;
  return words.toLowerCase().includes(label.toLowerCase()) ? words : `${words} (${label})`;
}

// ---------- pixel sizes ----------

/** Width and height from an image's header (PNG, JPEG, GIF, WebP, ICO, SVG), without decoding it. */
export function imageSizeFromBytes(bytes: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === "svg") return svgSize(bytes.subarray(0, 64 * 1024).toString("utf8"));
    if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR") {
      return positive(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    }
    if (bytes.length >= 10 && bytes.toString("ascii", 0, 4) === "GIF8") return positive(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
    if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
      const chunk = bytes.toString("ascii", 12, 16);
      if (chunk === "VP8 ") return positive(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
      if (chunk === "VP8L") {
        const b1 = bytes[22];
        const b2 = bytes[23];
        const b3 = bytes[24];
        return positive(1 + (((b1 & 0x3f) << 8) | bytes[21]), 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
      }
      if (chunk === "VP8X") return positive(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = bytes[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return positive(bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5));
        }
        if (marker === 0xd8 || marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) {
          i += marker === 0xff ? 1 : 2;
          continue;
        }
        i += 2 + bytes.readUInt16BE(i + 2);
      }
      return null;
    }
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x00000100) return positive(bytes[6] || 256, bytes[7] || 256);
  } catch {
    // a truncated or odd header: no size
  }
  return null;
}

function positive(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : null;
}

/** An SVG's size from width/height (px or unitless), else its viewBox. */
export function svgSize(text: string): { width: number; height: number } | null {
  const tag = text.match(/<svg\b[^>]{0,4000}>/i)?.[0];
  if (!tag) return null;
  const attr = (name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const length = (value: string | undefined) => {
    const m = value?.trim().match(/^(\d+(?:\.\d+)?)(px)?$/);
    return m ? Number(m[1]) : 0;
  };
  const width = length(attr("width"));
  const height = length(attr("height"));
  if (width && height) return { width: Math.round(width), height: Math.round(height) };
  const box = attr("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box && box.length === 4 && box[2] > 0 && box[3] > 0) return { width: Math.round(box[2]), height: Math.round(box[3]) };
  return null;
}

async function mediaSize(path: string, ext: string, bytes: Buffer) {
  if (IMAGE_EXT.has(ext)) {
    const size = imageSizeFromBytes(bytes, ext);
    if (size || ext === "svg") return size;
  }
  if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) return null;
  try {
    const info = await probe(path);
    return info.width && info.height ? { width: info.width, height: info.height } : null;
  } catch {
    return null;
  }
}

// ---------- storage ----------

const BRAND_ID = /^[A-Za-z0-9_-]{1,80}$/;
const ASSET_ID = /^a\d{1,6}$/;
const STORED_NAME = /^a\d{1,6}-[A-Za-z0-9_][A-Za-z0-9_.-]*\.[a-z0-9]{2,8}$/;
const KINDS = new Set<AssetKind>(["logo", "icon", "screenshot", "image", "video", "font", "doc"]);

type KitIndex = {
  next_id: number;
  /** asset id -> sha256 of its bytes, for duplicate checks. */
  hashes: Record<string, string>;
  /** asset id -> whether the vision pass has looked at it. */
  vision: Record<string, "done" | "failed">;
};
type StoredKit = BrandKit & { index: KitIndex };

/** Where kits live; NOMEN_BRANDKITS_DIR overrides it (tests). */
export const brandkitsRoot = () => process.env.NOMEN_BRANDKITS_DIR || join(process.cwd(), "data", "brandkits");

function kitDir(brandId: string) {
  if (!BRAND_ID.test(brandId)) throw new BrandKitError(400, "Invalid brand id.");
  return join(/*turbopackIgnore: true*/ brandkitsRoot(), brandId);
}

const filesDir = (brandId: string) => join(kitDir(brandId), "files");

type GlobalState = { locks: Map<string, Promise<unknown>>; scans: Set<string>; captions: Map<string, { again: boolean }> };
declare global {
  var __nomenBrandkit: GlobalState | undefined;
}
// On globalThis so every route bundle in the same server process shares the same locks.
const shared = (): GlobalState => (globalThis.__nomenBrandkit ??= { locks: new Map(), scans: new Set(), captions: new Map() });

/** Serializes writes to one brand's kit.json. */
async function withLock<T>(brandId: string, fn: () => Promise<T>): Promise<T> {
  const { locks } = shared();
  const previous = locks.get(brandId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(brandId, next);
  try {
    return await next;
  } finally {
    if (locks.get(brandId) === next) locks.delete(brandId);
  }
}

function emptyKit(brandId: string): StoredKit {
  return { brand_id: brandId, updated_at: "", assets: [], repo: null, index: { next_id: 1, hashes: {}, vision: {} } };
}

function isAsset(value: unknown): value is BrandAsset {
  const a = value as Partial<BrandAsset> | null;
  return Boolean(a && typeof a === "object" && typeof a.id === "string" && ASSET_ID.test(a.id) && KINDS.has(a.kind as AssetKind) && typeof a.path === "string" && typeof a.source === "string" && typeof a.caption === "string" && typeof a.bytes === "number");
}

function readStored(brandId: string): StoredKit {
  const file = join(kitDir(brandId), "kit.json");
  let raw: Partial<StoredKit>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredKit>;
  } catch {
    return emptyKit(brandId);
  }
  if (!raw || typeof raw !== "object") return emptyKit(brandId);
  const assets = Array.isArray(raw.assets) ? raw.assets.filter(isAsset) : [];
  const index = (raw.index && typeof raw.index === "object" ? raw.index : {}) as Partial<KitIndex>;
  const highest = assets.reduce((max, asset) => Math.max(max, Number(asset.id.slice(1))), 0);
  return {
    brand_id: brandId,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
    assets,
    repo: raw.repo && typeof raw.repo === "object" ? raw.repo : null,
    index: {
      next_id: Math.max(Number(index.next_id) || 1, highest + 1),
      hashes: index.hashes && typeof index.hashes === "object" ? { ...index.hashes } : {},
      vision: index.vision && typeof index.vision === "object" ? { ...index.vision } : {},
    },
  };
}

async function writeStored(stored: StoredKit) {
  stored.updated_at = now();
  const dir = kitDir(stored.brand_id);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `kit.json.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, JSON.stringify(stored, null, 2));
  await rename(tmp, join(dir, "kit.json"));
}

const publicKit = (stored: StoredKit): BrandKit => ({ brand_id: stored.brand_id, updated_at: stored.updated_at, assets: stored.assets, repo: stored.repo });

/** The brand's kit; an empty one when the brand never gave us anything. */
export function getBrandKit(brandId: string): BrandKit {
  return publicKit(readStored(brandId));
}

/** The kit as the API returns it: plus whether a vision pass is still writing captions. */
export function brandKitView(brandId: string) {
  return { ...getBrandKit(brandId), captioning: isCaptioning(brandId) };
}

/** 404s unless the brand exists. */
export async function requireBrand(brandId: string): Promise<{ id: string; name: string }> {
  const [row] = BRAND_ID.test(brandId) ? await store().find<{ id: string; name: string }>("brands", { id: brandId }, { limit: 1 }) : [];
  if (!row) throw new BrandKitError(404, "Brand not found.");
  return { id: row.id, name: row.name };
}

/**
 * Kits are folders on this machine's disk (data/brandkits). A serverless host has no lasting disk,
 * so there they can be read (empty) but not changed yet: see docs/convex.md.
 */
export function requireKitDisk() {
  if (store().kind !== "sqlite") throw new BrandKitError(501, "Brand kits aren't available on this deployment yet: they are kept on the server's disk, which a serverless host doesn't have. Run Nomen locally to import one.");
}

/**
 * The file behind an asset, or null. Never trusts the stored path: it rebuilds it from the
 * brand's files directory and the stored file name, and refuses symlinks and anything outside.
 */
export function assetPath(brandId: string, assetId: string): string | null {
  if (typeof brandId !== "string" || typeof assetId !== "string" || !BRAND_ID.test(brandId) || !ASSET_ID.test(assetId)) return null;
  const asset = readStored(brandId).assets.find((a) => a.id === assetId);
  if (!asset) return null;
  const name = posix.basename(asset.path.replace(/\\/g, "/"));
  if (!STORED_NAME.test(name) || !name.startsWith(`${asset.id}-`)) return null;
  const dir = filesDir(brandId);
  const full = join(dir, name);
  try {
    if (!lstatSync(full).isFile()) return null;
    const realDir = realpathSync(dir);
    if (!realpathSync(full).startsWith(realDir + sep)) return null;
    return full;
  } catch {
    return null;
  }
}

async function deleteAssetFile(brandId: string, asset: BrandAsset) {
  const name = posix.basename(asset.path.replace(/\\/g, "/"));
  if (STORED_NAME.test(name)) await rm(join(filesDir(brandId), name), { force: true }).catch(() => undefined);
}

// ---------- intake ----------

/**
 * A browser's relative path ("brand/logo.svg"), cleaned for classification only: it never becomes a
 * path on disk. Absolute paths, "..", NUL bytes and hidden files are refused.
 */
export function cleanRelativePath(name: string): { rel: string } | { error: string } {
  if (typeof name !== "string" || !name || name.includes("\0")) return { error: "invalid file name" };
  const unified = name.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return { error: "unsafe path (absolute paths are not allowed)" };
  const parts = unified.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return { error: "unsafe path (../ is not allowed)" };
  if (!parts.length) return { error: "invalid file name" };
  if (parts.length > 24 || unified.length > 500) return { error: "path too long" };
  if (parts.at(-1)!.startsWith(".")) return { error: "hidden file" };
  return { rel: parts.join("/") };
}

/** "Inter Bold.woff2" -> "Inter-Bold.woff2": letters, digits, dot, dash, underscore only. */
function cleanFileName(base: string) {
  const ext = extOf(base);
  const stem = (ext ? base.slice(0, -(ext.length + 1)) : base)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/[-.]{2,}/g, "-")
    .replace(/^[-._]+|[-.]+$/g, "")
    .slice(0, 60);
  return `${stem || "file"}.${ext}`;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
export const tooBigReason = (bytes: number) => `too big (${megabytes(bytes)}; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB)`;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Incoming = { rel: string; bytes: Buffer; source: string; readmeRef?: boolean; hash?: string };

/** Adds one file to the kit in memory (the caller writes kit.json). Returns the asset or why it was skipped. */
async function ingest(stored: StoredKit, item: Incoming): Promise<BrandAsset | SkippedFile> {
  const name = item.rel;
  const ext = extOf(item.rel);
  if (!baseKind(ext)) return { name, reason: ext ? `unsupported type (.${ext}); send images, videos, fonts, PDFs or Markdown` : "unsupported type (no extension)" };
  if (item.bytes.length === 0) return { name, reason: "empty file" };
  if (item.bytes.length > MAX_FILE_BYTES) return { name, reason: tooBigReason(item.bytes.length) };
  const hash = item.hash ?? sha256(item.bytes);
  const duplicate = Object.entries(stored.index.hashes).find(([, h]) => h === hash)?.[0];
  if (duplicate) return { name, reason: `already in the kit (${duplicate})` };
  if (stored.assets.length >= MAX_ASSETS) return { name, reason: `the kit is full (${MAX_ASSETS} files); remove some first` };

  const id = `a${stored.index.next_id++}`;
  const fileName = `${id}-${cleanFileName(item.rel.split("/").pop() ?? "file")}`;
  const dir = filesDir(stored.brand_id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  // An orphan left by a lost kit.json may hold this name; no asset points at it, so replace it
  // (rm first: writeFile would follow a symlink, rm does not).
  await rm(path, { force: true });
  await writeFile(path, item.bytes, { flag: "wx" });
  const size = await mediaSize(path, ext, item.bytes);
  const kind = classifyAsset(item.rel, size, { readmeRef: item.readmeRef }) ?? "doc";
  const asset: BrandAsset = { id, kind, path, source: item.source, caption: defaultCaption(item.rel, kind), bytes: item.bytes.length };
  if (size) {
    asset.width = size.width;
    asset.height = size.height;
  }
  stored.assets.push(asset);
  stored.index.hashes[id] = hash;
  return asset;
}

/**
 * Adds uploaded files (folder uploads send relative paths such as "brand/logo.svg" as the name).
 * Skips duplicates, oversized and unsupported files, and anything that tries to escape the kit.
 */
export async function addUploadedFiles(brandId: string, files: Array<{ name: string; bytes: Buffer }>): Promise<IntakeResult> {
  kitDir(brandId);
  return withLock(brandId, async () => {
    const stored = readStored(brandId);
    const added: BrandAsset[] = [];
    const skipped: SkippedFile[] = [];
    for (const file of files) {
      const label = String(file.name ?? "").slice(0, 200);
      const clean = cleanRelativePath(file.name);
      if ("error" in clean) {
        skipped.push({ name: label, reason: clean.error });
        continue;
      }
      const result = await ingest(stored, { rel: clean.rel, bytes: file.bytes, source: "upload" });
      if ("reason" in result) skipped.push({ name: label, reason: result.reason });
      else added.push(result);
    }
    if (added.length) {
      await writeStored(stored);
      await logEvent({ brandId, message: `Brand kit: added ${added.length} file${added.length === 1 ? "" : "s"}` }).catch(() => undefined);
    }
    return { kit: publicKit(stored), added, skipped };
  });
}

export async function removeAsset(brandId: string, assetId: string): Promise<BrandKit> {
  kitDir(brandId);
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) throw new BrandKitError(404, "No such file in the brand kit.");
  return withLock(brandId, async () => {
    const stored = readStored(brandId);
    const asset = stored.assets.find((a) => a.id === assetId);
    if (!asset) throw new BrandKitError(404, "No such file in the brand kit.");
    await deleteAssetFile(brandId, asset);
    stored.assets = stored.assets.filter((a) => a.id !== assetId);
    delete stored.index.hashes[assetId];
    delete stored.index.vision[assetId];
    await writeStored(stored);
    return publicKit(stored);
  });
}

/** Drops the repo scan and every asset it copied in; uploads stay. */
export async function forgetRepo(brandId: string): Promise<BrandKit> {
  kitDir(brandId);
  return withLock(brandId, async () => {
    const stored = readStored(brandId);
    for (const asset of stored.assets.filter((a) => a.source.startsWith("repo:"))) {
      await deleteAssetFile(brandId, asset);
      delete stored.index.hashes[asset.id];
      delete stored.index.vision[asset.id];
    }
    stored.assets = stored.assets.filter((a) => !a.source.startsWith("repo:"));
    stored.repo = null;
    await writeStored(stored);
    return publicKit(stored);
  });
}

// ---------- repo source ----------

export type RepoSource = { kind: "remote"; host: "github" | "gitlab"; url: string; origin: string } | { kind: "local"; path: string; origin: string };

const SOURCE_HELP = "Paste a public https://github.com/… or https://gitlab.com/… link, or the absolute path of a folder on this machine.";

/** Validates a GitHub or GitLab https link and builds the clone URL from its owner and repo only. */
export function parseRepoUrl(input: string): Extract<RepoSource, { kind: "remote" }> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new BrandKitError(400, `That isn't a link we can scan. ${SOURCE_HELP}`);
  }
  if (url.protocol !== "https:") throw new BrandKitError(400, `Only https:// links can be scanned. ${SOURCE_HELP}`);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com" && host !== "gitlab.com") throw new BrandKitError(400, `Only GitHub and GitLab repositories can be linked, not ${host}. ${SOURCE_HELP}`);
  if (url.username || url.password) throw new BrandKitError(400, "Remove the user name or token from the link: only public repositories can be scanned.");
  if (url.port) throw new BrandKitError(400, `That link has a port number. ${SOURCE_HELP}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const repoParts = host === "github.com" ? parts.slice(0, 2) : parts.slice(0, parts.includes("-") ? parts.indexOf("-") : parts.length);
  if (repoParts.length < 2 || repoParts.length > 10) throw new BrandKitError(400, `Link to a repository, like https://${host}/owner/repo.`);
  repoParts[repoParts.length - 1] = repoParts[repoParts.length - 1].replace(/\.git$/i, "");
  if (repoParts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || part === "." || part === ".." || part.startsWith("-"))) {
    throw new BrandKitError(400, "That repository link has characters we don't expect in an owner or repository name.");
  }
  const path = repoParts.join("/");
  const name = host === "github.com" ? "github" : "gitlab";
  return { kind: "remote", host: name, url: `https://${host}/${path}.git`, origin: `${name}:${path}` };
}

/** A repo link or a local folder; refuses everything else with a message the brand can act on. */
export async function resolveRepoSource(input: string): Promise<RepoSource> {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new BrandKitError(400, SOURCE_HELP);
  if (raw.length > 1000) throw new BrandKitError(400, "That link or path is too long.");
  if (/^(www\.)?(github|gitlab)\.com\//i.test(raw)) return parseRepoUrl(`https://${raw}`);
  if (/^[\w.-]+@[\w.-]+:/.test(raw)) throw new BrandKitError(400, `SSH links can't be scanned; use the https:// link. ${SOURCE_HELP}`);
  let path = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      path = fileURLToPath(raw);
    } catch {
      throw new BrandKitError(400, SOURCE_HELP);
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return parseRepoUrl(raw);
  }
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
  if (!isAbsolute(path)) throw new BrandKitError(400, `Use an absolute folder path (like /Users/you/code/app). ${SOURCE_HELP}`);
  let real: string;
  try {
    real = await realpath(resolve(path));
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new BrandKitError(400, `There is no folder at ${path} on this machine.`);
  }
  if (real === sep || real === resolve(homedir())) throw new BrandKitError(400, "That folder is too broad to scan; point at the project's own folder.");
  return { kind: "local", path: real, origin: `local:${real}` };
}

/** git, run without a shell. Replaced in tests so nothing touches the network. */
export const gitRunner = {
  run(args: string[], options: { timeout: number; env: Record<string, string> }): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const env = options.env as unknown as NodeJS.ProcessEnv; // only what cloneRepo passes, not the server's environment
      execFile("git", args, { timeout: options.timeout, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        else resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
  },
};

/** A shallow clone into a temp folder. No credentials, no prompts, no user or system git config. */
async function cloneRepo(source: Extract<RepoSource, { kind: "remote" }>): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const tmp = await mkdtemp(join(tmpdir(), "nomen-repo-"));
  const dir = join(tmp, "repo");
  const cleanup = () => rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
    HOME: tmp,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "GIT_SSL_CAINFO"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const args = ["-c", "credential.helper=", "-c", "core.symlinks=false", "clone", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:limit=25m", "--", source.url, dir];
  try {
    await gitRunner.run(args, { timeout: CLONE_TIMEOUT_MS, env });
  } catch (error) {
    await cleanup();
    const e = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string | null };
    if (e.code === "ENOENT") throw new BrandKitError(500, "git is not installed on this machine, so repositories can't be cloned. Paste a local folder path instead.");
    if (e.killed || e.signal) throw new BrandKitError(504, `Cloning took longer than ${CLONE_TIMEOUT_MS / 1000} seconds. Try again, or clone it yourself and paste the folder path.`);
    const stderr = String(e.stderr ?? "");
    if (/could not read (username|password)|authentication|terminal prompts disabled|repository not found|not found|\b40[134]\b/i.test(stderr)) {
      throw new BrandKitError(422, "We couldn't clone that repository: it is private or doesn't exist. Only public repositories can be scanned (private repos aren't supported yet); for a private one, clone it yourself and paste the folder path.");
    }
    const last = stderr.trim().split("\n").filter(Boolean).pop() ?? e.message;
    throw new BrandKitError(502, `git clone failed: ${last.slice(0, 300)}`);
  }
  return { root: dir, cleanup };
}

// ---------- repo walk ----------

type RepoFile = { rel: string; abs: string; size: number; ext: string; name: string };

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "vendor", "coverage", ".venv", "venv", "__pycache__", ".turbo", ".vercel", ".cache",
  ".parcel-cache", ".svelte-kit", ".nuxt", ".output", "target", "bower_components", "Pods", "DerivedData", ".pnpm-store", ".yarn", "storybook-static", ".expo",
]);
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "npm-shrinkwrap.json", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum", "uv.lock", "Pipfile.lock", "pdm.lock", "flake.lock"]);

const skipDir = (name: string) => SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".github");

/** Breadth-first (shallow files first, so the caps cut deep files), never following symlinks. */
async function walkRepo(root: string): Promise<{ files: RepoFile[]; truncated: boolean; bytes: number }> {
  const files: RepoFile[] = [];
  const queue: string[] = [""];
  let visited = 0;
  let bytes = 0;
  let truncated = false;
  for (let q = 0; q < queue.length && !truncated; q++) {
    const relDir = queue[q];
    let entries;
    try {
      entries = await readdir(relDir ? join(root, ...relDir.split("/")) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > MAX_REPO_FILES) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDir(entry.name) && rel.split("/").length < 14) queue.push(rel);
        continue;
      }
      if (!entry.isFile() || LOCKFILES.has(entry.name)) continue;
      const abs = join(root, ...rel.split("/"));
      try {
        const info = await lstat(abs);
        if (!info.isFile()) continue;
        bytes += info.size;
        files.push({ rel, abs, size: info.size, ext: extOf(entry.name), name: entry.name });
      } catch {
        // vanished mid-walk
      }
    }
  }
  return { files, truncated, bytes };
}

type Budget = { read: number };

/** Reads at most `max` bytes without following a symlink, charged to the scan's read budget. */
async function readCapped(abs: string, max: number, budget: Budget): Promise<Buffer | null> {
  if (budget.read >= MAX_REPO_READ) return null;
  const handle = await open(abs, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const length = Math.min(info.size, max, MAX_REPO_READ - budget.read);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    budget.read += bytesRead;
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readText(file: RepoFile, max: number, budget: Budget): Promise<string | null> {
  const buffer = await readCapped(file.abs, max, budget);
  if (!buffer || buffer.subarray(0, 8000).includes(0)) return null;
  return buffer.toString("utf8");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------- colors ----------

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("")}`;

function hslToHex(h: number, s: number, l: number) {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = clamp01(s / 100);
  const light = clamp01(l / 100);
  if (sat === 0) return toHex(light, light, light);
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex(channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3));
}

function oklchToHex(l: number, c: number, h: number) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);
  return toHex(
    gamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    gamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    gamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  );
}

/**
 * A CSS color as #rrggbb (alpha dropped): hex, rgb(), hsl(), oklch(), and shadcn's bare HSL
 * triplets ("222.2 84% 4.9%"). Null for anything else (names, gradients, var() references).
 */
export function parseColor(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\s*!important$/, "");
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) return `#${hex.slice(0, 3).split("").map((ch) => ch + ch).join("")}`;
    if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`;
    return null;
  }
  const num = (s: string, scale: number) => (s.endsWith("%") ? (Number(s.slice(0, -1)) / 100) * scale : Number(s));
  m = v.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/);
  if (m) return toHex(num(m[1], 255) / 255, num(m[2], 255) / 255, num(m[3], 255) / 255);
  m = v.match(/^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/) ?? v.match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (m) return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
  m = v.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+(-?[\d.]+)(?:deg)?(?:\s*\/\s*[\d.]+%?)?\s*\)$/);
  if (m) return oklchToHex(num(m[1], 1), num(m[2], 0.4), Number(m[3]));
  return null;
}

/** `var(--primary)` or `hsl(var(--primary))`: the name it points at. */
const aliasOf = (value: string) => value.trim().match(/^(?:(?:hsla?|rgba?|oklch)\(\s*)?var\(\s*--([\w-]+)\s*(?:,[^)]*)?\)\s*(?:\/\s*[^)]*)?\)?$/)?.[1] ?? null;

// Tailwind's default palette (v3 hex values) for brands that use it straight from class names.
const TAILWIND_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const TAILWIND_PALETTE: Record<string, string> = {
  red: "fef2f2 fee2e2 fecaca fca5a5 f87171 ef4444 dc2626 b91c1c 991b1b 7f1d1d 450a0a",
  orange: "fff7ed ffedd5 fed7aa fdba74 fb923c f97316 ea580c c2410c 9a3412 7c2d12 431407",
  amber: "fffbeb fef3c7 fde68a fcd34d fbbf24 f59e0b d97706 b45309 92400e 78350f 451a03",
  yellow: "fefce8 fef9c3 fef08a fde047 facc15 eab308 ca8a04 a16207 854d0e 713f12 422006",
  lime: "f7fee7 ecfccb d9f99d bef264 a3e635 84cc16 65a30d 4d7c0f 3f6212 365314 1a2e05",
  green: "f0fdf4 dcfce7 bbf7d0 86efac 4ade80 22c55e 16a34a 15803d 166534 14532d 052e16",
  emerald: "ecfdf5 d1fae5 a7f3d0 6ee7b7 34d399 10b981 059669 047857 065f46 064e3b 022c22",
  teal: "f0fdfa ccfbf1 99f6e4 5eead4 2dd4bf 14b8a6 0d9488 0f766e 115e59 134e4a 042f2e",
  cyan: "ecfeff cffafe a5f3fc 67e8f9 22d3ee 06b6d4 0891b2 0e7490 155e75 164e63 083344",
  sky: "f0f9ff e0f2fe bae6fd 7dd3fc 38bdf8 0ea5e9 0284c7 0369a1 075985 0c4a6e 082f49",
  blue: "eff6ff dbeafe bfdbfe 93c5fd 60a5fa 3b82f6 2563eb 1d4ed8 1e40af 1e3a8a 172554",
  indigo: "eef2ff e0e7ff c7d2fe a5b4fc 818cf8 6366f1 4f46e5 4338ca 3730a3 312e81 1e1b4b",
  violet: "f5f3ff ede9fe ddd6fe c4b5fd a78bfa 8b5cf6 7c3aed 6d28d9 5b21b6 4c1d95 2e1065",
  purple: "faf5ff f3e8ff e9d5ff d8b4fe c084fc a855f7 9333ea 7e22ce 6b21a8 581c87 3b0764",
  fuchsia: "fdf4ff fae8ff f5d0fe f0abfc e879f9 d946ef c026d3 a21caf 86198f 701a75 4a044e",
  pink: "fdf2f8 fce7f3 fbcfe8 f9a8d4 f472b6 ec4899 db2777 be185d 9d174d 831843 500724",
  rose: "fff1f2 ffe4e6 fecdd3 fda4af fb7185 f43f5e e11d48 be123c 9f1239 881337 4c0519",
};

function tailwindDefault(name: string): string | null {
  const m = name.match(/^([a-z]+)-(\d{2,3})$/);
  const row = m ? TAILWIND_PALETTE[m[1]] : undefined;
  const i = m ? TAILWIND_SHADES.indexOf(Number(m[2])) : -1;
  return row && i >= 0 ? `#${row.split(" ")[i]}` : null;
}

const COLOR_UTILITY =
  /(?<![\w-])(?:bg|text|border(?:-[trblxy])?|ring(?:-offset)?|from|via|to|fill|stroke|outline|decoration|shadow|accent|caret|divide|placeholder)-([a-z][a-z0-9]*(?:-[a-z0-9]+){0,4})(?:\/\d{1,3})?(?![\w-])/g;

// ---------- a tiny JS object-literal reader (never evaluates anything) ----------

type Token = { t: "str" | "id" | "p"; v: string };

function tokenize(src: string, start: number, limit = 200_000): Token[] {
  const tokens: Token[] = [];
  const end = Math.min(src.length, start + limit);
  let depth = 0;
  for (let i = start; i < end; ) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? end : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close < 0 ? end : close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let value = "";
      let dynamic = false;
      while (j < end && src[j] !== ch) {
        if (src[j] === "\\") {
          value += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (ch === "`" && src[j] === "$" && src[j + 1] === "{") dynamic = true;
        value += src[j];
        j++;
      }
      tokens.push(dynamic ? { t: "id", v: "`template`" } : { t: "str", v: value });
      i = j + 1;
      continue;
    }
    const word = src.slice(i, i + 80).match(/^[A-Za-z0-9_$][A-Za-z0-9_$.]*/);
    if (word) {
      tokens.push({ t: "id", v: word[0] });
      i += word[0].length;
      continue;
    }
    if (src.startsWith("...", i)) {
      tokens.push({ t: "p", v: "..." });
      i += 3;
      continue;
    }
    tokens.push({ t: "p", v: ch });
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth <= 0) break;
    }
    i++;
  }
  return tokens;
}

/** Skips one expression; stops before a `,` `}` `]` or `)` at depth 0. */
function skipExpression(tokens: Token[], pos: number) {
  let depth = 0;
  for (; pos < tokens.length; pos++) {
    const { t, v } = tokens[pos];
    if (t !== "p") continue;
    if (v === "{" || v === "[" || v === "(") depth++;
    else if (v === "}" || v === "]" || v === ")") {
      if (depth === 0) return pos;
      depth--;
    } else if (v === "," && depth === 0) return pos;
  }
  return pos;
}

type Leaf = (path: string[], value: string) => void;

function parseValue(tokens: Token[], pos: number, path: string[], visit: Leaf, steps: { n: number }): number {
  if (++steps.n > 20_000) return tokens.length;
  const token = tokens[pos];
  if (!token) return pos;
  if (token.t === "p" && token.v === "{") return parseObject(tokens, pos, path, visit, steps);
  if (token.t === "p" && token.v === "[") {
    pos++;
    let index = 0;
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.t === "p" && tok.v === "]") return pos + 1;
      if (tok.t === "p" && tok.v === ",") {
        pos++;
        continue;
      }
      pos = parseValue(tokens, pos, [...path, String(index++)], visit, steps);
    }
    return pos;
  }
  if (token.t === "str") {
    const next = tokens[pos + 1];
    if (!next || (next.t === "p" && (next.v === "," || next.v === "}" || next.v === "]"))) {
      visit(path, token.v);
      return pos + 1;
    }
  }
  return skipExpression(tokens, pos);
}

function parseObject(tokens: Token[], pos: number, path: string[], visit: Leaf, steps: { n: number }): number {
  pos++; // past "{"
  while (pos < tokens.length) {
    if (++steps.n > 20_000) return tokens.length;
    const token = tokens[pos];
    if (token.t === "p" && token.v === "}") return pos + 1;
    if (token.t === "p" && token.v === ",") {
      pos++;
      continue;
    }
    if (token.t === "p" && token.v === "...") {
      pos = skipExpression(tokens, pos + 1);
      continue;
    }
    if (token.t === "p" && token.v === "[") {
      // computed key: skip the whole property
      pos = skipExpression(tokens, pos);
      continue;
    }
    const key = token.v;
    const colon = tokens[pos + 1];
    if (colon?.t === "p" && colon.v === ":") {
      pos = parseValue(tokens, pos + 2, [...path, key], visit, steps);
    } else {
      pos = skipExpression(tokens, pos + 1);
    }
  }
  return pos;
}

/** Calls `visit(path, string)` for every string leaf of each `<key>: { ... }` object in the source. */
function walkObjects(src: string, key: RegExp, visit: Leaf) {
  for (const match of src.matchAll(key)) {
    const brace = (match.index ?? 0) + match[0].length - 1;
    if (src[brace] !== "{") continue;
    parseObject(tokenize(src, brace), 0, [], visit, { n: 0 });
  }
}

// ---------- fonts ----------

const GENERIC_FONTS = new Set([
  "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "-apple-system",
  "blinkmacsystemfont", "inherit", "initial", "unset", "revert", "emoji", "math", "segoe ui", "helvetica neue", "helvetica", "arial", "apple color emoji",
  "segoe ui emoji", "segoe ui symbol", "noto color emoji", "times new roman", "courier new", "menlo", "monaco", "consolas", "sfmono-regular", "liberation mono",
]);

/** The first family of a font-family value, unless it is generic or a variable. */
function firstFamily(value: string): string | null {
  const first = value.split(",")[0]?.trim().replace(/^["']|["']$/g, "").trim() ?? "";
  if (!first || first.length > 60 || /[(){}$<>;]|^var\b/i.test(first) || GENERIC_FONTS.has(first.toLowerCase())) return null;
  return first;
}

const titleWords = (slug: string) => slug.split(/[-_ ]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// ---------- README ----------

function cleanInline(text: string) {
  return decodeEntities(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/[*_`~]/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function readmeTitle(md: string): string {
  for (const line of md.split("\n").slice(0, 80)) {
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) {
      const title = cleanInline(m[1]);
      if (title) return title.slice(0, 100);
    }
  }
  const h1 = md.match(/<h1[^>]*>([\s\S]{1,400}?)<\/h1>/i);
  if (h1) {
    const title = cleanInline(h1[1]);
    if (title) return title.slice(0, 100);
  }
  const setext = md.match(/^([^\n#<![][^\n]{1,80})\n=+[ \t]*$/m);
  return setext ? cleanInline(setext[1]).slice(0, 100) : "";
}

function readmeParagraph(md: string): string {
  const withoutCode = md.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  for (const block of withoutCode.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed || /^(#|<|!\[|\[!\[|\||-{3}|={3}|```|>|[-*+] |\d+\. )/.test(trimmed)) continue;
    const text = cleanInline(trimmed);
    if (text.length >= 20) return text.slice(0, 300);
  }
  return "";
}

const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "zsh", "console", "terminal", "shell-session", "shellsession", "fish", "powershell", "ps", "ps1", "pwsh", "cmd", "bat", "nu"]);
const COMMAND_START = /^(npx|npm|pnpm|pnpx|yarn|bun|bunx|deno|pip3?|pipx|uv|uvx|poetry|conda|curl|wget|brew|cargo|go|docker|docker-compose|kubectl|helm|git clone|gem|composer|sudo|apt|apt-get|choco|scoop|winget|iwr|irm|nix|snap)\b/;
/** Developer chores (setting up the repo itself), not something the product's users type. */
const CHORE =
  /^(cd|export|echo|cp|mv|rm|source|cat|ls|mkdir|touch|set)\b|^(npm|pnpm|bun)\s+run\b|^(npm|yarn|pnpm|bun)\s+(dev|build|start|test|lint|format|typecheck|preview|storybook|clean)\b|^(npm|pnpm|bun)\s+(i|install|ci)$|^yarn(\s+install)?$/;

/**
 * Commands a user types, from fenced shell blocks and `$ ` lines. `names` are the product's own
 * command and package names: lines that use them come first (`npx acme init`, `brew install acme`),
 * and system chores that don't (`sudo apt update`) are dropped.
 */
function readmeCommands(md: string, names: string[]): string[] {
  const out: Array<{ line: string; mine: boolean }> = [];
  // "acme" in `npx acme`, `brew install acme`, `pip install acme[cli]` or https://acme.dev/install.sh
  const patterns = names.map((name) => new RegExp(`(^|[\\s/@'"=])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s@/'".:[=]|$)`, "i"));
  const mentions = (line: string) => patterns.some((pattern) => pattern.test(line));
  let lang: string | null = null;
  let fence = "";
  let pending = "";
  for (const raw of md.split("\n")) {
    const t = raw.trim();
    if (lang === null) {
      const m = t.match(/^(`{3,}|~{3,})\s*([\w+-]*)/);
      if (m) {
        lang = m[2].toLowerCase();
        fence = m[1];
      }
      continue;
    }
    if (t.startsWith(fence) && /^(`{3,}|~{3,})\s*$/.test(t)) {
      lang = null;
      pending = "";
      continue;
    }
    let line = pending ? `${pending} ${t}` : t;
    if (line.endsWith("\\")) {
      pending = line.slice(0, -1).trim();
      continue;
    }
    pending = "";
    const prompted = /^\$\s+/.test(line);
    line = line
      .replace(/^(\$|%|PS>|>)\s+/, "")
      .replace(/\s+#\s.*$/, "")
      .trim();
    if (!line || line.startsWith("#") || line.length > 200 || CHORE.test(line)) continue;
    const mine = mentions(line);
    const runsProduct = names.some((name) => line.toLowerCase() === name.toLowerCase() || line.toLowerCase().startsWith(`${name.toLowerCase()} `));
    if (!prompted && !(SHELL_LANGS.has(lang) && (COMMAND_START.test(line) || runsProduct))) continue;
    if (!mine && /^sudo\b/.test(line)) continue;
    out.push({ line, mine });
  }
  // the product's own commands first, each group in README order
  return [...out.filter((c) => c.mine), ...out.filter((c) => !c.mine)].map((c) => c.line);
}

// ---------- JSX text ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…", copy: "©", middot: "·", rarr: "→" };

function decodeEntities(text: string) {
  return text.replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** Looks like words a person reads, not code, a class list or a URL. */
function isUiString(text: string) {
  if (text.length < 2 || text.length > 120 || !/\p{L}/u.test(text)) return false;
  if (/[;=]|=>|&&|\|\||\$\{|^\/\/|^https?:|^[@./#]|\bclassName\b|\bfunction\b|\breturn\b|\bconst\b/.test(text)) return false;
  if (/^[a-z0-9]+([-_:/.][a-z0-9]+)+$/.test(text)) return false; // btn-primary, md:flex, a.b
  if (/^[a-z][a-zA-Z0-9]*$/.test(text) && /[A-Z]/.test(text)) return false; // camelCase identifiers
  const words = text.split(/\s+/);
  if (words.length > 1 && words.every((word) => /[-:]/.test(word) && /^[a-z0-9:/[\]._-]+$/.test(word))) return false; // "flex items-center gap-2"
  return true;
}

type JsxText = { headings: string[]; buttons: string[]; other: string[]; attrs: string[] };

function jsxText(src: string): JsxText {
  const out: JsxText = { headings: [], buttons: [], other: [], attrs: [] };
  for (const m of src.matchAll(/>\s{0,40}([^<>{}]{1,300}?)\s{0,40}<\/([A-Za-z][\w.]{0,40})\s{0,5}>/g)) {
    const text = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
    if (!isUiString(text)) continue;
    const tag = m[2];
    if (/^h[1-6]$/i.test(tag) || /^(CardTitle|Title|Heading|DialogTitle)$/.test(tag)) out.headings.push(text);
    else if (/^(button|Button|a|Link|NavLink|NextLink|RouterLink)$/.test(tag) || /Button$|Cta$|CTA$/.test(tag)) out.buttons.push(text);
    else out.other.push(text);
  }
  for (const m of src.matchAll(/\b(?:placeholder|aria-label|title|label)\s{0,3}=\s{0,3}(?:\{\s{0,3})?(["'`])([^"'`{}<>$\n]{2,100})\1/g)) {
    const text = decodeEntities(m[2]).replace(/\s+/g, " ").trim();
    if (isUiString(text)) out.attrs.push(text);
  }
  return out;
}

function summarize(src: string, fallback: string): string {
  const text = jsxText(src);
  const title = src.match(/\btitle\s*:\s*["'`]([^"'`\n]{3,90})["'`]/)?.[1];
  const main = text.headings[0] ?? title ?? text.other.find((s) => s.split(" ").length >= 3) ?? "";
  if (!main && !text.buttons.length) return "";
  const head = (main || fallback).slice(0, 140);
  const join = (buttons: string[]) => [head, buttons.length ? `buttons: ${buttons.map((b) => `"${b}"`).join(", ")}` : ""].filter(Boolean).join("; ");
  // whole buttons only, so a summary never ends inside a quote
  const buttons: string[] = [];
  for (const button of new Set(text.buttons)) {
    if (buttons.length >= 3 || join([...buttons, button]).length > 180) break;
    buttons.push(button);
  }
  return join(buttons);
}

// ---------- screens and components ----------

const UI_EXT = new Set(["tsx", "jsx", "vue", "svelte", "astro", "html", "mdx"]);
const CODE_EXT = new Set(["ts", "js", "mjs", "cjs", "mts", "cts"]);
const CSS_EXT = new Set(["css", "scss", "sass", "less", "pcss", "postcss", "styl"]);

const isTestOrExample = (rel: string) =>
  /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright|fixtures?|stories|\.storybook|examples?|scripts)(\/|$)/i.test(rel) || /\.(test|spec|stories|story)\.\w+$|\.d\.ts$|\.min\.\w+$/i.test(rel);

function routeOf(rel: string): string | null {
  let m = rel.match(/(?:^|\/)app\/((?:[^/]+\/)*)page\.(?:tsx|jsx|ts|js|mdx|md)$/);
  if (m) {
    const segments = m[1].split("/").filter(Boolean);
    if (segments.some((s) => s.startsWith("_"))) return null;
    return `/${segments.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@")).join("/")}`;
  }
  m = rel.match(/(?:^|\/)routes\/((?:[^/]+\/)*)\+page\.svelte$/);
  if (m) return `/${m[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s)).join("/")}`;
  m = rel.match(/(?:^|\/)pages\/(.+)\.(?:tsx|jsx|js|ts|mdx|md|astro|vue|svelte)$/);
  if (m) {
    const path = m[1];
    if (/(^|\/)_|^api\//.test(path) || /(^|\/)(404|500)$/.test(path)) return null;
    const segments = path.split("/");
    if (segments.at(-1)?.toLowerCase() === "index") segments.pop();
    return `/${segments.join("/")}`;
  }
  return null;
}

const KEY_COMPONENTS: Array<[RegExp, number]> = [
  [/hero/i, 10],
  [/dashboard/i, 10],
  [/terminal|console|shell|cli/i, 9],
  [/pricing|plans/i, 8],
  [/demo|playground|editor/i, 8],
  [/chat|composer|prompt/i, 7],
  [/navbar|^nav$|navigation|header|topbar/i, 7],
  [/feature/i, 6],
  [/sidebar/i, 6],
  [/card/i, 5],
  [/cta|signup|sign-?up|onboarding|getstarted/i, 5],
  [/footer/i, 4],
  [/testimonial|logocloud|socialproof/i, 4],
  [/table|list|grid|stats?/i, 3],
  [/modal|dialog|command|search/i, 3],
  [/button/i, 2],
];

function componentName(rel: string): string {
  const parts = rel.split("/");
  const file = parts.at(-1) ?? "";
  let stem = file.replace(/\.[^.]+$/, "");
  if (stem.toLowerCase() === "index" && parts.length > 1) stem = parts.at(-2) ?? stem;
  return stem
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
}

/** ~40 lines from where the markup starts: JSX structure and class names, without imports. */
function excerpt(src: string, lines = 40): string {
  const all = src.split("\n");
  let start = all.findIndex((line) => /^\s*<template\b/.test(line));
  if (start < 0) {
    const ret = all.findIndex((line) => /\breturn\s*\(\s*$|\breturn\s*\(?\s*</.test(line));
    if (ret >= 0) {
      const signature = all.slice(Math.max(0, ret - 6), ret).findLastIndex((line) => /\b(function|const|class)\s+[A-Z]/.test(line));
      start = signature >= 0 ? Math.max(0, ret - 6) + signature : ret;
    }
  }
  if (start < 0) start = all.findIndex((line) => /^\s*<[A-Za-z]/.test(line));
  if (start < 0) start = 0;
  return all
    .slice(start)
    .filter((line) => !/^\s*import\s/.test(line) && line.trim() !== "")
    .slice(0, lines)
    .map((line) => (line.length > 160 ? `${line.slice(0, 157)}...` : line.replace(/\s+$/, "")))
    .join("\n");
}

// ---------- the scan ----------

type Text = { file: RepoFile; text: string };
type Package = { file: RepoFile; pkg: Record<string, unknown> };
type AssetCandidate = { file: RepoFile; priority: number; readmeRef: boolean };
/** The repo's text, read once: stylesheets, Tailwind configs, theme files and source (UI files are a subset). */
type Sources = { css: Text[]; tailwind: Text[]; themes: Text[]; code: Text[]; ui: Text[] };

const BOILERPLATE = new Set(["public/next.svg", "public/vercel.svg", "public/file.svg", "public/globe.svg", "public/window.svg", "public/vite.svg", "src/assets/react.svg", "src/assets/vue.svg", "src/assets/svelte.svg", "src/assets/astro.svg"]);
const ASSET_DIRS = /^(public|assets|static|brand|branding|images?|img|media|docs?|screenshots?|resources|res|\.github|logos?|icons?|fonts?)$/i;
const ICON_FONT = /fontawesome|^fa-|glyphicons|icomoon|material-?icons|material-?symbols|codicon|katex|^icons?\b|bootstrap-icons|remixicon|ionicons/i;
const GENERIC_PACKAGE_NAMES = /^(my-app|app|web|frontend|client|website|site|root|monorepo|workspace|nextjs|next-app|vite-project|react-app|docs|ui|main|cli|server|api)$/i;

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const unscoped = (name: string) => name.replace(/^@[^/]+\//, "");
const tomlField = (toml: string, field: string) => toml.match(new RegExp(`^\\s*${field}\\s*=\\s*["']([^"'\\n]{1,300})["']`, "m"))?.[1] ?? "";

type Analysis = { scan: RepoScan; assets: AssetCandidate[] };

async function analyzeRepo(source: RepoSource, files: RepoFile[], budget: Budget): Promise<Analysis> {
  const byRel = new Map(files.map((file) => [file.rel, file]));
  const depth = (file: RepoFile) => file.rel.split("/").length;
  const read = async (file: RepoFile | undefined, max = 512 * 1024) => (file ? readText(file, max, budget) : null);

  const packageFiles = files.filter((f) => f.name === "package.json" && depth(f) <= 4).sort((a, b) => depth(a) - depth(b)).slice(0, 25);
  const packages = (
    await mapLimit(packageFiles, 8, async (file): Promise<Package | null> => {
      try {
        const pkg = JSON.parse((await read(file, 256 * 1024)) ?? "null") as unknown;
        return pkg && typeof pkg === "object" && !Array.isArray(pkg) ? { file, pkg: pkg as Record<string, unknown> } : null;
      } catch {
        return null;
      }
    })
  ).filter((p): p is Package => p !== null);
  const readmeFile =
    files.find((f) => depth(f) === 1 && /^readme(\.(md|markdown|mdx|txt|rst))?$/i.test(f.name)) ?? files.filter((f) => /^readme\.(md|markdown|mdx)$/i.test(f.name)).sort((a, b) => depth(a) - depth(b))[0];
  const readme = (await read(readmeFile, 256 * 1024)) ?? "";
  const pyproject = (await read(byRel.get("pyproject.toml"), 128 * 1024)) ?? "";
  const cargo = (await read(byRel.get("Cargo.toml"), 128 * 1024)) ?? "";

  const project = describeProject(source, packages, readme, pyproject, cargo);
  const commands = extractCommands(readme, packages, project.commandNames);

  const readAll = async (list: RepoFile[]) =>
    (await mapLimit(list, 16, async (file) => ({ file, text: await read(file) }))).filter((t): t is Text => t.text !== null && !isMinified(t.text));
  const tailwindFiles = files.filter((f) => /^tailwind\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(f.name)).slice(0, 10);
  const code = await readAll(
    files.filter((f) => (UI_EXT.has(f.ext) || CODE_EXT.has(f.ext)) && !isTestOrExample(f.rel) && f.size <= (UI_EXT.has(f.ext) ? 256 : 128) * 1024).slice(0, 4000),
  );
  const sources: Sources = {
    css: await readAll(files.filter((f) => CSS_EXT.has(f.ext) && !isTestOrExample(f.rel)).slice(0, 400)),
    tailwind: await readAll(tailwindFiles),
    themes: await readAll(files.filter((f) => /theme|palette|colors|tokens/i.test(f.name) && /^(js|ts|mjs|cjs|jsx|tsx|json)$/.test(f.ext) && !isTestOrExample(f.rel) && f.size <= 256 * 1024 && !tailwindFiles.includes(f)).slice(0, 40)),
    code,
    ui: code.filter((s) => UI_EXT.has(s.file.ext)),
  };

  const assets = pickAssets(files, readmeImages(readme, readmeFile, byRel));
  const logos: Text[] = [];
  for (const candidate of assets.filter((a) => a.file.ext === "svg" && classifyAsset(a.file.rel) === "logo").slice(0, 3)) {
    const text = await read(candidate.file, 256 * 1024);
    if (text) logos.push({ file: candidate.file, text });
  }

  const screens = extractScreens(sources);
  const components = extractComponents(sources, screens);
  const scan: RepoScan = {
    origin: source.origin,
    scanned_at: now(),
    name: project.name.slice(0, 100),
    description: project.description,
    readme: readme.slice(0, 4000),
    colors: extractColors(sources, logos),
    fonts: extractFonts(sources, packages),
    commands,
    screens,
    components,
    ui_strings: extractUiStrings(sources, screens, components),
  };
  return { scan, assets };
}

/** Name, description, and the names its users type (bins, package names, the repo's slug). */
function describeProject(source: RepoSource, packages: Package[], readme: string, pyproject: string, cargo: string) {
  const rootPkg = packages.find((p) => p.file.rel === "package.json")?.pkg ?? null;
  const title = readmeTitle(readme);
  const pkgName = str(rootPkg?.name);
  const plain = (s: string) => unscoped(s.toLowerCase()).replace(/[^a-z0-9]/g, "");
  const slug = source.kind === "remote" ? (source.origin.split("/").pop() ?? "") : (source.path.split(sep).pop() ?? "");
  let name = "";
  if (pkgName && !GENERIC_PACKAGE_NAMES.test(unscoped(pkgName))) name = title && plain(title) === plain(pkgName) ? title : pkgName;
  name ||= tomlField(pyproject, "name") || tomlField(cargo, "name") || (title.length <= 60 ? title : "") || slug;
  const description = (str(rootPkg?.description) || tomlField(pyproject, "description") || tomlField(cargo, "description") || readmeParagraph(readme)).slice(0, 400);

  const commandNames = new Set<string>();
  for (const { pkg } of packages) {
    if (!pkg.bin) continue;
    if (str(pkg.name)) commandNames.add(unscoped(str(pkg.name)));
    if (pkg.bin && typeof pkg.bin === "object") Object.keys(pkg.bin as object).forEach((bin) => commandNames.add(bin));
  }
  const scripts = pyproject.match(/^\[project\.scripts\]\s*\n([\s\S]*?)(?:^\[|$(?![\s\S]))/m)?.[1] ?? "";
  for (const m of scripts.matchAll(/^\s*([A-Za-z0-9_.-]{2,40})\s*=/gm)) commandNames.add(m[1]);
  for (const candidate of [unscoped(pkgName), tomlField(pyproject, "name"), tomlField(cargo, "name"), slug, name.toLowerCase().replace(/\s+/g, "-")]) {
    if (candidate) commandNames.add(candidate);
  }
  return { name, description, commandNames: [...commandNames].filter((n) => n.length >= 2 && !GENERIC_PACKAGE_NAMES.test(n)) };
}

function extractCommands(readme: string, packages: Package[], names: string[]): string[] {
  const fromBins = packages.filter(({ pkg }) => pkg.bin && str(pkg.name)).map(({ pkg }) => `npx ${str(pkg.name)}`);
  return [...new Set([...readmeCommands(readme, names), ...fromBins.slice(0, 3)])].slice(0, 15);
}

/** Brand colors, most used first: Tailwind config, CSS variables, theme files, Tailwind palette classes and the logo's fills. */
function extractColors(sources: Sources, logos: Text[]): RepoScan["colors"] {
  type Def = { name: string; value: string; source: string; order: number };
  const defs = new Map<string, Def>();
  let order = 0;
  const define = (rawName: string, value: string, source: string) => {
    const name = rawName.replace(/^--/, "").replace(/^color-/, "").replace(/(-(DEFAULT|value|main))+$/, "").replace(/^(DEFAULT|value)$/, "default");
    if (!name || name.startsWith("tw-") || name.length > 60 || defs.has(name)) return;
    defs.set(name, { name, value: value.trim(), source, order: order++ });
  };
  for (const { file, text } of [...sources.tailwind, ...sources.css]) {
    for (const m of text.matchAll(/(--[A-Za-z0-9_-]{1,80})\s{0,10}:\s{0,10}([^;{}]{1,200})/g)) define(m[1], m[2], file.rel);
  }
  const fromObject = (file: RepoFile) => (path: string[], value: string) => define(path.filter((p) => p !== "DEFAULT").join("-"), value, file.rel);
  for (const { file, text } of sources.tailwind) walkObjects(text, /\bcolors\s*:\s*\{/g, fromObject(file));
  for (const { file, text } of sources.themes) {
    walkObjects(text, /\b(?:colors|palette)["']?\s*:\s*\{/g, fromObject(file));
    for (const m of text.matchAll(/["']?([A-Za-z][\w-]{0,40})["']?\s{0,3}:\s{0,3}["'](#[0-9a-fA-F]{3,8})["']/g)) define(m[1], m[2], file.rel);
  }

  // how often each name is used: Tailwind utilities (bg-brand, text-primary/90) and var(--name)
  const usage = new Map<string, number>();
  const bump = (name: string) => usage.set(name, (usage.get(name) ?? 0) + 1);
  for (const { text } of [...sources.code, ...sources.css]) {
    for (const m of text.matchAll(COLOR_UTILITY)) bump(m[1]);
    for (const m of text.matchAll(/var\(\s*--([\w-]{1,80})/g)) bump(m[1].replace(/^color-/, ""));
  }
  const resolveHex = (def: Def): string | null => {
    let value = def.value;
    for (let hop = 0; hop < 5; hop++) {
      const alias = aliasOf(value);
      if (!alias) break;
      const target = defs.get(alias.replace(/^color-/, ""));
      if (!target || target === def) return null;
      value = target.value;
    }
    return parseColor(value);
  };

  type Color = RepoScan["colors"][number] & { score: number; order: number };
  const candidates: Color[] = [];
  for (const def of defs.values()) {
    const hex = resolveHex(def);
    if (hex) candidates.push({ name: def.name, hex, source: def.source, score: usage.get(def.name) ?? 0, order: def.order });
  }
  // Tailwind's own palette straight from class names: one shade per family (its most used), so
  // the status colors of a UI (rose-300, amber-200...) don't crowd out the brand's.
  const families = new Map<string, { shade: string; best: number; total: number }>();
  for (const [utility, count] of usage) {
    if (defs.has(utility) || !tailwindDefault(utility)) continue;
    const family = utility.split("-")[0];
    const entry = families.get(family) ?? { shade: utility, best: 0, total: 0 };
    entry.total += count;
    if (count > entry.best) Object.assign(entry, { shade: utility, best: count });
    families.set(family, entry);
  }
  for (const { shade, total } of families.values()) if (total >= 2) candidates.push({ name: shade, hex: tailwindDefault(shade)!, source: "Tailwind classes", score: total, order: order++ });
  // the logo's fills are the purest brand signal
  for (const { file, text } of logos) {
    let n = 0;
    for (const m of text.matchAll(/(?:fill|stop-color|stroke)\s*[=:]\s*["']?(#[0-9a-fA-F]{3,8})\b/g)) {
      const hex = parseColor(m[1]);
      if (!hex || hex === "#ffffff" || hex === "#000000") continue;
      candidates.push({ name: n++ === 0 ? "logo" : `logo-${n}`, hex, source: file.rel, score: 3, order: order++ });
    }
  }

  // one entry per hex: usage adds up, and the most brand-like name wins (primary over accent-foreground)
  const rank = (name: string) => (/^brand/.test(name) ? 0 : name === "primary" ? 1 : /^(primary|secondary|accent)\b/.test(name) ? 2 : 3);
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const byHex = new Map<string, Color>();
  for (const color of candidates) {
    const kept = byHex.get(color.hex);
    if (!kept) {
      byHex.set(color.hex, { ...color });
      continue;
    }
    kept.score += color.score;
    if (rank(color.name) < rank(kept.name)) Object.assign(kept, { name: color.name, source: color.source });
  }
  // plain white and black go last: every app has them, they say nothing about the brand
  const plain = (hex: string) => (hex === "#ffffff" || hex === "#000000" ? 1 : 0);
  return [...byHex.values()]
    .sort((a, b) => plain(a.hex) - plain(b.hex) || b.score - a.score || a.order - b.order)
    .slice(0, 12)
    .map(({ name, hex, source }) => ({ name, hex, source }));
}

/** Font families the app uses, most used first: CSS, Tailwind/theme config, next/font, Google Fonts links, @fontsource. */
function extractFonts(sources: Sources, packages: Package[]): string[] {
  const counts = new Map<string, { name: string; count: number; order: number }>();
  const add = (family: string | null, weight = 1) => {
    if (!family) return;
    const entry = counts.get(family.toLowerCase());
    if (entry) entry.count += weight;
    else counts.set(family.toLowerCase(), { name: family, count: weight, order: counts.size });
  };
  for (const { text } of sources.css) {
    for (const m of text.matchAll(/font-family\s{0,5}:\s{0,5}([^;{}]{1,300})/g)) add(firstFamily(m[1]));
    for (const m of text.matchAll(/--font-[\w-]{1,40}\s{0,5}:\s{0,5}([^;{}]{1,300})/g)) add(firstFamily(m[1]));
  }
  for (const { text } of [...sources.tailwind, ...sources.themes]) {
    walkObjects(text, /\bfontFamily\s*:\s*\{/g, (path, value) => {
      if (path.length === 1 || path.at(-1) === "0") add(firstFamily(value));
    });
  }
  for (const { text } of sources.code) {
    for (const m of text.matchAll(/import\s*\{([^}]{1,500})\}\s*from\s*["']next\/font\/google["']/g)) {
      for (const part of m[1].split(",")) {
        const font = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (font && /^[A-Z][A-Za-z0-9_]*$/.test(font)) add(font.replace(/_/g, " "), 2);
      }
    }
    for (const m of text.matchAll(/from\s*["']geist\/font\/(sans|mono)["']/g)) add(m[1] === "mono" ? "Geist Mono" : "Geist", 2);
    for (const m of text.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s)]{1,400})/g)) {
      for (const family of m[1].matchAll(/family=([^&:;]+)/g)) add(safeDecode(family[1].replace(/\+/g, " ")).trim(), 2);
    }
    for (const m of text.matchAll(/fontFamily\s{0,3}:\s{0,3}["'`]([^"'`\n]{2,120})["'`]/g)) add(firstFamily(m[1]));
    for (const m of text.matchAll(/["']@fontsource(?:-variable)?\/([a-z0-9-]{2,60})/g)) add(titleWords(m[1]), 2);
  }
  for (const { pkg } of packages) {
    for (const deps of [pkg.dependencies, pkg.devDependencies]) {
      if (!deps || typeof deps !== "object") continue;
      for (const dep of Object.keys(deps as object)) {
        const m = dep.match(/^@fontsource(?:-variable)?\/([a-z0-9-]{2,60})$/);
        if (m) add(titleWords(m[1]), 2);
        if (dep === "geist") add("Geist", 2);
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.order - b.order).map((f) => f.name).slice(0, 8);
}

/** The app's pages: file-based routes (Next.js, SvelteKit, Astro, Nuxt) and React/Vue Router configs. */
function extractScreens(sources: Sources): RepoScan["screens"] {
  const byName = new Map<string, Text>();
  for (const s of sources.ui) if (!byName.has(componentName(s.file.rel))) byName.set(componentName(s.file.rel), s);
  const summaryOf = (s: Text, route: string) => {
    let summary = summarize(s.text, "");
    if (!summary) {
      // a page that only renders <HomePage />: summarize the component it renders
      const child = [...s.text.matchAll(/<([A-Z][A-Za-z0-9]{1,60})\b/g)].map((m) => byName.get(m[1])).find((c) => c && c !== s);
      if (child) summary = summarize(child.text, "");
    }
    return summary || `${route === "/" ? "home" : titleWords(route.split("/").filter(Boolean).pop() ?? "page")} page`;
  };

  const screens: RepoScan["screens"] = [];
  const seen = new Set<string>();
  for (const s of sources.code) {
    const route = routeOf(s.file.rel);
    if (!route || seen.has(route)) continue;
    seen.add(route);
    screens.push({ route, summary: summaryOf(s, route), file: s.file.rel });
  }
  for (const s of sources.code) {
    if (!/react-router|createBrowserRouter|<Route\b|vue-router|@tanstack\/react-router/.test(s.text)) continue;
    const found: Array<[string, string | undefined]> = [];
    for (const m of s.text.matchAll(/<Route\b([^>]{0,600}?)\/?>/g)) {
      const path = m[1].match(/\bpath=\{?\s*["'`]([^"'`]{0,120})["'`]/)?.[1];
      const comp = m[1].match(/\b(?:element|component|Component)=\{\s*<?\s*([A-Z]\w{0,60})/)?.[1];
      if (path !== undefined) found.push([path, comp]);
    }
    for (const m of s.text.matchAll(/\bpath\s*:\s*["'`]([^"'`]{0,120})["'`][^{}]{0,200}?\b(?:element\s*:\s*<\s*([A-Z]\w{0,60})|[Cc]omponent\s*:\s*([A-Z]\w{0,60}))/g)) {
      found.push([m[1], m[2] ?? m[3]]);
    }
    for (const [rawPath, comp] of found) {
      if (rawPath.includes("*")) continue;
      const route = `/${rawPath.replace(/^\/+/, "")}`;
      if (seen.has(route)) continue;
      seen.add(route);
      const target = comp ? byName.get(comp) : undefined;
      screens.push({ route, summary: summaryOf(target ?? s, route), file: (target ?? s).file.rel });
    }
  }
  // home first, then shallow before deep, static before dynamic ([slug], :id)
  const rank = (route: string) => [route === "/" ? 0 : 1, route.split("/").length, /[[:]/.test(route) ? 1 : 0];
  return screens
    .sort((a, b) => {
      const [x, y] = [rank(a.route), rank(b.route)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.route.localeCompare(b.route);
    })
    .slice(0, 15);
}

/** The UI components most worth recreating: named like Hero or Dashboard, or used all over. */
function extractComponents(sources: Sources, screens: RepoScan["screens"]): RepoScan["components"] {
  const screenFiles = new Set(screens.map((s) => s.file));
  const used = new Map<string, number>();
  for (const s of sources.ui) for (const m of s.text.matchAll(/<([A-Z][A-Za-z0-9]{1,60})\b/g)) used.set(m[1], (used.get(m[1]) ?? 0) + 1);
  const scored = sources.ui
    .filter((s) => !screenFiles.has(s.file.rel) && !routeOf(s.file.rel) && s.file.ext !== "html" && s.file.ext !== "mdx" && !/(^|\/)(layout|template|loading|error|not-found)\.\w+$/.test(s.file.rel))
    .map((s) => {
      const name = componentName(s.file.rel);
      const weight = KEY_COMPONENTS.find(([re]) => re.test(name))?.[1] ?? 0;
      const uses = used.get(name) ?? 0;
      const markup = /className=|class=/.test(s.text) ? 1 : 0;
      const primitive = /(^|\/)ui\//.test(s.file.rel) ? 2 : 0;
      return { s, name, score: weight * 2 + Math.min(uses, 10) + markup - primitive, eligible: (weight > 0 || uses >= 3) && /^[A-Z]/.test(name) };
    })
    .filter((c) => c.eligible)
    .sort((a, b) => b.score - a.score || a.s.file.rel.localeCompare(b.s.file.rel));
  const components: RepoScan["components"] = [];
  for (const c of scored) {
    if (components.length >= 10) break;
    if (!components.some((existing) => existing.name === c.name)) components.push({ name: c.name, file: c.s.file.rel, excerpt: excerpt(c.s.text) });
  }
  return components;
}

/** Words people see in the product: headings, then buttons and links, other text, then placeholders and labels. Pages first. */
function extractUiStrings(sources: Sources, screens: RepoScan["screens"], components: RepoScan["components"]): string[] {
  const screenFiles = new Set(screens.map((s) => s.file));
  const componentFiles = new Set(components.map((c) => c.file));
  const ordered = [
    ...sources.ui.filter((s) => screenFiles.has(s.file.rel)),
    ...sources.ui.filter((s) => componentFiles.has(s.file.rel)),
    ...sources.ui.filter((s) => !screenFiles.has(s.file.rel) && !componentFiles.has(s.file.rel)),
  ].map((s) => jsxText(s.text));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const pick of [(t: JsxText) => t.headings, (t: JsxText) => t.buttons, (t: JsxText) => t.other, (t: JsxText) => t.attrs]) {
    for (const text of ordered) {
      for (const s of pick(text)) {
        if (out.length >= 80 || seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        out.push(s);
      }
    }
  }
  return out;
}

/** Repo files the README shows as images or videos (relative paths and links to the repo's raw files). */
function readmeImages(readme: string, readmeFile: RepoFile | undefined, byRel: Map<string, RepoFile>): Set<string> {
  const found = new Set<string>();
  if (!readmeFile) return found;
  const baseDir = posix.dirname(readmeFile.rel);
  const refs = [
    ...readme.matchAll(/!\[[^\]]{0,300}\]\(\s*<?([^)\s>]{1,500})>?(?:\s+["'][^"']*["'])?\s*\)/g),
    ...readme.matchAll(/<(?:img|source|video)\b[^>]{0,500}?\b(?:src|srcset)=["']([^"'\s]{1,500})/gi),
  ].map((m) => m[1]);
  for (const ref of refs) {
    const local = resolveRepoRef(ref, baseDir, byRel);
    if (local) found.add(local);
  }
  return found;
}

/** Text that is one long line (bundled or minified) carries no structure worth reading. */
function isMinified(text: string) {
  if (text.length < 20_000) return false;
  const lines = text.split("\n").length;
  return text.length / lines > 400;
}

/** A README image reference, as a file in the repo: relative paths and links to this repo's raw files. */
function resolveRepoRef(ref: string, baseDir: string, byRel: Map<string, RepoFile>): string | null {
  let target = ref.trim();
  if (/^https?:\/\//i.test(target)) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return null;
    }
    if (!/(^|\.)(github\.com|githubusercontent\.com|gitlab\.com)$/i.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);
    for (let i = 1; i < segments.length; i++) {
      const candidate = segments.slice(i).join("/");
      if (candidate.includes("/") && byRel.has(candidate)) return candidate;
    }
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  target = safeDecode(target.split(/[?#]/)[0]);
  const joined = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(baseDir === "." ? "" : baseDir, target));
  if (joined.startsWith("..") || joined.startsWith("/")) return null;
  return byRel.has(joined) ? joined : null;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Which repo files become kit assets, best first: logos, README images, app icons, screenshots, videos, fonts, other images. */
function pickAssets(files: RepoFile[], readmeRefs: Set<string>): AssetCandidate[] {
  const picked: AssetCandidate[] = [];
  for (const file of files) {
    const base = baseKind(file.ext);
    if (!base || base === "doc" || file.size < 100 || file.size > MAX_FILE_BYTES || BOILERPLATE.has(file.rel)) continue;
    const readmeRef = readmeRefs.has(file.rel);
    if (!readmeRef && isTestOrExample(file.rel)) continue;
    const parts = file.rel.split("/");
    const folders = parts.slice(0, -1);
    const stem = file.name.toLowerCase().replace(/\.[^.]+$/, "");
    const inAssetDir = folders.some((folder) => ASSET_DIRS.test(folder));
    const appMetadata = /(^|\/)app\/(icon|apple-icon|favicon|opengraph-image|twitter-image)\.\w+$/.test(file.rel);
    let priority = 0;
    if (base === "font") {
      if (ICON_FONT.test(file.name)) continue;
      priority = 50;
    } else if (base === "video") {
      if (!readmeRef && !inAssetDir) continue;
      priority = readmeRef ? 90 : 60;
    } else {
      const kind = classifyAsset(file.rel, null, { readmeRef });
      if (kind === "logo") priority = inAssetDir || folders.length <= 2 ? 100 : 75;
      else if (readmeRef) priority = 90;
      else if (kind === "icon" && (appMetadata || /favicon|apple|android-chrome|app-?icon|^icon/.test(stem))) priority = 80;
      else if (appMetadata) priority = 80;
      else if (kind === "screenshot" && (inAssetDir || folders.length === 0)) priority = 70;
      else if (inAssetDir) priority = kind === "icon" ? 10 : 30;
      else continue;
    }
    picked.push({ file, priority, readmeRef });
  }
  picked.sort((a, b) => b.priority - a.priority || b.file.size - a.file.size);
  // One file per font: Inter-Bold ships as .ttf, .woff and .woff2; keep the one renderers read best.
  const fontRank = ["ttf", "otf", "woff2", "woff"];
  const bestFont = new Map<string, AssetCandidate>();
  for (const candidate of picked.filter((c) => baseKind(c.file.ext) === "font")) {
    const stem = candidate.file.name.toLowerCase().replace(/\.[^.]+$/, "");
    const kept = bestFont.get(stem);
    if (!kept || fontRank.indexOf(candidate.file.ext) < fontRank.indexOf(kept.file.ext)) bestFont.set(stem, candidate);
  }
  const fonts = new Set(bestFont.values());
  // keep a few of each kind so forty favicon sizes can't crowd out the screenshots
  const caps: Record<string, number> = { icon: 4, font: 6, image: 20, video: 6 };
  const counts: Record<string, number> = {};
  return picked.filter((candidate) => {
    if (baseKind(candidate.file.ext) === "font" && !fonts.has(candidate)) return false;
    const kind = baseKind(candidate.file.ext) === "image" ? (classifyAsset(candidate.file.rel, null, { readmeRef: candidate.readmeRef }) ?? "image") : (baseKind(candidate.file.ext) ?? "image");
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts[kind] <= (caps[kind] ?? 40);
  });
}

/**
 * Reads a brand's code without running any of it, and merges what it finds into the kit: a
 * GitHub/GitLab https link is shallow-cloned to a temp folder (deleted afterwards); a local
 * folder is read in place. A new scan replaces the previous scan's assets; uploads stay.
 */
export async function scanRepo(brandId: string, source: string): Promise<BrandKit> {
  kitDir(brandId);
  const { scans } = shared();
  if (scans.has(brandId)) throw new BrandKitError(409, "A scan is already running for this brand; wait for it to finish.");
  scans.add(brandId);
  try {
    const resolved = await resolveRepoSource(source);
    const clone = resolved.kind === "remote" ? await cloneRepo(resolved) : null;
    const root = clone ? clone.root : (resolved as Extract<RepoSource, { kind: "local" }>).path;
    try {
      const walked = await walkRepo(root);
      if (walked.bytes > MAX_CHECKOUT_BYTES && clone) throw new BrandKitError(413, "That repository is too large to scan (over 1 GB checked out). Paste the path of a local copy instead.");
      if (!walked.files.length) throw new BrandKitError(422, "That folder has no files we can read.");
      const budget: Budget = { read: 0 };
      const { scan, assets } = await analyzeRepo(resolved, walked.files, budget);
      const kit = await withLock(brandId, async () => {
        const stored = readStored(brandId);
        // The previous scan's assets are replaced; ones whose bytes come back keep their id and caption.
        const previous = stored.assets.filter((a) => a.source.startsWith("repo:"));
        const previousByHash = new Map(previous.map((a) => [stored.index.hashes[a.id], a]));
        const previousVision = { ...stored.index.vision };
        stored.assets = stored.assets.filter((a) => !a.source.startsWith("repo:"));
        for (const a of previous) {
          delete stored.index.hashes[a.id];
          delete stored.index.vision[a.id];
        }
        const kept = new Set<string>();
        let added = 0;
        for (const candidate of assets) {
          if (added >= MAX_REPO_ASSETS || stored.assets.length >= MAX_ASSETS) break;
          const bytes = await readCapped(candidate.file.abs, MAX_FILE_BYTES + 1, budget);
          if (!bytes) continue;
          const hash = sha256(bytes);
          const old = previousByHash.get(hash);
          if (old && !kept.has(old.id) && !Object.values(stored.index.hashes).includes(hash)) {
            kept.add(old.id);
            stored.assets.push({ ...old, source: `repo:${candidate.file.rel}` });
            stored.index.hashes[old.id] = hash;
            if (previousVision[old.id]) stored.index.vision[old.id] = previousVision[old.id];
            added++;
            continue;
          }
          const result = await ingest(stored, { rel: candidate.file.rel, bytes, source: `repo:${candidate.file.rel}`, readmeRef: candidate.readmeRef, hash });
          if (!("reason" in result)) added++;
        }
        for (const a of previous) if (!kept.has(a.id)) await deleteAssetFile(brandId, a);
        stored.repo = scan;
        await writeStored(stored);
        return publicKit(stored);
      });
      const fromRepo = kit.assets.filter((a) => a.source.startsWith("repo:")).length;
      await logEvent({ brandId, message: `Brand kit: scanned ${scan.origin} (${fromRepo} assets, ${scan.colors.length} colors, ${scan.screens.length} screens${walked.truncated ? "; stopped at the file limit" : ""})` }).catch(() => undefined);
      return kit;
    } finally {
      await clone?.cleanup();
    }
  } finally {
    scans.delete(brandId);
  }
}

// ---------- captions (vision pass) ----------

type CaptionClient = Pick<NaiveClient, "message">;
export type CaptionResult = { captioned: number; failed: number; errors: string[] };

const DESCRIBE_TOOL = {
  name: "describe_assets",
  description: "Record a short caption, and the right kind, for every numbered image.",
  input_schema: {
    type: "object",
    required: ["assets"],
    properties: {
      assets: {
        type: "array",
        items: {
          type: "object",
          required: ["n", "caption", "kind"],
          properties: {
            n: { type: "integer", description: "The image's number." },
            caption: { type: "string", description: "4-14 words: what is visible, specific enough for a video editor to pick it." },
            kind: { type: "string", enum: ["logo", "icon", "screenshot", "image", "video"] },
          },
        },
      },
    },
  },
};

/** A ~512 px JPEG of an image (transparency on grey, so white and black logos both show) or a video's frame. */
async function thumbnail(bin: string, path: string, asset: BrandAsset, out: string): Promise<Buffer> {
  const run = (args: string[]) =>
    new Promise<void>((resolvePromise, reject) => execFile(bin, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error) => (error ? reject(error) : resolvePromise())));
  let { width, height } = asset;
  if (!width || !height) {
    const info = await probe(path).catch(() => null);
    width = info?.width;
    height = info?.height;
  }
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const scale = width && height ? Math.min(1, 512 / Math.max(width, height)) : 1;
  const filter =
    width && height
      ? `color=c=0x8a8a8a:s=${even(width * scale)}x${even(height * scale)}:d=1[bg];[0:v]scale=${even(width * scale)}:${even(height * scale)},format=rgba[fg];[bg][fg]overlay=shortest=1:format=auto,format=yuvj420p`
      : "[0:v]scale='min(512,iw)':-2,format=yuvj420p";
  const args = (seek: boolean) => ["-hide_banner", "-loglevel", "error", "-y", ...(seek ? ["-ss", "1"] : []), "-i", path, "-frames:v", "1", "-filter_complex", filter, "-q:v", "5", out];
  if (asset.kind === "video") await run(args(true)).catch(() => run(args(false)));
  else await run(args(false));
  return readFile(out);
}

/**
 * Writes a short caption for each image (and a frame of each video) the vision model hasn't seen,
 * and fixes the kind when it is obviously wrong. At most 12 images per request; only pixels and
 * the current kind go to the model, never paths or names. Failures are reported, not thrown.
 */
export async function captionAssets(naive: CaptionClient, brandId: string, options: { max?: number } = {}): Promise<CaptionResult> {
  const kit = readStored(brandId);
  const todo = kit.assets
    .filter((a) => !kit.index.vision[a.id] && (a.kind === "video" || ((a.kind === "logo" || a.kind === "icon" || a.kind === "screenshot" || a.kind === "image") && RASTER_EXT.has(extOf(a.path)))))
    .slice(0, options.max ?? CAPTION_PER_PASS);
  const result: CaptionResult = { captioned: 0, failed: 0, errors: [] };
  if (!todo.length) return result;
  const bin = await ffmpegPath();
  if (!bin) return { ...result, errors: ["ffmpeg is not available, so images can't be described"] };

  const described = new Map<string, { caption: string; kind: AssetKind | null }>();
  const failed = new Set<string>();
  const tmp = await mkdtemp(join(tmpdir(), "nomen-kit-"));
  try {
    const thumbs: Array<{ asset: BrandAsset; data: string }> = [];
    for (const asset of todo) {
      const path = assetPath(brandId, asset.id);
      const jpeg = path ? await thumbnail(bin, path, asset, join(tmp, `${asset.id}.jpg`)).catch(() => null) : null;
      if (jpeg?.length) thumbs.push({ asset, data: jpeg.toString("base64") });
      else failed.add(asset.id);
    }
    for (let i = 0; i < thumbs.length; i += CAPTION_BATCH) {
      const batch = thumbs.slice(i, i + CAPTION_BATCH);
      try {
        for (const [id, value] of await describeBatch(naive, batch)) described.set(id, value);
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }

  if (described.size || failed.size) {
    await withLock(brandId, async () => {
      const stored = readStored(brandId);
      for (const asset of stored.assets) {
        const d = described.get(asset.id);
        if (d) {
          asset.caption = d.caption;
          if (d.kind && asset.kind !== "video" && d.kind !== "video") asset.kind = d.kind;
          stored.index.vision[asset.id] = "done";
        } else if (failed.has(asset.id)) {
          stored.index.vision[asset.id] = "failed";
        }
      }
      await writeStored(stored);
    });
  }
  result.captioned = described.size;
  result.failed = failed.size;
  return result;
}

async function describeBatch(naive: CaptionClient, batch: Array<{ asset: BrandAsset; data: string }>) {
  const content: unknown[] = [];
  batch.forEach(({ asset }, i) => {
    const size = asset.width && asset.height ? `, ${asset.width}x${asset.height} px` : "";
    content.push({ type: "text", text: asset.kind === "video" ? `Image ${i + 1}: a frame from a product video${size}.` : `Image ${i + 1}: filed as "${asset.kind}"${size}.` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: batch[i].data } });
  });
  const instructions = [
    `${batch.length === 1 ? "This image is a file" : `These ${batch.length} images are files`} a brand gave us for its short video ads: logos, app icons, screenshots of its product, product photos and frames from product videos. Transparent areas show as grey.`,
    "For each image write a caption of 4-14 words saying what is visible, specific enough for a video editor to choose it: \"dark dashboard with a usage chart and a left sidebar\", \"purple wordmark 'Acme' on transparent background\", \"terminal running an install command\". Quote short visible headings or names exactly.",
    "Set kind: logo (a logo or wordmark on its own), icon (a small square app icon or favicon), screenshot (a screen of an app, website or terminal), image (a photo, illustration or anything else), video (only for video frames). Keep the filed kind unless it is clearly wrong.",
    "Call the describe_assets tool once with every image.",
  ].join("\n");
  content.push({ type: "text", text: instructions });
  const reply = await naive.message({ model: QC_MODEL, max_tokens: 1500, messages: [{ role: "user", content }], tools: [DESCRIBE_TOOL] });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === DESCRIBE_TOOL.name);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as { assets?: unknown } | null;
  const rows = raw && Array.isArray(raw.assets) ? raw.assets : [];
  const out = new Map<string, { caption: string; kind: AssetKind | null }>();
  for (const row of rows as Array<{ n?: unknown; caption?: unknown; kind?: unknown }>) {
    const item = batch[Number(row.n) - 1];
    const caption = typeof row.caption === "string" ? row.caption.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    if (!item || !caption) continue;
    const kind = typeof row.kind === "string" && ["logo", "icon", "screenshot", "image"].includes(row.kind) ? (row.kind as AssetKind) : null;
    out.set(item.asset.id, { caption, kind });
  }
  return out;
}

export const isCaptioning = (brandId: string) => shared().captions.has(brandId);

/**
 * Runs the caption pass in the background (the request that added the files doesn't wait for it).
 * A second call while one runs makes it go round once more for the files added meanwhile.
 */
export function startCaptioning(brandId: string, client: () => CaptionClient) {
  const { captions } = shared();
  const running = captions.get(brandId);
  if (running) {
    running.again = true;
    return;
  }
  const state = { again: false };
  captions.set(brandId, state);
  void (async () => {
    try {
      do {
        state.again = false;
        try {
          const result = await captionAssets(client(), brandId);
          if (result.errors.length) await logEvent({ brandId, level: "warn", message: `Brand kit: couldn't describe some images (${result.errors[0].slice(0, 200)})` }).catch(() => undefined);
        } catch (error) {
          await logEvent({ brandId, level: "warn", message: `Brand kit: couldn't describe images (${(error instanceof Error ? error.message : String(error)).slice(0, 200)})` }).catch(() => undefined);
        }
      } while (state.again);
    } finally {
      captions.delete(brandId);
    }
  })();
}
