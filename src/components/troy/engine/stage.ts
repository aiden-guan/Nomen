import type { Baked, Baker } from "./baker";
import type { Job } from "./jobs";
import { projectX, projectY } from "./tracer";

// The stage draws the world on one canvas. Positions are world units; the camera looks at a point
// in art pixels (projected world space) with a zoom in CSS pixels per art pixel. Everything is
// drawn in device pixels with whole-pixel scales at rest, so the art stays crisp.

export type Entity = {
  x: number;
  y: number;
  z: number;
  /** Extra isometric depth (added to x + y) for sorting. */
  sort?: number;
  /** Ground layers draw first, in insertion order, before any sorted entity. */
  ground?: boolean;
  job?: Job | null;
  /** Mirror horizontally around the sprite's anchor. */
  flip?: boolean;
  alpha?: number;
  hidden?: boolean;
  /** 0..1: how much of the sprite has appeared, revealed pixel by pixel. */
  reveal?: number;
  /** Radius (art px) of the soft blob shadow drawn at the entity's feet. */
  shadow?: number;
  /** Custom drawing. `px` is the device-pixel size of one art pixel. */
  paint?: (ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, time: number) => void;
  tick?: (dt: number, time: number) => void | "remove";
  /** Priority for baking this entity's sprites. */
  priority?: number;
  /** The last sprite drawn, shown again while the next frame is still baking (no flicker). */
  drawn?: Baked;
};

export type CameraTarget = { x: number; y: number; zoom: number };

type Anchor = { el: HTMLElement; at: () => { x: number; y: number; z: number } | null; dx: number; dy: number; visible: boolean };

const REVEAL_LEVELS = 24;

export class Stage {
  readonly entities: Entity[] = [];
  readonly camera = { x: 0, y: 0, zoom: 2 };
  timeScale = 1;
  /** Called every frame before drawing. */
  onFrame: ((dt: number, time: number) => void) | null = null;

  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private raf = 0;
  private last = 0;
  private time = 0;
  private running = false;
  private cameraTween: { from: CameraTarget; to: CameraTarget; start: number; duration: number; ease: (t: number) => number; done?: () => void } | null = null;
  private anchors: Anchor[] = [];
  private revealMasks: HTMLCanvasElement[] = [];
  private scratch: HTMLCanvasElement;
  private shadowSprite: HTMLCanvasElement;
  private resizeObserver: ResizeObserver | null = null;
  shake = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly baker: Baker,
  ) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("canvas 2d is not available");
    this.ctx = ctx;
    this.scratch = document.createElement("canvas");
    this.shadowSprite = makeShadowSprite();
    this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
  }

  get size() {
    return { width: this.width, height: this.height, dpr: this.dpr };
  }

  /** The canvas the stage draws on (for pointer input). */
  get element() {
    return this.canvas;
  }

  /**
   * Keeps the camera on a moving world point (a selected soldier). The camera's centre sits `dx`,
   * `dy` CSS pixels from the point, so the point stays clear of panels at any zoom. A camera move in
   * progress steers toward the point as it moves. Returning null leaves the camera where it is
   * (the point left the visible world).
   */
  follow: { at: () => { x: number; y: number; z: number } | null; dx: number; dy: number } | null = null;

  /** Where the camera's centre may go (art px) when the viewer pans or zooms; null: anywhere. */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** How far the viewer can zoom out and in, in CSS pixels per art pixel. */
  zoomRange = { min: 0.5, max: 6 };
  /**
   * A zoom the viewer asked for (wheel, pinch, buttons): the camera eases toward `zoom` while the
   * world point (ax, ay) stays at (sx, sy) CSS px from the canvas's centre, under the pointer.
   */
  private zoomGoal: { zoom: number; sx: number; sy: number; ax: number; ay: number } | null = null;

  /** Device pixels per art pixel for a zoom, snapped so art pixels stay whole on this screen. */
  snapZoom(zoom: number) {
    const device = Math.max(1, Math.round(zoom * this.dpr));
    return device / this.dpr;
  }

  /**
   * The zooms the camera settles on, smallest first: whole device pixels per art pixel (crisp art),
   * with quarter steps between them where they are far apart (1x screens, zoomed far out).
   */
  zoomSteps() {
    const { min, max } = this.zoomRange;
    const crisp: number[] = [];
    for (let d = Math.max(1, Math.ceil(min * this.dpr - 1e-6)); d / this.dpr <= max + 1e-6; d++) crisp.push(d / this.dpr);
    const steps: number[] = [];
    crisp.forEach((zoom, i) => {
      steps.push(zoom);
      const next = crisp[i + 1];
      if (!next || next / zoom <= 1.3) return;
      for (let q = Math.floor(zoom * 4 + 1) / 4; q < next; q += 0.25) {
        if (q / steps[steps.length - 1] >= 1.15 && next / q >= 1.15) steps.push(q);
      }
    });
    return steps.length ? steps : [this.fitZoom(min)];
  }

  /** The zoom the camera is heading for: a zoom in progress, a camera move, or where it is. */
  get zoomTarget() {
    return this.zoomGoal?.zoom ?? this.cameraTween?.to.zoom ?? this.camera.zoom;
  }

  /**
   * Zooms by `factor` toward a point on screen (CSS px from the canvas's top left; the centre by
   * default), keeping the world under that point where it is. The camera eases there unless
   * `instant` (a pinch, which tracks the fingers); `settle` lands on the nearest crisp zoom.
   */
  zoomToward(factor: number, at?: { x: number; y: number }, { instant = false, settle = false } = {}) {
    const { min, max } = this.zoomRange;
    let zoom = Math.min(max, Math.max(min, this.zoomTarget * factor));
    if (settle) zoom = this.nearestStep(zoom);
    this.aimZoom(zoom, at);
    if (instant) this.stepZoom(Infinity);
  }

  /** One crisp step in (+1) or out (-1), toward a point on screen (the centre by default). */
  zoomStep(direction: 1 | -1, at?: { x: number; y: number }) {
    const steps = this.zoomSteps();
    const from = this.zoomTarget;
    const next = direction > 0 ? steps.find((s) => s > from * 1.01) : [...steps].reverse().find((s) => s < from / 1.01);
    if (next !== undefined) this.aimZoom(next, at);
  }

  /** Ends a free zoom (a pinch, a trackpad) on the nearest crisp step, around the same point. */
  settleZoom() {
    const goal = this.zoomGoal;
    const zoom = this.nearestStep(this.zoomTarget);
    if (goal) goal.zoom = zoom;
    else if (Math.abs(zoom - this.camera.zoom) > 1e-6) this.aimZoom(zoom);
  }

  /** Moves the camera by a distance on screen (CSS px): the world follows a dragging pointer. */
  panBy(dx: number, dy: number) {
    this.cameraTween = null;
    const z = this.camera.zoom;
    this.camera.x -= dx / z;
    this.camera.y -= dy / z;
    if (this.zoomGoal) {
      this.zoomGoal.ax -= dx / z;
      this.zoomGoal.ay -= dy / z;
    }
    this.keepInBounds();
  }

  private nearestStep(zoom: number) {
    let best = zoom;
    let score = Infinity;
    for (const step of this.zoomSteps()) {
      const d = Math.abs(Math.log(step / zoom));
      if (d < score) {
        score = d;
        best = step;
      }
    }
    return best;
  }

  private aimZoom(zoom: number, at?: { x: number; y: number }) {
    const sx = (at?.x ?? this.width / 2) - this.width / 2;
    const sy = (at?.y ?? this.height / 2) - this.height / 2;
    // The viewer took the camera: a framing move in progress stops where it is.
    this.cameraTween = null;
    this.zoomGoal = { zoom, sx, sy, ax: this.camera.x + sx / this.camera.zoom, ay: this.camera.y + sy / this.camera.zoom };
  }

  private stepZoom(dt: number) {
    const goal = this.zoomGoal;
    if (!goal) return;
    const k = 1 - Math.exp(-dt * 16);
    let zoom = this.camera.zoom * (goal.zoom / this.camera.zoom) ** k;
    if (Math.abs(Math.log(goal.zoom / zoom)) < 0.004) zoom = goal.zoom;
    this.camera.zoom = zoom;
    // A followed soldier holds the camera's position; otherwise the point under the pointer does.
    if (!this.follow) {
      this.camera.x = goal.ax - goal.sx / zoom;
      this.camera.y = goal.ay - goal.sy / zoom;
      this.keepInBounds();
    }
    if (zoom === goal.zoom) this.zoomGoal = null;
  }

  private keepInBounds() {
    const b = this.bounds;
    if (!b) return;
    this.camera.x = Math.min(b.x1, Math.max(b.x0, this.camera.x));
    this.camera.y = Math.min(b.y1, Math.max(b.y0, this.camera.y));
  }

  /**
   * The largest zoom that fits, in whole device pixels when that costs little (crisp art), else in
   * quarter steps: on a 1x screen, 1.75 with a few doubled pixels beats a camp drawn at 1.
   */
  fitZoom(fit: number) {
    const whole = Math.floor(fit * this.dpr + 0.02) / this.dpr;
    if (whole >= fit * 0.78) return Math.max(1 / this.dpr, whole);
    return Math.max(1 / this.dpr, Math.floor(fit * 4) / 4);
  }

  add<T extends Entity>(entity: T): T {
    if (!this.entities.includes(entity)) this.entities.push(entity);
    this.removed.delete(entity);
    return entity;
  }

  remove(entity: Entity) {
    const index = this.entities.indexOf(entity);
    if (index >= 0) this.entities.splice(index, 1);
    this.removed.add(entity);
  }

  has(entity: Entity) {
    return this.entities.includes(entity);
  }

  private readonly removed = new Set<Entity>();

  /** Keeps an HTML element positioned over a world point (CSS transform, set every frame). */
  anchor(el: HTMLElement, at: () => { x: number; y: number; z: number } | null, dx = 0, dy = 0) {
    const anchor: Anchor = { el, at, dx, dy, visible: true };
    this.anchors.push(anchor);
    return () => {
      this.anchors = this.anchors.filter((a) => a !== anchor);
    };
  }

  /** CSS pixel position (relative to the canvas) of a world point. */
  toScreen(x: number, y: number, z = 0) {
    const ax = projectX(x, y);
    const ay = projectY(x, y, z);
    return { x: (ax - this.camera.x) * this.camera.zoom + this.width / 2, y: (ay - this.camera.y) * this.camera.zoom + this.height / 2 };
  }

  /** Art-pixel position (projected) of a world point. */
  static project(x: number, y: number, z = 0) {
    return { x: projectX(x, y), y: projectY(x, y, z) };
  }

  look(target: CameraTarget, duration = 0, ease: (t: number) => number = easeInOutCubic, done?: () => void) {
    this.zoomGoal = null;
    if (duration <= 0) {
      this.camera.x = target.x;
      this.camera.y = target.y;
      this.camera.zoom = target.zoom;
      this.cameraTween = null;
      done?.();
      return;
    }
    this.cameraTween = { from: { ...this.camera }, to: target, start: this.time, duration, ease, done };
  }

  get cameraMoving() {
    return this.cameraTween !== null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000) * this.timeScale;
      this.last = now;
      this.time += dt;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.resizeObserver?.disconnect();
    this.anchors = [];
    this.entities.length = 0;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const w = Math.round(this.width * this.dpr);
    const h = Math.round(this.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.onResize?.(this.width, this.height);
  }

  onResize: ((width: number, height: number) => void) | null = null;

  private step(dt: number) {
    this.stepZoom(dt);
    const followed = this.follow?.at();
    if (this.follow && followed) {
      // The offset is in CSS px: in art px it shrinks as the camera zooms in.
      const zoom = this.cameraTween?.to.zoom ?? this.camera.zoom;
      const tx = projectX(followed.x, followed.y) + this.follow.dx / zoom;
      const ty = projectY(followed.x, followed.y, followed.z) + this.follow.dy / zoom;
      if (this.cameraTween) {
        this.cameraTween.to = { ...this.cameraTween.to, x: tx, y: ty };
      } else {
        // Ease toward it, so a galloping rider pulls the camera along without jitter.
        const k = 1 - Math.exp(-dt * 5);
        this.camera.x += (tx - this.camera.x) * k;
        this.camera.y += (ty - this.camera.y) * k;
      }
    }
    if (this.cameraTween) {
      const tw = this.cameraTween;
      const t = Math.min(1, (this.time - tw.start) / tw.duration);
      const e = tw.ease(t);
      this.camera.x = tw.from.x + (tw.to.x - tw.from.x) * e;
      this.camera.y = tw.from.y + (tw.to.y - tw.from.y) * e;
      // Interpolate zoom geometrically so the scale change feels even.
      this.camera.zoom = tw.from.zoom * (tw.to.zoom / tw.from.zoom) ** e;
      if (t >= 1) {
        this.cameraTween = null;
        tw.done?.();
      }
    }
    this.onFrame?.(dt, this.time);
    // A tick may add or remove other entities, so remove by identity, never by a stale index,
    // and skip anything removed earlier in this frame.
    this.removed.clear();
    for (const entity of [...this.entities]) {
      if (this.removed.has(entity)) continue;
      if (entity.tick && entity.tick(dt, this.time) === "remove") this.remove(entity);
    }
    this.shake = Math.max(0, this.shake - dt * 3);
  }

  private draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    const px = this.camera.zoom * dpr; // device pixels per art pixel
    const shakeX = this.shake > 0 ? Math.round(Math.sin(this.time * 61) * this.shake * 2) * Math.max(1, Math.round(px)) * 0.5 : 0;
    const shakeY = this.shake > 0 ? Math.round(Math.cos(this.time * 53) * this.shake * 2) * Math.max(1, Math.round(px)) * 0.5 : 0;
    const ox = (this.width * dpr) / 2 - this.camera.x * px + shakeX;
    const oy = (this.height * dpr) / 2 - this.camera.y * px + shakeY;
    // Visible art-pixel rectangle, for culling.
    const viewX0 = -ox / px - 4;
    const viewY0 = -oy / px - 4;
    const viewX1 = (this.width * dpr - ox) / px + 4;
    const viewY1 = (this.height * dpr - oy) / px + 4;

    const sorted: Entity[] = [];
    for (const entity of this.entities) {
      if (entity.hidden) continue;
      if (entity.ground) this.drawEntity(entity, ox, oy, px, viewX0, viewY0, viewX1, viewY1);
      else sorted.push(entity);
    }
    sorted.sort((a, b) => a.x + a.y + (a.sort ?? 0) - (b.x + b.y + (b.sort ?? 0)));
    for (const entity of sorted) this.drawEntity(entity, ox, oy, px, viewX0, viewY0, viewX1, viewY1);

    // Overlays follow their world points.
    for (const anchor of this.anchors) {
      const at = anchor.at();
      if (!at) {
        if (anchor.visible) {
          anchor.el.style.visibility = "hidden";
          anchor.visible = false;
        }
        continue;
      }
      const s = this.toScreen(at.x, at.y, at.z);
      anchor.el.style.transform = `translate3d(${Math.round(s.x + anchor.dx)}px, ${Math.round(s.y + anchor.dy)}px, 0)`;
      if (!anchor.visible) {
        anchor.el.style.visibility = "";
        anchor.visible = true;
      }
    }
  }

  private drawEntity(entity: Entity, ox: number, oy: number, px: number, vx0: number, vy0: number, vx1: number, vy1: number) {
    const ctx = this.ctx;
    const sx = projectX(entity.x, entity.y);
    const sy = projectY(entity.x, entity.y, entity.z);
    const alpha = entity.alpha ?? 1;
    if (alpha <= 0) return;
    if (entity.shadow) {
      const gy = projectY(entity.x, entity.y, 0);
      const r = entity.shadow;
      ctx.globalAlpha = alpha * Math.max(0.25, 1 - entity.z / 40);
      ctx.drawImage(this.shadowSprite, Math.round(ox + (sx - r) * px), Math.round(oy + (gy - r * 0.45) * px), Math.round(r * 2 * px), Math.round(r * 0.9 * px));
    }
    if (entity.job) {
      // A frame that is not baked yet keeps the previous one on screen instead of a blank.
      const fresh = this.baker.get(entity.job, entity.priority ?? 0);
      if (fresh) entity.drawn = fresh;
      const baked = fresh ?? entity.drawn;
      if (baked) {
        const left = sx - (entity.flip ? baked.w - baked.ax : baked.ax);
        const top = sy - baked.ay;
        if (left > vx1 || top > vy1 || left + baked.w < vx0 || top + baked.h < vy0) {
          ctx.globalAlpha = 1;
          return;
        }
        const dx = Math.round(ox + left * px);
        const dy = Math.round(oy + top * px);
        const dw = Math.round(baked.w * px);
        const dh = Math.round(baked.h * px);
        ctx.globalAlpha = alpha;
        const reveal = entity.reveal ?? 1;
        if (reveal < 1) this.drawRevealed(baked, reveal, dx, dy, dw, dh, entity.flip ?? false);
        else if (entity.flip) {
          ctx.save();
          ctx.translate(dx + dw, dy);
          ctx.scale(-1, 1);
          ctx.drawImage(baked.image, 0, 0, dw, dh);
          ctx.restore();
        } else ctx.drawImage(baked.image, dx, dy, dw, dh);
      }
    }
    if (entity.paint) {
      ctx.globalAlpha = alpha;
      entity.paint(ctx, ox + sx * px, oy + sy * px, px, this.time);
    }
    ctx.globalAlpha = 1;
  }

  /** Draws a sprite through a noise mask so it appears (or vanishes) pixel by pixel. */
  private drawRevealed(baked: Baked, reveal: number, dx: number, dy: number, dw: number, dh: number, flip: boolean) {
    if (reveal <= 0) return;
    const level = Math.max(1, Math.min(REVEAL_LEVELS, Math.round(reveal * REVEAL_LEVELS)));
    const mask = this.revealMask(level);
    const scratch = this.scratch;
    if (scratch.width < baked.w || scratch.height < baked.h) {
      scratch.width = Math.max(scratch.width, baked.w);
      scratch.height = Math.max(scratch.height, baked.h);
    }
    const sctx = scratch.getContext("2d")!;
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, baked.w, baked.h);
    sctx.drawImage(baked.image, 0, 0);
    sctx.globalCompositeOperation = "destination-in";
    const pattern = sctx.createPattern(mask, "repeat");
    if (pattern) {
      sctx.fillStyle = pattern;
      sctx.fillRect(0, 0, baked.w, baked.h);
    }
    sctx.globalCompositeOperation = "source-over";
    const ctx = this.ctx;
    if (flip) {
      ctx.save();
      ctx.translate(dx + dw, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(scratch, 0, 0, baked.w, baked.h, 0, 0, dw, dh);
      ctx.restore();
    } else ctx.drawImage(scratch, 0, 0, baked.w, baked.h, dx, dy, dw, dh);
  }

  private revealMask(level: number) {
    if (!this.revealMasks.length) {
      // Clustered noise: random per 2x2 block mixed with per-pixel noise, like dissolving sand.
      const size = 64;
      const threshold = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) threshold[y * size + x] = noise(x >> 1, y >> 1) * 0.65 + noise(x + 101, y + 37) * 0.35;
      }
      for (let l = 1; l <= REVEAL_LEVELS; l++) {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const c = canvas.getContext("2d")!;
        const img = c.createImageData(size, size);
        const cut = l / REVEAL_LEVELS;
        for (let i = 0; i < size * size; i++) img.data[i * 4 + 3] = threshold[i] < cut ? 255 : 0;
        c.putImageData(img, 0, 0);
        this.revealMasks.push(canvas);
      }
    }
    return this.revealMasks[level - 1];
  }
}

function noise(x: number, y: number) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A soft elliptical shadow, dithered at its edge, drawn under walking figures. */
function makeShadowSprite() {
  const w = 16;
  const h = 8;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d")!;
  const img = c.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot((x + 0.5 - w / 2) / (w / 2), (y + 0.5 - h / 2) / (h / 2));
      const inside = d < 0.72 || (d < 1 && (x + y) % 2 === 0);
      if (!inside) continue;
      const i = (y * w + x) * 4;
      img.data[i] = 120;
      img.data[i + 1] = 90;
      img.data[i + 2] = 60;
      img.data[i + 3] = 92;
    }
  }
  c.putImageData(img, 0, 0);
  return canvas;
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
