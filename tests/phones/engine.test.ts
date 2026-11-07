import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advancePhones } from "@/lib/phones";
import { DAY_MS } from "@/lib/phones/rules";
import { getSession, listSessions, saveLink, updateLink, getLink, type SessionRow } from "@/lib/phones/store";
import { cancelSession, runNow, setSchedule } from "@/lib/phones/service";
import { events, fakeMobilerun, resetDb } from "./fake-mobilerun";

const BRAND = "brand_acme";
const T0 = new Date("2026-11-07T18:00:00.000Z");

let mr: ReturnType<typeof fakeMobilerun>;

const advanceClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
/** One worker tick, then move the clock past every poll interval so the next tick re-checks. */
async function tickAndWait(ms = 31_000) {
  await advancePhones();
  advanceClock(ms);
}
const sessions = () => listSessions(BRAND, 100).reverse();
const only = () => {
  const all = sessions();
  expect(all).toHaveLength(1);
  return all[0] as SessionRow;
};

/** "Run now" from the panel, then forget the status fetch it made. */
async function queueRun() {
  await runNow({ brandId: BRAND });
  mr.clearCalls();
}

function link(platforms: Array<{ platform: "tiktok" | "instagram"; credentialName: string | null }> = [{ platform: "tiktok", credentialName: "acme-tiktok" }], deviceId = "dev_ready_1") {
  saveLink({ brandId: BRAND, deviceId, topics: ["skincare routines", "SPF"], vpnCountry: "US", accounts: platforms });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("MOBILERUN_API_KEY", "dr_sk_test");
  mr = fakeMobilerun();
  vi.stubGlobal("fetch", mr.fetchMock);
  resetDb();
  mr.addDevice({ id: "dev_ready_1", state: "ready" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("advancePhones", () => {
  it("does nothing without a Mobilerun key", async () => {
    link();
    await queueRun();
    vi.stubEnv("MOBILERUN_API_KEY", "");
    await advancePhones();
    expect(mr.fetchMock).not.toHaveBeenCalled();
    expect(only().status).toBe("pending");
  });

  it("runs a session from start to finish", async () => {
    link();
    await queueRun();
    await advancePhones();

    const [create] = mr.callsTo("POST", /^\/tasks$/);
    const session = only();
    expect(session.status).toBe("running");
    expect(create.headers["idempotency-key"]).toBe(session.id);
    expect(create.body).toMatchObject({
      deviceId: "dev_ready_1",
      llmModel: "mobilerun/mobile-agent-fast",
      maxSteps: 144,
      executionTimeout: 1020,
      humanize: true,
      recordingEnabled: true,
      vpnCountry: "US",
      apps: ["com.zhiliaoapp.musically"],
      credentials: [{ packageName: "com.zhiliaoapp.musically", credentialNames: ["acme-tiktok"] }],
    });
    const brief = String(create.body?.task);
    expect(brief).toContain("social media manager for Acme Skin, using the brand's own official TikTok account");
    expect(brief).toContain("skincare routines, SPF");
    expect(brief).toContain("Like at most 8 videos");
    expect(brief).toContain("Never post, comment, send messages");

    // Before the poll interval passes, a tick makes no calls.
    const before = mr.fetchMock.mock.calls.length;
    await advancePhones();
    expect(mr.fetchMock.mock.calls.length).toBe(before);

    advanceClock(11_000);
    mr.tasks.get(session.task_id!)!.steps = 40;
    await advancePhones();
    expect(getSession(session.id)).toMatchObject({ status: "running", steps: 40 });

    advanceClock(11_000);
    mr.finishTask(session.task_id!, { steps: 96, message: "Watched 22 videos, liked 7, followed 2 creators." });
    await advancePhones();
    expect(getSession(session.id)).toMatchObject({ status: "succeeded", steps: 96, succeeded: 1, message: "Watched 22 videos, liked 7, followed 2 creators." });
    expect(events().map((e) => e.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/TikTok warm-up started/), expect.stringMatching(/TikTok warm-up finished/)]),
    );

    // Finished sessions are never polled again.
    const settled = mr.fetchMock.mock.calls.length;
    advanceClock(60_000);
    await advancePhones();
    expect(mr.fetchMock.mock.calls.length).toBe(settled);
  });

  it("sends no credentials when the app is already logged in", async () => {
    link([{ platform: "tiktok", credentialName: null }]);
    await queueRun();
    await advancePhones();
    expect(mr.callsTo("POST", /^\/tasks$/)[0].body?.credentials).toEqual([]);
  });

  it("wakes a parked phone before starting", async () => {
    mr.devices.get("dev_ready_1")!.state = "stopped";
    link();
    await queueRun();

    await tickAndWait();
    expect(mr.callsTo("POST", /\/resume$/)).toHaveLength(1);
    expect(only()).toMatchObject({ status: "waiting", message: "Waking up the parked phone." });
    expect(mr.callsTo("POST", /^\/tasks$/)).toHaveLength(0);

    // Still booting: keep waiting without another resume.
    await tickAndWait();
    expect(only().status).toBe("waiting");
    expect(mr.callsTo("POST", /\/resume$/)).toHaveLength(1);

    mr.devices.get("dev_ready_1")!.state = "ready";
    await advancePhones();
    expect(only().status).toBe("running");
  });

  it("fails in plain language when the phone was deleted", async () => {
    mr.devices.get("dev_ready_1")!.state = "terminated";
    link();
    await queueRun();
    await advancePhones();
    expect(only()).toMatchObject({ status: "failed", message: "This phone was deleted in Mobilerun. Link a different phone." });
  });

  it("gives up on a phone that stays unavailable for an hour", async () => {
    mr.devices.get("dev_ready_1")!.state = "maintenance";
    link();
    await queueRun();
    await tickAndWait();
    expect(only().status).toBe("waiting");
    advanceClock(61 * 60_000);
    await advancePhones();
    expect(only()).toMatchObject({ status: "failed", message: expect.stringMatching(/wasn't ready within an hour/) });
  });

  it("runs one session at a time on a phone", async () => {
    link([
      { platform: "tiktok", credentialName: "acme-tiktok" },
      { platform: "instagram", credentialName: "acme-ig" },
    ]);
    await queueRun();
    await tickAndWait();
    expect(mr.callsTo("POST", /^\/tasks$/)).toHaveLength(1);
    const [first, second] = sessions();
    expect(getSession(first.id)!.status).toBe("running");
    expect(getSession(second.id)).toMatchObject({ status: "pending", message: "Waiting for the phone's current session to finish." });

    mr.finishTask(getSession(first.id)!.task_id!, { message: "done" });
    await tickAndWait(); // records the finish; the second session's check is not due yet
    await advancePhones();
    expect(getSession(first.id)!.status).toBe("succeeded");
    expect(getSession(second.id)!.status).toBe("running");
    expect(mr.callsTo("POST", /^\/tasks$/)[1].body?.apps).toEqual(["com.instagram.android"]);
  });

  it("reports an agent failure", async () => {
    link();
    await queueRun();
    await tickAndWait();
    const session = only();
    Object.assign(mr.tasks.get(session.task_id!)!, { status: "failed", succeeded: false, message: "TikTok asked for a verification code", execution: { terminationReason: "agent_failed" } });
    await advancePhones();
    expect(only()).toMatchObject({ status: "failed", message: "The phone agent couldn't finish: TikTok asked for a verification code." });
    expect(events().some((e) => e.level === "warn" && /warm-up failed/.test(e.message))).toBe(true);
  });

  it("retries a busy phone later instead of failing", async () => {
    link();
    await queueRun();
    mr.failNext("POST", /^\/tasks$/, 409, { title: "Conflict", status: 409, detail: "device busy", errors: [] });
    await advancePhones();
    expect(only()).toMatchObject({ status: "waiting", error: "The phone is busy with another task. Trying again shortly." });

    advanceClock(70_000);
    await advancePhones();
    expect(only()).toMatchObject({ status: "running", error: null });
  });

  it("stops after a non-retryable error", async () => {
    link();
    await queueRun();
    mr.failNext("POST", /^\/tasks$/, 402, { title: "Payment Required", status: 402, detail: "insufficient credits", errors: [] });
    await advancePhones();
    expect(only()).toMatchObject({ status: "failed", message: "The Mobilerun account is out of credits or phone minutes." });
  });

  it("runs without recording on a phone that cannot record", async () => {
    link();
    await queueRun();
    mr.failNext("POST", /^\/tasks$/, 400, { title: "Bad Request", status: 400, detail: "DEVICE_RECORDING_UNSUPPORTED", errors: [] });
    await advancePhones();
    const creates = mr.callsTo("POST", /^\/tasks$/);
    expect(creates).toHaveLength(2);
    expect(creates[1].body?.recordingEnabled).toBe(false);
    expect(creates[1].headers["idempotency-key"]).toBe(`${only().id}-norec`);
    expect(only().status).toBe("running");
  });

  it("stops the Mobilerun task when the user stops a session", async () => {
    link();
    await queueRun();
    await tickAndWait();
    const session = only();
    await cancelSession(session.id);
    expect(mr.callsTo("POST", /\/cancel$/)).toHaveLength(1);
    expect(only()).toMatchObject({ status: "cancelled", message: "Stopped by you." });

    // A later poll does not resurrect it.
    await advancePhones();
    expect(only().status).toBe("cancelled");
  });

  it("stops a session that runs far past its length", async () => {
    link();
    await queueRun();
    await tickAndWait();
    advanceClock((12 + 31) * 60_000);
    await advancePhones();
    expect(only()).toMatchObject({ status: "failed", message: expect.stringMatching(/ran far longer/) });
    expect(mr.callsTo("POST", /\/cancel$/)).toHaveLength(1);
  });

  it("does one tick's work when called twice at once", async () => {
    link();
    await queueRun();
    await Promise.all([advancePhones(), advancePhones()]);
    expect(mr.callsTo("POST", /^\/tasks$/)).toHaveLength(1);
    expect(mr.callsTo("GET", /^\/devices\//)).toHaveLength(1);
  });

  it("recovers a session whose task create was interrupted", async () => {
    link();
    await queueRun();
    await advancePhones();
    const session = only();
    // Simulate a crash after the create was sent but before it was saved.
    const { db } = await import("@/lib/db");
    db().prepare("update phone_sessions set status = 'starting', task_id = null, updated_at = ?, next_check_at = ? where id = ?").run(new Date(Date.now() - 120_000).toISOString(), new Date().toISOString(), session.id);
    await advancePhones();
    // Same idempotency key, so Mobilerun hands back the same task instead of starting a second one.
    expect(mr.callsTo("POST", /^\/tasks$/).map((call) => call.headers["idempotency-key"])).toEqual([session.id, session.id]);
    expect(mr.tasks.size).toBe(1);
    expect(only()).toMatchObject({ status: "running", task_id: session.task_id });
  });
});

describe("daily schedule", () => {
  it("queues one session per account per day, for the configured days", async () => {
    link([
      { platform: "tiktok", credentialName: "acme-tiktok" },
      { platform: "instagram", credentialName: "acme-ig" },
    ]);
    await setSchedule({ brandId: BRAND, enabled: true, days: 2 });

    await advancePhones();
    await advancePhones();
    const day1 = sessions();
    expect(day1.map((s) => [s.kind, s.day_index, s.platform])).toEqual([
      ["scheduled", 0, "tiktok"],
      ["scheduled", 0, "instagram"],
    ]);

    // Finish both; the same day queues nothing new.
    for (let i = 0; i < 6; i++) {
      for (const task of mr.tasks.values()) if (task.status === "running") mr.finishTask(task.id, { message: "ok" });
      await tickAndWait();
    }
    expect(sessions().every((s) => s.status === "succeeded")).toBe(true);
    expect(sessions()).toHaveLength(2);

    vi.setSystemTime(new Date(T0.getTime() + DAY_MS + 1000));
    await advancePhones();
    expect(sessions().filter((s) => s.day_index === 1)).toHaveLength(2);

    vi.setSystemTime(new Date(T0.getTime() + 2 * DAY_MS + 1000));
    for (const task of mr.tasks.values()) if (task.status !== "completed") mr.finishTask(task.id, { message: "ok" });
    for (let i = 0; i < 6; i++) await tickAndWait();
    expect(sessions().filter((s) => s.day_index === 2)).toHaveLength(0);
  });

  it("skips days the worker was not running for instead of catching up", async () => {
    link();
    await setSchedule({ brandId: BRAND, enabled: true, days: 7 });
    vi.setSystemTime(new Date(T0.getTime() + 3 * DAY_MS + 60_000));
    await advancePhones();
    expect(sessions().map((s) => s.day_index)).toEqual([3]);
  });

  it("turning the schedule off stops sessions that have not started", async () => {
    mr.devices.get("dev_ready_1")!.state = "creating";
    link();
    await setSchedule({ brandId: BRAND, enabled: true, days: 3 });
    await advancePhones();
    expect(only().status).toBe("waiting");
    await setSchedule({ brandId: BRAND, enabled: false });
    expect(only()).toMatchObject({ status: "cancelled", message: "The schedule was turned off." });
    expect(getLink(BRAND)!.schedule_enabled).toBe(0);
  });

  it("changing the length of a running schedule keeps its start", async () => {
    link();
    await setSchedule({ brandId: BRAND, enabled: true, days: 3 });
    const started = getLink(BRAND)!.schedule_started_at;
    advanceClock(DAY_MS);
    await setSchedule({ brandId: BRAND, enabled: true, days: 10 });
    expect(getLink(BRAND)).toMatchObject({ schedule_days: 10, schedule_started_at: started });
    updateLink(getLink(BRAND)!.id, { schedule_enabled: 0 });
  });
});
