"use client";

import { type ReactNode, type SyntheticEvent, useEffect, useRef } from "react";
import type { Baker } from "../engine/baker";
import { type Act, ACT_FRAMES, ACT_RATE, type Job, RIDER_FRAME, RIDER_FRAMES, SOLDIER_FRAME } from "../engine/jobs";
import type { PropId } from "../scenes/stations";
import type { StationPlan, StationState } from "../scenes/derive";
import { STATION, type StationId, STATIONS } from "../scenes/layout";
import styles from "../troy.module.css";

// Small pieces shared by the station panel and the agent card: portraits drawn from the same
// baked sprites as the camp, the stations' emblems, a map of the camp, and a step tracker.

// --- Names ------------------------------------------------------------------------------------------

const NAMES = [
  "Nikias", "Kleon", "Lysandros", "Kallias", "Demetrios", "Theron", "Philon", "Xanthos", "Myron", "Glaukos", "Damon", "Kimon",
  "Agis", "Hermon", "Lykos", "Phaidon", "Alkaios", "Doros", "Menon", "Polemon", "Straton", "Timon", "Aristos", "Kritias",
  "Eudoros", "Kleitos", "Philippos", "Antiochos", "Nikandros", "Hippias", "Isokrates", "Laches", "Meidias", "Pasion", "Simon", "Lykon",
  "Thrasyllos", "Xenokles", "Zenon", "Ariston", "Diodoros", "Euthymos", "Kallistratos", "Mnason", "Nikon", "Phormion", "Sostratos", "Chairon",
  // Enough for the army below the agora too.
  "Andronikos", "Archelaos", "Aristeides", "Dion", "Hagnon", "Iason", "Kallimachos", "Kleomenes", "Lysias", "Megakles", "Nearchos", "Pausanias",
  "Perdikkas", "Pelopidas", "Philotas", "Sokles", "Telamon", "Theodoros", "Thrasyboulos", "Timoleon", "Xenon", "Zopyros", "Agathon", "Akastos",
  "Charmides", "Dexippos", "Eumenes", "Glaukias", "Hieron", "Krateros", "Lykourgos", "Nikostratos", "Alkimos", "Bion", "Eudemos", "Hipponikos",
];
const FIXED: Record<string, string> = { general: "Themistokles", herald: "Stentor" };
const named = new Map<string, string>();

/**
 * A Greek name for an agent: the same every time for the same agent, and no two agents share one
 * (the first free name from the agent's own place in the list).
 */
export function greekName(id: string) {
  const known = named.get(id) ?? FIXED[id];
  if (known) return known;
  let h = 7;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const taken = new Set(named.values());
  let name = "";
  for (let i = 0; i < NAMES.length && !name; i++) {
    const candidate = NAMES[(h + i) % NAMES.length];
    if (!taken.has(candidate)) name = candidate;
  }
  // More agents than names: the second of a name is "the Younger".
  if (!name) name = `${NAMES[h % NAMES.length]} the Younger`;
  named.set(id, name);
  return name;
}

// --- Portraits ----------------------------------------------------------------------------------------

/**
 * A soldier drawn full length on a patch of sand, animated with the frames the camp uses: walking
 * in place while on the move, galloping when mounted, and their work loop at their post.
 */
export function Portrait({
  baker,
  look,
  act,
  mounted = false,
  moving = false,
  carry = 0,
  coat = 0,
  size = 112,
}: {
  baker: Baker | null;
  look: number;
  act: Act;
  mounted?: boolean;
  moving?: boolean;
  carry?: number;
  /** The horse's coat, when mounted. */
  coat?: number;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!baker) return;
    let alive = true;
    // Facing the viewer, a little to the right.
    const dir = 1;
    const jobs: Job[] = mounted
      ? moving
        ? Array.from({ length: RIDER_FRAMES }, (_, f) => ({ k: "rider", look, dir, f, c: carry, h: coat }))
        : [{ k: "rider", look, dir, f: -1, c: carry, h: coat }]
      : Array.from({ length: ACT_FRAMES[act] }, (_, f) => ({ k: "soldier", look, act, dir, f }));
    const rate = mounted ? 0.075 : ACT_RATE[act];
    const frame = mounted ? RIDER_FRAME : SOLDIER_FRAME;
    const images: Array<CanvasImageSource | null> = jobs.map(() => null);
    jobs.forEach((job, i) => void baker.request(job, 7).then((baked) => alive && (images[i] = baked.image)));
    let raf = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const canvas = ref.current;
      if (!alive || !canvas) return;
      const ctx = canvas.getContext("2d")!;
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      // Scale to the figure itself (the frames have room around it), in whole pixels.
      const figure = mounted ? { w: 44, h: 48 } : { w: 22, h: 36 };
      const scale = Math.max(1, Math.floor(Math.min(w / figure.w, (h * 0.86) / figure.h)));
      const footX = Math.round(w / 2);
      const footY = Math.round(h * 0.9);
      // A patch of sand and a soft shadow, pixel by pixel.
      const rx = (mounted ? 15 : 11) * scale;
      for (let y = -4; y <= 4; y++) {
        for (let x = -rx; x <= rx; x += scale) {
          const d = (x / rx) ** 2 + (y / 4) ** 2;
          if (d > 1) continue;
          ctx.fillStyle = d < 0.45 ? "rgba(160, 120, 70, 0.30)" : (x / scale + y) % 2 ? "rgba(214, 186, 139, 0.55)" : "rgba(214, 186, 139, 0.3)";
          ctx.fillRect(footX + x, footY + y * scale * 0.5, scale, Math.max(1, scale * 0.5));
        }
      }
      const i = Math.floor((now - start) / 1000 / rate) % images.length;
      const image = images[i] ?? images.find(Boolean);
      if (image) ctx.drawImage(image, Math.round(footX - frame.ax * scale), Math.round(footY - frame.ay * scale), frame.w * scale, frame.h * scale);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [baker, look, act, mounted, moving, carry, coat]);
  return <canvas ref={ref} width={size * 2} height={Math.round(size * 2.2)} style={{ width: size, height: Math.round(size * 1.1), imageRendering: "pixelated" }} aria-hidden="true" />;
}

/** Each station's emblem: its main piece of furniture, baked like the camp's. */
const EMBLEM: Record<StationId, { id: PropId; v: number }> = {
  scouts: { id: "tower", v: 0 },
  oracle: { id: "shrine", v: 2 },
  tent: { id: "pavilion", v: 0 },
  workshop: { id: "desk", v: 4 },
  theatre: { id: "screen", v: 0 },
  agora: { id: "podium", v: 0 },
};

export function Emblem({ baker, id, size = 56 }: { baker: Baker | null; id: StationId; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!baker) return;
    let alive = true;
    void baker.request({ k: "prop", ...EMBLEM[id] }, 7).then((baked) => {
      const canvas = ref.current;
      if (!alive || !canvas) return;
      const box = opaqueBounds(baked.image, baked.w, baked.h);
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      // Whole pixels when that still fills the badge, otherwise as large as fits.
      const fit = Math.min((canvas.width * 0.92) / box.w, (canvas.height * 0.92) / box.h);
      const scale = fit >= 2 ? Math.floor(fit) : fit;
      const w = Math.round(box.w * scale);
      const h = Math.round(box.h * scale);
      ctx.drawImage(baked.image, box.x, box.y, box.w, box.h, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
    });
    return () => {
      alive = false;
    };
  }, [baker, id]);
  return <canvas ref={ref} width={size * 2} height={size * 2} style={{ width: size, height: size, imageRendering: "pixelated" }} aria-hidden="true" />;
}

/** The rectangle of a sprite that has any pixels in it. */
function opaqueBounds(image: CanvasImageSource, w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[(y * w + x) * 4 + 3]) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Wraps a line in curly quotes, without doubling the quotes it may already have. */
export function quote(text: string) {
  return `“${text.trim().replace(/^["“'‘]+|["”'’]+$/g, "")}”`;
}

// --- The camp at a glance ------------------------------------------------------------------------------

export const STATE_WORD: Record<StationState, string> = { waiting: "Waiting", working: "Working", done: "Done", failed: "Stopped", skipped: "Skipped", yours: "Your turn" };

export const STATE_COLOR: Record<StationState, string> = {
  waiting: "var(--ink-faint)",
  working: "var(--crimson)",
  done: "var(--olive)",
  failed: "var(--crimson-dark)",
  skipped: "var(--ink-faint)",
  yours: "var(--teal)",
};

/**
 * The six stations as they sit in the camp (two rows, the road running round), coloured by state.
 * `here` is ringed; `route` draws an errand from one station to another.
 */
export function CampMap({
  stations,
  here,
  route,
  onPick,
}: {
  stations: Record<StationId, StationPlan>;
  here?: StationId | null;
  route?: { from: StationId; to: StationId } | null;
  onPick?: (id: StationId) => void;
}) {
  // Columns and rows of the camp: top row scouts → tent, bottom row agora ← workshop.
  const cell: Record<StationId, [number, number]> = { scouts: [0, 0], oracle: [1, 0], tent: [2, 0], agora: [0, 1], theatre: [1, 1], workshop: [2, 1] };
  const x = (id: StationId) => 34 + cell[id][0] * 116;
  const y = (id: StationId) => 16 + cell[id][1] * 48;
  const roads: Array<[StationId, StationId]> = [
    ["scouts", "oracle"],
    ["oracle", "tent"],
    ["tent", "workshop"],
    ["workshop", "theatre"],
    ["theatre", "agora"],
    ["agora", "scouts"],
  ];
  return (
    <svg viewBox="0 0 300 100" className="block w-full" role="img" aria-label="The camp's stations and their state" shapeRendering="crispEdges">
      {roads.map(([a, b]) => (
        <line key={`${a}${b}`} x1={x(a)} y1={y(a)} x2={x(b)} y2={y(b)} stroke="#e3c896" strokeWidth={6} />
      ))}
      {route && (
        <line x1={x(route.from)} y1={y(route.from)} x2={x(route.to)} y2={y(route.to)} stroke="var(--crimson)" strokeWidth={2} strokeDasharray="4 3" className={styles.march} />
      )}
      {STATIONS.map((s) => {
        const plan = stations[s.id];
        const color = STATE_COLOR[plan.state];
        const active = here === s.id;
        const inner = (
          <>
            {active && <rect x={x(s.id) - 15} y={y(s.id) - 15} width={30} height={30} fill="none" stroke="var(--ink)" strokeWidth={2} />}
            <rect x={x(s.id) - 10} y={y(s.id) - 10} width={20} height={20} fill={plan.state === "waiting" || plan.state === "skipped" ? "var(--paper)" : color} stroke={color} strokeWidth={2} />
            {plan.state === "working" && <rect x={x(s.id) - 4} y={y(s.id) - 4} width={8} height={8} fill="var(--paper)" className={styles.blink} />}
            {plan.state === "done" && <path d={`M${x(s.id) - 5} ${y(s.id)}l3 4l7-8`} stroke="var(--paper)" strokeWidth={2.5} fill="none" />}
            <text x={x(s.id)} y={y(s.id) + 23} textAnchor="middle" className={styles.pixel} fontSize={10} fill={active ? "var(--ink)" : "var(--ink-soft)"}>
              {s.name}
            </text>
          </>
        );
        return onPick ? (
          <g key={s.id} role="button" tabIndex={0} aria-label={`${s.name}: ${STATE_WORD[plan.state]}`} className="cursor-pointer outline-none" onClick={() => onPick(s.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick(s.id)}>
            <rect x={x(s.id) - 50} y={y(s.id) - 14} width={100} height={42} fill="transparent" />
            {inner}
          </g>
        ) : (
          <g key={s.id}>{inner}</g>
        );
      })}
    </svg>
  );
}

// --- Bits ------------------------------------------------------------------------------------------------

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className={`${styles.pixel} mb-2.5 flex items-baseline gap-2 text-[12px] uppercase tracking-wider text-[var(--ink-faint)]`}>
        <span>{title}</span>
        {aside && <span className="ml-auto normal-case tracking-normal">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A row of steps, done ones filled, the current one pulsing. `failed` marks the current step red. */
export function Steps({ steps, current, failed = false }: { steps: string[]; current: number; failed?: boolean }) {
  return (
    <ol className="flex items-start gap-1" aria-label={`Step ${Math.min(current + 1, steps.length)} of ${steps.length}: ${steps[Math.min(current, steps.length - 1)]}`}>
      {steps.map((step, i) => {
        const done = i < current;
        const now = i === current;
        const color = now && failed ? "var(--crimson-dark)" : done ? "var(--olive)" : now ? "var(--crimson)" : "rgba(43,29,20,0.12)";
        return (
          <li key={step} className="min-w-0 flex-1">
            <span className={`block h-[6px] ${now && !failed ? styles.blink : ""}`} style={{ background: color }} />
            <span className={`${styles.pixel} mt-1 block truncate text-[10px] ${done || now ? "text-[var(--ink)]" : "text-[var(--ink-faint)]"}`}>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Chip({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "crimson" | "olive" | "teal" | "bronze" | "faint" }) {
  const color = { ink: "var(--ink)", crimson: "var(--crimson)", olive: "var(--olive)", teal: "var(--teal)", bronze: "var(--bronze)", faint: "var(--ink-faint)" }[tone];
  return (
    <span className={`${styles.pixel} inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-[11px]`} style={{ color, boxShadow: `inset 0 0 0 1.5px ${color}` }}>
      {children}
    </span>
  );
}

export function Stat({ n, label, icon }: { n: ReactNode; label: string; icon?: IconName }) {
  return (
    <div className="bg-[rgba(43,29,20,0.05)] px-2 py-2 text-center">
      <div className={`${styles.pixel} flex items-center justify-center gap-1.5 text-[20px] leading-none`}>
        {icon && <Icon name={icon} size={14} />}
        {n}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-[var(--ink-soft)]">{label}</div>
    </div>
  );
}

/** A parchment card: for the brief, a concept, a source. */
export function Parchment({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${styles.parchment} px-3 py-2.5 ${className}`}>{children}</div>;
}

// 14×14 pixel glyphs, drawn crisp.
const ICONS = {
  scroll: "M3 2h8v1h1v2h-1v6h1v2h-1v1h-8v-1h-1v-2h1v-6h-1v-2h1zM4 4v7h6v-7z",
  horse: "M8 2h2v1h1v1h1v2h-2v1h-1v2h1v3h-1v-2h-3v2h-1v-3h-1v-1h-1v2h-1v-3h1v-1h4v-1h1v-2h-1z",
  hourglass: "M3 2h8v2h-1v1h-1v1h-1v2h1v1h1v1h1v2h-8v-2h1v-1h1v-1h1v-2h-1v-1h-1v-1h-1z",
  check: "M11 3h2v2h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1h-2v-1h-1v-1h-1v-1h-1v-2h2v1h1v1h1v-1h1v-1h1v-1h1v-1h1z",
  cross: "M3 3h2v1h1v1h2v-1h1v-1h2v2h-1v1h-1v2h1v1h1v2h-2v-1h-1v-1h-2v1h-1v1h-2v-2h1v-1h1v-2h-1v-1h-1z",
  film: "M2 2h10v10h-10zM3 3v1h1v-1zM10 3v1h1v-1zM3 6v1h1v-1zM10 6v1h1v-1zM3 9v1h1v-1zM10 9v1h1v-1zM5 3v8h4v-8z",
  eye: "M5 4h4v1h2v1h1v2h-1v1h-2v1h-4v-1h-2v-1h-1v-2h1v-1h2zM6 6v2h2v-2z",
  trumpet: "M2 6h6v-1h1v-1h2v-1h1v8h-1v-1h-2v-1h-1v-1h-6z",
  pin: "M5 2h4v1h1v4h-1v1h-1v2h-1v2h-1v-2h-1v-2h-1v-1h-1v-4h1zM6 4v2h2v-2z",
  play: "M4 3h2v9h-2zM6 4h1v7h-1zM7 5h1v5h-1zM8 6h1v3h-1zM9 7h1v1h-1z",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 14, color = "currentColor" }: { name: IconName; size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} fill={color} shapeRendering="crispEdges" aria-hidden="true" className="shrink-0">
      <path d={ICONS[name]} fillRule="evenodd" />
    </svg>
  );
}

/** Pixel-art stills (a few dozen pixels wide) scale up crisp; photos stay smooth. */
export function crispIfTiny(event: SyntheticEvent<HTMLImageElement>) {
  if (event.currentTarget.naturalWidth < 120) event.currentTarget.style.imageRendering = "pixelated";
}

export function stationName(id: StationId) {
  return STATION[id].name;
}
