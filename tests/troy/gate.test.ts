import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_COOKIE, gateToken, safeEqual, safeNext } from "@/app/gate/token";
import { proxy } from "@/proxy";

// The password gate for demo deployments. The password here is a test value; the real one lives
// only in the deployment's SITE_PASSWORD environment variable.

const PASSWORD = "test-password#1";

function request(path: string, cookie?: string) {
  return new NextRequest(new URL(path, "https://nomen.example"), { headers: cookie ? { cookie: `${GATE_COOKIE}=${cookie}` } : {} });
}

afterEach(() => {
  delete process.env.SITE_PASSWORD;
  delete process.env.NOMEN_DEMO_ONLY;
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

  it("sends pages to the gate, keeping where the visitor was going", async () => {
    process.env.SITE_PASSWORD = PASSWORD;
    const home = await proxy(request("/"));
    expect(home.status).toBe(307);
    expect(new URL(home.headers.get("location")!).pathname).toBe("/gate");
    const deep = await proxy(request("/camp/demo?x=1"));
    expect(new URL(deep.headers.get("location")!).searchParams.get("next")).toBe("/camp/demo?x=1");
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
