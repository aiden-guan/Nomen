import { solid } from "../materials";
import { R } from "../palette";
import { type HitInfo, type Model, mul, rotZ, type ShadeOut, translate } from "../tracer";
import { gableClips, pyramidClips } from "./props";

// The lands the scouts ride out to: one landmark for each website or API the research uses,
// dressed in that platform's colours (never its logo). Each builder draws around its own origin
// on the ground, in world units, like the camp's furniture; a soldier is about 20 tall.

const frac = (v: number) => v - Math.floor(v);

/** Facing the camera: the viewer looks from +x+y, so a face built toward +x is turned by 45°. */
const FACING = rotZ(Math.PI / 4);

/** Planes that cut a box (half sizes hx, _, hz) into a gable with its ridge along y. */
function ridgeAlongY(hx: number, hz: number) {
  const len = Math.hypot(2 * hz, hx);
  return [(2 * hz) / len, 0, hx / len, (hx * hz) / len, (-2 * hz) / len, 0, hx / len, (hx * hz) / len];
}

/** Stone laid in courses, for walls and plinths. */
function masonry(rampId = R.stone) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = rampId;
    out.dither = 0;
    const row = Math.floor(h.z / 1.6);
    const joint = frac((h.x + h.y + row * 1.7) / 3.4);
    out.tone = frac(h.z / 1.6) < 0.16 || (joint < 0.1 && Math.abs(h.nz) < 0.6) ? -1 : 0.25;
  };
}

// --- TikTok: a giant phone, its screen a glitch of cyan and magenta -------------------------------

export function tiktokPhone(m: Model) {
  m.box(0, 0, 0.9, 6, 6, 0.9, { mat: solid(R.black, 1.6, 0) });
  m.with(FACING, () => {
    m.box(0, 0, 13, 1.3, 5.2, 11.2, { mat: solid(R.black, 0.9, 0) });
    m.box(1.36, 0, 13.4, 0.08, 4.4, 9.9, { mat: glitchScreen });
    // The earpiece slot.
    m.box(1.36, 0, 23.6, 0.08, 1.2, 0.25, { mat: solid(R.iron, 1, 0) });
  });
}

function glitchScreen(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.glow = 1;
  // Slanted bands of colour over black, like a frame of a video caught mid-glitch.
  const band = Math.floor((h.ly * 0.7 + h.lz * 0.45 + 40) / 1.4) % 5;
  out.ramp = band === 0 ? R.cyan : band === 2 ? R.magenta : band === 4 ? R.white : R.black;
  out.tone = band === 1 || band === 3 ? -3.4 : band === 4 ? -0.6 : 0;
  // A progress bar along the bottom.
  if (h.lz < -8.6 && h.lz > -9.3) {
    out.ramp = h.ly < 1.2 ? R.white : R.iron;
    out.tone = h.ly < 1.2 ? 0 : -1;
  }
}

// --- Instagram: square pictures on easels, in its warm-to-violet gradient --------------------------

export function instagramGallery(m: Model) {
  m.box(0, 0, 0.5, 9, 9, 0.5, { mat: solid(R.cream, 0.4, 0) });
  for (const [x, y, z] of [
    [-3, -5, 0],
    [3, -1, 0.6],
    [-5, 3, 0.3],
  ] as const) {
    m.with(mul(translate(x, y, z), FACING), () => {
      // Easel legs and a square canvas leaning on them.
      for (const side of [-1, 1]) m.capsule([-1.4, side * 2.4, 0.6], [0.2, side * 1.6, 11.4], 0.32, { mat: solid(R.wood, 0.3, 0) });
      m.capsule([-2.4, 0, 0.6], [-0.4, 0, 10.6], 0.32, { mat: solid(R.wood, 0.1, 0) });
      m.box(0.4, 0, 8.4, 0.35, 3.7, 3.7, { mat: solid(R.cream, 0.8, 0) });
      m.box(0.78, 0, 8.4, 0.05, 3.2, 3.2, { mat: gradientPicture });
    });
  }
}

function gradientPicture(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.glow = 0.6;
  // From gold at one corner through coral to violet at the other.
  const t = Math.max(0, Math.min(1, (h.ly + 3.2 - (h.lz - 3.2)) / 12.8));
  out.ramp = t < 0.33 ? R.gold : t < 0.66 ? R.coral : R.violet;
  out.tone = 0.6;
  // A round sun in the middle of each picture.
  if (Math.hypot(h.ly, h.lz) < 1.1) {
    out.ramp = R.cream;
    out.tone = 1.2;
  }
}

// --- YouTube: an outdoor screen on red posts, with benches -------------------------------------------

export function youtubeScreen(m: Model) {
  m.with(FACING, () => {
    for (const y of [-9.6, 9.6]) m.cylinder(-0.4, y, 8.6, 0.7, 8.6, { mat: solid(R.crimson, 0.6, 0) });
    m.box(-0.4, 0, 11.6, 0.6, 10.2, 6, { mat: solid(R.crimson, 0.3, 0) });
    m.box(0.25, 0, 11.6, 0.08, 9.2, 5.1, { mat: footage });
    // Two benches facing it.
    for (const y of [-4.5, 4.5]) {
      m.box(9, y, 1.4, 1.1, 3.4, 0.35, { mat: solid(R.woodDark, 0.8, 0) });
      for (const dy of [-2.6, 2.6]) m.box(9, y + dy, 0.6, 0.4, 0.4, 0.6, { mat: solid(R.woodDark, 0, 0) });
    }
  });
}

function footage(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.glow = 1;
  // A wide shot: sky, a hill, a figure; a red progress bar along the bottom.
  out.ramp = h.lz > 1.2 ? R.screen : h.lz > -1.6 + Math.sin(h.ly * 0.5) * 0.8 ? R.leaf : R.sand;
  out.tone = h.lz > 1.2 ? -0.2 : -0.6;
  if (Math.abs(h.ly - 2.4) < 0.8 && h.lz > -2.2 && h.lz < 1.4) {
    out.ramp = R.crimson;
    out.tone = -0.4;
  }
  if (h.lz < -4.3) {
    out.ramp = h.ly < -2 ? R.crimson : R.iron;
    out.tone = h.ly < -2 ? 0 : -1.5;
  }
}

// --- Meta Ad Library: billboards of ads, framed in blue -----------------------------------------------

export function adBillboards(m: Model) {
  for (const [x, y, z] of [
    [-4, -4, 0],
    [4, 2, 0],
  ] as const) {
    m.with(mul(translate(x, y, z), FACING), () => {
      for (const dy of [-3.8, 3.8]) m.box(-0.3, dy, 5.4, 0.45, 0.45, 5.4, { mat: solid(R.woodDark, 0.4, 0) });
      m.box(0, 0, 12.6, 0.5, 5.6, 3.9, { mat: solid(R.blue, 0.4, 0) });
      m.box(0.52, 0, 12.6, 0.05, 4.9, 3.2, { mat: adPoster });
    });
  }
}

function adPoster(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.glow = 0.5;
  out.ramp = R.white;
  out.tone = 0.6;
  // A product shot, a headline and a call-to-action button.
  if (h.ly < -0.6 && Math.abs(h.lz - 0.4) < 2.2) {
    out.ramp = R.gold;
    out.tone = 0.2;
  } else if (h.ly > 0.2 && h.lz > 0.8 && h.lz < 2.4 && Math.floor((h.lz - 0.8) / 0.55) % 2 === 0) {
    out.ramp = R.black;
    out.tone = 2;
  } else if (h.ly > 0.6 && h.lz < -1 && h.lz > -2.4) {
    out.ramp = R.blue;
    out.tone = 0.8;
  }
}

// --- Reddit: a stone forum, its notice board covered in threads --------------------------------------

export function redditForum(m: Model) {
  m.cylinder(0, 0, 0.4, 9, 0.4, { mat: masonry(R.stone) });
  // Benches in a half ring around the board.
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * 0.05 + (i / 4) * Math.PI * 0.6;
    m.with(mul(translate(Math.cos(a) * 6.6, Math.sin(a) * 6.6, 0), rotZ(a)), () => m.box(0, 0, 1.4, 0.9, 1.8, 0.6, { mat: masonry(R.marble) }));
  }
  m.with(mul(translate(-4, -4, 0), FACING), () => {
    for (const dy of [-4.2, 4.2]) m.box(-0.3, dy, 7.2, 0.45, 0.45, 7.2, { mat: solid(R.woodDark, 0.5, 0) });
    m.box(0, 0, 9.4, 0.4, 4.8, 3.6, { mat: solid(R.woodPale, 0.2, 0) });
    m.box(0.42, 0, 9.4, 0.05, 4.3, 3.1, { mat: noticeBoard });
    // An orange roof over the board, its ridge along the board.
    m.box(0.4, 0, 14, 1.7, 5.4, 1, { mat: solid(R.coral, 0.6, 0), clip: ridgeAlongY(1.7, 1) });
  });
}

function noticeBoard(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.woodPale;
  out.tone = -1;
  // Pinned notes, some with an orange header.
  const col = Math.floor((h.ly + 4.3) / 2.15);
  const row = Math.floor((h.lz + 3.1) / 2.07);
  const u = frac((h.ly + 4.3) / 2.15);
  const v = frac((h.lz + 3.1) / 2.07);
  if (u > 0.12 && u < 0.88 && v > 0.12 && v < 0.9) {
    out.ramp = (col + row) % 3 === 0 ? R.coral : R.cream;
    out.tone = v > 0.72 ? -0.4 : 0.9;
    if (out.ramp === R.cream && v > 0.3 && v < 0.62 && frac(v * 6) < 0.4) out.tone = -0.8;
  }
}

// --- ChatGPT: a dark round shrine with a glowing orb ----------------------------------------------------

export function answerShrine(m: Model) {
  m.cylinder(0, 0, 0.6, 7.5, 0.6, { mat: solid(R.black, 1.4, 0) });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    m.cylinder(Math.cos(a) * 5.6, Math.sin(a) * 5.6, 7.6, 0.75, 6.4, { mat: solid(R.black, 0.9, 0) });
  }
  m.cylinder(0, 0, 14.6, 7, 0.6, { mat: solid(R.black, 1.2, 0) });
  m.frustum(0, 0, 17.2, 6.4, 0.6, 2, { mat: solid(R.black, 0.8, 0) });
  m.cylinder(0, 0, 3, 1.6, 1.8, { mat: solid(R.stone, 0.6, 0) });
  m.sphere(0, 0, 7.2, 2.4, { mat: glowOrb(R.jade), cast: false });
}

function glowOrb(rampId: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.glow = 1;
    out.ramp = rampId;
    // Lit from within: brightest on top, with a few slow swirls.
    out.tone = -0.7 + (h.lz / 2.4) * 0.7 + (frac(Math.atan2(h.ly, h.lx) / Math.PI + h.lz * 0.15) < 0.16 ? -1 : 0);
  };
}

// --- Perplexity: a faceted teal crystal on stepped stone ------------------------------------------------

export function crystalSpire(m: Model) {
  m.box(0, 0, 0.8, 5.6, 5.6, 0.8, { mat: masonry(R.stone) });
  m.box(0, 0, 2.2, 4.2, 4.2, 0.6, { mat: masonry(R.marble) });
  m.frustum(0, 0, 12.6, 3, 0.15, 9.8, { mat: crystal });
  m.frustum(0, 0, 3.5, 1.4, 3, 0.8, { mat: crystal });
  for (const [x, y, s] of [
    [3, 1.5, 0.55],
    [-1.6, 3.2, 0.45],
  ] as const) {
    m.frustum(x, y, 3.2 + 3 * s, 1.4 * s * 1.6, 0.1, 3 * s, { mat: crystal });
  }
}

function crystal(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.glow = 0.55;
  out.ramp = R.teal;
  // Six facets, alternately catching and losing the light.
  const facet = Math.floor(((Math.atan2(h.ly, h.lx) + Math.PI) / (Math.PI * 2)) * 6);
  out.tone = facet % 2 ? 1 : -0.2;
}

// --- Ahrefs: a striped beacon, ranking the web from above -----------------------------------------------

export function rankBeacon(m: Model) {
  m.cylinder(0, 0, 0.8, 5, 0.8, { mat: masonry(R.stone) });
  m.frustum(0, 0, 10.6, 3.8, 2.6, 9, { mat: beaconStripes });
  m.cylinder(0, 0, 20, 3.4, 0.4, { mat: solid(R.navy, 0.6, 0) });
  m.cylinder(0, 0, 22, 2.1, 1.6, { mat: lantern });
  m.frustum(0, 0, 24.9, 2.8, 0.3, 1.4, { mat: solid(R.navy, 0.4, 0) });
}

function beaconStripes(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = Math.floor((h.z - 1.6) / 3) % 2 ? R.navy : R.fire;
  out.tone = out.ramp === R.fire ? -0.4 : 0.3;
  // A small door at the foot.
  if (h.z < 5.4 && Math.abs(Math.atan2(h.y, h.x) - Math.PI / 4) < 0.3) {
    out.ramp = R.woodDark;
    out.tone = 0;
  }
}

function lantern(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.glow = 1;
  out.ramp = R.fire;
  out.tone = frac((Math.atan2(h.ly, h.lx) / (Math.PI * 2)) * 6) < 0.18 ? -3.5 : 0.2;
}

// --- SimilarWeb: three houses alike, but not quite ----------------------------------------------------------

export function lookalikeHuts(m: Model) {
  [
    [-6, 4, R.blue],
    [-1, -3, R.teal],
    [4, -10, R.navy],
  ].forEach(([x, y, roof]) => {
    m.box(x, y, 3.4, 3.2, 3.2, 3.4, { mat: hutWall });
    m.box(x, y, 9.4, 3.8, 3.8, 2.6, { mat: solid(roof, 0.5, 0), clip: pyramidClips(3.8, 2.6) });
  });
}

function hutWall(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.cream;
  out.tone = 0.3;
  // A door and a window on the faces the camera sees.
  const face = h.nx > 0.7 ? h.ly : h.ny > 0.7 ? -h.lx : null;
  if (face !== null) {
    if (Math.abs(face) < 0.9 && h.lz < 0.6) {
      out.ramp = R.woodDark;
      out.tone = 0.2;
    } else if (Math.abs(face - 0) < 0.8 && h.lz > 1.4 && h.lz < 2.6) {
      out.ramp = R.screen;
      out.tone = 1;
    }
  }
}

// --- The brand's own site: a little walled town with its banners ----------------------------------------

export function brandGate(m: Model) {
  m.with(FACING, () => {
    for (const y of [-6.4, 6.4]) {
      m.box(0, y, 8, 2.8, 2.8, 8, { mat: masonry(R.stone) });
      for (const [dx, dy] of [
        [-2, -2],
        [2, -2],
        [-2, 2],
        [2, 2],
      ]) {
        m.box(dx, y + dy, 16.6, 0.8, 0.8, 0.6, { mat: masonry(R.stone) });
      }
      // A banner down the tower's face.
      m.box(2.9, y, 11, 0.12, 1.4, 3.2, { mat: banner });
    }
    const arch = m.hole(0, 0, 3.6, 3.4, 2.4, 3.6);
    const wall = masonry(R.stone);
    m.box(0, 0, 6.2, 1.8, 3.8, 6.2, {
      mat: (h: HitInfo, out: ShadeOut) => {
        if (!h.inner) return wall(h, out);
        // Inside the gateway: shade.
        out.ramp = R.woodDark;
        out.tone = -1.5;
        out.dither = 0;
      },
      carve: arch,
    });
    // Roofs of the town behind the wall.
    m.box(-7, -2, 6, 3.2, 3.2, 6, { mat: solid(R.cream, 0.2, 0) });
    m.box(-7, -2, 14, 3.6, 3.6, 2, { mat: solid(R.crimson, 0.3, 0), clip: gableClips(3.6, 2) });
    m.box(-6, 5, 4.6, 2.6, 2.6, 4.6, { mat: solid(R.cream, 0.4, 0) });
    m.box(-6, 5, 10.6, 3, 3, 1.6, { mat: solid(R.coral, 0.3, 0), clip: gableClips(3, 1.6) });
  });
}

function banner(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.crimson;
  out.tone = 0.5;
  // A gold stripe down the middle.
  if (Math.abs(h.ly) < 0.35) {
    out.ramp = R.gold;
    out.tone = 0.6;
  }
}
