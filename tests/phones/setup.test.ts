import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as setupRoute } from "@/app/api/phones/setup/route";
import { advancePhones } from "@/lib/phones";
import { listSessions, saveLink, type SessionRow } from "@/lib/phones/store";
import { events, fakeMobilerun, resetDb } from "./fake-mobilerun";

// "Set up for posting": the phone agent installs TikTok and lets it see the phone's videos. Signing
// in to Google or TikTok, and making accounts, stay with a person.

const BRAND = "brand_acme";
const PHONE = "dev_ready_1";
const T0 = new Date("2026-11-07T18:00:00.000Z");

let mr: ReturnType<typeof fakeMobilerun>;

const advanceClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const stops = () => mr.callsTo("POST", new RegExp(`^/devices/${PHONE}/stop$`));
const only = () => {
  const all = listSessions(BRAND, 10);
  expect(all).toHaveLength(1);
  return all[0] as SessionRow;
};

/** The Phones panel's "Set up for posting" button. */
async function setUp() {
  const response = await setupRoute(
    new Request("http://localhost/api/phones/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brandId: BRAND }) }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function link() {
  saveLink({ brandId: BRAND, deviceId: PHONE, topics: ["skincare routines"], vpnCountry: "US", accounts: [{ platform: "tiktok", credentialName: "acme-tiktok" }] });
}

const report = (fields: Record<string, unknown>) => ({ googleSignInNeeded: false, tiktokInstalled: true, photoAccess: true, tiktokLoggedIn: false, reason: "", ...fields });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("MOBILERUN_API_KEY", "dr_sk_test");
  mr = fakeMobilerun();
  vi.stubGlobal("fetch", mr.fetchMock);
  resetDb();
  mr.addDevice({ id: PHONE, state: "ready" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("setting up the phone for posting", () => {
  it("needs the brand's phone linked first", async () => {
    const refused = await setUp();
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/Link the brand's phone/);
    expect(mr.fetchMock).not.toHaveBeenCalled();
  });

  it("installs TikTok and lets it see the phone's videos, then keeps the phone on for a person to log in", async () => {
    link();
    expect((await setUp()).status).toBe(200);
    mr.clearCalls();
    await advancePhones();

    const [create] = mr.callsTo("POST", /^\/tasks$/);
    expect(create.body).toMatchObject({
      deviceId: PHONE,
      apps: ["com.android.vending", "com.android.settings", "com.zhiliaoapp.musically"],
      credentials: [],
      outputSchema: { type: "object", required: expect.arrayContaining(["googleSignInNeeded", "tiktokInstalled", "photoAccess", "tiktokLoggedIn"]) },
    });
    const brief = String(create.body?.task);
    expect(brief).toContain("If it asks you to sign in to a Google account, stop");
    expect(brief).toContain("Do not log in, sign up or create an account");
    expect(only()).toMatchObject({ kind: "setup", platform: "tiktok", status: "running" });

    advanceClock(11_000);
    mr.finishTask(only().task_id!, { output: report({}) });
    await advancePhones();
    expect(only()).toMatchObject({ status: "succeeded", message: expect.stringMatching(/Left for you: log in to the brand's TikTok/) });
    expect(events().some((e) => e.level === "info" && /Phones: phone setup for posting finished/.test(e.message))).toBe(true);

    // On for 30 minutes so a person can log in to TikTok, then parked.
    expect(stops()).toHaveLength(0);
    advanceClock(29 * 60_000);
    await advancePhones();
    expect(stops()).toHaveLength(0);
    advanceClock(2 * 60_000);
    await advancePhones();
    expect(stops()).toHaveLength(1);
  });

  it("asks a person to sign in to Google Play when the Play Store needs it", async () => {
    link();
    await setUp();
    await advancePhones();
    advanceClock(11_000);
    mr.finishTask(only().task_id!, { succeeded: false, output: report({ googleSignInNeeded: true, tiktokInstalled: false, photoAccess: false, reason: "The Play Store asked me to sign in." }) });
    await advancePhones();
    expect(only()).toMatchObject({ status: "failed", message: expect.stringMatching(/Sign in to Google Play on the phone first/) });
    expect(events().some((e) => e.level === "warn" && /Phones: phone setup for posting failed/.test(e.message))).toBe(true);
    expect(stops()).toHaveLength(0);
  });

  it("runs one setup at a time", async () => {
    link();
    await setUp();
    const again = await setUp();
    expect(again.status).toBe(409);
  });
});
