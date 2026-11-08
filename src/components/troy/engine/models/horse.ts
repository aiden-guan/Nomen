import { deck, planks, rope, solid, torchlight, wheel } from "../materials";
import { R } from "../palette";
import { type HitInfo, Model, mul, rotX, rotY, rotZ, type ShadeOut, translate } from "../tracer";

// The Trojan horse: a wooden horse on a wheeled cart, facing +x. Its +y flank has double doors;
// once they swing open, a gangplank slides out of the belly and tips down to the sand, and the
// soldiers inside march down it.

export const HORSE = {
  sillY: 13.6,
  sillZ: 47.6,
  doorHalfWidth: 9.6,
  doorHeight: 22.4,
  plankLength: 62,
  plankHalfWidth: 6.2,
};

/** The plank's resting angle below horizontal: its foot touches the ground. */
export const PLANK_REST = Math.asin(HORSE.sillZ / HORSE.plankLength);

/** Points the soldiers walk through on their way out (world units). */
export function exitPath() {
  const footY = HORSE.sillY + HORSE.plankLength * Math.cos(PLANK_REST);
  return [
    { x: 0, y: HORSE.sillY - 5, z: HORSE.sillZ + 0.6 },
    { x: 0, y: HORSE.sillY + 0.5, z: HORSE.sillZ + 0.6 },
    { x: 0, y: footY - 1, z: 0.6 },
    { x: 0, y: footY + 5, z: 0 },
  ];
}

/**
 * Opening timeline, 0..1: the doors swing open in the first 40%, the plank slides out until 65%,
 * then tips down to the sand and settles with a small bounce.
 */
export function doorPose(t: number) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const ease = (v: number) => 1 - (1 - v) ** 3;
  const doors = ease(clamp(t / 0.4)) * 1.92;
  const slide = ease(clamp((t - 0.36) / 0.29));
  const tipT = clamp((t - 0.62) / 0.38);
  // Ease in (gravity) then a small rebound before settling.
  const tip = tipT < 0.72 ? (tipT / 0.72) ** 2 : 1 - Math.sin(((tipT - 0.72) / 0.28) * Math.PI) * 0.06;
  // The plank keeps sliding out while it tips, so its length never jumps.
  const extend = 0.5 * slide + 0.5 * ease(clamp((t - 0.62) / 0.24));
  return { doors, slide, extend, tip, glow: clamp(t / 0.3) };
}

const bodyPlanks = planks({ ramp: R.wood, row: 4.3, length: 19 });

export type HorseOptions = { t?: number; silhouettes?: boolean };

/** The whole horse at one moment of the opening (for previews and tests). */
export function horseModel(options: HorseOptions = {}) {
  const pose = doorPose(Math.max(0, Math.min(1, options.t ?? 0)));
  const m = horseBody({ glow: pose.glow, silhouettes: options.silhouettes });
  m.include(horseLeaves(pose.doors));
  if (pose.extend > 0.01) m.include(horsePlank(pose.extend, pose.tip));
  return m;
}

/** Cart, legs, body (with the doorway carved and lit), neck, head and tail. */
export function horseBody(options: { glow?: number; silhouettes?: boolean } = {}) {
  const glow = options.glow ?? 1;
  const torch = torchlight(glow, HORSE.sillZ, HORSE.doorHeight, HORSE.doorHalfWidth + 3);
  const m = new Model();

  // --- Cart -----------------------------------------------------------------------------
  m.box(0, 0, 11.5, 50, 18, 2.5, { mat: deck() });
  for (const x of [-34, 34]) m.box(x, 0, 7.6, 3, 16.5, 1.6, { mat: R.woodDark });
  for (const x of [-34, 34]) {
    for (const y of [-19.6, 19.6]) m.cylinder(x, y, 7.2, 7.2, 1.8, { mat: wheel(7.2, 1.8), rot: rotX(-Math.PI / 2) });
  }
  // Tow rope coiled at the front of the cart.
  m.cylinder(44, -8, 15, 3.4, 1.2, { mat: rope() });

  // --- Legs -----------------------------------------------------------------------------
  const legPlanks = planks({ ramp: R.wood, row: 3.6, length: 60, vary: 0.4 });
  for (const x of [-22, 22]) {
    for (const y of [-8.4, 8.4]) {
      m.box(x, y, 41, 4, 4, 6, { mat: legPlanks });
      m.box(x, y, 34.4, 3.9, 3.9, 0.9, { mat: R.iron });
      m.box(x, y, 25, 3.2, 3.2, 9, { mat: legPlanks });
      m.box(x, y, 16.2, 3.9, 3.9, 2.2, { mat: solid(R.woodDark, 0.6, 0) });
    }
  }

  // --- Body -----------------------------------------------------------------------------
  const hole = m.hole(0, HORSE.sillY, HORSE.sillZ + HORSE.doorHeight / 2, HORSE.doorHalfWidth, 7, HORSE.doorHeight / 2);
  const bodyMat = (h: HitInfo, out: ShadeOut) => {
    if (h.inner) return torch(h, out);
    bodyPlanks(h, out);
    if (Math.abs(Math.abs(h.x) - 20.5) < 1.2) {
      out.ramp = R.iron;
      out.tone = 0.3;
    }
  };
  m.box(0, 0, 60, 31, 13.6, 14, { mat: bodyMat, carve: hole, clip: [...chamfers(13.6, 14, 3.6, 1), ...chamfers(13.6, 14, 2.4, -1)] });
  m.ellipsoid(-27, 0, 61.4, 12, 14.2, 14.6, { mat: bodyPlanks });
  m.ellipsoid(25, 0, 60.5, 13, 14.2, 15.4, { mat: bodyPlanks });

  // Door frame around the opening.
  const frame = solid(R.woodDark, 0.6, 0);
  const fy = HORSE.sillY + 0.5;
  m.box(-HORSE.doorHalfWidth - 1.3, fy, HORSE.sillZ + 11.2, 1.3, 0.6, 11.9, { mat: frame });
  m.box(HORSE.doorHalfWidth + 1.3, fy, HORSE.sillZ + 11.2, 1.3, 0.6, 11.9, { mat: frame });
  m.box(0, fy, HORSE.sillZ + HORSE.doorHeight + 0.7, HORSE.doorHalfWidth + 2.6, 0.6, 1.2, { mat: frame });
  m.box(0, fy, HORSE.sillZ - 0.6, HORSE.doorHalfWidth + 2.6, 0.7, 0.7, { mat: frame });

  // --- Neck, head, mane -------------------------------------------------------------------
  const neckTilt = Math.atan2(16, 36);
  m.with(mul(translate(34, 0, 86), rotY(neckTilt)), () => {
    m.box(0, 0, 0, 8.2, 7.6, 20, { mat: planks({ ramp: R.wood, row: 4.1, length: 32 }) });
    for (let i = 0; i < 9; i++) {
      const s = i / 8;
      m.box(-8.6, 0, -14 + s * 30, 2.4, 2.7, 2.6, { mat: solid(R.woodDark, 0.6 + (i % 2) * 0.8, 0), rot: rotY(-0.55) });
    }
  });
  m.with(mul(translate(44.5, 0, 106.5), rotY(0.62)), () => {
    m.box(8.5, 0, -1.4, 11.5, 6.6, 6.6, { mat: headMat });
    m.box(19.4, 0, -2.8, 4.8, 5.8, 5.2, { mat: muzzleMat });
    m.box(3.5, 0, -7.4, 6, 5.9, 2.6, { mat: solid(R.wood, -0.1, 0) });
    m.box(-1.8, -4, 8.6, 1.8, 1.5, 3.4, { mat: R.wood, rot: rotX(-0.2) });
    m.box(-1.8, 4, 8.6, 1.8, 1.5, 3.4, { mat: R.wood, rot: rotX(0.2) });
    m.box(1.8, 0, 6.6, 2.8, 2.6, 1.6, { mat: solid(R.woodDark, 0.9, 0) });
    m.box(14, 0, -1.4, 1, 6.9, 7, { mat: solid(R.rope, 0, 0) });
  });

  // --- Tail -----------------------------------------------------------------------------
  for (const [dy, dz, len] of [
    [0, 0, 24],
    [-2.6, 1.4, 20],
    [2.6, 1.4, 20],
  ] as const) {
    m.capsule([-38.5, dy * 0.3, 67 + dz], [-46, dy, 67 + dz - len], 1.7, { mat: rope() });
  }

  // Soldiers waiting inside, dark against the torchlight.
  if (options.silhouettes !== false) {
    const dark = solid(R.fire, -7, 0);
    for (const [x, s] of [
      [-5.5, 1],
      [2.5, 0.96],
      [7.5, 0.9],
    ] as const) {
      const z = HORSE.sillZ;
      m.capsule([x, 9, z + 3], [x, 9, z + 9 * s], 2.8, { mat: dark, cast: false });
      m.sphere(x, 9, z + 13.2 * s, 2.4, { mat: dark, cast: false });
      m.box(x, 9, z + 16.4 * s, 0.8, 2.6, 1.3, { mat: dark, cast: false });
      m.capsule([x + 3, 9.5, z + 4], [x + 3.6, 9.5, z + 20], 0.5, { mat: dark, cast: false });
    }
  }
  return m;
}

/** Both door leaves, swung open by `angle` radians (0 = closed). */
export function horseLeaves(angle: number) {
  const m = new Model();
  const leafHalf = HORSE.doorHalfWidth / 2;
  const doorZ = HORSE.sillZ + HORSE.doorHeight / 2;
  m.with(mul(translate(-HORSE.doorHalfWidth, HORSE.sillY + 0.2, doorZ), rotZ(angle)), () => {
    m.box(leafHalf, 0.85, 0, leafHalf - 0.1, 0.85, HORSE.doorHeight / 2 - 0.1, { mat: leafMat(1) });
  });
  m.with(mul(translate(HORSE.doorHalfWidth, HORSE.sillY + 0.2, doorZ), rotZ(-angle)), () => {
    m.box(-leafHalf, 0.85, 0, leafHalf - 0.1, 0.85, HORSE.doorHeight / 2 - 0.1, { mat: leafMat(-1) });
  });
  return m;
}

/** The gangplank: `extend` of its length out of the belly, tipped `tip` of the way down. */
export function horsePlank(extend: number, tip: number) {
  const m = new Model();
  const reach = Math.max(0.5, extend * HORSE.plankLength);
  const angle = tip * PLANK_REST;
  // Pivot at the sill; the plank runs outward (+y) and tips down around it.
  m.with(mul(translate(0, HORSE.sillY, HORSE.sillZ), rotX(-angle)), () => {
    m.box(0, reach / 2 - 2, 0.6, HORSE.plankHalfWidth, reach / 2 + 2, 0.6, { mat: plankMat });
    for (const x of [-HORSE.plankHalfWidth - 0.6, HORSE.plankHalfWidth + 0.6]) {
      m.box(x, reach / 2 - 2, 1.5, 0.6, reach / 2 + 2, 1.5, { mat: solid(R.wood, -0.3, 0) });
    }
  });
  return m;
}

/** Planes bevelling the two edges along x of a box (top edges for side 1, bottom for side -1). */
function chamfers(hy: number, hz: number, size: number, side: 1 | -1) {
  const k = Math.SQRT1_2;
  const c = (hy + hz - size) * k;
  return [0, k, side * k, c, 0, -k, side * k, c];
}

function headMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.wood;
  out.tone = 0.15;
  out.dither = 0;
  // Eye on each side, a third of the way from the back of the head: dark socket with a glint.
  if (Math.abs(h.ny) > 0.85 && Math.abs(h.lx + 3.6) < 1.8 && Math.abs(h.lz - 1.6) < 1.6) {
    out.ramp = R.woodDark;
    out.tone = -3;
    if (h.lx > -3.2 && h.lz > 2.2) out.tone = 3.2;
  }
}

function muzzleMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.wood;
  out.tone = 0.25;
  out.dither = 0;
  // Nostril and a carved mouth line.
  if (Math.abs(h.ny) > 0.85 && Math.abs(h.lx - 2) < 1.2 && Math.abs(h.lz - 0.6) < 1) out.tone = -2.4;
  if (Math.abs(h.ny) > 0.85 && h.lz < -2.8 && h.lz > -3.6) out.tone = -1.8;
}

function leafMat(side: 1 | -1) {
  return (h: HitInfo, out: ShadeOut) => {
    out.dither = 0;
    out.ramp = R.wood;
    // Distance from the hinge (local coordinates are centred on the leaf).
    const u = h.lx * side + HORSE.doorHalfWidth / 2;
    const board = Math.floor((u + 20) / 3.2);
    const v = (((u + 20) / 3.2) % 1 + 1) % 1;
    out.tone = (((board * 37) % 7) / 7 - 0.5) * 0.5 + (v < 0.16 ? -1.5 : 0.25);
    if (Math.abs(h.lz - 6.5) < 1.1 || Math.abs(h.lz + 6.5) < 1.1) {
      out.ramp = R.iron;
      out.tone = 0.7;
    }
    // Ring handle near the free edge.
    const d = Math.hypot(u - 7.6, h.lz);
    if (d < 1.4 && d > 0.6) {
      out.ramp = R.iron;
      out.tone = 1.6;
    }
  };
}

function plankMat(h: HitInfo, out: ShadeOut) {
  out.ramp = R.woodPale;
  out.dither = 0;
  // Cleats across the walkway for footing.
  out.tone = h.nz > 0.5 && ((h.ly % 4.2) + 4.2) % 4.2 < 1 ? -1.5 : 0.2;
}
