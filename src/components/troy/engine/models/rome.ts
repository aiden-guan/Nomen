import { solid } from "../materials";
import { R } from "../palette";
import { ScaledModel } from "../scaled";
import { fbm, hash2, type HitInfo, Model, mul, rotX, rotZ, type ShadeOut, translate } from "../tracer";
import { banner, pyramidClips } from "./props";

// The rival's city: a Roman port with a lighthouse on its mole, a temple on its podium over the
// forum, a wall with a gatehouse and towers, and beyond it red-roofed houses, an amphitheatre and
// an aqueduct, among cypresses and umbrella pines. Every builder draws around its own origin on
// the ground in world units (a soldier is 20 tall). The camera looks from +x+y, so fronts meant
// to be seen face +x or +y.
//
// The city is drawn big: its builders are designed at a small scale and drawn SCALE times larger,
// so the temple and the walls tower over the soldiers fighting below them.

/** How much bigger than designed the city's buildings are drawn. */
export const SCALE = 2;

/** The city's sizes in world units, for laying it out. */
export const CITY = {
  /** A wall run's thickness (half) and height, a tower's half side, the gatehouse's half depth and half width. */
  wall: 2.6 * SCALE,
  wallHeight: 12 * SCALE,
  tower: 5.4 * SCALE,
  gateDepth: 7 * SCALE,
  gateHalf: 8.5 * SCALE,
  /** The gate's passage (half its width) and where the ballista stands on a tower (height). */
  passage: 4.3 * SCALE,
  towerTop: 18.4 * SCALE,
};

const big = (m: Model, k = SCALE) => new ScaledModel(m, k);

const frac = (v: number) => v - Math.floor(v);

/** Planes that cut a box (half sizes hx, _, hz) into a gable with its ridge along y. */
export function ridgeAlongY(hx: number, hz: number) {
  const len = Math.hypot(2 * hz, hx);
  return [(2 * hz) / len, 0, hx / len, (hx * hz) / len, (-2 * hz) / len, 0, hx / len, (hx * hz) / len];
}

/** Planes that cut a box (half sizes _, hy, hz) into a gable with its ridge along x. */
export function ridgeAlongX(hy: number, hz: number) {
  const len = Math.hypot(2 * hz, hy);
  return [0, (2 * hz) / len, hy / len, (hy * hz) / len, 0, (-2 * hz) / len, hy / len, (hy * hz) / len];
}

/** Roman walling: courses of pale stone with a band of red brick every few courses (opus mixtum). */
export function romanMasonry(stone = R.ochre) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    const course = Math.floor(h.z / 1.25);
    if (course % 5 === 4) {
      out.ramp = R.tile;
      out.tone = frac(h.z / 1.25) < 0.2 ? -0.4 : 0.35;
      return;
    }
    out.ramp = stone;
    const along = Math.abs(h.nx) > Math.abs(h.ny) ? h.y : h.x;
    const joint = frac((along + course * 1.37) / 3.1) < 0.09;
    out.tone = frac(h.z / 1.25) < 0.14 || (joint && Math.abs(h.nz) < 0.5) ? -0.85 : 0.3 + (hash2(Math.floor(along / 3.1 + course * 0.45), course) - 0.5) * 0.35;
  };
}

/** Plaster over brick: a wash of colour, a darker plinth, faint weathering. */
function plaster(ramp: number, tone = 0.45) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = ramp;
    out.tone = h.lz < -0.5 && h.z < 1.2 ? tone - 0.65 : tone + (fbm(h.x * 0.3 + h.z * 0.2, h.y * 0.3) > 0.68 ? -0.25 : 0);
  };
}

/** Terracotta roof tiles: rows of round cover tiles running down the slope, eaves a shade darker. */
function tiles(alongX: boolean, tone = 0.45) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.tile;
    const across = alongX ? h.x : h.y;
    const ridge = frac(across / 1.15);
    out.tone = tone + (ridge < 0.28 ? -0.55 : ridge > 0.7 ? 0.25 : 0) + (hash2(Math.floor(across / 1.15), Math.floor(h.z * 1.6)) > 0.93 ? -0.4 : 0);
  };
}

const marble = (h: HitInfo, out: ShadeOut) => {
  out.ramp = R.marble;
  out.dither = 0;
  out.tone = 0.55 + (fbm(h.x * 0.4 + h.z * 0.3, h.y * 0.4) > 0.7 ? -0.35 : 0);
};

/** Fluted column shafts: vertical channels round the drum. */
const fluted = (h: HitInfo, out: ShadeOut) => {
  out.ramp = R.marble;
  out.dither = 0;
  out.tone = frac((Math.atan2(h.ly, h.lx) / (Math.PI * 2)) * 14) < 0.3 ? 0.1 : 0.7;
};

function column(m: Model, x: number, y: number, z: number, height: number, r: number) {
  m.cylinder(x, y, z + 0.3, r * 1.35, 0.3, { mat: marble });
  m.cylinder(x, y, z + height / 2, r, height / 2 - 0.6, { mat: fluted });
  // A capital flaring out under the architrave.
  m.frustum(x, y, z + height - 0.6, r, r * 1.5, 0.6, { mat: solid(R.marble, 0.9, 0) });
}

// --- The temple ---------------------------------------------------------------------------------

/**
 * The temple of the city's gods on its tall podium, facing +y: steps up to a deep porch of six
 * columns, a pediment with a gilded group on its peak, a tiled roof, the cella behind.
 */
export function temple(target: Model) {
  const m = big(target, SCALE);
  const hx = 13;
  const hy = 19;
  const podium = 5;
  // The podium, with a moulded top.
  m.box(0, -2, podium / 2, hx, hy - 2, podium / 2, { mat: romanMasonry(R.marble) });
  m.box(0, -2, podium + 0.25, hx + 0.5, hy - 1.5, 0.3, { mat: solid(R.marble, 0.9, 0) });
  // The steps, between two cheek walls.
  for (let i = 0; i < 6; i++) m.box(0, hy - 3.6 + i * 1.2 + 0.6, podium - 0.4 - i * 0.8, hx - 3, 0.6 + (5 - i) * 0.6, 0.4, { mat: solid(R.marble, 0.75 - i * 0.05, 0) });
  for (const side of [1, -1]) m.box(side * (hx - 1.6), hy + 0.4, podium / 2 + 0.2, 1.4, 3.6, podium / 2 + 0.2, { mat: romanMasonry(R.marble) });
  // The cella: a windowless hall, its doors bronze.
  const cellaY = -6;
  m.box(0, cellaY, podium + 7.5, hx - 2.4, hy - 9, 7.5, { mat: romanMasonry(R.cream) });
  m.box(0, cellaY + hy - 9 + 0.05, podium + 5, 2.6, 0.1, 5, { mat: doors });
  // Six columns across the front, three deep at the sides.
  const colH = 15;
  for (let i = 0; i < 6; i++) column(m, -hx + 2.2 + i * ((2 * hx - 4.4) / 5), hy - 3.6, podium, colH, 1);
  for (const side of [1, -1]) for (const y of [hy - 9.2, hy - 14.8]) column(m, side * (hx - 2.2), y, podium, colH, 1);
  // Architrave and frieze, the pediment and the roof.
  const top = podium + colH;
  m.box(0, -1.5, top + 0.9, hx, hy - 1.5, 0.9, { mat: frieze });
  m.box(0, -1.5, top + 4.2, hx + 0.4, hy - 1.2, 2.4, { mat: roofOrPediment, clip: ridgeAlongY(hx + 0.4, 2.4) });
  // A gilded chariot group on the peak of the pediment, and statues at its corners.
  m.box(0, hy - 2.6, top + 7.2, 1.6, 0.9, 0.7, { mat: solid(R.gold, 1.1, 0) });
  m.ellipsoid(0, hy - 2.6, top + 8.5, 0.8, 0.6, 1, { mat: solid(R.gold, 1.3, 0) });
  for (const side of [1, -1]) m.ellipsoid(side * (hx - 0.4), hy - 2.6, top + 2.6, 0.6, 0.5, 1, { mat: solid(R.gold, 1.1, 0) });
}

function doors(h: HitInfo, out: ShadeOut) {
  out.ramp = R.bronze;
  out.dither = 0;
  out.tone = Math.abs(h.lx) < 0.15 ? -0.8 : frac(h.lz / 1.6) < 0.15 || frac(h.lx / 1.3) < 0.12 ? 0.1 : 0.7;
}

function frieze(h: HitInfo, out: ShadeOut) {
  out.ramp = R.marble;
  out.dither = 0;
  // A plain architrave below, a frieze of triglyphs above.
  const along = Math.abs(h.nx) > 0.5 ? h.y : h.x;
  out.tone = h.lz < 0 ? 0.75 : frac(along / 1.8) < 0.3 ? 0.05 : 0.6;
}

function roofOrPediment(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  // The gable end is the pediment: a marble frame round a shaded tympanum.
  if (Math.abs(h.ny) > 0.9) {
    out.ramp = R.marble;
    const inset = h.lz < -1.8 || Math.abs(h.lx) > 11.6 - (h.lz + 2.4) * 4.5;
    out.tone = inset ? 0.85 : 0.2;
    return;
  }
  out.ramp = R.tile;
  const ridge = frac(h.y / 1.15);
  out.tone = 0.45 + (ridge < 0.28 ? -0.55 : ridge > 0.7 ? 0.25 : 0);
}

// --- The wall, its towers and its gate ---------------------------------------------------------------

/** A run of the city wall along y, `length` (world units) long each way of its centre: a walkway on top, merlons on its outer (-x) edge. */
export function wall(target: Model, length: number) {
  const m = big(target);
  const half = length / SCALE;
  const t = 2.6;
  const h = 12;
  m.box(0, 0, h / 2, t, half, h / 2, { mat: romanMasonry() });
  m.box(0.4, 0, h + 0.2, t - 0.4, half, 0.2, { mat: solid(R.stone, 0.6, 0) });
  for (let y = -half + 1.4; y <= half - 1.2; y += 3.2) m.box(-t + 0.7, y, h + 1.3, 0.7, 1, 1.3, { mat: romanMasonry() });
}

/**
 * A wall tower: square, a storey above the wall, with arrow slits, merlons and a tiled pyramid roof
 * on posts over the fighting platform (`roof` 0 leaves it open for a ballista).
 */
export function tower(target: Model, roof = 1) {
  const m = big(target, SCALE);
  const s = 5.4;
  const h = 18;
  m.box(0, 0, h / 2, s, s, h / 2, { mat: towerMat });
  m.box(0, 0, h + 0.2, s + 0.4, s + 0.4, 0.3, { mat: solid(R.stone, 0.7, 0) });
  for (const [x, y] of [
    [-s, -s],
    [-s, 0],
    [-s, s],
    [0, -s],
    [0, s],
    [s, -s],
    [s, 0],
    [s, s],
  ]) m.box(x * 0.9, y * 0.9, h + 1.5, 0.95, 0.95, 1.2, { mat: romanMasonry() });
  if (!roof) return;
  for (const [x, y] of [
    [-s + 1, -s + 1],
    [s - 1, s - 1],
    [-s + 1, s - 1],
    [s - 1, -s + 1],
  ]) m.box(x, y, h + 2.6, 0.3, 0.3, 2.4, { mat: solid(R.woodDark, 0.5, 0) });
  m.box(0, 0, h + 7, s + 1.2, s + 1.2, 2.2, { mat: tiles(true, 0.35), clip: pyramidClips(s + 1.2, 2.2) });
}

function towerMat(h: HitInfo, out: ShadeOut) {
  romanMasonry()(h, out);
  // Arrow slits in the upper storey.
  const along = Math.abs(h.nx) > 0.5 ? h.ly : h.lx;
  if (Math.abs(h.nz) < 0.5 && h.z > 12.5 && h.z < 15.5 && Math.abs(along) < 0.4) {
    out.ramp = R.black;
    out.tone = 0.3;
  }
}

/**
 * The gatehouse: a deep arched passage through the wall (along x), towers either side, an attic
 * over the arch. `v` 0: the doors stand open; 1: shut.
 */
export function gatehouse(target: Model, v: number) {
  const m = big(target, SCALE);
  const depth = 7;
  const half = 8.5;
  // The block, carved by the arched passage: a long ellipsoid through it, its crown the arch.
  const arch = m.cutter((c) => c.ellipsoid(0, 0, 2, 40, 4.3, 9.2, { mat: 0 }));
  m.box(0, 0, 8.5, depth, half, 8.5, { mat: gateMat, carve: arch });
  // The attic over the arch, with a bronze plaque.
  m.box(0, 0, 18.2, depth + 0.5, half + 0.5, 1.2, { mat: solid(R.marble, 0.75, 0) });
  m.box(depth + 0.55, 0, 18.2, 0.08, 3.4, 0.8, { mat: solid(R.bronze, 0.9, 0) });
  for (let y = -half + 1; y <= half - 0.9; y += 3.4) m.box(-depth + 0.8, y, 20.4, 0.8, 1, 1, { mat: romanMasonry() });
  // The doors: open against the passage walls, or shut across it.
  if (v === 1) for (const side of [1, -1]) m.box(-depth + 1.4, side * 2, 5, 0.35, 2, 5, { mat: gateDoor });
  else for (const side of [1, -1]) m.box(-depth + 3.4, side * 3.9, 5, 2, 0.3, 5, { mat: gateDoor });
}

function gateMat(h: HitInfo, out: ShadeOut) {
  if (h.inner) {
    // The passage: dark, darker deeper in.
    out.ramp = R.black;
    out.dither = 0;
    out.tone = 0.8 - Math.abs(h.lx) * 0.12;
    return;
  }
  romanMasonry(R.marble)(h, out);
  // Voussoirs round the arch on both faces.
  const z = h.lz + 8.5;
  const r = Math.hypot(h.ly / 4.3, (z - 2) / 9.2);
  if (Math.abs(h.nx) > 0.5 && z > 5 && r < 1.3) {
    out.ramp = R.marble;
    out.tone = frac((Math.atan2(z - 2, h.ly) / Math.PI) * 11) < 0.15 ? 0.1 : 0.85;
  }
}

function gateDoor(h: HitInfo, out: ShadeOut) {
  out.ramp = R.woodDark;
  out.dither = 0;
  out.tone = frac((h.ly + h.lx) / 1.2) < 0.15 ? 0 : 0.7;
  if (Math.abs(Math.abs(h.lz) - 3) < 0.3) {
    out.ramp = R.iron;
    out.tone = 0.6;
  }
}

// --- Houses -------------------------------------------------------------------------------------------

const WALLS = [R.ochre, R.cream, R.coral, R.linen];

/**
 * Houses of the city: `v` 0 a townhouse round an atrium (a square opening in its roof), 1 a
 * two-storey house with a balcony, 2 a tall apartment block, 3 a row of shops under an awning.
 * Each about 12 to 16 across.
 */
export function house(target: Model, v: number) {
  const m = big(target, SCALE);
  const wallRamp = WALLS[v % WALLS.length];
  if (v % 4 === 0) {
    const hx = 8;
    const hy = 7;
    const hz = 3.6;
    m.box(0, 0, hz, hx, hy, hz, { mat: houseWalls(wallRamp, 1) });
    // A hipped roof sloping inward to the atrium's opening.
    const atrium = m.hole(0, 0, hz * 2 + 1.5, 2.6, 2.2, 2.2);
    m.box(0, 0, hz * 2 + 1.5, hx + 0.8, hy + 0.8, 1.5, { mat: tiles(false), clip: pyramidClips(hy + 0.8, 1.5), carve: atrium });
    m.box(0, 0, hz * 2 + 0.2, 2.5, 2.1, 0.1, { mat: solid(R.teal, 0.6, 0) });
    return;
  }
  if (v % 4 === 1) {
    const hx = 7;
    const hy = 6;
    const hz = 5.6;
    m.box(0, 0, hz, hx, hy, hz, { mat: houseWalls(wallRamp, 2) });
    m.box(0, 0, hz * 2 + 1.8, hx + 0.9, hy + 0.9, 1.8, { mat: tiles(true), clip: ridgeAlongX(hy + 0.9, 1.8) });
    // A wooden balcony along the front, on beams.
    m.box(hx + 0.9, 0, hz + 0.3, 0.9, hy - 1, 0.2, { mat: solid(R.wood, 0.4, 0) });
    m.box(hx + 1.7, 0, hz + 1.1, 0.1, hy - 1, 0.6, { mat: solid(R.woodDark, 0.4, 0) });
    return;
  }
  if (v % 4 === 2) {
    const hx = 7;
    const hy = 8;
    const hz = 8.2;
    m.box(0, 0, hz, hx, hy, hz, { mat: houseWalls(wallRamp, 3) });
    m.box(0, 0, hz * 2 + 1.6, hx + 0.8, hy + 0.8, 1.6, { mat: tiles(false), clip: ridgeAlongY(hx + 0.8, 1.6) });
    // Pots of flowers on the sills.
    for (const y of [-4, 0, 4]) m.box(hx + 0.35, y, 10.3, 0.3, 0.9, 0.3, { mat: solid(R.grass, 0.5, 0) });
    return;
  }
  // Shops: a long low block, an awning on poles over the counters.
  const hx = 5;
  const hy = 10;
  const hz = 3.2;
  m.box(0, 0, hz, hx, hy, hz, { mat: houseWalls(wallRamp, 1) });
  m.box(0, 0, hz * 2 + 1.2, hx + 0.7, hy + 0.7, 1.2, { mat: tiles(true), clip: ridgeAlongX(hy + 0.7, 1.2) });
  m.box(hx + 2.2, 0, 4.6, 2.2, hy - 0.5, 0.15, { mat: awning, rot: undefined });
  for (const y of [-hy + 1, hy - 1]) m.box(hx + 4.1, y, 2.3, 0.18, 0.18, 2.3, { mat: solid(R.woodDark, 0.5, 0) });
}

function houseWalls(ramp: number, storeys: number) {
  const base = plaster(ramp);
  return (h: HitInfo, out: ShadeOut) => {
    base(h, out);
    if (Math.abs(h.nz) > 0.5) return;
    // Small dark windows in rows, a door in the middle of the front on the ground floor.
    const along = Math.abs(h.nx) > 0.5 ? h.ly : h.lx;
    const storey = Math.floor(h.z / 3.6);
    const inStorey = h.z - storey * 3.6;
    const slot = frac((along + 50) / 3.4);
    if (storey < storeys && storey > 0 && inStorey > 1.2 && inStorey < 2.6 && slot > 0.35 && slot < 0.65) {
      out.ramp = R.woodDark;
      out.tone = 0.2;
    } else if (storey === 0 && Math.abs(along) < 1 && h.z < 2.8 && h.nx > 0.5) {
      out.ramp = R.woodDark;
      out.tone = 0.5;
    }
  };
}

function awning(h: HitInfo, out: ShadeOut) {
  out.dither = 0;
  const s = Math.floor((h.ly + 20) / 1.4) % 2;
  out.ramp = s ? R.crimson : R.cream;
  out.tone = s ? 0.35 : 0.65;
}

// --- The amphitheatre ---------------------------------------------------------------------------------

/**
 * The amphitheatre: an oval of three tiers of arches, the seating falling in rings to a sand arena.
 * About 80 by 64.
 */
export function amphitheatre(target: Model) {
  const m = big(target, 1.6);
  const rx = 40;
  const ry = 32;
  // Near-vertical outer walls: a very tall ellipsoid cut to 17 high, hollowed by a bowl.
  const bowl = m.cutter((c) => c.ellipsoid(0, 0, 19, rx - 7.5, ry - 7.5, 24, { mat: 0 }));
  m.ellipsoid(0, 0, 8.5, rx, ry, 70, { mat: arcades(rx, ry), clip: [0, 0, 1, 8.5, 0, 0, -1, 8.5], carve: bowl });
  m.ellipsoid(0, 0, 0.05, rx - 21, ry - 18, 0.06, { mat: arenaSand });
  // Awning masts round the rim.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    m.capsule([Math.cos(a) * (rx - 1), Math.sin(a) * (ry - 1), 17], [Math.cos(a) * (rx - 1), Math.sin(a) * (ry - 1), 20.5], 0.22, { mat: solid(R.woodDark, 0.5, 0) });
  }
}

function arcades(rx: number, ry: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.ochre;
    if (h.inner) {
      // Seating: rings of stone benches, aisles every so often.
      const a = Math.atan2(h.ly / ry, h.lx / rx);
      const aisle = frac((a / (Math.PI * 2)) * 20) < 0.06;
      out.ramp = aisle ? R.cream : R.ochre;
      out.tone = aisle ? 0.6 : frac((h.z + 20) / 1.3) < 0.35 ? -0.1 : 0.55;
      return;
    }
    if (h.nz > 0.9) {
      out.tone = 0.7;
      return;
    }
    // Three storeys of arches between pilasters, a solid attic on top.
    const a = Math.atan2(h.ly / ry, h.lx / rx);
    const bay = frac((a / (Math.PI * 2)) * 44);
    const z = h.z;
    const storey = Math.floor(z / 5);
    const inStorey = z - storey * 5;
    if (storey < 3 && Math.abs(bay - 0.5) < 0.3 && inStorey > 0.6 && (inStorey < 3.4 || (inStorey < 4.1 && Math.abs(bay - 0.5) < 0.18))) {
      out.ramp = R.woodDark;
      out.tone = storey === 0 ? 0.1 : 0.4;
      return;
    }
    out.tone = inStorey < 0.5 ? -0.3 : 0.45;
  };
}

function arenaSand(h: HitInfo, out: ShadeOut) {
  out.ramp = R.sand;
  out.dither = 0;
  out.tone = hash2(Math.floor(h.x * 1.5), Math.floor(h.y * 1.5)) > 0.9 ? -0.5 : 0.6;
}

// --- The aqueduct -------------------------------------------------------------------------------------

/** A run of the aqueduct along y: `bays` tall arches on piers, the water channel along the top. */
export function aqueduct(target: Model, bays: number) {
  const m = big(target, SCALE);
  const span = 9;
  const half = (bays * span) / 2;
  for (let i = 0; i < bays; i++) {
    const y = -half + span / 2 + i * span;
    const hole = m.cutter((c) => c.ellipsoid(0, y, 2, 12, 3.1, 12, { mat: 0 }));
    m.box(0, y, 9, 1.8, span / 2, 9, { mat: romanMasonry(R.ochre), carve: hole });
  }
  m.box(0, 0, 18.6, 2.1, half, 0.6, { mat: solid(R.stone, 0.6, 0) });
  m.box(0, 0, 19.5, 1.6, half, 0.3, { mat: solid(R.water, 0.9, 0) });
}

// --- The lighthouse -----------------------------------------------------------------------------------

/** The lighthouse on the mole: a square tower, an octagonal storey, a round lantern with a fire (`f` flickers). */
export function pharos(target: Model, f: number) {
  const m = big(target, SCALE);
  m.box(0, 0, 0.8, 9.5, 9.5, 0.8, { mat: romanMasonry(R.stone) });
  m.box(0, 0, 13, 7, 7, 11.4, { mat: lighthouseWalls });
  m.box(0, 0, 24.8, 7.8, 7.8, 0.4, { mat: solid(R.marble, 0.8, 0) });
  m.cylinder(0, 0, 30.5, 5, 5.3, { mat: lighthouseWalls });
  m.cylinder(0, 0, 36.2, 5.6, 0.4, { mat: solid(R.marble, 0.8, 0) });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    m.box(Math.cos(a) * 3.4, Math.sin(a) * 3.4, 39, 0.35, 0.35, 2.6, { mat: solid(R.marble, 0.6, 0) });
  }
  m.cylinder(0, 0, 41.9, 4.2, 0.4, { mat: solid(R.bronze, 0.7, 0) });
  // The fire, and the statue of a god on the dome.
  const flick = [0, 0.5, 0.25][f % 3];
  m.ellipsoid(0, 0, 38.4 + flick * 0.3, 2.4, 2.4, 2.4 + flick, { mat: fireMat });
  m.ellipsoid(0, 0, 39 + flick * 0.4, 1.3, 1.3, 1.6 + flick, { mat: (_h, out) => ((out.ramp = R.gold), (out.glow = 1), (out.tone = 1.6), (out.dither = 0)) });
  m.ellipsoid(0, 0, 44, 0.8, 0.8, 1.8, { mat: solid(R.bronze, 0.9, 0) });
}

function lighthouseWalls(h: HitInfo, out: ShadeOut) {
  romanMasonry(R.marble)(h, out);
  if (Math.abs(h.nz) > 0.5) return;
  // Windows climbing the tower.
  const along = Math.abs(h.nx) > Math.abs(h.ny) ? h.ly : h.lx;
  if (Math.abs(along) < 0.6 && frac(h.z / 5.2) > 0.45 && frac(h.z / 5.2) < 0.75) {
    out.ramp = R.black;
    out.tone = 0.4;
  }
}

function fireMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.fire;
  out.glow = 1;
  out.dither = 0;
  out.tone = 2.3 - (h.lz + 1.6) * 0.45;
}

// --- Trees, statues and fountains ---------------------------------------------------------------------

/** A cypress: a tall dark flame of a tree. `v` varies its height. */
export function cypress(target: Model, v: number) {
  const m = big(target, 2.6);
  const tall = 10 + (v % 3) * 2;
  m.capsule([0, 0, 0], [0, 0, 2], 0.5, { mat: solid(R.woodDark, 0.4, 0) });
  m.ellipsoid(0, 0, tall / 2 + 1.5, 2.3, 2.3, tall / 2 + 0.5, { mat: foliage(R.cypress, v) });
  m.ellipsoid(0.2, 0.1, tall + 1.6, 1.1, 1.1, 1.6, { mat: foliage(R.cypress, v + 3) });
}

/** An umbrella pine: a tall bare trunk and a broad flat crown. */
export function pine(target: Model, v: number) {
  const m = big(target, 2.1);
  const lean = ((v % 3) - 1) * 0.9;
  m.capsule([0, 0, 0], [lean, 0.4, 13], 0.7, { mat: solid(R.woodDark, 0.55, 0) });
  m.capsule([lean, 0.4, 11], [lean - 2.6, 1.6, 14], 0.4, { mat: solid(R.woodDark, 0.5, 0) });
  m.ellipsoid(lean - 0.5, 0.6, 15.6, 8.5, 7.5, 2.6, { mat: foliage(R.leaf, v) });
  m.ellipsoid(lean + 1.8, -0.8, 16.8, 5.5, 4.8, 2, { mat: foliage(R.leaf, v + 1) });
}

function foliage(ramp: number, seed: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = ramp;
    out.dither = 0.4;
    const n = fbm(h.x * 0.9 + seed * 7, h.y * 0.9 + h.z * 0.7);
    out.tone = 0.3 + (n > 0.62 ? 0.55 : n < 0.38 ? -0.55 : 0);
  };
}

/** A column of honour in the forum, a gilded eagle with spread wings on top. */
export function honourColumn(target: Model) {
  const m = big(target, 1.8);
  m.box(0, 0, 1.6, 2.6, 2.6, 1.6, { mat: marble });
  m.box(0, 0, 3.4, 2.9, 2.9, 0.25, { mat: solid(R.marble, 0.9, 0) });
  m.cylinder(0, 0, 12.4, 1.15, 9, { mat: spiral });
  m.box(0, 0, 21.8, 1.6, 1.6, 0.4, { mat: solid(R.marble, 0.8, 0) });
  const gold = solid(R.gold, 1.2, 0);
  m.ellipsoid(0, 0, 23.3, 0.8, 0.7, 1.1, { mat: gold });
  m.sphere(0.5, 0, 24.5, 0.5, { mat: gold });
  for (const side of [1, -1]) m.box(-0.1, side * 1.8, 24.2, 0.18, 1.4, 0.7, { mat: gold, rot: rotX(side * -0.55) });
}

/** The column's carved frieze winding up the shaft. */
function spiral(h: HitInfo, out: ShadeOut) {
  out.ramp = R.marble;
  out.dither = 0;
  const a = Math.atan2(h.ly, h.lx) / (Math.PI * 2);
  out.tone = frac(h.z / 2.2 + a) < 0.16 ? 0.1 : 0.7;
}

/** A round fountain: a stone basin brimming with water, a jet from a bronze spout. */
export function fountain(target: Model, f: number) {
  const m = big(target, 1.8);
  m.cylinder(0, 0, 1, 6, 1, { mat: marble });
  m.cylinder(0, 0, 1.75, 5.2, 0.3, { mat: water(f) });
  m.cylinder(0, 0, 3, 0.8, 2, { mat: solid(R.bronze, 0.7, 0) });
  m.cylinder(0, 0, 5.2, 1.8, 0.3, { mat: solid(R.marble, 0.7, 0) });
  m.ellipsoid(0, 0, 6.6 + (f % 2) * 0.2, 0.5, 0.5, 1.4, { mat: solid(R.foam, 1, 0), cast: false });
}

function water(f: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = R.water;
    out.dither = 0;
    const r = Math.hypot(h.lx, h.ly);
    out.tone = frac(r / 1.6 - f * 0.5) < 0.2 ? 1.3 : 0.6;
  };
}

/** A warehouse on the quay: a long hall under a tiled roof, arched doors along its front (+x). */
export function horreum(target: Model) {
  const m = big(target, SCALE);
  const hx = 6;
  const hy = 18;
  m.box(0, 0, 4.4, hx, hy, 4.4, { mat: warehouseWalls });
  m.box(0, 0, 10.4, hx + 0.8, hy + 0.8, 1.6, { mat: tiles(false), clip: ridgeAlongY(hx + 0.8, 1.6) });
}

function warehouseWalls(h: HitInfo, out: ShadeOut) {
  romanMasonry(R.ochre)(h, out);
  if (h.nx < 0.5) return;
  const slot = frac((h.ly + 50) / 6);
  const r = Math.hypot((slot - 0.5) * 6, h.z - 3.6);
  if ((Math.abs(slot - 0.5) * 6 < 1.6 && h.z < 3.6) || (h.z >= 3.6 && r < 1.6)) {
    out.ramp = R.woodDark;
    out.tone = 0.15;
  }
}

/** A banner on a pole above the towers and the gate: the legion's red and gold, or the Greeks' once they hold it. */
export function standard(target: Model, greek: number, wave: number) {
  const m = big(target, 2.2);
  m.capsule([0, 0, 0], [0, 0, 9], 0.2, { mat: solid(R.woodDark, 0.5, 0) });
  m.with(mul(translate(0, 0, 4.4), rotZ(Math.PI / 4)), () => banner(m, greek ? [R.blue, R.white] : [R.crimson, R.gold], wave));
}

/** Rocks breaking the sea's surface: a cluster of weathered boulders, `v` picks the cluster. */
export function rocks(target: Model, v: number) {
  const m = big(target, 1.6);
  const n = 4 + (v % 3);
  for (let i = 0; i < n; i++) {
    const a = i * 2.4 + v;
    const r = i === 0 ? 0 : 2.2 + (i % 2) * 1.4;
    const size = i === 0 ? 3.2 : 1.4 + ((i * 7 + v) % 3) * 0.5;
    m.ellipsoid(Math.cos(a) * r, Math.sin(a) * r, size * 0.35, size, size * 0.85, size * 0.8, { mat: boulder(v + i) });
  }
}

function boulder(seed: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = R.stone;
    out.dither = 0.3;
    const n = fbm(h.x * 0.8 + seed * 3.1, h.y * 0.8 + h.z * 0.6);
    out.tone = 0.2 + (n > 0.6 ? 0.5 : n < 0.4 ? -0.5 : 0) + (h.nz > 0.75 && n > 0.55 ? 0.3 : 0);
    // Wet and dark at the waterline, a little green weed.
    if (h.z < 0.6) out.tone -= 0.7;
    else if (h.z < 1.1 && n > 0.5) out.ramp = R.olive;
  };
}

/** A ruined shrine on an islet: three columns still standing, one fallen across the step. */
export function ruin(target: Model) {
  const m = big(target, 1.8);
  m.box(0, 0, 0.5, 6.5, 4.5, 0.5, { mat: romanMasonry(R.marble) });
  for (const [x, y, h] of [
    [-4.8, -3, 8],
    [-1.6, -3, 6],
    [4.8, -3, 8.5],
  ]) {
    m.cylinder(x, y, 1 + h / 2, 0.75, h / 2, { mat: fluted });
    m.box(x, y, 1 + h + 0.3, 1, 1, 0.3, { mat: solid(R.marble, 0.8, 0) });
  }
  m.box(-4.8 + 3.2, -3, 9.6, 3.5, 0.9, 0.5, { mat: solid(R.marble, 0.6, 0) });
  m.cylinder(1.8, 2.4, 1.75, 0.75, 3.6, { mat: fluted, rot: mul(rotZ(0.5), rotX(Math.PI / 2)) });
}
