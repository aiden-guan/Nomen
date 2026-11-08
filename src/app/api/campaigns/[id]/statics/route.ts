import { body, handle } from "@/lib/api";
import { getCampaign } from "@/lib/pipeline";
import { startStaticPack } from "@/lib/statics/pipeline";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

/** Starts a static ad pack from the campaign's existing research. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    const campaign = getCampaign(id);
    if (!campaign) return Response.json({ error: "No such campaign" }, { status: 404 });
    const { concepts } = await body<{ concepts: number }>(request);
    const packId = startStaticPack(id, { concepts: Number.isFinite(Number(concepts)) ? Number(concepts) : undefined });
    void tick();
    return Response.json({ packId }, { status: 201 });
  });
}
