import { vi } from "vitest";

// A fake of the parts of Naive's API that posting, the loop and the director use, behind a stubbed
// fetch, so the tests run the real client, worker and loop code with only the network faked.
// Shapes follow https://usenaive.ai/docs/api/social.md and /files.md. Naive's "busy" answer is
// the one it sends in practice: 429 rate_limited, "the service is at capacity".

export const NAIVE_BASE = "https://naive.test";

type Route = "upload" | "put" | "createPost" | "getPost" | "analytics" | "accounts";

export type FakePost = { id: string; status: string; url?: string | null; error?: string | null; metrics?: Record<string, number> | null; [key: string]: unknown };

export type Call = { method: string; path: string; body: unknown; idempotencyKey?: string };

export function fakeNaive() {
  const state = {
    calls: [] as Call[],
    identities: [] as Array<{ id: string; name: string }>,
    accounts: [] as Array<Record<string, unknown>>,
    /** How many of the next calls to each route answer "the service is at capacity". */
    busy: {} as Partial<Record<Route, number>>,
    /** Status a new post starts in ("processing", or "scheduled" when it has a time). */
    createdStatus: null as string | null,
    posts: new Map<string, FakePost>(),
    /** Idempotency key -> post id, so a retried create returns the same post. */
    keys: new Map<string, string>(),
    analytics: {} as Record<string, unknown>,
    sessions: [] as Array<Record<string, unknown>>,
    uploads: 0,
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const atCapacity = () => json(429, { error: { type: "rate_limit", code: "rate_limited", message: "the service is at capacity", request_id: "req_fake" } });
  const isBusy = (route: Route) => {
    if (!state.busy[route]) return false;
    state.busy[route]! -= 1;
    return true;
  };
  const page = (data: unknown[]) => ({ data, has_more: false, next_cursor: null });

  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body) body = { bytes: (init.body as Uint8Array).length };
    const path = url.origin === NAIVE_BASE ? url.pathname : url.href;
    state.calls.push({ method, path, body, idempotencyKey: headers["idempotency-key"] });

    if (url.origin === "https://upload.test") return isBusy("put") ? new Response("the service is at capacity", { status: 429 }) : new Response(null, { status: 200 });
    if (url.origin !== NAIVE_BASE) throw new Error(`unexpected request to ${url.href}`);

    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/v1/identities") return json(200, page(state.identities));
    if (method === "POST" && path === "/v1/identities") {
      const identity = { id: `idn_${state.identities.length + 1}`, name: (body as { name: string }).name };
      state.identities.push(identity);
      return json(201, identity);
    }
    if ((m = path.match(/^\/v1\/identities\/([^/]+)\/social\/activate$/)) && method === "POST") return json(200, { activated: true });
    if ((m = path.match(/^\/v1\/identities\/([^/]+)\/social\/portal$/)) && method === "POST") return json(200, { url: `https://portal.test/connect/${m[1]}` });
    if ((m = path.match(/^\/v1\/identities\/([^/]+)\/social\/accounts$/)) && method === "GET") return isBusy("accounts") ? atCapacity() : json(200, page(state.accounts));
    if (path === "/v1/files/uploads" && method === "POST") {
      if (isBusy("upload")) return atCapacity();
      state.uploads += 1;
      return json(201, { file_id: `fil_up${state.uploads}`, upload_url: `https://upload.test/fil_up${state.uploads}` });
    }
    if ((m = path.match(/^\/v1\/files\/([^/]+)\/url$/)) && method === "POST") return json(200, { url: `https://files.test/${m[1]}`, expires_at: "2099-01-01T00:00:00Z" });
    if ((m = path.match(/^\/v1\/identities\/([^/]+)\/social\/posts$/)) && method === "POST") {
      if (isBusy("createPost")) return atCapacity();
      const key = headers["idempotency-key"];
      const existing = key ? state.keys.get(key) : undefined;
      if (existing) return json(200, state.posts.get(existing));
      const request = body as { scheduled_at?: string };
      const post: FakePost = { id: `spo_${state.posts.size + 1}`, object: "social_post", status: state.createdStatus ?? (request.scheduled_at ? "scheduled" : "processing"), url: null, error: null, metrics: null, ...request };
      state.posts.set(post.id, post);
      if (key) state.keys.set(key, post.id);
      return json(201, post);
    }
    if ((m = path.match(/^\/v1\/identities\/([^/]+)\/social\/posts\/([^/]+)\/analytics$/)) && method === "GET") {
      if (isBusy("analytics")) return atCapacity();
      return state.posts.has(m[2]) ? json(200, state.analytics) : json(404, { error: { code: "not_found", message: "no such post" } });
    }
    if ((m = path.match(/^\/v1\/identities\/([^/]+)\/social\/posts\/([^/]+)$/)) && method === "GET") {
      if (isBusy("getPost")) return atCapacity();
      const post = state.posts.get(m[2]);
      return post ? json(200, post) : json(404, { error: { code: "not_found", message: "no such post" } });
    }
    if (method === "GET" && path === "/v1/agents") return json(200, page([{ id: "agt_director", name: "nomen-director" }]));
    if (method === "POST" && path === "/v1/sessions") {
      state.sessions.push(body as Record<string, unknown>);
      return json(201, { id: `ses_${state.sessions.length}`, status: "queued", stop_reason: null, stop_code: null, consumed_micro_usd: 0, structured_output: null, pending_actions: [], last_seq: 0 });
    }
    throw new Error(`the fake Naive has no route for ${method} ${path}`);
  });

  return { state, fetchStub, calls: (route: RegExp, method?: string) => state.calls.filter((c) => route.test(c.path) && (!method || c.method === method)) };
}

/** Moves a post on, as Naive would once the network confirms it. Like the live API, the post read carries no link. */
export function postOut(post: FakePost) {
  Object.assign(post, { status: "posted", posted_at: new Date().toISOString() });
}

/**
 * A post's analytics in the shape Naive returned live on 2026-11-08 (bundle.social's, trimmed): the
 * post with each network's permalink, the network's own post, and one snapshot of lifetime totals
 * per refresh. Every read Naive makes forces a new snapshot.
 */
export function liveAnalytics(permalink: string, snapshots: Array<{ at: string; views: number; likes?: number; comments?: number; shares?: number; saves?: number }>) {
  const externalId = permalink.split("/").pop();
  return {
    object: "social_analytics",
    identity_id: "idn_naive",
    resource_id: "spo_1",
    platform: "tiktok",
    data: {
      post: {
        id: "spo_1",
        status: "POSTED",
        data: { TIKTOK: { type: "VIDEO", text: "Three steps to a running company.", uploadIds: ["upl_1"], isAiGenerated: true } },
        externalData: { TIKTOK: { id: externalId, permalink, status: "PUBLISH_COMPLETE" } },
        retryCount: 0,
      },
      profilePost: { id: "pp_1", socialAccountId: "acc_tt", externalId, permalink, type: "POST", internal: true },
      items: snapshots.map((s, i) => ({
        id: `snap_${i}`,
        profilePostId: "pp_1",
        impressions: s.views,
        impressionsUnique: s.views,
        views: s.views,
        viewsUnique: s.views,
        likes: s.likes ?? 0,
        dislikes: 0,
        comments: s.comments ?? 0,
        shares: s.shares ?? 0,
        saves: s.saves ?? 0,
        forced: true,
        createdAt: s.at,
        updatedAt: s.at,
        deletedAt: null,
        raw: null,
      })),
    },
  };
}
