import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "../http";
import { download, probe } from "../media";
import type { Computer, NaiveClient } from "../naive";
import type { ProductVisual } from "./types";

// Product screenshots for the edit: one throwaway Naive computer whose browser presents as a
// phone, a screenshot of the homepage and up to four pages that show what the product is
// (pricing, features, how it works, docs), saved locally as ProductVisuals.

/** The NaiveClient methods a capture uses (a NaiveClient satisfies it). */
export type CaptureClient = Pick<NaiveClient, "createComputer" | "getComputer" | "browserAction" | "fileUrl" | "closeBrowser" | "deleteComputer" | "pauseComputer">;

export type CaptureInput = {
  /** "monid.ai", "www.monid.ai" or "https://monid.ai/". */
  domain: string;
  /** Pages to capture after the homepage ("/pricing" or full URLs on the domain). Omitted, they are found from the homepage's links. */
  paths?: string[];
  /** Where the PNGs are saved. */
  dir: string;
  /** Pages besides the homepage, at most (default 4). */
  maxPages?: number;
  /** Default 430 x 932, a large phone. */
  viewport?: { width: number; height: number };
  /** Stop starting new pages after this long (default 110 s). */
  budgetMs?: number;
  /** Poll interval while the computer boots (default 1.5 s). */
  pollMs?: number;
  /** ProductVisual ids are this plus a number (default "s": s1, s2, ...). */
  idPrefix?: string;
};

export const PHONE_VIEWPORT = { width: 430, height: 932 };

/**
 * Screenshots of the brand's own site as a phone sees it. Individual pages may fail; the computer
 * is always closed and destroyed (or paused if that fails). Throws ApiError only when no browser
 * could be started at all.
 */
export async function captureSiteVisuals(naive: CaptureClient, input: CaptureInput): Promise<ProductVisual[]> {
  const started = Date.now();
  const left = () => (input.budgetMs ?? 110_000) - (Date.now() - started);
  const host = hostOf(input.domain);
  const bare = host.replace(/^www\./, "");
  const origin = `https://${host}`;
  const viewport = input.viewport ?? PHONE_VIEWPORT;
  const prefix = input.idPrefix ?? "s";
  await mkdir(input.dir, { recursive: true });

  const computer = await naive.createComputer(
    {
      name: `nomen-capture-${bare}`.slice(0, 200),
      vcpu: 1,
      memory_mb: 1024,
      browser: { allowed_domains: [bare, `*.${bare}`], timeout_minutes: 5, viewport, os: "mobile", block_ads: true, solve_captchas: false },
    },
    `nomen-capture-${bare}-${randomUUID()}`,
  );
  const visuals: ProductVisual[] = [];
  try {
    await waitUntilRunning(naive, computer, Math.min(45_000, Math.max(5_000, left())), input.pollMs ?? 1500);
    let step = 0;
    // Idempotency-Keys never expire and a reused one replays the old answer, so every goto gets its own.
    const key = () => `nomen-capture-${computer.id}-${++step}`;
    const seen = new Set<string>();

    const shoot = async (url: string) => {
      const landed = await naive.browserAction(computer.id, { action: "goto", url }, key());
      const final = pageKey(landed.url || url);
      if (seen.has(final)) return;
      seen.add(final);
      const title = await naive
        .browserAction(computer.id, { action: "extract", selector: "title" })
        .then((result) => (result.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120))
        .catch(() => "");
      const shot = await naive.browserAction(computer.id, { action: "screenshot" });
      if (!shot.file_id) throw new Error(`no screenshot of ${url}`);
      const path = pathOf(landed.url || url, bare);
      const local = join(input.dir, `site-${slug(path)}.png`);
      const { url: signed } = await naive.fileUrl(shot.file_id);
      await download(signed, local);
      const size = await imageSize(local);
      visuals.push({
        id: `${prefix}${visuals.length + 1}`,
        kind: "screenshot",
        url: local,
        caption: `${pageLabel(path)}, as a phone shows it${title ? `: "${title}"` : ""}`,
        source: `capture:mobile:${path}`,
        ...(size ? { width: size.width, height: size.height } : {}),
      });
    };

    let links: Array<{ href: string; text: string }> = [];
    try {
      await shoot(`${origin}/`);
      if (!input.paths) {
        const found = await naive.browserAction(computer.id, { action: "links", limit: 200 });
        links = found.links ?? [];
      }
    } catch {
      // the homepage would not load or capture: explicit paths may still work
    }

    const max = input.maxPages ?? 4;
    const pages = input.paths ? input.paths.map((path) => resolvePage(path, origin, bare)).filter((url): url is string => url !== null).slice(0, max) : pickPages(links, bare, max);
    for (const page of pages) {
      if (left() < 12_000) break;
      try {
        await shoot(page);
      } catch {
        // one page failing (a redirect off the domain, a slow load) never costs the others
      }
    }
    return visuals;
  } finally {
    await naive.closeBrowser(computer.id).catch(() => null);
    await naive.deleteComputer(computer.id).catch(() => naive.pauseComputer(computer.id).catch(() => null));
  }
}

async function waitUntilRunning(naive: CaptureClient, computer: Computer, timeoutMs: number, pollMs: number) {
  const deadline = Date.now() + timeoutMs;
  let current = computer;
  while (current.status !== "running") {
    if (current.status === "failed" || current.status === "destroyed" || current.status === "paused") {
      throw new ApiError("naive", 409, "computer_unavailable", `capture computer ${computer.id} is ${current.status}`);
    }
    if (Date.now() > deadline) throw new ApiError("naive", 504, "computer_timeout", `capture computer ${computer.id} did not start in time`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await naive.getComputer(computer.id);
  }
}

// ---------- choosing pages ----------

const PAGE_KINDS: Array<{ kind: string; score: number; test: RegExp }> = [
  { kind: "pricing", score: 10, test: /^(pricing|plans?|prices?)$/ },
  { kind: "product", score: 8, test: /^(features?|product|platform|how-it-works|how|solutions?|use-cases?|why-.+|overview|tour)$/ },
  { kind: "shop", score: 7, test: /^(products?|shop|store)$/ },
  { kind: "docs", score: 6, test: /^(docs?|documentation|getting-started|quickstart|quick-start|guides?|demo|integrations?|examples?|api)$/ },
  { kind: "collection", score: 5, test: /^(collections?|catalog|catalogue)$/ },
  { kind: "proof", score: 4, test: /^(customers?|case-studies|reviews?|testimonials)$/ },
  { kind: "about", score: 2, test: /^(about|about-us|our-story)$/ },
];
const SKIP = /(^|[/-])(log-?in|sign-?in|sign-?up|register|account|cart|checkout|privacy|terms|legal|cookies?|careers?|jobs|contact|press|status|support|help|affiliates?|unsubscribe|blog|news|changelog)([/-]|$)/;
const SKIP_HOSTS = /^(app|dashboard|console|auth|login|accounts?|status|help|support|blog)\./;
/** Path segments that only group pages ("/pages/how-it-works" is a top-level page on Shopify). */
const NEUTRAL_SEGMENTS = new Set(["pages", "en", "en-us", "us"]);

/**
 * The most useful pages to show, one per kind: pricing, features or how it works, a product page,
 * docs, then customers. Login, legal, careers and blog posts are skipped; shorter paths win ties.
 */
export function pickPages(links: Array<{ href: string; text: string }>, domain: string, max = 4): string[] {
  const bare = hostOf(domain).replace(/^www\./, "");
  const best = new Map<string, { url: string; score: number }>();
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href, `https://${bare}/`);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || !(host === bare || host.endsWith(`.${bare}`)) || SKIP_HOSTS.test(host)) continue;
    const path = url.pathname.toLowerCase().replace(/\/+$/, "");
    const docsHost = /^(docs|developers?)\./.test(host);
    if ((!path && !docsHost) || SKIP.test(path) || /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|xml|json)$/.test(path)) continue;
    const parts = path.split("/").filter((part) => part && !NEUTRAL_SEGMENTS.has(part));
    const match = docsHost ? PAGE_KINDS.find((kind) => kind.kind === "docs") : PAGE_KINDS.find((kind) => parts.some((part) => kind.test.test(part)));
    if (!match) continue;
    // A deep docs page is less useful than the section's front page; a shop's product page is two deep.
    const score = match.score - Math.max(0, parts.length - (match.kind === "shop" || match.kind === "collection" ? 2 : 1)) * 1.5;
    const clean = `${url.protocol}//${host}${url.pathname.replace(/\/+$/, "") || "/"}`;
    const current = best.get(match.kind);
    if (!current || score > current.score || (score === current.score && clean.length < current.url.length)) best.set(match.kind, { url: clean, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, max).map((page) => page.url);
}

function resolvePage(path: string, origin: string, bare: string): string | null {
  try {
    const url = new URL(path, `${origin}/`);
    const host = url.hostname.toLowerCase();
    return host === bare || host.endsWith(`.${bare}`) ? url.href : null;
  } catch {
    return null;
  }
}

// ---------- small helpers ----------

/** "https://www.Monid.ai/x" -> "www.monid.ai". */
function hostOf(domain: string) {
  const trimmed = domain.trim();
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  }
}

function pageKey(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** "/pricing" for the brand's own host; "docs.monid.ai/start" for a subdomain. */
function pathOf(url: string, bare: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const host = parsed.hostname.replace(/^www\./, "");
    return host === bare ? path : `${host}${path === "/" ? "" : path}`;
  } catch {
    return url;
  }
}

function pageLabel(path: string) {
  if (path === "/") return "homepage";
  const last = path.split("/").filter(Boolean).pop() ?? path;
  return `${last.replace(/[-_]+/g, " ")} page (${path})`;
}

function slug(path: string) {
  return path === "/" ? "home" : path.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || "page";
}

/** Width and height from a PNG's IHDR, else from ffmpeg. */
async function imageSize(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const file = await open(path, "r");
    try {
      const head = Buffer.alloc(24);
      await file.read(head, 0, 24, 0);
      if (head.readUInt32BE(0) === 0x89504e47 && head.toString("ascii", 12, 16) === "IHDR") return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    } finally {
      await file.close();
    }
    const info = await probe(path);
    return info.width && info.height ? { width: info.width, height: info.height } : null;
  } catch {
    return null;
  }
}
