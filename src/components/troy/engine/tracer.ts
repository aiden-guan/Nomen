// Troy engine: a small analytic ray tracer that bakes isometric pixel-art sprites.
//
// Models are unions of convex primitives (box, ellipsoid, cylinder, capsule, frustum), each optionally
// cut by planes and carved by one box. An orthographic 2:1 dimetric camera shoots one ray per art
// pixel; the hit is lit by a sun with hard shadows, mapped onto a hand-made colour ramp with ordered
// dithering, and edged with depth lines. Rays that miss land on an island ground whose rim dissolves
// into scattered pixels. Pure TypeScript, no DOM: it runs in the browser and in Node.

export type Mat3x4 = readonly [number, number, number, number, number, number, number, number, number, number, number, number];

/** What a material function fills in for one hit. `ramp` indexes PALETTE; `tone` shifts the level. */
export type ShadeOut = { ramp: number; tone: number; dither: number; glow: number; flat: number };

/** Everything a material can look at. Local coordinates are in the primitive's own frame. */
export type HitInfo = {
  x: number;
  y: number;
  z: number;
  lx: number;
  ly: number;
  lz: number;
  nx: number;
  ny: number;
  nz: number;
  /** Which face the ray entered through for a carved hole (1) or the outer surface (0). */
  inner: number;
  tag: number;
};

export type Material = number | ((hit: HitInfo, out: ShadeOut) => void);

export type Prim = {
  kind: number;
  cx: number;
  cy: number;
  cz: number;
  // Local axes expressed in world space (columns of the rotation).
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  ux: number;
  uy: number;
  uz: number;
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  clip: Float64Array | null;
  carve: Prim | null;
  mat: Material;
  tag: number;
  cast: boolean;
  // World-space bounding sphere.
  sx: number;
  sy: number;
  sz: number;
  sr: number;
};

export const KIND = { box: 0, ellipsoid: 1, cylinder: 2, capsule: 3, frustum: 4 } as const;

// ---------------------------------------------------------------------------------------------
// Camera. Screen x = x - y, screen y = (x + y) / 2 - 1.2247 z, in art pixels per world unit.

export const PPU = Math.SQRT2;
const RX = Math.SQRT1_2;
const RY = -Math.SQRT1_2;
const UX = -0.3535533905932738;
const UY = -0.3535533905932738;
const UZ = 0.8660254037844386;
const DX = -0.6123724356957945;
const DY = -0.6123724356957945;
const DZ = -0.5;
const Z_SCALE = 1.224744871391589;
const FAR = 2000;

export function projectX(x: number, y: number) {
  return x - y;
}

export function projectY(x: number, y: number, z: number) {
  return 0.5 * (x + y) - Z_SCALE * z;
}

/** World point on the ground plane (z = h) under a screen point. */
export function unprojectGround(sx: number, sy: number, h = 0) {
  // sx = x - y ; sy + Z h = (x + y) / 2
  const sum = 2 * (sy + Z_SCALE * h);
  return { x: (sum + sx) / 2, y: (sum - sx) / 2 };
}

// ---------------------------------------------------------------------------------------------
// Palette: ramps from darkest to lightest, hand-tuned so shadows lean cool and highlights warm.

export const PALETTE: number[][] = [];
const rampIndex = new Map<string, number>();

export function defineRamp(name: string, colors: string[]) {
  const existing = rampIndex.get(name);
  const parsed = colors.map((hex) => Number.parseInt(hex.replace("#", ""), 16));
  if (existing !== undefined) {
    PALETTE[existing] = parsed;
    return existing;
  }
  PALETTE.push(parsed);
  rampIndex.set(name, PALETTE.length - 1);
  return PALETTE.length - 1;
}

export function ramp(name: string) {
  const index = rampIndex.get(name);
  if (index === undefined) throw new Error(`unknown ramp ${name}`);
  return index;
}

// ---------------------------------------------------------------------------------------------
// Noise helpers shared by materials and grounds.

export function hash2(x: number, y: number) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hash3(x: number, y: number, z: number) {
  return hash2(x + Math.imul(z | 0, 1442695041), y - Math.imul(z | 0, 2246822519));
}

export function valueNoise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function fbm(x: number, y: number, octaves = 3) {
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * freq, y * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return total / (1 - 0.5 ** octaves);
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export function bayer(x: number, y: number) {
  return BAYER4[(y & 3) * 4 + (x & 3)];
}

// ---------------------------------------------------------------------------------------------
// Ray / primitive intersection. Results land in these module-level slots to avoid allocation.

let tIn = 0;
let tOut = 0;
let nInX = 0;
let nInY = 0;
let nInZ = 0;
let nOutX = 0;
let nOutY = 0;
let nOutZ = 0;
let inner = 0;
// Local-space ray of the last primitive tested (materials read local coordinates from it).
let lox = 0;
let loy = 0;
let loz = 0;
let ldx = 0;
let ldy = 0;
let ldz = 0;

function toLocal(p: Prim, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
  const rx = ox - p.cx;
  const ry = oy - p.cy;
  const rz = oz - p.cz;
  lox = rx * p.ax + ry * p.ay + rz * p.az;
  loy = rx * p.bx + ry * p.by + rz * p.bz;
  loz = rx * p.ux + ry * p.uy + rz * p.uz;
  ldx = dx * p.ax + dy * p.ay + dz * p.az;
  ldy = dx * p.bx + dy * p.by + dz * p.bz;
  ldz = dx * p.ux + dy * p.uy + dz * p.uz;
}

// Local-space interval of the convex shape; normals are local here and rotated later.
let lInX = 0;
let lInY = 0;
let lInZ = 0;
let lOutX = 0;
let lOutY = 0;
let lOutZ = 0;

// Slab state shared by the three unrolled axis tests of boxLocal.
let slab0 = 0;
let slab1 = 0;
let slabIn = -1;
let slabOut = -1;
let slabInSign = 0;
let slabOutSign = 0;

function slab(axis: number, o: number, d: number, h: number) {
  if (d > -1e-12 && d < 1e-12) return o >= -h && o <= h;
  const inv = 1 / d;
  let a = (-h - o) * inv;
  let b = (h - o) * inv;
  let sa = -1;
  if (a > b) {
    const tmp = a;
    a = b;
    b = tmp;
    sa = 1;
  }
  if (a > slab0) {
    slab0 = a;
    slabIn = axis;
    slabInSign = sa;
  }
  if (b < slab1) {
    slab1 = b;
    slabOut = axis;
    slabOutSign = -sa;
  }
  return slab0 <= slab1;
}

function boxLocal(hx: number, hy: number, hz: number) {
  slab0 = -Infinity;
  slab1 = Infinity;
  slabIn = -1;
  slabOut = -1;
  if (!slab(0, lox, ldx, hx) || !slab(1, loy, ldy, hy) || !slab(2, loz, ldz, hz)) return false;
  tIn = slab0;
  tOut = slab1;
  lInX = slabIn === 0 ? slabInSign : 0;
  lInY = slabIn === 1 ? slabInSign : 0;
  lInZ = slabIn === 2 ? slabInSign : 0;
  lOutX = slabOut === 0 ? slabOutSign : 0;
  lOutY = slabOut === 1 ? slabOutSign : 0;
  lOutZ = slabOut === 2 ? slabOutSign : 0;
  return true;
}

function ellipsoidLocal(a: number, b: number, c: number) {
  const ox = lox / a;
  const oy = loy / b;
  const oz = loz / c;
  const dx = ldx / a;
  const dy = ldy / b;
  const dz = ldz / c;
  const A = dx * dx + dy * dy + dz * dz;
  const B = ox * dx + oy * dy + oz * dz;
  const C = ox * ox + oy * oy + oz * oz - 1;
  const disc = B * B - A * C;
  if (disc < 0) return false;
  const s = Math.sqrt(disc);
  tIn = (-B - s) / A;
  tOut = (-B + s) / A;
  let px = lox + ldx * tIn;
  let py = loy + ldy * tIn;
  let pz = loz + ldz * tIn;
  lInX = px / (a * a);
  lInY = py / (b * b);
  lInZ = pz / (c * c);
  px = lox + ldx * tOut;
  py = loy + ldy * tOut;
  pz = loz + ldz * tOut;
  lOutX = px / (a * a);
  lOutY = py / (b * b);
  lOutZ = pz / (c * c);
  return true;
}

function cylinderLocal(r: number, h: number) {
  let t0 = -Infinity;
  let t1 = Infinity;
  let inSide = true;
  let outSide = true;
  const A = ldx * ldx + ldy * ldy;
  const C = lox * lox + loy * loy - r * r;
  if (A < 1e-12) {
    if (C > 0) return false;
  } else {
    const B = lox * ldx + loy * ldy;
    const disc = B * B - A * C;
    if (disc < 0) return false;
    const s = Math.sqrt(disc);
    t0 = (-B - s) / A;
    t1 = (-B + s) / A;
  }
  if (Math.abs(ldz) < 1e-12) {
    if (loz < -h || loz > h) return false;
  } else {
    let a = (-h - loz) / ldz;
    let b = (h - loz) / ldz;
    if (a > b) {
      const tmp = a;
      a = b;
      b = tmp;
    }
    if (a > t0) {
      t0 = a;
      inSide = false;
    }
    if (b < t1) {
      t1 = b;
      outSide = false;
    }
  }
  if (t0 > t1) return false;
  tIn = t0;
  tOut = t1;
  if (inSide) {
    lInX = lox + ldx * t0;
    lInY = loy + ldy * t0;
    lInZ = 0;
  } else {
    lInX = 0;
    lInY = 0;
    lInZ = ldz > 0 ? -1 : 1;
  }
  if (outSide) {
    lOutX = lox + ldx * t1;
    lOutY = loy + ldy * t1;
    lOutZ = 0;
  } else {
    lOutX = 0;
    lOutY = 0;
    lOutZ = ldz > 0 ? 1 : -1;
  }
  return true;
}

function sphereAt(cz: number, r: number) {
  const oz = loz - cz;
  const B = lox * ldx + loy * ldy + oz * ldz;
  const A = ldx * ldx + ldy * ldy + ldz * ldz;
  const C = lox * lox + loy * loy + oz * oz - r * r;
  const disc = B * B - A * C;
  if (disc < 0) return false;
  const s = Math.sqrt(disc);
  tIn = (-B - s) / A;
  tOut = (-B + s) / A;
  lInX = lox + ldx * tIn;
  lInY = loy + ldy * tIn;
  lInZ = oz + ldz * tIn;
  lOutX = lox + ldx * tOut;
  lOutY = loy + ldy * tOut;
  lOutZ = oz + ldz * tOut;
  return true;
}

// Accumulator for shapes built from several surfaces (capsule, frustum): outermost entry and exit.
let acc0 = 0;
let acc1 = 0;
let acc0x = 0;
let acc0y = 0;
let acc0z = 0;
let acc1x = 0;
let acc1y = 0;
let acc1z = 0;

function accReset() {
  acc0 = Infinity;
  acc1 = -Infinity;
}

function accTake(t0: number, n0x: number, n0y: number, n0z: number, t1: number, n1x: number, n1y: number, n1z: number) {
  if (t0 < acc0) {
    acc0 = t0;
    acc0x = n0x;
    acc0y = n0y;
    acc0z = n0z;
  }
  if (t1 > acc1) {
    acc1 = t1;
    acc1x = n1x;
    acc1y = n1y;
    acc1z = n1z;
  }
}

function accFinish() {
  if (!(acc0 < acc1)) return false;
  tIn = acc0;
  tOut = acc1;
  lInX = acc0x;
  lInY = acc0y;
  lInZ = acc0z;
  lOutX = acc1x;
  lOutY = acc1y;
  lOutZ = acc1z;
  return true;
}

function capsuleLocal(r: number, h: number) {
  // Union of an uncapped cylinder and two spheres; the union is convex, so merge the intervals.
  accReset();
  const A = ldx * ldx + ldy * ldy;
  if (A > 1e-12) {
    const B = lox * ldx + loy * ldy;
    const C = lox * lox + loy * loy - r * r;
    const disc = B * B - A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const a = (-B - s) / A;
      const b = (-B + s) / A;
      const za = loz + ldz * a;
      const zb = loz + ldz * b;
      if (za >= -h && za <= h) accTake(a, lox + ldx * a, loy + ldy * a, 0, -Infinity, 0, 0, 0);
      if (zb >= -h && zb <= h) accTake(Infinity, 0, 0, 0, b, lox + ldx * b, loy + ldy * b, 0);
    }
  }
  if (sphereAt(-h, r)) accTake(tIn, lInX, lInY, lInZ, tOut, lOutX, lOutY, lOutZ);
  if (sphereAt(h, r)) accTake(tIn, lInX, lInY, lInZ, tOut, lOutX, lOutY, lOutZ);
  return accFinish();
}

function frustumSide(t: number, m: number, s: number, h: number) {
  const z = loz + ldz * t;
  if (z < -h || z > h) return;
  const k = m + s * z;
  if (k < 0) return;
  const nx = lox + ldx * t;
  const ny = loy + ldy * t;
  accTake(t, nx, ny, -s * k, t, nx, ny, -s * k);
}

function frustumLocal(r0: number, r1: number, h: number) {
  // Radius r0 at z = -h, r1 at z = +h. Collect every valid surface crossing, keep the outermost two.
  const s = (r1 - r0) / (2 * h);
  const m = (r0 + r1) / 2;
  accReset();
  const k0 = m + s * loz;
  const A = ldx * ldx + ldy * ldy - s * s * ldz * ldz;
  const B = lox * ldx + loy * ldy - s * ldz * k0;
  const C = lox * lox + loy * loy - k0 * k0;
  if (Math.abs(A) > 1e-12) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const q = Math.sqrt(disc);
      frustumSide((-B - q) / A, m, s, h);
      frustumSide((-B + q) / A, m, s, h);
    }
  } else if (Math.abs(B) > 1e-12) {
    frustumSide(-C / (2 * B), m, s, h);
  }
  if (Math.abs(ldz) > 1e-12) {
    const tb = (-h - loz) / ldz;
    const xb = lox + ldx * tb;
    const yb = loy + ldy * tb;
    if (xb * xb + yb * yb <= r0 * r0) accTake(tb, 0, 0, -1, tb, 0, 0, -1);
    const tt = (h - loz) / ldz;
    const xt = lox + ldx * tt;
    const yt = loy + ldy * tt;
    if (xt * xt + yt * yt <= r1 * r1) accTake(tt, 0, 0, 1, tt, 0, 0, 1);
  }
  return accFinish();
}

function shapeLocal(p: Prim) {
  switch (p.kind) {
    case 0:
      return boxLocal(p.p0, p.p1, p.p2);
    case 1:
      return ellipsoidLocal(p.p0, p.p1, p.p2);
    case 2:
      return cylinderLocal(p.p0, p.p1);
    case 3:
      return capsuleLocal(p.p0, p.p1);
    default:
      return frustumLocal(p.p0, p.p1, p.p2);
  }
}

function applyClips(clip: Float64Array) {
  for (let i = 0; i < clip.length; i += 4) {
    const nx = clip[i];
    const ny = clip[i + 1];
    const nz = clip[i + 2];
    const c = clip[i + 3];
    const nd = nx * ldx + ny * ldy + nz * ldz;
    const no = nx * lox + ny * loy + nz * loz;
    if (Math.abs(nd) < 1e-12) {
      if (no > c) return false;
      continue;
    }
    const t = (c - no) / nd;
    if (nd > 0) {
      if (t < tOut) {
        tOut = t;
        lOutX = nx;
        lOutY = ny;
        lOutZ = nz;
      }
    } else if (t > tIn) {
      tIn = t;
      lInX = nx;
      lInY = ny;
      lInZ = nz;
    }
    if (tIn > tOut) return false;
  }
  return true;
}

function toWorldNormals(p: Prim) {
  let x = lInX * p.ax + lInY * p.bx + lInZ * p.ux;
  let y = lInX * p.ay + lInY * p.by + lInZ * p.uy;
  let z = lInX * p.az + lInY * p.bz + lInZ * p.uz;
  let len = Math.hypot(x, y, z) || 1;
  nInX = x / len;
  nInY = y / len;
  nInZ = z / len;
  x = lOutX * p.ax + lOutY * p.bx + lOutZ * p.ux;
  y = lOutX * p.ay + lOutY * p.by + lOutZ * p.uy;
  z = lOutX * p.az + lOutY * p.bz + lOutZ * p.uz;
  len = Math.hypot(x, y, z) || 1;
  nOutX = x / len;
  nOutY = y / len;
  nOutZ = z / len;
}

/** Entry and exit of a ray through a primitive (world normals), honouring clips and its carve. */
function interval(p: Prim, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean {
  toLocal(p, ox, oy, oz, dx, dy, dz);
  if (!shapeLocal(p)) return false;
  if (p.clip && !applyClips(p.clip)) return false;
  toWorldNormals(p);
  inner = 0;
  if (p.carve) {
    const aIn = tIn;
    const aOut = tOut;
    const anx = nInX;
    const any = nInY;
    const anz = nInZ;
    const aox = nOutX;
    const aoy = nOutY;
    const aoz = nOutZ;
    if (interval(p.carve, ox, oy, oz, dx, dy, dz) && tIn <= aIn + 1e-9 && tOut > aIn) {
      // The hole covers our entry: we enter through the hole's far wall, seen from inside.
      if (tOut >= aOut) return false;
      tIn = tOut;
      nInX = -nOutX;
      nInY = -nOutY;
      nInZ = -nOutZ;
      tOut = aOut;
      inner = 1;
    } else {
      tIn = aIn;
      tOut = aOut;
      nInX = anx;
      nInY = any;
      nInZ = anz;
      inner = 0;
    }
    nOutX = aox;
    nOutY = aoy;
    nOutZ = aoz;
    // The carve test moved the local ray into the hole's frame; put ours back.
    toLocal(p, ox, oy, oz, dx, dy, dz);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Modeling: a transform stack and primitive constructors.

export const IDENTITY: Mat3x4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function mul(a: Mat3x4, b: Mat3x4): Mat3x4 {
  return [
    a[0] * b[0] + a[1] * b[4] + a[2] * b[8],
    a[0] * b[1] + a[1] * b[5] + a[2] * b[9],
    a[0] * b[2] + a[1] * b[6] + a[2] * b[10],
    a[0] * b[3] + a[1] * b[7] + a[2] * b[11] + a[3],
    a[4] * b[0] + a[5] * b[4] + a[6] * b[8],
    a[4] * b[1] + a[5] * b[5] + a[6] * b[9],
    a[4] * b[2] + a[5] * b[6] + a[6] * b[10],
    a[4] * b[3] + a[5] * b[7] + a[6] * b[11] + a[7],
    a[8] * b[0] + a[9] * b[4] + a[10] * b[8],
    a[8] * b[1] + a[9] * b[5] + a[10] * b[9],
    a[8] * b[2] + a[9] * b[6] + a[10] * b[10],
    a[8] * b[3] + a[9] * b[7] + a[10] * b[11] + a[11],
  ];
}

export const translate = (x: number, y: number, z: number): Mat3x4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];

export function rotX(a: number): Mat3x4 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}

export function rotY(a: number): Mat3x4 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
}

export function rotZ(a: number): Mat3x4 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

/** A rotation whose local z axis points along (x, y, z). */
export function alignZ(x: number, y: number, z: number): Mat3x4 {
  const len = Math.hypot(x, y, z) || 1;
  const wx = x / len;
  const wy = y / len;
  const wz = z / len;
  // Pick a helper not parallel to w.
  const hx = Math.abs(wz) < 0.9 ? 0 : 1;
  const hz = Math.abs(wz) < 0.9 ? 1 : 0;
  // u = normalize(h x w), v = w x u
  let ux = 0 * wz - hz * wy;
  let uy = hz * wx - hx * wz;
  let uz = hx * wy - 0 * wx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = wy * uz - wz * uy;
  const vy = wz * ux - wx * uz;
  const vz = wx * uy - wy * ux;
  return [ux, vx, wx, 0, uy, vy, wy, 0, uz, vz, wz, 0];
}

type PrimOptions = { mat: Material; rot?: Mat3x4; clip?: number[]; carve?: Prim | null; tag?: number; cast?: boolean };

export class Model {
  readonly prims: Prim[] = [];
  private stack: Mat3x4[] = [IDENTITY];

  get frame() {
    return this.stack[this.stack.length - 1];
  }

  /** Runs `build` with `m` applied on top of the current frame. */
  with(m: Mat3x4, build: () => void) {
    this.stack.push(mul(this.frame, m));
    try {
      build();
    } finally {
      this.stack.pop();
    }
  }

  private make(kind: number, x: number, y: number, z: number, p: [number, number, number, number], radius: number, o: PrimOptions): Prim {
    const f = o.rot ? mul(this.frame, mul(translate(x, y, z), o.rot)) : mul(this.frame, translate(x, y, z));
    const prim: Prim = {
      kind,
      cx: f[3],
      cy: f[7],
      cz: f[11],
      ax: f[0],
      ay: f[4],
      az: f[8],
      bx: f[1],
      by: f[5],
      bz: f[9],
      ux: f[2],
      uy: f[6],
      uz: f[10],
      p0: p[0],
      p1: p[1],
      p2: p[2],
      p3: p[3],
      clip: o.clip ? Float64Array.from(o.clip) : null,
      carve: o.carve ?? null,
      mat: o.mat,
      tag: o.tag ?? 0,
      cast: o.cast ?? true,
      sx: f[3],
      sy: f[7],
      sz: f[11],
      sr: radius,
    };
    return prim;
  }

  private add(prim: Prim) {
    this.prims.push(prim);
    return prim;
  }

  /** Box centred at (x, y, z) with half extents (hx, hy, hz). */
  box(x: number, y: number, z: number, hx: number, hy: number, hz: number, o: PrimOptions) {
    return this.add(this.make(KIND.box, x, y, z, [hx, hy, hz, 0], Math.hypot(hx, hy, hz), o));
  }

  /** A box that is not drawn, for carving a hole into another primitive. */
  hole(x: number, y: number, z: number, hx: number, hy: number, hz: number, rot?: Mat3x4) {
    return this.make(KIND.box, x, y, z, [hx, hy, hz, 0], Math.hypot(hx, hy, hz), { mat: 0, rot });
  }

  /**
   * A primitive of any shape that is not drawn, for carving a hole into another one (an arch is an
   * ellipsoid, a bowl a sphere): `build` makes it on a scratch model in this model's frame.
   */
  cutter(build: (scratch: Model) => Prim): Prim {
    const scratch = new Model();
    scratch.stack = [this.frame];
    return build(scratch);
  }

  ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number, o: PrimOptions) {
    return this.add(this.make(KIND.ellipsoid, x, y, z, [rx, ry, rz, 0], Math.max(rx, ry, rz), o));
  }

  sphere(x: number, y: number, z: number, r: number, o: PrimOptions) {
    return this.ellipsoid(x, y, z, r, r, r, o);
  }

  /** Cylinder along its local z (use `rot`), radius r, half height h. */
  cylinder(x: number, y: number, z: number, r: number, h: number, o: PrimOptions) {
    return this.add(this.make(KIND.cylinder, x, y, z, [r, h, 0, 0], Math.hypot(r, h), o));
  }

  /** Capsule between two points, radius r. */
  capsule(a: [number, number, number], b: [number, number, number], r: number, o: Omit<PrimOptions, "rot">) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const half = Math.hypot(dx, dy, dz) / 2;
    return this.add(this.make(KIND.capsule, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, [r, half, 0, 0], half + r, { ...o, rot: alignZ(dx, dy, dz) }));
  }

  /** Truncated cone along local z: radius r0 at the bottom (z - h), r1 at the top (z + h). */
  frustum(x: number, y: number, z: number, r0: number, r1: number, h: number, o: PrimOptions) {
    return this.add(this.make(KIND.frustum, x, y, z, [r0, r1, h, 0], Math.hypot(Math.max(r0, r1), h), o));
  }

  /** Appends every primitive of another model, transformed by the current frame. */
  include(other: Model) {
    for (const p of other.prims) this.add(transformPrim(p, this.frame));
  }
}

function transformPrim(p: Prim, f: Mat3x4): Prim {
  const t = (x: number, y: number, z: number) => [f[0] * x + f[1] * y + f[2] * z + f[3], f[4] * x + f[5] * y + f[6] * z + f[7], f[8] * x + f[9] * y + f[10] * z + f[11]];
  const r = (x: number, y: number, z: number) => [f[0] * x + f[1] * y + f[2] * z, f[4] * x + f[5] * y + f[6] * z, f[8] * x + f[9] * y + f[10] * z];
  const [cx, cy, cz] = t(p.cx, p.cy, p.cz);
  const [ax, ay, az] = r(p.ax, p.ay, p.az);
  const [bx, by, bz] = r(p.bx, p.by, p.bz);
  const [ux, uy, uz] = r(p.ux, p.uy, p.uz);
  const [sx, sy, sz] = t(p.sx, p.sy, p.sz);
  return { ...p, cx, cy, cz, ax, ay, az, bx, by, bz, ux, uy, uz, sx, sy, sz, carve: p.carve ? transformPrim(p.carve, f) : null };
}

// ---------------------------------------------------------------------------------------------
// Baking.

export type Ground = {
  /** Signed distance to the island rim in world units: negative inside. */
  sdf: (x: number, y: number) => number;
  /** Ground colour at a point (ramp and tone), before light and shadow. */
  shade: (x: number, y: number, out: ShadeOut) => void;
  /** World-space rectangle that contains the island. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Width of the dissolving rim band, in world units. */
  rim: number;
  /** Ramp levels of sunlit and shadowed ground (defaults 4 and 2.2). */
  lit?: number;
  dark?: number;
  /** How many ramp levels the contact darkening under objects can take away (default 1.2). */
  ao?: number;
  /** Height of the ground plane. */
  z?: number;
};

export type BakeOptions = {
  ground?: Ground | null;
  /** Direction toward the sun. */
  sun?: [number, number, number];
  /** Darken the far side of depth discontinuities (lines between overlapping parts). */
  edges?: boolean;
  /** Draw a one-pixel rim in the darkest tone of the touching colour around the silhouette. */
  outline?: boolean;
  /** Extra transparent margin around the content, in pixels. */
  pad?: number;
  /** Fixed canvas (for animation frames that must share an anchor). */
  frame?: { w: number; h: number; ax: number; ay: number };
  /** Shadows from primitives that are not part of the sprite (for example a building nearby). */
  shadowCasters?: Prim[];
  /** Skip drawing the ground where it would be fully lit (shadow-only layers for moving parts). */
  shadowOnly?: boolean;
  /**
   * Primitives drawn by another layer in front of this one: they hide whatever is behind them
   * (output stays transparent there) and cast shadows, but are not drawn themselves.
   */
  holdouts?: Prim[];
};

export type Sprite = {
  w: number;
  h: number;
  /** Pixel position of the world origin inside the sprite. */
  ax: number;
  ay: number;
  rgba: Uint8ClampedArray;
};

// From the upper left: tops brightest, left-front faces lit, right-front faces in shade, and
// shadows falling to the right like the references.
const DEFAULT_SUN: [number, number, number] = normalize3(-0.62, 0.32, 0.72);

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

const shade: ShadeOut = { ramp: 0, tone: 0, dither: 1, glow: 0, flat: 0 };
const hit: HitInfo = { x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0, nx: 0, ny: 0, nz: 1, inner: 0, tag: 0 };

/** Screen-space bounding box of a set of primitives (and an optional ground). */
export function measure(prims: Prim[], ground?: Ground | null) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (sx: number, sy: number, r: number) => {
    x0 = Math.min(x0, sx - r);
    x1 = Math.max(x1, sx + r);
    y0 = Math.min(y0, sy - r);
    y1 = Math.max(y1, sy + r);
  };
  for (const p of prims) grow(projectX(p.sx, p.sy), projectY(p.sx, p.sy, p.sz), p.sr * PPU);
  if (ground) {
    const { x0: gx0, y0: gy0, x1: gx1, y1: gy1 } = ground.bounds;
    const gz = ground.z ?? 0;
    for (const [x, y] of [
      [gx0, gy0],
      [gx1, gy0],
      [gx0, gy1],
      [gx1, gy1],
    ]) {
      grow(projectX(x, y), projectY(x, y, gz), 0);
    }
  }
  return { x0, y0, x1, y1 };
}

export function bake(prims: Prim[], options: BakeOptions = {}): Sprite {
  const ground = options.ground ?? null;
  const [Lx, Ly, Lz] = options.sun ?? DEFAULT_SUN;
  const pad = options.pad ?? 2;
  let w: number;
  let h: number;
  let ax: number;
  let ay: number;
  if (options.frame) {
    ({ w, h, ax, ay } = options.frame);
  } else {
    const box = measure(prims, ground);
    if (!Number.isFinite(box.x0)) return { w: 1, h: 1, ax: 0, ay: 0, rgba: new Uint8ClampedArray(4) };
    ax = Math.ceil(-box.x0) + pad;
    ay = Math.ceil(-box.y0) + pad;
    w = Math.ceil(box.x1) + ax + pad;
    h = Math.ceil(box.y1) + ay + pad;
  }

  // Bin primitives into 8x8 tiles by their projected bounding circle.
  const TILE = 8;
  const tw = Math.ceil(w / TILE);
  const th = Math.ceil(h / TILE);
  const bins: Prim[][] = Array.from({ length: tw * th }, () => []);
  const holdouts = new Set(options.holdouts ?? []);
  for (const p of holdouts.size ? prims.concat(options.holdouts ?? []) : prims) {
    const sx = projectX(p.sx, p.sy) + ax;
    const sy = projectY(p.sx, p.sy, p.sz) + ay;
    const r = p.sr * PPU + 1;
    const tx0 = Math.max(0, Math.floor((sx - r) / TILE));
    const tx1 = Math.min(tw - 1, Math.floor((sx + r) / TILE));
    const ty0 = Math.max(0, Math.floor((sy - r) / TILE));
    const ty1 = Math.min(th - 1, Math.floor((sy + r) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) bins[ty * tw + tx].push(p);
  }
  const casters = prims
    .filter((p) => p.cast)
    .concat(options.shadowCasters ?? [])
    .concat((options.holdouts ?? []).filter((p) => p.cast));

  const level = new Float32Array(w * h).fill(-1); // ramp level before quantisation, -1 = empty
  const rampOf = new Int16Array(w * h).fill(-1);
  const depth = new Float32Array(w * h).fill(Infinity);
  const ditherOf = new Float32Array(w * h);
  const isGround = new Uint8Array(w * h);

  const occludedDir = (px: number, py: number, pz: number, lx: number, ly: number, lz: number) => {
    const len = Math.hypot(lx, ly, lz);
    lx /= len;
    ly /= len;
    lz /= len;
    for (let i = 0; i < casters.length; i++) {
      const p = casters[i];
      const wx = p.sx - px;
      const wy = p.sy - py;
      const wz = p.sz - pz;
      const along = wx * lx + wy * ly + wz * lz;
      if (along < -p.sr) continue;
      const d2 = wx * wx + wy * wy + wz * wz - along * along;
      if (d2 > p.sr * p.sr) continue;
      if (interval(p, px, py, pz, lx, ly, lz) && tOut > 0.02 && tIn < 1e6) return true;
    }
    return false;
  };
  const occluded = (px: number, py: number, pz: number) => occludedDir(px, py, pz, Lx, Ly, Lz);

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const sx = (px + 0.5 - ax) / PPU;
      const sy = (py + 0.5 - ay) / PPU;
      // Ray origin far above the scene, on the line through this pixel.
      const ox = sx * RX - sy * UX - FAR * DX;
      const oy = sx * RY - sy * UY - FAR * DY;
      const oz = -sy * UZ - FAR * DZ;
      const list = bins[Math.floor(py / TILE) * tw + Math.floor(px / TILE)];
      let best = Infinity;
      let bestPrim: Prim | null = null;
      let bnx = 0;
      let bny = 0;
      let bnz = 1;
      let binner = 0;
      let blx = 0;
      let bly = 0;
      let blz = 0;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!interval(p, ox, oy, oz, DX, DY, DZ)) continue;
        if (tOut <= 0 || tIn >= best) continue;
        best = tIn;
        bestPrim = p;
        bnx = nInX;
        bny = nInY;
        bnz = nInZ;
        binner = inner;
        // Local coordinates of the hit, in the primitive's frame.
        toLocal(p, ox, oy, oz, DX, DY, DZ);
        blx = lox + ldx * tIn;
        bly = loy + ldy * tIn;
        blz = loz + ldz * tIn;
      }
      const index = py * w + px;
      let hx: number;
      let hy: number;
      let hz: number;
      let nx: number;
      let ny: number;
      let nz: number;
      if (bestPrim && holdouts.has(bestPrim)) continue;
      if (bestPrim) {
        hx = ox + DX * best;
        hy = oy + DY * best;
        hz = oz + DZ * best;
        nx = bnx;
        ny = bny;
        nz = bnz;
        shade.ramp = 0;
        shade.tone = 0;
        // Flat faces read best as solid tones; curved ones get dithered gradients.
        shade.dither = bestPrim.kind === KIND.box ? 0 : 0.35;
        shade.glow = 0;
        shade.flat = 0;
        if (typeof bestPrim.mat === "number") shade.ramp = bestPrim.mat;
        else {
          hit.x = hx;
          hit.y = hy;
          hit.z = hz;
          hit.lx = blx;
          hit.ly = bly;
          hit.lz = blz;
          hit.nx = nx;
          hit.ny = ny;
          hit.nz = nz;
          hit.inner = binner;
          hit.tag = bestPrim.tag;
          bestPrim.mat(hit, shade);
        }
        depth[index] = best;

        // Light: sky ambient plus sun with a hard shadow.
        let light: number;
        if (shade.glow >= 1) {
          light = 1.05;
        } else {
          const ndl = nx * Lx + ny * Ly + nz * Lz;
          let sun = Math.max(0, ndl);
          if (sun > 0 && occluded(hx + nx * 0.06 + Lx * 0.08, hy + ny * 0.06 + Ly * 0.08, hz + nz * 0.06 + Lz * 0.08)) sun = 0;
          light = 0.48 + 0.16 * (0.5 + 0.5 * nz) + 0.5 * sun;
          if (shade.glow > 0) light = light * (1 - shade.glow) + 1.05 * shade.glow;
          if (shade.flat > 0) light = light * (1 - shade.flat) + 0.8 * shade.flat;
        }
        const steps = PALETTE[shade.ramp].length - 1;
        level[index] = Math.max(0, Math.min(steps, ((light - 0.3) / 0.8) * steps + shade.tone));
        rampOf[index] = shade.ramp;
        ditherOf[index] = shade.dither;
      } else if (ground) {
        const gz = ground.z ?? 0;
        const t = (gz - oz) / DZ;
        hx = ox + DX * t;
        hy = oy + DY * t;
        hz = gz;
        const d = ground.sdf(hx, hy);
        // Rim: pixels thin out toward the edge in small random clumps, with a few strays outside.
        const n = hash2(px, py);
        if (d > -ground.rim) {
          if (d > 0) {
            if (d > ground.rim * 0.7 || n > 0.07 * (1 - d / (ground.rim * 0.7))) continue;
          } else {
            const keep = -d / ground.rim;
            const clump = hash2(px >> 1, py >> 1);
            if (keep ** 1.4 < n * 0.6 + clump * 0.4) continue;
          }
        }
        shade.ramp = 0;
        shade.tone = 0;
        shade.dither = 1;
        shade.glow = 0;
        shade.flat = 0;
        ground.shade(hx, hy, shade);
        // Soft sun: four slightly spread rays give dithered penumbrae like the references.
        let visible = 0;
        for (let k = 0; k < 4; k++) {
          const jx = k & 1 ? 0.045 : -0.045;
          const jy = k & 2 ? 0.045 : -0.045;
          if (!occludedDir(hx, hy, hz + 0.05, Lx + jx, Ly + jy, Lz)) visible++;
        }
        const lit = ground.lit ?? 4;
        const dark = ground.dark ?? 2.2;
        let value = dark + (lit - dark) * (visible / 4) + shade.tone;
        const aoStrength = ground.ao ?? 1.2;
        if (aoStrength > 0) value -= aoStrength * groundOcclusion(hx, hy, hz, casters);
        // A shadow layer keeps only the ground these primitives darken.
        if (options.shadowOnly && value > lit + shade.tone - 0.3) continue;
        depth[index] = t;
        isGround[index] = 1;
        const steps = PALETTE[shade.ramp].length - 1;
        level[index] = Math.max(0, Math.min(steps, value));
        rampOf[index] = shade.ramp;
        ditherOf[index] = shade.dither;
      } else {
        continue;
      }
    }
  }

  // Depth lines: darken a pixel whose right or lower neighbour is much nearer (it sits behind an edge).
  if (options.edges !== false) {
    const shift = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (rampOf[i] < 0 || isGround[i]) continue;
        const d = depth[i];
        let darker = 0;
        const check = (j: number) => {
          if (rampOf[j] < 0 || isGround[j]) return;
          if (depth[j] < d - 6) darker = 1;
        };
        if (x > 0) check(i - 1);
        if (x < w - 1) check(i + 1);
        if (y > 0) check(i - w);
        if (y < h - 1) check(i + w);
        shift[i] = darker;
      }
    }
    for (let i = 0; i < w * h; i++) if (shift[i]) level[i] = Math.max(0, level[i] - 1.25);
  }

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = rampOf[i];
      if (r < 0) continue;
      const colors = PALETTE[r];
      const s = ditherOf[i];
      const threshold = 0.5 + (bayer(x, y) - 0.5) * s;
      const q = Math.max(0, Math.min(colors.length - 1, Math.floor(level[i] + threshold)));
      const c = colors[q];
      rgba[i * 4] = c >> 16;
      rgba[i * 4 + 1] = (c >> 8) & 255;
      rgba[i * 4 + 2] = c & 255;
      rgba[i * 4 + 3] = 255;
    }
  }

  if (options.outline) {
    const copy = rgba.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (rampOf[i] >= 0) continue;
        // Transparent pixel touching an object pixel: draw the object's darkest tone.
        let source = -1;
        if (x > 0 && rampOf[i - 1] >= 0 && !isGround[i - 1]) source = i - 1;
        else if (x < w - 1 && rampOf[i + 1] >= 0 && !isGround[i + 1]) source = i + 1;
        else if (y > 0 && rampOf[i - w] >= 0 && !isGround[i - w]) source = i - w;
        else if (y < h - 1 && rampOf[i + w] >= 0 && !isGround[i + w]) source = i + w;
        if (source < 0) continue;
        const c = PALETTE[rampOf[source]][0];
        copy[i * 4] = c >> 16;
        copy[i * 4 + 1] = (c >> 8) & 255;
        copy[i * 4 + 2] = c & 255;
        copy[i * 4 + 3] = 255;
      }
    }
    rgba.set(copy);
  }

  return { w, h, ax, ay, rgba };
}

const AO_DIRS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2 + 0.3;
  return normalize3(Math.cos(a), Math.sin(a), 0.55);
});

function groundOcclusion(x: number, y: number, z: number, casters: Prim[]) {
  let blocked = 0;
  for (const [dx, dy, dz] of AO_DIRS) {
    for (let i = 0; i < casters.length; i++) {
      const p = casters[i];
      const wx = p.sx - x;
      const wy = p.sy - y;
      const wz = p.sz - z;
      if (wx * wx + wy * wy + wz * wz > (p.sr + 10) * (p.sr + 10)) continue;
      if (interval(p, x, y, z + 0.05, dx, dy, dz) && tOut > 0 && tIn < 9) {
        blocked++;
        break;
      }
    }
  }
  return blocked / AO_DIRS.length;
}
