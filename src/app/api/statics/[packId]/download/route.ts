import { handle } from "@/lib/api";
import { buildPackZip } from "@/lib/statics/pack";

export const runtime = "nodejs";

/** The ready-to-upload pack: approved ads if any are approved, otherwise every ready one. */
export async function GET(_request: Request, { params }: { params: Promise<{ packId: string }> }) {
  return handle(async () => {
    const { name, bytes } = await buildPackZip((await params).packId);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"`, "content-length": String(bytes.length), "cache-control": "no-store" },
    });
  });
}
