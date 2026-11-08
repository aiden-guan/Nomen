import { body, handle } from "@/lib/api";
import { editStaticAd, getStaticAd, regenerateStaticAd, setStaticApproved } from "@/lib/statics/pipeline";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

/** Approve or unapprove an ad, or change its on-image copy (it is re-rendered on the same picture). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!getStaticAd(id)) return Response.json({ error: "No such ad" }, { status: 404 });
    const { approved, headline, subhead, cta, eyebrow } = await body<{ approved: boolean; headline: string; subhead: string; cta: string; eyebrow: string }>(request);
    if (typeof approved === "boolean") setStaticApproved(id, approved);
    if ([headline, subhead, cta, eyebrow].some((value) => typeof value === "string")) {
      editStaticAd(id, { headline, subhead, cta, eyebrow });
      void tick();
    }
    return Response.json({ ok: true });
  });
}

/** Make this ad again, optionally steered by a note. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!getStaticAd(id)) return Response.json({ error: "No such ad" }, { status: 404 });
    const { note } = await body<{ note: string }>(request);
    const newId = regenerateStaticAd(id, typeof note === "string" ? note.slice(0, 400) : undefined);
    void tick();
    return Response.json({ id: newId }, { status: 201 });
  });
}
