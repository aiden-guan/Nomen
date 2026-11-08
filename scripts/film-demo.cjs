// Films the demo walk-through frame by frame, for the edited demo video (video/, Remotion).
//
//   npm run build && npm start                         (a production build on :3000)
//   node scripts/film-demo.cjs out/plate.mp4           (SITE=monid.ai for the other demo)
//
// Nothing here runs in real time, so nothing stutters: the page's clock is Playwright's fake one,
// advanced exactly 1/30 s per frame. The scene (requestAnimationFrame), the replay clock and the
// tour's timers follow it; every CSS animation and the playing video are set to it before each
// screenshot. The page is /demo?record=1: the tour on autoplay drives the camera, and its card,
// the dispatches and the replay controls stay off screen (the captions go on in the edit).
//
// Writes the plate (1920 x 1080, 30 fps, no audio) and, beside it, <plate>.json: the frame each
// tour step starts on and each demo video that played (its file and first frame), so the edit can
// place the captions and the videos' sound.
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const { writeFileSync } = require("fs");
const FFMPEG = require("ffmpeg-static");

const out = process.argv[2] || "plate.mp4";
const site = process.env.SITE || "naive.ai";
const base = process.env.BASE_URL || "http://localhost:3000";
const FPS = 30;
const W = 1440, H = 810, SCALE = 4 / 3; // 1920 x 1080 frames
// After the last step opens: its time on screen (tour.ts) and a beat.
const TAIL_SECONDS = Number(process.env.TAIL || 8.2);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const errors = [];
  let frame = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  // FILM_LOG=text: print the page's console lines that contain it, with the frame they came on.
  if (process.env.FILM_LOG) page.on("console", (m) => m.text().includes(process.env.FILM_LOG) && console.log(`frame ${frame}: ${m.text()}`));
  await page.clock.install({ time: Date.now() });
  await page.goto(`${base}/demo?record=1`);
  const input = page.locator("input").first();
  await input.waitFor({ timeout: 120000 });
  // The horse baked and grown in, then time stops: from here it moves only a frame at a time.
  await page.waitForTimeout(2500);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 50);

  const cdp = await context.newCDPSession(page);
  const ff = spawn(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const write = (buf) => new Promise((resolve) => (ff.stdin.write(buf) ? resolve() : ff.stdin.once("drain", resolve)));

  const log = { fps: FPS, site, steps: [], videos: [] };
  let step = null;
  /** One frame: the clock on by 1/30 s, animations and videos to it, a screenshot. */
  async function shoot() {
    const ms = Math.round(((frame + 1) * 1000) / FPS) - Math.round((frame * 1000) / FPS);
    await page.clock.runFor(ms);
    const info = await page.evaluate(async () => {
      const now = performance.now();
      // CSS animations and transitions: paused, and set to the page's clock.
      for (const a of document.getAnimations()) {
        if (a.__start === undefined) a.__start = now - (a.currentTime ?? 0);
        a.pause();
        a.currentTime = Math.max(0, now - a.__start);
      }
      // Videos: paused, muted, and seeked to the page's clock since they appeared (or changed).
      const videos = [];
      for (const v of document.querySelectorAll("video")) {
        const src = v.currentSrc || v.src;
        if (!src) continue;
        if (v.dataset.filmSrc !== src) {
          v.dataset.filmSrc = src;
          v.dataset.filmStart = String(now);
          videos.push(src);
        }
        v.muted = true;
        if (!v.paused) v.pause();
        const t = (now - Number(v.dataset.filmStart)) / 1000;
        const target = Number.isFinite(v.duration) && v.duration > 0 ? Math.min(t, v.duration - 0.05) : t;
        if (Math.abs(v.currentTime - target) > 0.001) {
          await new Promise((resolve) => {
            const done = () => resolve();
            v.addEventListener("seeked", done, { once: true });
            setTimeout(done, 400);
            v.currentTime = target;
          }).catch(() => {});
        }
      }
      return { step: document.documentElement.dataset.tourStep || null, videos };
    });
    if (info.step && info.step !== step) {
      step = info.step;
      log.steps.push({ key: step, frame });
      console.log(`${(frame / FPS).toFixed(2)}s  ${step}`);
    }
    for (const src of info.videos) log.videos.push({ src: new URL(src).pathname, frame });
    const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 95, optimizeForSpeed: false });
    await write(Buffer.from(data, "base64"));
    frame++;
  }
  const hold = async (seconds) => {
    for (let i = 0; i < Math.round(seconds * FPS); i++) await shoot();
  };

  // The landing: a beat on the horse, the website typed, the gates opened.
  await hold(1.2);
  await input.click();
  for (const ch of site) {
    await input.type(ch);
    await hold(0.09);
  }
  await hold(0.45);
  log.enter = frame;
  await input.press("Enter");
  // Until the tour's last step has had its time.
  let lastAt = null;
  while (frame < FPS * 240) {
    await shoot();
    if (step === "loop" && lastAt === null) lastAt = frame;
    if (lastAt !== null && frame - lastAt >= TAIL_SECONDS * FPS) break;
  }
  log.frames = frame;
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  writeFileSync(out.replace(/\.mp4$/, "") + ".json", JSON.stringify(log, null, 2));
  console.log(`${frame} frames (${(frame / FPS).toFixed(1)} s) -> ${out}`);
  if (errors.length) console.log("page errors:\n" + errors.slice(0, 5).join("\n"));
  await browser.close();
})();
