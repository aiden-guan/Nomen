import { type HitInfo, type Mat3x4, type Material, Model, type Prim, type ShadeOut } from "./tracer";

type Options = { mat: Material; rot?: Mat3x4; clip?: number[]; carve?: Prim | null; tag?: number; cast?: boolean };

/**
 * Builds onto another model at `k` times the size: positions, sizes, clip planes and nested frames
 * scale, and materials still see the design's own units (so a building drawn twice as big keeps its
 * proportions: as many windows, courses and columns, each twice as large).
 */
export class ScaledModel extends Model {
  constructor(
    private readonly target: Model,
    private readonly k: number,
  ) {
    super();
  }

  override get frame() {
    return this.target.frame;
  }

  override with(m: Mat3x4, build: () => void) {
    const k = this.k;
    this.target.with([m[0], m[1], m[2], m[3] * k, m[4], m[5], m[6], m[7] * k, m[8], m[9], m[10], m[11] * k], build);
  }

  private options(o: Options): Options {
    const k = this.k;
    const mat = o.mat;
    return {
      ...o,
      clip: o.clip?.map((v, i) => (i % 4 === 3 ? v * k : v)),
      mat: typeof mat === "function" ? designUnits(mat, k) : mat,
    };
  }

  override box(x: number, y: number, z: number, hx: number, hy: number, hz: number, o: Options) {
    const k = this.k;
    return this.target.box(x * k, y * k, z * k, hx * k, hy * k, hz * k, this.options(o));
  }

  override hole(x: number, y: number, z: number, hx: number, hy: number, hz: number, rot?: Mat3x4) {
    const k = this.k;
    return this.target.hole(x * k, y * k, z * k, hx * k, hy * k, hz * k, rot);
  }

  override cutter(build: (scratch: Model) => Prim): Prim {
    return this.target.cutter((c) => build(new ScaledModel(c, this.k)));
  }

  override ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number, o: Options) {
    const k = this.k;
    return this.target.ellipsoid(x * k, y * k, z * k, rx * k, ry * k, rz * k, this.options(o));
  }

  override sphere(x: number, y: number, z: number, r: number, o: Options) {
    return this.ellipsoid(x, y, z, r, r, r, o);
  }

  override cylinder(x: number, y: number, z: number, r: number, h: number, o: Options) {
    const k = this.k;
    return this.target.cylinder(x * k, y * k, z * k, r * k, h * k, this.options(o));
  }

  override capsule(a: [number, number, number], b: [number, number, number], r: number, o: Omit<Options, "rot">) {
    const k = this.k;
    return this.target.capsule([a[0] * k, a[1] * k, a[2] * k], [b[0] * k, b[1] * k, b[2] * k], r * k, this.options(o));
  }

  override frustum(x: number, y: number, z: number, r0: number, r1: number, h: number, o: Options) {
    const k = this.k;
    return this.target.frustum(x * k, y * k, z * k, r0 * k, r1 * k, h * k, this.options(o));
  }
}

/** A material that reads its hit in the design's units, `k` times smaller than the world's. */
function designUnits(mat: (h: HitInfo, out: ShadeOut) => void, k: number) {
  return (h: HitInfo, out: ShadeOut) => {
    const { x, y, z, lx, ly, lz } = h;
    h.x = x / k;
    h.y = y / k;
    h.z = z / k;
    h.lx = lx / k;
    h.ly = ly / k;
    h.lz = lz / k;
    mat(h, out);
    h.x = x;
    h.y = y;
    h.z = z;
    h.lx = lx;
    h.ly = ly;
    h.lz = lz;
  };
}
