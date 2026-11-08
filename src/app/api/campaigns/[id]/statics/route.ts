import { after } from "next/server";
import { body, handle } from "@/lib/api";
import { getCampaign } from "@/lib/pipeline";
import { startStaticPack, staticsAvailable } from "@/lib/statics/pipeline";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

/** Starts a static ad pack from the campaign's existing research. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!staticsAvailable()) return Response.json({ error: "Static ads aren't available on this deployment yet: they still keep their data on the local disk." }, { status: 400 });
    const campaign = await getCampaign(id);
    if (!campaign) return Response.json({ error: "No such campaign" }, { status: 404 });
    const { concepts } = await body<{ concepts: number }>(request);
    const packId = await startStaticPack(id, { concepts: Number.isFinite(Number(concepts)) ? Number(concepts) : undefined });
    after(tick);
    return Response.json({ packId }, { status: 201 });
  });
}
