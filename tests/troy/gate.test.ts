import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_COOKIE, gateToken, safeEqual, safeNext } from "@/app/gate/token";
import { liveEnabled } from "@/lib/live";
import { proxy } from "@/proxy";

// The password gate for demo deployments. The password here is a test value; the real one lives
// only in the deployment's SITE_PASSWORD environment variable.

const PASSWORD = "test-password#1";

function request(path: string, cookie?: string) {
  return new NextRequest(new URL(path, "https://nomen.example"), { headers: cookie ? { cookie: `${GATE_COOKIE}=${cookie}` } : {} });
}

afterEach(() => {
  for (const name of ["SITE_PASSWORD", "NOMEN_DEMO_ONLY", "VERCEL", "NEXT_PUBLIC_CONVEX_URL", "CONVEX_DEPLOY_KEY"]) delete process.env[name];
});

describe("gate tokens", () => {
  it("hash the password and never contain it", async () => {
    const token = await gateToken(PASSWORD);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).toBe(await gateToken(PASSWORD));
    expect(token).not.toBe(await gateToken("test-password#2"));
    expect(token.includes(PASSWORD)).toBe(false);
  });

  it("compare equal strings only", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("only send people on to paths on this site", () => {
    expect(safeNext("/camp/demo?x=1")).toBe("/camp/demo?x=1");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/gate?next=/gate")).toBe("/");
  });
});

describe("the proxy", () => {
  it("lets everything through when no password is set", async () => {
    const response = await proxy(request("/camp/demo"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("sends the front door to the demo and other pages to the gate, keeping where the visitor was going", async () => {
    process.env.SITE_PASSWORD = PASSWORD;
    const home = await proxy(request("/"));
    expect(home.status).toBe(307);
    expect(new URL(home.headers.get("location")!).pathname).toBe("/demo");
    const deep = await proxy(request("/camp/brand_abc?x=1"));
    expect(new URL(deep.headers.get("location")!).searchParams.get("next")).toBe("/camp/brand_abc?x=1");
  });

  it("keeps the demo public: its page, its recordings and videos, and the demo camp", async () => {
    process.env.SITE_PASSWORD = PASSWORD;
    for (const path of ["/demo", "/demo/index.json", "/demo/usenaive-ai/script.json", "/demo/usenaive-ai/1.mp4", "/camp/demo", "/camp/demo?site=usenaive.ai"]) {
      expect((await proxy(request(path))).headers.get("x-middleware-next"), path).toBe("1");
    }
    // Everything else still needs the password: the live site, real camps, the workspace, the API.
    for (const path of ["/brands", "/settings", "/camp/brand_abc", "/camp/demo-copy", "/demox"]) {
      const response = await proxy(request(path));
      expect(response.status, path).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname, path).toBe("/gate");
    }
    for (const path of ["/api/brands", "/api/campaigns/cmp_1", "/api/phones/outreach"]) expect((await proxy(request(path))).status, path).toBe(401);
  });

  it("answers API calls with 401, and the app header's status call with a locked status", async () => {
    process.env.SITE_PASSWORD = PASSWORD;
    const api = await proxy(request("/api/brands"));
    expect(api.status).toBe(401);
    const status = await proxy(request("/api/status"));
    expect(status.status).toBe(401);
    expect(await status.json()).toMatchObject({ naive: { ok: false }, monid: { ok: false }, mobilerun: { configured: false } });
  });

  it("lets the gate itself through", async () => {
    process.env.SITE_PASSWORD = PASSWORD;
    expect((await proxy(request("/gate"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/api/gate"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("lets a browser with the right cookie in, and not one with a wrong cookie", async () => {
    process.env.SITE_PASSWORD = PASSWORD;
    expect((await proxy(request("/", await gateToken(PASSWORD)))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/", await gateToken("guess")))).status).toBe(307);
  });
});

describe("the demo-only build", () => {
  it("switches the API off but answers the header's status call, behind the gate", async () => {
    process.env.NOMEN_DEMO_ONLY = "1";
    process.env.SITE_PASSWORD = PASSWORD;
    const cookie = await gateToken(PASSWORD);
    expect((await proxy(request("/api/brands"))).status).toBe(401);
    const brands = await proxy(request("/api/brands", cookie));
    expect(brands.status).toBe(404);
    const status = await proxy(request("/api/status", cookie));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ naive: { ok: false }, monid: { ok: false }, mobilerun: { configured: false } });
    expect((await proxy(request("/api/gate"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("/camp/demo", cookie))).headers.get("x-middleware-next")).toBe("1");
  });

  it("works without a password too", async () => {
    process.env.NOMEN_DEMO_ONLY = "1";
    expect((await proxy(request("/api/campaigns/x"))).status).toBe(404);
    expect((await proxy(request("/"))).headers.get("x-middleware-next")).toBe("1");
  });
});

describe("live or demo on Vercel", () => {
  it("plays the demo on / until Convex is connected, then goes live by itself", async () => {
    process.env.VERCEL = "1";
    expect(liveEnabled()).toBe(false);
    expect((await proxy(request("/api/brands"))).status).toBe(404);
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://example.convex.cloud";
    process.env.CONVEX_DEPLOY_KEY = "prod:example|key";
    expect(liveEnabled()).toBe(true);
    expect((await proxy(request("/api/brands"))).headers.get("x-middleware-next")).toBe("1");
    process.env.NOMEN_DEMO_ONLY = "1";
    expect(liveEnabled()).toBe(false);
  });

  it("is live on a machine with a disk", () => {
    expect(liveEnabled()).toBe(true);
  });
});
