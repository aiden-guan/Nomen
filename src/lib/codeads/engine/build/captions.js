// Build-genre text overlay (docs/BUILD.md): ONE spoken word at a time dead center + callouts, like @wemakebuild.
// Driven by story.json from tools/narrate.py: words [{w,t0,t1}], callouts [{text, style, t0, t1, pos?}].
// Styles: term (yellow caps, the engineering word), label (orange caps, a number/fact), money (green), stamp (red, tilted,
// slams in), sfx (small yellow comic word at pos [x,y] in frame fractions). Pops are part of this genre's look (the house
// "no popping text" rule is exempt here) — but each element pops ONCE on entry and never pulses after.

const CSS = `
@font-face { font-family: 'Fredoka'; font-weight: 600; src: url(/engine/fonts/fredoka-latin-600-normal.woff2) format('woff2'); }
@font-face { font-family: 'Fredoka'; font-weight: 700; src: url(/engine/fonts/fredoka-latin-700-normal.woff2) format('woff2'); }
@font-face { font-family: 'Luckiest Guy'; font-weight: 400; src: url(/engine/fonts/luckiest-guy-latin-400-normal.woff2) format('woff2'); }
.bw { position: absolute; left: 0; right: 0; top: 1000px; text-align: center; transform-origin: 50% 50%;
  font-family: 'Fredoka'; font-weight: 700; font-size: 80px; line-height: 1; color: #fff; white-space: nowrap;
  -webkit-text-stroke: 11px #161616; paint-order: stroke fill; text-shadow: 0 7px 0 rgba(0,0,0,.38), 0 0 26px rgba(0,0,0,.25); }
.bc { position: absolute; left: 0; right: 0; text-align: center; white-space: nowrap; transform-origin: 50% 50%; opacity: 0;
  font-family: 'Luckiest Guy'; font-weight: 400; line-height: 1; letter-spacing: .02em; paint-order: stroke fill; }
.bc.term  { top: 390px; font-size: 92px; color: #ffd43b; -webkit-text-stroke: 13px #2b1a05; text-shadow: 0 8px 0 rgba(0,0,0,.4), 0 0 26px rgba(0,0,0,.55); }
/* bands (024 v5): term 20 %, label 14 %, money 17 % of frame height — above the faces (28–45 %) and the word (52 %).
   label/money: bigger + a wider dark halo — v2's orange "50 FEET A DAY" vanished on the orange TBM, the green money line was thin */
.bc.label { top: 262px; font-size: 84px; color: #ffc45c; -webkit-text-stroke: 13px #120a04; text-shadow: 0 7px 0 rgba(0,0,0,.55), 0 0 28px rgba(0,0,0,.9), 0 0 64px rgba(0,0,0,.6); }   /* Nomen: a darker outline and halo, the label sits over a wooden desk in code ads */
.bc.money { top: 318px; font-size: 104px; color: #7cf05f; -webkit-text-stroke: 14px #0d2a0a; text-shadow: 0 8px 0 rgba(0,0,0,.45), 0 0 30px rgba(0,0,0,.75), 0 0 64px rgba(0,0,0,.45); }
.bc.stamp { top: 560px; font-size: 100px; color: #ff3b30; -webkit-text-stroke: 13px #2a0606; text-shadow: 0 8px 0 rgba(0,0,0,.45), 0 0 26px rgba(0,0,0,.55); }
.bc.sfx   { font-size: 66px; color: #ffe14d; -webkit-text-stroke: 10px #2b1a05; text-shadow: 0 6px 0 rgba(0,0,0,.4), 0 0 22px rgba(0,0,0,.55); left: auto; right: auto; }
`;

export const BUILD_FONTS = ['700 80px Fredoka', '600 40px Fredoka', '400 92px "Luckiest Guy"'];

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const easeOutBack = (u) => { const c = 1.9; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); };

export function createBuildOverlay(story) {
  const ui = document.getElementById('ui');
  for (const id of ['title', 'hud', 'sub', 'end']) { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  const word = document.createElement('div'); word.className = 'bw'; ui.appendChild(word);
  const callouts = (story.callouts || []).map((c) => {
    const el = document.createElement('div'); el.className = 'bc ' + c.style; el.textContent = c.text; ui.appendChild(el);
    if (c.style === 'sfx') { const [x, y] = c.pos || [0.5, 0.4]; el.style.left = `${x * 1080}px`; el.style.top = `${y * 1920}px`; el.style.transform = 'translate(-50%,-50%)'; }
    else if (c.x != null) { el.style.left = `${c.x * 1080}px`; el.style.right = 'auto'; el.style.top = `${(c.y ?? 0.5) * 1920}px`; } // placed at [x, y] (centred there)
    else if (c.y != null) el.style.top = `${c.y * 1920}px`; // per-callout height (frame fraction) when the style's band covers the subject
    return { c, el, fit: 1 };
  });
  const words = story.words || [];
  let wi = 0, shown = null, fitted = false;

  function measureText(o) { // width of the text itself (block is full-width)
    const r = document.createRange(); r.selectNodeContents(o.el); return r.getBoundingClientRect().width;
  }

  function update(t) {
    if (!fitted && document.fonts.status === 'loaded') { for (const o of callouts) { o.el.style.opacity = 1; o.el.style.transform = "none"; o.fit = Math.min(1, 960 / Math.max(1, measureText(o))); o.el.style.opacity = 0; } fitted = true; }
    // the spoken word
    while (wi > 0 && words[wi] && t < words[wi].t0) wi--;
    while (wi < words.length - 1 && t >= words[wi + 1].t0) wi++;
    const w = words[wi];
    if (w && t >= w.t0 && t < w.t1) {
      if (shown !== wi) { word.textContent = w.w; shown = wi; }
      const u = clamp((t - w.t0) / 0.075);
      word.style.opacity = 1; word.style.transform = `translateY(-50%) scale(${0.86 + 0.14 * easeOutBack(u)})`;
    } else word.style.opacity = 0;
    // callouts: pop in once, hold steady, quick fade out
    for (const o of callouts) {
      const { c, el } = o;
      if (t < c.t0 || t > c.t1) { el.style.opacity = 0; continue; }
      const a = t - c.t0, out = clamp((c.t1 - t) / 0.12);
      let s, rot = 0;
      if (c.style === 'stamp') { const u = clamp(a / 0.14); s = 2.1 - 1.1 * u * u + (u >= 1 ? 0.06 * Math.exp(-(a - 0.14) * 30) * Math.sin((a - 0.14) * 60) : 0); rot = -8; }
      else if (c.style === 'sfx') { s = easeOutBack(clamp(a / 0.16)); rot = -7; }
      else s = easeOutBack(clamp(a / 0.2));
      el.style.opacity = out * clamp(a / 0.05);
      const base = c.style === 'sfx' || c.x != null ? 'translate(-50%,-50%) ' : 'translateY(-50%) ';
      el.style.transform = `${base}rotate(${rot}deg) scale(${Math.max(0.01, s * o.fit)})`;
    }
  }
  return { update };
}
