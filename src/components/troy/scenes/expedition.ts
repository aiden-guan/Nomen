import { type Act, ACT_FRAMES, ACT_RATE, dirFor, type Job, SHOOT_RELEASE } from "../engine/jobs";
import { CITY } from "../engine/models/rome";
import { deckSpot, HULL, OARS_IN, PLANK_FOOT, PLANK_HEAD, type Plank, ROW_FRAMES } from "../engine/models/ships";
import { LOOK } from "../engine/models/soldier";
import type { Entity, Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import type { Point } from "../engine/walker";
import { type BattlePlan, CLASH_GAP, type Company, companyB, FILE_GAP, type Outcome, outcomeOf, RANK_GAP, shipsFor } from "./battle";
import {
  BERTH_DIR,
  BERTHS_SX,
  harborProps,
  homeBerth,
  inShip,
  isletAt,
  isletProps,
  ISLETS,
  ROME,
  ROME_BERTHS_B,
  ROME_LINES,
  ROME_WALL,
  romePoint,
  romeProps,
  romeTiles,
  SEA,
  seaTiles,
  type Standing,
} from "./layout";

// The expedition: the agora's army boards the ships at the quay below the camp, sails south across
// the sea to the rival's city, runs the ships in at its quay, and fights the legion in the forum.
//
// The Greeks are camp agents: the camp marches them out of the horse and down to the quay, then
// hands each one over here (claim) to board; this scene moves them from then on. The ships, the
// legion, the engines on the walls and everything that flies belong to this scene. What happens is
// the campaign's numbers: a company sails when its video's post goes out, lands when it is out,
// and attacks once its numbers are in; the attack ends, after a few seconds, the way the video
// does against the category's top videos. Nobody appears or vanishes in the open: the routed
// legion runs into the dark of the gate's passage.

type Figure = Entity & { look: number; act: Act; dir: number };

/** A point to walk to, with the act and heading for the leg that ends there. */
type Step = Point & { act?: Act; dir?: number };

/** What a soldier of the army is in the plan: his company (index), his place in it, his arm. */
export type Enlisted = { id: string; company: number; rank: number; file: number; role: "hoplite" | "archer" };

/** Callbacks into the camp. */
export type ExpeditionHooks = {
  /** Registers an entity of the scenery (a ground or a prop) with the camp, to be shown with it. */
  scenery: (entity: Entity) => void;
  /** Takes over a soldier standing at his post on the quay; null while he is still on his way. */
  claim: (id: string) => Figure | null;
  /** Hands a soldier back to the camp (on the home quay), to go wherever his plan says. */
  release: (id: string) => void;
  /** A soldier calls something out. */
  say: (id: string, text: string, seconds: number) => void;
};

/** What the soldiers call out at the big moments of the expedition. */
export const CALLS = {
  board: "To the ships, men of Achaea!",
  land: "Ashore! Shields up, and at them!",
  victory: "Rome is ours! Raise our colours on the gate!",
  hold: "Hold the line! Give no ground!",
};

/** World units per second. */
const PACE = { board: 30, land: 30, charge: 54, pursue: 50, rout: 52, back: 34, march: 26 };
/** How long the front ranks fight before the attack is decided, and how long the deciding takes. */
const FIGHT = 6.5;
/** Ships' speeds along each part of the voyage: rowing out, under sail, running in. */
const SAILING = { out: 22, open: 50, approach: 30 };

type Stage_ = "home" | "boarding" | "voyage" | "offshore" | "landing" | "ready" | "assault" | "done" | "returning";

type Soldier = {
  id: string;
  entity: Figure;
  /** The company's story he is part of. */
  run: Run;
  company: number;
  role: "hoplite" | "archer";
  rank: number;
  file: number;
  ship: number;
  /** Deck spot on the ship. */
  spot: number;
  /** aboard: carried by the ship; walking: on a path; posted: standing (acting) where he is. */
  state: "aboard" | "walking" | "posted";
  steps: Step[];
  speed: number;
  travelled: number;
  then: (() => void) | null;
  /** What he does standing, and which way he faces. */
  idle: Act;
  facing: number;
  phase: number;
  /** Seconds left lying knocked down. */
  down: number;
  frame: number;
  doing: string;
  /** Waiting to start walking (a queue up a plank). */
  wait: number;
};

type Ship = {
  index: number;
  hull: Entity;
  rig: Entity;
  wake: Entity;
  x: number;
  y: number;
  dir: number;
  /** moored: alongside at home; sailing: on the way; anchored: waiting off the city; beached: run in at its quay; homeward: sailing back. */
  state: "moored" | "sailing" | "anchored" | "beached" | "homeward";
  path: Array<Point & { speed: number; dir: number; sail: number }>;
  leg: number;
  /** The way out to the city (from the berth to the quay), and how many of its points the ship has passed. */
  route: Array<Point & { speed: number; dir: number; sail: number }>;
  passed: number;
  rowed: number;
  plank: Plank;
  sail: number;
  /** Where it has been lately, for its wake (world, with the time it was there). */
  trail: Array<{ x: number; y: number; t: number }>;
  speed: number;
};

type Legionary = {
  entity: Figure;
  century: number;
  file: number;
  rank: number;
  /** Where he is headed (`a`, `b`) and what he does there; routed men run for the gate and in. */
  to: { a: number; b: number };
  act: Act;
  routed: boolean;
  gone: boolean;
  /** Coming back out of the gate (the expedition went home). */
  back: boolean;
  down: number;
  phase: number;
  travelled: number;
};

type Run = {
  stage: Stage_;
  /** Scene time the current stage began. */
  since: number;
  outcome: Outcome | null;
  ship: number;
  /** The century of the legion facing this company in the city. */
  century: number;
};

type Missile = { from: Point; to: Point; peak: number; t: number; duration: number; entity: Entity; land: () => void };
type Puff = { entity: Entity; age: number; life: number };

const CENTURIES = 4;

export class Expedition {
  private readonly ships: Ship[] = [];
  private readonly soldiers = new Map<string, Soldier>();
  private readonly romans: Legionary[] = [];
  private readonly centurion: Figure & { routed: boolean; gone: boolean; back: boolean };
  private readonly ballistae: Array<{ entity: Entity; wait: number; loosed: number }> = [];
  private readonly standards: Entity[] = [];
  private readonly missiles: Missile[] = [];
  private readonly puffs: Puff[] = [];
  private readonly scenery: Array<{ entity: Entity; box: { x0: number; y0: number; x1: number; y1: number } }> = [];
  private plan: BattlePlan = { phase: "none", companies: [], rival: null, benchmark: null, score: null };
  private enlisted: Enlisted[] = [];
  private runs: Run[] = [];
  private time = 0;
  private sparkWait = 0;
  private won = false;
  /** When the gate's banners began to change hands. */
  private swapAt = -1e9;
  private called = new Set<string>();
  private glints: Array<{ sx: number; sy: number; phase: number; speed: number; size: number }> = [];
  private glinting: Entity | null = null;

  constructor(
    private readonly stage: Stage,
    private readonly hooks: ExpeditionHooks,
  ) {
    // The sea first, under everything; its glints and the ships' wakes on it; then the lands.
    seaTiles().forEach((t, i) => this.addScenery({ x: 0, y: 0, z: 0, ground: true, job: { k: "sea", i }, reveal: 0, priority: 2 }, worldBox(t)));
    this.glints = makeGlints();
    this.glinting = stage.add({ x: 0, y: 0, z: 0, ground: true, reveal: 0, paint: (ctx, sx, sy, px, time) => this.paintGlints(ctx, sx, sy, px, time) });
    this.addScenery(this.glinting, screenBox({ x0: SEA.cx - SEA.hw, y0: SEA.cy - SEA.hh, x1: SEA.cx + SEA.hw, y1: SEA.cy + SEA.hh }));
    for (let k = 0; k < BERTHS_SX.length; k++) this.ships.push(this.makeShip(k));
    this.addScenery({ x: 0, y: 0, z: 0, ground: true, job: { k: "shore-road" }, reveal: 0, priority: 3 }, screenBox({ x0: -260, y0: 400, x1: -140, y1: 500 }));
    this.addScenery({ x: 0, y: 0, z: 0, ground: true, job: { k: "shore" }, reveal: 0, priority: 3 }, screenBox({ x0: -440, y0: 420, x1: 220, y1: 512 }));
    romeTiles().forEach((t, i) => this.addScenery({ x: 0, y: 0, z: 0, ground: true, job: { k: "rome", i }, reveal: 0, priority: 2 }, worldBox(t)));
    ISLETS.forEach((islet, i) => {
      const c = isletAt(i);
      this.addScenery({ x: c.x, y: c.y, z: 0, ground: true, job: { k: "islet", i }, reveal: 0, priority: 2 }, screenBox({ x0: islet.sx - 60, y0: islet.sy - 50, x1: islet.sx + 60, y1: islet.sy + 30 }));
    });
    for (const p of [...harborProps(), ...romeProps(), ...isletProps()]) this.addProp(p);
    // The engines on the gate towers, and banners over them.
    for (const b of ROME_WALL.guns) {
      const p = romePoint(ROME_LINES.gate, b);
      const entity = stage.add({ x: p.x - 2, y: p.y, z: CITY.towerTop + 0.2, sort: 40, job: { k: "prop", id: "ballista", v: 0 } as Job, reveal: 0, priority: 2.5 });
      this.addScenery(entity, around(entity, 30));
      this.ballistae.push({ entity, wait: 2 + this.ballistae.length * 1.7, loosed: 0 });
      for (const side of [-1, 1]) {
        const banner = stage.add({ x: p.x + 7, y: p.y + side * 7, z: CITY.towerTop + 0.2, sort: 45, job: { k: "prop", id: "standard", v: 0 } as Job, reveal: 0, priority: 2.5 });
        this.addScenery(banner, around(banner, 30));
        this.standards.push(banner);
      }
    }
    // The legion: four centuries of two ranks of three, the centurion behind them.
    for (let century = 0; century < CENTURIES; century++) {
      for (let i = 0; i < 6; i++) {
        const file = (i % 3) - 1;
        const rank = Math.floor(i / 3);
        const to = this.restOf(century, file, rank);
        const p = romePoint(to.a, to.b);
        const entity: Figure = stage.add({ x: p.x, y: p.y, z: 0, look: LOOK.roman + ((century + i) % 3), act: "stand" as Act, dir: 4, shadow: 5, reveal: 0, priority: 2.6, job: null as Job | null });
        this.addScenery(entity, around(entity, 30));
        this.romans.push({ entity, century, file, rank, to, act: "stand", routed: false, gone: false, back: false, down: 0, phase: Math.random() * 5, travelled: 0 });
      }
    }
    const c = romePoint(ROME_LINES.centurion, 0);
    this.centurion = Object.assign(stage.add({ x: c.x, y: c.y, z: 0, look: LOOK.centurion, act: "stand" as Act, dir: 4, shadow: 5, reveal: 0, priority: 2.6, job: null as Job | null }), { routed: false, gone: false, back: false });
    this.addScenery(this.centurion, around(this.centurion, 30));
  }

  // --- Scenery ---------------------------------------------------------------------------------------

  private addScenery(entity: Entity, box: { x0: number; y0: number; x1: number; y1: number }) {
    if (!this.stage.has(entity)) this.stage.add(entity);
    this.scenery.push({ entity, box });
    this.hooks.scenery(entity);
  }

  private addProp(p: Standing) {
    const entity: Entity = this.stage.add({ x: p.x, y: p.y, z: p.z ?? 0, sort: p.sort ?? 0, job: { k: "prop", id: p.prop, v: p.v ?? 0 } as Job, reveal: 0, priority: 2.5 });
    this.addScenery(entity, around(entity, p.prop === "pharos" ? 130 : p.prop === "amphitheatre" ? 140 : p.prop === "temple" || p.prop === "aqueduct" ? 110 : 70));
    if (p.key === "pharos" || p.key === "firetower" || p.key === "fountain") {
      // Fires flicker, the fountain plays.
      const id = p.prop;
      const frames = id === "fountain" ? 2 : 3;
      entity.tick = (_dt, time) => {
        if (entity.job?.k === "prop") entity.job = { ...entity.job, v: Math.floor(time / 0.16) % frames };
      };
    }
  }

  private makeShip(k: number): Ship {
    const berth = homeBerth(k);
    const hull = this.stage.add({ x: berth.x, y: berth.y, z: 0, job: null as Job | null, reveal: 0, priority: 2.8 });
    const rig = this.stage.add({ x: berth.x, y: berth.y, z: 0, job: null as Job | null, reveal: 0, priority: 2.8 });
    const ship: Ship = { index: k, hull, rig, wake: null as unknown as Entity, x: berth.x, y: berth.y, dir: BERTH_DIR, state: "moored", path: [], leg: 0, route: [], passed: 0, rowed: 0, plank: 0, sail: 0, trail: [], speed: 0 };
    ship.wake = this.stage.add({ x: 0, y: 0, z: 0, ground: true, paint: (ctx, sx, sy, px, time) => this.paintWake(ship, ctx, sx, sy, px, time) });
    this.addScenery(hull, around(hull, 80));
    this.addScenery(rig, around(rig, 80));
    this.scenery.push({ entity: ship.wake, box: { x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 } });
    this.drawShip(ship);
    return ship;
  }

  /** Reveals the scenery as it comes into view (the dock and the sea materialise as you look down at them). */
  revealTick(dt: number, showing: boolean) {
    const { width, height } = this.stage.size;
    const cam = this.stage.camera;
    const hw = width / 2 / cam.zoom + 40;
    const hh = height / 2 / cam.zoom + 40;
    const view = { x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh };
    for (const { entity, box } of this.scenery) {
      if (!showing) {
        entity.reveal = Math.max(0, (entity.reveal ?? 0) - dt * 2);
        continue;
      }
      const reveal = entity.reveal ?? 1;
      if (reveal >= 1) continue;
      const seen = box.x1 > view.x0 && box.x0 < view.x1 && box.y1 > view.y0 && box.y0 < view.y1;
      if (seen || reveal > 0) entity.reveal = Math.min(1, reveal + dt * (entity.ground ? 1.1 : 1.6));
    }
    // The army's figures follow their ship or the ground they stand on.
    for (const s of this.soldiers.values()) if ((s.entity.reveal ?? 1) < 1) s.entity.reveal = Math.min(1, (s.entity.reveal ?? 0) + dt * 1.6);
  }

  // --- The plan --------------------------------------------------------------------------------------

  /**
   * Applies the battle plan and the army in it. `instantly`: a camp opened directly, so everything
   * goes straight to where the plan has it (no voyage to watch).
   */
  apply(plan: BattlePlan, army: Enlisted[], instantly = false) {
    this.plan = plan;
    this.enlisted = army;
    const count = plan.companies.length;
    const ships = shipsFor(count);
    const centuries = centuriesFor(count);
    const runs: Run[] = [];
    for (let k = 0; k < Math.max(count, this.runs.length); k++) {
      const previous = this.runs[k];
      if (k >= count) {
        // No longer in the plan: it finishes coming home first.
        runs.push(previous);
        continue;
      }
      const run: Run = previous ?? { stage: "home", since: this.time, outcome: null, ship: ships[k], century: centuries[k] };
      // A company under way keeps its ship and the century it faces.
      if (run.stage === "home") {
        run.ship = ships[k];
        run.century = centuries[k];
      }
      runs.push(run);
    }
    while (runs.length > count && runs[runs.length - 1].stage === "home") runs.pop();
    this.runs = runs;
    for (const a of army) {
      const s = this.soldiers.get(a.id);
      if (s) Object.assign(s, { company: a.company, rank: a.rank, file: a.file, role: a.role });
    }
    if (instantly) this.settleInstantly();
    this.decideStandards();
  }

  /** Clears the expedition: the ships back at their berths, the legion at rest (a different camp, or back to the landing). */
  reset() {
    for (const m of this.missiles) this.stage.remove(m.entity);
    for (const p of this.puffs) this.stage.remove(p.entity);
    this.missiles.length = 0;
    this.puffs.length = 0;
    this.soldiers.clear();
    this.runs = [];
    this.timers.length = 0;
    this.enlisted = [];
    this.plan = { phase: "none", companies: [], rival: null, benchmark: null, score: null };
    this.won = false;
    this.called.clear();
    for (const ship of this.ships) {
      const berth = homeBerth(ship.index);
      Object.assign(ship, { x: berth.x, y: berth.y, dir: BERTH_DIR, state: "moored", path: [], leg: 0, route: [], passed: 0, plank: 0, sail: 0, trail: [], speed: 0 });
      this.drawShip(ship);
    }
    for (const r of this.romans) {
      Object.assign(r, { to: this.restOf(r.century, r.file, r.rank), act: "stand", routed: false, gone: false, back: false, down: 0 });
      this.put(r);
      r.entity.alpha = 1;
      if (!this.stage.has(r.entity)) this.stage.add(r.entity);
    }
    const c = romePoint(ROME_LINES.centurion, 0);
    Object.assign(this.centurion, { x: c.x, y: c.y, dir: 4, act: "stand", routed: false, gone: false, back: false, alpha: 1 });
    if (!this.stage.has(this.centurion)) this.stage.add(this.centurion);
    this.decideStandards();
  }

  // --- Running it --------------------------------------------------------------------------------------

  tick(dt: number) {
    this.time += dt;
    this.runs.forEach((run, k) => this.advance(run, k));
    for (const ship of this.ships) this.sail(ship, dt);
    for (const s of this.soldiers.values()) this.moveSoldier(s, dt);
    this.moveRomans(dt);
    const fighting = this.runs.some((r) => r.stage === "assault");
    this.figure(this.centurion, this.centurion.routed || this.centurion.back ? "march" : fighting ? "point" : "stand", 0.7);
    this.workBallistae(dt);
    if (fighting) this.clashSparks(dt);
    this.flyMissiles(dt);
    this.agePuffs(dt);
  }

  /** Moves one company's story on when the plan and the scene allow. */
  private advance(run: Run, k: number) {
    const company = this.plan.companies[k];
    const going = company?.state === "sent" || company?.state === "engaged";
    // The plan stepped back (the demo started over): everyone goes home.
    if (!going && run.stage !== "home" && run.stage !== "returning") this.recall(run);
    if (run.stage === "returning") return this.comeHome(run);
    if (!company) return;
    const ship = this.ships[run.ship];
    const members = this.members(k);
    switch (run.stage) {
      case "home": {
        if (!going) return;
        this.to(run, "boarding");
        ship.plank = 1;
        if (!this.called.has("board")) {
          this.called.add("board");
          const leader = members.find((m) => m.rank === 0 && m.file === 0) ?? members[0];
          if (leader) this.hooks.say(leader.id, CALLS.board, 3.4);
        }
        return;
      }
      case "boarding": {
        // Take each soldier as he reaches the quay, and send him up the plank.
        let queue = 0;
        for (const m of members) {
          if (this.soldiers.has(m.id)) continue;
          const entity = this.hooks.claim(m.id);
          if (!entity) continue;
          this.board(this.enlist(m, entity, run), queue++ * 0.35);
        }
        // Sail once everyone for this ship is aboard (every company it carries).
        const sharing = this.runs.filter((r) => r.ship === run.ship);
        const crew = this.shipMembers(run.ship);
        const aboard = crew.filter((m) => this.soldiers.get(m.id)?.state === "aboard").length;
        const climbing = crew.some((m) => this.soldiers.get(m.id)?.state === "walking");
        // Everyone aboard; or, long after the order to board, everyone who made it to the quay.
        const late = this.time - run.since > 40 && aboard > 0 && !climbing;
        const allAboard = sharing.every((r) => r.stage === "boarding" || r.stage === "voyage") && (aboard === crew.length || late);
        if (allAboard && ship.state === "moored") {
          ship.plank = 0;
          this.setSail(ship);
          for (const r of sharing) this.to(r, "voyage");
        }
        return;
      }
      case "voyage":
        if (ship.state === "beached" && company.state === "engaged") {
          this.to(run, "landing");
          this.beginLanding(run, k);
        } else if (ship.state === "anchored" || ship.state === "beached") this.to(run, "offshore");
        return;
      case "offshore":
        if (company.state === "engaged") {
          this.runIn(ship);
          this.to(run, "voyage");
        }
        return;
      case "landing":
        if (members.every((m) => this.soldiers.get(m.id)?.state === "posted")) this.to(run, "ready");
        return;
      case "ready":
        if (company.ratio !== null && this.time - run.since > 0.6) this.beginAssault(run, k);
        return;
      case "assault":
        if (this.time - run.since > FIGHT) this.decide(run, k, company);
        return;
      case "done": {
        // Numbers that change after the fight change its outcome.
        const outcome = outcomeOf(company);
        if (outcome && outcome !== run.outcome && this.time - run.since > 2) this.beginAssault(run, k);
        return;
      }
    }
  }

  private to(run: Run, stage: Stage_) {
    run.stage = stage;
    run.since = this.time;
  }

  // --- Boarding and sailing --------------------------------------------------------------------------

  private enlist(m: Enlisted, entity: Figure, run: Run): Soldier {
    const ship = run.ship;
    const spot = this.deckIndex(m, ship);
    const s: Soldier = { id: m.id, entity, run, company: m.company, role: m.role, rank: m.rank, file: m.file, ship, spot, state: "posted", steps: [], speed: PACE.board, travelled: 0, then: null, idle: "stand", facing: entity.dir, phase: Math.random() * 10, down: 0, frame: -1, doing: "Waiting on the quay to board", wait: 0 };
    this.soldiers.set(m.id, s);
    return s;
  }

  /** Which of the ship's ten deck spots a soldier takes: his company's block, then his place in it. */
  private deckIndex(m: Enlisted, ship: number) {
    const sharing = this.runs.map((r, k) => ({ r, k })).filter(({ r }) => r.ship === ship).map(({ k }) => k);
    const block = Math.max(0, sharing.indexOf(m.company));
    const per = sharing.length > 1 ? 5 : 10;
    const order = this.members(m.company).findIndex((x) => x.id === m.id);
    return Math.min(9, block * per + Math.max(0, order));
  }

  private board(s: Soldier, delay: number) {
    const ship = this.ships[s.ship];
    const foot = inShip(ship, ship.dir, PLANK_FOOT.side.x, PLANK_FOOT.side.y);
    const head = inShip(ship, ship.dir, PLANK_HEAD.side.x, PLANK_HEAD.side.y);
    const spot = deckSpot(s.spot >> 1, s.spot & 1 ? 1 : -1);
    const deck = inShip(ship, ship.dir, spot.x, spot.y);
    s.wait = delay;
    s.doing = "Going up the gangplank";
    this.walk(s, [foot, { ...head, z: HULL.deck + 0.4 }, { ...deck, z: HULL.deck, dir: ship.dir }], PACE.board, () => {
      s.state = "aboard";
      s.doing = "Aboard, waiting to sail";
    });
  }

  /** The way out of the harbour and across the sea to the city, in legs along the eight headings. */
  private setSail(ship: Ship) {
    const k = ship.index;
    const berth = homeBerth(k);
    const along = (p: Point, dir: number, d: number) => ({ x: p.x + Math.cos((dir * Math.PI) / 4) * d, y: p.y + Math.sin((dir * Math.PI) / 4) * d, z: 0 });
    const p1 = along(berth, 7, 24);
    const p2 = along(p1, 0, 26);
    const rome = romePoint(ROME_LINES.ship, ROME_BERTHS_B[k]);
    // South (screen down) until level with the berth across the battle, then in along +x.
    const turn = { x: p2.x + (rome.y - p2.y), y: rome.y, z: 0 };
    const anchor = along(rome, 4, 70);
    ship.path = [
      { ...p1, speed: SAILING.out, dir: 7, sail: 0 },
      { ...p2, speed: SAILING.out, dir: 0, sail: 0 },
      { ...turn, speed: SAILING.open, dir: 1, sail: 1 },
      { ...anchor, speed: SAILING.approach, dir: 0, sail: 1 },
    ];
    ship.route = [...ship.path, { ...rome, speed: SAILING.approach * 0.8, dir: 0, sail: 0 }];
    ship.passed = 0;
    ship.leg = 0;
    ship.state = "sailing";
    for (const s of this.soldiers.values()) if (s.ship === k && s.state === "aboard") s.doing = "Sailing for the rival's city";
  }

  /** From the anchorage off the city, in to the quay, bow first. */
  private runIn(ship: Ship) {
    const rome = romePoint(ROME_LINES.ship, ROME_BERTHS_B[ship.index]);
    ship.path = [{ ...rome, speed: SAILING.approach * 0.8, dir: 0, sail: 0 }];
    ship.leg = 0;
    ship.state = "sailing";
  }

  /** Back the way it came: from wherever it is on its route, to its berth at home. */
  private sailHome(ship: Ship) {
    const berth = homeBerth(ship.index);
    const back = [...ship.route.slice(0, ship.passed).reverse(), berth];
    const path: Ship["path"] = [];
    let from = { x: ship.x, y: ship.y };
    for (const p of back) {
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      path.push({ x: p.x, y: p.y, z: 0, speed: len > 120 ? SAILING.open : SAILING.out, dir: dirFor(dx, dy), sail: len > 120 ? 1 : 0 });
      from = p;
    }
    ship.path = path;
    ship.leg = 0;
    ship.plank = 0;
    ship.state = "homeward";
  }

  /** The plan has stepped back: the company re-embarks wherever it is, and the legion takes back what it lost. */
  private recall(run: Run) {
    this.to(run, "returning");
    run.outcome = null;
    const ship = this.ships[run.ship];
    this.legionReturns();
    for (const s of this.soldiersOf(run)) {
      if (s.state === "aboard") continue;
      if (ship.state === "moored") this.disembarkHome(s);
      else this.reembark(s, ship);
    }
    this.decideStandards();
  }

  /** A returning company: aboard, home across the sea, and back down the plank to the camp. */
  private comeHome(run: Run) {
    const ship = this.ships[run.ship];
    const soldiers = this.soldiersOf(run);
    if (ship.state === "moored") {
      if (soldiers.length) ship.plank = 1;
      for (const s of soldiers) if (s.state === "aboard") this.disembarkHome(s);
      if (!soldiers.length) {
        this.to(run, "home");
        if (!this.runs.some((r) => r.ship === ship.index && r.stage !== "home")) ship.plank = 0;
      }
      return;
    }
    if (ship.state === "homeward") return;
    const sharing = this.runs.filter((r) => r.ship === run.ship);
    const ready = soldiers.every((s) => s.state === "aboard") && sharing.every((r) => r.stage === "returning" || r.stage === "home");
    if (ready) this.sailHome(ship);
  }

  /** At home: back down the gangplank to the quay, and over to the camp. */
  private disembarkHome(s: Soldier) {
    const ship = this.ships[s.ship];
    const release = () => {
      this.soldiers.delete(s.id);
      this.hooks.release(s.id);
    };
    // Not on the plank yet: straight back to the camp.
    if (s.state !== "aboard" && s.entity.z < 0.5) return release();
    const head = inShip(ship, ship.dir, PLANK_HEAD.side.x, PLANK_HEAD.side.y);
    const foot = inShip(ship, ship.dir, PLANK_FOOT.side.x, PLANK_FOOT.side.y);
    s.doing = "Back down the gangplank, home";
    s.wait = 0;
    this.walk(s, [{ ...head, z: HULL.deck + 0.4 }, foot], PACE.board, release);
  }

  /** In the city: back up the bow's plank to the deck. */
  private reembark(s: Soldier, ship: Ship) {
    const foot = inShip(ship, ship.dir, PLANK_FOOT.bow.x, PLANK_FOOT.bow.y);
    const head = inShip(ship, ship.dir, PLANK_HEAD.bow.x, PLANK_HEAD.bow.y);
    const spot = deckSpot(s.spot >> 1, s.spot & 1 ? 1 : -1);
    const deck = inShip(ship, ship.dir, spot.x, spot.y);
    s.doing = "Back aboard, to sail home";
    s.wait = 0;
    s.down = 0;
    this.walk(s, [foot, { ...head, z: HULL.deck + 0.1 }, { ...deck, z: HULL.deck, dir: ship.dir }], PACE.board, () => {
      s.state = "aboard";
      s.doing = "Aboard, sailing home";
    });
  }

  /** Whoever fled into the gate comes back out to the line, except the centuries a company still holds the field against. */
  private legionReturns() {
    const beaten = new Set(this.runs.filter((r) => r.outcome === "won" && r.stage !== "returning").map((r) => r.century));
    for (const r of this.romans) {
      if (beaten.has(r.century)) continue;
      r.to = this.restOf(r.century, r.file, r.rank);
      r.act = "stand";
      if (!r.routed && !r.gone) continue;
      if (r.gone) this.inGate(r.entity, r.century * 3 + r.file);
      r.routed = false;
      r.gone = false;
      r.back = true;
    }
    if (this.centurion.routed || this.centurion.gone) {
      if (this.centurion.gone) this.inGate(this.centurion, 5);
      Object.assign(this.centurion, { routed: false, gone: false, back: true });
    }
  }

  /** Puts a figure back in the dark of the gate's passage, ready to walk out. */
  private inGate(e: Figure, lane: number) {
    const inside = romePoint(ROME_LINES.gate + 2, ((lane % 5) - 2) * 1.6);
    Object.assign(e, { x: inside.x, y: inside.y, z: 0, alpha: 0 });
    if (!this.stage.has(e)) this.stage.add(e);
  }

  private sail(ship: Ship, dt: number) {
    if (ship.state === "sailing" || ship.state === "homeward") {
      let remaining = 0;
      const leg = ship.path[ship.leg];
      if (leg) {
        remaining = leg.speed * dt;
        ship.speed = leg.speed;
        const dx = leg.x - ship.x;
        const dy = leg.y - ship.y;
        const left = Math.hypot(dx, dy);
        ship.dir = leg.dir;
        ship.sail = leg.sail;
        if (left <= remaining) {
          ship.x = leg.x;
          ship.y = leg.y;
          ship.leg++;
          if (ship.state === "sailing") ship.passed = Math.min(ship.route.length, ship.passed + (ship.path === ship.route ? 0 : 1));
        } else {
          ship.x += (dx / left) * remaining;
          ship.y += (dy / left) * remaining;
        }
        ship.rowed += remaining;
      }
      if (ship.leg >= ship.path.length && ship.state === "homeward") {
        // Home: alongside the quay again, heading the way it lies at its berth.
        const berth = homeBerth(ship.index);
        Object.assign(ship, { x: berth.x, y: berth.y, dir: BERTH_DIR, state: "moored", speed: 0, sail: 0, route: [], passed: 0 });
      } else if (ship.leg >= ship.path.length) {
        // Arrived: at the anchorage (wait for the word to land) or at the quay.
        const quay = romePoint(ROME_LINES.ship, ROME_BERTHS_B[ship.index]);
        const atQuay = Math.hypot(ship.x - quay.x, ship.y - quay.y) < 1;
        ship.state = atQuay ? "beached" : "anchored";
        ship.passed = atQuay ? ship.route.length : ship.route.length - 1;
        ship.speed = 0;
        ship.sail = 0;
        if (!atQuay) {
          // Only go on in if a company aboard is ashore already in the plan.
          const engaged = this.runs.some((r, k) => r.ship === ship.index && this.plan.companies[k]?.state === "engaged");
          if (engaged) this.runIn(ship);
        }
      }
      if (this.time - (ship.trail[ship.trail.length - 1]?.t ?? -1) > 0.08) {
        ship.trail.push({ x: ship.x, y: ship.y, t: this.time });
        if (ship.trail.length > 40) ship.trail.shift();
      }
    } else if (ship.trail.length && this.time - ship.trail[0].t > 3) ship.trail.shift();
    this.drawShip(ship);
  }

  private drawShip(ship: Ship) {
    const rowing = ship.state === "sailing" || ship.state === "homeward";
    const f = rowing ? Math.floor(ship.rowed / 3.2) % ROW_FRAMES : OARS_IN;
    const c = ship.index;
    for (const e of [ship.hull, ship.rig]) {
      e.x = ship.x;
      e.y = ship.y;
    }
    ship.hull.job = { k: "hull", dir: ship.dir, f, c, p: ship.plank } as Job;
    ship.rig.job = { k: "rig", dir: ship.dir, s: ship.sail, c } as Job;
    // The hull goes under everyone on deck; the rig sorts at the mast, so the sail hides men behind it.
    const a = (ship.dir * Math.PI) / 4;
    const depth = (x: number, y: number) => x * (Math.cos(a) + Math.sin(a)) + y * (Math.cos(a) - Math.sin(a));
    let lowest = 0;
    for (let i = 0; i < 10; i++) {
      const spot = deckSpot(i >> 1, i & 1 ? 1 : -1);
      lowest = Math.min(lowest, depth(spot.x, spot.y));
    }
    ship.hull.sort = lowest - 1.5;
    ship.rig.sort = depth(4.2, 0) + 0.05;
  }

  // --- Landing and fighting ----------------------------------------------------------------------------

  private beginLanding(run: Run, k: number) {
    const ship = this.ships[run.ship];
    ship.plank = 2;
    const members = this.members(k).map((m) => this.soldiers.get(m.id)).filter((s): s is Soldier => Boolean(s));
    const head = inShip(ship, ship.dir, PLANK_HEAD.bow.x, PLANK_HEAD.bow.y);
    const foot = inShip(ship, ship.dir, PLANK_FOOT.bow.x, PLANK_FOOT.bow.y);
    // Front rank first, down the plank and into line at the landing.
    members
      .slice()
      .sort((a, b) => a.rank - b.rank || a.file - b.file)
      .forEach((s, i) => {
        const place = this.place(s, k, ROME_LINES.landing);
        s.state = "walking";
        s.wait = i * 0.32;
        s.doing = "Down the gangplank, ashore";
        this.walk(s, [{ ...head, z: HULL.deck + 0.1 }, foot, { ...place, dir: 0 }], PACE.land, () => {
          s.idle = "stand";
          s.facing = 0;
          s.doing = "Formed up on the quay, waiting for the video's numbers";
        });
      });
    if (!this.called.has("land")) {
      this.called.add("land");
      const leader = members.find((m) => m.rank === 0 && m.file === 0) ?? members[0];
      if (leader) this.hooks.say(leader.id, CALLS.land, 3.2);
    }
  }

  /** A soldier's place in his company's formation, with its front rank at `front` (battle `a`). */
  private place(s: Soldier, k: number, front: number): Point {
    const b = companyB(k, this.plan.companies.length);
    if (s.role === "archer") return romePoint(front - 2 * RANK_GAP - 6, b + 7);
    return romePoint(front - s.rank * RANK_GAP, b + s.file * FILE_GAP);
  }

  private beginAssault(run: Run, k: number) {
    this.to(run, "assault");
    run.outcome = null;
    for (const s of this.companySoldiers(k)) {
      const front = ROME_LINES.clash;
      if (s.role === "archer") {
        this.walk(s, [{ ...this.place(s, k, front - 14), dir: 0 }], PACE.march, () => {
          s.idle = "shoot";
          s.facing = 0;
          s.doing = "Loosing arrows over the phalanx at the legion";
        });
        s.doing = "Moving up behind the phalanx";
        continue;
      }
      s.doing = "Charging the legion";
      this.walk(
        s,
        [{ ...this.place(s, k, front), dir: 0, act: "charge" }],
        PACE.charge,
        () => {
          s.idle = s.rank === 0 ? "fight" : "stand";
          s.facing = 0;
          s.doing = s.rank === 0 ? "Fighting in the front rank" : "Pressing behind the front rank";
        },
        "charge",
      );
    }
    // The century facing them steps up to meet them (if it hasn't already fled).
    if (!this.romans.some((r) => r.century === run.century && !r.routed && !r.gone)) {
      this.decide(run, k, this.plan.companies[k]);
      return;
    }
    for (const r of this.romans) {
      if (r.century !== run.century || r.gone) continue;
      r.routed = false;
      const b = companyB(k, this.plan.companies.length);
      r.to = { a: ROME_LINES.clash + CLASH_GAP + r.rank * RANK_GAP, b: b + r.file * FILE_GAP };
      r.act = r.rank === 0 ? "fight" : "stand";
    }
  }

  /** The fight is over: the company routs the century, holds, or is thrown back. */
  private decide(run: Run, k: number, company: Company) {
    const outcome = outcomeOf(company) ?? "held";
    run.outcome = outcome;
    this.to(run, "done");
    const soldiers = this.companySoldiers(k);
    if (outcome === "won") {
      for (const s of soldiers) {
        s.doing = "Routed the legion: the video beats the top videos";
        this.walk(s, [{ ...this.place(s, k, ROME_LINES.pursuit), dir: 0 }], PACE.pursue, () => {
          s.idle = "cheer";
          s.facing = 0;
        });
      }
      for (const r of this.romans) if (r.century === run.century) this.rout(r);
    } else {
      const back = outcome === "held" ? ROME_LINES.clash - 16 : ROME_LINES.fallback;
      for (const s of soldiers) {
        s.doing = outcome === "held" ? "Holding the line: level with the top videos" : "Thrown back to the quay: the video trails the top videos";
        this.walk(s, [{ ...this.place(s, k, back), dir: 0 }], PACE.back, () => {
          s.idle = "stand";
          s.facing = 0;
        });
      }
      for (const r of this.romans) {
        if (r.century !== run.century || r.gone) continue;
        r.to = this.restOf(r.century, r.file, r.rank);
        r.act = "stand";
      }
      if (outcome === "held" && !this.called.has(`hold${k}`)) {
        this.called.add(`hold${k}`);
        const leader = soldiers.find((s) => s.rank === 0 && s.file === 0);
        if (leader) this.hooks.say(leader.id, CALLS.hold, 3);
      }
    }
    this.decideStandards();
  }

  /** Every company has fought, and won: the whole legion breaks, and the gate's banners change hands. */
  private decideStandards() {
    const companies = this.plan.companies;
    const won = companies.length > 0 && companies.every((_, k) => this.runs[k]?.outcome === "won");
    if (won && !this.won) {
      this.won = true;
      this.swapAt = this.time + 1.2;
      for (const r of this.romans) this.rout(r);
      this.centurion.routed = true;
      if (!this.called.has("victory")) {
        this.called.add("victory");
        const first = this.runs.findIndex((r) => r.outcome === "won");
        const leader = this.companySoldiers(first).find((s) => s.rank === 0 && s.file === 0);
        if (leader) this.later(1.6, () => this.hooks.say(leader.id, CALLS.victory, 4));
      }
    }
    if (!won && this.won) {
      this.won = false;
      this.swapAt = -1e9;
    }
    this.waveStandards();
  }

  /** The gate's banners wave; once the city falls they come down, and the Greeks' go up in their place. */
  private waveStandards() {
    const t = (this.time - this.swapAt) / 1.6;
    const greek = this.won && t >= 0.5;
    const lowered = this.won && t > 0 && t < 1 ? (t < 0.5 ? t * 2 : (1 - t) * 2) : 0;
    for (const banner of this.standards) {
      banner.job = { k: "prop", id: "standard", v: (greek ? 4 : 0) + (Math.floor(this.time / 0.2) % 4) } as Job;
      banner.z = CITY.towerTop + 0.2 - lowered * 16;
    }
  }

  private rout(r: Legionary) {
    if (r.routed || r.gone) return;
    r.routed = true;
    r.down = 0;
    r.act = "march";
  }

  private readonly timers: Array<{ at: number; run: () => void }> = [];
  private later(seconds: number, run: () => void) {
    this.timers.push({ at: this.time + seconds, run });
  }

  /** Puts everything where the plan leaves it, with nothing to watch on the way. */
  private settleInstantly() {
    this.runs.forEach((run, k) => {
      const company = this.plan.companies[k];
      if (!company) return;
      const going = company.state === "sent" || company.state === "engaged";
      if (!going) return;
      const ship = this.ships[run.ship];
      const members = this.members(k);
      // Everyone straight aboard (their figures come off the quay).
      for (const m of members) {
        if (this.soldiers.has(m.id)) continue;
        const entity = this.hooks.claim(m.id);
        if (entity) this.enlist(m, entity, run);
      }
      const rome = romePoint(ROME_LINES.ship, ROME_BERTHS_B[run.ship]);
      if (company.state === "sent") {
        const anchor = { x: rome.x - 70, y: rome.y };
        Object.assign(ship, { x: anchor.x, y: anchor.y, dir: 0, state: "anchored", sail: 0, plank: 0 });
        for (const s of this.companySoldiers(k)) {
          s.state = "aboard";
          s.doing = "Aboard, waiting off the rival's city";
        }
        run.stage = "offshore";
      } else {
        Object.assign(ship, { x: rome.x, y: rome.y, dir: 0, state: "beached", sail: 0, plank: 2 });
        const outcome = outcomeOf(company);
        run.outcome = outcome;
        run.stage = outcome ? "done" : "ready";
        const front = outcome === "won" ? ROME_LINES.pursuit : outcome === "held" ? ROME_LINES.clash - 16 : outcome === "repulsed" ? ROME_LINES.fallback : ROME_LINES.landing;
        for (const s of this.companySoldiers(k)) {
          const p = this.place(s, k, front);
          Object.assign(s.entity, { x: p.x, y: p.y, z: 0, dir: 0 });
          s.state = "posted";
          s.steps = [];
          s.idle = outcome === "won" ? "cheer" : "stand";
          s.facing = 0;
          s.doing = outcome === "won" ? "Routed the legion: the video beats the top videos" : outcome ? "Holding their ground" : "Formed up on the quay, waiting for the video's numbers";
        }
        if (outcome === "won") for (const r of this.romans) if (r.century === run.century) this.vanishRoman(r);
      }
      this.drawShip(ship);
    });
    this.decideStandards();
    if (this.won) {
      for (const r of this.romans) this.vanishRoman(r);
      this.centurion.gone = true;
      this.stage.remove(this.centurion);
    }
  }

  private vanishRoman(r: Legionary) {
    r.routed = true;
    r.gone = true;
    this.stage.remove(r.entity);
  }

  // --- Soldiers ---------------------------------------------------------------------------------------

  private walk(s: Soldier, steps: Step[], speed: number, then: () => void, act: Act = "march") {
    s.state = "walking";
    s.steps = steps.map((p) => ({ ...p, act: p.act ?? act }));
    s.speed = speed;
    s.then = then;
  }

  private moveSoldier(s: Soldier, dt: number) {
    const e = s.entity;
    if (s.state === "aboard") {
      const ship = this.ships[s.ship];
      const spot = deckSpot(s.spot >> 1, s.spot & 1 ? 1 : -1);
      const p = inShip(ship, ship.dir, spot.x, spot.y);
      e.x = p.x;
      e.y = p.y;
      e.z = HULL.deck;
      e.dir = ship.dir;
      e.shadow = 0;
      // Archers on deck shoot at the legion as the ship runs in.
      const shooting = s.role === "archer" && ship.state === "sailing" && ship.leg >= ship.path.length - 1 && this.near(ship);
      this.pose(s, shooting ? "shoot" : "stand");
      return;
    }
    if (s.down > 0) {
      s.down -= dt;
      e.job = { k: "soldier", look: e.look, act: "fallen", dir: e.dir, f: 0 };
      return;
    }
    if (s.state === "walking") {
      if (s.wait > 0) {
        s.wait -= dt;
        this.pose(s, "stand");
        return;
      }
      let remaining = s.speed * dt;
      let act: Act = "march";
      while (remaining > 0 && s.steps.length) {
        const b = s.steps[0];
        act = b.act ?? "march";
        const dx = b.x - e.x;
        const dy = b.y - e.y;
        const dz = b.z - e.z;
        if (Math.hypot(dx, dy) > 0.05) e.dir = dirFor(dx, dy);
        const left = Math.hypot(dx, dy, dz);
        if (left <= remaining) {
          e.x = b.x;
          e.y = b.y;
          e.z = b.z;
          remaining -= left;
          s.travelled += left;
          s.steps.shift();
          if (!s.steps.length && b.dir !== undefined) e.dir = b.dir;
        } else {
          const k = remaining / left;
          e.x += dx * k;
          e.y += dy * k;
          e.z += dz * k;
          s.travelled += remaining;
          remaining = 0;
        }
      }
      e.shadow = e.z < 1 ? 5 : 0;
      const frames = ACT_FRAMES[act];
      const stride = Math.max(14, s.speed * 0.42);
      e.job = { k: "soldier", look: e.look, act, dir: e.dir, f: frames > 1 ? Math.floor((s.travelled / stride) * frames) % frames : 0 };
      if (!s.steps.length) {
        s.state = "posted";
        const then = s.then;
        s.then = null;
        then?.();
      }
      return;
    }
    e.dir = s.facing;
    e.shadow = e.z < 1 ? 5 : 0;
    this.pose(s, s.idle);
  }

  private pose(s: Soldier, act: Act) {
    const e = s.entity;
    const frames = ACT_FRAMES[act];
    const f = frames > 1 ? Math.floor((this.time + s.phase) / ACT_RATE[act]) % frames : 0;
    e.act = act;
    e.job = { k: "soldier", look: e.look, act, dir: e.dir, f };
    if (act === "shoot" && f === SHOOT_RELEASE && s.frame !== f) this.loose(e);
    s.frame = f;
  }

  /** A ship running in, within bowshot of the legion. */
  private near(ship: Ship) {
    const quay = romePoint(ROME_LINES.ship, ROME_BERTHS_B[ship.index]);
    return Math.hypot(ship.x - quay.x, ship.y - quay.y) < 140;
  }

  private members(k: number) {
    return this.enlisted.filter((m) => m.company === k);
  }

  private shipMembers(ship: number) {
    return this.enlisted.filter((m) => this.runs[m.company]?.ship === ship);
  }

  private companySoldiers(k: number) {
    const run = this.runs[k];
    return run ? this.soldiersOf(run) : [];
  }

  private soldiersOf(run: Run) {
    return [...this.soldiers.values()].filter((s) => s.run === run);
  }

  // --- The legion -----------------------------------------------------------------------------------

  private restOf(century: number, file: number, rank: number) {
    return { a: ROME_LINES.romans + rank * RANK_GAP, b: companyB(century, CENTURIES) + file * FILE_GAP };
  }

  private put(r: Legionary) {
    const p = romePoint(r.to.a, r.to.b);
    r.entity.x = p.x;
    r.entity.y = p.y;
    r.entity.dir = 4;
  }

  private moveRomans(dt: number) {
    for (const r of this.romans) {
      if (r.gone) continue;
      const e = r.entity;
      if (r.down > 0 && !r.routed) {
        r.down -= dt;
        e.job = { k: "soldier", look: e.look, act: "fallen", dir: e.dir, f: 0 };
        continue;
      }
      if (r.back) {
        // Out of the gate again and back into line, out of the dark of the passage.
        const mouth = romePoint(ROME_LINES.gate - CITY.gateDepth - 4, 0);
        const rest = romePoint(r.to.a, r.to.b);
        const target = e.x > mouth.x + 0.5 ? { x: mouth.x, y: e.y } : rest;
        const dx = target.x - e.x;
        const dy = target.y - e.y;
        const dist = Math.hypot(dx, dy);
        const step = Math.min(dist, PACE.march * dt);
        if (dist > 0.01) {
          e.x += (dx / dist) * step;
          e.y += (dy / dist) * step;
          e.dir = dirFor(dx, dy);
        }
        e.alpha = Math.min(1, (e.alpha ?? 1) + dt * 1.5);
        r.travelled += step;
        e.job = { k: "soldier", look: e.look, act: "march", dir: e.dir, f: Math.floor(r.travelled / 2.2) % ACT_FRAMES.march };
        if (target === rest && dist < 0.5) {
          r.back = false;
          e.alpha = 1;
          e.dir = 4;
        }
        continue;
      }
      if (r.routed) {
        // Run for the gate and into the dark of its passage.
        if (this.flee(e, dt, r.century * 3 + r.file)) {
          r.gone = true;
          this.stage.remove(e);
        }
        r.travelled += PACE.rout * dt;
        continue;
      }
      const p = romePoint(r.to.a, r.to.b);
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.4) {
        const step = Math.min(dist, PACE.march * dt);
        e.x += (dx / dist) * step;
        e.y += (dy / dist) * step;
        r.travelled += step;
        // Stepping up or back, they keep their faces to the Greeks.
        e.dir = 4;
        e.job = { k: "soldier", look: e.look, act: "march", dir: 4, f: Math.floor(r.travelled / 2.2) % ACT_FRAMES.march };
        continue;
      }
      e.dir = 4;
      this.figure(e, r.act, r.phase);
    }
    if (this.centurion.routed && !this.centurion.gone && this.flee(this.centurion, dt, 5)) {
      this.centurion.gone = true;
      this.stage.remove(this.centurion);
    }
    if (this.centurion.back) {
      const c = this.centurion;
      const rest = romePoint(ROME_LINES.centurion, 0);
      const mouth = romePoint(ROME_LINES.gate - CITY.gateDepth - 4, 0);
      const target = c.x > mouth.x + 0.5 ? mouth : rest;
      const dx = target.x - c.x;
      const dy = target.y - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) {
        const step = Math.min(dist, PACE.march * dt);
        c.x += (dx / dist) * step;
        c.y += (dy / dist) * step;
        c.dir = dirFor(dx, dy);
      }
      c.alpha = Math.min(1, (c.alpha ?? 1) + dt * 1.5);
      if (target === rest && dist < 0.5) Object.assign(c, { back: false, alpha: 1, dir: 4 });
    }
  }

  /** One step of running for the gate; true once in its passage and out of sight. */
  private flee(e: Figure, dt: number, lane: number) {
    const mouth = romePoint(ROME_LINES.gate - CITY.gateDepth - 4, ((lane % 5) - 2) * 2.2);
    const inside = romePoint(ROME_LINES.gate + 2, ((lane % 5) - 2) * 1.6);
    const target = e.x < mouth.x - 0.5 ? mouth : inside;
    const dx = target.x - e.x;
    const dy = target.y - e.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.min(dist, PACE.rout * dt);
    if (dist > 0.01) {
      e.x += (dx / dist) * step;
      e.y += (dy / dist) * step;
      e.dir = dirFor(dx, dy);
    }
    e.job = { k: "soldier", look: e.look, act: "march", dir: e.dir, f: Math.floor(this.time / 0.07) % ACT_FRAMES.march };
    // Fading into the dark of the passage.
    if (e.x > mouth.x + 1) e.alpha = Math.max(0, 1 - (e.x - mouth.x) / (inside.x - mouth.x));
    return target === inside && dist < 0.5;
  }

  private figure(e: Figure, act: Act, phase: number) {
    const frames = ACT_FRAMES[act];
    const f = frames > 1 ? Math.floor((this.time + phase) / ACT_RATE[act]) % frames : 0;
    e.job = { k: "soldier", look: e.look, act, dir: e.dir, f };
  }

  private pickRoman(front: boolean) {
    const standing = this.romans.filter((r) => r.down <= 0 && !r.routed && !r.gone);
    const preferred = front ? standing.filter((r) => r.act === "fight") : standing;
    const pool = preferred.length ? preferred : standing;
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  // --- The engines and what flies ------------------------------------------------------------------------

  /** An archer has let go of his arrow: it flies at the legion. */
  private loose(archer: Entity) {
    const target = this.pickRoman(true);
    if (!target) return;
    const t = target.entity;
    const to = { x: t.x + (Math.random() - 0.5) * 5, y: t.y + (Math.random() - 0.5) * 5, z: 0 };
    this.fire("arrow", { x: archer.x + 1, y: archer.y + 1, z: archer.z + 13 }, to, 20 + Math.random() * 12, 0.9 + Math.random() * 0.4, () => {
      this.puff(to, 3, 0.35);
      if (target.down <= 0 && !target.routed && Math.random() < 0.3) target.down = 2.4 + Math.random() * 2;
    });
  }

  private workBallistae(dt: number) {
    const greeks = [...this.soldiers.values()].filter((s) => s.state !== "aboard" && this.inCity(s.entity));
    const fighting = this.runs.some((r) => r.stage === "assault" || r.stage === "ready" || r.stage === "landing");
    for (const b of this.ballistae) {
      b.wait -= dt;
      b.loosed = Math.max(0, b.loosed - dt);
      if (fighting && !this.won && b.wait <= 0) {
        b.wait = 2.6 + Math.random() * 2.4;
        const target = greeks[Math.floor(Math.random() * greeks.length)];
        if (target) {
          b.loosed = 1;
          const to = { x: target.entity.x + (Math.random() - 0.5) * 8, y: target.entity.y + (Math.random() - 0.5) * 8, z: 0 };
          this.fire("bolt", { x: b.entity.x - 3, y: b.entity.y, z: b.entity.z + 5.5 }, to, 10, 0.8, () => {
            this.puff(to, 3, 0.3);
            this.spark(to, 2);
            if (Math.hypot(target.entity.x - to.x, target.entity.y - to.y) < 3.5 && target.down <= 0 && Math.random() < 0.5) target.down = 1.4;
          });
        }
      }
      b.entity.job = { k: "prop", id: "ballista", v: b.loosed > 0 ? 1 : 0 } as Job;
    }
  }

  private inCity(e: Entity) {
    return e.x - ROME.x > ROME_LINES.quay - 4;
  }

  private clashSparks(dt: number) {
    this.sparkWait -= dt;
    if (this.sparkWait > 0) return;
    this.sparkWait = 0.1 + Math.random() * 0.16;
    const fighting = this.romans.filter((r) => r.act === "fight" && r.rank === 0 && r.down <= 0 && !r.routed && !r.gone);
    const r = fighting[Math.floor(Math.random() * fighting.length)];
    if (!r) return;
    this.spark({ x: r.entity.x - 4 - Math.random() * 2, y: r.entity.y + (Math.random() - 0.5) * 4, z: 8 + Math.random() * 5 }, 1);
  }

  private fire(kind: "arrow" | "bolt", from: Point, to: Point, peak: number, duration: number, land: () => void) {
    const missile: Missile = { from, to, peak, t: 0, duration, land, entity: null as unknown as Entity };
    const at = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t + 4 * peak * t * (1 - t) });
    missile.entity = this.stage.add({
      x: from.x,
      y: from.y,
      z: from.z,
      sort: 0.5,
      paint: (ctx, sx, sy, px) => {
        const a = at(missile.t);
        const b = at(Math.min(1, missile.t + 0.04));
        let dx = projectX(b.x, b.y) - projectX(a.x, a.y);
        let dy = projectY(b.x, b.y, b.z) - projectY(a.x, a.y, a.z);
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const dot = (i: number, color: string) => {
          ctx.fillStyle = color;
          ctx.fillRect(Math.round(sx + dx * i * px - px / 2), Math.round(sy + dy * i * px - px / 2), Math.ceil(px), Math.ceil(px));
        };
        const length = kind === "bolt" ? 7 : 5;
        for (let i = -length; i < 0; i++) dot(i, kind === "bolt" ? "#3d281c" : "#664027");
        dot(0, "#c4beb4");
        dot(-length, "#ead6ad");
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
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].at > this.time) continue;
      const [timer] = this.timers.splice(i, 1);
      timer.run();
    }
    this.waveStandards();
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
            const h = ((x * 374761393 + y * 668265263 + seed) >>> 0) % 7;
            if (h < 2 + d * 3) continue;
            ctx.fillStyle = d < 0.4 ? "#e5e1d8" : d < 0.75 ? "#cfcac0" : "#97918a";
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

  // --- The water ---------------------------------------------------------------------------------------

  /** Sunlight glinting on the swell: short bright dashes that come and go. */
  private paintGlints(ctx: CanvasRenderingContext2D, ox: number, oy: number, px: number, time: number) {
    const unit = Math.max(1, Math.round(px));
    const shown = this.glinting?.reveal ?? 1;
    if (shown <= 0) return;
    for (const g of this.glints) {
      if ((g.phase / (Math.PI * 2)) % 1 > shown) continue;
      const v = Math.sin(time * g.speed + g.phase);
      if (v < 0.55) continue;
      const x = Math.round(ox + g.sx * px);
      const y = Math.round(oy + g.sy * px);
      ctx.fillStyle = v > 0.85 ? "#f1f6f1" : "#9cc8d3";
      ctx.fillRect(x, y, unit * g.size, unit);
      if (v > 0.9 && g.size > 2) ctx.fillRect(x + unit, y - unit, unit * (g.size - 2), unit);
    }
  }

  /** A ship's wake: foam spreading behind it in a V and fading, and a bow wave. */
  private paintWake(ship: Ship, ctx: CanvasRenderingContext2D, ox: number, oy: number, px: number, time: number) {
    if (!ship.trail.length) return;
    const unit = Math.max(1, Math.round(px));
    const a = (ship.dir * Math.PI) / 4;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    for (const p of ship.trail) {
      const age = time - p.t;
      const life = 2.6;
      if (age > life) continue;
      const k = age / life;
      // Two arms spreading behind the stern.
      for (const side of [1, -1]) {
        const spread = 6 + k * 16;
        const wx = p.x - ux * (HULL.half + 2) - uy * side * spread;
        const wy = p.y - uy * (HULL.half + 2) + ux * side * spread;
        const x = Math.round(ox + projectX(wx, wy) * px);
        const y = Math.round(oy + projectY(wx, wy, 0) * px);
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.fillStyle = k < 0.3 ? "#fcfdfa" : "#cbe0e0";
        ctx.fillRect(x, y, unit * (k < 0.5 ? 3 : 2), unit);
      }
      // Churned water down the middle.
      const cx = p.x - ux * (HULL.half + 1);
      const cy = p.y - uy * (HULL.half + 1);
      ctx.globalAlpha = (1 - k) * 0.6;
      ctx.fillStyle = "#b0ced3";
      ctx.fillRect(Math.round(ox + projectX(cx, cy) * px), Math.round(oy + projectY(cx, cy, 0) * px), unit * 2, unit);
    }
    ctx.globalAlpha = 1;
    if (ship.state === "sailing" && ship.speed > 0) {
      // The bow wave.
      for (const side of [1, -1]) {
        for (let i = 0; i < 3; i++) {
          const wx = ship.x + ux * (HULL.half + 2 - i * 3) - uy * side * (2 + i * 1.6);
          const wy = ship.y + uy * (HULL.half + 2 - i * 3) + ux * side * (2 + i * 1.6);
          ctx.fillStyle = (Math.floor(time * 8) + i) % 3 ? "#fcfdfa" : "#e1ece8";
          ctx.fillRect(Math.round(ox + projectX(wx, wy) * px), Math.round(oy + projectY(wx, wy, 0) * px), unit * 2, unit);
        }
      }
    }
  }

  // --- For the camera and the HTML --------------------------------------------------------------------------

  /**
   * What the camera should watch: the harbour while the army boards, the fleet at sea (its centre,
   * world), the city once a company lands; null when nothing is under way.
   */
  focus(): { kind: "harbor" } | { kind: "fleet"; at: Point } | { kind: "rome" } | null {
    const stages = this.runs.map((r) => r.stage);
    if (stages.some((s) => s === "landing" || s === "ready" || s === "assault" || s === "done")) return { kind: "rome" };
    const sailing = this.ships.filter((s) => s.state === "sailing" || s.state === "anchored");
    if (sailing.length) {
      const at = { x: sailing.reduce((n, s) => n + s.x, 0) / sailing.length, y: sailing.reduce((n, s) => n + s.y, 0) / sailing.length, z: 0 };
      return { kind: "fleet", at };
    }
    if (stages.some((s) => s === "boarding")) return { kind: "harbor" };
    return null;
  }

  /** What a soldier of the expedition is doing, for his card; null if the camp has him. */
  doing(id: string): string | null {
    const s = this.soldiers.get(id);
    if (!s) return null;
    if (s.down > 0) return "Knocked down, getting up again";
    return s.doing;
  }

  /** Where a company is (world), for its label: its ship until it lands, then its front rank. */
  companyAt(k: number): Point | null {
    const run = this.runs[k];
    if (!run) return null;
    const soldiers = this.companySoldiers(k).filter((s) => s.state !== "aboard" && this.inCity(s.entity));
    if (soldiers.length) {
      const front = soldiers.filter((s) => s.role === "hoplite");
      const list = front.length ? front : soldiers;
      return { x: list.reduce((n, s) => n + s.entity.x, 0) / list.length, y: list.reduce((n, s) => n + s.entity.y, 0) / list.length, z: 26 };
    }
    const ship = this.ships[run.ship];
    return { x: ship.x, y: ship.y, z: 40 };
  }

  /** Where each company is in its story, in a word or two for its label. */
  stages(): string[] {
    return this.plan.companies.map((company, k) => {
      const run = this.runs[k];
      if (!run || company.state === "failed") return company.state === "failed" ? "post failed" : "mustered";
      switch (run.stage) {
        case "home":
          return company.state === "approved" ? "cleared to sail" : "mustered";
        case "boarding":
          return "boarding";
        case "voyage":
          return this.ships[run.ship].state === "sailing" ? "under sail" : "landing";
        case "offshore":
          return "off the city";
        case "landing":
          return "landing";
        case "ready":
          return "formed up";
        case "assault":
          return "fighting";
        case "done":
          return run.outcome === "won" ? "took the gate" : run.outcome === "held" ? "holding" : "thrown back";
        case "returning":
          return "sailing home";
      }
    });
  }

  /** The legion has broken and the city's gate is taken. */
  get taken() {
    return this.won;
  }
}

/** The century of the legion facing each company: the nearest one across the battle. */
function centuriesFor(count: number): number[] {
  const free = new Set(Array.from({ length: CENTURIES }, (_, i) => i));
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const b = companyB(k, count);
    let best = -1;
    for (const c of free) if (best < 0 || Math.abs(companyB(c, CENTURIES) - b) < Math.abs(companyB(best, CENTURIES) - b)) best = c;
    if (best >= 0) free.delete(best);
    out.push(best < 0 ? k % CENTURIES : best);
  }
  return out;
}

/** The screen box (art px) of a world rectangle. */
function worldBox(t: { x0: number; y0: number; x1: number; y1: number }) {
  return { x0: t.x0 - t.y1, x1: t.x1 - t.y0, y0: (t.x0 + t.y0) / 2 - 10, y1: (t.x1 + t.y1) / 2 + 10 };
}

function screenBox(b: { x0: number; y0: number; x1: number; y1: number }) {
  return b;
}

/** The screen box (art px) within `r` of an entity. */
function around(e: Entity, r: number) {
  const sx = projectX(e.x, e.y);
  const sy = projectY(e.x, e.y, e.z);
  return { x0: sx - r, x1: sx + r, y0: sy - r * 1.2, y1: sy + r * 0.6 };
}

/** Glints scattered over the open sea (screen positions, art px), clear of the shores. */
function makeGlints() {
  const glints: Array<{ sx: number; sy: number; phase: number; speed: number; size: number }> = [];
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 520; i++) {
    const sx = SEA.cx + (random() * 2 - 1) * (SEA.hw - 60);
    const sy = SEA.cy + (random() * 2 - 1) * (SEA.hh - 50);
    // Not over the home shore, the islets or the city.
    if (sy < 520) continue;
    if (ISLETS.some((islet) => Math.hypot((sx - islet.sx) / 2, sy - islet.sy) < islet.r)) continue;
    const x = sy + sx / 2 - ROME.x;
    if (x > ROME_LINES.quay - 20 && sy > 860) continue;
    glints.push({ sx, sy, phase: random() * Math.PI * 2, speed: 0.6 + random() * 1.6, size: 2 + Math.floor(random() * 3) });
  }
  return glints;
}
