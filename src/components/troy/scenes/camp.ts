import { type Act, ACT_FRAMES, ACT_RATE, dirFor, type Job, RIDER_FRAMES } from "../engine/jobs";
import { exitPath } from "../engine/models/horse";
import { SCREEN } from "../engine/models/props";
import type { CameraTarget, Entity, Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import type { Point } from "../engine/walker";
import { type AgentPlan, type CampPlan, runLabel } from "./derive";
import type { LandingScene } from "./landing";
import { CAMP_CENTER, hub, ISLAND_RADIUS, type Node, sandbars, STATION, type StationId, STATIONS, TRAIL, travel } from "./layout";
import { COURIER_STALL, DESK_SLOTS, PROPS, SPOTS, STABLE_GATE, STALLS, type Waypoint } from "./stations";

// The camp: station islands, their furniture and the agents, below the horse. This file owns the
// world; Camp.tsx owns the HTML around it and feeds it plans derived from the live campaign.
//
// Agents are people, not icons: each one comes out of the horse and walks the sandbars to its
// station, walks between its posts as the plan changes, climbs up to the tower or the podium, and
// goes back into the horse when it is no longer needed. Scouts take a horse from the stable and
// ride off the edge of the world along the trail, then ride back with a scroll case and drop it in
// the basket. A courier rides each finished piece of work to the next station. Nobody appears or
// dissolves in the open.

/**
 * World units per second. Brisk enough that the camp keeps up with the campaign: soldiers march
 * at double time on the roads and riders gallop flat out.
 */
const SPEED = { column: 46, walk: 24, home: 40, run: 54, ride: 84, courier: 92 };

/** Seconds a figure holds still for small moments: mounting, unsaddling, a handover, a drop. */
const BEAT = { mount: 0.25, dismount: 0.25, out: 0.5, drop: 0.45, pickup: 0.25, handover: 0.35 };

/** World units per full stride cycle: longer strides at speed, so a march becomes a run, not a scurry. */
function strideLength(speed: number) {
  return Math.max(14, speed * 0.42);
}

/** A point to move to, with the act and heading for the leg that ends there. */
type Step = Point & { act?: Act; dir?: number };

type Figure = Entity & { look: number; act: Act; dir: number };

type Agent = {
  plan: AgentPlan;
  entity: Figure;
  /** Where the figure is: waiting to come out of the horse, on the move, at its post, off the map, or back inside the horse. */
  where: "queued" | "moving" | "posted" | "out" | "home";
  /** A sequence (a walk, a ride) is running; `settle` decides what is next when it ends. */
  busy: boolean;
  /** The island (or the horse) the figure is on, for routing. */
  node: Node;
  /** Steps that took the figure up to its post (a ladder, a step), walked back down to leave. */
  up: Step[] | null;
  /** The plan took this agent away: it goes back into the horse. */
  dismissed: boolean;
  /** Scouts: this run is over for them (the case is in the basket, or they came back empty). */
  finished: boolean;
  /** Scouts: the scroll case is in the basket. */
  delivered: boolean;
  /** The stall whose horse this agent is riding, while mounted. */
  stall: number | null;
  /** Out on a run on foot (every horse was out). */
  onFoot: boolean;
  /** Off the map: when the rider left the visible world. */
  outSince: number;
  phase: number;
  /** For queued agents: their place in the column (sideways offset on the sandbars). */
  lane: number;
  /** What the figure is doing while on the move or busy (see AgentInfo.doing). */
  doing: string;
  /** The courier: the errand he is on, and how many he has finished. */
  errand: { from: StationId; to: StationId } | null;
  deliveries: number;
  /** A scout's trip, as the camp shows it (it can trail the data by a few seconds). */
  trip: Trip;
};

type Trip = "camp" | "out" | "back" | "done" | "empty";

type Stall = { steed: Entity; rider: Agent | null };

/** How a station is named in a sentence ("walking over to the war tent"). */
const PLACE: Record<Node, string> = { horse: "the horse", scouts: "the scouts' island", oracle: "the oracle", tent: "the war tent", workshop: "the workshop", theatre: "the theatre", agora: "the agora" };

/** What a figure standing at its post looks like it is doing, by its act. */
const ACT_WORDS: Record<Act, string> = {
  stand: "Standing by",
  march: "On the march",
  carry: "Carrying a scroll case",
  climb: "Climbing",
  type: "Typing at the desk",
  paint: "Painting at the easel",
  inspect: "Studying a shot through a lens",
  read: "Taking notes",
  lookout: "Keeping watch from the tower",
  herald: "Sounding the trumpet from the podium",
  point: "Pointing out the plan on the map",
  cheer: "Cheering",
  sit: "Sitting",
  watch: "Watching the screen",
};

/** What the camp can say about one agent, for the agent card. */
export type AgentInfo = {
  /** Where the figure is: on the map, off its edge, or back inside the horse. */
  where: "queued" | "moving" | "posted" | "out" | "home";
  /** What it is doing right now, in a short sentence. */
  doing: string;
  mounted: boolean;
  /** On the map (the camera can follow it). */
  visible: boolean;
  /** The courier's errand, if any, and how many he has run. */
  errand: { from: StationId; to: StationId } | null;
  deliveries: number;
  /** A scout's trip: still in camp, riding out (or off the map), riding back, or over. */
  trip: Trip;
};

export type CampEvents = {
  /** The courier reached a station with work for it. */
  onArrive?: (station: StationId) => void;
};

export class CampScene {
  readonly grounds: Entity[] = [];
  private readonly props: Entity[] = [];
  private readonly keyed = new Map<string, Entity>();
  private readonly desks = new Map<number, Entity & { state: number }>();
  private readonly agents = new Map<string, Agent>();
  /** Agents waiting to come out of the horse, in order. */
  private readonly column: Agent[] = [];
  private readonly stalls: Stall[] = [];
  private readonly dispatches: Array<{ from: StationId; to: StationId }> = [];
  private readonly posters = new Map<string, HTMLCanvasElement | null>();
  private posterList: CampPlan["posters"] = [];
  private showing = false;
  private revealT = 0;
  private readonly barCount = sandbars().length + 1;
  private time = 0;
  private tvOn = false;
  private planned = false;
  /** The column is marching in from the horse: the first plan queues everyone instead of placing them. */
  private entering = false;
  private brandId: string | null = null;
  private recruited = 0;
  events: CampEvents = {};
  /** The agent whose card is open, and the one under the pointer. */
  selected: string | null = null;
  hovered: string | null = null;
  /** `big`: around a rider rather than a soldier on foot. */
  private readonly ring: Entity & { big: boolean };
  private readonly hoverRing: Entity & { big: boolean };
  private readonly marker: Entity & { big: boolean };

  constructor(
    private readonly stage: Stage,
    private readonly landing: LandingScene,
  ) {
    sandbars().forEach((_, i) => this.grounds.push(stage.add({ x: 0, y: 0, z: 0, ground: true, job: { k: "bar", i }, reveal: 0, priority: 5 - i * 0.1 })));
    this.grounds.push(stage.add({ x: 0, y: 0, z: 0, ground: true, job: { k: "trail" }, reveal: 0, priority: 4.3 }));
    STATIONS.forEach((s, i) => this.grounds.push(stage.add({ x: s.x, y: s.y, z: 0, ground: true, job: { k: "island", id: s.id }, reveal: 0, priority: 5 - i * 0.1 })));
    for (const station of STATIONS) {
      for (const placement of PROPS[station.id]) {
        const entity = stage.add({
          x: station.x + placement.x,
          y: station.y + placement.y,
          z: 0,
          sort: placement.sort ?? 0,
          job: { k: "prop", id: placement.prop, v: placement.v ?? 0 },
          reveal: 0,
          priority: 4,
        });
        this.props.push(entity);
        if (placement.key) this.keyed.set(`${station.id}:${placement.key}`, entity);
      }
    }
    // Horses tied at the scouts' rail; they leave with a rider and come back with one.
    const scouts = STATION.scouts;
    for (const stall of STALLS) {
      const steed = stage.add({ x: scouts.x + stall.horse.x, y: scouts.y + stall.horse.y, z: 0, shadow: 8, job: { k: "steed", dir: stall.horse.dir }, reveal: 0, priority: 4 });
      this.props.push(steed);
      this.stalls.push({ steed, rider: null });
    }
    // The selected soldier gets a marker over its head and a ring at its feet; a hovered one a ring.
    this.ring = stage.add({ x: 0, y: 0, z: 0, hidden: true, big: false, paint: (ctx, sx, sy, px, time) => this.paintRing(ctx, sx, sy, px, time, false) });
    this.hoverRing = stage.add({ x: 0, y: 0, z: 0, hidden: true, big: false, paint: (ctx, sx, sy, px, time) => this.paintRing(ctx, sx, sy, px, time, true) });
    this.marker = stage.add({ x: 0, y: 0, z: 0, sort: 1e6, hidden: true, big: false, paint: (ctx, sx, sy, px, time) => this.paintMarker(ctx, sx, sy, px, time) });
    // The theatre screen shows finished videos, drawn over the screen prop.
    const screen = this.keyed.get("theatre:screen")!;
    stage.add({ x: screen.x, y: screen.y, z: 0, sort: 0.5, paint: (ctx, sx, sy, px) => this.paintScreen(ctx, sx, sy, px) });
    stage.add({ x: 0, y: 0, z: 0, tick: (dt) => this.tick(dt) });
  }

  /** Starts baking the camp so it is ready when the column arrives, and forgets another brand's camp. */
  prepare(brandId: string) {
    if (this.brandId !== null && this.brandId !== brandId) this.reset();
    this.brandId = brandId;
    for (const entity of [...this.grounds, ...this.props]) if (entity.job) void this.stage.baker.request(entity.job, 5);
  }

  /** The column is about to march out of the horse: everyone in the first plan walks in. */
  beginEntrance() {
    if (!this.planned) this.entering = true;
  }

  /** Clears every agent, desk and errand (a different camp, or back to the landing). */
  reset() {
    for (const agent of this.agents.values()) this.stage.remove(agent.entity);
    this.agents.clear();
    this.column.length = 0;
    this.dispatches.length = 0;
    for (const desk of this.desks.values()) this.stage.remove(desk);
    this.desks.clear();
    for (const stall of this.stalls) {
      stall.rider = null;
      this.stage.add(stall.steed);
    }
    this.timers.length = 0;
    this.planned = false;
    this.entering = false;
    this.recruited = 0;
    this.brandId = null;
  }

  show(visible: boolean) {
    this.showing = visible;
    if (visible && this.revealT === 0 && this.landing.isOpen) this.revealT = 0.0001;
  }

  /** The camera that frames the whole camp, leaving room for the panels around it. */
  camera(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    const { width, height } = this.stage.size;
    const spanX = 2 * (196 + ISLAND_RADIUS + 34);
    const spanY = 76 + 80 + 140 + 46;
    const usableW = width - insets.right - 24;
    const usableH = height - insets.top - insets.bottom;
    const fit = Math.min(usableW / spanX, usableH / spanY, 3.5);
    const zoom = this.stage.fitZoom(fit);
    const midY = CAMP_CENTER.sy - 4;
    return { x: CAMP_CENTER.sx + insets.right / 2 / zoom, y: midY + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  insets = { top: 84, bottom: 72, right: 0 };

  /** A camera centred on one station (for the station panel). */
  focus(id: StationId, insets = this.insets): CameraTarget {
    const base = this.camera(insets);
    const station = STATION[id];
    // Close enough to see who is doing what, in whole device pixels.
    const zoom = Math.min(this.stage.fitZoom(Math.max(2, base.zoom * 1.6)), 4);
    const sx = projectX(station.x, station.y);
    const sy = projectY(station.x, station.y, 4);
    return { x: sx + insets.right / 2 / zoom, y: sy + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  /** Where a station sits on screen (CSS px), for labels. */
  stationPoint(id: StationId) {
    const s = STATION[id];
    return { x: s.x, y: s.y, z: 0 };
  }

  /** How many agents are still waiting to come out of the horse. */
  get waiting() {
    return this.column.length;
  }

  /**
   * Sends the next agent in the column out of the horse (the landing calls this while the doors
   * are open). Returns false when nobody is waiting.
   */
  nextRecruit(): boolean {
    const agent = this.column.shift();
    if (!agent) return false;
    this.arrive(agent);
    return true;
  }

  /** Applies a plan: posts every agent, sets screens, baskets and reels. */
  apply(plan: CampPlan) {
    const instantly = !this.planned && !this.entering;
    this.planned = true;
    for (const [key, value] of Object.entries(plan.props)) {
      // The basket fills as scouts actually drop their scroll cases in it (see updateBasket).
      if (key === "basket") continue;
      for (const station of STATIONS) {
        const entity = this.keyed.get(`${station.id}:${key}`);
        if (entity?.job?.k === "prop") entity.job = { ...entity.job, v: value };
      }
    }
    this.tvOn = plan.tvOn;
    this.posterList = plan.posters;
    for (const poster of plan.posters) this.loadPoster(poster.creativeId, poster.url, poster.video);

    // Desks: one per planned video, set up with the camp.
    const workshop = STATION.workshop;
    const live = new Set<number>();
    for (const desk of plan.desks) {
      live.add(desk.slot);
      let entity = this.desks.get(desk.slot);
      if (!entity) {
        const slot = DESK_SLOTS[desk.slot];
        // Set up with the workshop's island, grain by grain (see tick).
        entity = Object.assign(this.stage.add({ x: workshop.x + slot.x, y: workshop.y + slot.y, z: 0, job: null as Job | null, reveal: 0, priority: 4 }), { state: desk.state });
        this.desks.set(desk.slot, entity);
      }
      entity.state = desk.state;
    }
    for (const [slot, entity] of this.desks) {
      if (!live.has(slot)) {
        this.stage.remove(entity);
        this.desks.delete(slot);
      }
    }

    // Agents.
    const seen = new Set<string>();
    for (const agentPlan of plan.agents) {
      seen.add(agentPlan.id);
      this.post(agentPlan, instantly);
    }
    for (const [id, agent] of this.agents) {
      if (seen.has(id) || agent.dismissed) continue;
      agent.dismissed = true;
      const queued = this.column.indexOf(agent);
      if (queued >= 0) {
        // Still inside the horse: it simply stays there.
        this.column.splice(queued, 1);
        this.agents.delete(id);
      } else this.settle(agent);
    }
    this.updateBasket();
  }

  /** The courier carries work from one station to the next (each stage change, each finished video). */
  dispatch(from: StationId, to: StationId) {
    if (from === to) return;
    const last = this.dispatches[this.dispatches.length - 1];
    if (last && last.from === from && last.to === to) return;
    // A long backlog only delays the picture: keep the latest few.
    if (this.dispatches.length >= 3) this.dispatches.shift();
    this.dispatches.push({ from, to });
    const courier = this.agents.get("courier");
    if (courier) this.settle(courier);
  }

  // --- Agents: what each one does next ----------------------------------------------------------

  private post(plan: AgentPlan, instantly: boolean) {
    let agent = this.agents.get(plan.id);
    if (!agent) {
      agent = this.create(plan);
      this.agents.set(plan.id, agent);
      if (instantly) this.place(agent);
      else {
        agent.lane = (((this.recruited++ * 7) % 5) - 2) * 1.7;
        this.column.push(agent);
      }
      return;
    }
    const previous = agent.plan;
    agent.plan = plan;
    if (agent.dismissed) agent.dismissed = false;
    // A scout whose run starts over (the demo stepping back) is a scout again.
    if (previous.returning && !plan.returning) {
      agent.finished = false;
      agent.delivered = false;
      agent.trip = "camp";
    }
    if (agent.where !== "queued") this.settle(agent);
  }

  private create(plan: AgentPlan): Agent {
    const entity: Figure = { x: 0, y: 0, z: 0, look: plan.look, act: plan.act, dir: plan.dir, sort: plan.sort ?? 0, shadow: 5, priority: 3, job: null };
    return { plan, entity, where: "queued", busy: false, node: "horse", up: null, dismissed: false, finished: false, delivered: false, stall: null, onFoot: false, outSince: 0, phase: Math.random() * 10, lane: 0, doing: "Waiting inside the horse", errand: null, deliveries: 0, trip: "camp" };
  }

  /** Puts an agent straight at its post (opening a camp directly, not through the march). */
  private place(agent: Agent) {
    const plan = agent.plan;
    if (plan.returning) {
      // Came back before we were watching: already home.
      agent.finished = true;
      agent.delivered = plan.returning === "scroll";
      agent.trip = agent.delivered ? "done" : "empty";
      agent.where = "home";
      return;
    }
    if (plan.away) {
      const stall = this.freeStall(agent);
      if (stall >= 0) {
        this.stalls[stall].rider = agent;
        this.stage.remove(this.stalls[stall].steed);
        agent.stall = stall;
      }
      agent.where = "out";
      agent.node = "scouts";
      agent.trip = "out";
      agent.outSince = this.time - 10;
      return;
    }
    const post = this.postPoint(plan);
    // Appears with its island, grain by grain (see tick).
    Object.assign(agent.entity, { x: post.x, y: post.y, z: post.z, dir: plan.dir, act: plan.act, reveal: 0, alpha: 1 });
    agent.entity.shadow = post.z < 1 ? 5 : 0;
    agent.up = plan.via ? this.viaSteps(plan) : null;
    agent.node = plan.station;
    agent.where = "posted";
    this.stage.add(agent.entity);
  }

  /** Decides what an agent does next, once it is free. */
  private settle(agent: Agent) {
    if (agent.busy) return;
    const plan = agent.plan;
    if (agent.where === "queued") return;

    if (agent.dismissed) {
      if (agent.where === "home") this.agents.delete(plan.id);
      else if (agent.where === "out") this.rideBack(agent);
      else this.goHome(agent);
      return;
    }
    // Back inside the horse but needed again: out it comes.
    if (agent.where === "home") {
      if (plan.returning && agent.finished) return;
      agent.where = "queued";
      this.column.push(agent);
      return;
    }

    if (plan.id === "courier" && this.dispatches.length) {
      this.courierRun(agent);
      return;
    }

    if (plan.id.startsWith("scout:")) {
      if (plan.away) {
        if (agent.where !== "out") this.rideOut(agent);
        return;
      }
      if (plan.returning) {
        if (agent.finished) return this.goHome(agent);
        if (agent.where === "out") return this.rideBack(agent);
        // The run ended before this scout even left: out and straight back.
        return this.rideOut(agent);
      }
      if (agent.where === "out") return this.rideBack(agent);
    }

    if (agent.where === "out") return this.rideBack(agent);
    if (this.atPost(agent)) {
      agent.where = "posted";
      agent.entity.dir = plan.dir;
      agent.entity.act = plan.act;
      return;
    }
    this.toPost(agent);
  }

  /** Out of the horse, down the plank and along the sandbars to the post. */
  private arrive(agent: Agent) {
    const e = agent.entity;
    const out = exitPath();
    Object.assign(e, { x: out[0].x, y: out[0].y, z: out[0].z, alpha: 0, reveal: 1, act: "march" as Act });
    this.stage.add(e);
    const route = travel("horse", agent.plan.station, agent.lane);
    const steps: Step[] = [...out.slice(1), ...route, ...this.approach(agent.plan)];
    agent.node = agent.plan.station;
    agent.doing = `Marching out of the horse to ${PLACE[agent.plan.station]}`;
    this.run(
      agent,
      steps,
      SPEED.column,
      () => {
        agent.up = agent.plan.via ? this.viaSteps(agent.plan) : null;
      },
      "march",
      "in",
    );
  }

  /** Walks to the post: down from where it was, along the roads if it is on another island, up to it. */
  private toPost(agent: Agent) {
    const plan = agent.plan;
    const far = agent.node !== plan.station;
    const steps: Step[] = [...this.descend(agent)];
    if (far) steps.push(...travel(agent.node, plan.station));
    steps.push(...this.approach(plan));
    agent.node = plan.station;
    agent.doing = far ? `Walking over to ${PLACE[plan.station]}` : plan.via ? "Climbing up to the post" : "Taking up the post";
    this.run(agent, steps, far ? SPEED.home : SPEED.walk, () => {
      agent.up = plan.via ? this.viaSteps(plan) : null;
    });
  }

  /** Back along the sandbars, up the plank and into the horse. */
  private goHome(agent: Agent) {
    const steps: Step[] = [...this.descend(agent), ...travel(agent.node, "horse"), ...exitPath().reverse()];
    agent.node = "horse";
    agent.doing = agent.finished ? "Job done: marching back into the horse" : "Marching back into the horse";
    this.run(
      agent,
      steps,
      SPEED.home,
      () => {
        this.stage.remove(agent.entity);
        agent.where = "home";
      },
      "march",
      "home",
    );
  }

  /** A scout takes a horse from the stable and gallops off along the trail. */
  private rideOut(agent: Agent) {
    const stall = agent.stall ?? this.freeStall(agent);
    if (stall < 0) {
      // Every horse is out: run for it, along the trail on foot.
      agent.onFoot = true;
      agent.node = "scouts";
      agent.trip = "out";
      agent.doing = `Every horse is out: running off along the trail for ${this.source(agent)}`;
      this.run(agent, [...this.descend(agent), this.gate(), TRAIL.b], SPEED.run, () => this.offTheMap(agent), "march", undefined, true);
      return;
    }
    agent.onFoot = false;
    this.stalls[stall].rider = agent;
    agent.stall = stall;
    agent.node = "scouts";
    agent.trip = "out";
    agent.doing = "Going to the stable for a horse";
    this.run(agent, this.toStall(agent, stall), SPEED.walk, () => {
      agent.doing = "Saddling up";
      this.mount(agent, stall, () => {
        agent.doing = `Galloping off along the trail for ${this.source(agent)}`;
        this.ride(agent, [this.gate(), TRAIL.b], SPEED.ride, 0, () => this.offTheMap(agent));
      });
    });
  }

  /** Off the edge of the world: hidden until the plan brings it back. */
  private offTheMap(agent: Agent) {
    agent.outSince = this.time;
    agent.doing = `Out past the edge of the map, fetching ${this.source(agent)}`;
    agent.where = "out";
    this.stage.remove(agent.entity);
    // The run may already be over: look again once the rider has been gone a moment.
    this.later(0.85, () => this.settle(agent));
  }

  /** A scout gallops back in along the trail, unsaddles at the stable and takes the case to the basket. */
  private rideBack(agent: Agent) {
    const plan = agent.plan;
    // Stay out a moment at least, so a quick run still reads as a trip.
    const wait = BEAT.out - (this.time - agent.outSince);
    if (wait > 0) {
      agent.busy = true;
      this.later(wait, () => {
        agent.busy = false;
        this.settle(agent);
      });
      return;
    }
    // Always from beyond the edge of the screen as it is now (the camera may have moved).
    const from = this.offscreenOnTrail();
    const carrying = !agent.dismissed && plan.returning === "scroll";
    Object.assign(agent.entity, { x: from.x, y: from.y, z: 0, alpha: 1, reveal: 1 });
    this.stage.add(agent.entity);
    agent.where = "moving";
    agent.node = "scouts";
    agent.trip = "back";
    const basket = { ...this.rel("scouts", SPOTS.basket.x, SPOTS.basket.y, 0), dir: SPOTS.basket.dir };
    agent.doing = carrying ? "Riding back with a scroll case" : agent.dismissed ? "Called back to camp" : "Riding back empty-handed";
    const deliver = () => {
      agent.busy = true;
      agent.doing = "Dropping the scroll case in the basket";
      agent.entity.act = "stand";
      this.later(BEAT.drop, () => {
        agent.delivered = true;
        agent.finished = true;
        agent.trip = "done";
        this.updateBasket();
        agent.busy = false;
        this.settle(agent);
      });
    };
    if (agent.onFoot || agent.stall === null) {
      // Back on foot: straight to the basket (or home, empty-handed).
      agent.onFoot = false;
      if (carrying) {
        agent.doing = "Running the scroll case to the basket";
        return this.run(agent, [this.gate(), basket], SPEED.run, deliver, "carry");
      }
      if (plan.returning && !agent.dismissed) {
        agent.finished = true;
        agent.trip = "empty";
      }
      return this.run(agent, [this.gate()], SPEED.run, () => undefined);
    }
    const stall = agent.stall;
    const at = STALLS[stall];
    const horse = { ...this.rel("scouts", at.horse.x, at.horse.y, 0), dir: at.horse.dir };
    this.ride(agent, [this.gate(), horse], SPEED.ride, carrying ? 1 : 0, () => {
      agent.doing = "Tying up the horse";
      this.dismount(agent, carrying, () => {
        if (agent.dismissed) return this.settle(agent);
        if (!carrying) {
          if (agent.plan.returning) {
            agent.finished = true;
            agent.trip = "empty";
          }
          return this.settle(agent);
        }
        // Into the basket with it.
        agent.entity.act = "carry";
        agent.doing = "Carrying the scroll case to the basket";
        this.run(agent, [this.gate(), basket], SPEED.walk, deliver, "carry");
      });
    });
  }

  /** The courier saddles up, rides to where the work is, then on to the station that needs it. */
  private courierRun(agent: Agent) {
    const stall = agent.stall ?? this.freeStall(agent);
    // The courier's horse is his alone, so it is always in when he is.
    if (stall < 0) return;
    this.stalls[stall].rider = agent;
    agent.stall = stall;
    agent.node = "scouts";
    agent.doing = "Going to the stable for his horse";
    this.run(agent, this.toStall(agent, stall), SPEED.walk, () => {
      agent.doing = "Saddling up";
      this.mount(agent, stall, () => this.courierLeg(agent));
    });
  }

  private courierLeg(agent: Agent) {
    const job = this.dispatches.shift();
    const stall = agent.stall!;
    // Leave the stable through its gate, or cross the island the last job ended on.
    const lead: Step[] = this.atStable(agent) ? [this.gate(), hub("scouts")] : [hub(agent.node)];
    if (!job) {
      // Nothing more to carry: back to the stable, unsaddle, back to the post.
      const at = STALLS[stall];
      const home: Step[] = agent.node === "scouts" ? [] : [...travel(agent.node, "scouts"), hub("scouts")];
      const steps: Step[] = [...lead, ...home, this.gate(), { ...this.rel("scouts", at.horse.x, at.horse.y, 0), dir: at.horse.dir }];
      agent.node = "scouts";
      agent.errand = null;
      agent.doing = "Riding back to the stable";
      this.ride(agent, steps, SPEED.courier, 1, () => this.dismount(agent, false, () => this.settle(agent)));
      return;
    }
    const pickup: Step[] = [...lead, ...travel(agent.node, job.from)];
    agent.node = job.from;
    agent.errand = job;
    agent.doing = `Riding to ${PLACE[job.from]} to collect the finished work`;
    this.ride(agent, pickup, SPEED.courier, 1, () => {
      agent.doing = `Collecting the work at ${PLACE[job.from]}`;
      this.pause(agent, BEAT.pickup, () => {
        agent.node = job.to;
        agent.doing = `Carrying the work to ${PLACE[job.to]}`;
        this.ride(agent, [hub(job.from), ...travel(job.from, job.to)], SPEED.courier, 1, () => {
          this.events.onArrive?.(job.to);
          agent.deliveries++;
          agent.doing = `Handing the work over at ${PLACE[job.to]}`;
          this.pause(agent, BEAT.handover, () => this.courierLeg(agent));
        });
      });
    });
  }

  /** Swaps the walker for a rider on the stall's horse, standing a moment before moving off. */
  private mount(agent: Agent, stall: number, then: () => void) {
    const at = STALLS[stall];
    const steed = this.stalls[stall].steed;
    this.stage.remove(steed);
    const e = agent.entity;
    Object.assign(e, { x: steed.x, y: steed.y, z: 0, dir: at.horse.dir, shadow: 9 });
    e.job = { k: "rider", look: e.look, dir: e.dir, f: -1, c: agent.plan.id === "courier" ? 1 : 0 };
    agent.busy = true;
    this.later(BEAT.mount, () => {
      agent.busy = false;
      then();
    });
  }

  /** Ties the horse back at its stall and steps down beside it. */
  private dismount(agent: Agent, carrying: boolean, then: () => void) {
    const stall = agent.stall!;
    const at = STALLS[stall];
    const e = agent.entity;
    agent.busy = true;
    e.job = { k: "rider", look: e.look, dir: at.horse.dir, f: -1, c: carrying ? 1 : agent.plan.id === "courier" ? 1 : 0 };
    this.later(BEAT.dismount, () => {
      const steed = this.stalls[stall].steed;
      this.stalls[stall].rider = null;
      agent.stall = null;
      this.stage.add(steed);
      const spot = this.rel("scouts", at.mount.x, at.mount.y, 0);
      Object.assign(e, { x: spot.x, y: spot.y, z: 0, dir: at.mount.dir, shadow: 5, act: carrying ? "carry" : "stand" });
      e.job = { k: "soldier", look: e.look, act: e.act, dir: e.dir, f: 0 };
      agent.busy = false;
      then();
    });
  }

  private pause(agent: Agent, seconds: number, then: () => void) {
    agent.busy = true;
    this.later(seconds, () => {
      agent.busy = false;
      then();
    });
  }

  // --- Moving -------------------------------------------------------------------------------------

  /** Walks a figure through steps; when it gets there, `done` runs and the agent settles. */
  private run(agent: Agent, steps: Step[], speed: number, done: () => void, act: Act = "march", door?: "in" | "home", leaving = false) {
    agent.busy = true;
    agent.where = "moving";
    const e = agent.entity;
    this.stage.add(e);
    let leg = 0;
    let travelled = 0;
    const stride = strideLength(speed);
    e.tick = (dt) => {
      // Stepping out of the dark doorway.
      if (door !== "home" && (e.alpha ?? 1) < 1) e.alpha = Math.min(1, (e.alpha ?? 0) + dt * 4);
      let remaining = speed * dt;
      let legAct: Act = act;
      while (remaining > 0 && leg < steps.length) {
        const b = steps[leg];
        legAct = b.act ?? act;
        const dx = b.x - e.x;
        const dy = b.y - e.y;
        const dz = b.z - e.z;
        // Walk facing the way you go; on a ladder, face the ladder.
        if (b.act === "climb" && b.dir !== undefined) e.dir = b.dir;
        else if (Math.hypot(dx, dy) > 0.05) e.dir = dirFor(dx, dy);
        const left = Math.hypot(dx, dy, dz);
        if (left <= remaining) {
          e.x = b.x;
          e.y = b.y;
          e.z = b.z;
          remaining -= left;
          travelled += left;
          leg++;
        } else {
          const k = remaining / left;
          e.x += dx * k;
          e.y += dy * k;
          e.z += dz * k;
          travelled += remaining;
          remaining = 0;
        }
      }
      // Back up the plank: fade into the dark of the doorway.
      if (door === "home" && e.z > 40 && leg >= steps.length - 1) e.alpha = Math.max(0, (e.alpha ?? 1) - dt * 5);
      e.shadow = e.z < 1 ? 5 : 0;
      e.act = legAct;
      const frames = ACT_FRAMES[legAct];
      e.job = { k: "soldier", look: e.look, act: legAct, dir: e.dir, f: frames > 1 ? Math.floor((travelled / stride) * frames) % frames : 0 };
      const gone = leaving && leg >= steps.length - 1 && this.offscreen(e);
      if (leg >= steps.length || gone) {
        const last = steps[steps.length - 1];
        if (last?.dir !== undefined && !gone) e.dir = last.dir;
        e.tick = undefined;
        agent.busy = false;
        agent.where = "posted";
        done();
        // `done` may have sent the agent off the map, or started its next errand.
        if (!agent.busy && (agent.where as Agent["where"]) !== "out") this.settle(agent);
      }
    };
  }

  /** Gallops a rider through steps. `carry` 1 holds the scroll case. Stops early once it leaves the screen on the trail. */
  private ride(agent: Agent, steps: Step[], speed: number, carry: number, done: () => void) {
    agent.busy = true;
    agent.where = "moving";
    const e = agent.entity;
    const leaving = steps[steps.length - 1] === TRAIL.b;
    this.stage.add(e);
    let leg = 0;
    let travelled = 0;
    e.shadow = 9;
    e.tick = (dt) => {
      let remaining = speed * dt;
      while (remaining > 0 && leg < steps.length) {
        const b = steps[leg];
        const dx = b.x - e.x;
        const dy = b.y - e.y;
        const left = Math.hypot(dx, dy);
        if (left > 0.05) e.dir = dirFor(dx, dy);
        if (left <= remaining) {
          e.x = b.x;
          e.y = b.y;
          remaining -= left;
          travelled += left;
          leg++;
          if (leg === steps.length && b.dir !== undefined) e.dir = b.dir;
        } else {
          e.x += (dx / left) * remaining;
          e.y += (dy / left) * remaining;
          travelled += remaining;
          remaining = 0;
        }
      }
      e.job = { k: "rider", look: e.look, dir: e.dir, f: Math.floor((travelled / 7) % RIDER_FRAMES), c: carry };
      const gone = leaving && leg >= 1 && this.offscreen(e);
      if (leg >= steps.length || gone) {
        e.tick = undefined;
        if (!gone) e.job = { k: "rider", look: e.look, dir: e.dir, f: -1, c: carry };
        agent.busy = false;
        done();
        // `done` may have sent the agent off the map, or started its next errand.
        if (!agent.busy && (agent.where as Agent["where"]) !== "out") this.settle(agent);
      }
    };
  }

  // --- Looking at agents ---------------------------------------------------------------------------

  /** The agent under a point on the canvas (CSS pixels): the one drawn in front if several overlap. */
  pick(cssX: number, cssY: number): string | null {
    const zoom = this.stage.camera.zoom;
    let best: { id: string; depth: number } | null = null;
    for (const agent of this.agents.values()) {
      const e = agent.entity;
      if (!this.stage.has(e) || (e.alpha ?? 1) < 0.5 || (e.reveal ?? 1) < 0.5) continue;
      const s = this.stage.toScreen(e.x, e.y, e.z);
      const mounted = e.job?.k === "rider";
      // At least 24 CSS pixels wide, so a small figure is still easy to hit (on a phone too).
      const half = Math.max((mounted ? 13 : 7) * zoom, 12);
      const top = (mounted ? 36 : 28) * zoom;
      if (cssX < s.x - half || cssX > s.x + half || cssY < s.y - top || cssY > s.y + 4 * zoom) continue;
      const depth = e.x + e.y + (e.sort ?? 0);
      if (!best || depth > best.depth) best = { id: agent.plan.id, depth };
    }
    return best?.id ?? null;
  }

  /** Where an agent is on the map, or null while it is off the map or inside the horse. */
  position(id: string): Point | null {
    const agent = this.agents.get(id);
    if (!agent || !this.stage.has(agent.entity)) return null;
    return { x: agent.entity.x, y: agent.entity.y, z: agent.entity.z };
  }

  /** What an agent is up to, for its card. */
  info(id: string): AgentInfo | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    const e = agent.entity;
    const posted = agent.where === "posted" && !agent.busy;
    const doing = agent.where === "home" ? (agent.finished ? "Back inside the horse, the job done" : "Inside the horse, about to march out") : agent.where === "queued" ? "Waiting inside the horse for a place in the column" : posted ? ACT_WORDS[e.act] : agent.doing;
    return { where: agent.where, doing, mounted: e.job?.k === "rider", visible: this.stage.has(e), errand: agent.errand, deliveries: agent.deliveries, trip: agent.trip };
  }

  /** "the brand profile", for a scout's errand. */
  private source(agent: Agent) {
    const key = agent.plan.id.startsWith("scout:") ? agent.plan.id.slice(6) : "";
    return key ? `“${runLabel(key)}”` : "the research";
  }

  /** Keeps the marker and rings on the selected and hovered soldiers. */
  private placeMarkers() {
    const put = (marker: Entity & { big: boolean }, id: string | null, below: boolean) => {
      const agent = id ? this.agents.get(id) : undefined;
      const e = agent?.entity;
      if (!e || !this.stage.has(e)) {
        marker.hidden = true;
        return;
      }
      marker.hidden = false;
      marker.x = e.x;
      marker.y = e.y;
      marker.z = e.z;
      // Rings sit just under the figure in the depth order; the marker is drawn over everything.
      if (below) marker.sort = (e.sort ?? 0) - 0.05;
      marker.big = e.job?.k === "rider";
    };
    put(this.ring, this.selected, true);
    put(this.hoverRing, this.hovered && this.hovered !== this.selected ? this.hovered : null, true);
    put(this.marker, this.selected, false);
  }

  /** An elliptical ring of dashes at a soldier's feet; the selected one's dashes march round. */
  private paintRing(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, time: number, hover: boolean) {
    const entity = hover ? this.hoverRing : this.ring;
    const r = entity.big ? 11 : 7;
    const dots = entity.big ? 26 : 18;
    const unit = Math.max(1, Math.round(px));
    const spin = hover ? 0 : time * 0.6;
    ctx.fillStyle = hover ? "rgba(43, 29, 20, 0.45)" : "#b73a31";
    for (let i = 0; i < dots; i++) {
      if (i % 3 === 2) continue;
      const a = (i / dots + spin) * Math.PI * 2;
      ctx.fillRect(Math.round(sx + Math.cos(a) * r * px), Math.round(sy + Math.sin(a) * r * 0.5 * px), unit, unit);
    }
  }

  /** A bobbing pixel arrow over the selected soldier's head. */
  private paintMarker(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, time: number) {
    const head = this.marker.big ? 44 : 34;
    const bob = Math.round(Math.sin(time * 5) * 1.5);
    const rows = ["0111110", "0111110", "1111111", "0111110", "0011100", "0001000"];
    const unit = Math.max(1, Math.round(px));
    const x0 = Math.round(sx - 3.5 * unit);
    const y0 = Math.round(sy - (head - bob) * px);
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== "1") continue;
        // Ink outline around a crimson arrow.
        ctx.fillStyle = "#2b1d14";
        ctx.fillRect(x0 + (x - 1) * unit, y0 + y * unit, unit * 3, unit * 2);
      }
    });
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== "1") continue;
        ctx.fillStyle = y < 2 ? "#d65a45" : "#b73a31";
        ctx.fillRect(x0 + x * unit, y0 + y * unit, unit, unit);
      }
    });
  }

  // --- Places ----------------------------------------------------------------------------------

  /** On foot to the stall's mounting spot, around the end of the rail. */
  private toStall(agent: Agent, stall: number): Step[] {
    const steps: Step[] = [...this.descend(agent)];
    if (agent.node !== "scouts") steps.push(...travel(agent.node, "scouts"), hub("scouts"));
    const at = STALLS[stall];
    steps.push(this.gate(), this.rel("scouts", at.mount.x, at.mount.y, 0));
    return steps;
  }

  private gate(): Point {
    return this.rel("scouts", STABLE_GATE.x, STABLE_GATE.y, 0);
  }

  private atStable(agent: Agent) {
    const s = STATION.scouts;
    return agent.node === "scouts" && agent.entity.x - s.x < STABLE_GATE.x + 2;
  }

  private rel(station: StationId, x: number, y: number, z: number): Point {
    const s = STATION[station];
    return { x: s.x + x, y: s.y + y, z };
  }

  private postPoint(plan: AgentPlan): Point {
    return this.rel(plan.station, plan.x, plan.y, plan.z);
  }

  private viaSteps(plan: AgentPlan): Step[] {
    return (plan.via ?? []).map((w: Waypoint) => ({ ...this.rel(plan.station, w.x, w.y, w.z), act: w.act, dir: w.dir }));
  }

  /** From the island's hub up to the post: any waypoints (ladder, step), then the post itself. */
  private approach(plan: AgentPlan): Step[] {
    return [...this.viaSteps(plan), { ...this.postPoint(plan), dir: plan.dir }];
  }

  /** Back down the way the figure came up (down the ladder, off the podium), or out of the stable. */
  private descend(agent: Agent): Step[] {
    const up = agent.up;
    agent.up = null;
    if (!up?.length) return this.atStable(agent) ? [this.gate()] : [];
    const steps: Step[] = [];
    for (let i = up.length - 1; i >= 0; i--) {
      const leg = up[i + 1];
      steps.push({ x: up[i].x, y: up[i].y, z: up[i].z, act: leg?.act, dir: leg?.act ? leg.dir : undefined });
    }
    return steps;
  }

  private atPost(agent: Agent) {
    const p = this.postPoint(agent.plan);
    const e = agent.entity;
    return agent.node === agent.plan.station && this.stage.has(e) && Math.hypot(e.x - p.x, e.y - p.y) < 0.6 && Math.abs(e.z - p.z) < 0.4;
  }

  /** A stall with its horse in, for this rider (the courier has his own). */
  private freeStall(agent: Agent) {
    if (agent.plan.id === "courier") return this.stalls[COURIER_STALL].rider ? -1 : COURIER_STALL;
    return this.stalls.findIndex((s, i) => i !== COURIER_STALL && !s.rider);
  }

  private offscreen(e: Entity) {
    const { width, height } = this.stage.size;
    const s = this.stage.toScreen(e.x, e.y, e.z);
    const margin = 48;
    return s.x < -margin || s.x > width + margin || s.y < -margin || s.y > height + margin;
  }

  /** The first point along the trail that is off the screen (where a rider coming back appears). */
  private offscreenOnTrail(): Point {
    for (let t = 0.1; t <= 1; t += 0.05) {
      const p = { x: TRAIL.a.x + (TRAIL.b.x - TRAIL.a.x) * t, y: TRAIL.a.y + (TRAIL.b.y - TRAIL.a.y) * t, z: 0 };
      if (this.offscreen(p)) return p;
    }
    return TRAIL.b;
  }

  private updateBasket() {
    const scouts = [...this.agents.values()].filter((a) => a.plan.id.startsWith("scout:"));
    const delivered = scouts.filter((a) => a.delivered).length;
    const basket = this.keyed.get("scouts:basket");
    if (basket?.job?.k === "prop") basket.job = { ...basket.job, v: scouts.length ? Math.round((delivered / scouts.length) * 7) : 0 };
  }

  private readonly timers: Array<{ at: number; run: () => void }> = [];

  /** Runs `run` after `seconds` of scene time (paused with the scene, unlike setTimeout). */
  private later(seconds: number, run: () => void) {
    this.timers.push({ at: this.time + seconds, run });
  }

  private tick(dt: number) {
    this.time += dt;
    this.revealTick(dt);
    this.placeMarkers();
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].at > this.time) continue;
      const [timer] = this.timers.splice(i, 1);
      timer.run();
    }
    // Animate agents that are at their posts.
    for (const agent of this.agents.values()) {
      if (agent.where !== "posted" || agent.busy) continue;
      const e = agent.entity;
      const act = e.act;
      const frames = ACT_FRAMES[act];
      const f = frames > 1 ? Math.floor((this.time + agent.phase) / ACT_RATE[act]) % frames : 0;
      e.job = { k: "soldier", look: e.look, act, dir: e.dir, f };
      if ((e.reveal ?? 1) < 1 && this.revealT > 0.6) e.reveal = Math.min(1, (e.reveal ?? 0) + dt * 1.6);
    }
    // Desk screens: a working screen scrolls through four frames.
    const phase = Math.floor(this.time / 0.22) % 4;
    for (const desk of this.desks.values()) {
      desk.job = { k: "prop", id: "desk", v: desk.state * 4 + (desk.state === 1 ? phase : 0) };
      if (desk.reveal !== undefined && desk.reveal < 1 && this.revealT > 0.5) desk.reveal = Math.min(1, desk.reveal + dt * 1.5);
    }
    // Banners wave; the oracle's television flickers while it studies.
    const wave = Math.floor(this.time / 0.18) % 4;
    for (let i = 0; i < 3; i++) {
      const banner = this.keyed.get(`agora:banner${i}`);
      if (banner?.job?.k === "prop") banner.job = { k: "prop", id: "banner", v: i * 4 + ((wave + i) % 4) };
    }
    const shrine = this.keyed.get("oracle:shrine");
    if (shrine?.job?.k === "prop") shrine.job = { k: "prop", id: "shrine", v: this.tvOn ? 1 + (Math.floor(this.time / 0.3) % 4) : 0 };
  }

  private revealTick(dt: number) {
    const targets = [...this.grounds, ...this.props];
    if (!this.showing) {
      for (const entity of targets) entity.reveal = Math.max(0, (entity.reveal ?? 0) - dt * 2);
      this.revealT = 0;
      return;
    }
    if (this.revealT <= 0 && this.landing.isOpen) this.revealT = 0.0001;
    if (this.revealT <= 0) return;
    this.revealT += dt;
    // Grounds appear one after another along the road, grain by grain; furniture follows.
    this.grounds.forEach((ground, i) => {
      const order = i < this.barCount ? i * 2 : (i - this.barCount) * 2 + 1;
      ground.reveal = Math.max(ground.reveal ?? 0, Math.min(1, (this.revealT - order * 0.14) / 0.6));
    });
    this.props.forEach((prop, i) => {
      prop.reveal = Math.max(prop.reveal ?? 0, Math.min(1, (this.revealT - 0.5 - i * 0.05) / 0.5));
    });
  }

  private loadPoster(id: string, url: string | null, videoUrl: string | null) {
    if (this.posters.has(id) || typeof document === "undefined") return;
    this.posters.set(id, null);
    const toPixels = (source: CanvasImageSource, w: number, h: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = 9;
      canvas.height = 16;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // Cover-crop to 9:16.
      const scale = Math.max(9 / w, 16 / h);
      ctx.drawImage(source, (9 - w * scale) / 2, (16 - h * scale) / 2, w * scale, h * scale);
      this.posters.set(id, canvas);
    };
    const fromVideo = () => {
      if (!videoUrl) return;
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = `${videoUrl}#t=1`;
      video.addEventListener("loadeddata", () => toPixels(video, video.videoWidth || 9, video.videoHeight || 16), { once: true });
    };
    if (!url) return fromVideo();
    const img = new Image();
    img.onload = () => toPixels(img, img.naturalWidth, img.naturalHeight);
    img.onerror = fromVideo;
    img.src = url;
  }

  private paintScreen(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number) {
    if (!this.posterList.length) return;
    // The screen faces the camera, so it is an upright rectangle on screen.
    const width = 2 * SCREEN.half * Math.SQRT2 * 0.98;
    const top = sy - (SCREEN.top - 0.3) * 1.2247 * px + 0.25 * px;
    const height = (SCREEN.top - SCREEN.bottom - 0.6) * 1.2247 * px;
    const count = Math.min(3, this.posterList.length);
    const start = Math.floor(this.time / 4) % this.posterList.length;
    const slotW = (width * px) / 3;
    for (let i = 0; i < count; i++) {
      const poster = this.posterList[(start + i) % this.posterList.length];
      const pixels = this.posters.get(poster.creativeId);
      const w = Math.round(9 * (height / 16));
      const x = Math.round(sx - (width * px) / 2 + slotW * (i + (3 - count) / 2) + (slotW - w) / 2);
      const y = Math.round(top);
      ctx.imageSmoothingEnabled = false;
      if (pixels) ctx.drawImage(pixels, x, y, w, Math.round(height));
      else {
        ctx.fillStyle = "#2a2d33";
        ctx.fillRect(x, y, w, Math.round(height));
      }
    }
  }
}

export { hub };
