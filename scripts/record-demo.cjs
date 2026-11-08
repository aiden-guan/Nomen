// Records the demo walk-through to an MP4, for a voice-over and face cam to go on top.
//
//   npm run build && npm start                      (in one terminal: a production build on :3000)
//   node scripts/record-demo.cjs demo.mp4           (in another; SITE=monid.ai for the other demo)
//
// It opens /demo?record=1 (the tour on autoplay, no buttons on screen), types the website, and
// records until the tour's last step has had its time: about 1:43. Chrome's screencast frames are
// placed by their own timestamps on a constant 30 fps timeline and piped into ffmpeg (H.264,
// 1920 x 1080). Needs Playwright with Chromium (npx playwright install chromium).
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const FFMPEG = require("ffmpeg-static");
const out = process.argv[2] || "demo.mp4";
const site = process.env.SITE || "naive.ai";
const FPS = 30;
const W = 1440, H = 810, SCALE = 4 / 3; // 1920 x 1080 frames

(async () => {
  const browser = await chromium.launch({ args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"] });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${process.env.BASE_URL || "http://localhost:3000"}/demo?record=1`);
  const input = page.locator("input").first();
  await input.waitFor({ timeout: 120000 });
  await page.waitForTimeout(2500); // fonts, the horse baked

  const ff = spawn(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-vf", "scale=1920:1080:flags=lanczos", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  let t0 = null, firstWall = null, written = 0, last = null, frames = 0;
  const write = (buf) => new Promise((resolve) => (ff.stdin.write(buf) ? resolve() : ff.stdin.once("drain", resolve)));
  let queue = Promise.resolve();
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    const buf = Buffer.from(data, "base64");
    const ts = metadata.timestamp;
    frames++;
    if (firstWall === null) firstWall = Date.now();
    queue = queue.then(async () => {
      if (t0 === null) t0 = ts;
      const due = Math.round((ts - t0) * FPS);
      // Hold the previous frame until this one's time comes.
      while (last && written < due) { await write(last); written++; }
      last = buf;
    });
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const start = Date.now();
  await page.waitForTimeout(700);
  await input.click();
  await input.pressSequentially(site, { delay: 95 });
  await page.waitForTimeout(450);
  await input.press("Enter");
  const entered = Date.now();
  // Until the tour's last step has had its time (and a beat more).
  let lastSeen = null;
  for (;;) {
    await page.waitForTimeout(250);
    const n = await page.locator('section[aria-label="Tour"] span').first().textContent({ timeout: 100 }).catch(() => null);
    if (n && n !== lastSeen) { lastSeen = n; console.log(((Date.now() - start) / 1000).toFixed(1), n, await page.locator('section[aria-label="Tour"] h2').textContent().catch(() => "")); }
    if (n && n.split("/")[0] === n.split("/")[1]) { await page.waitForTimeout(8100); break; }
    if (Date.now() - start > 200000) { console.log("timeout"); break; }
  }
  const stopAt = Date.now();
  await cdp.send("Page.stopScreencast");
  await queue;
  // The tail: hold the last frame until the moment the recording stopped.
  const total = Math.round(((stopAt - firstWall) / 1000) * FPS);
  while (last && written < total) { await write(last); written++; }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log(`frames from Chrome: ${frames}, written: ${written} (${(written / FPS).toFixed(1)} s), Enter at ${((entered - start) / 1000).toFixed(1)} s`);
  console.log(errors.slice(0, 5).join("\n"));
  await browser.close();
})();
