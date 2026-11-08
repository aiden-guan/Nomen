import { bakeJob, type Job, jobKey } from "./jobs";
import type { Sprite } from "./tracer";

// Turns jobs into drawable images: a small pool of workers bakes them, the results are cached by
// key, and anything not ready yet is simply skipped by the renderer until it arrives.

export type Baked = { image: CanvasImageSource; w: number; h: number; ax: number; ay: number };

type Pending = { id: number; key: string; job: Job; priority: number; resolve: (baked: Baked) => void; reject: (error: Error) => void };

export class Baker {
  private readonly cache = new Map<string, Baked>();
  private readonly inflight = new Map<string, Promise<Baked>>();
  private readonly queue: Pending[] = [];
  private readonly running = new Map<number, Pending>();
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private nextId = 1;
  private inline = false;
  private disposed = false;

  constructor(poolSize?: number) {
    const size = poolSize ?? Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1));
    try {
      for (let i = 0; i < size; i++) {
        const worker = new Worker(new URL("./bake.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ id: number; sprite?: Sprite; error?: string }>) => this.settle(worker, event.data);
        worker.onerror = () => this.fallBackToInline();
        this.workers.push(worker);
        this.idle.push(worker);
      }
    } catch {
      this.fallBackToInline();
    }
  }

  /** The baked image if it is ready; otherwise starts baking it and returns undefined. */
  get(job: Job, priority = 0): Baked | undefined {
    const key = jobKey(job);
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (!this.inflight.has(key)) void this.request(job, priority).catch(() => undefined);
    return undefined;
  }

  has(job: Job) {
    return this.cache.has(jobKey(job));
  }

  /** Bakes a job (once) and resolves with its image. Higher priority runs first. */
  request(job: Job, priority = 0): Promise<Baked> {
    const key = jobKey(job);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const existing = this.inflight.get(key);
    if (existing) {
      const queued = this.queue.find((p) => p.key === key);
      if (queued && priority > queued.priority) {
        queued.priority = priority;
        this.sortQueue();
      }
      return existing;
    }
    const promise = new Promise<Baked>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, key, job, priority, resolve, reject });
      this.sortQueue();
    });
    this.inflight.set(key, promise);
    this.pump();
    return promise;
  }

  /** Requests many jobs and resolves when all are ready. */
  all(jobs: Job[], priority = 0) {
    return Promise.all(jobs.map((job) => this.request(job, priority)));
  }

  dispose() {
    this.disposed = true;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.queue.length = 0;
  }

  private sortQueue() {
    this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
  }

  private pump() {
    if (this.disposed) return;
    if (this.inline) {
      this.pumpInline();
      return;
    }
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop()!;
      const next = this.queue.shift()!;
      this.running.set(next.id, next);
      worker.postMessage({ id: next.id, job: next.job });
    }
  }

  private inlineScheduled = false;

  private pumpInline() {
    if (this.inlineScheduled || !this.queue.length) return;
    this.inlineScheduled = true;
    // One job per task keeps input responsive even without workers.
    setTimeout(() => {
      this.inlineScheduled = false;
      const next = this.queue.shift();
      if (next) {
        try {
          void this.finish(next, bakeJob(next.job));
        } catch (error) {
          this.fail(next, error);
        }
      }
      this.pumpInline();
    }, 0);
  }

  private settle(worker: Worker, data: { id: number; sprite?: Sprite; error?: string }) {
    const job = this.running.get(data.id);
    this.running.delete(data.id);
    this.idle.push(worker);
    if (job) {
      if (data.sprite) void this.finish(job, data.sprite);
      else this.fail(job, new Error(data.error ?? "bake failed"));
    }
    this.pump();
  }

  private fallBackToInline() {
    if (this.inline) return;
    this.inline = true;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    // Anything that was on a worker goes back on the queue.
    for (const job of this.running.values()) this.queue.push(job);
    this.running.clear();
    this.sortQueue();
    this.pump();
  }

  private async finish(job: Pending, sprite: Sprite) {
    try {
      const baked = { image: await toImage(sprite), w: sprite.w, h: sprite.h, ax: sprite.ax, ay: sprite.ay };
      this.cache.set(job.key, baked);
      this.inflight.delete(job.key);
      job.resolve(baked);
    } catch (error) {
      this.fail(job, error);
    }
  }

  private fail(job: Pending, error: unknown) {
    this.inflight.delete(job.key);
    job.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

async function toImage(sprite: Sprite): Promise<CanvasImageSource> {
  const data = new ImageData(sprite.rgba as Uint8ClampedArray<ArrayBuffer>, sprite.w, sprite.h);
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(data);
    } catch {
      // fall through to a canvas
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = sprite.w;
  canvas.height = sprite.h;
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  return canvas;
}
