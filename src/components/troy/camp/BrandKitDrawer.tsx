"use client";

import { type ChangeEvent, type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { ACCEPT, KIND_LABEL, KIND_ORDER, MAX_ASSETS, pickedFrom, size, useBrandKit } from "@/components/brandkit/intake";
import type { BrandAsset } from "@/lib/creative/types";
import styles from "../troy.module.css";

// The brand kit in the camp: the supplies the agents carry into the videos. Drop the brand's logo,
// product screens, demo clips and fonts (files or a whole folder), or link its code, and the oracle
// reads them with the product, the writers quote the real commands and UI, and the screen builder
// draws in the brand's look. Same API as the workspace's Brand kit tab (src/app/api/brands/[id]/brandkit).

export function BrandKitDrawer({ brandId, brandName, stage, wide, onClose }: { brandId: string; brandName: string; stage: string | null; wide: boolean; onClose: () => void }) {
  const kitState = useBrandKit(brandId);
  const { base, kit, loadError, actionError, progress, notice, setNotice, removing, captioning, uploading, upload, drop, remove } = kitState;
  const [dragging, setDragging] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    // React has no prop for it: the folder picker needs the non-standard webkitdirectory attribute.
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    drop(event);
  };
  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = pickedFrom(event.target.files);
    event.target.value = "";
    void upload(picked);
  };

  const count = kit?.assets.length ?? 0;
  const assets = [...(kit?.assets ?? [])].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const percent = progress ? Math.round((progress.loaded / Math.max(progress.total, 1)) * 100) : 0;
  // The product brief reads the kit at the start of the reference study; production reads it for screens.
  const timing =
    stage === "research"
      ? "In time: the oracle reads the kit when it starts studying your product, right after the scouts."
      : stage === "style"
        ? "The oracle is studying your product now; what you add here still goes into the product screens."
        : stage === "strategy" || stage === "production"
          ? "This campaign's product study is done. The screen builder still uses the kit for videos in production, and the next campaign reads all of it."
          : "The next campaign reads it from the start.";

  return (
    <aside aria-label="Brand kit" className={`${styles.box} ${styles.enter} absolute z-20 flex flex-col ${wide ? "bottom-4 right-4 top-[76px] w-[420px]" : "inset-x-3 bottom-3 h-[64vh]"}`}>
      <header className="flex items-start gap-3 border-b-2 border-[rgba(43,29,20,0.12)] px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-[var(--ink-soft)]">
            Supplies · {count}/{MAX_ASSETS} files{captioning ? " · describing images" : ""}
          </p>
          <h2 ref={headingRef} tabIndex={-1} className={`${styles.pixel} mt-1 text-[24px] font-semibold leading-none outline-none`}>
            Brand kit
          </h2>
          <p className="mt-2 text-[13px] leading-snug text-[var(--ink-soft)]">{brandName}&apos;s real logo, product screens, demo clips and fonts, so the videos show the actual product instead of guessing at it.</p>
        </div>
        <button type="button" onClick={onClose} className={`${styles.link} ${styles.pixel} -mr-1 px-2 text-xl leading-none`} aria-label="Close">
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13px]">
        <p className="mb-4 bg-[rgba(201,143,58,0.12)] px-3 py-2 text-[12px] leading-snug">{timing}</p>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (!dragging) setDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
          className={`border-2 border-dashed px-4 py-6 text-center transition-colors ${dragging ? "border-[var(--crimson)] bg-[rgba(183,58,49,0.06)]" : "border-[rgba(43,29,20,0.25)] bg-[rgba(43,29,20,0.03)]"} ${uploading ? "pointer-events-none opacity-80" : ""}`}
        >
          {progress ? (
            <div className="space-y-2">
              <p className={`${styles.pixel} flex items-center justify-center gap-2`}>
                <span className={styles.spinner} aria-hidden="true" /> Loading the wagon: {progress.sent} of {progress.files} · {percent}%
              </p>
              <div className="h-2 bg-[rgba(43,29,20,0.1)]">
                <div className="h-full bg-[var(--crimson)] transition-all" style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : (
            <>
              <p className={`${styles.pixel} text-[15px]`}>Drop files or a whole folder</p>
              <p className="mt-1 text-[12px] leading-snug text-[var(--ink-soft)]">Logo (SVG or PNG), app icon, product screenshots, short demo clips, fonts, brand guidelines (PDF). Up to 25 MB each.</p>
              <div className="mt-3 flex justify-center gap-2">
                <button type="button" className={`${styles.button} ${styles.pixel} h-9 px-3 text-[13px]`} onClick={() => filesInput.current?.click()}>
                  Choose files
                </button>
                <button type="button" className={`${styles.button} ${styles.buttonQuiet} ${styles.pixel} h-9 px-3 text-[13px]`} onClick={() => folderInput.current?.click()}>
                  Choose folder
                </button>
              </div>
            </>
          )}
          <input ref={filesInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={onPick} />
          <input ref={folderInput} type="file" multiple className="hidden" onChange={onPick} />
        </div>

        {(actionError || loadError) && (
          <p role="alert" className="mt-3 bg-[rgba(183,58,49,0.08)] px-3 py-2 text-[12px] text-[var(--crimson-dark)]">
            {actionError ?? loadError}
          </p>
        )}
        {notice && (notice.added > 0 || notice.skipped.length > 0 || notice.unsupported > 0) && (
          <div className="mt-3 text-[12px] text-[var(--ink-soft)]">
            <p>
              {notice.added ? `Added ${notice.added} file${notice.added === 1 ? "" : "s"}.` : "No new files added."}
              {notice.unsupported > 0 && ` Skipped ${notice.unsupported} that aren't images, videos, fonts, PDFs or Markdown.`}{" "}
              <button type="button" className={`${styles.link} underline decoration-dotted underline-offset-4`} onClick={() => setNotice(null)}>
                ok
              </button>
            </p>
            {notice.skipped.slice(0, 6).map((item, i) => (
              <p key={`${item.name}-${i}`} className="truncate text-[var(--crimson-dark)]">
                {item.name}: {item.reason}
              </p>
            ))}
          </div>
        )}

        <Repo kitState={kitState} />

        <section className="mt-6">
          <h3 className={`${styles.pixel} mb-2.5 text-[12px] uppercase tracking-wider text-[var(--ink-faint)]`}>In the wagon · {count}</h3>
          {!kit ? (
            <p className={`${styles.pixel} flex items-center gap-2 text-[var(--ink-soft)]`}>
              <span className={styles.spinner} aria-hidden="true" /> Unloading
            </p>
          ) : assets.length === 0 ? (
            <p className="text-[var(--ink-soft)]">Nothing yet. Without a kit the videos can only use screenshots of your website.</p>
          ) : (
            <ul className="grid grid-cols-3 gap-2">
              {assets.map((asset) => (
                <Tile key={asset.id} asset={asset} src={`${base}/file?asset=${encodeURIComponent(asset.id)}`} captioning={captioning} removing={removing === asset.id} onRemove={() => void remove(asset)} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

function Repo({ kitState }: { kitState: ReturnType<typeof useBrandKit> }) {
  const { kit, scanRepo, forgetRepo } = kitState;
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<"scan" | "forget" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const repo = kit?.repo ?? null;

  useEffect(() => {
    if (busy !== "scan") return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const run = async (kind: "scan" | "forget", work: () => Promise<void>) => {
    setBusy(kind);
    setElapsed(0);
    setError(null);
    try {
      await work();
      if (kind === "scan") setSource("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (source.trim()) void run("scan", () => scanRepo(source.trim()));
  };

  return (
    <section className="mt-6">
      <h3 className={`${styles.pixel} mb-1 text-[12px] uppercase tracking-wider text-[var(--ink-faint)]`}>Or link your code</h3>
      <p className="text-[12px] leading-snug text-[var(--ink-soft)]">A public GitHub or GitLab link, or a folder on this machine. We read it for your logo, colors, fonts, commands, screens and UI text. It is only read: never installed, built or run.</p>
      <form className="mt-2 flex gap-2" onSubmit={submit}>
        <input
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="github.com/you/app"
          spellCheck={false}
          autoCapitalize="none"
          disabled={busy !== null}
          aria-label="Repository link or folder"
          className={`${styles.input} min-w-0 flex-1 border-2 border-[rgba(43,29,20,0.2)] bg-[var(--paper)] px-2 py-1.5 font-mono text-[12px]`}
        />
        <button type="submit" disabled={busy !== null || !source.trim()} className={`${styles.button} ${styles.buttonInk} ${styles.pixel} h-9 shrink-0 px-3 text-[13px]`}>
          {busy === "scan" ? <span className={styles.spinner} aria-hidden="true" /> : null} {repo ? "Scan again" : "Scan"}
        </button>
      </form>
      {busy === "scan" && <p className="mt-1.5 text-[12px] text-[var(--ink-soft)]">Reading the code… {elapsed} s. Cloning and scanning can take a minute or two.</p>}
      {error && <p className="mt-1.5 text-[12px] text-[var(--crimson-dark)]">{error}</p>}
      {repo && (
        <div className="mt-3 bg-[rgba(43,29,20,0.04)] px-3 py-2 text-[12px]">
          <p className="flex items-baseline gap-2">
            <span className="min-w-0 truncate font-semibold">{repo.name || "Your code"}</span>
            <span className="shrink-0 text-[var(--ink-faint)]">{repo.origin.replace(/^local:/, "folder ").replace(/^(github|gitlab):/, "$1 ")}</span>
            <button type="button" disabled={busy !== null} className={`${styles.link} ml-auto shrink-0 underline decoration-dotted underline-offset-4`} onClick={() => void run("forget", forgetRepo)}>
              {busy === "forget" ? "Forgetting…" : "Forget"}
            </button>
          </p>
          <p className="mt-0.5 text-[var(--ink-soft)]">
            {[`${repo.commands.length} commands`, `${repo.screens.length} screens`, `${repo.ui_strings.length} UI strings`, repo.fonts.length ? repo.fonts.slice(0, 3).join(", ") : null].filter(Boolean).join(" · ")}
          </p>
          {repo.colors.length > 0 && (
            <p className="mt-1.5 flex flex-wrap gap-1">
              {repo.colors.slice(0, 10).map((color) => (
                <span key={`${color.name}-${color.hex}`} title={`${color.name} ${color.hex}`} className="size-5 border border-[rgba(43,29,20,0.2)]" style={{ backgroundColor: color.hex }} />
              ))}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Tile({ asset, src, captioning, removing, onRemove }: { asset: BrandAsset; src: string; captioning: boolean; removing: boolean; onRemove: () => void }) {
  const name = asset.path.split(/[\\/]/).pop()?.replace(/^a\d+-/, "") ?? asset.id;
  return (
    <li className="group relative text-[11px]" title={`${name} · ${size(asset.bytes)}${asset.caption ? ` · ${asset.caption}` : ""}`}>
      <div className="grid aspect-square place-items-center overflow-hidden bg-[rgba(43,29,20,0.06)]">
        {asset.kind === "video" ? (
          <video src={src} muted playsInline preload="metadata" className="size-full object-cover" />
        ) : asset.kind === "font" || asset.kind === "doc" ? (
          <span className={`${styles.pixel} text-[14px] text-[var(--ink-soft)]`}>{asset.kind === "font" ? "Aa" : asset.path.toLowerCase().endsWith(".pdf") ? "PDF" : "MD"}</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={asset.caption} loading="lazy" className="max-h-full max-w-full object-contain p-1" />
        )}
      </div>
      <p className="mt-1 truncate">
        <span className={styles.pixel}>{KIND_LABEL[asset.kind]}</span> <span className="text-[var(--ink-faint)]">{asset.caption || (captioning ? "describing…" : name)}</span>
      </p>
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${name}`}
        className="absolute right-1 top-1 grid size-6 place-items-center bg-[rgba(43,29,20,0.75)] text-[12px] text-[var(--paper)] opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 disabled:opacity-100"
      >
        {removing ? <span className={styles.spinner} aria-hidden="true" /> : "×"}
      </button>
    </li>
  );
}
