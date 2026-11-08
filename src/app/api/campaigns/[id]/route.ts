import { after } from "next/server";
import { body, handle } from "@/lib/api";
import { getCampaign, retryCampaign, stopCampaign } from "@/lib/pipeline";
import { approveAll, type PublishChoice, publishCampaign, VISIBILITIES, type Visibility } from "@/lib/publish";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

type Payload = { action: "retry" | "stop" | "approve_all" | "publish"; mode: "now" | "daily"; creativeIds: unknown; platforms: unknown; visibility: unknown };

const strings = (value: unknown) => (Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!(await getCampaign(id))) return Response.json({ error: "No such campaign" }, { status: 404 });
    const { action, mode, creativeIds, platforms, visibility } = await body<Payload>(request);
    if (action === "retry") await retryCampaign(id);
    else if (action === "stop") await stopCampaign(id);
    else if (action === "approve_all") await approveAll(id);
    else if (action === "publish") {
      // Optional: only these videos, only these connected networks, or a visibility (YouTube only).
      if (visibility !== undefined && !VISIBILITIES.includes(visibility as Visibility)) return Response.json({ error: `visibility is one of ${VISIBILITIES.join(", ")}` }, { status: 400 });
      const choice: PublishChoice = { creativeIds: strings(creativeIds), platforms: strings(platforms), visibility: visibility as Visibility | undefined };
      return Response.json(await publishCampaign(id, mode === "now" ? "now" : "daily", choice));
    } else return Response.json({ error: "Unknown action" }, { status: 400 });
    after(tick);
    return Response.json({ ok: true });
  });
}
