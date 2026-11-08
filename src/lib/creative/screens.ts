// The screen builder: turns a beat's ScreenRequest into a short motion-graphic clip of the
// product's own UI (a terminal typing a command, step cards, result rows, a balance ticking down),
// in the brand's colours, fonts and wording, the way viral dev-tool videos show their product.
//
//   ScreenRequest + ProductBrief + BrandKit
//     └─ writeScreen ── a designer model writes one self-contained HTML page + keyframe times
//          └─ sanitizeHtml ── no remote or out-of-kit references survive
//               └─ renderScreen ── headless Chrome (DevTools pipe) screenshots the page at ?t=1.25 ...
//                    └─ ffmpeg ── 30 fps, a 2.5% push-in ─► 1080x1920 / 1080x960 H.264, no audio
//                                 (desktop: 1440x900 with no push-in; the filmed edit moves the camera)
//                         └─ checkScreen ── a vision pass: legible, nothing cut off, on brief, on brand
//
// buildScreens runs that for every request, with one rewrite when the check fails.
//
// Animation is deterministic: the page draws the state at time T from its URL (?t=), never from a
// clock. A tiny runtime injected before the page's own code sets T and freezes Date, random and
// animation timelines, so the same t always gives the same picture. That makes frames cheap to
// find: the renderer screenshots the keyframes, then bisects every stretch whose two ends differ
// until each changing frame is captured (smooth mode, ~85 ms a frame per Chrome), and holds the
// stretches whose ends match. Keyframes mode instead holds each keyframe until the next with 0.12 s
// crossfades, which is cheaper and looks like a slideshow.
//
// Generated HTML is untrusted. Besides sanitizing it, the page is served from a throwaway server on
// 127.0.0.1 that is also Chrome's proxy: every request Chrome makes (remote hosts, other local
// ports, Chrome's own background traffic) reaches that server, which answers only the page and
// files inside the allowed roots (the brand kit, assets/fonts) and returns 204 to everything else.
// An http page cannot load or open file:// URLs, so a script cannot put a local file on screen.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, createReadStream, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ApiError } from "../http";
import { ffmpegPath } from "../media";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import { editFfmpeg } from "./edit";
import type { BrandKit, ProductBrief, ScreenClip, ScreenRequest } from "./types";

const exec = promisify(execFile);

// ---------- sizes, timing, safe areas ----------

export const SCREEN_SIZES = {
  full: { width: 1080, height: 1920 },
  half: { width: 1080, height: 960 },
  /** A monitor's display that filmed_screen photographs with a phone (16:10). */
  desktop: { width: 1440, height: 900 },
} as const;

/**
 * The canvas a request renders at: its exact `box` (a remake's graphic at the reference's size),
 * else the full or half frame.
 */
export function screenSize(request: Pick<ScreenRequest, "size"> & { box?: ScreenRequest["box"] }): { width: number; height: number } {
  const box = request.box;
  if (box && box.width >= 64 && box.height >= 64) return { width: Math.min(1080, even(box.width)), height: Math.min(1920, even(box.height)) };
  return SCREEN_SIZES[request.size] ?? SCREEN_SIZES.full;
}

export const SCREEN_FPS = 30;
/** Crossfade between two keyframes that are far enough apart. */
const FADE_SECONDS = 0.12;
/** Keyframes closer than this (typing, a ticking counter) cut instead of fading. */
const HARD_CUT_GAP = 0.25;
/** Slow push-in over the whole clip, so a held state never looks frozen. */
const PUSH_IN = 0.025;
/** At most this many screenshots per clip, after expanding ranges. */
export const MAX_CAPTURES = 48;
/** Chrome processes running at once, across every render in this process. */
const CHROME_PARALLEL = 3;
const SHOT_TIMEOUT_MS = 30_000;

type Band = { from: number; to: number; why: string };
export type SafeAreas = { width: number; height: number; noText: Band[]; rightRail: { x: number; from: number; to: number } | null };

/**
 * Where text must not go, in the screen's own CSS pixels. Full screen: TikTok's top bar (9%), its
 * caption and buttons (bottom 18%), and the band where the edit burns spoken captions (59-70% of the
 * height, see captions.ts LOOK.caption). Half screen is the bottom half of a split frame, so the
 * same frame bands land at different panel heights. A desktop screen sits on a filmed monitor in
 * the middle of the frame, clear of TikTok's bands; its edges may disappear under the bezel, and
 * when the photo's monitor sits low, the captions cover the bottom of the screen.
 */
export function safeAreas(size: ScreenRequest["size"]): SafeAreas {
  if (size === "desktop") {
    return {
      ...SCREEN_SIZES.desktop,
      noText: [
        { from: 0, to: 48, why: "the monitor's top bezel and the camera's framing" },
        { from: 790, to: 900, why: "the bottom bezel, and the spoken captions may sit over the bottom of the screen" },
      ],
      rightRail: null,
    };
  }
  if (size === "half") {
    return {
      ...SCREEN_SIZES.half,
      noText: [
        { from: 0, to: 20, why: "the seam with the presenter above" },
        { from: 170, to: 385, why: "spoken captions are burned here (59-70% of the full frame)" },
        { from: 660, to: 960, why: "TikTok's caption, handle and music line (bottom ~16% of the frame)" },
      ],
      rightRail: { x: 960, from: 0, to: 600 },
    };
  }
  return {
    ...SCREEN_SIZES.full,
    noText: [
      { from: 0, to: 175, why: "TikTok's top bar (top 9%)" },
      { from: 1130, to: 1345, why: "spoken captions are burned here (59-70% of the height)" },
      { from: 1575, to: 1920, why: "TikTok's caption, handle and music line (bottom 18%)" },
    ],
    rightRail: { x: 960, from: 900, to: 1560 },
  };
}

export type ScreenState = { t: number; label: string };

export type ScreenContext = {
  product: ProductBrief;
  kit: BrandKit | null;
  /** Free-form look notes from the director or campaign: "dark, terminal-heavy, blue accents". */
  style?: string;
  /** The previous attempt and what was wrong with it, for a rewrite. */
  previous?: { html: string; issues: string[] };
};

type Messenger = Pick<NaiveClient, "message">;

// ---------- allowed local files ----------

/** The bundled fonts directory (Poppins ExtraBold), always allowed. */
export const FONTS_DIR = join(process.cwd(), "assets", "fonts");
const BRANDKITS_DIR = join(process.cwd(), "data", "brandkits");

/**
 * Files and directories a screen may reference: assets/fonts, the brand's kit directory and each
 * kit asset, and product visuals stored locally. Entries are absolute; a directory allows what is
 * inside it.
 */
export function allowedRoots(kit: BrandKit | null, product?: ProductBrief | null): string[] {
  const roots = [FONTS_DIR];
  if (kit) {
    roots.push(join(BRANDKITS_DIR, kit.brand_id));
    for (const asset of kit.assets) if (asset.path && isAbsolute(asset.path)) roots.push(resolve(asset.path));
  }
  for (const visual of product?.visuals ?? []) {
    const path = localPath(visual.url);
    if (path) roots.push(path);
  }
  return [...new Set(roots.map((r) => resolve(r)))];
}

function localPath(url: string): string | null {
  if (!url) return null;
  if (url.startsWith("file://")) {
    try {
      return fileURLToPath(url);
    } catch {
      return null;
    }
  }
  return isAbsolute(url) ? resolve(url) : null;
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** A file:// URL's absolute path if it points at an existing file inside the allowed roots, else null. */
function allowedFile(url: string, allow: string[]): string | null {
  if (!/^file:\/\/\//i.test(url)) return null; // file://host/... is never ours
  let path: string;
  try {
    path = resolve(fileURLToPath(url.replace(/[?#].*$/, "")));
  } catch {
    return null;
  }
  if (!allow.some((root) => inside(path, root))) return null;
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** The file:// URL to give the writer for a local file. */
export const fileUrl = (path: string) => pathToFileURL(resolve(path)).href;

// ---------- sanitizing ----------

const REMOTE = /^\s*(?:(?:https?|ftp|wss?|javascript|blob|filesystem|chrome|about):|\/\/|\\\\)/i;
const FILE_URL = /file:\/\/[^\s"'`()<>\\]*/gi;
/** Elements that embed another document, play media on their own clock or change the base URL. */
const DROPPED_ELEMENTS = ["iframe", "frame", "frameset", "object", "embed", "applet", "portal", "video", "audio", "source", "track", "base", "fencedframe"];
const URL_ATTRIBUTES = ["src", "href", "xlink:href", "srcset", "poster", "data", "action", "formaction", "background", "ping", "longdesc", "manifest"];

/**
 * Removes everything in model-written HTML that could load something from outside: scripts with a
 * src, iframes and other embeds, <link>s, @imports, remote url(...)s and attributes, refresh
 * redirects, and file:// URLs outside `allow` (or missing). Inline scripts and styles stay; the
 * renderer's server, proxy and CSP stop anything they try at runtime. Returns what was removed.
 */
export function sanitizeHtml(input: string, allow: string[]): { html: string; removed: string[] } {
  const roots = allow.map((r) => resolve(r));
  const removed: string[] = [];
  const note = (what: string) => removed.push(what.replace(/\s+/g, " ").slice(0, 160));
  let html = input.replace(/\u0000/g, "");

  // Scripts that load code from anywhere: the whole element. Self-closing ones first, so the paired
  // pattern cannot run from one of them to a later inline script's </script>.
  html = html.replace(/<script\b[^>]*\bsrc\s*=[^>]*\/>/gi, (m) => (note(m), ""));
  html = html.replace(/<script\b[^>]*\bsrc\s*=[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => (note(m.match(/<script\b[^>]*>/i)?.[0] ?? "script src"), ""));
  html = html.replace(/<script\b[^>]*\bsrc\s*=[^>]*>/gi, (m) => (note(m), ""));

  for (const tag of DROPPED_ELEMENTS) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), (m) => (note(m.match(/^<[^>]*>/)?.[0] ?? tag), ""));
    html = html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), (m) => (m.startsWith("</") ? "" : (note(m), "")));
  }

  // <link> only survives when it points at an allowed local file (a kit stylesheet or font preload).
  html = html.replace(/<link\b[^>]*>/gi, (m) => {
    const href = m.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = href ? (href[2] ?? href[3] ?? href[4] ?? "") : "";
    if (value && allowedFile(value, roots)) return m;
    note(m);
    return "";
  });

  // Redirects and anything else that navigates on its own.
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, (m) => (note(m), ""));

  // CSS: @import of anything, remote url(...).
  html = html.replace(/@import\s+(?:url\(\s*)?(["']?)[^;"'<]*\1\s*\)?[^;<]*;?/gi, (m) => (note(m), ""));
  html = html.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, _q: string, value: string) => {
    if (REMOTE.test(value)) {
      note(`url(${value})`);
      return 'url("")';
    }
    return m;
  });

  // <img>: dropped when its picture can't load (remote, outside the kit, missing).
  html = html.replace(/<img\b[^>]*>/gi, (m) => {
    const src = m.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = src ? (src[2] ?? src[3] ?? src[4] ?? "").trim() : "";
    if (!value) return m.includes("srcset") ? (note(m), "") : m;
    if (/^data:image\//i.test(value) || allowedFile(value, roots)) return m.replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    note(`img ${value}`);
    return "";
  });

  // Remote or out-of-kit URL attributes on any other element.
  const attr = new RegExp(`(\\s)(${URL_ATTRIBUTES.map((a) => a.replace(":", "\\:")).join("|")})\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi");
  html = html.replace(attr, (m, space: string, name: string, _raw: string, a?: string, b?: string, c?: string) => {
    const value = (a ?? b ?? c ?? "").trim();
    const bad = REMOTE.test(value) || (/^file:/i.test(value) && !allowedFile(value, roots)) || (name.toLowerCase() === "srcset" && /(?:https?:|\/\/)/i.test(value));
    if (!bad) return m;
    note(`${name}=${value}`);
    return space;
  });

  // Any file:// left (CSS, inline scripts) that is outside the allowed roots or missing.
  html = html.replace(FILE_URL, (m) => {
    if (allowedFile(m, roots)) return m;
    note(m);
    return "data:,";
  });

  return { html, removed };
}

// ---------- the page runtime ----------

/**
 * Injected first in <head>: fixes the stage size, turns off transitions, and defines T (seconds,
 * from ?t=) plus small helpers the writer is told about. Date, performance.now and Math.random are
 * frozen; requestAnimationFrame runs a callback at most a few times; CSS, Web Animations and SVG
 * animations are paused at T, so a page using @keyframes still renders the right moment.
 */
export function runtime(request: Pick<ScreenRequest, "seconds" | "size"> & { box?: ScreenRequest["box"] }): string {
  const { width, height } = screenSize(request);
  const seconds = Number.isFinite(request.seconds) ? request.seconds : 4;
  const css = `html,body{margin:0!important;padding:0!important;width:${width}px!important;height:${height}px!important;overflow:hidden!important}*,*::before,*::after{transition:none!important;caret-color:transparent!important}`;
  const js = [
    "(function(){",
    "var q=new URLSearchParams(location.search),t=parseFloat(q.get('t'));",
    `if(!isFinite(t))t=0;t=Math.max(0,t);var D=${seconds};`,
    `window.T=t;window.DURATION=D;window.W=${width};window.H=${height};`,
    "var clamp=function(x,a,b){a=a===undefined?0:a;b=b===undefined?1:b;return Math.min(b,Math.max(a,x));};",
    "window.clamp=clamp;",
    "window.lerp=function(a,b,p){return a+(b-a)*p;};",
    "window.prog=function(a,b){return clamp((t-a)/Math.max(1e-6,b-a));};",
    "window.ease=function(p){p=clamp(p);return 1-Math.pow(1-p,3);};",
    "window.easeInOut=function(p){p=clamp(p);return p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;};",
    "window.typed=function(s,start,cps){s=String(s);cps=cps||16;return s.slice(0,Math.max(0,Math.floor((t-start)*cps+1e-6)));};",
    "var seed=20261107;Math.random=function(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};",
    "var now=1767225600000+t*1000;Date.now=function(){return now;};",
    "try{performance.now=function(){return t*1000;};}catch(e){}",
    "var frames=0;window.requestAnimationFrame=function(cb){if(frames++>3)return 0;return setTimeout(function(){cb(t*1000);},0);};",
    "function sync(){",
    "try{document.getAnimations().forEach(function(a){try{a.pause();a.currentTime=t*1000;}catch(e){}});}catch(e){}",
    "try{document.querySelectorAll('svg').forEach(function(s){if(s.pauseAnimations){s.pauseAnimations();s.setCurrentTime(t);}});}catch(e){}",
    "}",
    "document.addEventListener('DOMContentLoaded',sync);window.addEventListener('load',sync);",
    "})();",
  ].join("");
  return `<meta charset="utf-8"><style data-nomen-runtime>${css}</style><script data-nomen-runtime>${js}</script>`;
}

/** The page as rendered: doctype, the runtime first in <head>, and a whole document even from a fragment. */
export function prepareHtml(html: string, request: Pick<ScreenRequest, "seconds" | "size"> & { box?: ScreenRequest["box"] }): string {
  const body = html.replace(/<style data-nomen-runtime>[\s\S]*?<\/style>|<script data-nomen-runtime>[\s\S]*?<\/script>/g, "").replace(/^﻿/, "").trim();
  const head = runtime(request);
  let doc: string;
  if (/<head\b[^>]*>/i.test(body)) doc = body.replace(/<head\b[^>]*>/i, (m) => `${m}${head}`);
  else if (/<html\b[^>]*>/i.test(body)) doc = body.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  else doc = `<html><head>${head}</head><body>${body}</body></html>`;
  return /^\s*<!doctype/i.test(doc) ? doc : `<!doctype html>\n${doc}`;
}

// ---------- writing ----------

function bandsText(size: ScreenRequest["size"]): string {
  const areas = safeAreas(size);
  const bands = areas.noText.map((b) => `y ${b.from}-${b.to} (${b.why})`).join("; ");
  const rail = areas.rightRail ? `; and x > ${areas.rightRail.x} between y ${areas.rightRail.from} and ${areas.rightRail.to} (TikTok's like/comment/share buttons)` : "";
  return `No text or key UI in: ${bands}${rail}. Backgrounds, glows and the edges of cards may run under these bands.`;
}

function zonesText(size: ScreenRequest["size"]): string {
  if (size === "desktop") {
    return "This is the whole display of a desktop monitor that a phone films from about 60 cm away. In the video the monitor fills about 85% of the phone's width, so this 1440 px screen shows up about 900 px wide in a 1080x1920 frame (0.6x). Put the hero (the command, the panel that matters, the result) in x 140-1300, y 80-760.";
  }
  return size === "half"
    ? "This panel is the bottom half of a split screen (the presenter is above it). Put a short label or step title in y 30-165 and the hero element (card, terminal, rows, number) in y 390-650."
    : "Put the hero element (card, terminal, app window, big number) in y 200-1110, centred or slightly above centre; a short supporting row may sit in y 1360-1560.";
}

const CANVAS_NAME = { full: "a full vertical phone screen", half: "the bottom half of a split screen", desktop: "a desktop monitor's display, filmed by a phone" } as const;

/**
 * The designer's brief per canvas: vertical graphics are motion design; a desktop screen is a real
 * app on a filmed monitor; a remake's element (`box`) is one post, chart or card at the reference's size.
 */
function lookText(size: ScreenRequest["size"], element = false): string[] {
  if (size === "desktop" && !element) {
    return [
      "TYPE (it is read through a phone camera pointed at a monitor)",
      "- Nothing under 36 px. Body, rows and code 44-56 px; commands and labels 52-72 px; headlines and key numbers 88-160 px. Set the app as if zoomed to 250-300%: few lines, big text. At most ~25 words of small text on screen.",
      "- High contrast (light text on dark or dark on light, never mid-grey on grey). Monospace for code and terminals. One accent colour for emphasis.",
      "",
      "LOOK",
      "- It must look like a real screen on a real computer, not a poster, slide or motion-graphic card: a terminal window, a code editor, a browser showing the product's site or dashboard, or the product's own app, with plausible window chrome (a title bar with three small dots, tabs or a sidebar). Use the brand's real colours, fonts, logo and wording from the brand kit (file:// URLs below, exactly as given). If the kit has no font files, use the given system stacks.",
      "- Copy what the reference showed on its monitor from reference_visual (which app, light or dark, what was on screen), adapted to this product.",
      "- Fill the display edge to edge: the app's own background, or a desktop background behind one big window covering at least 85% of the screen. One idea per screen: the command being typed, the panel that matters, the result.",
      "- No captions and no big headline banners floating over the app (the edit adds captions), no lorem ipsum or \"Your text here\".",
      "- Draw icons as inline SVG or simple shapes; use the kit's logo and icons by their file:// URLs. No emoji (they may not render).",
    ];
  }
  return [
    "TYPE (it is watched on a phone)",
    element ? "- Copy the reference element's type hierarchy at this size; nothing under 18 px." : "- Nothing under 34 px. Body and rows 40-56 px; labels and commands 44-64 px; headlines and key numbers 72-150 px, weight 700-900, letter-spacing -0.02em. At most ~14 words of small text on screen.",
    "- High contrast (light text on dark or dark on light, never mid-grey on grey). Monospace for code and terminals. One accent colour for emphasis; a highlighted word gets an accent pill or a thick underline.",
    "",
    "LOOK",
    "- Use the brand's real colours, fonts and logo from the brand kit (file:// URLs below, exactly as given). If the kit has no font files, use the given system stacks. Copy the reference's visual style from reference_visual (background, card style, layout, how text is emphasised), adapted to the brand.",
    ...(element
      ? ["- It must look like the reference's element, made for this product: a social post looks like a real post card, a chart like a clean chart card, a photo card like a framed photo. No nav bars, scrollbars, lorem ipsum, \"Your text here\" or fake browser chrome."]
      : [
          "- It must look like a designed motion graphic, not a screenshot of a web page: no nav bars, footers, cookie banners, scrollbars, breadcrumbs, lorem ipsum, \"Your text here\", fake browser chrome around everything. Depth comes from soft shadows, 28-48 px rounded corners, a subtle glow or grid behind the hero, and big confident type.",
          "- Use the whole stage: the background runs edge to edge (gradient, glow, grid), the hero fills most of its zone, and on a full screen the lower zone holds a supporting element (a pill, badge or the mascot) so the frame is not top-heavy.",
        ]),
    "- Draw icons as inline SVG or simple shapes; use the kit's logo and icons by their file:// URLs. No emoji (they may not render).",
  ];
}

export function writerSystem(request: Pick<ScreenRequest, "size" | "seconds"> & { box?: ScreenRequest["box"] }): string {
  const { width, height } = screenSize(request);
  // A remake's graphic is one element (a post, a chart) that the edit places inside the video at
  // exactly this size: it fills its canvas, and the frame's safe areas are the edit's concern.
  const element = Boolean(request.box);
  const desktop = request.size === "desktop" && !element;
  const canvas = element
    ? [
        `- Exactly ${width}x${height} CSS pixels: one element (a post card, chart, photo card or text card) that the edit places inside a video frame at exactly this size, screenshotted at device scale 1. The element fills the canvas edge to edge: its own background reaches every edge, with no margin, outer shadow, backdrop or rounded outer corners. Position everything in px; never use vh, vw, window.innerHeight or media queries.`,
        "- Keep 4% inner padding for text. Nothing may be cut off by the edges or overflow its box: size boxes for the longest text they will hold.",
      ]
    : [
        `- Exactly ${width}x${height} CSS pixels (${CANVAS_NAME[request.size] ?? CANVAS_NAME.full}), screenshotted at device scale 1. html and body are fixed at that size with overflow hidden; build one stage and position everything in px inside it. Never size anything with vh, vw, window.innerHeight or media queries.`,
        `- ${bandsText(request.size)}`,
        `- ${zonesText(request.size)}`,
        "- Keep 64 px side margins for text. Nothing may be cut off by the edges or overflow its card: size boxes for the longest text they will hold (the fully typed command, the final number).",
      ];
  return [
    desktop
      ? "You are a senior UI designer. You rebuild real software screens for viral developer-tool and SaaS videos on TikTok and Reels in which a phone films a computer monitor while a voice walks through a setup: the product's own app, a terminal where a command types itself, a code editor, a browser on the product's dashboard. You build what the monitor shows as one self-contained HTML document; a headless browser screenshots it at several moments, the frames are cut into a clip, and the edit puts that clip on a photographed monitor."
      : "You are a senior motion designer and UI designer. You make the on-screen graphics for viral developer-tool and SaaS videos on TikTok and Reels: full-bleed dark or brand-colour backgrounds, one idea per screen, chunky UI cards, a terminal where a command types itself, app windows, step cards (\"01 · Paste into your agent's chat\"), result rows that land one by one, a balance or counter ticking, a progress ring, and bold labels with one highlighted word. You build each graphic as one self-contained HTML document; a headless browser screenshots it at several moments and the frames are cut into a vertical video.",
    "",
    "THE CANVAS",
    ...canvas,
    "",
    ...lookText(request.size, element),
    "",
    "TRUTH",
    "- Every word comes from the product facts, the brand's real UI strings and commands, or the spoken line. Quote commands, URLs and product names exactly. Never invent numbers, prices, customer names, testimonials, features, integrations or UI the facts don't contain; if a number is not in the facts, show none. Sample data (task names, tool names in a list) must be plausible and generic, never claims.",
    "",
    "ANIMATION (deterministic; the page is screenshotted, not played)",
    "- Before your code runs, the page defines: T (the time to draw, in seconds, from ?t=), DURATION, W, H, and helpers clamp(x,a=0,b=1), lerp(a,b,p), prog(a,b) (0 to 1 as T goes from a to b), ease(p) (ease-out cubic), easeInOut(p), typed(text, start, charsPerSecond=16) (the part of text typed by T).",
    desktop
      ? "- Write one render() that sets every element from T and call it at the end of <body>. Motion is what really happens on a screen: a command types itself (typed(cmd, start, 14-18) with a solid block cursor after it), output lines print one by one, a panel or menu opens, a button highlights as a cursor clicks it, a list fills in, a number ticks (lerp with ease). Things appear the way software shows them, at once or with a 0.1-0.2 s fade; nothing flies in or bounces, and the window itself stays put."
      : "- Write one render() that sets every element from T and call it at the end of <body>. Arrivals: opacity and a 30-60 px slide or a 0.92-1 scale over 0.25-0.4 s using ease(prog(a, a+0.35)). Typing: typed(cmd, start, 14-18) with a solid block cursor after it. Counters: lerp with ease, formatted the way the product formats money or numbers. Rings: SVG stroke-dashoffset.",
    "- Do not use timers, requestAnimationFrame loops, Date, Math.random, fetch, transitions, or text measurement; CSS @keyframes are allowed (they are frozen at T) but computing from T is preferred.",
    `- Time it to the spoken line (about 2.6 words per second over ${request.seconds} s): the key reveal lands when its words are spoken. Something should change at least every ~1 s while the line runs; the final state is complete by about 80% of DURATION and holds.`,
    "",
    "KEYFRAMES",
    "- List 3-10 moments worth capturing: {\"t\": seconds, \"label\": \"what is on screen\"}, sorted, the first at 0, one right after each arrival or change finishes, the last when everything has landed. The renderer captures every frame between two keyframes whose pictures differ, so motion plays at 30 fps; between two keyframes that look identical it assumes nothing moves, so never bracket a motion with two identical-looking keyframes. The keyframes are also what the quality check looks at. Typing or a ticking counter may be one range entry: {\"t\": 0.6, \"to\": 2.2, \"step\": 0.08, \"label\": \"typing the command\"}.",
    "",
    "NO NETWORK",
    "- No http(s) URLs for fonts, images, scripts or styles, no <script src>, <link>, <iframe>, <video>, <audio>, Google Fonts, CDNs: they are stripped and blocked. Only inline CSS/JS/SVG, data: URIs, the file:// URLs listed below, and system fonts. Never navigate, fetch or open windows.",
    "",
    "ANSWER",
    "- First the complete HTML document in one ```html block (aim for under 14 KB; no comments needed), then the keyframes in one ```json block: {\"states\": [...]}. Nothing else.",
  ].join("\n");
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The writer's user message: the screen, the product facts, the brand kit and its file URLs. */
export function screenPrompt(request: ScreenRequest, ctx: ScreenContext): string {
  const { product, kit } = ctx;
  const repo = kit?.repo ?? null;
  const assets = kit?.assets ?? [];
  const pick = (kinds: string[]) => assets.filter((a) => kinds.includes(a.kind) && a.path && existsSync(a.path));
  const describe = (a: (typeof assets)[number]) => ({ url: fileUrl(a.path), kind: a.kind, caption: a.caption, ...(a.width && a.height ? { size: `${a.width}x${a.height}` } : {}) });
  const localVisuals = product.visuals
    .map((v) => ({ v, path: localPath(v.url) }))
    .filter((x): x is { v: (typeof product.visuals)[number]; path: string } => Boolean(x.path && existsSync(x.path)))
    .slice(0, 4)
    .map(({ v, path }) => ({ url: fileUrl(path), kind: v.kind, caption: v.caption, ...(v.width && v.height ? { size: `${v.width}x${v.height}` } : {}) }));

  const facts = {
    name: product.name,
    one_liner: product.one_liner,
    kind: product.kind,
    audience: product.audience,
    aha: product.aha,
    features: product.features.slice(0, 8).map((f) => ({ name: f.name, what_it_does: f.what_it_does, how_to_show_it: f.how_to_show_it })),
    claims: product.claims.slice(0, 14),
    proof: product.proof.slice(0, 8),
    offer: product.offer,
    voice: product.voice,
    look: product.look,
  };
  const brand = {
    colors: (repo?.colors ?? []).slice(0, 14).map((c) => `${c.name} ${c.hex}`),
    font_families: (repo?.fonts ?? []).slice(0, 6),
    font_files: pick(["font"]).slice(0, 6).map(describe),
    logos_and_icons: pick(["logo", "icon"]).slice(0, 8).map(describe),
    images: [...pick(["screenshot", "image"]).slice(0, 4).map(describe), ...localVisuals].slice(0, 6),
    commands: (repo?.commands ?? []).slice(0, 20).map((c) => cap(c, 200)),
    ui_strings: (repo?.ui_strings ?? []).slice(0, 80).map((s) => cap(s, 140)),
    screens: (repo?.screens ?? []).slice(0, 12).map((s) => `${s.route}: ${cap(s.summary, 140)}`),
    components: (repo?.components ?? []).slice(0, 8).map((c) => ({ name: c.name, file: c.file, excerpt: cap(c.excerpt, 1400) })),
    repo: repo ? { name: repo.name, description: cap(repo.description, 300), readme_excerpt: cap(repo.readme, 1500) } : null,
  };
  const always = {
    display_font: `@font-face { font-family: "Poppins"; font-weight: 800; src: url("${fileUrl(join(FONTS_DIR, "Poppins-ExtraBold.ttf"))}"); }  (bold display face for big labels when the brand has no font file)`,
    sans_stack: '-apple-system, "SF Pro Display", "Helvetica Neue", Inter, Arial, sans-serif',
    mono_stack: '"SF Mono", "JetBrains Mono", Menlo, Monaco, "DejaVu Sans Mono", "Liberation Mono", monospace',
  };

  const parts = [
    `<screen>\n${JSON.stringify({ id: request.id, size: request.size, canvas: screenSize(request), seconds: request.seconds, brief: request.brief, spoken_line: request.line, reference_visual: request.reference_visual }, null, 1)}\n</screen>`,
    `<product_facts>\n${JSON.stringify(facts)}\n</product_facts>`,
    kit ? `<brand_kit>\n${JSON.stringify(brand)}\n</brand_kit>` : "<brand_kit>none: use the product's look and a clean dark developer style with one accent colour</brand_kit>",
    `<always_available>\n${JSON.stringify(always)}\n</always_available>`,
  ];
  if (ctx.style?.trim()) parts.push(`<style_notes>\n${ctx.style.trim()}\n</style_notes>`);
  if (ctx.previous) {
    parts.push(
      `<previous_attempt>\n${ctx.previous.html ? `${cap(ctx.previous.html, 18000)}\n` : ""}</previous_attempt>`,
      `<problems>\n${ctx.previous.issues.map((i) => `- ${i}`).join("\n") || "- (none listed)"}\n</problems>`,
      "Write the screen again, fixing every problem above. Keep what worked.",
    );
  } else {
    parts.push(`Design and write the screen "${request.id}".`);
  }
  return parts.join("\n\n");
}

/** Pulls the HTML document and the raw keyframe list out of the writer's answer. */
export function parseScreenReply(text: string): { html: string | null; states: unknown } {
  const fences = [...text.matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2], whole: m[0] }));
  const looksHtml = (s: string) => /<(?:!doctype|html|body|div|svg|style)\b/i.test(s);
  let htmlBlock: (typeof fences)[number] | undefined = fences.find((f) => f.lang === "html" && looksHtml(f.body)) ?? fences.filter((f) => f.lang !== "json" && looksHtml(f.body)).sort((a, b) => b.body.length - a.body.length)[0];
  let html: string | null = htmlBlock?.body ?? null;
  if (!html) {
    const start = text.search(/<!doctype html|<html\b/i);
    if (start >= 0) {
      const end = text.toLowerCase().lastIndexOf("</html>");
      html = end > start ? text.slice(start, end + 7) : text.slice(start);
      htmlBlock = undefined;
    }
  }
  if (html) {
    html = html.trim();
    // A cut-off answer: no closing tag for the document or its body.
    if (!/<\/html\s*>|<\/body\s*>/i.test(html) && /<html\b|<body\b/i.test(html)) html = null;
    else if (html.length < 80) html = null;
  }

  let rest = text;
  if (htmlBlock) rest = rest.replace(htmlBlock.whole, "");
  else if (html) rest = rest.replace(html, "");
  let states: unknown = null;
  const jsonBlock = fences.find((f) => f.lang === "json") ?? null;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  if (jsonBlock) states = tryParse(jsonBlock.body.trim());
  if (states === null) {
    // A bare array first: extractJson would pick out the first {...} inside it.
    const array = rest.match(/\[[\s\S]*\]/);
    const parsed = array ? tryParse(array[0]) : null;
    states = Array.isArray(parsed) ? parsed : extractJson(rest);
  }
  if (states && typeof states === "object" && !Array.isArray(states)) {
    const obj = states as Record<string, unknown>;
    states = obj.states ?? obj.keyframes ?? obj.frames ?? null;
  }
  return { html, states };
}

const snapT = (t: number) => Math.round(t * SCREEN_FPS) / SCREEN_FPS;
const round3 = (t: number) => Math.round(t * 1000) / 1000;

/**
 * Normalizes keyframes: numbers or {t, label} (also time/at), ranges {t, to, step} expanded,
 * clamped to [0, seconds], snapped to the 30 fps grid, de-duplicated, sorted, starting at 0, and
 * thinned evenly to at most MAX_CAPTURES. Unusable input gives five evenly spaced keyframes.
 */
export function parseStates(raw: unknown, seconds: number): ScreenState[] {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 4;
  const out: ScreenState[] = [];
  const list = Array.isArray(raw) ? raw : [];
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  for (const item of list) {
    if (typeof item === "number" || typeof item === "string") {
      const t = num(item);
      if (Number.isFinite(t)) out.push({ t, label: "" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const t = num(o.t ?? o.time ?? o.at ?? o.start);
    if (!Number.isFinite(t)) continue;
    const label = typeof o.label === "string" ? o.label.trim() : typeof o.description === "string" ? o.description.trim() : "";
    const to = num(o.to ?? o.until ?? o.end);
    const step = num(o.step ?? o.every);
    if (Number.isFinite(to) && to > t && Number.isFinite(step) && step > 0) {
      // A range too dense for the budget is stretched evenly rather than cut short.
      const s = Math.max(Math.min(2, Math.max(1 / SCREEN_FPS, step)), (to - t) / MAX_CAPTURES);
      const n = Math.floor((to - t) / s + 1e-9);
      for (let i = 0; i <= n; i++) out.push({ t: t + i * s, label: label ? `${label} (${i + 1})` : "" });
      if (t + n * s < to - 1e-6) out.push({ t: to, label: label ? `${label} (end)` : "" });
    } else {
      out.push({ t, label });
    }
  }

  const byT = new Map<number, ScreenState>();
  for (const s of out) {
    const t = round3(Math.min(total, Math.max(0, snapT(Math.min(total, Math.max(0, s.t))))));
    if (!byT.has(t)) byT.set(t, { t, label: s.label || `t=${t}` });
  }
  let states = [...byT.values()].sort((a, b) => a.t - b.t);
  if (!states.length) {
    states = [0, 0.25, 0.5, 0.75, 1].map((p) => ({ t: round3(snapT(total * p)), label: `${Math.round(p * 100)}%` }));
  }
  if (states[0].t > 0) states.unshift({ t: 0, label: "start" });
  if (states.length > MAX_CAPTURES) {
    const keep: ScreenState[] = [];
    for (let i = 0; i < MAX_CAPTURES; i++) keep.push(states[Math.round((i * (states.length - 1)) / (MAX_CAPTURES - 1))]);
    states = [...new Map(keep.map((s) => [s.t, s])).values()];
  }
  return states;
}

/** Up to two kit screenshots (or local product screenshots) as small JPEGs, so the writer sees the real UI. */
async function referenceImages(ctx: ScreenContext): Promise<Array<{ type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }>> {
  const paths: string[] = [];
  for (const a of ctx.kit?.assets ?? []) if ((a.kind === "screenshot" || a.kind === "logo") && a.path && existsSync(a.path) && /\.(png|jpe?g|webp|gif)$/i.test(a.path)) paths.push(a.path);
  for (const v of ctx.product.visuals) {
    const p = localPath(v.url);
    if (p && v.kind === "screenshot" && existsSync(p)) paths.push(p);
  }
  const bin = await ffmpegBin();
  if (!bin || !paths.length) return [];
  const images = [];
  for (const path of [...new Set(paths)].slice(0, 2)) {
    try {
      const { stdout } = await exec(
        bin,
        ["-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2,crop=iw:'min(ih,1400)':0:0", "-q:v", "4", "-f", "mjpeg", "pipe:1"],
        { encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
      );
      const data = (stdout as unknown as Buffer).toString("base64");
      if (data) images.push({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data } });
    } catch {
      // unreadable image: the writer still has its caption
    }
  }
  return images;
}

/**
 * One designer call: a self-contained HTML document for the screen (sanitized against the brand
 * kit's files and assets/fonts) and the keyframes worth capturing. Throws when the answer has no
 * usable document.
 */
export async function writeScreen(naive: Messenger, request: ScreenRequest, ctx: ScreenContext): Promise<{ html: string; states: ScreenState[] }> {
  const images = await referenceImages(ctx);
  const text = screenPrompt(request, ctx);
  const content = images.length ? [...images, { type: "text", text: `The images above are the brand's real UI, for its look.\n\n${text}` }] : text;
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 14000,
    system: writerSystem(request),
    messages: [{ role: "user", content }],
  });
  const answer = reply.content.map((block) => block.text ?? "").join("\n");
  const parsed = parseScreenReply(answer);
  if (!parsed.html) {
    const why = reply.stop_reason === "max_tokens" ? "the answer was cut off before the HTML ended" : "the answer had no HTML document";
    throw new ApiError("naive", 502, "screen_unreadable", `screen ${request.id}: ${why}`);
  }
  const { html } = sanitizeHtml(parsed.html, allowedRoots(ctx.kit, ctx.product));
  return { html, states: parseStates(parsed.states, request.seconds) };
}

// ---------- Chrome ----------

const MAC_CHROMES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];
const PATH_CHROMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

const isExecutable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Chrome or Chromium binary to render with: CHROME_PATH, then the usual macOS app bundles,
 * then google-chrome, chromium and chromium-browser on PATH. Null when none is executable.
 */
export function findChrome(options: { env?: Record<string, string | undefined>; appPaths?: string[] } = {}): string | null {
  const env = options.env ?? process.env;
  if (env.CHROME_PATH && isExecutable(env.CHROME_PATH)) return env.CHROME_PATH;
  for (const app of options.appPaths ?? MAC_CHROMES) if (isExecutable(app)) return app;
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of PATH_CHROMES) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function chromeMissing(): Error {
  const error = new Error(
    `No Chrome or Chromium found to render screens: install Google Chrome, or set CHROME_PATH to a Chrome/Chromium binary${process.env.CHROME_PATH ? ` (CHROME_PATH=${process.env.CHROME_PATH} is not an executable file)` : ""}.`,
  );
  (error as Error & { code: string }).code = "chrome_missing";
  return error;
}

/**
 * Flags for one headless Chrome driven over the DevTools pipe (fds 3 and 4). Every request it makes
 * goes to the screen server, which is also its proxy and serves only the page and allowed files.
 */
export function chromeArgs(input: { width: number; height: number; scale: number; port: number; profile: string }): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--no-pings",
    "--use-mock-keychain",
    "--password-store=basic",
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    "--font-render-hinting=none",
    `--proxy-server=http://127.0.0.1:${input.port}`,
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--user-data-dir=${input.profile}`,
    `--window-size=${input.width},${input.height}`,
    `--force-device-scale-factor=${input.scale}`,
    "--remote-debugging-pipe",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

// Chrome processes are capped across every render in this process.
let slotsInUse = 0;
const slotWaiters: Array<() => void> = [];
const tryAcquireSlot = () => (slotsInUse < CHROME_PARALLEL ? (slotsInUse++, true) : false);
const acquireSlot = () => (tryAcquireSlot() ? Promise.resolve() : new Promise<void>((done) => slotWaiters.push(done)));
const releaseSlot = () => {
  const next = slotWaiters.shift();
  if (next) next(); // the slot passes straight to the next waiter
  else slotsInUse--;
};

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type EventWaiter = { method: string; resolve: (params: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** One headless Chrome with one page, driven over the DevTools protocol on a pipe (no port is opened). */
class ChromeSession {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private waiters: EventWaiter[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private stderr = "";
  private exited: Error | null = null;
  private sessionId = "";

  private constructor(
    private readonly child: ChildProcess,
    private readonly profile: string,
    private readonly timeoutMs: number,
  ) {
    const output = child.stdio[4] as Readable | null;
    output?.on("data", (chunk: Buffer) => this.receive(chunk));
    output?.on("error", () => undefined);
    (child.stdio[3] as Writable | null)?.on("error", () => undefined);
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2000);
    });
    const gone = (why: string) => {
      if (this.exited) return;
      const tail = this.stderr.trim().split("\n").filter((l) => !/task_policy_set|CVDisplayLink|allocator/.test(l)).slice(-2).join(" ");
      this.exited = new Error(`Chrome ${why}${tail ? `: ${tail.slice(0, 300)}` : ""}`);
      for (const p of this.pending.values()) (clearTimeout(p.timer), p.reject(this.exited));
      this.pending.clear();
      for (const w of this.waiters) (clearTimeout(w.timer), w.reject(this.exited));
      this.waiters = [];
    };
    child.on("exit", (code, signal) => gone(`exited (${signal ?? code})`));
    child.on("error", (error) => gone(`could not start (${error.message})`));
  }

  static async open(chrome: string, input: { width: number; height: number; scale: number; port: number; timeoutMs: number }): Promise<ChromeSession> {
    const profile = await mkdtemp(join(tmpdir(), "nomen-chrome-"));
    const child = spawn(chrome, chromeArgs({ ...input, profile }), { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const session = new ChromeSession(child, profile, input.timeoutMs);
    try {
      const { targetId } = (await session.send("Target.createTarget", { url: "about:blank" }, false)) as { targetId: string };
      const { sessionId } = (await session.send("Target.attachToTarget", { targetId, flatten: true }, false)) as { sessionId: string };
      session.sessionId = sessionId;
      await session.send("Page.enable");
      await session.send("Emulation.setDeviceMetricsOverride", { width: input.width, height: input.height, deviceScaleFactor: input.scale, mobile: false });
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  private receive(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let end: number;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const raw = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      let message: { id?: number; method?: string; params?: unknown; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string };
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Chrome: ${message.error.message ?? "protocol error"}`));
        else pending.resolve(message.result ?? {});
      } else if (message.method && message.sessionId === this.sessionId) {
        const index = this.waiters.findIndex((w) => w.method === message.method);
        if (index >= 0) {
          const [waiter] = this.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params);
        }
      }
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, onPage = true): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(this.exited);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the page did not finish rendering within ${Math.round(this.timeoutMs / 1000)} s (${method}; an endless loop?)`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message = JSON.stringify({ id, method, params, ...(onPage && this.sessionId ? { sessionId: this.sessionId } : {}) });
      (this.child.stdio[3] as Writable).write(`${message}\0`);
    });
  }

  /** Waits for the page event `method`; `cancel` drops the wait (and its timer) when it is no longer needed. */
  private waitFor(method: string): { promise: Promise<unknown>; cancel: () => void } {
    if (this.exited) return { promise: Promise.reject(this.exited), cancel: () => undefined };
    let waiter: EventWaiter | undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      const w: EventWaiter = {
        method,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error(`the page did not finish loading within ${Math.round(this.timeoutMs / 1000)} s (an endless loop?)`));
        }, this.timeoutMs),
      };
      waiter = w;
      this.waiters.push(w);
    });
    promise.catch(() => undefined);
    const cancel = () => {
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((x) => x !== waiter);
    };
    return { promise, cancel };
  }

  /** Loads `url`, waits for its load event and fonts, and writes a PNG of the viewport. */
  async shoot(url: string, png: string): Promise<void> {
    const loaded = this.waitFor("Page.loadEventFired");
    try {
      const navigation = (await this.send("Page.navigate", { url })) as { errorText?: string };
      if (navigation.errorText) throw new Error(`Chrome could not open the page: ${navigation.errorText}`);
      await loaded.promise;
    } finally {
      loaded.cancel();
    }
    await this.send("Runtime.evaluate", { expression: "document.fonts.ready.then(function(){return 1})", awaitPromise: true, returnByValue: true });
    const shot = (await this.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false })) as { data?: string };
    if (!shot.data) throw new Error("Chrome returned no screenshot");
    await writeFile(png, Buffer.from(shot.data, "base64"));
  }

  async close(): Promise<void> {
    if (!this.exited) {
      const done = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
      this.send("Browser.close", {}, false).catch(() => undefined);
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 2000);
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([done, new Promise<void>((resolve) => (giveUp = setTimeout(resolve, 5000)))]);
      clearTimeout(kill);
      clearTimeout(giveUp);
    }
    await rm(this.profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

type ShotTask = { url: string; png: string; resolve: () => void; reject: (error: Error) => void };

/** Up to `max` Chrome sessions taking screenshots from one queue; the first failure fails the rest. */
class ShotPool {
  private readonly sessions: ChromeSession[] = [];
  private readonly idle: ChromeSession[] = [];
  private readonly queue: ShotTask[] = [];
  private opening = 0;
  private closed = false;
  private failure: Error | null = null;

  constructor(
    private readonly launch: () => Promise<ChromeSession>,
    private readonly max: number,
  ) {}

  shoot(url: string, png: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.queue.push({ url, png, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    while (this.idle.length && this.queue.length) this.run(this.idle.pop()!, this.queue.shift()!);
    if (this.closed || this.failure || this.queue.length <= this.opening) return;
    const running = this.sessions.length + this.opening;
    if (running >= this.max) return;
    if (running === 0) {
      this.opening++;
      void acquireSlot().then(() => this.open());
    } else if (tryAcquireSlot()) {
      this.opening++;
      void this.open();
    }
  }

  private async open() {
    let session: ChromeSession;
    try {
      session = await this.launch();
    } catch (error) {
      this.opening--;
      releaseSlot();
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.opening--;
    if (this.closed || this.failure) {
      await session.close();
      releaseSlot();
      return;
    }
    this.sessions.push(session);
    this.idle.push(session);
    this.pump();
  }

  private run(session: ChromeSession, task: ShotTask) {
    session.shoot(task.url, task.png).then(
      () => {
        task.resolve();
        this.idle.push(session);
        this.pump();
      },
      (error: Error) => {
        task.reject(error);
        this.fail(error);
      },
    );
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const task of this.queue.splice(0)) task.reject(this.failure);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(new Error("render stopped"));
    const sessions = this.sessions.splice(0);
    this.idle.length = 0;
    await Promise.all(sessions.map((s) => s.close().finally(releaseSlot)));
  }
}

// ---------- the screen server ----------

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".css": "text/css; charset=utf-8",
};

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** file:///abs/path -> /f/abs/path, so the page asks the screen server for kit files. */
const toServed = (html: string) => html.replace(/file:\/\/(\/[^\s"'`()<>\\]*)/gi, "/f$1");

async function serveScreen(page: string, allow: string[]): Promise<{ server: Server; port: number }> {
  const roots = await Promise.all(allow.map(async (root) => realpath(root).catch(() => resolve(root))));
  let port = 0;
  const server = createServer((req, res) => {
    const nothing = () => {
      // 204 to a navigation leaves the current page in place; to a subresource it is just empty.
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "invalid"}`);
    } catch {
      return nothing();
    }
    if (url.host !== `127.0.0.1:${port}` || (req.method !== "GET" && req.method !== "HEAD")) return nothing();
    if (url.pathname === "/screen.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store" });
      res.end(page);
      return;
    }
    if (!url.pathname.startsWith("/f/")) return nothing();
    void (async () => {
      let path: string;
      try {
        path = await realpath(resolve(decodeURIComponent(url.pathname.slice(2))));
      } catch {
        return nothing();
      }
      const type = CONTENT_TYPES[extname(path).toLowerCase()];
      if (!type || !roots.some((root) => inside(path, root))) return nothing();
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return nothing();
      res.writeHead(200, { "content-type": type, "content-length": String(info.size), "cache-control": "no-store", "x-content-type-options": "nosniff" });
      if (req.method === "HEAD") return void res.end();
      createReadStream(path).on("error", () => res.destroy()).pipe(res);
    })();
  });
  // HTTPS through the proxy (CONNECT) and websockets: refused.
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done());
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  return { server, port };
}

// ---------- rendering ----------

export type RenderScreenOptions = {
  /** Where the HTML, the captured frames and the clip are written. */
  workDir: string;
  /** File name base (default: the request id, made file-safe). */
  name?: string;
  /** Local files and directories the page may load (default: assets/fonts and data/brandkits). */
  allow?: string[];
  /**
   * "smooth" (default): every frame whose picture changes is captured, so arrivals, typing and
   * counters play at 30 fps; stretches where neighbouring keyframes look the same are held.
   * "keyframes": only the keyframes, each held until the next, crossfaded when far apart.
   */
  motion?: "smooth" | "keyframes";
  /** Device scale for screenshots; >1 supersamples and scales down (sharper push-in, slower). Default 1. */
  scale?: number;
  /** Push-in over the clip as a fraction (default 0.025; 0 for none). */
  pushIn?: number;
  /** Chrome binary (default: findChrome()). */
  chromePath?: string;
  /** Per-step timeout for loading and capturing a frame (default 30 s). */
  timeoutMs?: number;
  /** Keep the captured PNGs in `<name>-frames/` (default: deleted once the clip is encoded). */
  keepFrames?: boolean;
};

/**
 * A rendered screen, plus the keyframes it came from, how many frames Chrome captured, and the
 * moments worth inspecting (where the picture holds still: the longest holds and the end).
 */
export type RenderedScreen = ScreenClip & { states: ScreenState[]; captures: number; inspect: number[] };

/** The end, plus the two longest holds before it (at least 0.2 s), as times a little into each hold. */
export function holdTimes(starts: number[], total: number): number[] {
  const fps = SCREEN_FPS;
  const holds = starts.map((start, i) => ({ start, length: (i + 1 < starts.length ? starts[i + 1] : total) - start }));
  const last = holds.pop();
  const picks = holds
    .filter((h) => h.length >= Math.round(0.2 * fps))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2)
    .map((h) => h.start + Math.min(3, Math.floor(h.length / 2)));
  if (last) picks.push(Math.max(last.start, total - 1));
  return [...new Set(picks)].sort((a, b) => a - b).map((f) => Math.round((f / fps) * 1000) / 1000);
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "screen";
const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
const num = (x: number) => String(Math.round(x * 10000) / 10000);
const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

async function ffmpegBin(): Promise<string | null> {
  return (await editFfmpeg()) ?? (await ffmpegPath());
}

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Keyframes mode: when each keyframe starts showing. A final keyframe at the very end is pulled in so it is seen. */
export function displayTimes(states: ScreenState[], seconds: number): number[] {
  const starts = states.map((s) => s.t);
  const n = starts.length;
  if (n >= 2 && starts[n - 1] >= seconds - 1 / SCREEN_FPS) {
    const prev = starts[n - 2];
    starts[n - 1] = Math.max(prev + 1 / SCREEN_FPS, Math.max(prev + (seconds - prev) / 2, seconds - 0.5));
  }
  return starts.map((t) => snapT(Math.min(seconds, t)));
}

/** perspective options mapping the viewport (x, y, w; height follows the canvas aspect) onto the canvas. */
function viewport(x: string, y: string, w: string): string {
  const y2 = `(${y})+H*(${w})/W`;
  return [`x0='${x}'`, `y0='${y}'`, `x1='(${x})+(${w})'`, `y1='${y}'`, `x2='${x}'`, `y2='${y2}'`, `x3='(${x})+(${w})'`, `y3='${y2}'`, "interpolation=cubic", "eval=frame"].join(":");
}

type Encode = { width: number; height: number; scale: number; seconds: number; pushIn: number; out: string };

/** The push-in (sub-pixel, via perspective), the scale back down from a supersampled canvas, and the pixel format. */
function finish(input: Encode): string[] {
  const total = Math.max(1, Math.round(input.seconds * SCREEN_FPS));
  const filters: string[] = [];
  if (input.pushIn > 0 && total > 1) {
    const z = `(1+${num(input.pushIn)}*min(1,(on-1)/${total - 1}))`;
    filters.push(`perspective=${viewport(`(W-W/${z})/2`, `(H-H/${z})/2`, `W/${z}`)}`);
  }
  if (even(input.width * input.scale) !== input.width || even(input.height * input.scale) !== input.height) filters.push(`scale=${input.width}:${input.height}:flags=lanczos`);
  filters.push("format=yuv420p");
  return filters;
}

const encodeArgs = (input: Encode) => [
  "-frames:v",
  String(Math.max(1, Math.round(input.seconds * SCREEN_FPS))),
  "-r",
  String(SCREEN_FPS),
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-an",
  "-movflags",
  "+faststart",
  input.out,
];

/**
 * Smooth mode: one PNG per output frame (`pattern`, numbered from 0), at 30 fps, with the push-in;
 * exactly round(seconds x 30) frames of H.264 yuv420p, no audio.
 */
export function sequenceArgs(input: Encode & { pattern: string }): string[] {
  const ws = even(input.width * input.scale);
  const hs = even(input.height * input.scale);
  const filters = [`scale=${ws}:${hs}:flags=lanczos`, "setsar=1", "format=yuv420p", ...finish(input)];
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-framerate", String(SCREEN_FPS), "-start_number", "0", "-i", input.pattern, "-vf", filters.join(","), ...encodeArgs(input)];
}

/**
 * Keyframes mode: each PNG held until the next, crossfaded over FADE_SECONDS where they are at
 * least HARD_CUT_GAP apart (cut otherwise), with the push-in; exactly round(seconds x 30) frames.
 */
export function assembleArgs(input: Encode & { pngs: string[]; starts: number[] }): string[] {
  const fps = SCREEN_FPS;
  const total = Math.max(1, Math.round(input.seconds * fps));
  const ws = even(input.width * input.scale);
  const hs = even(input.height * input.scale);
  const n = input.pngs.length;
  const start = input.starts.map((s, i) => (i === 0 ? 0 : Math.min(total - 1, Math.max(1, Math.round(s * fps)))));
  const fadeFrames = Math.max(1, Math.round(FADE_SECONDS * fps));
  const fade = start.map((s, i) => {
    if (i === 0) return 0;
    const before = s - start[i - 1];
    const after = i + 1 < n ? start[i + 1] - s : Infinity;
    return before >= HARD_CUT_GAP * fps && after > fadeFrames ? fadeFrames : 0;
  });
  // Each keyframe's stream starts when its fade begins and ends once the next one is opaque; the
  // first runs the whole clip underneath.
  const from = start.map((s, i) => Math.max(i === 0 ? 0 : start[i - 1] + 1, s - Math.floor(fade[i] / 2)));
  const opaque = from.map((f, i) => f + fade[i]);
  const until = from.map((_, i) => (i === 0 ? total : i + 1 < n ? Math.max(opaque[i + 1], from[i] + 1) : total));

  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  for (const png of input.pngs) args.push("-i", png);
  const graph: string[] = [];
  input.pngs.forEach((_, i) => {
    const len = Math.max(1, until[i] - from[i]);
    const alpha = fade[i] > 0;
    graph.push(
      `[${i}:v]scale=${ws}:${hs}:flags=lanczos,setsar=1,format=${alpha ? "yuva420p" : "yuv420p"},trim=end_frame=1,loop=loop=${len - 1}:size=1:start=0,settb=1/${fps},setpts=N+${from[i]}` +
        (alpha ? `,fade=t=in:start_frame=0:nb_frames=${fade[i]}:alpha=1` : "") +
        `[s${i}]`,
    );
  });
  let base = "s0";
  for (let i = 1; i < n; i++) {
    graph.push(`[${base}][s${i}]overlay=0:0:eof_action=pass:format=auto[c${i}]`);
    base = `c${i}`;
  }
  graph.push(`[${base}]${finish(input).join(",")}[v]`);
  return [...args, "-filter_complex", graph.join(";"), "-map", "[v]", ...encodeArgs(input)];
}

/**
 * Renders a screen with headless Chrome and ffmpeg. Writes the page to `<workDir>/<name>.html`,
 * serves it to at most 3 Chrome sessions (shared by every render in the process), captures frames
 * at `?t=` and encodes `<workDir>/<name>.mp4`: exactly request.seconds long (rounded to the 30 fps
 * grid), 1080x1920 (full), 1080x960 (half) or 1440x900 (desktop), H.264 yuv420p, no audio, with a
 * 2.5% push-in (none on desktop: the picture on a monitor holds still; the filmed edit moves the camera). When
 * every captured frame is the same picture, the result is a still `<name>.png` (kind "image").
 *
 * Smooth mode (default) captures the keyframes plus frame 0 and the last frame, then bisects every
 * stretch whose two ends differ until each changing frame is captured; a stretch whose ends are
 * identical is assumed to hold. Keyframes mode captures only the keyframes.
 */
export async function renderScreen(html: string, states: ScreenState[], request: ScreenRequest, options: RenderScreenOptions): Promise<RenderedScreen> {
  const size = request.box ? screenSize(request) : SCREEN_SIZES[request.size];
  if (!size) throw new Error(`screen ${request.id}: unknown size "${String(request.size)}"`);
  if (!(Number.isFinite(request.seconds) && request.seconds > 0)) throw new Error(`screen ${request.id}: seconds must be positive`);
  const chrome = options.chromePath ?? findChrome();
  if (!chrome) throw chromeMissing();
  const bin = await ffmpegBin();
  if (!bin) throw new Error("No ffmpeg found: install ffmpeg or the ffmpeg-static package, or set FFMPEG_PATH.");

  const fps = SCREEN_FPS;
  const total = Math.max(1, Math.round(request.seconds * fps));
  const motion = options.motion ?? "smooth";
  const workDir = resolve(options.workDir);
  const name = safeName(options.name ?? request.id);
  const scale = Math.min(3, Math.max(1, options.scale ?? 1));
  const pushIn = Math.max(0, Math.min(0.1, options.pushIn ?? (request.size === "desktop" ? 0 : PUSH_IN)));
  const allow = [...(options.allow ?? [FONTS_DIR, BRANDKITS_DIR]), workDir].map((r) => resolve(r));
  const keyframes = parseStates(states, request.seconds);
  const frameDir = join(workDir, `${name}-frames`);
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });

  const page = prepareHtml(sanitizeHtml(html, allow).html, request);
  const htmlPath = join(workDir, `${name}.html`);
  await writeFile(htmlPath, page, "utf8");

  const pngOf = (key: number) => join(frameDir, `${String(key).padStart(5, "0")}.png`);
  const hashes = new Map<number, string>();
  const { server, port } = await serveScreen(toServed(page), allow);
  const pool = new ShotPool(() => ChromeSession.open(chrome, { width: size.width, height: size.height, scale, port, timeoutMs: options.timeoutMs ?? SHOT_TIMEOUT_MS }), CHROME_PARALLEL);
  const capture = (keys: Array<{ key: number; t: number }>) =>
    Promise.all(
      keys.map(async ({ key, t }) => {
        await pool.shoot(`http://127.0.0.1:${port}/screen.html?t=${num(t)}`, pngOf(key));
        const bytes = await readFile(pngOf(key));
        if (!pngSize(bytes)) throw new Error(`screen ${request.id}: Chrome wrote an unreadable screenshot`);
        hashes.set(key, sha1(bytes));
      }),
    );

  // (key, when it starts showing in seconds), in time order.
  let shown: Array<{ key: number; start: number }>;
  try {
    if (motion === "keyframes") {
      await capture(keyframes.map((s, i) => ({ key: i, t: s.t })));
      const starts = displayTimes(keyframes, request.seconds);
      shown = keyframes.map((_, i) => ({ key: i, start: starts[i] }));
    } else {
      const frameOf = (t: number) => Math.min(total - 1, Math.max(0, Math.round(t * fps)));
      const anchors = [...new Set([0, total - 1, ...keyframes.map((s) => frameOf(s.t))])].sort((a, b) => a - b);
      await capture(anchors.map((key) => ({ key, t: key / fps })));
      const differs = ([a, b]: [number, number]) => b - a > 1 && hashes.get(a) !== hashes.get(b);
      let open = anchors.slice(1).map((b, i): [number, number] => [anchors[i], b]).filter(differs);
      while (open.length) {
        const mids = open.map(([a, b]) => Math.floor((a + b) / 2));
        await capture(mids.map((key) => ({ key, t: key / fps })));
        open = open.flatMap(([a, b], i): Array<[number, number]> => [[a, mids[i]], [mids[i], b]]).filter(differs);
      }
      shown = [...hashes.keys()].sort((a, b) => a - b).map((key) => ({ key, start: key / fps }));
    }
  } catch (error) {
    if (!options.keepFrames) await rm(frameDir, { recursive: true, force: true });
    throw error;
  } finally {
    await pool.close();
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  }

  // Consecutive identical pictures are one hold.
  const unique = shown.filter((s, i) => i === 0 || hashes.get(s.key) !== hashes.get(shown[i - 1].key));
  const captures = hashes.size;
  const holds = motion === "smooth" ? holdTimes(unique.map((u) => u.key), total) : [];
  const inspect = holds.length >= 2 ? holds : checkTimes(request.seconds, keyframes);
  const base = { id: request.id, seconds: request.seconds, html_path: htmlPath, states: keyframes, captures, inspect };
  const cleanup = () => (options.keepFrames ? Promise.resolve() : rm(frameDir, { recursive: true, force: true }));

  try {
    if (unique.length === 1) {
      const out = join(workDir, `${name}.png`);
      const png = pngOf(unique[0].key);
      const dims = pngSize(await readFile(png));
      if (dims && dims.width === size.width && dims.height === size.height) await copyFile(png, out);
      else await exec(bin, ["-hide_banner", "-loglevel", "error", "-y", "-i", png, "-vf", `scale=${size.width}:${size.height}:flags=lanczos`, "-frames:v", "1", out]);
      return { ...base, kind: "image", path: out };
    }

    const out = join(workDir, `${name}.mp4`);
    const encode = { width: size.width, height: size.height, scale, seconds: request.seconds, pushIn, out };
    let args: string[];
    if (motion === "keyframes") {
      args = assembleArgs({ ...encode, pngs: unique.map((u) => pngOf(u.key)), starts: unique.map((u) => u.start) });
    } else {
      // One numbered link per output frame to the capture on screen then.
      const seq = join(frameDir, "seq");
      await mkdir(seq, { recursive: true });
      let j = 0;
      for (let f = 0; f < total; f++) {
        while (j + 1 < unique.length && unique[j + 1].key <= f) j++;
        const link = join(seq, `${String(f).padStart(5, "0")}.png`);
        await symlink(pngOf(unique[j].key), link).catch(() => copyFile(pngOf(unique[j].key), link));
      }
      args = sequenceArgs({ ...encode, pattern: join(seq, "%05d.png") });
    }
    try {
      await exec(bin, args, { maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`screen ${request.id}: ffmpeg failed${stderr ? `: ${stderr.slice(-1500)}` : ""}`);
    }
    return { ...base, kind: "video", path: out };
  } finally {
    await cleanup();
  }
}

// ---------- checking ----------

export type ScreenCheck = { pass: boolean; issues: string[]; score: number | null };

export const SCREEN_PASS_SCORE = 7;

const CHECK_TOOL = {
  name: "screen_verdict",
  description: "Record the verdict on this rendered screen.",
  input_schema: {
    type: "object",
    required: ["score", "pass", "issues"],
    properties: {
      score: { type: "integer", description: "1-10. 9-10 looks like a top creator's motion graphic; 7-8 good, minor flaws; 5-6 amateur, hard to read or off-brief; 1-4 broken." },
      pass: { type: "boolean", description: "true only if score >= 7 and there is no critical defect." },
      issues: { type: "array", items: { type: "string" }, description: "Concrete defects a designer can fix, most severe first, each naming the element and where it is. Empty if none." },
    },
  },
};

/**
 * When to look at a clip: three of its keyframes (about 40% and 70% through the list, and the
 * last), a few frames after each so a crossfade has finished; without keyframes, 35%, 70% and the end.
 */
export function checkTimes(seconds: number, states?: ScreenState[]): number[] {
  const end = Math.max(0, seconds - 1.5 / SCREEN_FPS);
  const list = (states ?? []).filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  let times: number[];
  if (list.length >= 2) {
    // Never the first keyframe: at t=0 most screens are still an empty background waiting for arrivals.
    const picks = [...new Set([Math.round((list.length - 1) * 0.4), Math.round((list.length - 1) * 0.7), list.length - 1])].filter((i) => i > 0);
    times = picks.map((i) => Math.min(list[i].t + 0.07, i + 1 < list.length ? list[i + 1].t - 1 / SCREEN_FPS : end, end));
    if (times.length < 2) times.push(Math.min(end, seconds * 0.5));
  } else {
    times = [0.35, 0.7, 1].map((p) => Math.min(end, seconds * p));
  }
  return [...new Set(times.map((t) => Math.round(Math.max(0, t) * 1000) / 1000))].sort((a, b) => a - b);
}

/**
 * How wide the check sees a frame: about as big as a phone shows it. A vertical screen is the whole
 * picture (half of 1080 px); a desktop screen is a monitor filling most of it, seen a little larger
 * so the reviewer can still judge its type.
 */
const checkWidth = (size: ScreenRequest["size"]) => (size === "desktop" ? 640 : 540);

async function checkFrames(clip: ScreenClip & { states?: ScreenState[]; inspect?: number[] }, request: ScreenRequest): Promise<Buffer[]> {
  const bin = await ffmpegBin();
  if (!bin) throw new Error("ffmpeg is not available");
  const grab = async (at: number | null) => {
    const args = ["-hide_banner", "-loglevel", "error"];
    if (at !== null) args.push("-ss", at.toFixed(3));
    args.push("-i", clip.path, "-frames:v", "1", "-vf", `scale=${checkWidth(request.size)}:-2:flags=lanczos`, "-q:v", "3", "-f", "mjpeg", "pipe:1");
    const { stdout } = await exec(bin, args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return stdout as unknown as Buffer;
  };
  if (clip.kind === "image") return [await grab(null)];
  const frames: Buffer[] = [];
  const seconds = clip.seconds || request.seconds;
  const times = clip.inspect?.length ? clip.inspect.map((t) => Math.min(t, Math.max(0, seconds - 1.5 / SCREEN_FPS))) : checkTimes(seconds, clip.states);
  for (const at of times) {
    const frame = await grab(at);
    if (frame.length) frames.push(frame);
  }
  return frames;
}

/**
 * Vision QC on 2-3 frames of a rendered screen, shown at phone size (540 px wide): legible, nothing
 * cut off, no placeholders, safe areas clear, on brief and on brand.
 */
export async function checkScreen(naive: Messenger, clip: ScreenClip & { states?: ScreenState[]; inspect?: number[] }, request: ScreenRequest, context: { product?: ProductBrief; kit?: BrandKit | null } = {}): Promise<ScreenCheck> {
  const frames = await checkFrames(clip, request);
  if (!frames.length) return { pass: false, issues: ["the clip has no readable frames"], score: 1 };
  const colors = (context.kit?.repo?.colors ?? []).slice(0, 8).map((c) => `${c.name} ${c.hex}`).join(", ");
  const desktop = request.size === "desktop";
  const where = desktop
    ? "the display of a desktop monitor that a phone films; in the video the monitor fills about 85% of the phone's width"
    : request.size === "half"
      ? "the bottom half of a split screen, under the presenter"
      : "full screen";
  const rubric = [
    `These ${frames.length} frame(s), in time order, are from a ${request.seconds} s on-screen graphic for a vertical TikTok${context.product ? ` about ${context.product.name}` : ""}, shown at about phone size (${request.box ? `one ${screenSize(request).width}x${screenSize(request).height} px element placed inside a 1080x1920 video frame` : where}).`,
    `What it should show: ${request.brief}`,
    `The spoken line it goes with: "${request.line}"`,
    request.reference_visual ? `The viral video it remakes looked like: ${request.reference_visual}` : "",
    colors ? `Brand colours: ${colors}.` : "",
    request.box ? "" : `Reserved areas (no text there): ${bandsText(request.size)}`,
    desktop
      ? "Critical defects (any one fails it): text too small or too low-contrast to read at this size; text or UI cut off by the edges or overflowing its box; overlapping text; placeholder text (lorem ipsum, \"Your text\", {{...}}, TODO); broken-image icons, empty boxes or missing-glyph squares; a blank, black or error page; text inside a reserved area; content that contradicts the brief or shows a different product name; it looks like a poster, slide or motion-graphic card rather than a real app, terminal, editor or browser window on a computer."
      : `Critical defects (any one fails it): text too small or too low-contrast to read on a phone; text or UI cut off by the frame or overflowing its box; overlapping text; placeholder text (lorem ipsum, "Your text", {{...}}, TODO); broken-image icons, empty boxes or missing-glyph squares; a blank, black or error page; text inside a reserved area; content that contradicts the brief or shows a different product name${request.box ? "" : "; it looks like a plain web page screenshot rather than a designed motion graphic"}.`,
    "Not critical (mention, do not fail for it): small spacing or alignment nits, a slightly different layout than the brief describes when the content is right.",
    desktop
      ? "The frames are taken where the screen holds still."
      : "The frames are taken where the screen holds still. The whole picture zooms in slowly (about 2.5% over the clip) on purpose: small differences in size or position between frames are that zoom, not a defect.",
    desktop
      ? "Judge it like a creative director at a top short-form agency: does it look like the real product on a real screen, with one clear idea and type big enough to read through a phone camera? Call the screen_verdict tool once."
      : "Judge it like a creative director at a top short-form agency: bold, clean, high contrast, one clear idea per screen. Call the screen_verdict tool once.",
  ]
    .filter(Boolean)
    .join("\n");
  const images = frames.map((frame) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } }));
  const ask = (text: string, tools?: object[]) => naive.message({ model: QC_MODEL, max_tokens: 1200, messages: [{ role: "user", content: [...images, { type: "text", text }] }], tools });

  type Raw = { score?: unknown; pass?: unknown; issues?: unknown } | null;
  let raw: Raw = null;
  try {
    const reply = await ask(rubric, [CHECK_TOOL]);
    const call = reply.content.find((block) => block.type === "tool_use" && block.name === CHECK_TOOL.name);
    raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Raw;
  } catch (error) {
    if (!(error instanceof ApiError) || !/tool/i.test(error.message)) throw error;
  }
  if (!raw || raw.score === undefined) {
    const reply = await ask(`${rubric.replace("Call the screen_verdict tool once.", "")}\nAnswer with only a JSON object: {"score": 1-10, "pass": true|false, "issues": ["..."]}`);
    raw = extractJson(reply.content.map((block) => block.text ?? "").join("\n")) as Raw;
    if (!raw) throw new ApiError("naive", 502, "qc_unreadable", `screen ${request.id}: the screen check returned no verdict`);
  }
  const score = Math.max(1, Math.min(10, Math.round(Number(raw.score) || 0)));
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((i): i is string => typeof i === "string" && i.trim() !== "").slice(0, 8) : [];
  return { pass: raw.pass === true && score >= SCREEN_PASS_SCORE, issues, score };
}

// ---------- building ----------

export type BuildScreensOptions = {
  workDir: string;
  /** Screens built at once (default 3). Chrome itself is capped at 3 processes. */
  concurrency?: number;
  /** Passed to renderScreen (scale, pushIn, chromePath, timeoutMs). */
  render?: Omit<RenderScreenOptions, "workDir" | "name" | "allow">;
  /** Keep a screen that failed its check twice instead of reporting it as a failure. */
  keepFailed?: boolean;
};

export type ScreenReport = { id: string; attempts: number; check: ScreenCheck | null; note?: string };

/**
 * Builds every requested screen: write, render, check, and one rewrite with the check's issues when
 * it fails. Screens are independent: one failing never stops the others. Clips come back in request
 * order; `reports` says how many attempts each took and what the last check said.
 */
export async function buildScreens(
  naive: Messenger,
  requests: ScreenRequest[],
  ctx: Omit<ScreenContext, "previous">,
  options: BuildScreensOptions,
): Promise<{ clips: ScreenClip[]; failures: Array<{ id: string; error: string; retryable?: boolean }>; reports: ScreenReport[] }> {
  const results: Array<{ clip?: ScreenClip; error?: string; retryable?: boolean; report?: ScreenReport }> = requests.map(() => ({}));
  const chrome = options.render?.chromePath ?? findChrome();
  // Without Chrome or ffmpeg nothing can render: fail every screen now rather than pay for writes.
  const missing = !chrome || !isExecutable(chrome) ? chromeMissing().message : !(await ffmpegBin()) ? "No ffmpeg found: install ffmpeg or the ffmpeg-static package, or set FFMPEG_PATH." : "";
  if (missing || !chrome) return { clips: [], failures: requests.map((r) => ({ id: r.id, error: missing })), reports: [] };
  const allow = allowedRoots(ctx.kit, ctx.product);
  await mkdir(resolve(options.workDir), { recursive: true });

  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const i = next++;
      try {
        results[i] = await buildOne(naive, requests[i], ctx, { ...options, render: { ...options.render, chromePath: chrome } }, allow);
      } catch (error) {
        // A busy or rate-limited model is worth another try later; a bad screen is not.
        results[i] = { error: error instanceof Error ? error.message : String(error), retryable: error instanceof ApiError && error.retryable };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, requests.length)) }, worker));

  const clips: ScreenClip[] = [];
  const failures: Array<{ id: string; error: string; retryable?: boolean }> = [];
  const reports: ScreenReport[] = [];
  results.forEach((r, i) => {
    if (r.clip) clips.push(r.clip);
    if (r.error) failures.push({ id: requests[i].id, error: r.error, ...(r.retryable ? { retryable: true } : {}) });
    if (r.report) reports.push(r.report);
  });
  return { clips, failures, reports };
}

async function buildOne(
  naive: Messenger,
  request: ScreenRequest,
  ctx: Omit<ScreenContext, "previous">,
  options: BuildScreensOptions,
  allow: string[],
): Promise<{ clip?: ScreenClip; error?: string; report: ScreenReport }> {
  const base = safeName(request.id);
  let previous: ScreenContext["previous"];
  let last: { clip: ScreenClip; check: ScreenCheck } | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let written: { html: string; states: ScreenState[] };
    try {
      written = await writeScreen(naive, request, { ...ctx, previous });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      previous = { html: "", issues: [`your last answer could not be used: ${lastError}. Answer with one complete \`\`\`html block and one \`\`\`json block.`] };
      continue;
    }
    let clip: ScreenClip;
    try {
      clip = await renderScreen(written.html, written.states, request, { ...options.render, workDir: options.workDir, name: attempt === 1 ? base : `${base}.v${attempt}`, allow });
    } catch (error) {
      if ((error as { code?: string }).code === "chrome_missing") throw error;
      lastError = error instanceof Error ? error.message : String(error);
      previous = { html: written.html, issues: [`it did not render: ${lastError}`] };
      continue;
    }
    let check: ScreenCheck;
    try {
      check = await checkScreen(naive, clip, request, ctx);
    } catch (error) {
      // No verdict is not a verdict: keep the clip and say the check was unavailable.
      const note = `check unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return { clip, report: { id: request.id, attempts: attempt, check: null, note } };
    }
    if (check.pass) return { clip, report: { id: request.id, attempts: attempt, check } };
    last = { clip, check };
    lastError = `failed its check: ${check.issues.join("; ") || `score ${check.score}`}`;
    previous = { html: written.html, issues: check.issues.length ? check.issues : [`scored ${check.score}/10: make it bolder, cleaner and easier to read`] };
  }
  const report: ScreenReport = { id: request.id, attempts: 2, check: last?.check ?? null };
  if (last && options.keepFailed) return { clip: last.clip, report: { ...report, note: "kept although it failed its check" } };
  return { error: lastError || "no usable screen", report };
}
