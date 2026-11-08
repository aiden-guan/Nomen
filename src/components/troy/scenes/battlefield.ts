import { type Act, ACT_FRAMES, ACT_RATE, dirFor, type Job } from "../engine/jobs";
import { FORT_GUNS } from "../engine/models/battle";
import { LOOK } from "../engine/models/soldier";
import type { Entity, Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import type { Point } from "../engine/walker";
import { type BattlePlan, CLASH_GAP, companyB, companyFront, FILE_GAP, RANK_GAP, victorious } from "./battle";
import { BATTLE_LINES, battlePoint, CATAPULT_B, FIELD } from "./layout";

// The battle below the agora, drawn: the rival's legion drawn up before its fort, the Greeks'
// catapults, the fort's ballistae, and everything that flies between the armies. The Greek army
// itself is made of camp agents (derive.ts posts them, camp.ts walks them out of the horse); this
// scene answers them. Legionaries get knocked flat and get up again; nobody dies and nobody
// appears or vanishes in the open.

type Figure = Entity & { look: number; act: Act; dir: number };

type Legionary = {
  entity: Figure;
  century: number;
  /** -1, 0 or 1 across the century's front; 0 for the front rank, 1 behind it. */
  file: number;
  rank: number;
  /** Where he is headed (battle `a`, `b`) and what he does once there. */
  to: { a: number; b: number };
  act: Act;
  /** Seconds left lying knocked down. */
  down: number;
  phase: number;
  travelled: number;
};

type Missile = { from: Point; to: Point; peak: number; t: number; duration: number; entity: Entity; land: () => void };
type Puff = { entity: Entity; age: number; life: number };

/** Legionaries march at this pace (world units per second), and fall back faster. */
const PACE = { march: 26, retreat: 34 };
const CENTURIES = 4;

/** Callbacks into the camp: register an entity to appear with the camp, and find the Greeks. */
export type BattleHooks = {
  ground: (entity: Entity, at: number) => void;
  prop: (entity: Entity, at: number) => void;
  /** Greek soldiers on the field, to aim the ballistae at. */
  greeks: () => Entity[];
};

export class Battlefield {
  private readonly romans: Legionary[] = [];
  private readonly centurion: Figure;
  private readonly catapults: Array<{ entity: Entity; b: number; frame: number; wait: number }> = [];
  private readonly ballistae: Array<{ entity: Entity; wait: number; loosed: number }> = [];
  private readonly missiles: Missile[] = [];
  private readonly puffs: Puff[] = [];
  private plan: BattlePlan = { phase: "none", companies: [], rival: null, benchmark: null, score: null };
  private time = 0;
  private sparkWait = 0;
  private placed = false;

  constructor(
    private readonly stage: Stage,
    private readonly hooks: BattleHooks,
  ) {
    hooks.ground(stage.add({ x: FIELD.x, y: FIELD.y, z: 0, ground: true, job: { k: "field" } as Job, reveal: 0, priority: 4 }), 1.2);
    const fort = battlePoint(BATTLE_LINES.fort, 0);
    hooks.prop(stage.add({ x: fort.x, y: fort.y, z: 0, job: { k: "prop", id: "fort", v: 0 }, reveal: 0, priority: 3.8 }), 1.7);
    CATAPULT_B.forEach((b, i) => {
      const p = battlePoint(BATTLE_LINES.catapults, b);
      const entity = stage.add({ x: p.x, y: p.y, z: 0, job: { k: "prop", id: "catapult", v: 0 }, reveal: 0, priority: 3.8 });
      hooks.prop(entity, 1.8);
      this.catapults.push({ entity, b, frame: 0, wait: 1.5 + i * 2.2 });
    });
    for (const gun of FORT_GUNS) {
      // Drawn after the fort's towers they stand on.
      const entity = stage.add({ x: fort.x + gun.x, y: fort.y + gun.y, z: gun.z, sort: 60, job: { k: "prop", id: "ballista", v: 0 }, reveal: 0, priority: 3.7 });
      hooks.prop(entity, 1.9);
      this.ballistae.push({ entity, wait: 2.5 + this.ballistae.length * 1.7, loosed: 0 });
    }
    // The legion: four centuries of two ranks of three, the centurion behind them.
    for (let century = 0; century < CENTURIES; century++) {
      for (let i = 0; i < 6; i++) {
        const file = (i % 3) - 1;
        const rank = Math.floor(i / 3);
        const to = { a: BATTLE_LINES.romans + rank * RANK_GAP, b: companyB(century, CENTURIES) + file * FILE_GAP };
        const p = battlePoint(to.a, to.b);
        const entity: Figure = stage.add({ x: p.x, y: p.y, z: 0, look: LOOK.roman + ((century + i) % 3), act: "stand" as Act, dir: 4, shadow: 5, reveal: 0, priority: 3, job: null as Job | null });
        hooks.prop(entity, 2 + century * 0.1);
        this.romans.push({ entity, century, file, rank, to, act: "stand", down: 0, phase: Math.random() * 5, travelled: 0 });
      }
    }
    const c = battlePoint(BATTLE_LINES.centurion, 0);
    this.centurion = stage.add({ x: c.x, y: c.y, z: 0, look: LOOK.centurion, act: "stand" as Act, dir: 4, shadow: 5, reveal: 0, priority: 3, job: null as Job | null });
    hooks.prop(this.centurion, 2.2);
  }

  /** What the legion does, from the battle plan; `instantly` puts everyone in place (a camp opened directly). */
  apply(plan: BattlePlan, instantly = false) {
    this.plan = plan;
    const fighting = plan.phase === "advance" || plan.phase === "clash";
    // Each engaged company is met by the century nearest it; the others stand their ground.
    const met = new Map<number, { a: number; b: number; act: Act }>();
    const free = new Set(Array.from({ length: CENTURIES }, (_, i) => i));
    plan.companies.forEach((company, k) => {
      if (company.state !== "engaged") return;
      const b = companyB(k, plan.companies.length);
      let best = -1;
      for (const c of free) if (best < 0 || Math.abs(companyB(c, CENTURIES) - b) < Math.abs(companyB(best, CENTURIES) - b)) best = c;
      if (best < 0) return;
      free.delete(best);
      // A century that is routed falls back to its gate, closing up in front of it.
      met.set(best, victorious(company) ? { a: BATTLE_LINES.gate - 6, b: (best - (CENTURIES - 1) / 2) * 7, act: "stand" } : { a: companyFront(company) + CLASH_GAP, b, act: "fight" });
    });
    for (const r of this.romans) {
      const order = met.get(r.century);
      const routed = order?.act === "stand";
      r.to = { a: (order?.a ?? BATTLE_LINES.romans) + r.rank * (routed ? 6 : RANK_GAP), b: (order?.b ?? companyB(r.century, CENTURIES)) + r.file * (routed ? 4 : FILE_GAP) };
      r.act = order?.act ?? "stand";
      if ((instantly || !this.placed) && !fighting) this.put(r);
    }
    this.centurion.act = fighting ? "point" : "stand";
    this.placed = true;
  }

  /** Clears what is in the air and stands the legion at rest (a different camp, or back to the landing). */
  reset() {
    for (const m of this.missiles) this.stage.remove(m.entity);
    for (const p of this.puffs) this.stage.remove(p.entity);
    this.missiles.length = 0;
    this.puffs.length = 0;
    this.placed = false;
    this.apply({ phase: "none", companies: [], rival: null, benchmark: null, score: null });
    for (const r of this.romans) {
      r.down = 0;
      this.put(r);
    }
  }

  /** An archer has let go of his arrow: it flies at the legion. */
  loose(archer: Entity) {
    if (this.plan.phase !== "advance" && this.plan.phase !== "clash") return;
    const target = this.pickRoman(true);
    if (!target) return;
    const t = target.entity;
    const to = { x: t.x + (Math.random() - 0.5) * 5, y: t.y + (Math.random() - 0.5) * 5, z: 0 };
    this.fire("arrow", { x: archer.x + 1, y: archer.y + 1, z: 13 }, to, 18 + Math.random() * 10, 0.85 + Math.random() * 0.3, () => {
      this.puff(to, 3, 0.35);
      if (target.down <= 0 && Math.random() < 0.3) this.knockDown(target);
    });
  }

  tick(dt: number) {
    this.time += dt;
    const fighting = this.plan.phase === "advance" || this.plan.phase === "clash";
    this.moveRomans(dt);
    this.figure(this.centurion, this.centurion.act, 0.7);
    this.workCatapults(dt, fighting);
    this.workBallistae(dt, fighting);
    if (this.plan.phase === "clash") this.clashSparks(dt);
    this.flyMissiles(dt);
    this.agePuffs(dt);
  }

  // --- The legion -----------------------------------------------------------------------------

  private put(r: Legionary) {
    const p = battlePoint(r.to.a, r.to.b);
    r.entity.x = p.x;
    r.entity.y = p.y;
    r.entity.dir = 4;
  }

  private moveRomans(dt: number) {
    for (const r of this.romans) {
      const e = r.entity;
      if (r.down > 0) {
        r.down -= dt;
        e.job = { k: "soldier", look: e.look, act: "fallen", dir: e.dir, f: 0 };
        continue;
      }
      const p = battlePoint(r.to.a, r.to.b);
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.4) {
        // Falling back they turn and go; advancing or shuffling they keep facing the Greeks.
        const retreating = dx > 2 && r.act === "stand";
        const step = Math.min(dist, (retreating ? PACE.retreat : PACE.march) * dt);
        e.x += (dx / dist) * step;
        e.y += (dy / dist) * step;
        r.travelled += step;
        e.dir = retreating ? dirFor(dx, dy) : 4;
        e.job = { k: "soldier", look: e.look, act: "march", dir: e.dir, f: Math.floor(r.travelled / 2.2) % ACT_FRAMES.march };
        continue;
      }
      e.dir = 4;
      this.figure(e, r.act, r.phase);
    }
  }

  private figure(e: Figure, act: Act, phase: number) {
    const frames = ACT_FRAMES[act];
    const f = frames > 1 ? Math.floor((this.time + phase) / ACT_RATE[act]) % frames : 0;
    e.job = { k: "soldier", look: e.look, act, dir: e.dir, f };
  }

  private knockDown(r: Legionary) {
    r.down = 2.4 + Math.random() * 2.2;
  }

  /** A legionary standing in the line: one facing a Greek company if `front`, else any. */
  private pickRoman(front: boolean) {
    const standing = this.romans.filter((r) => r.down <= 0);
    const preferred = front ? standing.filter((r) => r.act === "fight") : standing;
    const pool = preferred.length ? preferred : standing;
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  // --- The engines ----------------------------------------------------------------------------

  private workCatapults(dt: number, fighting: boolean) {
    for (const c of this.catapults) {
      c.wait -= dt;
      if (!fighting) {
        c.frame = 0;
      } else if (c.frame === 0 && c.wait <= 0) {
        // Loose: the arm swings, the stone flies at the legion's rear ranks.
        c.frame = 1;
        c.wait = 0.12;
        const target = this.pickRoman(false);
        const t = target ? target.entity : battlePoint(BATTLE_LINES.romans + 12, c.b * 0.5);
        const to = { x: t.x + (Math.random() - 0.5) * 8, y: t.y + (Math.random() - 0.5) * 8, z: 0 };
        this.fire("stone", { x: c.entity.x - 6, y: c.entity.y, z: 14 }, to, 52 + Math.random() * 12, 1.7 + Math.random() * 0.3, () => this.impact(to));
      } else if (c.frame === 1 && c.wait <= 0) {
        c.frame = 2;
        c.wait = 0.7;
      } else if (c.frame === 2 && c.wait <= 0) {
        c.frame = 3;
        c.wait = 1.6;
      } else if (c.frame === 3 && c.wait <= 0) {
        c.frame = 0;
        c.wait = 2.2 + Math.random() * 1.8;
      }
      c.entity.job = { k: "prop", id: "catapult", v: c.frame };
    }
  }

  private workBallistae(dt: number, fighting: boolean) {
    for (const b of this.ballistae) {
      b.wait -= dt;
      b.loosed = Math.max(0, b.loosed - dt);
      if (fighting && b.wait <= 0) {
        const greeks = this.hooks.greeks();
        const target = greeks[Math.floor(Math.random() * greeks.length)];
        b.wait = 3 + Math.random() * 2.5;
        if (target) {
          b.loosed = 1.1;
          const to = { x: target.x + (Math.random() - 0.5) * 6, y: target.y + (Math.random() - 0.5) * 6, z: 0 };
          this.fire("bolt", { x: b.entity.x - 3, y: b.entity.y - 3, z: b.entity.z + 5.5 }, to, 7, 0.75, () => {
            this.puff(to, 3, 0.3);
            this.spark(to, 2);
          });
        }
      }
      b.entity.job = { k: "prop", id: "ballista", v: b.loosed > 0 ? 1 : 0 };
    }
  }

  private clashSparks(dt: number) {
    this.sparkWait -= dt;
    if (this.sparkWait > 0) return;
    this.sparkWait = 0.12 + Math.random() * 0.18;
    const fighting = this.romans.filter((r) => r.act === "fight" && r.rank === 0 && r.down <= 0);
    const r = fighting[Math.floor(Math.random() * fighting.length)];
    if (!r) return;
    // Bronze on iron where the spears meet the shields, between the front ranks.
    this.spark({ x: r.entity.x - 4 - Math.random() * 2, y: r.entity.y + (Math.random() - 0.5) * 4, z: 8 + Math.random() * 5 }, 1);
  }

  // --- What flies -------------------------------------------------------------------------------

  private fire(kind: "arrow" | "stone" | "bolt", from: Point, to: Point, peak: number, duration: number, land: () => void) {
    const missile: Missile = { from, to, peak, t: 0, duration, land, entity: null as unknown as Entity };
    const at = (t: number) => ({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t + 4 * peak * t * (1 - t),
    });
    missile.entity = this.stage.add({
      x: from.x,
      y: from.y,
      z: from.z,
      sort: 0.5,
      shadow: kind === "stone" ? 3 : 0,
      paint: (ctx, sx, sy, px) => {
        // Point along the flight, in screen space.
        const a = at(missile.t);
        const b = at(Math.min(1, missile.t + 0.04));
        let dx = projectX(b.x, b.y) - projectX(a.x, a.y);
        let dy = projectY(b.x, b.y, b.z) - projectY(a.x, a.y, a.z);
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const dot = (i: number, color: string, size = 1) => {
          ctx.fillStyle = color;
          ctx.fillRect(Math.round(sx + dx * i * px - (size * px) / 2), Math.round(sy + dy * i * px - (size * px) / 2), Math.ceil(px * size), Math.ceil(px * size));
        };
        if (kind === "stone") {
          dot(0, "#2b1d14", 4);
          dot(0, "#77726b", 3);
          dot(-0.6, "#aba59b", 1);
        } else {
          const length = kind === "bolt" ? 7 : 5;
          for (let i = -length; i < 0; i++) dot(i, kind === "bolt" ? "#3d281c" : "#664027");
          dot(0, "#c4beb4");
          dot(-length, "#ead6ad");
        }
      },
    });
    this.missiles.push(missile);
  }

  private flyMissiles(dt: number) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.t = Math.min(1, m.t + dt / m.duration);
      const t = m.t;
      m.entity.x = m.from.x + (m.to.x - m.from.x) * t;
      m.entity.y = m.from.y + (m.to.y - m.from.y) * t;
      m.entity.z = m.from.z + (m.to.z - m.from.z) * t + 4 * m.peak * t * (1 - t);
      if (t >= 1) {
        this.stage.remove(m.entity);
        this.missiles.splice(i, 1);
        m.land();
      }
    }
  }

  /** A stone lands: a burst of dust, the ground shakes a little, and the legionaries near it go down. */
  private impact(at: Point) {
    this.puff(at, 9, 0.8);
    for (let k = 0; k < 5; k++) this.puff({ x: at.x + (Math.random() - 0.5) * 10, y: at.y + (Math.random() - 0.5) * 10, z: 0 }, 3, 0.5 + Math.random() * 0.3);
    this.stage.shake = Math.max(this.stage.shake, 0.18);
    for (const r of this.romans) {
      if (r.down > 0) continue;
      if (Math.hypot(r.entity.x - at.x, r.entity.y - at.y) < 9 && Math.random() < 0.75) this.knockDown(r);
    }
  }

  /** A burst of dust on the ground, `size` art px across at its widest, fading over `life` seconds. */
  private puff(at: Point, size: number, life: number) {
    const puff: Puff = { age: 0, life, entity: null as unknown as Entity };
    const seed = Math.floor(Math.random() * 1e6);
    puff.entity = this.stage.add({
      x: at.x,
      y: at.y,
      z: 0,
      sort: 0.4,
      paint: (ctx, sx, sy, px) => {
        const k = puff.age / puff.life;
        const r = Math.max(1, size * (0.35 + 0.65 * Math.sqrt(k)));
        ctx.globalAlpha *= 1 - k;
        for (let y = -r; y <= r; y++) {
          for (let x = -r; x <= r; x++) {
            const d = (x / r) ** 2 + ((y * 2) / r) ** 2;
            if (d > 1) continue;
            // Clumpy, dithered dust: sand in the middle, darker at the edge.
            const h = ((x * 374761393 + y * 668265263 + seed) >>> 0) % 7;
            if (h < 2 + d * 3) continue;
            ctx.fillStyle = d < 0.4 ? "#e3c896" : d < 0.75 ? "#d2b386" : "#a3866a";
            ctx.fillRect(Math.round(sx + x * px), Math.round(sy + (y - r * 0.4) * px), Math.ceil(px), Math.ceil(px));
          }
        }
      },
    });
    this.puffs.push(puff);
  }

  /** A few bright pixels where metal meets metal. */
  private spark(at: Point, count: number) {
    const puff: Puff = { age: 0, life: 0.22, entity: null as unknown as Entity };
    const offsets = Array.from({ length: count + 1 }, () => [Math.round((Math.random() - 0.5) * 4), Math.round((Math.random() - 0.5) * 4)]);
    puff.entity = this.stage.add({
      x: at.x,
      y: at.y,
      z: at.z,
      sort: 2,
      paint: (ctx, sx, sy, px) => {
        const k = puff.age / puff.life;
        offsets.forEach(([dx, dy], i) => {
          ctx.fillStyle = i === 0 ? "#fffaf0" : k < 0.5 ? "#f6da94" : "#e3b45c";
          ctx.fillRect(Math.round(sx + dx * px * (1 + k)), Math.round(sy + dy * px * (1 + k)), Math.ceil(px), Math.ceil(px));
        });
      },
    });
    this.puffs.push(puff);
  }

  private agePuffs(dt: number) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.stage.remove(p.entity);
        this.puffs.splice(i, 1);
      }
    }
  }
}
