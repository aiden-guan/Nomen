import { body, handle } from "@/lib/api";
import { getBrand } from "@/lib/pipeline";
import { connectedAccounts, connectLink } from "@/lib/publish";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!(await getBrand(id))) return Response.json({ error: "No such brand" }, { status: 404 });
    try {
      return Response.json({ accounts: await connectedAccounts(id) });
    } catch (error) {
      return Response.json({ accounts: [], error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** Returns the hosted page where the brand's owner connects its accounts. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!(await getBrand(id))) return Response.json({ error: "No such brand" }, { status: 404 });
    const { returnTo } = await body<{ returnTo: string }>(request);
    const valid = typeof returnTo === "string" && /^https?:\/\//.test(returnTo) ? returnTo : undefined;
    return Response.json({ url: await connectLink(id, valid) });
  });
}
