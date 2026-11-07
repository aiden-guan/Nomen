import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mediaDir } from "@/lib/media";

export const runtime = "nodejs";

/** Serves a finished video from local storage, with Range support so the player can seek. */
export async function GET(request: Request, { params }: { params: Promise<{ creativeId: string; name: string }> }) {
  const { creativeId, name } = await params;
  if (!/^crv_[a-z0-9]+$/.test(creativeId) || !/^((final|shot\d+-r\d+)\.mp4|shot\d+-frame\.png)$/.test(name)) return new Response("Not found", { status: 404 });
  const path = join(mediaDir(creativeId), name);
  if (!existsSync(path)) return new Response("Not found", { status: 404 });
  const size = statSync(path).size;
  const range = request.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  const headers: Record<string, string> = { "content-type": name.endsWith(".png") ? "image/png" : "video/mp4", "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
}
