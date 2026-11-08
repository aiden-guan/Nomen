import { after } from "next/server";
import { body, handle } from "@/lib/api";
import { getCampaign, retryCampaign, stopCampaign } from "@/lib/pipeline";
import { approveAll, publishCampaign } from "@/lib/publish";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!(await getCampaign(id))) return Response.json({ error: "No such campaign" }, { status: 404 });
    const { action, mode } = await body<{ action: "retry" | "stop" | "approve_all" | "publish"; mode: "now" | "daily" }>(request);
    if (action === "retry") await retryCampaign(id);
    else if (action === "stop") await stopCampaign(id);
    else if (action === "approve_all") await approveAll(id);
    else if (action === "publish") return Response.json(await publishCampaign(id, mode === "now" ? "now" : "daily"));
    else return Response.json({ error: "Unknown action" }, { status: 400 });
    after(tick);
    return Response.json({ ok: true });
  });
}
