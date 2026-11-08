"use client";

// The brand kit's intake, shared by the brand page's panel (BrandKitPanel) and the Troy camp's
// supply wagon (troy/camp/BrandKitDrawer): reading dropped files and folders, uploading them in
// batches with progress, removing assets and scanning a repo. No markup here.
import { useCallback, useEffect, useState, type DragEvent } from "react";
import type { BrandAsset, BrandKit } from "@/lib/creative/types";

export type Skipped = { name: string; reason: string };
export type KitView = BrandKit & { captioning: boolean; added?: string[]; skipped?: Skipped[] };
export type Picked = { file: File; path: string };
export type Progress = { total: number; loaded: number; files: number; sent: number };
export type Notice = { added: number; skipped: Skipped[]; unsupported: number };

// Mirrors the server's limits (src/lib/creative/brandkit.ts); the server enforces them.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ASSETS = 60;
export const EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "mp4", "mov", "webm", "m4v", "ttf", "otf", "woff", "woff2", "pdf", "md", "markdown"];
export const ACCEPT = EXTENSIONS.map((ext) => `.${ext}`).join(",");
const SKIP_FOLDERS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "vendor", "coverage", "__MACOSX"]);
/** Files a dropped folder is walked for at most (most of a code folder is skipped by type anyway). */
const MAX_WALK = 2000;
const BATCH_FILES = 12;
const BATCH_BYTES = 24 * 1024 * 1024;

export const KIND_ORDER: BrandAsset["kind"][] = ["logo", "icon", "screenshot", "image", "video", "font", "doc"];
export const KIND_LABEL: Record<BrandAsset["kind"], string> = { logo: "Logo", icon: "Icon", screenshot: "Screenshot", image: "Image", video: "Video", font: "Font", doc: "Doc" };

export const extOf = (name: string) => {
  const base = name.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};
export const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const kitBase = (brandId: string) => `/api/brands/${encodeURIComponent(brandId)}/brandkit`;

export async function kitApi(url: string, init?: RequestInit): Promise<KitView> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as KitView & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
  return body;
}

/** One multipart POST; XHR rather than fetch for upload progress. */
export function uploadBatch(url: string, batch: Picked[], onProgress: (loaded: number) => void): Promise<KitView> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const { file, path } of batch) form.append("files", file, path);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as KitView & { error?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error ?? `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed: the connection dropped."));
    xhr.send(form);
  });
}

/** Up to 12 files and ~24 MB per request; a bigger single file goes on its own. */
export function toBatches(files: Picked[]): Picked[][] {
  const batches: Picked[][] = [];
  let current: Picked[] = [];
  let bytes = 0;
  for (const item of files) {
    if (current.length && (current.length >= BATCH_FILES || bytes + item.file.size > BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Walks dropped files and folders. Entries must be read synchronously, inside the drop event. */
export function readDrop(event: DragEvent): Promise<Picked[]> {
  const entries: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(event.dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  if (!entries.length && !loose.length) loose.push(...Array.from(event.dataTransfer.files));
  return (async () => {
    const out: Picked[] = loose.map((file) => ({ file, path: file.name }));
    const budget = { n: out.length };
    for (const entry of entries) await walkEntry(entry, out, budget);
    return out;
  })();
}

async function walkEntry(entry: FileSystemEntry, out: Picked[], budget: { n: number }): Promise<void> {
  if (budget.n >= MAX_WALK || entry.name.startsWith(".")) return;
  if (entry.isFile) {
    budget.n++;
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)).catch(() => null);
    if (file) out.push({ file, path: entry.fullPath.replace(/^\/+/, "") || file.name });
    return;
  }
  if (!entry.isDirectory || SKIP_FOLDERS.has(entry.name)) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries answers in chunks (about 100 at a time) until it returns an empty list
  for (;;) {
    const chunk = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)).catch(() => [] as FileSystemEntry[]);
    if (!chunk.length) return;
    for (const child of chunk) await walkEntry(child, out, budget);
  }
}

/** Files from an <input type="file"> (a folder picker gives each file its relative path). */
export const pickedFrom = (files: FileList | null): Picked[] =>
  Array.from(files ?? [])
    .filter((file) => !file.name.startsWith("."))
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));

/**
 * One brand's kit with everything a panel does to it: load (and poll while images are being
 * described), upload with progress, remove an asset, scan or forget a repo.
 */
export function useBrandKit(brandId: string) {
  const base = kitBase(brandId);
  const [kit, setKit] = useState<KitView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setKit(await kitApi(base));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Captions are written in the background after an upload or scan: poll until they land.
  const captioning = Boolean(kit?.captioning);
  useEffect(() => {
    if (!captioning) return;
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [captioning, refresh]);

  const uploading = progress !== null;

  async function upload(picked: Picked[]) {
    if (uploading || !picked.length) return;
    setActionError(null);
    const skipped: Skipped[] = [];
    let unsupported = 0;
    const ready: Picked[] = [];
    const room = Math.max(0, MAX_ASSETS - (kit?.assets.length ?? 0));
    for (const item of picked) {
      if (!EXTENSIONS.includes(extOf(item.path))) unsupported++;
      else if (item.file.size > MAX_FILE_BYTES) skipped.push({ name: item.path, reason: `too big (${size(item.file.size)}; the limit is 25 MB)` });
      else if (item.file.size === 0) skipped.push({ name: item.path, reason: "empty file" });
      else if (ready.length >= room) skipped.push({ name: item.path, reason: `not sent: the kit holds ${MAX_ASSETS} files` });
      else ready.push(item);
    }
    let added = 0;
    if (ready.length) {
      const total = ready.reduce((sum, item) => sum + item.file.size, 0);
      let done = 0;
      setProgress({ total, loaded: 0, files: ready.length, sent: 0 });
      try {
        for (const batch of toBatches(ready)) {
          const batchBytes = batch.reduce((sum, item) => sum + item.file.size, 0);
          const next = await uploadBatch(base, batch, (loaded) => setProgress((p) => p && { ...p, loaded: done + Math.min(loaded, batchBytes) }));
          done += batchBytes;
          added += next.added?.length ?? 0;
          skipped.push(...(next.skipped ?? []));
          setKit(next);
          setProgress((p) => p && { ...p, loaded: done, sent: p.sent + batch.length });
        }
      } catch (error) {
        setActionError(errorText(error));
      } finally {
        setProgress(null);
      }
    }
    setNotice({ added, skipped, unsupported });
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    if (uploading) return;
    void readDrop(event).then(upload, (error) => setActionError(errorText(error)));
  }

  async function remove(asset: BrandAsset) {
    setRemoving(asset.id);
    setActionError(null);
    try {
      setKit(await kitApi(`${base}?asset=${encodeURIComponent(asset.id)}`, { method: "DELETE" }));
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setRemoving(null);
    }
  }

  /** Reads a public GitHub/GitLab repo or a local folder (read-only; can take a minute or two). */
  const scanRepo = (source: string) => kitApi(`${base}/repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) }).then(setKit);
  const forgetRepo = () => kitApi(`${base}/repo`, { method: "DELETE" }).then(setKit);

  return { base, kit, setKit, loadError, actionError, progress, notice, setNotice, removing, captioning, uploading, refresh, upload, drop, remove, scanRepo, forgetRepo };
}
