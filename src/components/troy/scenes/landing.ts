import type { Baker } from "../engine/baker";
import { LEAF_STEPS, PLANK_FROM, PLANK_STEPS, type Job } from "../engine/jobs";
import { exitPath, HORSE, PLANK_REST } from "../engine/models/horse";
import { type Entity, Stage } from "../engine/stage";
import { makeWalker, type Point, smoothPath, type Walker } from "../engine/walker";

// The landing: the horse on its island. `open()` plays the doors, the gangplank and then an
// endless column of soldiers marching out toward the camp.

/** Seconds the full opening takes (doors, plank, settle). */
export const OPEN_SECONDS = 2.6;

export type LandingEvents = {
  /** The plank has landed: the march begins. */
  onPlankDown?: () => void;
};

export class LandingScene {
  readonly island: Entity;
  readonly body: Entity;
  readonly leaves: Entity;
  readonly plank: Entity;
  private opening = -1;
  private streaming = false;
  private streamTimer = 0;
  private spawned = 0;
  private knockTimer = 6;
  private knock = 0;
  private plankDown = false;
  private readonly marchers = new Set<Walker>();
  /** Where marching soldiers head once they reach the sand (set by the camp). */
  destination: (index: number) => Point[] = defaultDestination;

  constructor(
    private readonly stage: Stage,
    private readonly events: LandingEvents = {},
  ) {
    this.island = stage.add({ x: 0, y: 0, z: 0, ground: true, job: { k: "horse-island" }, priority: 10 });
    this.body = stage.add({ x: 0, y: 0, z: 0, job: { k: "horse-body" }, priority: 10 });
    this.leaves = stage.add({ x: 0, y: 0, z: 0, sort: 22, job: { k: "horse-leaves", s: 0 }, priority: 9 });
    this.plank = stage.add({ x: 0, y: 0, z: 0, sort: 1, job: null, priority: 8 });
    stage.add({ x: 0, y: 0, z: 0, hidden: false, tick: (dt) => this.tick(dt) });
  }

  /** Bakes everything the opening needs, most urgent first. */
  preload(baker: Baker) {
    const jobs: Array<[Job, number]> = [
      [{ k: "horse-island" }, 10],
      [{ k: "horse-body" }, 10],
    ];
    for (let s = 0; s <= LEAF_STEPS; s++) jobs.push([{ k: "horse-leaves", s }, 7]);
    for (let s = 0; s <= PLANK_STEPS; s++) jobs.push([{ k: "horse-plank", s }, 6]);
    for (let look = 0; look < 6; look++) for (const dir of [1, 2, 3]) for (let f = 0; f < 8; f++) jobs.push([{ k: "soldier", look, act: "march", dir, f }, 4]);
    return Promise.all(jobs.map(([job, priority]) => baker.request(job, priority)));
  }

  /** Ready when the horse can be shown (island and body baked). */
  ready(baker: Baker) {
    return Promise.all([baker.request({ k: "horse-island" }, 10), baker.request({ k: "horse-body" }, 10)]);
  }

  /** Ready when the whole opening can play without a missing frame. */
  openingReady(baker: Baker) {
    return LEAF_STEPS + PLANK_STEPS + 2 <= countReady(baker);
  }

  /** A small rattle of the doors, as if someone inside knocked. */
  rattle() {
    if (this.opening < 0) this.knock = 0.45;
  }

  open() {
    if (this.opening >= 0) return;
    this.opening = 0;
    this.knock = 0;
  }

  /** Opens instantly (for visitors coming straight to the camp, or reduced motion). */
  openNow() {
    this.opening = OPEN_SECONDS;
    this.leaves.job = { k: "horse-leaves", s: LEAF_STEPS };
    this.plank.job = { k: "horse-plank", s: PLANK_STEPS };
    this.plankDown = true;
  }

  /** Closes the horse again (back to the landing). */
  reset() {
    this.opening = -1;
    this.streaming = false;
    this.plankDown = false;
    this.knock = 0;
    this.leaves.job = { k: "horse-leaves", s: 0 };
    this.plank.job = null;
    for (const walker of this.marchers) this.stage.remove(walker);
    this.marchers.clear();
  }

  startStream() {
    this.streaming = true;
  }

  stopStream() {
    this.streaming = false;
  }

  get isOpen() {
    return this.plankDown;
  }

  private tick(dt: number) {
    // Idle knock: every few seconds the doors jiggle.
    if (this.opening < 0) {
      this.knockTimer -= dt;
      if (this.knockTimer <= 0) {
        this.knockTimer = 7 + Math.random() * 5;
        this.knock = 0.45;
      }
      if (this.knock > 0) {
        this.knock = Math.max(0, this.knock - dt);
        const wobble = Math.abs(Math.sin(this.knock * 38)) * (this.knock / 0.45);
        this.leaves.job = { k: "horse-leaves", s: Math.round(wobble * 1.4) };
      } else this.leaves.job = { k: "horse-leaves", s: 0 };
      return;
    }

    if (this.opening < OPEN_SECONDS) {
      this.opening += dt;
      const t = Math.min(1, this.opening / OPEN_SECONDS);
      this.leaves.job = { k: "horse-leaves", s: Math.min(LEAF_STEPS, Math.round((t / 0.4) * LEAF_STEPS)) };
      if (t >= PLANK_FROM) this.plank.job = { k: "horse-plank", s: Math.min(PLANK_STEPS, Math.round(((t - PLANK_FROM) / (1 - PLANK_FROM)) * PLANK_STEPS)) };
      // The plank hits the sand at about 89% of the timeline.
      if (!this.plankDown && t >= 0.885) {
        this.plankDown = true;
        this.stage.shake = 0.55;
        this.dust();
        this.events.onPlankDown?.();
      }
    }

    if (this.streaming) {
      this.streamTimer -= dt;
      if (this.streamTimer <= 0) {
        this.streamTimer = 0.34 + Math.random() * 0.12;
        this.spawn();
      }
    }
  }

  private spawn() {
    const index = this.spawned++;
    const out = exitPath();
    const onward = this.destination(index);
    const path = [...out, ...smoothPath([out[out.length - 1], ...onward], 5).slice(1)];
    const walker = makeWalker({
      look: index % 6,
      path,
      speed: 24,
      onArrive: (w) => {
        // Join the camp: dissolve into the island grain by grain.
        let t = 0;
        w.act = "stand";
        w.tick = (dt) => {
          t += dt;
          w.reveal = Math.max(0, 1 - t / 0.7);
          if (t < 0.7) return undefined;
          this.marchers.delete(w);
          return "remove";
        };
      },
    });
    // Step out of the dark: fade in over the first stride.
    walker.alpha = 0;
    const baseTick = walker.tick!;
    walker.tick = (dt, time) => {
      walker.alpha = Math.min(1, (walker.alpha ?? 0) + dt * 4);
      // No blob shadow while on the plank (it would float under the walkway).
      walker.shadow = walker.z < 1 ? 5 : 0;
      return baseTick(dt, time);
    };
    this.marchers.add(walker);
    this.stage.add(walker);
  }

  private dust() {
    const footY = HORSE.sillY + HORSE.plankLength * Math.cos(PLANK_REST);
    for (let i = 0; i < 22; i++) {
      const angle = (i / 22) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 10 + Math.random() * 16;
      this.stage.add(dustPuff(Math.random() * 10 - 5, footY + 2, Math.cos(angle) * speed, Math.sin(angle) * speed * 0.6, 0.7 + Math.random() * 0.5));
    }
  }
}

function countReady(baker: Baker) {
  let n = 0;
  for (let s = 0; s <= LEAF_STEPS; s++) if (baker.has({ k: "horse-leaves", s })) n++;
  for (let s = 0; s <= PLANK_STEPS; s++) if (baker.has({ k: "horse-plank", s })) n++;
  return n;
}

/** Without a camp, marchers fan out toward the lower left and leave the page. */
function defaultDestination(index: number): Point[] {
  const spread = ((index * 37) % 9) - 4;
  return [
    { x: 6 + spread * 3, y: 92, z: 0 },
    { x: -20 + spread * 8, y: 170, z: 0 },
    { x: -40 + spread * 12, y: 320, z: 0 },
  ];
}

/** A puff of sand: a few pixels that drift outward, rise a little and fade. */
export function dustPuff(x: number, y: number, vx: number, vy: number, life: number): Entity {
  let age = 0;
  const seed = Math.random();
  const puff: Entity = {
    x,
    y,
    z: 0.5,
    sort: 40,
    tick: (dt) => {
      age += dt;
      puff.x += vx * dt;
      puff.y += vy * dt;
      puff.z += dt * 6;
      vx *= 0.93;
      vy *= 0.93;
      return age >= life ? "remove" : undefined;
    },
    paint: (ctx, sx, sy, px) => {
      const k = age / life;
      const size = Math.max(1, Math.round(px * (1.6 - k)));
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.fillStyle = seed > 0.5 ? "#e6cfa2" : "#d7ba8b";
      for (let i = 0; i < 3; i++) {
        const ox = Math.round((Math.cos(seed * 9 + i * 2.1) * (1 + k * 3)) * px);
        const oy = Math.round((Math.sin(seed * 7 + i * 1.7) * (0.5 + k * 1.5)) * px);
        ctx.fillRect(Math.round(sx + ox), Math.round(sy + oy), size, size);
      }
    },
  };
  return puff;
}

export { Stage };
