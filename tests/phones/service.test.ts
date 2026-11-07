import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as statusRoute } from "@/app/api/phones/route";
import { GET as credentialsRoute } from "@/app/api/phones/credentials/route";
import { PUT as linkRoute } from "@/app/api/phones/link/route";
import { POST as provisionRoute } from "@/app/api/phones/devices/route";
import { getLink, listAccounts } from "@/lib/phones/store";
import { runNow } from "@/lib/phones/service";
import { fakeMobilerun, resetDb } from "./fake-mobilerun";

let mr: ReturnType<typeof fakeMobilerun>;

const put = (body: unknown) => linkRoute(new Request("http://localhost/api/phones/link", { method: "PUT", body: JSON.stringify(body) }));
const goodLink = {
  brandId: "brand_acme",
  deviceId: "dev_ready_1",
  official: true,
  topics: ["skincare routines", " SPF ", "spf", ""],
  vpnCountry: "US",
  accounts: [
    { platform: "tiktok", credentialName: "acme-tiktok" },
    { platform: "instagram", credentialName: "" },
  ],
};

beforeEach(() => {
  vi.stubEnv("MOBILERUN_API_KEY", "dr_sk_test");
  mr = fakeMobilerun();
  vi.stubGlobal("fetch", mr.fetchMock);
  resetDb([
    { id: "brand_acme", name: "Acme Skin" },
    { id: "brand_other", name: "Other Co" },
  ]);
  mr.addDevice({ id: "dev_ready_1", state: "ready" });
  mr.addDevice({ id: "dev_ready_2", state: "ready" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("phones panel API", () => {
  it("reports setup needed without a key, and never calls Mobilerun", async () => {
    vi.stubEnv("MOBILERUN_API_KEY", "");
    const response = await statusRoute(new Request("http://localhost/api/phones?brandId=brand_acme"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false, link: null, active: [], history: [] });
    expect(mr.fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown brand", async () => {
    const response = await statusRoute(new Request("http://localhost/api/phones?brandId=nope"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Brand not found." });
  });

  it("links a brand's official accounts and cleans the topics", async () => {
    const response = await put(goodLink);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.link).toMatchObject({ deviceId: "dev_ready_1", topics: ["skincare routines", "SPF"], vpnCountry: "US" });
    expect(body.device).toMatchObject({ id: "dev_ready_1", label: "Ready", tone: "good" });
    expect(listAccounts("brand_acme").map((a) => [a.platform, a.credential_name])).toEqual([
      ["tiktok", "acme-tiktok"],
      ["instagram", null],
    ]);
  });

  it("requires the official-account confirmation", async () => {
    const response = await put({ ...goodLink, official: false });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/official accounts/);
    expect(getLink("brand_acme")).toBeUndefined();
  });

  it("allows one account per platform", async () => {
    const response = await put({ ...goodLink, accounts: [{ platform: "tiktok" }, { platform: "tiktok" }] });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Only one TikTok account per brand.");
  });

  it("rejects unknown platforms and empty topics", async () => {
    expect((await put({ ...goodLink, accounts: [{ platform: "myspace" }] })).status).toBe(400);
    expect((await put({ ...goodLink, topics: [] })).status).toBe(400);
  });

  it("keeps each phone to one brand", async () => {
    expect((await put(goodLink)).status).toBe(200);
    const response = await put({ ...goodLink, brandId: "brand_other" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already linked to Acme Skin/);
  });

  it("removes a platform's account when it is unticked", async () => {
    await put(goodLink);
    await put({ ...goodLink, accounts: [{ platform: "instagram" }] });
    expect(listAccounts("brand_acme").map((a) => a.platform)).toEqual(["instagram"]);
  });

  it("refuses a phone Mobilerun no longer has", async () => {
    const response = await put({ ...goodLink, deviceId: "dev_missing" });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/doesn't know this phone/);
  });

  it("returns saved login names without their values", async () => {
    const response = await credentialsRoute();
    const body = await response.json();
    expect(body).toEqual({ tiktok: ["acme-tiktok"], instagram: ["acme-ig"], youtube: [], x: [], reddit: [] });
    expect(JSON.stringify(body)).not.toContain("hunter");
  });

  it("provisions a minute-billed Android phone with an idempotency key", async () => {
    const request = () =>
      provisionRoute(new Request("http://localhost/api/phones/devices", { method: "POST", body: JSON.stringify({ brandId: "brand_acme", idempotencyKey: "click-1234567890" }) }));
    const first = await (await request()).json();
    const second = await (await request()).json();
    expect(first.id).toBe(second.id);
    const [call] = mr.callsTo("POST", /^\/devices$/);
    expect(call.query.get("deviceType")).toBe("android_cloud_phone");
    expect(call.query.get("billing")).toBe("minute");
    expect(call.headers["idempotency-key"]).toBe("click-1234567890");
  });

  it("will not queue a second warm-up for an account that has one", async () => {
    await put(goodLink);
    await runNow({ brandId: "brand_acme" });
    await expect(runNow({ brandId: "brand_acme" })).rejects.toMatchObject({ status: 409 });
  });
});
