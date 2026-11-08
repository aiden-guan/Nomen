import { after } from "next/server";
import { body, handle } from "@/lib/api";
import { getPack, retryPack, stopPack } from "@/lib/statics/pipeline";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ packId: string }> }) {
  return handle(async () => {
    const id = (await params).packId;
    if (!getPack(id)) return Response.json({ error: "No such pack" }, { status: 404 });
    const { action } = await body<{ action: "retry" | "stop" }>(request);
    if (action === "retry") await retryPack(id);
    else if (action === "stop") await stopPack(id);
    else return Response.json({ error: "Unknown action" }, { status: 400 });
    after(tick);
    return Response.json({ ok: true });
  });
}
