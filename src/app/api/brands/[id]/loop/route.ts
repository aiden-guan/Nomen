import { body, handle } from "@/lib/api";
import { type LoopPatch, loopView, updateLoop } from "@/lib/loop";
import { getBrand } from "@/lib/pipeline";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The brand's autopilot: its settings, what it will do next and why, and this week's spend. */
export async function GET(_request: Request, { params }: Context) {
  return handle(async () => {
    const id = (await params).id;
    if (!(await getBrand(id))) return Response.json({ error: "No such brand" }, { status: 404 });
    return Response.json(await loopView(id));
  });
}

/** Changes the brand's autopilot. Turning it on needs a weekly budget first. */
export async function POST(request: Request, { params }: Context) {
  return handle(async () => {
    const id = (await params).id;
    if (!(await getBrand(id))) return Response.json({ error: "No such brand" }, { status: 404 });
    await updateLoop(id, await body<LoopPatch>(request));
    return Response.json(await loopView(id));
  });
}
