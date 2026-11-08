"use client";

import { usePathname } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiFailure, type BrandListItem, listBrands, normalizeSite, startCampaign } from "./api";
import { Baker } from "./engine/baker";
import { easeInOutCubic, Stage } from "./engine/stage";
import { pixelFont } from "./fonts";
import { CampScene } from "./scenes/camp";
import { LandingScene, OPEN_SECONDS } from "./scenes/landing";
import { Camp } from "./camp/Camp";
import { useReducedMotion } from "./hooks";
import styles from "./troy.module.css";

type View = "landing" | "camp";
type Phase = "loading" | "idle" | "submitting" | "opening" | "marching";

export function TroyExperience({ initialView, brandId: initialBrandId, cost }: { initialView: View; brandId?: string; cost?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const formAnchorRef = useRef<HTMLDivElement>(null);
  const engine = useRef<{ stage: Stage; baker: Baker; landing: LandingScene; camp: CampScene } | null>(null);
  const [view, setView] = useState<View>(initialView);
  const [brandId, setBrandId] = useState<string | undefined>(initialBrandId);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState("");
  const [shakeKey, setShakeKey] = useState(0);
  const [brands, setBrands] = useState<BrandListItem[] | null>(null);
  const [arrived, setArrived] = useState(initialView === "camp");
  // Children anchor HTML to the world, so they mount only once the engine exists.
  const [engineReady, setEngineReady] = useState(false);
  const pathname = usePathname();
  const reducedMotion = useReducedMotion();

  // The camp lives under the same canvas: these pages are full-bleed and ignore any app chrome.
  useInertSiblings(rootRef);

  // --- Engine lifecycle -------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const baker = new Baker();
    const stage = new Stage(canvas, baker);
    const landing = new LandingScene(stage, {});
    const camp = new CampScene(stage, landing);
    engine.current = { stage, baker, landing, camp };
    stage.onResize = () => frame(engine.current, viewRef.current, false);
    if (initialView === "camp") {
      landing.openNow();
      camp.show(true);
    }
    frame(engine.current, initialView, false);
    stage.start();
    setEngineReady(true);

    let alive = true;
    landing.island.reveal = 0;
    landing.body.reveal = 0;
    void landing.ready(baker).then(() => {
      if (!alive) return;
      // The horse appears grain by grain, like the island's rim.
      const start = performance.now();
      const grow = () => {
        if (!alive) return;
        const t = Math.min(1, (performance.now() - start) / 900);
        landing.island.reveal = t;
        landing.body.reveal = Math.min(1, t * 1.25);
        if (t < 1) requestAnimationFrame(grow);
      };
      requestAnimationFrame(grow);
      setPhase((p) => (p === "loading" ? "idle" : p));
    });
    void landing.preload(baker).catch(() => undefined);
    return () => {
      alive = false;
      stage.dispose();
      baker.dispose();
      engine.current = null;
      setEngineReady(false);
    };
    // The engine is created once per mount; view changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const viewRef = useRef(view);
  viewRef.current = view;
  // The opening runs on timers; Back or leaving the page must stop them.
  const cancelMarch = useRef<() => void>(() => undefined);
  useEffect(() => () => cancelMarch.current(), []);

  // Back/forward between "/" and "/camp/…" without remounting.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    if (pathname === "/" && viewRef.current === "camp") {
      cancelMarch.current();
      setView("landing");
      setArrived(false);
      setPhase("idle");
      e.landing.reset();
      e.camp.show(false);
      frame(e, "landing", true);
    } else if (pathname?.startsWith("/camp/") && viewRef.current === "landing") {
      const id = decodeURIComponent(pathname.split("/")[2] ?? "");
      if (id) {
        setBrandId(id);
        setView("camp");
        setArrived(true);
        e.landing.openNow();
        e.camp.show(true);
        frame(e, "camp", true);
      }
    }
  }, [pathname]);

  // Keep the form glued under the island.
  useLayoutEffect(() => {
    const e = engine.current;
    const el = formAnchorRef.current;
    if (!e || !el) return;
    return e.stage.anchor(el, () => ({ x: FORM_AT, y: FORM_AT, z: 0 }));
  }, [engineReady, view]);

  // Returning visitors: their camps, from the core's brand list.
  useEffect(() => {
    let alive = true;
    listBrands()
      .then((list) => alive && setBrands(list))
      .catch(() => alive && setBrands(null));
    return () => {
      alive = false;
    };
  }, []);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const e = engine.current;
      if (!e || phase === "submitting" || phase === "opening" || phase === "marching") return;
      const checked = normalizeSite(site);
      if ("error" in checked) {
        setError(checked.error);
        setShakeKey((k) => k + 1);
        e.landing.rattle();
        return;
      }
      setError(null);
      setPhase("submitting");
      e.landing.rattle();
      const knocking = setInterval(() => e.landing.rattle(), 650);
      try {
        const result = await startCampaign(site);
        clearInterval(knocking);
        setBrandId(result.brandId);
        setPhase("opening");
        cancelMarch.current();
        cancelMarch.current = march(e, result.brandId, reducedMotion, () => {
          setView("camp");
          setPhase("marching");
          window.history.pushState(null, "", `/camp/${encodeURIComponent(result.brandId)}`);
        }, () => setArrived(true));
      } catch (err) {
        clearInterval(knocking);
        setPhase("idle");
        setError(err instanceof ApiFailure && err.status === 404 ? "Nomen's API isn't running here yet. Start the app with the core track merged." : err instanceof Error ? err.message : String(err));
        setShakeKey((k) => k + 1);
      }
    },
    [phase, site, reducedMotion],
  );

  const busy = phase === "submitting";
  const formGone = phase === "opening" || phase === "marching" || view === "camp";

  return (
    <div ref={rootRef} className={`${styles.root} ${pixelFont.variable}`}>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />

      {view === "landing" && (
        <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-5 px-5 py-4 sm:px-8 sm:py-6">
          <span className={`${styles.pixel} pointer-events-auto mr-auto text-[22px] font-semibold tracking-tight`}>Nomen</span>
          {brands && brands.length > 0 && <BrandsMenu brands={brands} />}
          <a href="/settings" className={`${styles.link} ${styles.pixel} pointer-events-auto text-[15px]`}>
            Settings
          </a>
        </header>
      )}

      {view === "landing" && engineReady && (
        <div ref={formAnchorRef} className="pointer-events-none absolute left-0 top-0 will-change-transform">
          <form
            key={shakeKey}
            onSubmit={submit}
            className={`pointer-events-auto -translate-x-1/2 ${formGone ? styles.leave : styles.enter} ${shakeKey ? styles.shake : ""}`}
            style={{ width: "min(440px, calc(100vw - 32px))" }}
            aria-label="Start a campaign"
          >
            <label htmlFor="troy-site" className={`${styles.pixel} mb-3 block text-center text-[15px] text-[var(--ink-soft)]`}>
              What&apos;s your company&apos;s website?
            </label>
            <div className={`${styles.box} flex items-center gap-2 py-1.5 pl-4 pr-1.5`}>
              <input
                id="troy-site"
                name="site"
                value={site}
                onChange={(event) => {
                  setSite(event.target.value);
                  if (error) setError(null);
                }}
                placeholder="yourcompany.com"
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                disabled={busy || formGone}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "troy-site-error" : "troy-site-hint"}
                className={`${styles.input} ${styles.pixel} h-11 flex-1 text-[19px]`}
              />
              <button type="submit" disabled={busy || formGone} className={`${styles.button} ${styles.pixel} h-10 shrink-0 px-4 text-[15px]`}>
                {busy ? (
                  <>
                    <span className={styles.spinner} aria-hidden="true" /> Knocking
                  </>
                ) : (
                  <>
                    <span className="hidden min-[420px]:inline">Open the gates</span>
                    <span className="min-[420px]:hidden">Open</span> <span aria-hidden="true">→</span>
                  </>
                )}
              </button>
            </div>
            <p id="troy-site-hint" className="mt-4 text-center text-[13px] leading-relaxed text-[var(--ink-soft)]">
              Inside: an army of agents that researches your market, writes the strategy, films the ads and posts them.
              {cost && <span className="mt-1 block text-[12px] text-[var(--ink-faint)]">Each campaign: {cost}.</span>}
              <a href="/camp/demo" className={`${styles.link} ${styles.pixel} mt-2 inline-block text-[13px] underline decoration-dotted underline-offset-4`}>
                Or watch a demo camp →
              </a>
            </p>
            <p id="troy-site-error" role="alert" className="mt-2 min-h-5 text-center text-[13px] font-medium text-[var(--crimson)]">
              {error}
            </p>
          </form>
        </div>
      )}

      {engineReady && view === "camp" && brandId && <Camp brandId={brandId} arrived={arrived} engine={engine} />}

      <p className="sr-only" aria-live="polite">
        {phase === "opening" ? "The gates are opening. Your agents are on their way." : ""}
      </p>
    </div>
  );
}

/** Frames the camera for a view: the horse with room for the form, or the camp. */
function frame(e: { stage: Stage; camp: CampScene } | null, view: View, animate: boolean) {
  if (!e) return;
  const target = view === "camp" ? e.camp.camera() : landingCamera(e.stage);
  e.stage.look(target, animate ? 1.6 : 0, easeInOutCubic);
}

/** The form sits this far below the horse (art px on screen), over the island's dissolving rim. */
const FORM_AT = 64;

export function landingCamera(stage: Stage) {
  const { width, height } = stage.size;
  const formHeight = 232;
  const top = -150; // the horse's ears
  const bottom = FORM_AT;
  // On phones the island's rim may run off the sides; the horse itself must fit.
  const halfWidth = width < 640 ? 94 : 170;
  const fit = Math.min((height - formHeight - 40) / (bottom - top), (width - 24) / (halfWidth * 2), 3.5);
  const zoom = stage.fitZoom(fit);
  const total = (bottom - top) * zoom + formHeight;
  const topPx = Math.max(20, (height - total) / 2);
  return { x: 0, y: top - (topPx - height / 2) / zoom, zoom };
}

/** Doors, plank, the column of soldiers and the walk to the camp. Returns a cancel function. */
function march(e: { stage: Stage; landing: LandingScene; camp: CampScene }, brandId: string, reduced: boolean, toCamp: () => void, arrived: () => void) {
  const { stage, landing, camp } = e;
  camp.prepare(brandId);
  landing.destination = (index) => camp.marchRoute(index);
  if (reduced) {
    landing.openNow();
    camp.show(true);
    toCamp();
    stage.look(camp.camera(), 0);
    arrived();
    return () => undefined;
  }
  landing.open();
  const timers = [
    setTimeout(() => landing.startStream(), OPEN_SECONDS * 1000 - 150),
    // Follow the column down to the camp once a few soldiers are out.
    setTimeout(() => {
      toCamp();
      camp.show(true);
      stage.look(camp.camera(), 3.2, easeInOutCubic, arrived);
    }, OPEN_SECONDS * 1000 + 2300),
    setTimeout(() => landing.stopStream(), OPEN_SECONDS * 1000 + 9000),
  ];
  return () => timers.forEach(clearTimeout);
}

function BrandsMenu({ brands }: { brands: BrandListItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${styles.link} ${styles.pixel} text-[15px]`}>
        Your camps ({brands.length}) {open ? "▴" : "▾"}
      </button>
      {open && (
        <ul className={`${styles.boxSoft} absolute right-0 top-9 z-10 max-h-[60vh] w-72 overflow-y-auto py-2 text-sm`}>
          {brands.map((brand) => (
            <li key={brand.id}>
              <a href={`/camp/${encodeURIComponent(brand.id)}`} className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-[var(--sand)]/40">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{brand.name}</span>
                  <span className="block truncate text-xs text-[var(--ink-soft)]">{brand.domain}</span>
                </span>
                <span className={`${styles.pixel} shrink-0 text-xs text-[var(--ink-soft)]`}>{brand.campaign ? stageWord(brand.campaign.stage, brand.campaign.status) : "idle"}</span>
              </a>
            </li>
          ))}
          <li className="mt-1 border-t-2 border-[rgba(43,29,20,0.1)] px-4 pt-2">
            <a href="/brands" className={`${styles.link} ${styles.pixel} text-[13px]`}>
              All brands and workspaces →
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}

export function stageWord(stage: string, status: string) {
  if (status === "failed") return "needs you";
  if (status === "review") return "review";
  if (status === "live") return "live";
  if (status === "publishing") return "posting";
  return { research: "scouting", style: "studying", strategy: "planning", production: "filming", review: "review", live: "live" }[stage] ?? stage;
}


/**
 * These pages cover the whole window. If an app layout renders chrome around them (a header),
 * make it inert while they are open so keyboard focus can't wander into what is hidden.
 */
function useInertSiblings(rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const touched: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && !child.contains(root) && !child.hasAttribute("inert") && child.tagName !== "SCRIPT" && !child.tagName.includes("-")) {
        child.setAttribute("inert", "");
        touched.push(child);
      }
    }
    return () => touched.forEach((el) => el.removeAttribute("inert"));
  }, [rootRef]);
}
