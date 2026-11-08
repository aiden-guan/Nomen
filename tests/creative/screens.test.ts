import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FONTS_DIR,
  MAX_CAPTURES,
  assembleArgs,
  buildScreens,
  checkTimes,
  displayTimes,
  fileUrl,
  findChrome,
  holdTimes,
  parseScreenReply,
  parseStates,
  prepareHtml,
  renderScreen,
  safeAreas,
  sanitizeHtml,
  screenPrompt,
  writerSystem,
} from "@/lib/creative/screens";
import { editFfmpeg } from "@/lib/creative/edit";
import type { BrandKit, ProductBrief, ScreenRequest } from "@/lib/creative/types";
import { ffmpegPath, probe } from "@/lib/media";

const exec = promisify(execFile);
const FIXTURES = resolve("tests/creative/fixtures/screens");
const KIT = join(FIXTURES, "kit");
const chrome = findChrome();
const ffmpeg = (await editFfmpeg()) ?? (await ffmpegPath());
const canRender = Boolean(chrome && ffmpeg);

const request = (over: Partial<ScreenRequest> = {}): ScreenRequest => ({
  id: "crv_x-b3",
  brief: "a terminal where `set up https://monid.ai/SKILL.md` is typed and the agent replies 'connected: 2900+ tools'",
  line: "Paste one line into your agent and it's connected.",
  seconds: 2,
  reference_visual: "dark background, a terminal card, big white monospace text",
  size: "full",
  ...over,
});

const product: ProductBrief = {
  name: "Monid",
  one_liner: "Give your AI agent one setup link and it can find and use thousands of tools, paying per call from one balance.",
  kind: "software",
  audience: "developers building AI agents",
  problem: "every tool needs its own sign-up and API key",
  aha: "you paste one link into your agent and it is connected",
  features: [{ name: "discover", what_it_does: "finds the right tool for a task", how_to_show_it: "a ranked list of tools" }],
  claims: ["2900+ tools across 97+ providers", "pay per call from one balance", "$1 free credit"],
  proof: [],
  objections: [],
  offer: "$1 free credit",
  voice: "dry, technical",
  look: "white page, black type, blue accents",
  visuals: [],
};

const kit: BrandKit = {
  brand_id: "monid-test",
  updated_at: "2026-11-07T00:00:00Z",
  assets: [{ id: "a1", kind: "logo", path: join(KIT, "logo.svg"), source: "upload", caption: "Monid M logo, black square", width: 96, height: 96, bytes: 300 }],
  repo: {
    origin: "local:/monid",
    scanned_at: "2026-11-07T00:00:00Z",
    name: "monid",
    description: "Tools for AI agents",
    readme: "Connect your agent to every tool it needs.",
    colors: [{ name: "brand", hex: "#1f3cff", source: "tailwind.config.ts" }],
    fonts: ["Inter"],
    commands: ["set up https://monid.ai/SKILL.md"],
    screens: [],
    components: [{ name: "SetupPill", file: "components/setup.tsx", excerpt: "<div className='rounded-xl bg-black font-mono'>set up …</div>" }],
    ui_strings: ["Give this to your agent", "LIVE · 2900+ TOOLS"],
  },
};

const typingHtml = async () => (await readFile(join(FIXTURES, "typing.html"), "utf8")).replaceAll("__KIT_URL__", fileUrl(KIT));

describe("sanitizeHtml", () => {
  const allow = [KIT, FONTS_DIR];

  it("removes remote scripts, links, imports, fonts, iframes and embeds but keeps inline code and visible URLs", () => {
    const html = [
      "<!doctype html><html><head>",
      '<script src="https://cdn.example.com/gsap.min.js"></script>',
      '<script src="//evil.example/x.js"/>',
      '<link rel="preconnect" href="https://fonts.gstatic.com">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<base href="https://evil.example/">',
      "<style>@import url('https://fonts.googleapis.com/css2?family=Inter'); @font-face{font-family:X;src:url(https://fonts.gstatic.com/x.woff2) format('woff2')} body{background:url(\"//cdn.example/bg.png\")}</style>",
      "</head><body>",
      "<h1>set up https://monid.ai/SKILL.md</h1>",
      '<iframe src="https://evil.example"><p>inside</p></iframe>',
      '<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/y">',
      '<video src="https://cdn.example/v.mp4" autoplay></video>',
      '<a href="https://monid.ai">link</a>',
      '<img src="https://cdn.example/logo.png" alt="remote">',
      '<svg><image href="https://cdn.example/i.png"/></svg>',
      "<script>const cmd = 'set up https://monid.ai/SKILL.md'; render();</script>",
      "</body></html>",
    ].join("\n");
    const { html: out, removed } = sanitizeHtml(html, allow);
    expect(out).not.toMatch(/cdn\.example|evil\.example|fonts\.googleapis|fonts\.gstatic/);
    expect(out).not.toMatch(/<iframe|<object|<embed|<video|<base|http-equiv|@import|<link/i);
    expect(out).not.toContain("inside");
    expect(out).toContain("<h1>set up https://monid.ai/SKILL.md</h1>");
    expect(out).toContain("const cmd = 'set up https://monid.ai/SKILL.md'; render();");
    expect(out).toMatch(/<a\s*>link<\/a>/);
    expect(out).toContain('url("")');
    expect(removed.length).toBeGreaterThanOrEqual(10);
  });

  it("keeps file:// references inside the kit and assets/fonts and drops everything else", () => {
    const inKit = fileUrl(join(KIT, "logo.svg"));
    const font = fileUrl(join(FONTS_DIR, "Poppins-ExtraBold.ttf"));
    const html = [
      `<style>@font-face{font-family:P;src:url("${font}")} .x{background:url(file:///etc/hosts)}</style>`,
      `<img src="${inKit}"><img src="file:///etc/passwd"><img src="${fileUrl(KIT)}/missing.png">`,
      `<img src="${fileUrl(KIT)}/../typing.html">`,
      `<script>var secret = "${fileUrl(resolve(".env.local"))}"; var ok = "${inKit}";</script>`,
      `<link rel="preload" href="${font}" as="font"><link rel="stylesheet" href="file:///etc/style.css">`,
    ].join("\n");
    const { html: out, removed } = sanitizeHtml(html, allow);
    expect(out).toContain(`src="${inKit}"`);
    expect(out).toContain(`url("${font}")`);
    expect(out).toContain(`var ok = "${inKit}"`);
    expect(out).toContain(`<link rel="preload" href="${font}" as="font">`);
    expect(out).not.toMatch(/\/etc\/|missing\.png|typing\.html|\.env\.local/);
    expect(out).toContain('var secret = "data:,"');
    expect(removed.some((r) => r.includes("/etc/passwd"))).toBe(true);
  });
});

describe("the writer's answer", () => {
  it("pulls the HTML and the keyframes out of fenced blocks", () => {
    const text = 'Here it is.\n```html\n<!doctype html><html><body><div id="a">x</div><script>render()</script></body></html>\n```\n```json\n{"states": [{"t": 0, "label": "empty"}, {"t": 1.2, "label": "typed"}]}\n```';
    const { html, states } = parseScreenReply(text);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toMatch(/<\/html>$/);
    expect(states).toEqual([
      { t: 0, label: "empty" },
      { t: 1.2, label: "typed" },
    ]);
  });

  it("reads an unfenced document followed by a bare array, and rejects a cut-off document", () => {
    const loose = parseScreenReply('<html><body><div style="color:#fff;background:#000">hello there friend, this is the screen</div></body></html>\nStates: [0, 0.5, {"t": 2}]');
    expect(loose.html).toContain("hello there friend");
    expect(loose.states).toEqual([0, 0.5, { t: 2 }]);
    const cut = parseScreenReply('```html\n<!doctype html><html><body><div class="term">set up https://monid.ai/SK');
    expect(cut.html).toBeNull();
    expect(parseScreenReply('```html\n<html><body><p>a long enough document body here</p></body></html>\n```\n```json\n{"keyframes": [0, 1]}\n```').states).toEqual([0, 1]);
  });

  it("puts the brand kit's file URLs, colours, commands and the reserved bands in the prompt", () => {
    const text = screenPrompt(request(), { product, kit });
    expect(text).toContain(fileUrl(join(KIT, "logo.svg")));
    expect(text).toContain("#1f3cff");
    expect(text).toContain("set up https://monid.ai/SKILL.md");
    expect(text).toContain("Poppins-ExtraBold.ttf");
    const again = screenPrompt(request(), { product, kit, previous: { html: "<html></html>", issues: ["the command is cut off"] } });
    expect(again).toContain("<problems>\n- the command is cut off");
    expect(safeAreas("full").noText.map((b) => [b.from, b.to])).toEqual([
      [0, 175],
      [1130, 1345],
      [1575, 1920],
    ]);
  });

  it("briefs a desktop screen as a real app on a filmed monitor, with no TikTok bands", () => {
    const desktop = request({ size: "desktop" });
    expect(safeAreas("desktop")).toMatchObject({ width: 1440, height: 900, rightRail: null });
    const system = writerSystem(desktop);
    expect(system).toContain("Exactly 1440x900 CSS pixels (a desktop monitor's display, filmed by a phone)");
    expect(system).toContain("Nothing under 36 px");
    expect(system).toMatch(/real screen on a real computer/);
    expect(system).not.toMatch(/TikTok's like\/comment\/share buttons|designed motion graphic/);
    expect(writerSystem(request())).toMatch(/TikTok's like\/comment\/share buttons/);
    expect(screenPrompt(desktop, { product, kit })).toContain('"width": 1440');
  });

  it("leaves the spoken line to the captions when the screen is captioned (organic videos)", () => {
    const captioned = writerSystem(request({ captioned: true }));
    expect(captioned).toContain("The edit captions the spoken line over this screen");
    expect(writerSystem(request())).not.toContain("The edit captions the spoken line over this screen");
  });
});

describe("keyframes", () => {
  it("clamps, snaps to the 30 fps grid, sorts, de-duplicates and starts at 0", () => {
    const states = parseStates([{ t: 1.21, label: "typed" }, 3, { time: 0.5 }, { t: 9, label: "late" }, { t: 1.2 }, "bad", null, { t: -1 }], 2);
    expect(states.map((s) => s.t)).toEqual([0, 0.5, 1.2, 2]);
    expect(states.find((s) => s.t === 1.2)?.label).toBe("typed");
    expect(parseStates([{ t: 0.4 }, { t: 1 }], 2)[0]).toEqual({ t: 0, label: "start" });
  });

  it("expands ranges for typing and counters, and thins long lists", () => {
    const states = parseStates([{ t: 0 }, { t: 0.5, to: 1, step: 0.1, label: "typing" }, { t: 2 }], 2);
    expect(states.map((s) => s.t)).toEqual([0, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 2]);
    expect(states[1].label).toBe("typing (1)");
    const many = parseStates([{ t: 0, to: 10, step: 0.05 }], 10);
    expect(many.length).toBeLessThanOrEqual(MAX_CAPTURES);
    expect(many[0].t).toBe(0);
    expect(many.at(-1)!.t).toBe(10);
  });

  it("falls back to five evenly spaced keyframes", () => {
    expect(parseStates(null, 4).map((s) => s.t)).toEqual([0, 1, 2, 3, 4]);
    expect(parseStates("nonsense", 2).length).toBe(5);
  });

  it("shows a final keyframe at the very end early enough to be seen, and checks settled moments", () => {
    expect(displayTimes([{ t: 0, label: "" }, { t: 1, label: "" }, { t: 4, label: "" }], 4)).toEqual([0, 1, 3.5]);
    expect(displayTimes([{ t: 0, label: "" }, { t: 3.8, label: "" }, { t: 4, label: "" }], 4)).toEqual([0, 3.8, 3.9]);
    const times = checkTimes(4, [
      { t: 0, label: "" },
      { t: 1, label: "" },
      { t: 2, label: "" },
      { t: 4, label: "" },
    ]);
    expect(times).toEqual([1.07, 2.07, 3.95]);
    expect(checkTimes(2)).toEqual([0.7, 1.4, 1.95]);
  });

  it("inspects the two longest holds and the end of a smooth render", () => {
    // Holds start at frames 0 (10 long), 10 (30 long), 40 (5 long) and 45 (to the end at 60).
    expect(holdTimes([0, 10, 40, 45], 60)).toEqual([0.1, 0.433, 1.967]);
    // Continuous motion has no hold worth a look: only the end.
    expect(holdTimes([0, 1, 2, 3], 4)).toEqual([0.1]);
  });

  it("crossfades keyframes that are far apart and cuts between close ones", () => {
    const args = assembleArgs({ pngs: ["a.png", "b.png", "c.png", "d.png"], starts: [0, 1, 1.1, 1.6], width: 1080, height: 1920, scale: 1, seconds: 2, pushIn: 0.025, out: "o.mp4" });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph.match(/fade=t=in/g)?.length).toBe(1);
    expect(graph).toContain("perspective=");
    expect(args).toContain("-an");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("60");
  });
});

describe("prepareHtml", () => {
  it("puts the runtime first in <head> and fixes the stage size", () => {
    const page = prepareHtml("<html><head><title>x</title></head><body><p>hi</p></body></html>", { seconds: 3, size: "half" });
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page.indexOf("data-nomen-runtime")).toBeLessThan(page.indexOf("<title>"));
    expect(page).toContain("height:960px!important");
    expect(page).toContain("window.DURATION=D");
    // Re-preparing replaces the runtime instead of stacking a second copy.
    expect(prepareHtml(page, { seconds: 3, size: "half" }).match(/<script data-nomen-runtime>/g)?.length).toBe(1);
    expect(prepareHtml("<div>fragment</div>", { seconds: 1, size: "full" })).toMatch(/<html><head>.*<\/head><body><div>fragment<\/div><\/body><\/html>$/s);
  });
});

describe("findChrome", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomen-chrome-find-"));
    await writeFile(join(dir, "chromium"), "#!/bin/sh\n", "utf8");
    await chmod(join(dir, "chromium"), 0o755);
    await writeFile(join(dir, "my-chrome"), "#!/bin/sh\n", "utf8");
    await chmod(join(dir, "my-chrome"), 0o755);
    await writeFile(join(dir, "not-executable"), "", "utf8");
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("prefers CHROME_PATH, then app bundles, then chromium on PATH, else null", () => {
    expect(findChrome({ env: { CHROME_PATH: join(dir, "my-chrome"), PATH: dir }, appPaths: [] })).toBe(join(dir, "my-chrome"));
    expect(findChrome({ env: { CHROME_PATH: join(dir, "not-executable"), PATH: dir }, appPaths: [] })).toBe(join(dir, "chromium"));
    expect(findChrome({ env: { PATH: "/nonexistent" }, appPaths: [join(dir, "my-chrome")] })).toBe(join(dir, "my-chrome"));
    expect(findChrome({ env: { PATH: "/nonexistent" }, appPaths: [join(dir, "not-executable")] })).toBeNull();
  });
});

/** Mean absolute difference of two equally sized grey frames. */
const meanDiff = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

async function grey(video: string, at: number): Promise<Buffer> {
  const { stdout } = await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", video, "-frames:v", "1", "-vf", "scale=270:-2,format=gray", "-f", "rawvideo", "pipe:1"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout as unknown as Buffer;
}

async function pixel(path: string, x: number, y: number): Promise<number[]> {
  const { stdout } = await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
  return [...(stdout as unknown as Buffer)];
}

describe.skipIf(!canRender)("renderScreen (headless Chrome)", () => {
  let work = "";
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "nomen-screens-test-"));
  });
  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("renders a ?t= typing page into an exact 1080x1920 clip whose frames change", async () => {
    const clip = await renderScreen(await typingHtml(), [{ t: 0, label: "empty" }, { t: 1.3, label: "typed" }, { t: 2, label: "connected" }], request(), { workDir: work, allow: [KIT, FONTS_DIR] });
    expect(clip.kind).toBe("video");
    expect(clip.path).toBe(join(work, "crv_x-b3.mp4"));
    const info = await probe(clip.path);
    expect([info.width, info.height]).toEqual([1080, 1920]);
    expect(info.duration).toBeCloseTo(2, 1);
    expect(info.hasAudio).toBe(false);
    expect(clip.captures).toBeGreaterThan(20); // the typing and the arrival were captured frame by frame
    expect(clip.inspect.at(-1)).toBeCloseTo(1.967, 2); // the final, settled frame is always inspected
    const early = await grey(clip.path, 0.25);
    const late = await grey(clip.path, 1.9);
    expect(meanDiff(early, late)).toBeGreaterThan(2);
    expect(await readFile(clip.html_path, "utf8")).toContain("data-nomen-runtime");
  }, 120_000);

  it("renders keyframes mode at 1080x960 for a split layout", async () => {
    const clip = await renderScreen(await typingHtml(), [{ t: 0 }, { t: 0.6 }, { t: 1.6 }] as never, request({ id: "half one", size: "half", seconds: 1.5 }), {
      workDir: work,
      allow: [KIT, FONTS_DIR],
      motion: "keyframes",
    });
    expect(clip.kind).toBe("video");
    expect(clip.path).toBe(join(work, "half_one.mp4"));
    expect(clip.captures).toBe(3);
    const info = await probe(clip.path);
    expect([info.width, info.height]).toEqual([1080, 960]);
    expect(info.duration).toBeCloseTo(1.5, 1);
  }, 120_000);

  it("renders a desktop screen at 1440x900 that holds still where nothing changes (no push-in)", async () => {
    const clip = await renderScreen(await typingHtml(), [{ t: 0, label: "empty" }, { t: 1.3, label: "typed" }, { t: 2, label: "connected" }], request({ id: "desk", size: "desktop" }), { workDir: work, allow: [KIT, FONTS_DIR] });
    const info = await probe(clip.path);
    expect([info.width, info.height]).toEqual([1440, 900]);
    // The logo never changes: with no push-in it is the same pixels early and late.
    const logo = async (at: number) => {
      const { stdout } = await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", clip.path, "-frames:v", "1", "-vf", "crop=96:96:64:220,format=gray", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
      return stdout as unknown as Buffer;
    };
    expect(meanDiff(await logo(0.2), await logo(1.9))).toBeLessThan(1);
    expect(meanDiff(await grey(clip.path, 0.25), await grey(clip.path, 1.9))).toBeGreaterThan(1); // the typing still shows
  }, 120_000);

  it("returns a still when nothing moves, and nothing outside the allowed roots reaches the page", async () => {
    const outside = await mkdtemp(join(tmpdir(), "nomen-outside-"));
    try {
      await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", join(outside, "red.png")]);
      const html = [
        '<html><head><style>body{background:#123456} #slot{position:absolute;left:100px;top:600px;width:400px;height:400px}</style></head><body>',
        '<img id="slot">',
        "<script>",
        // Built at runtime so the sanitizer cannot see it: the server must refuse it.
        `var s = document.getElementById('slot'); s.src = '/f' + '${join(outside, "red.png")}';`,
        "fetch('http://example.com/').catch(function(){});",
        "location.href = 'file:///etc/hosts';",
        "</script></body></html>",
      ].join("");
      const clip = await renderScreen(html, [{ t: 0, label: "a" }, { t: 1, label: "b" }], request({ id: "still", seconds: 1 }), { workDir: work, allow: [KIT, FONTS_DIR] });
      expect(clip.kind).toBe("image");
      expect(clip.path.endsWith("still.png")).toBe(true);
      const info = await probe(clip.path);
      expect([info.width, info.height]).toEqual([1080, 1920]);
      // Still our page (not /etc/hosts), and the red image never loaded.
      expect(await pixel(clip.path, 40, 40)).toEqual([0x12, 0x34, 0x56]);
      const [r, g] = await pixel(clip.path, 300, 800);
      expect(r > 200 && g < 60).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!canRender)("buildScreens", () => {
  let work = "";
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "nomen-build-test-"));
    await mkdir(work, { recursive: true });
  });
  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("writes, renders and checks each screen, rewrites once after a failed check, and keeps going when one screen fails", async () => {
    const html = await typingHtml();
    const calls: Array<{ kind: "write" | "check"; id: string; text: string }> = [];
    let checks = 0;
    const naive = {
      message: async (input: { system?: string; messages: Array<{ content: unknown }>; tools?: Array<{ name: string }> }) => {
        const text = JSON.stringify(input.messages);
        const id = text.includes("bad-one") ? "bad-one" : "good-one";
        if (input.tools?.some((t) => t.name === "screen_verdict")) {
          calls.push({ kind: "check", id, text });
          checks++;
          const verdict = checks === 1 ? { score: 4, pass: false, issues: ["the command is cut off at the right edge"] } : { score: 8, pass: true, issues: [] };
          return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "screen_verdict", input: verdict }] };
        }
        calls.push({ kind: "write", id, text });
        if (id === "bad-one") return { stop_reason: "end_turn", content: [{ type: "text", text: "Sorry, I can't draw that." }] };
        return { stop_reason: "end_turn", content: [{ type: "text", text: `\`\`\`html\n${html}\n\`\`\`\n\`\`\`json\n{"states": [{"t": 0, "label": "empty"}, {"t": 1.3, "label": "typed"}, {"t": 1.6, "label": "connected"}]}\n\`\`\`` }] };
      },
    };
    const result = await buildScreens(naive as never, [request({ id: "good-one" }), request({ id: "bad-one" })], { product, kit }, { workDir: work, concurrency: 2 });

    expect(result.clips.map((c) => c.id)).toEqual(["good-one"]);
    expect(result.clips[0].path).toBe(join(work, "good-one.v2.mp4"));
    expect(result.failures).toEqual([{ id: "bad-one", error: expect.stringContaining("no HTML document") }]);
    const good = calls.filter((c) => c.id === "good-one");
    expect(good.map((c) => c.kind)).toEqual(["write", "check", "write", "check"]);
    expect(good[2].text).toContain("the command is cut off at the right edge");
    expect(calls.filter((c) => c.id === "bad-one").map((c) => c.kind)).toEqual(["write", "write"]);
    expect(result.reports.find((r) => r.id === "good-one")).toMatchObject({ attempts: 2, check: { pass: true, score: 8 } });
  }, 180_000);

});

describe("buildScreens without Chrome", () => {
  it("fails every screen up front, without model calls, when there is no Chrome", async () => {
    let called = 0;
    const naive = { message: async () => (called++, { stop_reason: "end_turn", content: [] }) };
    const result = await buildScreens(naive as never, [request()], { product, kit: null }, { workDir: join(tmpdir(), "nomen-no-chrome"), render: { chromePath: "/nonexistent/chrome" } });
    expect(called).toBe(0);
    expect(result.clips).toEqual([]);
    expect(result.failures[0].error).toMatch(/No Chrome or Chromium found/);
  });
});
