import { rope, solid } from "../materials";
import { R } from "../palette";
import { hash2, type HitInfo, type Model, rotX, rotY, rotZ, type ShadeOut } from "../tracer";

// The Greek fleet: black-hulled triremes with a painted band and an eye at the bow, a bronze ram
// at the waterline, the stern sweeping up into a curled aphlaston, a bank of oars down each side,
// shields along the rails and a striped square sail. Built along +x (bow forward) around the
// ship's centre on the waterline; about 80 long, where a soldier is 20 tall.
//
// A ship is two sprites: the hull (with its oars, shields, ram and stern) and the rig (mast, yard,
// sail, lines). Soldiers on deck are drawn between them, so the sail hides the men behind the mast
// and not the men in front of it.

/** Each ship's colour: its painted band, its sail's stripe and some of its shields. */
export const SHIP_COLORS = [R.crimson, R.teal, R.gold, R.navy, R.olive, R.violet];

/** Oar frames: four strokes of rowing; OARS_IN has the oars pulled in (moored). */
export const ROW_FRAMES = 4;
export const OARS_IN = 4;

/** The hull's size: half its length, half its beam, and the deck's height. */
export const HULL = { half: 36, beam: 5.5, deck: 6 };

/** A gangplank: none, down the port side (moored alongside a quay), or down from the bow (run in bow first). */
export type Plank = 0 | 1 | 2;
/** Where a plank's foot rests on the quay, in the ship's frame: off the port side, or ahead of the bow. */
export const PLANK_FOOT = { side: { x: -21, y: -15 }, bow: { x: 49, y: -1.6 } };
/** Where a plank meets the deck, in the ship's frame. */
export const PLANK_HEAD = { side: { x: -7, y: -3.6 }, bow: { x: 28, y: -1.6 } };

const OAR_X = Array.from({ length: 12 }, (_, i) => -19 + i * 3.4);
const MAST_X = 4;

/**
 * A clip plane through two points of one coordinate plane ("xy", "xz" or "yz", in the box's own
 * frame), keeping the side the box's centre is on.
 */
function plane(axes: "xy" | "xz" | "yz", a: [number, number], b: [number, number]) {
  const du = b[0] - a[0];
  const dv = b[1] - a[1];
  const len = Math.hypot(du, dv);
  let nu = dv / len;
  let nv = -du / len;
  let c = nu * a[0] + nv * a[1];
  if (c < 0) {
    nu = -nu;
    nv = -nv;
    c = -c;
  }
  if (axes === "xy") return [nu, nv, 0, c];
  if (axes === "xz") return [nu, 0, nv, c];
  return [0, nu, nv, c];
}

/** The hull's clips (the box is centred half a deck up): pointed ends, raked bow and stern, a narrower bottom. */
function hullClips() {
  const { half, beam, deck } = HULL;
  const z = (world: number) => world - deck / 2;
  return [
    // Bow and stern come to a point in plan.
    ...plane("xy", [14, beam], [half + 1, 0]),
    ...plane("xy", [14, -beam], [half + 1, 0]),
    ...plane("xy", [-14, beam], [-half - 1, 0]),
    ...plane("xy", [-14, -beam], [-half - 1, 0]),
    // The bow rakes forward above the ram; the stern lifts out of the water.
    ...plane("xz", [30.5, z(0)], [36.8, z(deck)]),
    ...plane("xz", [-28.5, z(0)], [-36.8, z(deck)]),
    // The sides turn under below the oar ports.
    ...plane("yz", [beam - 2.2, z(0)], [beam, z(2.2)]),
    ...plane("yz", [-(beam - 2.2), z(0)], [-beam, z(2.2)]),
  ];
}

/**
 * The hull. `f`: 0..3 a stroke of the oars, OARS_IN with the oars pulled in. `color`: an index into
 * SHIP_COLORS. `plank`: a gangplank lowered from the stern or the bow.
 */
export function hull(m: Model, f: number, color: number, plank: Plank = 0) {
  const band = SHIP_COLORS[color % SHIP_COLORS.length];
  const { half, beam, deck } = HULL;
  // Where the hull meets the water: a ring of foam, whiter where the bow cuts the sea.
  m.ellipsoid(0.5, 0, 0.05, half + 1.2, beam + 1.3, 0.05, { mat: foamMat(f !== OARS_IN), cast: false });
  m.box(0, 0, deck / 2, half + 1, beam, deck / 2, { mat: hullMat(band), clip: hullClips() });
  // The ram: a bronze beak at the waterline with three fins, and the stem rising above it.
  m.frustum(37.6, 0, 0.75, 0.9, 0.3, 3, { mat: solid(R.bronze, 1, 0), rot: rotY(Math.PI / 2) });
  for (const zf of [0.15, 0.75, 1.35]) m.box(36.4, 0, zf, 2.8, 0.66 - Math.abs(zf - 0.75) * 0.3, 0.15, { mat: solid(R.bronze, zf === 0.75 ? 1.4 : 0.7, 0) });
  timber(m, [
    [35.8, 0, 5.6],
    [37.8, 0, 8.4],
    [37.4, 0, 11],
    [35.8, 0, 12.2],
    [34.8, 0, 11.4],
  ], 0.55, solid(band, 0.35, 0));
  // The aphlaston: the stern's timbers sweeping up and curling forward like a fan.
  for (const y of [-1.1, 0, 1.1]) {
    timber(m, [
      [-34.2, y * 0.6, 5.4],
      [-37.2, y * 0.85, 8.5],
      [-38.6, y, 12.4],
      [-37.6, y * 1.15, 15.8],
      [-35, y * 1.25, 17.2],
      [-33, y * 1.25, 16.2],
    ], 0.5, solid(y === 0 ? band : R.woodDark, y === 0 ? 0.5 : 0.35, 0));
  }
  // The helmsman's raised deck at the stern, and his two steering oars.
  m.box(-25.5, 0, deck + 0.45, 4.2, beam - 1.6, 0.45, { mat: solid(R.woodDark, 0.5, 0) });
  for (const side of [1, -1]) {
    m.capsule([-26.5, side * (beam - 0.4), deck + 1.6], [-34.5, side * (beam + 1.6), -0.2], 0.38, { mat: solid(R.woodDark, 0.45, 0) });
    m.box(-34.3, side * (beam + 1.55), 0.7, 1.5, 0.18, 1.1, { mat: solid(R.woodDark, 0.3, 0), rot: rotZ(side * 0.2) });
  }
  // Shields hung along both rails: bronze, white and the ship's colour.
  for (const side of [1, -1]) {
    for (let i = 0; i < 9; i++) {
      const x = -15.2 + i * 3.8;
      const ramp = [R.bronze, band, R.cream][i % 3];
      m.cylinder(x, side * (beam + 0.16), deck - 0.6, 1.3, 0.13, { mat: shieldMat(ramp), rot: rotX(Math.PI / 2) });
    }
  }
  // The oars, rowing; pulled in while moored.
  if (f !== OARS_IN) {
    const stroke = f % ROW_FRAMES;
    // Catch, drive, finish, recover: blades in forward, back through the water, out, forward again.
    const reach = [3.6, 0.6, -3.4, -0.4][stroke];
    const lift = [0.2, 0.1, 1.6, 3.1][stroke];
    for (const side of [1, -1]) {
      for (const x of OAR_X) {
        const port: [number, number, number] = [x, side * (beam + 0.1), 3.3];
        const blade: [number, number, number] = [x + reach, side * (beam + 10.5), lift];
        m.capsule(port, blade, 0.19, { mat: solid(R.woodPale, 0.2, 0) });
        const t = 0.78;
        m.capsule([port[0] + (blade[0] - port[0]) * t, port[1] + (blade[1] - port[1]) * t, port[2] + (blade[2] - port[2]) * t], blade, 0.4, { mat: solid(R.woodPale, 0.55, 0) });
      }
    }
  }
  if (plank === 1) gangplank(m, [PLANK_HEAD.side.x, PLANK_HEAD.side.y, deck + 0.4], [PLANK_FOOT.side.x, PLANK_FOOT.side.y, 0.15]);
  if (plank === 2) gangplank(m, [PLANK_HEAD.bow.x, PLANK_HEAD.bow.y, deck + 0.1], [PLANK_FOOT.bow.x, PLANK_FOOT.bow.y, 0.15]);
}

/** The rig: mast, yard, the sail set and full of wind (`sail` 1) or furled on the yard (0), and its lines. */
export function rig(m: Model, sail: number, color: number) {
  const band = SHIP_COLORS[color % SHIP_COLORS.length];
  const { deck, beam } = HULL;
  const top = 35;
  m.cylinder(MAST_X, 0, (deck + top) / 2, 0.6, (top - deck) / 2, { mat: solid(R.wood, 0.3, 0) });
  m.cylinder(MAST_X + 0.9, 0, top - 2.4, 0.38, 12.4, { mat: solid(R.woodDark, 0.45, 0), rot: rotX(Math.PI / 2) });
  // A pennant at the masthead.
  m.box(MAST_X - 1.2, 0, top + 0.5, 1.4, 0.08, 0.5, { mat: solid(band, 0.6, 0) });
  const line = solid(R.rope, 0.1, 0);
  // Forestay to the stem, backstay to the stern, shrouds to the rails.
  m.capsule([MAST_X, 0, top - 0.5], [36.6, 0, 11.6], 0.1, { mat: line, cast: false });
  m.capsule([MAST_X, 0, top - 0.5], [-35, 0, 16.6], 0.1, { mat: line, cast: false });
  for (const side of [1, -1]) m.capsule([MAST_X, side * 0.4, top - 4], [MAST_X - 3, side * (beam - 0.3), deck + 0.2], 0.08, { mat: line, cast: false });
  if (sail) {
    // A square sail bellying forward: a slice of a tall cylinder, 23 wide and 15 deep, hung from the yard.
    const half = 11.6;
    const belly = 2.4;
    const radius = (half * half + belly * belly) / (2 * belly);
    const front = MAST_X + 1.4;
    const cx = front + belly - radius;
    const z0 = top - 3.2;
    const z1 = z0 - 15;
    m.cylinder(cx, 0, (z0 + z1) / 2, radius, (z0 - z1) / 2, { mat: sailMat(band), clip: [-1, 0, 0, -(front - cx)] });
    // Sheets from the sail's lower corners back to the deck.
    for (const side of [1, -1]) m.capsule([front, side * half, z1 + 0.3], [-8, side * (beam - 0.6), deck + 0.4], 0.08, { mat: line, cast: false });
  } else {
    // Furled along the yard, bound with ties.
    m.cylinder(MAST_X + 1.3, 0, top - 3.6, 1.05, 11.2, { mat: furledMat, rot: rotX(Math.PI / 2) });
  }
}

/** One heading of the hull (eight headings, 0 = +x). */
export function hullModel(m: Model, dir: number, f: number, color: number, plank: Plank = 0) {
  m.with(rotZ(dir * (Math.PI / 4)), () => hull(m, f, color, plank));
}

export function rigModel(m: Model, dir: number, sail: number, color: number) {
  m.with(rotZ(dir * (Math.PI / 4)), () => rig(m, sail, color));
}

/** Where a soldier stands on deck: `i` along it (stern to bow, clear of the mast), `side` port or starboard. */
export function deckSpot(i: number, side: number) {
  const xs = [-19, -11, -3, 12, 20];
  return { x: xs[i % xs.length], y: side * 2.2, z: HULL.deck };
}

/** A smooth timber along points: capsules joint to joint. */
function timber(m: Model, points: Array<[number, number, number]>, r: number, mat: (h: HitInfo, out: ShadeOut) => void) {
  for (let i = 0; i < points.length - 1; i++) m.capsule(points[i], points[i + 1], r, { mat });
}

function gangplank(m: Model, from: [number, number, number], to: [number, number, number]) {
  m.capsule(from, to, 0.95, { mat: plankMat });
  // A rope rail along one side.
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ox = (-dy / len) * 1.2;
  const oy = (dx / len) * 1.2;
  m.capsule([from[0] + ox, from[1] + oy, from[2] + 1.6], [to[0] + ox, to[1] + oy, to[2] + 1.6], 0.09, { mat: solid(R.rope, 0, 0), cast: false });
}

function plankMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.woodPale;
  out.dither = 0;
  // Cleats across the plank.
  out.tone = (h.lz + 20) % 1.6 < 0.3 ? -0.5 : 0.35;
}

function hullMat(band: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    // The deck: planks along the ship, a darker gangway down the middle.
    if (h.nz > 0.9) {
      out.ramp = R.woodDark;
      const plank = Math.floor((h.ly + 20) / 1.15);
      const butt = (h.lx + plank * 7.3 + 100) % 11 < 0.35;
      out.tone = (Math.abs(h.ly) < 0.9 ? 1.25 : 0.65) + (hash2(plank, 5) - 0.5) * 0.3 + ((h.ly + 20) % 1.15 < 0.18 || butt ? -0.6 : 0);
      return;
    }
    const z = h.lz + HULL.deck / 2;
    // The ship's eye at the bow, to see its way across the sea.
    const ex = (h.lx - 27.6) / 2.5;
    const ez = (z - 3.7) / 1.25;
    const eye = ex * ex + ez * ez;
    if (eye < 1.4 && Math.abs(h.ly) > 0.5) {
      const pupil = ex * ex * 1.6 + ez * ez < 0.3;
      out.ramp = eye < 1 && !pupil ? R.white : R.black;
      out.tone = eye < 1 && !pupil ? 1 : pupil ? 0.1 : 0.6;
      return;
    }
    if (z > 5.4) {
      // The rail, pale against the tar.
      out.ramp = R.cream;
      out.tone = 0.7;
    } else if (z > 3.75) {
      // The painted band, with a running key of darker squares.
      out.ramp = band;
      out.tone = 0.6 + (Math.floor((h.lx + 100) / 1.6) % 2 === 0 && z > 4.25 && z < 4.95 ? -0.6 : 0);
    } else {
      out.ramp = R.black;
      // Tarred planking, and the oar ports along the top strake.
      const port = OAR_X.some((x) => Math.abs(h.lx - x) < 0.5) && Math.abs(z - 3.3) < 0.45;
      out.tone = port ? -1.2 : 1.05 + (Math.floor(z * 1.3) % 2 ? 0.28 : 0);
    }
  };
}

function sailMat(band: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    const y = h.ly;
    // Linen panels sewn edge to edge, a broad stripe of the ship's colour down the middle and at
    // the edges, a darker foot; the flat back is in shade.
    const panel = Math.floor((y + 30) / 2.9);
    const seam = (y + 30) % 2.9 < 0.35;
    const stripe = Math.abs(y) < 3 || Math.abs(y) > 10.2;
    out.ramp = stripe ? band : R.cream;
    out.tone = (stripe ? 0.55 : 0.85) + (panel % 2 ? 0.12 : -0.05) + (seam ? -0.4 : 0);
    if (h.lz < -6.2) {
      out.ramp = band;
      out.tone = 0.15;
    }
    if (h.nx < -0.9) out.tone -= 0.5;
  };
}

function furledMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.cream;
  out.dither = 0;
  out.tone = (h.lz + 20) % 2.6 < 0.45 ? -0.6 : 0.5;
}

function shieldMat(ramp: number) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    const r = Math.hypot(h.lx, h.ly);
    out.ramp = r > 1.0 ? R.bronze : ramp;
    out.tone = r > 1.0 ? 0.9 : 0.55;
    if (r < 0.32) {
      out.ramp = R.bronze;
      out.tone = 1.3;
    }
  };
}

function foamMat(moving: boolean) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = R.foam;
    out.dither = 1;
    // Whiter where the bow cuts the water when under way.
    out.tone = moving && h.lx > 24 ? 0.9 : 0;
  };
}

// --- The harbour's furniture ----------------------------------------------------------------------

/**
 * A wooden derrick for loading the ships: an A-frame, its boom swung out over the water, a net of
 * amphorae hanging from it.
 */
export function crane(m: Model) {
  const wood = solid(R.wood, 0.3, 0);
  for (const y of [-2.4, 2.4]) m.capsule([-1.5, y, 0.3], [0, y * 0.25, 15], 0.45, { mat: wood });
  m.capsule([1.8, 0, 0.3], [0, 0, 15], 0.4, { mat: wood });
  m.capsule([0, 0, 14], [11, -3, 18], 0.4, { mat: solid(R.woodDark, 0.4, 0) });
  m.capsule([11, -3, 18], [11, -3, 8.8], 0.1, { mat: rope() });
  m.sphere(11, -3, 7.2, 1.8, { mat: netMat });
  for (const [x, y] of [
    [10.4, -2.4],
    [11.6, -3.4],
  ]) m.frustum(x, y, 7.6, 0.55, 0.25, 0.7, { mat: solid(R.coral, 0.3, 0) });
  m.cylinder(-2.5, 0, 2, 0.8, 0.6, { mat: rope(), rot: rotX(Math.PI / 2) });
  m.box(0, 0, 0.3, 3.2, 3.2, 0.3, { mat: solid(R.woodDark, 0.4, 0) });
}

function netMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.rope;
  out.dither = 0;
  const a = Math.atan2(h.ly, h.lx) * 3;
  out.tone = Math.abs(Math.sin(a * 2)) < 0.25 || Math.abs(Math.sin(h.lz * 3)) < 0.25 ? 0.6 : -0.8;
}

/** Amphorae stacked in a rack, crates and a coil of rope, or a net drying on poles: `v` picks. */
export function cargo(m: Model, v: number) {
  const jar = (x: number, y: number, z: number, ramp: number, lying: boolean) => {
    if (lying) {
      m.ellipsoid(x, y, z, 1.9, 1.05, 1.05, { mat: solid(ramp, 0.4, 0) });
      m.frustum(x + 2.4, y, z, 0.38, 0.32, 0.6, { mat: solid(ramp, 0.2, 0), rot: rotY(Math.PI / 2) });
      return;
    }
    m.ellipsoid(x, y, z, 1.05, 1.05, 1.9, { mat: solid(ramp, 0.4, 0) });
    m.cylinder(x, y, z + 2.3, 0.4, 0.5, { mat: solid(ramp, 0.2, 0) });
    for (const s of [1, -1]) m.capsule([x, y + s * 0.45, z + 2.4], [x, y + s * 0.9, z + 1.2], 0.18, { mat: solid(ramp, 0.2, 0) });
  };
  if (v % 3 === 0) {
    for (let i = 0; i < 3; i++) jar(-2.4 + i * 2.4, 0, 1.9, i % 2 ? R.coral : R.tile, false);
    for (let i = 0; i < 2; i++) jar(-1.2 + i * 2.4, 2.4, 1.9, R.ochre, false);
    jar(0, -2.6, 1.05, R.coral, true);
  } else if (v % 3 === 1) {
    for (const [x, y, z] of [
      [0, 0, 1.4],
      [3, 0.4, 1.4],
      [1.5, 0.2, 4.2],
    ]) m.box(x, y, z, 1.4, 1.4, 1.4, { mat: crateMat });
    m.cylinder(-2.6, 1.6, 0.5, 1.6, 0.5, { mat: rope() });
  } else {
    for (const y of [-4, 4]) m.capsule([0, y, 0], [0, y, 7.5], 0.3, { mat: solid(R.woodDark, 0.4, 0) });
    m.box(0, 0, 5, 0.12, 4.2, 2.4, { mat: netMat, cast: false });
    m.box(0, 0, 7.4, 0.25, 4.4, 0.2, { mat: solid(R.wood, 0.3, 0) });
  }
}

function crateMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.wood;
  out.dither = 0;
  const edge = Math.max(Math.abs(h.lx), Math.abs(h.ly), Math.abs(h.lz));
  out.tone = edge > 1.15 ? -0.6 : Math.abs(h.lx + h.lz) < 0.18 || Math.abs(h.ly - h.lz) < 0.18 ? -0.3 : 0.45;
}

/** A stone mooring post with a rope round it. */
export function bollard(m: Model) {
  m.cylinder(0, 0, 1.3, 0.85, 1.3, { mat: solid(R.stone, 0.2, 0) });
  m.sphere(0, 0, 2.7, 0.95, { mat: solid(R.stone, 0.5, 0) });
  m.cylinder(0, 0, 1.6, 0.98, 0.3, { mat: rope() });
}

/** A harbour beacon: a round stone tower with a fire basket burning on top (`f` flickers). */
export function beacon(m: Model, f: number) {
  m.cylinder(0, 0, 7, 3.2, 7, { mat: masonryRound });
  m.cylinder(0, 0, 14.4, 3.7, 0.45, { mat: solid(R.stone, 0.6, 0) });
  m.frustum(0, 0, 15.6, 1.6, 2.4, 1.2, { mat: solid(R.iron, 0.6, 0) });
  const flick = [0, 0.6, 0.3][f % 3];
  m.ellipsoid(0, 0, 17.6 + flick * 0.4, 1.7, 1.7, 2.6 + flick, { mat: flameMat });
  m.ellipsoid(0.3, 0.2, 18.4 + flick * 0.5, 0.9, 0.9, 1.6 + flick, { mat: (_h, out) => ((out.ramp = R.gold), (out.glow = 1), (out.tone = 1.5), (out.dither = 0)) });
}

function masonryRound(h: HitInfo, out: ShadeOut) {
  out.ramp = R.stone;
  out.dither = 0;
  const row = Math.floor(h.z / 1.5);
  const a = Math.atan2(h.ly, h.lx) / (Math.PI * 2) + (row % 2) * 0.06;
  out.tone = h.z - row * 1.5 < 0.22 || a * 12 - Math.floor(a * 12) < 0.08 ? -0.9 : 0.35;
}

function flameMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.fire;
  out.glow = 1;
  out.dither = 0;
  out.tone = 2.4 - (h.lz + 1.5) * 0.5;
}
