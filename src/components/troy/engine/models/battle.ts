import { rope, solid } from "../materials";
import { R } from "../palette";
import { type HitInfo, type Model, mul, rotX, rotY, rotZ, type ShadeOut, translate } from "../tracer";
import { pyramidClips } from "./props";

// The battle below the agora: the Greeks' stone-throwing catapults, and the rival's Roman fort with
// its towers, gate, tents, ballistae and eagle. Built like the camp's furniture, in world units
// around their own origin on the ground; a soldier is about 20 tall.

const frac = (v: number) => v - Math.floor(v);

/**
 * The catapult's arm, in radians from +x toward +z: loaded and pulled back, swinging, at rest
 * against the padded beam after a throw, and halfway back on the winch.
 */
const ARM = [2.95, 1.95, 1.2, 2.3];
export const CATAPULT_FRAMES = ARM.length;

/**
 * A Greek stone-thrower: a heavy frame, a twisted-rope skein the arm pivots in, a padded beam it
 * slams against, and a winch at the back. `v`: 0 loaded, 1 swinging, 2 thrown, 3 winching back.
 * It throws toward +x (down and to the right on screen), at the rival's lines.
 */
export function catapult(m: Model, v: number) {
  m.with(rotZ(0), () => {
    const beam = solid(R.wood, 0.25, 0);
    const dark = solid(R.woodDark, 0.6, 0);
    for (const y of [-3, 3]) m.box(0, y, 0.9, 6.6, 0.6, 0.6, { mat: beam });
    for (const x of [-5.6, -1.6, 4.6]) m.box(x, 0, 0.9, 0.6, 3.7, 0.55, { mat: dark });
    // Uprights, braces and the padded stop beam.
    for (const y of [-3, 3]) {
      m.box(1.8, y, 4.7, 0.55, 0.55, 3.9, { mat: beam });
      m.capsule([5.2, y, 1.4], [2.2, y, 7.7], 0.34, { mat: solid(R.wood, 0.05, 0) });
    }
    m.box(1.8, 0, 8.7, 0.65, 3.75, 0.6, { mat: dark });
    m.box(1.15, 0, 8.7, 0.3, 1.7, 0.55, { mat: rope() });
    // The skein of twisted rope, iron-bound at both ends.
    m.cylinder(-2.2, 0, 2.3, 1.15, 2.75, { mat: rope(), rot: rotX(Math.PI / 2) });
    for (const y of [-2.85, 2.85]) m.cylinder(-2.2, y, 2.3, 1.4, 0.25, { mat: solid(R.iron, 0.8, 0), rot: rotX(Math.PI / 2) });
    // The arm and its cup; a stone in it when loaded.
    const a = ARM[v % ARM.length];
    const tip: [number, number, number] = [-2.2 + Math.cos(a) * 9.6, 0, 2.3 + Math.sin(a) * 9.6];
    m.capsule([-2.2, 0, 2.3], tip, 0.55, { mat: solid(R.wood, 0.55, 0) });
    m.with(mul(translate(tip[0], tip[1], tip[2]), rotY(Math.PI / 2 - a)), () => m.cylinder(0, 0, 0.35, 1.15, 0.4, { mat: dark }));
    if (v % ARM.length === 0) m.sphere(tip[0] + 0.3, 0, tip[2] + 1.1, 0.95, { mat: solid(R.stone, 0.5, 0) });
    // The winch, its handles turned a little each frame.
    m.cylinder(-6.1, 0, 2.3, 0.62, 3.3, { mat: dark, rot: rotX(Math.PI / 2) });
    for (const y of [-3.5, 3.5]) m.box(-6.1, y, 2.3, 0.22, 0.2, 1.4, { mat: solid(R.iron, 0.6, 0), rot: rotY(v * 0.7) });
    // Stones piled ready beside the frame.
    for (const [x, y, r] of [
      [-4.4, 5.3, 0.95],
      [-3.1, 5.8, 0.85],
      [-3.8, 4.6, 0.8],
      [-3.7, 5.4, 0.75],
    ]) m.sphere(x, y, r * 0.85 + (x === -3.7 ? 1.2 : 0), r, { mat: solid(R.stone, 0.25, 0) });
  });
}

/**
 * A Roman ballista on a trestle: a big crossbow with twisted-rope springs. `v`: 0 drawn with a bolt
 * on the slider, 1 just loosed. It shoots toward -x (up and to the left on screen), at the Greeks.
 */
export function ballista(m: Model, v: number) {
  m.with(rotZ(Math.PI), () => {
    const dark = solid(R.woodDark, 0.5, 0);
    for (const [x, y] of [
      [-2.8, -2.2],
      [-2.8, 2.2],
      [2.4, -2.2],
      [2.4, 2.2],
    ]) m.capsule([x * 0.35, y * 0.35, 3.7], [x, y, 0.4], 0.3, { mat: dark });
    m.box(0, 0, 3.9, 1.1, 1.1, 0.45, { mat: solid(R.wood, 0.3, 0) });
    // The stock, and the spring frame standing up at its front.
    m.box(0.3, 0, 4.8, 5.3, 0.55, 0.38, { mat: solid(R.wood, 0.45, 0) });
    m.box(3.2, 0, 5.2, 0.6, 2.4, 1.45, { mat: dark });
    for (const y of [-1.65, 1.65]) {
      m.cylinder(3.2, y, 5.2, 0.55, 1.45, { mat: rope() });
      for (const z of [3.85, 6.55]) m.cylinder(3.2, y, z, 0.72, 0.17, { mat: solid(R.iron, 0.9, 0) });
    }
    // Arms swept back while drawn, flung forward once loosed; the string from tip to tip.
    const drawn = v % 2 === 0;
    const tip = (side: number): [number, number, number] => (drawn ? [0.7, side * 3.05, 5.2] : [2.5, side * 3.95, 5.2]);
    for (const side of [-1, 1]) m.capsule([3.2, side * 1.65, 5.2], tip(side), 0.27, { mat: solid(R.wood, 0.65, 0) });
    const nock: [number, number, number] = drawn ? [-3.9, 0, 5.3] : [2.3, 0, 5.3];
    for (const side of [-1, 1]) m.capsule(tip(side), nock, 0.08, { mat: solid(R.cream, 1, 0) });
    if (drawn) {
      m.capsule([-3.7, 0, 5.45], [4.4, 0, 5.45], 0.14, { mat: solid(R.wood, 0.9, 0) });
      m.frustum(4.85, 0, 5.45, 0.32, 0.02, 0.9, { mat: solid(R.iron, 1.3, 0), rot: rotY(Math.PI / 2) });
      for (const side of [-1, 1]) m.box(-3.45, side * 0.25, 5.45, 0.4, 0.05, 0.25, { mat: solid(R.cream, 1, 0) });
    }
  });
}

/** The fort's size: half the side of its square, and how tall its palisade stands. */
export const FORT = { half: 34, wall: 7.6, gate: 6 };

/** The towers either side of the gate (local), whose open platforms carry the ballistae. */
const GATE_TOWERS: Array<[number, number]> = [
  [-FORT.half, FORT.gate + 2.2],
  [-FORT.half, -FORT.gate - 2.2],
];

/** Where the fort's two ballistae stand, on the gate towers' platforms (world, from the fort's centre). */
export const FORT_GUNS = GATE_TOWERS.map(([x, y]) => ({ x, y, z: 10.55 }));

/**
 * The rival's fort, a Roman marching camp: a palisade of sharpened logs round a square, a gate in
 * the wall facing the battle (-x, up and to the left on screen) with towers either side, tents in
 * rows, the commander's tent and the legion's golden eagle.
 */
export function romanFort(m: Model) {
  m.with(rotZ(0), () => {
    const h = FORT.half;
    let n = 0;
    // A sharpened log; their heights and shades vary a little, like cut timber.
    const log = (x: number, y: number) => {
      const i = n++;
      const top = FORT.wall + ((i * 37) % 7) * 0.12;
      m.cylinder(x, y, top / 2, 0.66, top / 2, { mat: solid(i % 4 === 0 ? R.woodDark : R.wood, 0.05 + ((i * 13) % 5) * 0.12, 0) });
      m.frustum(x, y, top + 0.55, 0.66, 0.06, 0.55, { mat: solid(R.wood, 0.75, 0) });
    };
    for (let t = -h; t <= h + 0.01; t += 1.3) {
      log(h, t);
      log(t, h);
      log(t, -h);
      // The gate gap in the wall toward the battle (local -x).
      if (Math.abs(t) > FORT.gate) log(-h, t);
    }
    // A walkway along the inside of the palisade, on posts.
    for (const [x, y, hx, hy] of [
      [h - 1.7, 0, 0.9, h - 1],
      [-(h - 1.7), 0, 0.9, h - 1],
      [0, h - 1.7, h - 1, 0.9],
      [0, -(h - 1.7), h - 1, 0.9],
    ]) m.box(x, y, 5.1, hx, hy, 0.25, { mat: solid(R.woodPale, 0.1, 0), cast: false });
    // Towers at the corners and either side of the gate.
    for (const [x, y] of [
      [h, h],
      [h, -h],
      [-h, h],
      [-h, -h],
    ] as Array<[number, number]>)
      tower(m, x, y, true);
    // The gate towers are open on top, for the ballistae.
    for (const [x, y] of GATE_TOWERS) tower(m, x, y, false);
    // The gate's doors stand open, swung inward.
    for (const side of [1, -1]) m.with(mul(translate(-h + 0.6, side * FORT.gate, 0), rotZ(side * -1.2)), () => m.box(0, side * -2.9, 3.6, 0.35, 2.9, 3.6, { mat: doorMat }));
    m.box(-h, 0, 8.6, 0.55, FORT.gate + 2.6, 0.55, { mat: solid(R.woodDark, 0.4, 0) });
    // Rows of leather tents, and the commander's tent at the heart of the camp.
    for (const [x, y] of [
      [14, -18],
      [14, -6],
      [14, 6],
      [14, 18],
      [-2, -20],
      [-2, 20],
      [-16, -18],
      [-16, 18],
    ]) tent(m, x, y, 1);
    praetorium(m, 2, 0);
    // The eagle, by the gate where the legion forms up.
    aquila(m, -h + 9, 0);
  });
}

function tower(m: Model, x: number, y: number, roof: boolean) {
  const post = solid(R.woodDark, 0.45, 0);
  for (const [dx, dy] of [
    [-2, -2],
    [-2, 2],
    [2, -2],
    [2, 2],
  ]) m.box(x + dx, y + dy, 5.8, 0.4, 0.4, 5.8, { mat: post });
  m.box(x, y, 10.2, 2.9, 2.9, 0.35, { mat: solid(R.woodPale, 0.15, 0) });
  // A breastwork round the platform, and a little pyramid roof on poles.
  for (const [dx, dy, hx, hy] of [
    [2.7, 0, 0.18, 2.9],
    [-2.7, 0, 0.18, 2.9],
    [0, 2.7, 2.9, 0.18],
    [0, -2.7, 2.9, 0.18],
  ]) m.box(x + dx, y + dy, 11.4, hx, hy, 0.85, { mat: solid(R.wood, 0.3, 0) });
  if (!roof) return;
  for (const [dx, dy] of [
    [-2.4, -2.4],
    [2.4, 2.4],
    [-2.4, 2.4],
    [2.4, -2.4],
  ]) m.box(x + dx, y + dy, 13.2, 0.2, 0.2, 1.6, { mat: post });
  m.box(x, y, 16.2, 3.4, 3.4, 1.6, { mat: solid(R.crimson, 0.1, 0), clip: pyramidClips(3.4, 1.6) });
}

/** A contubernium's leather tent: a ridge tent with its ridge along x. */
function tent(m: Model, x: number, y: number, scale: number) {
  const hx = 4.2 * scale;
  const hy = 3 * scale;
  const hz = 2.6 * scale;
  const len = Math.hypot(2 * hz, hy);
  m.box(x, y, hz, hx, hy, hz, { mat: leather, clip: [0, (2 * hz) / len, hy / len, (hy * hz) / len, 0, (-2 * hz) / len, hy / len, (hy * hz) / len] });
}

/** The commander's tent: larger, red and white, with a little pennant. */
function praetorium(m: Model, x: number, y: number) {
  m.box(x, y, 3.2, 6.5, 6.5, 3.2, { mat: canvasStripes });
  m.box(x, y, 7.4, 7, 7, 1.6, { mat: solid(R.crimson, 0.3, 0), clip: pyramidClips(7, 1.6) });
  m.capsule([x, y, 8.8], [x, y, 12.6], 0.18, { mat: solid(R.woodDark, 0.6, 0) });
  m.box(x, y + 1.3, 12, 0.08, 1.3, 0.55, { mat: solid(R.gold, 0.6, 0) });
}

/** The legion's eagle: a golden eagle with spread wings on a tall pole, a red banner beneath. */
export function aquila(m: Model, x: number, y: number) {
  const gold = solid(R.gold, 1.1, 0);
  m.capsule([x, y, 0], [x, y, 21], 0.3, { mat: solid(R.woodDark, 0.5, 0) });
  // The vexillum: a red square on a crossbar, fringed in gold.
  m.box(x, y, 16.6, 0.25, 3, 0.2, { mat: gold });
  m.box(x + 0.15, y, 14.3, 0.1, 2.7, 2.2, { mat: vexillum });
  // The eagle on its perch.
  m.box(x, y, 21.3, 0.5, 1.3, 0.25, { mat: gold });
  m.ellipsoid(x, y, 22.4, 0.9, 0.75, 1.1, { mat: gold });
  m.sphere(x + 0.55, y, 23.6, 0.55, { mat: gold });
  for (const side of [1, -1]) m.box(x - 0.1, y + side * 1.9, 23.3, 0.2, 1.5, 0.75, { mat: gold, rot: rotX(side * -0.55) });
}

function doorMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.wood;
  out.dither = 0;
  out.tone = frac(h.ly / 1.3) < 0.15 ? -0.6 : 0.2;
  if (Math.abs(h.lz) > 2.6 && Math.abs(h.lz) < 3.1) {
    out.ramp = R.iron;
    out.tone = 0.6;
  }
}

function leather(h: HitInfo, out: ShadeOut) {
  out.ramp = R.wood;
  out.dither = 0;
  // Stitched panels.
  out.tone = frac(h.lx / 2.1) < 0.08 ? -0.4 : 0.85;
}

function canvasStripes(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  const s = Math.floor((h.lx + h.ly + 20) / 1.6) % 2;
  out.ramp = s ? R.crimson : R.cream;
  out.tone = s ? 0.3 : 0.5;
}

function vexillum(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  out.ramp = R.crimson;
  out.tone = 0.5;
  if (Math.abs(h.ly) > 2.3 || h.lz < -1.8) {
    out.ramp = R.gold;
    out.tone = 0.8;
  }
}
