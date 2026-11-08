// The wall screen's pictures (Nomen code ads): what the computer shows, drawn on a 1280×720 canvas as a pure function of
// the beat's screen and how far the narration has got (u 0..1), so any frame renders on its own. The screen fills about
// two thirds of a vertical frame's width at most, so everything is big: few lines, few words.
//   terminal  lines typed at a prompt ("> " lines are the machine's answers)
//   chat      lines[0] is your message, the rest are the agent's replies, appearing one by one
//   image     a real product visual (a phone-size capture fills the width and scrolls), with the logo
//   logo      the brand card: logo, name, url
//   error     a red failure card (an explosion, a zap)
//   dashboard a list of agents (lines) working, with status dots and progress bars
import { drawContain } from './sets/devoffice.js';

const W = 1280, H = 720;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export function drawScreen(g, s, u, t, brand, assets) {
  const C = brand.colors, bg = C.screenBg, fg = C.screenFg, accent = C.accent;
  const sans = brand.fontFamily ? `"${brand.fontFamily}", Helvetica, Arial, sans-serif` : 'Helvetica, Arial, sans-serif';
  const mono = 'Menlo, "SF Mono", Monaco, Consolas, monospace';
  g.save(); g.clearRect(0, 0, W, H);
  const kind = s.kind || 'logo', lines = (s.lines || []).filter(Boolean);
  if (kind === 'error') {
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#d32f2f'); gr.addColorStop(1, '#7f1010'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(W / 2, 60); g.lineTo(W / 2 + 120, 270); g.lineTo(W / 2 - 120, 270); g.closePath(); g.fill();
    g.fillStyle = '#c62828'; g.font = `900 150px ${sans}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', W / 2, 200);
    g.fillStyle = '#fff'; g.font = `900 120px ${sans}`; g.fillText(fit(g, (lines[0] || 'ERROR').toUpperCase(), W - 80), W / 2, 400);
    g.font = `600 62px ${mono}`; let y = 520; for (const l of lines.slice(1, 3)) { g.fillText(fit(g, l.replace(/^>\s?/, ''), W - 80), W / 2, y); y += 84; }
    g.fillStyle = 'rgba(255,255,255,.08)'; for (let y2 = (t * 240) % 24; y2 < H; y2 += 24) g.fillRect(0, y2, W, 3);   // scan lines: a dead screen still moves
  } else {
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    if (kind === 'terminal' || kind === 'chat' || kind === 'dashboard') windowChrome(g, s.title || (kind === 'terminal' ? 'terminal' : brand.name), sans, fg, assets.logo);
    if (kind === 'terminal') terminal(g, lines, u, t, mono, fg, accent);
    else if (kind === 'chat') chat(g, lines, u, sans, fg, accent);
    else if (kind === 'dashboard') dashboard(g, lines, u, sans, fg, accent);
    else if (kind === 'image' && assets.image) image(g, assets.image, assets.logo, u);
    else logoCard(g, brand, assets.logo, sans, fg, accent, u);
  }
  g.restore();
}

function windowChrome(g, title, sans, fg, logo) {
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, 0, W, 84);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { g.fillStyle = c; g.beginPath(); g.arc(46 + i * 44, 42, 14, 0, 7); g.fill(); });
  g.font = `700 40px ${sans}`; g.textAlign = 'left'; g.textBaseline = 'middle';
  const tw = g.measureText(String(title).slice(0, 26)).width + (logo ? 60 : 0), x0 = W / 2 - tw / 2;
  if (logo) drawContain(g, logo, x0, 18, 48, 48);
  g.fillStyle = fg; g.globalAlpha = 0.85; g.fillText(String(title).slice(0, 26), x0 + (logo ? 60 : 0), 43); g.globalAlpha = 1;
}

function terminal(g, lines, u, t, mono, fg, accent) {
  const rows = lines.slice(0, 5), total = rows.reduce((n, l) => n + l.replace(/^>\s?/, '').replace(/^\$\s*/, '').length, 0) || 1;
  let left = Math.floor(clamp(u) * total * 1.02), y = 170, cx = 70, cy = y;
  g.font = `600 64px ${mono}`; g.textAlign = 'left'; g.textBaseline = 'middle';
  for (const l of rows) {
    // the screen draws its own "$" prompt: a command written with one keeps a single prompt
    const out = l.startsWith('>'), text = out ? l.replace(/^>\s?/, '') : l.replace(/^\$\s*/, ''), shown = text.slice(0, Math.max(0, left));
    if (left <= 0 && shown === '') break;
    left -= text.length;
    if (!out) { g.fillStyle = accent; g.fillText('$', 60, y); }
    const x0 = out ? 60 : 120, str = fit(g, shown, W - x0 - 60);
    g.fillStyle = out ? fg : '#ffffff'; g.globalAlpha = out ? 0.8 : 1; g.fillText(str, x0, y); g.globalAlpha = 1;
    cx = x0 + g.measureText(str).width + 8; cy = y; y += 104;
    if (left <= 0) break;
  }
  if (Math.floor(t * 2) % 2 === 0) { g.fillStyle = accent; g.fillRect(cx, cy - 34, 34, 68); }
}

function chat(g, lines, u, sans, fg, accent) {
  const shown = lines.length ? Math.max(1, Math.ceil(clamp(u * 1.15) * lines.length)) : 0;
  let y = 120;
  lines.slice(0, Math.min(shown, 3)).forEach((l, i) => {
    const mine = i === 0;
    g.font = `600 58px ${sans}`;
    const maxW = W * 0.78, words = l.split(/\s+/), rows = []; let row = '';
    for (const w of words) { const tt = row ? row + ' ' + w : w; if (g.measureText(tt).width > maxW - 80 && row) { rows.push(row); row = w; } else row = tt; }
    if (row) rows.push(row);
    const bw = Math.min(maxW, Math.max(...rows.map((r) => g.measureText(r).width)) + 80), bh = rows.length * 72 + 44;
    const x = mine ? W - 50 - bw : 50;
    g.fillStyle = mine ? accent : 'rgba(255,255,255,.14)'; g.beginPath(); g.roundRect(x, y, bw, bh, 40); g.fill();
    g.fillStyle = mine ? inkOn(accent) : fg; g.textAlign = 'left'; g.textBaseline = 'top';
    rows.forEach((r, k) => g.fillText(r, x + 40, y + 24 + k * 72));
    y += bh + 30;
  });
}

function dashboard(g, lines, u, sans, fg, accent) {
  const rows = (lines.length ? lines : ['agent']).slice(0, 4);
  g.textBaseline = 'middle';
  rows.forEach((l, i) => {
    const y = 170 + i * 140, k = clamp(u * 1.3 - i * 0.12);
    g.fillStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.roundRect(40, y - 56, W - 80, 112, 24); g.fill();
    g.fillStyle = k > 0.98 ? '#3fb950' : accent; g.beginPath(); g.arc(98, y, 20, 0, 7); g.fill();
    g.fillStyle = fg; g.font = `700 60px ${sans}`; g.textAlign = 'left'; g.fillText(fit(g, l, 640), 146, y);
    g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(830, y - 14, 360, 28); g.fillStyle = k > 0.98 ? '#3fb950' : accent; g.fillRect(830, y - 14, 360 * k, 28);
  });
}

function image(g, img, logo, u) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (ih > iw * 1.2) {
    // a phone-size capture: its top at the screen's full width (big enough to read in a phone frame), scrolling slowly
    const s = W / iw, view = H / s, travel = Math.min(ih - view, view * 0.6) * clamp(u);
    g.drawImage(img, 0, travel, iw, view, 0, 0, W, H);
    if (logo) { g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.roundRect(W - 150, H - 150, 120, 120, 24); g.fill(); drawContain(g, logo, W - 140, H - 140, 100, 100); }
    return;
  }
  g.save(); g.beginPath(); g.roundRect(30, 30, W - 60, H - 60, 24); g.clip(); drawContain(g, img, 30, 30, W - 60, H - 60); g.restore();
}

function logoCard(g, brand, logo, sans, fg, accent, u) {
  // everything in the top three quarters: Gary's hard hat covers the screen's bottom edge
  const k = clamp(u * 3);
  if (logo) drawContain(g, logo, W / 2 - 150, 24 - (1 - k) * 20, 300, 300);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `800 124px ${sans}`;
  g.fillText(fit(g, brand.name, W - 80), W / 2, logo ? 392 : 240);
  if (brand.url) { g.fillStyle = accent; g.font = `700 80px ${sans}`; g.fillText(fit(g, brand.url, W - 80), W / 2, logo ? 506 : 360); }
}

function fit(g, s, maxW) { if (g.measureText(s).width <= maxW) return s; let a = s; while (a.length > 1 && g.measureText(a + '…').width > maxW) a = a.slice(0, -1); return a + '…'; }
function inkOn(hex) { const n = parseInt(String(hex).replace('#', ''), 16), r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255; return 0.2126 * r + 0.7152 * gg + 0.0722 * b > 140 ? '#111' : '#fff'; }
