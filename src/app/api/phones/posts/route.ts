// OWNED BY THE PHONES TRACK. "Post through phone", for the camp:
// GET /api/phones/posts?brandId=… : whether it can run, what one post costs, and the brand's phone posts.
// POST /api/phones/posts { creativeId }: post one finished, approved video on TikTok through the brand's phone.
import { readJson, respond } from "@/lib/phones/respond";
import { phonePosts, postThroughPhone } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return respond(() => phonePosts(new URL(request.url).searchParams.get("brandId")));
}

export function POST(request: Request) {
  return respond(async () => postThroughPhone(await readJson(request)));
}
