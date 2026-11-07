import { ACT_FRAMES, ACT_RATE, dirFor, type Job, RIDER_FRAMES } from "../engine/jobs";
import { SCREEN } from "../engine/models/props";
import type { CameraTarget, Entity, Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import { makeWalker, type Point, type Walker } from "../engine/walker";
import type { AgentPlan, CampPlan } from "./derive";
import type { LandingScene } from "./landing";
import { CAMP_CENTER, ISLAND_RADIUS, road, sandbars, STATION, type StationId, STATIONS } from "./layout";
import { DESK_SLOTS, PROPS, SPOTS } from "./stations";

// The camp: station islands, their furniture and the agents, below the horse. This file owns the
// world; Camp.tsx owns the HTML around it and feeds it plans derived from the live campaign.

type Agent = {
  plan: AgentPlan;
  entity: Walker;
  mode: "posted" | "walking" | "leaving" | "away";
  phase: number;
  /** A scout that already brought its scroll back stays off duty. */
  delivered?: boolean;
};

export type CampEvents = {
  /** A messenger reached a station. */
  onArrive?: (station: StationId) => void;
};

export class CampScene {
  readonly grounds: Entity[] = [];
  private readonly props: Entity[] = [];
  private readonly keyed = new Map<string, Entity>();
  private readonly desks = new Map<number, Entity & { state: number }>();
  private readonly agents = new Map<string, Agent>();
  private readonly posters = new Map<string, HTMLCanvasElement | null>();
  private posterList: CampPlan["posters"] = [];
  private showing = false;
  private revealT = 0;
  private readonly barCount = sandbars().length;
  private time = 0;
  private tvOn = false;
  private planned = false;
  events: CampEvents = {};

  constructor(
    private readonly stage: Stage,
    private readonly landing: LandingScene,
  ) {
    sandbars().forEach((_, i) => this.grounds.push(stage.add({ x: 0, y: 0, z: 0, ground: true, job: { k: "bar", i }, reveal: 0, priority: 5 - i * 0.1 })));
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
    // The theatre screen shows finished videos, drawn over the screen prop.
    const screen = this.keyed.get("theatre:screen")!;
    stage.add({ x: screen.x, y: screen.y, z: 0, sort: 0.5, paint: (ctx, sx, sy, px) => this.paintScreen(ctx, sx, sy, px) });
    stage.add({ x: 0, y: 0, z: 0, tick: (dt) => this.tick(dt) });
  }

  /** Starts baking the camp so it is ready when the column arrives. */
  prepare(_brandId: string) {
    for (const entity of [...this.grounds, ...this.props]) if (entity.job) void this.stage.baker.request(entity.job, 5);
  }

  show(visible: boolean) {
    this.showing = visible;
    if (visible && this.revealT === 0 && this.landing.isOpen) this.revealT = 0.0001;
  }

  /** The camera that frames the whole camp, leaving room for the panels around it. */
  camera(insets: { top: number; bottom: number; right: number } = this.insets): CameraTarget {
    const { width, height, dpr } = this.stage.size;
    const spanX = 2 * (196 + ISLAND_RADIUS + 34);
    const spanY = 76 + 80 + 140 + 46;
    const usableW = width - insets.right - 24;
    const usableH = height - insets.top - insets.bottom;
    const fit = Math.min(usableW / spanX, usableH / spanY, 3.5);
    const zoom = Math.max(1 / dpr, Math.floor(fit * dpr) / dpr);
    const midY = CAMP_CENTER.sy - 4;
    return { x: CAMP_CENTER.sx + insets.right / 2 / zoom, y: midY + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  insets = { top: 84, bottom: 72, right: 0 };

  /** A camera centred on one station (for the station panel). */
  focus(id: StationId, insets = this.insets): CameraTarget {
    const base = this.camera(insets);
    const station = STATION[id];
    // Close enough to see who is doing what, in whole device pixels.
    const zoom = Math.min(this.stage.snapZoom(Math.max(2, base.zoom * 1.6)), this.stage.snapZoom(4));
    const sx = projectX(station.x, station.y);
    const sy = projectY(station.x, station.y, 4);
    return { x: sx + insets.right / 2 / zoom, y: sy + (insets.bottom - insets.top) / 2 / zoom, zoom };
  }

  /** Where a station sits on screen (CSS px), for labels. */
  stationPoint(id: StationId) {
    const s = STATION[id];
    return { x: s.x, y: s.y, z: 0 };
  }

  /** The way a soldier from the horse walks to its post, with a little lane offset. */
  marchRoute(index: number): Point[] {
    const station = STATIONS[index % STATIONS.length];
    const lane = ((index * 7) % 5) - 2;
    const points = road("scouts", station.id).map((p, i, all) => (i === all.length - 1 ? p : { x: p.x + lane * 1.6, y: p.y - lane * 1.6, z: 0 }));
    const angle = index * 2.39996;
    const r = ISLAND_RADIUS * (0.25 + ((index * 13) % 7) / 24);
    const end = { x: station.x + Math.cos(angle) * r, y: station.y + Math.sin(angle) * r * 0.8, z: 0 };
    return [{ x: lane * 1.4, y: 70, z: 0 }, ...points.slice(0, -1), end];
  }

  /** Applies a plan: posts every agent, sets screens, baskets and reels. */
  apply(plan: CampPlan) {
    const first = !this.planned;
    this.planned = true;
    for (const [key, value] of Object.entries(plan.props)) {
      for (const station of STATIONS) {
        const entity = this.keyed.get(`${station.id}:${key}`);
        if (entity?.job?.k === "prop") entity.job = { ...entity.job, v: value };
      }
    }
    this.tvOn = plan.tvOn;
    this.posterList = plan.posters;
    for (const poster of plan.posters) this.loadPoster(poster.creativeId, poster.url);

    // Desks: one per video, appearing as the strategy hands out concepts.
    const workshop = STATION.workshop;
    const live = new Set<number>();
    for (const desk of plan.desks) {
      live.add(desk.slot);
      let entity = this.desks.get(desk.slot);
      if (!entity) {
        const slot = DESK_SLOTS[desk.slot];
        entity = Object.assign(this.stage.add({ x: workshop.x + slot.x, y: workshop.y + slot.y, z: 0, job: null as Job | null, reveal: first ? 1 : 0, priority: 4 }), { state: desk.state });
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
      this.post(agentPlan, first);
    }
    for (const [id, agent] of this.agents) {
      if (!seen.has(id) && agent.mode !== "leaving") this.dismiss(agent);
    }
  }

  /** A messenger rides from one station to another along the sandbars. */
  dispatch(from: StationId, to: StationId) {
    if (from === to) return;
    const path = road(from, to).map((p, i, all) => {
      // Start and end at the edge of the islands, not in the middle of their furniture.
      if (i === 0 || i === all.length - 1) {
        const other = i === 0 ? all[1] : all[all.length - 2];
        const dx = other.x - p.x;
        const dy = other.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: p.x + (dx / len) * (ISLAND_RADIUS * 0.55), y: p.y + (dy / len) * (ISLAND_RADIUS * 0.55), z: 0 };
      }
      return p;
    });
    let travelled = 0;
    let leg = 0;
    const rider: Entity = { x: path[0].x, y: path[0].y, z: 0, shadow: 9, alpha: 0, job: null, priority: 3, sort: 2 };
    let fading = -1;
    rider.tick = (dt) => {
      if (fading >= 0) {
        fading += dt;
        rider.alpha = Math.max(0, 1 - fading * 2.5);
        return fading > 0.4 ? "remove" : undefined;
      }
      rider.alpha = Math.min(1, (rider.alpha ?? 0) + dt * 3);
      let step = 52 * dt;
      while (step > 0 && leg < path.length - 1) {
        const b = path[leg + 1];
        const dx = b.x - rider.x;
        const dy = b.y - rider.y;
        const left = Math.hypot(dx, dy);
        const move = Math.min(left, step);
        if (left > 0.001) {
          rider.x += (dx / left) * move;
          rider.y += (dy / left) * move;
          rider.job = { k: "rider", look: 0, dir: dirFor(dx, dy), f: Math.floor((travelled / 7) % RIDER_FRAMES) };
        }
        travelled += move;
        step -= move;
        if (move >= left) leg++;
      }
      if (leg >= path.length - 1) {
        fading = 0;
        this.events.onArrive?.(to);
      }
    };
    this.stage.add(rider);
  }

  private post(plan: AgentPlan, instantly: boolean) {
    const station = STATION[plan.station];
    const target: Point = { x: station.x + plan.x, y: station.y + plan.y, z: plan.z };
    let agent = this.agents.get(plan.id);

    if (!agent) {
      // A scout already out on a run, or one that came back before we were watching, is not drawn.
      if (plan.away || (plan.returning && instantly)) {
        this.agents.set(plan.id, { plan, entity: this.idleWalker(plan, target), mode: "away", phase: Math.random() * 10, delivered: Boolean(plan.returning) });
        return;
      }
      const entity = this.idleWalker(plan, target);
      entity.reveal = instantly ? 1 : 0;
      entity.alpha = 1;
      this.stage.add(entity);
      agent = { plan, entity, mode: "posted", phase: Math.random() * 10 };
      this.agents.set(plan.id, agent);
      if (plan.returning) this.returnFromEdge(agent, target);
      return;
    }

    const previous = agent.plan;
    agent.plan = plan;
    if (plan.away) {
      if (agent.mode === "posted" || agent.mode === "walking") this.leaveCamp(agent);
      return;
    }
    if (plan.returning && agent.delivered) return;
    if (agent.mode === "away" && plan.returning) {
      this.returnFromEdge(agent, target);
      return;
    }
    if (agent.mode === "away") {
      agent.entity.x = target.x;
      agent.entity.y = target.y;
      agent.entity.z = target.z;
      agent.entity.reveal = 0;
      agent.entity.alpha = 1;
      this.stage.add(agent.entity);
      agent.mode = "posted";
      return;
    }
    const moved = Math.hypot(agent.entity.x - target.x, agent.entity.y - target.y) > 1.5 || Math.abs(agent.entity.z - target.z) > 0.5;
    if (moved && agent.mode !== "walking") this.walkTo(agent, target);
    else if (!moved && previous.act !== plan.act) agent.entity.act = plan.act;
  }

  private idleWalker(plan: AgentPlan, at: Point): Walker {
    const walker = makeWalker({ look: plan.look, path: [at, at], act: plan.act, priority: 3 });
    walker.dir = plan.dir;
    walker.sort = plan.sort ?? 0;
    walker.shadow = at.z > 2 ? 0 : 5;
    walker.tick = () => undefined;
    walker.job = { k: "soldier", look: plan.look, act: plan.act, dir: plan.dir, f: 0 };
    return walker;
  }

  private walkTo(agent: Agent, target: Point) {
    agent.mode = "walking";
    Object.assign(agent.entity, { path: [{ x: agent.entity.x, y: agent.entity.y, z: agent.entity.z }, target], leg: 0, travelled: 0, arrived: false, act: "march", speed: 18 });
    agent.entity.onArrive = () => {
      agent.mode = "posted";
      agent.entity.tick = () => undefined;
      agent.entity.dir = agent.plan.dir;
      agent.entity.act = agent.plan.act;
    };
    agent.entity.tick = (dt) => {
      stepOn(agent.entity, dt);
      return undefined;
    };
  }

  private leaveCamp(agent: Agent) {
    const station = STATION[agent.plan.station];
    const exit = { x: station.x + agent.plan.x, y: station.y + agent.plan.y, z: 0 };
    this.walkTo(agent, exit);
    agent.entity.onArrive = () => {
      agent.mode = "away";
      this.fadeOut(agent.entity, () => undefined);
    };
  }

  private returnFromEdge(agent: Agent, target: Point) {
    const station = STATION[agent.plan.station];
    const index = [...agent.plan.id].reduce((n, c) => n + c.charCodeAt(0), 0);
    const exit = SPOTS.exits[index % SPOTS.exits.length];
    agent.delivered = true;
    agent.entity.x = station.x + exit.x;
    agent.entity.y = station.y + exit.y;
    agent.entity.z = 0;
    agent.entity.alpha = 0;
    agent.entity.reveal = 1;
    const carrying = agent.plan.returning === "scroll";
    agent.mode = "walking";
    Object.assign(agent.entity, { path: [{ x: agent.entity.x, y: agent.entity.y, z: 0 }, target], leg: 0, travelled: 0, arrived: false, act: carrying ? "carry" : "march", speed: 16 });
    agent.entity.onArrive = () => {
      // Drop the scroll in the basket, then head off duty.
      agent.entity.act = "stand";
      agent.entity.dir = 5;
      setTimeout(() => {
        agent.mode = "leaving";
        this.fadeOut(agent.entity, () => {
          this.stage.remove(agent.entity);
          agent.mode = "away";
        });
      }, 900);
    };
    agent.entity.tick = (dt) => {
      agent.entity.alpha = Math.min(1, (agent.entity.alpha ?? 0) + dt * 3);
      stepOn(agent.entity, dt);
      return undefined;
    };
    if (!this.stage.entities.includes(agent.entity)) this.stage.add(agent.entity);
  }

  private dismiss(agent: Agent) {
    agent.mode = "leaving";
    this.fadeOut(agent.entity, () => {
      this.stage.remove(agent.entity);
      this.agents.delete(agent.plan.id);
    });
  }

  private fadeOut(entity: Entity, done: () => void) {
    let t = 0;
    entity.tick = (dt) => {
      t += dt;
      entity.reveal = Math.max(0, 1 - t / 0.6);
      if (t >= 0.6) {
        done();
        return "remove";
      }
      return undefined;
    };
  }

  private tick(dt: number) {
    this.time += dt;
    this.revealTick(dt);
    // Animate agents that are at their posts.
    for (const agent of this.agents.values()) {
      if (agent.mode !== "posted") continue;
      const act = agent.entity.act;
      const frames = ACT_FRAMES[act];
      const f = frames > 1 ? Math.floor((this.time + agent.phase) / ACT_RATE[act]) % frames : 0;
      agent.entity.job = { k: "soldier", look: agent.plan.look, act, dir: agent.entity.dir, f };
      if (agent.entity.reveal !== undefined && agent.entity.reveal < 1) agent.entity.reveal = Math.min(1, agent.entity.reveal + dt * 2);
    }
    // Desk screens: a working screen scrolls through four frames.
    const phase = Math.floor(this.time / 0.22) % 4;
    for (const desk of this.desks.values()) {
      desk.job = { k: "prop", id: "desk", v: desk.state * 4 + (desk.state === 1 ? phase : 0) };
      if (desk.reveal !== undefined && desk.reveal < 1) desk.reveal = Math.min(1, desk.reveal + dt * 1.5);
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

  private loadPoster(id: string, url: string | null) {
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
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = `/api/media/${encodeURIComponent(id)}/final.mp4#t=1`;
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

/** Advances a walker-shaped entity along its path (shared by re-posted agents). */
function stepOn(entity: Walker, dt: number) {
  let remaining = entity.speed * dt;
  while (remaining > 0 && entity.leg < entity.path.length - 1) {
    const b = entity.path[entity.leg + 1];
    const dx = b.x - entity.x;
    const dy = b.y - entity.y;
    const dz = b.z - entity.z;
    const left = Math.hypot(dx, dy, dz);
    if (left <= remaining) {
      entity.x = b.x;
      entity.y = b.y;
      entity.z = b.z;
      remaining -= left;
      entity.travelled += left;
      entity.leg++;
    } else {
      const k = remaining / left;
      entity.x += dx * k;
      entity.y += dy * k;
      entity.z += dz * k;
      entity.travelled += remaining;
      remaining = 0;
    }
    if (Math.hypot(dx, dy) > 0.01) entity.dir = dirFor(dx, dy);
  }
  const frames = ACT_FRAMES[entity.act];
  entity.job = { k: "soldier", look: entity.look, act: entity.act, dir: entity.dir, f: Math.floor((entity.travelled / 14) * frames) % frames };
  if (entity.leg >= entity.path.length - 1 && !entity.arrived) {
    entity.arrived = true;
    entity.onArrive?.(entity);
  }
}
