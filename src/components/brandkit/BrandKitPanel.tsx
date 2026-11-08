"use client";

// The brand kit: the brand's real logo, product screens, demo clips and fonts (uploaded, or found in
// its code), so the video agents can show the actual product. The brand page renders
// <BrandKitPanel brandId brandName /> and nothing else, so the internals can change freely. The
// intake itself (drops, batches, progress) lives in ./intake, shared with the Troy camp.
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Badge, Button, Card, Empty, Spinner, cx } from "@/components/ui";
import type { BrandAsset } from "@/lib/creative/types";
import { ACCEPT, errorText, KIND_LABEL, KIND_ORDER, kitApi, type KitView, MAX_ASSETS, type Notice, pickedFrom, size, useBrandKit } from "./intake";

export type BrandKitPanelProps = { brandId: string; brandName: string };

const KIND_TONE: Record<BrandAsset["kind"], "accent" | "info" | "good" | "neutral" | "warn"> = {
  logo: "accent",
  icon: "info",
  screenshot: "good",
  image: "neutral",
  video: "warn",
  font: "neutral",
  doc: "neutral",
};

export function BrandKitPanel({ brandId, brandName }: BrandKitPanelProps) {
  const { base, kit, setKit, loadError, actionError, progress, notice, setNotice, removing, captioning, uploading, upload, drop, remove } = useBrandKit(brandId);
  const [dragging, setDragging] = useState(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // React has no prop for it: the folder picker needs the non-standard webkitdirectory attribute.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    setDragging(false);
    drop(event);
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = pickedFrom(event.target.files);
    event.target.value = "";
    void upload(picked);
  }

  const count = kit?.assets.length ?? 0;
  const header = (
    <span className="flex items-center gap-2">
      Brand kit
      <Badge tone={count ? "accent" : "neutral"}>
        {count}/{MAX_ASSETS} files
      </Badge>
      {captioning && (
        <Badge tone="info">
          <Spinner className="size-2.5" /> Describing images
        </Badge>
      )}
    </span>
  );
  const subtitle = `${brandName}'s real logo, product screens, demo clips and fonts, so the videos show the actual product instead of guessing at it.`;

  if (!kit) {
    return (
      <Card title={header} subtitle={subtitle}>
        {loadError ? <p className="text-sm text-rose-300">{loadError}</p> : <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> Loading…</div>}
      </Card>
    );
  }

  const assets = [...kit.assets].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const percent = progress ? Math.round((progress.loaded / Math.max(progress.total, 1)) * 100) : 0;

  return (
    <Card title={header} subtitle={subtitle}>
      <div className="space-y-6">
        {loadError && <p className="text-xs text-amber-300">Couldn&apos;t refresh: {loadError}</p>}

        {/* drop zone */}
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
          className={cx(
            "rounded-2xl border border-dashed px-6 py-8 text-center transition",
            dragging ? "border-violet-400/70 bg-violet-500/10" : "border-white/15 bg-white/[0.02]",
            uploading && "pointer-events-none opacity-80",
          )}
        >
          {progress ? (
            <div className="mx-auto max-w-sm space-y-3">
              <div className="flex items-center justify-center gap-2 text-sm text-zinc-200">
                <Spinner /> Uploading {progress.sent} of {progress.files} file{progress.files === 1 ? "" : "s"}… {percent}%
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all" style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm font-medium text-zinc-100">Drop files or a whole folder here</p>
              <p className="mx-auto mt-1 max-w-lg text-xs text-zinc-400">
                Your logo (SVG or PNG), app icon, product screenshots, short demo clips, fonts and brand guidelines (PDF). Up to 25 MB per file, {MAX_ASSETS} files in all.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => filesInput.current?.click()}>
                  Choose files
                </Button>
                <Button size="sm" variant="ghost" onClick={() => folderInput.current?.click()}>
                  Choose folder
                </Button>
              </div>
            </>
          )}
          <input ref={filesInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={onPick} />
          <input ref={folderInput} type="file" multiple className="hidden" onChange={onPick} />
        </div>

        {actionError && <p className="text-sm text-rose-300">{actionError}</p>}
        {notice && <UploadNotice notice={notice} onClose={() => setNotice(null)} />}

        <RepoSection base={base} kit={kit} onKit={setKit} />

        {/* assets */}
        <div>
          <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">Files</h3>
          {assets.length === 0 ? (
            <Empty title="Nothing here yet">Upload a logo and a few product screenshots, or link your code above. Without them the videos can only use screenshots of your website.</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {assets.map((asset) => (
                <AssetTile key={asset.id} asset={asset} src={`${base}/file?asset=${encodeURIComponent(asset.id)}`} captioning={captioning} removing={removing === asset.id} onRemove={() => void remove(asset)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function UploadNotice({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const { added, skipped, unsupported } = notice;
  if (!added && !skipped.length && !unsupported) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-zinc-200">
          {added ? `Added ${added} file${added === 1 ? "" : "s"}.` : "No new files added."}
          {unsupported > 0 && (
            <span className="text-zinc-400">
              {unsupported === 1 ? " Skipped 1 file that isn't an image, video, font, PDF or Markdown." : ` Skipped ${unsupported} files that aren't images, videos, fonts, PDFs or Markdown.`}
            </span>
          )}
        </p>
        <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300" aria-label="Dismiss">
          ✕
        </button>
      </div>
      {skipped.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
          {skipped.map((item, i) => (
            <li key={`${item.name}-${i}`} className="flex gap-2">
              <span className="truncate font-mono text-zinc-400">{item.name}</span>
              <span className="shrink-0 text-amber-300">{item.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RepoSection({ base, kit, onKit }: { base: string; kit: KitView; onKit: (kit: KitView) => void }) {
  const [source, setSource] = useState("");
  const [scanning, setScanning] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const repo = kit.repo;

  useEffect(() => {
    if (!scanning) return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [scanning]);

  async function scan() {
    if (!source.trim()) return;
    setScanning(true);
    setElapsed(0);
    setError(null);
    try {
      onKit(await kitApi(`${base}/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: source.trim() }) }));
      setSource("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setScanning(false);
    }
  }

  async function forget() {
    setForgetting(true);
    setError(null);
    try {
      onKit(await kitApi(`${base}/repo`, { method: "DELETE" }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setForgetting(false);
    }
  }

  const fromRepo = kit.assets.filter((asset) => asset.source.startsWith("repo:")).length;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-zinc-100">Link your code</h3>
          <p className="mt-0.5 max-w-xl text-xs text-zinc-400">
            A public GitHub or GitLab link, or a folder on this machine. We read it for your logo, colors, fonts, install commands, screens and real UI text, so generated screens look like your
            product. Your code is only read: never installed, built or run.
          </p>
        </div>
        {repo && (
          <Button size="sm" variant="ghost" loading={forgetting} disabled={scanning} onClick={() => void forget()}>
            Forget
          </Button>
        )}
      </div>

      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void scan();
        }}
      >
        <input
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="https://github.com/you/app  or  /Users/you/code/app"
          spellCheck={false}
          disabled={scanning}
          className="h-10 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
        />
        <Button type="submit" variant="primary" loading={scanning} disabled={!source.trim()}>
          {repo ? "Scan again" : "Scan"}
        </Button>
      </form>
      {scanning && <p className="mt-2 text-xs text-zinc-400">Reading the code… {elapsed} s. Cloning and scanning can take a minute or two.</p>}
      {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}

      {repo && (
        <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-zinc-100">{repo.name || "Your code"}</span>
            <Badge tone="neutral">{repo.origin.replace(/^local:/, "folder: ").replace(/^(github|gitlab):/, "$1: ")}</Badge>
            <span className="text-xs text-zinc-500">
              {fromRepo} file{fromRepo === 1 ? "" : "s"} · {repo.ui_strings.length} UI strings · scanned {new Date(repo.scanned_at).toLocaleString()}
            </span>
          </div>
          {repo.description && <p className="text-xs text-zinc-400">{repo.description}</p>}

          {repo.colors.length > 0 && (
            <Found label="Colors">
              <div className="flex flex-wrap gap-2">
                {repo.colors.map((color) => (
                  <div key={`${color.name}-${color.hex}`} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] py-1 pl-1 pr-2.5" title={`from ${color.source}`}>
                    <span className="size-6 rounded-md ring-1 ring-inset ring-white/15" style={{ backgroundColor: color.hex }} />
                    <span className="text-xs text-zinc-200">{color.name}</span>
                    <span className="font-mono text-[11px] text-zinc-500">{color.hex}</span>
                  </div>
                ))}
              </div>
            </Found>
          )}

          {repo.fonts.length > 0 && (
            <Found label="Fonts">
              <div className="flex flex-wrap gap-1.5">
                {repo.fonts.map((font) => (
                  <Badge key={font}>{font}</Badge>
                ))}
              </div>
            </Found>
          )}

          {repo.commands.length > 0 && (
            <Found label="Commands">
              <div className="space-y-1 rounded-xl border border-white/10 bg-black/40 p-3 font-mono text-xs text-emerald-200">
                {repo.commands.map((command) => (
                  <div key={command} className="truncate">
                    <span className="select-none text-zinc-600">$ </span>
                    {command}
                  </div>
                ))}
              </div>
            </Found>
          )}

          {repo.screens.length > 0 && (
            <Found label="Screens">
              <ul className="space-y-1 text-xs">
                {repo.screens.map((screen) => (
                  <li key={screen.route} className="flex gap-3">
                    <span className="w-32 shrink-0 truncate font-mono text-violet-300">{screen.route}</span>
                    <span className="truncate text-zinc-400">{screen.summary}</span>
                  </li>
                ))}
              </ul>
            </Found>
          )}

          {repo.components.length > 0 && (
            <Found label="Components">
              <div className="flex flex-wrap gap-1.5">
                {repo.components.map((component) => (
                  <span key={component.file} title={component.file} className="rounded-md bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                    {`<${component.name} />`}
                  </span>
                ))}
              </div>
            </Found>
          )}
        </div>
      )}
    </div>
  );
}

function Found({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      {children}
    </div>
  );
}

function AssetTile({ asset, src, captioning, removing, onRemove }: { asset: BrandAsset; src: string; captioning: boolean; removing: boolean; onRemove: () => void }) {
  const name = asset.path.split(/[\\/]/).pop()?.replace(/^a\d+-/, "") ?? asset.id;
  const where = asset.source.startsWith("repo:") ? `from code: ${asset.source.slice(5)}` : "uploaded";
  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
      <div className="flex aspect-video items-center justify-center overflow-hidden bg-[repeating-conic-gradient(#ffffff08_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
        <Preview asset={asset} src={src} />
      </div>
      <div className="space-y-1 p-2.5">
        <div className="flex items-center gap-1.5">
          <Badge tone={KIND_TONE[asset.kind]}>{KIND_LABEL[asset.kind]}</Badge>
          <span className="truncate text-[11px] text-zinc-500" title={name}>
            {name}
          </span>
        </div>
        <p className="line-clamp-2 min-h-8 text-xs text-zinc-300" title={asset.caption}>
          {asset.caption || (captioning ? "Describing…" : "No description yet")}
        </p>
        <p className="truncate text-[11px] text-zinc-600" title={where}>
          {[asset.width && asset.height ? `${asset.width}×${asset.height}` : "", size(asset.bytes), where].filter(Boolean).join(" · ")}
        </p>
      </div>
      <button
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${name}`}
        className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-lg bg-black/60 text-xs text-zinc-200 opacity-0 transition hover:bg-rose-500/80 focus:opacity-100 group-hover:opacity-100 disabled:opacity-100"
      >
        {removing ? <Spinner className="size-3" /> : "✕"}
      </button>
    </div>
  );
}

function Preview({ asset, src }: { asset: BrandAsset; src: string }) {
  if (asset.kind === "video") {
    return (
      <video
        src={src}
        muted
        playsInline
        loop
        preload="metadata"
        className="h-full w-full object-contain"
        onMouseEnter={(event) => void event.currentTarget.play().catch(() => undefined)}
        onMouseLeave={(event) => event.currentTarget.pause()}
      />
    );
  }
  if (asset.kind === "font") return <FontPreview id={asset.id} src={src} />;
  if (asset.kind === "doc") {
    return <span className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-xs text-zinc-300">{asset.path.toLowerCase().endsWith(".pdf") ? "PDF" : "MD"}</span>;
  }
  // eslint-disable-next-line @next/next/no-img-element -- served from our own API, sizes vary
  return <img src={src} alt={asset.caption} loading="lazy" className="max-h-full max-w-full object-contain p-2" />;
}

/** Loads the font file itself so the tile shows the real letterforms. */
function FontPreview({ id, src }: { id: string; src: string }) {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const name = `brandkit-${id}`;
    const face = new FontFace(name, `url("${src}")`);
    face
      .load()
      .then((loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setFamily(name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, src]);
  return (
    <span className="text-2xl text-zinc-100" style={family ? { fontFamily: `"${family}"` } : undefined}>
      Aa Bb 123
    </span>
  );
}
