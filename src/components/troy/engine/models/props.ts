import { planks, rope, solid } from "../materials";
import { R } from "../palette";
import { fbm, type HitInfo, hash2, Model, mul, rotX, rotY, rotZ, type ShadeOut, translate } from "../tracer";

// Station furniture. Every builder draws around its own origin on the ground (z = 0); the camp
// places them. Sizes are in world units (a soldier is about 20 tall).

const frac = (v: number) => v - Math.floor(v);

/** Planes that cut a box (half sizes b, b, h) into a square pyramid with its apex on top. */
export function pyramidClips(b: number, h: number) {
  const len = Math.hypot(2 * h, b);
  const c = (b * h) / len;
  const n = (2 * h) / len;
  const k = b / len;
  return [n, 0, k, c, -n, 0, k, c, 0, n, k, c, 0, -n, k, c];
}

/** Planes that cut a box (half sizes _, hy, hz) into a gable with its ridge along x. */
export function gableClips(hy: number, hz: number) {
  const len = Math.hypot(2 * hz, hy);
  return [0, (2 * hz) / len, hy / len, (hy * hz) / len, 0, (-2 * hz) / len, hy / len, (hy * hz) / len];
}

function stripes(a: number, b: number, count: number, toneA = 0.3, toneB = 0.4) {
  return (h: HitInfo, out: ShadeOut) => {
    const s = Math.floor(((Math.atan2(h.ly, h.lx) + Math.PI) / (Math.PI * 2)) * count);
    out.ramp = s % 2 ? a : b;
    out.tone = s % 2 ? toneA : toneB;
    out.dither = 0;
  };
}

const marble = (h: HitInfo, out: ShadeOut) => {
  out.ramp = R.marble;
  out.dither = 0;
  out.tone = 0.2 + (fbm(h.x * 0.4 + h.z * 0.3, h.y * 0.4) > 0.68 ? -0.6 : 0);
};

// ----------------------------------------------------------------------------------------------
// Scouts

export function watchtower(m: Model) {
  const post = planks({ ramp: R.wood, row: 3.2, length: 50, vary: 0.35 });
  for (const x of [-5, 5]) for (const y of [-5, 5]) m.box(x, y, 12, 0.8, 0.8, 12, { mat: post });
  // Cross braces on the two sides the camera sees.
  m.with(translate(5, 0, 9), () => m.box(0, 0, 0, 0.4, 0.5, 7.2, { mat: solid(R.woodDark, 0.6, 0), rot: rotX(0.86) }));
  m.with(translate(0, 5, 9), () => m.box(0, 0, 0, 0.5, 0.4, 7.2, { mat: solid(R.woodDark, 0.6, 0), rot: rotY(-0.86) }));
  m.box(0, 0, 24.4, 7.2, 7.2, 0.7, { mat: planks({ ramp: R.woodPale, row: 1, length: 30, axis: "y" }) });
  // Railing.
  for (const [x, y, hx, hy] of [
    [0, 7, 7.2, 0.35],
    [7, 0, 0.35, 7.2],
    [0, -7, 7.2, 0.35],
    [-7, 0, 0.35, 7.2],
  ] as const) {
    m.box(x, y, 27.8, hx, hy, 0.35, { mat: solid(R.wood, 0.4, 0) });
  }
  for (const x of [-7, 7]) for (const y of [-7, 7]) m.box(x, y, 26.6, 0.45, 0.45, 2.2, { mat: R.wood });
  // Roof on four poles.
  for (const x of [-6.5, 6.5]) for (const y of [-6.5, 6.5]) m.box(x, y, 31, 0.35, 0.35, 3.6, { mat: R.woodDark });
  m.box(0, 0, 37, 8.8, 8.8, 3.2, { mat: thatch, clip: pyramidClips(8.8, 3.2) });
  // Pennant.
  m.capsule([0, 0, 40], [0, 0, 46], 0.25, { mat: solid(R.woodDark, 0.5, 0) });
  m.box(0, 2.2, 45, 0.15, 2, 1, { mat: solid(R.crimson, 0.6, 0) });
  // Ladder up the front.
  for (const x of [-1.6, 1.6]) m.box(x, 8.4, 12, 0.3, 0.3, 12.4, { mat: R.wood, rot: rotX(-0.12) });
  for (let i = 0; i < 9; i++) m.box(0, 8.4 + (12 - i * 2.7) * 0.12, 1.5 + i * 2.7, 1.6, 0.25, 0.25, { mat: solid(R.woodPale, 0, 0) });
}

function thatch(h: HitInfo, out: ShadeOut) {
  out.ramp = R.rope;
  out.dither = 0;
  out.tone = 0.4 + (frac(h.z * 0.9 + hash2(Math.floor(h.x * 2), Math.floor(h.y * 2)) * 0.3) < 0.25 ? -1 : 0);
}

export function scrollBasket(m: Model, fill: number) {
  m.cylinder(0, 0, 2, 3.6, 2, { mat: wicker });
  m.cylinder(0, 0, 4.05, 3.75, 0.25, { mat: solid(R.rope, -0.4, 0) });
  const count = Math.round(fill * 7);
  for (let i = 0; i < count; i++) {
    const a = i * 2.4;
    const r = i === 0 ? 0 : 1.9;
    m.with(mul(translate(Math.cos(a) * r, Math.sin(a) * r, 4.6), rotY(0.35 * Math.sin(a * 3))), () => {
      m.cylinder(0, 0, 0, 0.75, 2.2, { mat: scrollMat, rot: rotX(0.3 * Math.cos(a * 2)) });
    });
  }
}

function wicker(h: HitInfo, out: ShadeOut) {
  out.ramp = R.rope;
  out.dither = 0;
  const a = Math.atan2(h.ly, h.lx) * 4;
  out.tone = (Math.floor(h.lz * 1.4) + Math.floor(a)) % 2 ? -0.7 : 0.3;
}

function scrollMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.cream;
  out.dither = 0;
  out.tone = Math.abs(h.lz) > 1.6 ? -0.8 : 0.5;
  if (Math.abs(h.lz) < 0.35) {
    out.ramp = R.crimson;
    out.tone = 0.3;
  }
}

/** A signpost with arrows toward the places scouts go. */
export function signpost(m: Model) {
  m.box(0, 0, 6.5, 0.55, 0.55, 6.5, { mat: R.wood });
  const boards: Array<[number, number, number]> = [
    [11, 0.3, R.teal],
    [8.8, -1.2, R.crimson],
    [6.6, 2.3, R.navy],
  ];
  for (const [z, angle, tip] of boards) {
    m.with(mul(translate(0, 0, z), rotZ(angle)), () => {
      m.box(2.4, 0, 0, 3, 0.3, 0.8, { mat: solid(R.woodPale, 0.4, 0) });
      m.box(5.6, 0, 0, 0.8, 0.32, 0.8, { mat: solid(tip, 0.4, 0), clip: [0.707, 0, 0.707, 0.3, 0.707, 0, -0.707, 0.3] });
    });
  }
}

// ----------------------------------------------------------------------------------------------
// Oracle

export function shrine(m: Model) {
  m.box(0, 0, 0.8, 12.5, 10.5, 0.8, { mat: marble });
  m.box(0, 0, 2.2, 11, 9, 0.6, { mat: marble });
  for (const x of [-9, 9]) {
    for (const y of [-7, 7]) {
      m.cylinder(x, y, 9.8, 1.15, 7, { mat: fluted });
      m.box(x, y, 17.2, 1.6, 1.6, 0.4, { mat: marble });
      m.box(x, y, 3.2, 1.5, 1.5, 0.4, { mat: marble });
    }
  }
  m.box(0, 0, 18.4, 10.8, 8.8, 0.9, { mat: marble });
  m.box(0, 0, 21.8, 11.4, 9.4, 2.6, { mat: pediment, clip: gableClips(9.4, 2.6) });
}

function fluted(h: HitInfo, out: ShadeOut) {
  out.ramp = R.marble;
  out.dither = 0;
  out.tone = frac((Math.atan2(h.ly, h.lx) / (Math.PI * 2)) * 10) < 0.3 ? -0.5 : 0.3;
}

function pediment(h: HitInfo, out: ShadeOut) {
  marble(h, out);
  // A painted band along the eaves.
  if (h.lz < -1.9 && Math.abs(h.nz) < 0.5) {
    out.ramp = R.teal;
    out.tone = 0.2;
  }
}

/** A beige CRT television on a tripod, screen facing +x. `glow` 0..1 lights the screen. */
export function tvOnTripod(m: Model, glow: number, flicker: number) {
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    m.capsule([Math.cos(a) * 3, Math.sin(a) * 3, 0], [0, 0, 7], 0.3, { mat: solid(R.woodDark, 0.4, 0) });
  }
  m.box(0, 0, 10, 2.6, 3, 2.7, { mat: R.plastic });
  m.box(2.65, 0, 10.1, 0.15, 2.3, 2, { mat: screenMat(glow, flicker, 0) });
  m.capsule([-0.5, -1, 12.7], [-1.5, -3, 16], 0.12, { mat: solid(R.iron, 0.5, 0) });
  m.capsule([-0.5, 1, 12.7], [-1.2, 3.2, 15.6], 0.12, { mat: solid(R.iron, 0.5, 0) });
}

/**
 * A glowing screen on a box face. `state` tints it: 0 idle, 1 working (blue), 2 done (green),
 * 3 failed (red). `phase` moves the progress band so frames animate.
 */
export function screenMat(glow: number, phase: number, state: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = state === 2 ? R.leaf : state === 3 ? R.coral : R.screen;
    if (glow <= 0) {
      out.ramp = R.black;
      out.tone = 1;
      return;
    }
    out.glow = 1;
    // Rows of "footage" bars and a scanline that walks down.
    const v = frac(h.lz * 0.9 + phase);
    const u = h.ly;
    let tone = 2.6 * glow;
    if (v < 0.22) tone += 1.2;
    if (Math.abs(u) > 1.5) tone -= 0.8;
    if (state === 1 && Math.abs(h.lz + 0.9) < 0.3) tone = u < -1.8 + phase * 3.6 ? 4.5 : 1.2;
    out.tone = tone - 1;
  };
}

// ----------------------------------------------------------------------------------------------
// War tent

export function pavilion(m: Model) {
  const canvas = stripes(R.coral, R.cream, 16, 0.4, 0.5);
  const hole = m.hole(10, 6, 4.5, 4.4, 4.2, 4.6, rotZ(0.6));
  m.cylinder(0, 0, 4.6, 12.5, 4.6, { mat: (h, out) => (h.inner ? tentInside(h, out) : canvas(h, out)), carve: hole });
  m.frustum(0, 0, 13, 14.2, 0.8, 4, { mat: canvas });
  m.cylinder(0, 0, 9.4, 13.6, 0.35, { mat: scallop });
  m.capsule([0, 0, 16.5], [0, 0, 22], 0.3, { mat: solid(R.woodDark, 0.6, 0) });
  m.box(0, 2.4, 21, 0.15, 2.4, 1.1, { mat: solid(R.violet, 0.8, 0) });
  // Guy ropes and pegs on the visible sides.
  for (const a of [0.2, 1.2, 2.2, -0.9]) {
    const x = Math.cos(a) * 18.5;
    const y = Math.sin(a) * 18.5;
    m.capsule([Math.cos(a) * 13, Math.sin(a) * 13, 9.2], [x, y, 0.6], 0.14, { mat: solid(R.rope, 0.6, 0), cast: false });
    m.box(x, y, 0.6, 0.35, 0.35, 0.6, { mat: R.woodDark });
  }
}

function tentInside(_h: HitInfo, out: ShadeOut) {
  out.ramp = R.coral;
  out.tone = -2.6;
  out.dither = 0;
}

function scallop(h: HitInfo, out: ShadeOut) {
  out.ramp = R.crimson;
  out.dither = 0;
  out.tone = frac((Math.atan2(h.ly, h.lx) / (Math.PI * 2)) * 32) < 0.5 ? 0.5 : -0.2;
}

/** The strategist's table: a painted map with little figures. */
export function mapTable(m: Model) {
  for (const x of [-5, 5]) for (const y of [-3.4, 3.4]) m.box(x, y, 3.5, 0.45, 0.45, 3.5, { mat: R.woodDark });
  m.box(0, 0, 7.3, 6, 4.2, 0.35, { mat: mapMat });
  for (const [x, y, ramp] of [
    [-2.4, -1, R.crimson],
    [1.5, 1.6, R.crimson],
    [3.5, -1.8, R.navy],
    [-0.6, 2.4, R.navy],
    [0.8, -0.4, R.gold],
  ] as const) {
    m.cylinder(x, y, 8.1, 0.45, 0.45, { mat: solid(ramp, 0.6, 0) });
    m.sphere(x, y, 8.85, 0.38, { mat: solid(ramp, 1, 0) });
  }
  // A rolled scroll on the corner.
  m.cylinder(-4.6, 2.8, 8, 0.55, 1.8, { mat: scrollMat, rot: rotX(Math.PI / 2) });
}

function mapMat(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  if (h.nz < 0.8) {
    out.ramp = R.wood;
    out.tone = 0;
    return;
  }
  const land = fbm(h.lx * 0.35 + 4, h.ly * 0.35 + 1) > 0.5;
  out.ramp = land ? R.cream : R.teal;
  out.tone = land ? 0.2 : 1.6;
  if (Math.abs(h.lx) > 5.4 || Math.abs(h.ly) > 3.6) {
    out.ramp = R.wood;
    out.tone = 0.6;
  }
  // A dotted route across the map.
  if (Math.abs(h.ly - Math.sin(h.lx * 0.6) * 1.2) < 0.25 && frac(h.lx * 0.8) < 0.5) {
    out.ramp = R.crimson;
    out.tone = 0.5;
  }
}

// ----------------------------------------------------------------------------------------------
// Workshop

/**
 * A desk turned to face the camera (+x+y): a big beige CRT at the back, keyboard at the front, and
 * a stool where the editor sits looking over the desk at the screen. In the desk's frame +x points
 * at the camera; the editor's seat is at (7, 0) facing -x. `state` and `phase` drive the screen.
 */
export function editDesk(m: Model, state: number, phase: number) {
  m.with(rotZ(Math.PI / 4), () => {
    m.box(0, 0, 7.6, 3.4, 5.4, 0.45, { mat: planks({ ramp: R.woodPale, row: 9, length: 40 }) });
    for (const x of [-2.9, 2.9]) for (const y of [-4.9, 4.9]) m.box(x, y, 3.6, 0.35, 0.35, 3.6, { mat: R.wood });
    // Monitor on a riser, screen toward +x.
    m.box(-1.6, 0, 8.5, 1.4, 1.6, 0.45, { mat: solid(R.plastic, -0.4, 0) });
    m.box(-1.5, 0, 11.9, 2, 2.9, 2.95, { mat: R.plastic });
    m.box(-3, 0, 11.7, 1, 2, 2, { mat: solid(R.plastic, -0.6, 0) });
    m.box(0.55, 0, 12, 0.1, 2.35, 2.25, { mat: screenMat(state === 0 ? 0 : 1, phase, state) });
    // Keyboard, a mug, and a stack of papers.
    m.box(2.2, -0.3, 8.2, 0.8, 2.1, 0.18, { mat: keys });
    m.cylinder(1.6, 3.8, 8.6, 0.55, 0.55, { mat: solid(R.cream, 0.6, 0) });
    m.box(1.2, -4, 8.15, 1, 0.8, 0.15, { mat: solid(R.white, 0.4, 0) });
    m.cylinder(7, 0, 1.2, 1.6, 1.2, { mat: solid(R.woodDark, 0.6, 0) });
  });
}

function keys(h: HitInfo, out: ShadeOut) {
  out.ramp = R.plastic;
  out.dither = 0;
  out.tone = h.nz > 0.5 && frac(h.ly * 1.6) < 0.3 ? -0.8 : 0.4;
}

/** An easel with the first frame of a shot being painted. */
export function easel(m: Model, painted: number) {
  m.capsule([-1.6, -2.4, 0], [0.4, 0, 12], 0.25, { mat: solid(R.wood, 0.4, 0) });
  m.capsule([-1.6, 2.4, 0], [0.4, 0, 12], 0.25, { mat: solid(R.wood, 0.4, 0) });
  m.capsule([-3, 0, 0], [-0.6, 0, 11], 0.25, { mat: solid(R.wood, 0.2, 0) });
  m.box(0.4, 0, 5.2, 0.5, 3.2, 0.25, { mat: R.wood });
  m.with(mul(translate(0.6, 0, 8.6), rotY(-0.16)), () => {
    m.box(0, 0, 0, 0.2, 2.9, 3.4, { mat: canvasMat(painted) });
  });
}

function canvasMat(painted: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.white;
    out.tone = 0.6;
    if (h.nx < 0.5) {
      out.ramp = R.woodPale;
      out.tone = 0;
      return;
    }
    // Paint fills in from the bottom: a sky, a figure, a product.
    const reveal = (h.lz + 3.4) / 6.8;
    if (reveal > painted) return;
    if (h.lz > 0.8) {
      out.ramp = R.teal;
      out.tone = 2.2;
    } else {
      out.ramp = R.sand;
      out.tone = 0.6;
    }
    if (Math.hypot(h.ly + 0.8, h.lz - 0.2) < 1) {
      out.ramp = R.skinMid;
      out.tone = 1;
    }
    if (Math.abs(h.ly - 1.2) < 0.5 && h.lz > -2 && h.lz < 0.6) {
      out.ramp = R.crimson;
      out.tone = 0.8;
    }
  };
}

/** Film canisters stacked as videos finish. */
export function reels(m: Model, count: number) {
  for (let i = 0; i < count; i++) {
    const layer = Math.floor(i / 3);
    const k = i % 3;
    m.cylinder((k - 1) * 3.2 + layer * 1.6, 0, 0.6 + layer * 1.25, 1.5, 0.6, { mat: reelMat });
  }
}

function reelMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.iron;
  out.dither = 0;
  const r = Math.hypot(h.lx, h.ly);
  out.tone = h.nz > 0.5 ? (r < 0.5 ? -1 : r > 1.2 ? 1.4 : 0.6) : 0;
}

// ----------------------------------------------------------------------------------------------
// Theatre

/**
 * One row of shallow marble seats in an arc around (0, 0), opening toward -x-y where the screen
 * stands. Seats run from angle 0 (+x) to 90° (+y); row 0 is innermost and lowest.
 */
export function tier(m: Model, row: number) {
  const r = 15 + row * 4.4;
  const segments = 5 + row;
  const top = 1.2 * (row + 1);
  for (let i = 0; i < segments; i++) {
    const a = ((i + 0.5) / segments) * (Math.PI / 2);
    const len = (r * (Math.PI / 2)) / segments / 2 + 0.25;
    m.with(mul(translate(Math.cos(a) * r, Math.sin(a) * r, 0), rotZ(a)), () => {
      m.box(0, 0, top / 2, 2.15, len, top / 2, { mat: tierMat });
    });
  }
}

function tierMat(h: HitInfo, out: ShadeOut) {
  marble(h, out);
  if (h.nz > 0.7) out.tone += 0.3;
}

/** The screen the videos play on: a linen sheet on a frame, facing +x+y. */
export const SCREEN = { bottom: 9.5, top: 22.5, half: 11 };

export function screenFrame(m: Model) {
  m.with(rotZ(Math.PI / 4), () => {
    for (const y of [-SCREEN.half - 0.8, SCREEN.half + 0.8]) m.cylinder(0, y, 12.4, 0.6, 12.4, { mat: solid(R.wood, 0.3, 0) });
    m.box(0, 0, SCREEN.top + 0.8, 0.5, SCREEN.half + 1.4, 0.55, { mat: solid(R.wood, 0.3, 0) });
    m.box(0, 0, SCREEN.bottom - 0.8, 0.5, SCREEN.half + 1.4, 0.55, { mat: solid(R.wood, 0.1, 0) });
    m.box(0.2, 0, (SCREEN.top + SCREEN.bottom) / 2, 0.12, SCREEN.half, (SCREEN.top - SCREEN.bottom) / 2, { mat: solid(R.black, 1.2, 0) });
    // Bunting along the top.
    for (let i = 0; i < 9; i++) m.box(0.5, -SCREEN.half + 0.8 + i * 2.6, SCREEN.top - 0.6, 0.1, 0.8, 0.9, { mat: solid(i % 2 ? R.teal : R.crimson, 0.6, 0), clip: [0, 0, 1, 0.1] });
  });
}

// ----------------------------------------------------------------------------------------------
// Agora

export function podium(m: Model) {
  m.box(0, 0, 0.8, 6.4, 6.4, 0.8, { mat: marble });
  m.box(0, 0, 3.1, 4.8, 4.8, 1.5, { mat: marble });
  m.box(0, 0, 4.85, 5.1, 5.1, 0.25, { mat: solid(R.marble, 0.6, 0) });
  // A step on the visible side.
  m.box(5.6, 0, 1.9, 1.2, 2.4, 0.3, { mat: marble });
}

export const PLATFORM_FLAGS: Array<{ id: string; colors: [number, number] }> = [
  { id: "tiktok", colors: [R.black, R.teal] },
  { id: "instagram", colors: [R.violet, R.coral] },
  { id: "youtube", colors: [R.crimson, R.white] },
];

/** A banner pole with a flag in a platform's colours; `wave` 0..1 animates the cloth. */
export function banner(m: Model, colors: [number, number], wave: number) {
  m.cylinder(0, 0, 9.5, 0.38, 9.5, { mat: solid(R.woodDark, 0.6, 0) });
  m.sphere(0, 0, 19.3, 0.6, { mat: solid(R.gold, 0.8, 0) });
  // The cloth: thin slices offset by a travelling wave.
  for (let i = 0; i < 6; i++) {
    const y = 0.9 + i * 1.05;
    const sway = Math.sin(wave * Math.PI * 2 + i * 0.9) * 0.55 * (i / 5);
    m.box(sway, y, 15.2 - i * 0.12, 0.14, 0.55, 2.6, { mat: flagMat(colors, i), cast: true });
  }
}

function flagMat(colors: [number, number], slice: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = colors[0];
    out.tone = colors[0] === R.black ? 1.5 : 0.6;
    // A stripe of the second colour through the middle slices.
    if ((slice === 2 || slice === 3) && Math.abs(h.lz) < 1.1) {
      out.ramp = colors[1];
      out.tone = 0.8;
    }
  };
}

// ----------------------------------------------------------------------------------------------
// Scenery

export function oliveTree(m: Model, seed: number) {
  const lean = (hash2(seed, 3) - 0.5) * 0.5;
  m.capsule([0, 0, 0], [lean * 4, 0.6, 8], 1.1, { mat: bark });
  m.capsule([lean * 4, 0.6, 8], [lean * 6 - 2, 1.4, 13], 0.8, { mat: bark });
  m.capsule([lean * 4, 0.6, 8], [lean * 4 + 3, -1, 12.5], 0.75, { mat: bark });
  const blobs = 5;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + seed;
    const r = 3.2 + hash2(seed, i) * 1.6;
    m.ellipsoid(lean * 5 + Math.cos(a) * 3.2, 0.4 + Math.sin(a) * 3.2, 14 + hash2(i, seed) * 2.4, r, r, r * 0.75, { mat: leaves });
  }
  m.ellipsoid(lean * 5, 0.4, 16.4, 3.6, 3.6, 2.8, { mat: leaves });
}

function bark(h: HitInfo, out: ShadeOut) {
  out.ramp = R.woodDark;
  out.dither = 0;
  out.tone = 1 + (frac(h.lz * 0.6 + Math.atan2(h.ly, h.lx)) < 0.3 ? -0.7 : 0);
}

function leaves(h: HitInfo, out: ShadeOut) {
  out.ramp = R.olive;
  out.dither = 0.6;
  const n = hash2(Math.floor(h.x * 1.3), Math.floor(h.y * 1.3 + h.z * 1.3));
  out.tone = 0.4 + (n > 0.82 ? 1 : n < 0.15 ? -1 : 0);
}

export function amphora(m: Model) {
  m.ellipsoid(0, 0, 3.4, 2, 2, 2.9, { mat: terracotta });
  m.cylinder(0, 0, 6.8, 0.8, 0.9, { mat: terracotta });
  m.cylinder(0, 0, 7.8, 1.1, 0.25, { mat: terracotta });
  m.frustum(0, 0, 0.5, 0.6, 1.2, 0.5, { mat: terracotta });
  for (const y of [-1, 1]) m.capsule([0, y * 0.9, 7.2], [0, y * 1.9, 5.2], 0.25, { mat: terracotta });
}

function terracotta(h: HitInfo, out: ShadeOut) {
  out.ramp = R.coral;
  out.dither = 0;
  out.tone = -0.8;
  // A black band with a meander.
  if (h.z > 3.6 && h.z < 4.6) {
    out.ramp = R.black;
    out.tone = 1;
  }
}

export function campfire(m: Model, frame: number) {
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    m.sphere(Math.cos(a) * 3.2, Math.sin(a) * 3.2, 0.5, 0.8, { mat: solid(R.stone, 0.4, 0) });
  }
  m.capsule([-2.2, -1, 0.6], [2.2, 1, 0.6], 0.5, { mat: bark });
  m.capsule([-1.8, 1.6, 0.7], [1.8, -1.4, 0.7], 0.5, { mat: bark });
  const flick = [0, 0.4, -0.3, 0.2][frame % 4];
  m.frustum(0.2, 0, 2.6, 1.5, 0.2, 1.8 + flick * 0.5, { mat: flame(0.6), cast: false });
  m.frustum(-0.6 + flick * 0.5, 0.4, 2.2, 0.9, 0.1, 1.3, { mat: flame(1), cast: false });
  m.frustum(0.9, -0.5 - flick * 0.3, 2.1, 0.7, 0.1, 1.1 - flick * 0.3, { mat: flame(1.4), cast: false });
}

function flame(heat: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = R.fire;
    out.glow = 1;
    out.dither = 0;
    out.tone = 2.6 + heat - (h.lz + 1.5) * 0.6;
  };
}

/**
 * Horse coats: bay, chestnut, dun, grey and black, each with its mane. Tied side by side at the
 * stable, horses of one colour would merge into one long brown shape; mixed, each reads as a horse.
 */
const COATS = [
  { ramp: R.wood, tone: 0.6, dither: 0.3, mane: R.hair, maneTone: 0.6 },
  { ramp: R.bronze, tone: -0.35, dither: 0.12, mane: R.wood, maneTone: -0.6 },
  { ramp: R.woodPale, tone: 0.2, dither: 0.3, mane: R.hair, maneTone: 0.4 },
  { ramp: R.stone, tone: 0.9, dither: 0.3, mane: R.iron, maneTone: 0.6 },
  { ramp: R.hair, tone: 1, dither: 0.3, mane: R.black, maneTone: 0.4 },
];

/**
 * A small riding horse with a rider seat, galloping along +x, in one of the COATS. `f` is the
 * stride 0..5, or -1 for a horse standing still (tied at the stable, or waiting for its rider).
 */
export function mount(m: Model, f: number, coatIndex = 0) {
  const look = COATS[coatIndex % COATS.length];
  const coat = (h: HitInfo, out: ShadeOut) => {
    out.ramp = look.ramp;
    out.dither = look.dither;
    out.tone = look.tone;
  };
  const mane = solid(look.mane, look.maneTone, 0);
  const still = f < 0;
  const phase = still ? 0 : (f / 6) * Math.PI * 2;
  const bob = still ? 0 : Math.sin(phase * 2) * 0.35;
  m.with(translate(0, 0, bob), () => {
    m.ellipsoid(0, 0, 9, 6.2, 2.5, 2.9, { mat: coat });
    // Standing, the neck rises forward from the chest and the head hangs at rest; the tail hangs.
    m.with(mul(translate(still ? 4.6 : 5.2, 0, 11.4), rotY(still ? 0.32 : -0.75 + Math.sin(phase) * 0.1)), () => {
      m.box(0, 0, 2.4, 1.6, 1.4, 3.2, { mat: coat });
      m.box(1.4, 0, 5.4, 3, 1.25, 1.35, { mat: coat, rot: rotY(still ? 0.62 : 1.1) });
      m.box(-0.6, 0, 3.4, 0.9, 0.5, 3.4, { mat: mane });
      for (const y of [-0.7, 0.7]) m.box(0, y, 6.6, 0.3, 0.25, 0.7, { mat: coat });
    });
    m.capsule([-5.8, 0, 10], still ? [-6.8, 0, 5.2] : [-8.4, 0, 6.6 + Math.sin(phase) * 0.8], 0.6, { mat: mane });
    // Saddle cloth.
    m.box(-0.4, 0, 11.2, 2.6, 2.75, 0.5, { mat: solid(R.crimson, 0.4, 0) });
  });
  // Gallop: legs swing in a rotary pattern. Standing: straight down.
  const legs: Array<[number, number, number]> = [
    [4.2, 1.1, 0],
    [4.2, -1.1, 0.5],
    [-4, 1.1, 2.4],
    [-4, -1.1, 2.9],
  ];
  for (const [x, y, offset] of legs) {
    const a = still ? 0 : Math.sin(phase + offset) * 0.6;
    const hip: [number, number, number] = [x, y, 8 + bob];
    const knee: [number, number, number] = [x + Math.sin(a) * 3.6, y, 8 + bob - Math.cos(a) * 3.6];
    const hoofLift = still ? 0 : Math.max(0, Math.sin(phase + offset + 1.2)) * 1.6;
    const hoof: [number, number, number] = [knee[0] + Math.sin(a * 0.4) * 3.4, y, Math.max(0.5, knee[2] - 3.4 + hoofLift)];
    m.capsule(hip, knee, 0.7, { mat: coat });
    m.capsule(knee, hoof, 0.5, { mat: coat });
  }
}

/** The scouts' stable: a hitching rail along y between two posts, with a water trough on its +x side. */
export const RAIL = { half: 24 };

export function hitchingRail(m: Model) {
  const wood = solid(R.woodDark, 0.5, 0);
  for (const y of [-RAIL.half, RAIL.half]) m.box(0, y, 3.4, 0.7, 0.7, 3.4, { mat: wood });
  m.box(0, 0, 6.2, 0.45, RAIL.half + 0.6, 0.45, { mat: solid(R.wood, 0.3, 0) });
  // A trough under the horses' heads, on the far side of the rail from them.
  m.box(3.2, 0, 1.3, 1.6, RAIL.half - 3, 1.3, { mat: solid(R.woodDark, 0.9, 0) });
  m.box(3.2, 0, 2.5, 1.1, RAIL.half - 3.5, 0.15, { mat: solid(R.water, 0.6, 0) });
}

