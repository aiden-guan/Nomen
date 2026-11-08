// Boots one code ad (adapted from ED Studio's engine/main.js, build mode only).
// /ad/story.json holds the narration's word times, the callouts and the ad's beats (src/lib/codeads/layout.ts);
// engine/codead.js builds the scene from it. Exposes window.renderAt(t), window.renderAtBlur(t, n, shutter, fps),
// window.CODEAD_READY / window.CODEAD_ERROR and window.CODEAD_QC() for src/lib/codeads/render.ts.
import { createStudio } from '@engine/core.js';
import { createBuildOverlay, BUILD_FONTS } from '@engine/build/captions.js';
import { build } from '@engine/codead.js';

try {
  const story = await (await fetch('/ad/story.json')).json();
  const studio = createStudio(document.getElementById('gl'), story.look || {});
  const overlay = createBuildOverlay(story);
  await Promise.all(BUILD_FONTS.map((f) => document.fonts.load(f)));
  const video = await build(studio, story);
  await document.fonts.ready;
  window.STORY = story;

  window.renderAt = (t) => { accum.style.display = 'none'; video.update(t); overlay.update(t); studio.render(t); };
  // Motion blur (the build genre renders 60 fps + 2 sub-frames): sub-frames spread over the shutter are averaged on a 2-D
  // canvas laid over the WebGL one; the text overlay is drawn once at the frame's own time, so captions stay crisp.
  const gl = document.getElementById('gl');
  const accum = document.createElement('canvas'); accum.width = gl.width; accum.height = gl.height;
  Object.assign(accum.style, { position: 'absolute', left: '0', top: '0', width: '1080px', height: '1920px', display: 'none' });
  gl.after(accum); const actx = accum.getContext('2d');
  window.renderAtBlur = (t, n = 2, shutter = 0.5, fps = 30) => {
    if (n <= 1) return window.renderAt(t);
    for (let k = 0; k < n; k++) {
      const tk = Math.max(0, t + ((k + 0.5) / n - 0.5) * shutter / fps);
      video.update(tk); studio.render(tk);
      actx.globalAlpha = 1 / (k + 1); actx.drawImage(gl, 0, 0);   // running mean of the sub-frames
    }
    actx.globalAlpha = 1; accum.style.display = 'block';
    video.update(t); overlay.update(t);
  };
  window.CODEAD_QC = () => (video.qc ? video.qc() : []);
  window.renderAt(0);
  window.CODEAD_READY = true;
} catch (err) {
  console.error(err);
  window.CODEAD_ERROR = String((err && err.stack) || err);
}
