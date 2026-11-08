import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packDir } from "@/lib/statics/pipeline";

export const runtime = "nodejs";

const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

/** Serves a pack's rendered ads, logos and screenshot from local storage. */
export async function GET(_request: Request, { params }: { params: Promise<{ packId: string; path: string[] }> }) {
  const { packId, path } = await params;
  const ext = path[path.length - 1]?.split(".").pop()?.toLowerCase() ?? "";
  if (!/^spk_[a-z0-9]+$/.test(packId) || path.length > 2 || !path.every((part) => /^[a-z0-9_][a-z0-9_.-]*$/i.test(part) && !part.includes("..")) || !TYPES[ext]) {
    return new Response("Not found", { status: 404 });
  }
  const file = join(packDir(packId), ...path);
  if (!existsSync(file)) return new Response("Not found", { status: 404 });
  const bytes = readFileSync(file);
  return new Response(new Uint8Array(bytes), { headers: { "content-type": TYPES[ext], "content-length": String(bytes.length), "cache-control": "private, max-age=300" } });
}
