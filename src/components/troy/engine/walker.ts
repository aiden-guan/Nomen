import { type Act, ACT_FRAMES, dirFor, type Job } from "./jobs";
import type { Entity } from "./stage";

// Figures that walk along paths: position by distance travelled, heading from the path, and the
// march cycle advancing with each step so feet never slide.

export type Point = { x: number; y: number; z: number };

export type Walker = Entity & {
  look: number;
  act: Act;
  path: Point[];
  leg: number;
  travelled: number;
  speed: number;
  /** Fraction of a stride per world unit walked. */
  cadence: number;
  dir: number;
  onArrive?: (walker: Walker) => void;
  arrived: boolean;
};

export function makeWalker(options: { look: number; path: Point[]; speed?: number; act?: Act; priority?: number; onArrive?: (walker: Walker) => void }): Walker {
  const start = options.path[0];
  const next = options.path[1] ?? start;
  const walker: Walker = {
    x: start.x,
    y: start.y,
    z: start.z,
    look: options.look,
    act: options.act ?? "march",
    path: options.path,
    leg: 0,
    travelled: 0,
    speed: options.speed ?? 22,
    cadence: 1 / 14,
    dir: dirFor(next.x - start.x, next.y - start.y),
    shadow: 5,
    priority: options.priority ?? 2,
    onArrive: options.onArrive,
    arrived: false,
    job: null,
  };
  walker.job = walkJob(walker);
  walker.tick = (dt) => stepWalker(walker, dt);
  return walker;
}

function walkJob(w: Walker): Job {
  const frames = ACT_FRAMES[w.act];
  const f = Math.floor((w.travelled * w.cadence * frames) % frames);
  return { k: "soldier", look: w.look, act: w.act, dir: w.dir, f };
}

/** Moves a walker along its path; returns "remove" never (callers decide what to do on arrival). */
export function stepWalker(w: Walker, dt: number) {
  if (w.arrived) return;
  let remaining = w.speed * dt;
  while (remaining > 0 && w.leg < w.path.length - 1) {
    const a = w.path[w.leg];
    const b = w.path[w.leg + 1];
    const dx = b.x - w.x;
    const dy = b.y - w.y;
    const dz = b.z - w.z;
    const left = Math.hypot(dx, dy, dz);
    if (left <= remaining) {
      w.x = b.x;
      w.y = b.y;
      w.z = b.z;
      remaining -= left;
      w.travelled += left;
      w.leg++;
    } else {
      const k = remaining / left;
      w.x += dx * k;
      w.y += dy * k;
      w.z += dz * k;
      w.travelled += remaining;
      remaining = 0;
    }
    if (Math.hypot(b.x - a.x, b.y - a.y) > 0.01) w.dir = dirFor(b.x - a.x, b.y - a.y);
  }
  w.job = walkJob(w);
  if (w.leg >= w.path.length - 1 && !w.arrived) {
    w.arrived = true;
    w.onArrive?.(w);
  }
}

/** A gently curving path through the given points (Catmull-Rom, sampled every few units). */
export function smoothPath(points: Point[], step = 4): Point[] {
  if (points.length < 3) return points;
  const out: Point[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const n = Math.max(1, Math.ceil(length / step));
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  return out;
}
