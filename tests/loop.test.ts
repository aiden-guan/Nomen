import { beforeEach, describe, expect, it } from "vitest";
import { GET as loopGet, POST as loopPost } from "@/app/api/brands/[id]/loop/route";
import { db, now as nowIso } from "@/lib/db";
import {
  advanceLoop,
  autopostOn,
  campaignSpendMicro,
  DEFAULT_LOOP,
  estimateCampaignMicro,
  getLoop,
  type LoopCampaign,
  type LoopInput,
  type LoopSettings,
  loopHistory,
  nextLoopAction,
  saveLoop,
  spendInWindow,
  UNTRACKED_USD_PER_VIDEO,
  updateLoop,
} from "@/lib/loop";
import { remadeReferences } from "@/lib/pipeline";
import { estimateUsd } from "@/lib/views";

const M = 1_000_000;
const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-11-20T12:00:00.000Z");
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY).toISOString();
const ahead = (days: number, from = NOW) => new Date(from.getTime() + days * DAY).toISOString();

// ---------- the estimate and spend accounting ----------

describe("estimateCampaignMicro", () => {
  const veo = { concepts: 4, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1" };

  it("prices every video as a 36 s presenter video rendered twice, plus the untracked allowance and research", () => {
    // 4 x (36 s x 2 renders x $0.40 + $2) + $1
    expect(estimateCampaignMicro(veo)).toBe(124.2 * M);
  });

  it("uses the options' seconds when they ask for more than 36 s", () => {
    expect(estimateCampaignMicro({ ...veo, concepts: 1, shotsPerConcept: 5, secondsPerShot: 8 })).toBe((40 * 2 * 0.4 + 2 + 1) * M);
  });

  it("assumes an unknown model costs $0.50 a second, more than Veo", () => {
    expect(estimateCampaignMicro({ ...veo, concepts: 1, videoModel: "someone/new-model" })).toBe((36 * 2 * 0.5 + 2 + 1) * M);
  });

  it("is never below the UI's video estimate", () => {
    for (const concepts of [1, 2, 4, 8])
      for (const shotsPerConcept of [1, 2, 3])
        for (const secondsPerShot of [4, 8, 10]) {
          const options = { ...veo, concepts, shotsPerConcept, secondsPerShot };
          expect(estimateCampaignMicro(options)).toBeGreaterThan(estimateUsd({ ...options, learnStyle: true })! * M);
        }
  });

  it("covers the measured 2-video campaign that spent $26.10 against a $12.80 video estimate", () => {
    expect(estimateCampaignMicro({ ...veo, concepts: 2 })).toBeGreaterThan(26.1 * M);
  });
});

describe("campaignSpendMicro", () => {
  const zero = { naive_spend_micro: 0, monid_spend_micro: 0, style_spend_micro: 0, strategy_spend_micro: 0, creative_micro: 0, research_micro: 0, videos: 0, planned: 0 };

  it("adds the untracked allowance to the recorded spend", () => {
    expect(campaignSpendMicro({ ...zero, naive_spend_micro: 26 * M, monid_spend_micro: 0.07 * M, videos: 2, planned: 2 })).toBe(26.07 * M + 2 * UNTRACKED_USD_PER_VIDEO * M);
  });

  it("takes the larger of the stored totals and a fresh sum of their sources", () => {
    const stale = { ...zero, naive_spend_micro: 1 * M, strategy_spend_micro: 0.2 * M, creative_micro: 5 * M, research_micro: 0.1 * M };
    expect(campaignSpendMicro(stale)).toBe(5.3 * M);
  });

  it("charges the allowance for planned videos even when the campaign stopped before making them", () => {
    expect(campaignSpendMicro({ ...zero, planned: 4 })).toBe(4 * UNTRACKED_USD_PER_VIDEO * M);
  });

  it("charges the allowance for every re-rendered video too", () => {
    expect(campaignSpendMicro({ ...zero, planned: 2, videos: 5 })).toBe(5 * UNTRACKED_USD_PER_VIDEO * M);
  });
});

// ---------- the decision ----------

const on: LoopSettings = { ...DEFAULT_LOOP, enabled: true, weekly_budget_micro: 200 * M };
const campaign = (overrides: Partial<LoopCampaign> = {}): LoopCampaign => ({
  id: "cmp_1",
  status: "live",
  created_at: ago(10),
  spent_at: ago(9.5),
  spend_micro: 30 * M,
  ready: 2,
  ...overrides,
});
const input = (overrides: Partial<LoopInput> = {}): LoopInput => ({
  loop: on,
  campaigns: [campaign()],
  posts: { inFlight: 0, until: null },
  estimateMicro: 60 * M,
  now: NOW,
  ...overrides,
});

describe("nextLoopAction", () => {
  it("starts when the last campaign is done, the cadence has passed and the budget has room", () => {
    const decision = nextLoopAction(input());
    expect(decision).toMatchObject({ start: true, code: "start" });
    expect(decision.reason).toContain("Campaign 1 started 10 days ago");
  });

  it("starts a brand's first campaign", () => {
    expect(nextLoopAction(input({ campaigns: [] }))).toMatchObject({ start: true, code: "start" });
  });

  it("never starts while off, whatever else holds", () => {
    expect(nextLoopAction(input({ loop: { ...on, enabled: false }, campaigns: [] }))).toMatchObject({ start: false, code: "off" });
  });

  it("never starts with a budget of 0, even with nothing spent", () => {
    expect(nextLoopAction(input({ loop: { ...on, weekly_budget_micro: 0 }, campaigns: [], estimateMicro: 0 }))).toMatchObject({ start: false, code: "no_budget" });
  });

  it("waits while any campaign is running", () => {
    const decision = nextLoopAction(input({ campaigns: [campaign(), campaign({ id: "cmp_2", status: "running", created_at: ago(1) })] }));
    expect(decision).toMatchObject({ start: false, code: "running" });
    expect(decision.reason).toBe("Campaign 2 is still running.");
    expect(decision.next_at).toBeUndefined();
  });

  it("waits for a person while the last campaign's finished videos are unposted", () => {
    const decision = nextLoopAction(input({ campaigns: [campaign({ status: "review", ready: 3 })] }));
    expect(decision).toMatchObject({ start: false, code: "review" });
    expect(decision.reason).toBe("Campaign 1's 3 videos are waiting to be approved and scheduled. Publish them, or skip them to let autopilot move on.");
    expect(nextLoopAction(input({ campaigns: [campaign({ status: "review", ready: 1 })] })).reason).toContain("1 video is waiting to be approved and scheduled. Publish it, or skip it");
  });

  it("moves past a review campaign with nothing ready, or one a person skipped", () => {
    expect(nextLoopAction(input({ campaigns: [campaign({ status: "review", ready: 0 })] })).start).toBe(true);
    expect(nextLoopAction(input({ loop: { ...on, waived_campaign_id: "cmp_1" }, campaigns: [campaign({ status: "review" })] })).start).toBe(true);
  });

  it("only the latest campaign's review holds the loop", () => {
    const older = campaign({ id: "cmp_0", status: "review", created_at: ago(20), spent_at: ago(19) });
    expect(nextLoopAction(input({ campaigns: [older, campaign()] })).start).toBe(true);
  });

  it("waits while posts are being submitted", () => {
    expect(nextLoopAction(input({ posts: { inFlight: 1, until: null } }))).toMatchObject({ start: false, code: "posting" });
  });

  it("waits for the last scheduled post, and says when", () => {
    const until = ahead(2);
    expect(nextLoopAction(input({ posts: { inFlight: 0, until } }))).toMatchObject({ start: false, code: "posting", next_at: until });
  });

  it("ignores a scheduled time that has passed", () => {
    expect(nextLoopAction(input({ posts: { inFlight: 0, until: ago(0.1) } })).start).toBe(true);
  });

  it("waits out the cadence from the last campaign's start, and says when", () => {
    const decision = nextLoopAction(input({ campaigns: [campaign({ created_at: ago(3), spent_at: ago(2.5) })] }));
    expect(decision).toMatchObject({ start: false, code: "cadence", next_at: ahead(4) });
  });

  it("starts exactly when the cadence is up", () => {
    expect(nextLoopAction(input({ campaigns: [campaign({ created_at: ago(7), spent_at: ago(8) })] })).start).toBe(true);
  });

  it("honours a shorter cadence", () => {
    expect(nextLoopAction(input({ loop: { ...on, cadence_days: 2 }, campaigns: [campaign({ created_at: ago(3), spent_at: ago(8) })] })).start).toBe(true);
  });

  it("counts a campaign started by a person against the cadence", () => {
    const manual = campaign({ id: "cmp_2", created_at: ago(1), spent_at: ago(0.5) });
    expect(nextLoopAction(input({ campaigns: [campaign(), manual] })).code).toBe("cadence");
  });

  it("refuses for good when the estimate alone is over the budget", () => {
    const decision = nextLoopAction(input({ campaigns: [], estimateMicro: 250 * M }));
    expect(decision).toMatchObject({ start: false, code: "too_expensive" });
    expect(decision.next_at).toBeUndefined();
    expect(decision.reason).toContain("$250.00");
    expect(decision.reason).toContain("$200.00");
  });

  it("starts when spend + estimate lands exactly on the budget", () => {
    expect(nextLoopAction(input({ campaigns: [], estimateMicro: 200 * M })).start).toBe(true);
  });

  it("skips when this week's spend + the estimate is over the budget, with the numbers and when it fits again", () => {
    // Started 7.5 days ago (cadence passed), still changing 2 days ago: its $150 counts until 5 days from now.
    const decision = nextLoopAction(input({ campaigns: [campaign({ created_at: ago(7.5), spent_at: ago(2), spend_micro: 150 * M })] }));
    expect(decision).toMatchObject({ start: false, code: "over_budget", next_at: ahead(5) });
    expect(decision.reason).toBe(`Over budget: $150.00 spent in the last 7 days + up to $60.00 for the next campaign is more than the $200.00 weekly budget. It fits again ${ahead(5).slice(0, 16).replace("T", " ")} UTC.`);
  });

  it("finds the time enough spend has aged out when several campaigns count", () => {
    const campaigns = [
      campaign({ id: "a", created_at: ago(13), spent_at: ago(6), spend_micro: 40 * M }),
      campaign({ id: "b", created_at: ago(12), spent_at: ago(4), spend_micro: 60 * M }),
      campaign({ id: "c", created_at: ago(11), spent_at: ago(1), spend_micro: 90 * M }),
    ];
    // $190 + $60 > $200. After a ages out (in 1 day): $150 + $60 > $200. After b (in 3 days): $90 + $60 fits.
    expect(nextLoopAction(input({ campaigns }))).toMatchObject({ code: "over_budget", next_at: ahead(3) });
  });

  it("does not count spend older than 7 days", () => {
    expect(nextLoopAction(input({ campaigns: [campaign({ spent_at: ago(7.01), spend_micro: 1000 * M })] })).start).toBe(true);
  });

  it("checks waits before money, so a wait is not reported as a budget problem", () => {
    const decision = nextLoopAction(input({ campaigns: [campaign({ created_at: ago(1), spent_at: ago(1), spend_micro: 500 * M })] }));
    expect(decision.code).toBe("cadence");
  });

  it("gives a stable reason for the same state, so it is logged once", () => {
    const state = input({ campaigns: [campaign({ created_at: ago(3) })] });
    expect(nextLoopAction(state)).toEqual(nextLoopAction({ ...state, now: new Date(NOW.getTime() + 4000) }));
  });
});

describe("spendInWindow", () => {
  it("counts a running campaign whatever its age", () => {
    expect(spendInWindow([campaign({ status: "running", spent_at: ago(30), spend_micro: 5 * M })], NOW)).toBe(5 * M);
  });

  it("counts campaigns that changed in the last 7 days only", () => {
    expect(spendInWindow([campaign({ spent_at: ago(1), spend_micro: 5 * M }), campaign({ spent_at: ago(8), spend_micro: 7 * M })], NOW)).toBe(5 * M);
  });
});

// ---------- against the database ----------

const BRAND = "brd_loop";

function insertBrand(id = BRAND) {
  db().prepare("insert into brands (id, name, domain, url, created_at, updated_at) values (?, ?, ?, ?, ?, ?)").run(id, "Loop Co", `${id}.com`, `https://${id}.com`, nowIso(), nowIso());
}

function insertCampaign(fields: { id: string; brand?: string; status: string; created_at: string; updated_at?: string; naive?: number; concepts?: number }) {
  db()
    .prepare(
      `insert into campaigns (id, brand_id, status, stage, options_json, naive_spend_micro, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.id,
      fields.brand ?? BRAND,
      fields.status,
      fields.status === "running" ? "production" : fields.status === "publishing" ? "review" : fields.status,
      JSON.stringify({ concepts: fields.concepts ?? 2, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1", learnStyle: true }),
      fields.naive ?? 0,
      fields.created_at,
      fields.updated_at ?? fields.created_at,
    );
}

let creativeN = 0;
function insertCreative(campaignId: string, fields: { status?: string; reference?: string; rejected?: number; cost?: number } = {}) {
  const id = `crv_${++creativeN}`;
  db()
    .prepare(
      `insert into creatives (id, campaign_id, idx, concept_json, shots_json, status, caption, platforms_json, rejected, cost_micro, created_at, updated_at)
       values (?, ?, 0, ?, '[]', ?, '', '["tiktok"]', ?, ?, ?, ?)`,
    )
    .run(id, campaignId, JSON.stringify({ title: "t", reference: fields.reference ? { url: fields.reference } : undefined }), fields.status ?? "ready", fields.rejected ?? 0, fields.cost ?? 0, nowIso(), nowIso());
  return id;
}

function insertPost(creativeId: string, status: string, scheduledAt: string | null, createdAt = nowIso()) {
  db()
    .prepare("insert into posts (id, creative_id, brand_id, idem, platforms_json, scheduled_at, status, created_at, updated_at) values (?, ?, ?, ?, '[]', ?, ?, ?, ?)")
    .run(`pst_${creativeId}_${status}`, creativeId, BRAND, `idem_${creativeId}_${status}`, scheduledAt, status, createdAt, createdAt);
}

const events = () => db().prepare("select level, message, campaign_id from events where brand_id = ? order by id").all(BRAND) as Array<{ level: string; message: string; campaign_id: string | null }>;
const campaignsOf = (brandId = BRAND) => db().prepare("select id, status from campaigns where brand_id = ? order by created_at").all(brandId) as Array<{ id: string; status: string }>;

beforeEach(() => {
  // brand_loops is part of the store schema; deleting the brands clears it (on delete cascade).
  db().exec("delete from events; delete from settings; delete from brands;");
  insertBrand();
});

describe("loopHistory", () => {
  it("adds up recorded spend and the allowance, and reads open posts", async () => {
    const real = new Date();
    insertCampaign({ id: "cmp_a", status: "publishing", created_at: ago(2, real), naive: 20 * M });
    const crv = insertCreative("cmp_a", { cost: 21 * M });
    insertCreative("cmp_a", { status: "failed" });
    insertCreative("cmp_a", { rejected: 1 });
    insertPost(crv, "scheduled", ahead(3, real));
    const history = await loopHistory(BRAND, real);
    expect(history.campaigns).toHaveLength(1);
    // fresh $21 beats stored $20; 3 video rows beat 2 planned; the one ready video is scheduled, so none waits
    expect(history.campaigns[0]).toMatchObject({ spend_micro: 21 * M + 3 * UNTRACKED_USD_PER_VIDEO * M, ready: 0 });
    expect(history.posts).toEqual({ inFlight: 0, until: ahead(3, real) });
  });

  it("counts only the videos not yet posted as waiting for review", async () => {
    const real = new Date();
    insertCampaign({ id: "cmp_a", status: "review", created_at: ago(1, real) });
    insertPost(insertCreative("cmp_a"), "posted", null);
    insertPost(insertCreative("cmp_a"), "failed", null); // a failed post can be sent again
    insertCreative("cmp_a");
    expect((await loopHistory(BRAND, real)).campaigns[0].ready).toBe(2);
  });

  it("stops counting a post stuck in processing a day after it was due", async () => {
    const real = new Date();
    insertCampaign({ id: "cmp_a", status: "publishing", created_at: ago(5, real) });
    insertPost(insertCreative("cmp_a"), "processing", ago(2, real), ago(3, real));
    expect((await loopHistory(BRAND, real)).posts.inFlight).toBe(0);
    insertPost(insertCreative("cmp_a"), "pending", null);
    expect((await loopHistory(BRAND, real)).posts.inFlight).toBe(1);
  });
});

describe("advanceLoop", () => {
  const enable = (budgetUsd = 500, extra: Partial<LoopSettings> = {}) => saveLoop(BRAND, { ...DEFAULT_LOOP, enabled: true, weekly_budget_micro: budgetUsd * M, ...extra });

  it("does nothing for a brand that never turned it on", async () => {
    await advanceLoop();
    expect(campaignsOf()).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("does nothing when turned off", async () => {
    await enable(500, { enabled: false });
    await advanceLoop();
    expect(campaignsOf()).toEqual([]);
  });

  it("starts a campaign once, logs why, and then waits for it", async () => {
    await enable();
    await advanceLoop();
    const [started] = campaignsOf();
    expect(started.status).toBe("running");
    const logged = events().filter((e) => e.message.startsWith("Autopilot"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ campaign_id: started.id });
    expect(logged[0].message).toMatch(/^Autopilot started campaign 1\. No campaign yet; \$0\.00 spent/);

    await advanceLoop();
    await advanceLoop();
    expect(campaignsOf()).toHaveLength(1);
    expect(events().filter((e) => e.message.startsWith("Autopilot"))).toHaveLength(1);
    expect((await getLoop(BRAND)).last).toMatchObject({ code: "running" });
  });

  it("logs a wait once, not on every tick, and again when it changes", async () => {
    await enable();
    const real = new Date();
    insertCampaign({ id: "cmp_a", status: "live", created_at: ago(2, real) });
    await advanceLoop(real);
    await advanceLoop(new Date(real.getTime() + 4000));
    await advanceLoop(new Date(real.getTime() + 8000));
    const waits = events().filter((e) => e.message.startsWith("Autopilot is waiting"));
    expect(waits).toHaveLength(1);
    expect(waits[0].message).toContain("Campaign 1 started less than 7 days ago");

    await saveLoop(BRAND, { ...(await getLoop(BRAND)), cadence_days: 1, weekly_budget_micro: 10 * M });
    await advanceLoop(real);
    const latest = events().at(-1)!;
    expect(latest.level).toBe("warn");
    expect(latest.message).toContain("more than the whole weekly budget of $10.00");
    expect(campaignsOf()).toHaveLength(1);
  });

  it("skips with the numbers when this week's spend leaves no room", async () => {
    await enable(150, { cadence_days: 1 });
    const real = new Date();
    insertCampaign({ id: "cmp_a", status: "live", created_at: ago(3, real), updated_at: ago(2, real), naive: 40 * M, concepts: 2 });
    await advanceLoop(real);
    expect(campaignsOf()).toHaveLength(1);
    const latest = events().at(-1)!;
    // $40 recorded + 2 x $2 allowance; the default 4-video estimate is $124.20
    expect(latest).toMatchObject({ level: "warn" });
    expect(latest.message).toContain("Over budget: $44.00 spent in the last 7 days + up to $124.20 for the next campaign is more than the $150.00 weekly budget.");
  });

  it("waits for a person to post the last campaign, then moves on when they skip it", async () => {
    await enable();
    const real = new Date();
    insertCampaign({ id: "cmp_a", status: "review", created_at: ago(9, real) });
    insertCreative("cmp_a");
    await advanceLoop(real);
    expect((await getLoop(BRAND)).last).toMatchObject({ code: "review" });
    expect(campaignsOf()).toHaveLength(1);

    await updateLoop(BRAND, { skipCampaignId: "cmp_a" });
    await advanceLoop(real);
    expect(campaignsOf()).toHaveLength(2);
  });

  it("never starts for a loop that is on with no budget, and leaves other brands alone", async () => {
    insertBrand("brd_other");
    await saveLoop("brd_other", { ...DEFAULT_LOOP, enabled: true, weekly_budget_micro: 0 });
    await enable(500, { enabled: false });
    await advanceLoop();
    expect(campaignsOf()).toEqual([]);
    expect(campaignsOf("brd_other")).toEqual([]);
    expect((await getLoop("brd_other")).last).toMatchObject({ code: "no_budget" });
  });
});

describe("updateLoop", () => {
  it("refuses to turn on without a budget", async () => {
    await expect(updateLoop(BRAND, { enabled: true })).rejects.toThrow("Set a weekly budget before turning autopilot on.");
    await expect(updateLoop(BRAND, { enabled: true, weeklyBudgetUsd: 0 })).rejects.toThrow("Set a weekly budget");
    expect((await getLoop(BRAND)).enabled).toBe(false);
  });

  it("refuses to clear the budget of a loop that is on", async () => {
    await updateLoop(BRAND, { enabled: true, weeklyBudgetUsd: 100 });
    await expect(updateLoop(BRAND, { weeklyBudgetUsd: 0 })).rejects.toThrow("Autopilot is on, so it needs a weekly budget above $0. Turn it off first.");
    expect((await getLoop(BRAND)).weekly_budget_micro).toBe(100 * M);
  });

  it("validates the numbers", async () => {
    await expect(updateLoop(BRAND, { weeklyBudgetUsd: -5 })).rejects.toThrow();
    await expect(updateLoop(BRAND, { weeklyBudgetUsd: "lots" })).rejects.toThrow();
    await expect(updateLoop(BRAND, { weeklyBudgetUsd: "" })).rejects.toThrow();
    await expect(updateLoop(BRAND, { cadenceDays: 0 })).rejects.toThrow();
    await expect(updateLoop(BRAND, { cadenceDays: 2.5 })).rejects.toThrow();
  });

  it("stores the settings and logs what changed", async () => {
    await updateLoop(BRAND, { enabled: true, weeklyBudgetUsd: "75.5", cadenceDays: 3, autopost: true });
    expect(await getLoop(BRAND)).toMatchObject({ enabled: true, weekly_budget_micro: 75.5 * M, cadence_days: 3, autopost: true });
    expect(events().at(-1)!.message).toBe(
      "Autopilot settings changed by you: turned on; weekly budget $75.50; a campaign every 3 days; finished videos are approved and scheduled automatically",
    );
  });

  it("only skips this brand's campaigns", async () => {
    insertBrand("brd_other");
    insertCampaign({ id: "cmp_other", brand: "brd_other", status: "review", created_at: nowIso() });
    await expect(updateLoop(BRAND, { skipCampaignId: "cmp_other" })).rejects.toThrow("No such campaign for this brand.");
  });
});

describe("autopostOn", () => {
  it("needs the loop on and posting on", async () => {
    expect(await autopostOn(BRAND)).toBe(false);
    await saveLoop(BRAND, { ...DEFAULT_LOOP, enabled: true, weekly_budget_micro: M, autopost: false });
    expect(await autopostOn(BRAND)).toBe(false);
    await saveLoop(BRAND, { ...DEFAULT_LOOP, enabled: false, weekly_budget_micro: M, autopost: true });
    expect(await autopostOn(BRAND)).toBe(false);
    await saveLoop(BRAND, { ...DEFAULT_LOOP, enabled: true, weekly_budget_micro: M, autopost: true });
    expect(await autopostOn(BRAND)).toBe(true);
  });
});

describe("loop API", () => {
  const ctx = (id = BRAND) => ({ params: Promise.resolve({ id }) });
  const post = (payload: unknown, id = BRAND) => loopPost(new Request(`http://localhost/api/brands/${id}/loop`, { method: "POST", body: JSON.stringify(payload) }), ctx(id));

  it("answers 404 for an unknown brand", async () => {
    expect((await loopGet(new Request("http://localhost/api/brands/nope/loop"), ctx("nope"))).status).toBe(404);
  });

  it("starts off, with no budget", async () => {
    const view = await (await loopGet(new Request(`http://localhost/api/brands/${BRAND}/loop`), ctx())).json();
    expect(view.settings).toEqual({ enabled: false, weeklyBudgetUsd: 0, cadenceDays: 7, autopost: false });
    expect(view.status).toMatchObject({ decision: { start: false, code: "off" }, nextRunAt: null, spendThisWeekUsd: 0, last: null });
    expect(view.status.estimateUsd).toBeGreaterThan(0);
  });

  it("refuses to turn on without a budget, and turns on with one", async () => {
    const refused = await post({ enabled: true });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Set a weekly budget before turning autopilot on." });

    const accepted = await post({ enabled: true, weeklyBudgetUsd: 300, cadenceDays: 7, autopost: false });
    expect(accepted.status).toBe(200);
    const view = await accepted.json();
    expect(view.settings).toEqual({ enabled: true, weeklyBudgetUsd: 300, cadenceDays: 7, autopost: false });
    // No campaign yet and $124.20 fits $300: the worker starts one on its next tick.
    expect(view.status.decision).toMatchObject({ start: true, code: "start" });
    expect(view.status.nextRunAt).not.toBeNull();
    expect(campaignsOf()).toEqual([]);
  });
});

describe("remadeReferences", () => {
  it("lists the references this brand remade in its other campaigns", async () => {
    insertBrand("brd_other");
    insertCampaign({ id: "cmp_old", status: "live", created_at: ago(14, new Date()) });
    insertCampaign({ id: "cmp_new", status: "running", created_at: nowIso() });
    insertCampaign({ id: "cmp_theirs", brand: "brd_other", status: "live", created_at: nowIso() });
    insertCreative("cmp_old", { reference: "https://www.tiktok.com/@a/video/1" });
    insertCreative("cmp_old", { reference: "https://www.tiktok.com/@a/video/1", rejected: 1 });
    insertCreative("cmp_old", { reference: "https://www.tiktok.com/@b/video/2", rejected: 1 });
    insertCreative("cmp_old", { reference: "https://www.tiktok.com/@c/video/3", status: "failed" });
    insertCreative("cmp_old");
    insertCreative("cmp_new", { reference: "https://www.tiktok.com/@d/video/4" });
    insertCreative("cmp_theirs", { reference: "https://www.tiktok.com/@e/video/5" });
    expect((await remadeReferences(BRAND, "cmp_new")).sort()).toEqual(["https://www.tiktok.com/@a/video/1", "https://www.tiktok.com/@b/video/2"]);
  });
});
