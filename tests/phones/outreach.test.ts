import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as statusRoute, POST as sendRoute } from "@/app/api/phones/outreach/route";
import { db, now } from "@/lib/db";
import { advancePhones } from "@/lib/phones";
import { outreachTask } from "@/lib/phones/mobilerun";
import { getSession, listSessions, saveLink } from "@/lib/phones/store";
import { events, fakeMobilerun, resetDb } from "./fake-mobilerun";

// A brief cast to a real creator can have its outreach DM sent from the brand's own account on its
// phone: only once a person approved the brief, only once, and exactly the drafted message.

const BRAND = "brand_acme";
const MESSAGE = "Hi, I'm the founder of Acme Skin. Your \"3-step SPF\" video did 1.2M views. $150 flat for one video. Interested?";
let mr: ReturnType<typeof fakeMobilerun>;

function brief(id: string, { approved = true, platform = "tiktok", outreach = true } = {}) {
  const conn = db();
  conn.prepare("insert or ignore into campaigns (id, brand_id, status, stage, options_json, created_at, updated_at) values (?, ?, 'review', 'review', '{}', ?, ?)").run("cmp_1", BRAND, now(), now());
  const concept = { title: "3-step SPF", casting: { status: "approved", pick: { handle: "sunny.skin", platform }, outreach: outreach ? { channel: `${platform}_dm`, message: MESSAGE } : null } };
  conn
    .prepare("insert into creatives (id, campaign_id, idx, concept_json, shots_json, status, caption, platforms_json, approved, created_at, updated_at) values (?, 'cmp_1', 0, ?, '[]', 'ready', '', '[]', ?, ?, ?)")
    .run(id, JSON.stringify(concept), approved ? 1 : 0, now(), now());
}

const send = async (creativeId: string) => {
  const response = await sendRoute(new Request("http://localhost/api/phones/outreach", { method: "POST", body: JSON.stringify({ brandId: BRAND, creativeId }) }));
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  vi.stubEnv("MOBILERUN_API_KEY", "dr_sk_test");
  mr = fakeMobilerun();
  vi.stubGlobal("fetch", mr.fetchMock);
  resetDb();
  db().exec("delete from creatives; delete from campaigns;");
  mr.addDevice({ id: "dev_ready_1", state: "ready" });
  saveLink({ brandId: BRAND, deviceId: "dev_ready_1", topics: ["skincare"], vpnCountry: null, accounts: [{ platform: "tiktok", credentialName: "acme-tiktok" }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("outreach from the phone", () => {
  it("sends the approved DM to the creator, word for word, from the brand's account", async () => {
    brief("crv_1");
    const queued = await send("crv_1");
    expect(queued.status).toBe(200);
    expect(queued.body.session).toMatchObject({ task: "outreach", to: "sunny.skin", status: "pending", platform: "tiktok" });

    await advancePhones();
    const [create] = mr.callsTo("POST", /^\/tasks$/);
    const task = String(create.body?.task);
    expect(task).toContain("using the brand's own official TikTok account");
    expect(task).toContain("one direct message to the creator @sunny.skin");
    expect(task).toContain(`-----\n${MESSAGE}\n-----`);
    expect(task).toContain("Never message anyone else, never send a second message");
    expect(create.body).toMatchObject({ apps: ["com.zhiliaoapp.musically"], credentials: [{ packageName: "com.zhiliaoapp.musically", credentialNames: ["acme-tiktok"] }] });

    const [session] = listSessions(BRAND);
    mr.finishTask(session.task_id!, { message: "Sent the message to @sunny.skin." });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    await advancePhones();
    vi.useRealTimers();
    expect(getSession(session.id)).toMatchObject({ status: "succeeded" });
    expect(events().map((e) => e.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/outreach DM to @sunny\.skin on TikTok queued/), expect.stringMatching(/outreach DM to @sunny\.skin on TikTok sent/)]),
    );

    // Sent once, never again; and the card can read where it stands.
    expect((await send("crv_1")).status).toBe(409);
    const status = await statusRoute(new Request(`http://localhost/api/phones/outreach?brandId=${BRAND}&creativeId=crv_1`));
    expect(await status.json()).toMatchObject({ linked: true, session: { status: "succeeded", to: "sunny.skin" } });
  });

  it("will not send before a person approves the brief, or twice at once", async () => {
    brief("crv_1", { approved: false });
    expect(await send("crv_1")).toMatchObject({ status: 400, body: { error: "Approve the brief before its outreach is sent." } });
    brief("crv_2");
    expect((await send("crv_2")).status).toBe(200);
    expect(await send("crv_2")).toMatchObject({ status: 409, body: { error: "The DM to @sunny.skin is already on its way." } });
  });

  it("needs a draft, and the brand's account on that platform linked to its phone", async () => {
    brief("crv_1", { outreach: false });
    expect((await send("crv_1")).body.error).toBe("This brief has no creator and outreach draft to send.");
    brief("crv_2", { platform: "instagram" });
    expect((await send("crv_2")).body.error).toBe("Link the brand's Instagram account on the phone first.");
    expect((await send("crv_x")).status).toBe(404);
  });

  it("lets a warm-up and a DM share the phone, one after the other", async () => {
    brief("crv_1");
    await send("crv_1");
    const { runNow } = await import("@/lib/phones/service");
    await runNow({ brandId: BRAND });
    expect(listSessions(BRAND).map((s) => s.task).sort()).toEqual(["outreach", "warmup"]);
  });

  it("writes a task that stops rather than guess", () => {
    const task = outreachTask({ platform: "Instagram", brand: "Acme", handle: "x.y", message: "Hello" });
    expect(task).toContain("if no account matches exactly, stop and report it without messaging anyone");
    expect(task).toContain("If the app does not let you message them");
    expect(task).toContain("exactly as written, with nothing added, removed or changed, and send it once");
  });
});
