// Renders a code ad: serves the vendored engine (src/lib/codeads/engine), three.js and the ad's own folder on 127.0.0.1,
// opens it in headless Chrome with WebGL (driven over the DevTools pipe, like the screen builder), steps the timeline
// frame by frame and pipes JPEG frames into ffmpeg. Ported from ED Studio's tools/render.mjs (which uses puppeteer).
//
// It needs Chrome with a GPU (or SwiftShader) and ffmpeg on the machine: it runs locally, not on a serverless host.

import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";

import { ffmpegPath } from "../media";

/** The browser half of the engine (vendored from ED Studio, plus the code-ad scene). */
export const ENGINE_DIR = resolve(process.cwd(), "src/lib/codeads/engine");
const THREE_DIR = resolve(process.cwd(), "node_modules/three");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** Serves /engine/*, /three/* and /ad/* (the ad's folder), nothing else, on a random port of 127.0.0.1. */
export function serveAd(adDir: string): Promise<{ server: Server; port: number }> {
  const roots: Record<string, string> = { engine: ENGINE_DIR, three: THREE_DIR, ad: resolve(adDir) };
  const server = createServer((req, res) => {
    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const [, top, ...rest] = pathname.split("/");
    const root = roots[top ?? ""];
    const file = root ? resolve(root, rest.join("/")) : "";
    if (req.method !== "GET" || !root || !(file === root || file.startsWith(root + sep)) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done({ server, port: (server.address() as { port: number }).port }));
  });
}

/** Headless Chrome flags: WebGL on the GPU (Metal on macOS), every request routed to our server and nowhere else. */
export function webglChromeArgs(input: { port: number; profile: string }): string[] {
  const args = [
    "--headless=new",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    `--use-angle=${process.platform === "darwin" ? "metal" : "default"}`,
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--no-pings",
    "--use-mock-keychain",
    "--password-store=basic",
    "--force-color-profile=srgb",
    `--proxy-server=http://127.0.0.1:${input.port}`,
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    `--user-data-dir=${input.profile}`,
    "--window-size=1080,1920",
    "--force-device-scale-factor=1",
    "--remote-debugging-pipe",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** One headless Chrome page over the DevTools pipe (fds 3 and 4): navigate, evaluate, screenshot. */
class Page {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private sessionId = "";
  private exited: Error | null = null;
  private stderr = "";
  readonly logs: string[] = [];

  private constructor(
    private readonly child: ChildProcess,
    private readonly profile: string,
  ) {
    (child.stdio[4] as Readable).on("data", (chunk: Buffer) => this.receive(chunk));
    (child.stdio[3] as Writable).on("error", () => undefined);
    child.stderr?.on("data", (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2000)));
    const gone = (why: string) => {
      if (this.exited) return;
      this.exited = new Error(`Chrome ${why}: ${this.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
      for (const p of this.pending.values()) (clearTimeout(p.timer), p.reject(this.exited));
      this.pending.clear();
    };
    child.on("exit", (code, signal) => gone(`exited (${signal ?? code})`));
    child.on("error", (error) => gone(`could not start (${error.message})`));
  }

  static async open(chrome: string, port: number): Promise<Page> {
    const profile = await mkdtemp(join(tmpdir(), "nomen-codead-"));
    const child = spawn(chrome, webglChromeArgs({ port, profile }), { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const page = new Page(child, profile);
    try {
      const { targetId } = (await page.send("Target.createTarget", { url: "about:blank" }, false)) as { targetId: string };
      const { sessionId } = (await page.send("Target.attachToTarget", { targetId, flatten: true }, false)) as { sessionId: string };
      page.sessionId = sessionId;
      await page.send("Page.enable");
      await page.send("Runtime.enable");
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  private receive(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let end: number;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const raw = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
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
      } else if (message.method === "Runtime.consoleAPICalled") {
        const params = message.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
        if (params.type === "error" || params.type === "warning") this.logs.push(`[page ${params.type}] ${(params.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ")}`.slice(0, 400));
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = (message.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } }).exceptionDetails;
        this.logs.push(`[page error] ${details?.exception?.description ?? details?.text ?? "exception"}`.slice(0, 400));
      }
    }
  }

  send(method: string, params: Record<string, unknown> = {}, onPage = true, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(this.exited);
    const id = ++this.nextId;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`Chrome did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: done, reject: fail, timer });
      (this.child.stdio[3] as Writable).write(`${JSON.stringify({ id, method, params, ...(onPage && this.sessionId ? { sessionId: this.sessionId } : {}) })}\0`);
    });
  }

  async evaluate<T>(expression: string, timeoutMs = 120_000): Promise<T> {
    const result = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, true, timeoutMs)) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) throw new Error(`page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "exception"}`);
    return result.result?.value as T;
  }

  async jpeg(scale = 1, quality = 92): Promise<Buffer> {
    const shot = (await this.send("Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true, clip: { x: 0, y: 0, width: 1080, height: 1920, scale } })) as { data?: string };
    if (!shot.data) throw new Error("Chrome returned no screenshot");
    return Buffer.from(shot.data, "base64");
  }

  async close(): Promise<void> {
    if (!this.exited) {
      const done = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
      this.send("Browser.close", {}, false, 5000).catch(() => undefined);
      const kill = setTimeout(() => this.child.kill("SIGKILL"), 3000);
      await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 6000))]);
      clearTimeout(kill);
    }
    await rm(this.profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The page with the ad loaded and its scene built. Call `close()` when done. */
export async function openAd(adDir: string, chrome: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const { server, port } = await serveAd(adDir);
  let page: Page | null = null;
  const close = async () => {
    await page?.close();
    await new Promise<void>((done) => server.close(() => done()));
  };
  try {
    page = await Page.open(chrome, port);
    await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/engine/index.html` });
    const started = Date.now();
    for (;;) {
      const state = await page.evaluate<{ ready: boolean; error: string | null }>("({ ready: !!window.CODEAD_READY, error: window.CODEAD_ERROR || null })").catch(() => ({ ready: false, error: null }));
      if (state.error) throw new Error(`the code-ad page failed: ${state.error.slice(0, 600)}`);
      if (state.ready) break;
      if (Date.now() - started > 120_000) throw new Error(`the code-ad page did not load within 120 s${page.logs.length ? `: ${page.logs.slice(-3).join(" ")}` : ""}`);
      await new Promise((done) => setTimeout(done, 250));
    }
    return { page, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const frameAt = (page: Page, t: number, blur: number, shutter: number, fps: number) =>
  page.evaluate(`new Promise((r) => { ${blur > 1 ? `window.renderAtBlur(${t}, ${blur}, ${shutter}, ${fps})` : `window.renderAt(${t})`}; requestAnimationFrame(() => r(1)); })`);

/** Still frames at the given times (half size by default), written as t<seconds>.jpg; returns their paths. */
export async function renderStills(adDir: string, chrome: string, times: number[], outDir: string, scale = 0.5): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const { page, close } = await openAd(adDir, chrome);
  try {
    const paths: string[] = [];
    for (const t of times) {
      await frameAt(page, t, 1, 0.5, 30);
      const path = join(outDir, `t${t.toFixed(2).padStart(6, "0")}.jpg`);
      await writeFile(path, await page.jpeg(scale, 90));
      paths.push(path);
    }
    return paths;
  } finally {
    await close();
  }
}

/** The scene's own checks (faces under text), as lines; empty means clean. */
export async function runQc(adDir: string, chrome: string): Promise<string[]> {
  const { page, close } = await openAd(adDir, chrome);
  try {
    return await page.evaluate<string[]>("window.CODEAD_QC()", 300_000);
  } finally {
    await close();
  }
}

export type RenderOptions = { fps?: number; blur?: number; shutter?: number; from?: number; to: number; onProgress?: (done: number, total: number) => void };

/** The silent picture: every frame from `from` to `to`, H.264 1080x1920, into `out`. Returns the page's warnings. */
export async function renderVideo(adDir: string, chrome: string, out: string, options: RenderOptions): Promise<string[]> {
  const ffmpeg = await ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is needed to encode a code ad");
  const fps = options.fps ?? 60, blur = options.blur ?? 2, shutter = options.shutter ?? 0.5, from = options.from ?? 0;
  const { page, close } = await openAd(adDir, chrome);
  const encoder = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "ignore", "pipe"] });
  let encoderError = "";
  encoder.stderr?.on("data", (chunk: Buffer) => (encoderError = (encoderError + chunk.toString("utf8")).slice(-1000)));
  const finished = new Promise<number>((done) => encoder.on("close", (code) => done(code ?? 1)));
  try {
    const total = Math.round((options.to - from) * fps);
    for (let i = 0; i < total; i++) {
      await frameAt(page, from + i / fps, blur, shutter, fps);
      const buffer = await page.jpeg(1, 95);
      if (!encoder.stdin!.write(buffer)) await new Promise((done) => encoder.stdin!.once("drain", done));
      if (options.onProgress && (i % fps === 0 || i === total - 1)) options.onProgress(i + 1, total);
    }
  } finally {
    encoder.stdin!.end();
    await close();
  }
  const code = await finished;
  if (code !== 0) throw new Error(`ffmpeg could not encode the frames: ${encoderError.trim().slice(0, 300)}`);
  return page.logs;
}

/** A contact sheet of stills (cols x rows, each 216 px wide) for a person or a vision model to read at a glance. */
export async function contactSheet(stills: string[], out: string, cols = 6): Promise<string> {
  const ffmpeg = await ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is needed for a contact sheet");
  const rows = Math.ceil(stills.length / cols);
  const inputs = stills.flatMap((path) => ["-i", path]);
  const scaled = stills.map((_, i) => `[${i}:v]scale=270:480[s${i}]`).join(";");
  const pads = Array.from({ length: cols * rows - stills.length }, (_, i) => `color=black:s=270x480:d=1[p${i}]`);
  const all = [...stills.map((_, i) => `[s${i}]`), ...pads.map((_, i) => `[p${i}]`)].join("");
  const layout = Array.from({ length: cols * rows }, (_, i) => `${(i % cols) * 274}_${Math.floor(i / cols) * 484}`).join("|");
  const filter = [scaled, ...pads, `${all}xstack=inputs=${cols * rows}:layout=${layout}:fill=black[out]`].filter(Boolean).join(";");
  await new Promise<void>((done, fail) => {
    const child = spawn(ffmpeg, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "3", out], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`contact sheet failed: ${err.slice(-300)}`))));
  });
  return out;
}
