// GET /api/brands/:id/brandkit/file?asset=<id>   one brand kit file (thumbnails, previews, fonts).
// Only files the kit lists are served, looked up by id; with Range support so videos can seek.
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { BrandKitError, assetPath, contentTypeOf, requireBrand } from "@/lib/creative/brandkit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "Not found." }, { status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    requireBrand(id);
  } catch (error) {
    if (error instanceof BrandKitError) return notFound();
    throw error;
  }
  const path = assetPath(id, new URL(request.url).searchParams.get("asset") ?? "");
  if (!path) return notFound();
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return notFound();
  }
  const headers: Record<string, string> = {
    "content-type": contentTypeOf(path),
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    // An uploaded SVG opened on its own must not run script in the app's origin.
    "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  };
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    // "bytes=100-" (from), "bytes=100-199" (span) or "bytes=-500" (the last 500)
    const suffix = !range[1];
    const start = suffix ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = suffix || !range[2] ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
}
