import { body, handle } from "@/lib/api";
import { getPack, retryPack, stopPack } from "@/lib/statics/pipeline";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ packId: string }> }) {
  return handle(async () => {
    const id = (await params).packId;
    if (!getPack(id)) return Response.json({ error: "No such pack" }, { status: 404 });
    const { action } = await body<{ action: "retry" | "stop" }>(request);
    if (action === "retry") retryPack(id);
    else if (action === "stop") stopPack(id);
    else return Response.json({ error: "Unknown action" }, { status: 400 });
    void tick();
    return Response.json({ ok: true });
  });
}
