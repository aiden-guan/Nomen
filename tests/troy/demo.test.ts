import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advance,
  approveAll,
  type DemoScript,
  type DemoState,
  freshState,
  ILLUSTRATIVE_RATIOS,
  illustrativeNumbers,
  isScript,
  jump,
  limit,
  loadDemoScript,
  placeEvents,
  publish,
  REVIEW_HOLD,
  replay,
  timeline,
} from "@/components/troy/camp/demo";
import { SAMPLE } from "@/components/troy/camp/sample";
import { derive } from "@/components/troy/scenes/derive";

// The demo camp replays a campaign on a clock. These tests pin the clock, the review that waits
// for the presenter, posting, the presenter's skips, where event lines land and how recordings load.

const ORIGIN = Date.UTC(2026, 10, 9, 10, 0, 0);
const at = (t: number, extra: Partial<DemoState> = {}): DemoState => ({ ...freshState(ORIGIN), t, ...extra });
const campaignAt = (t: number, extra: Partial<DemoState> = {}) => replay(SAMPLE, at(t, extra)).campaign!;

/** Runs the clock in small steps, as the camp does. */
function play(script: DemoScript, state: DemoState, seconds: number, auto = false) {
  let s = state;
  for (let i = 0; i < seconds * 4; i++) s = advance(script, s, 0.25, auto);
  return s;
}

describe("the demo clock", () => {
  it("gives every stage its window", () => {
    expect(timeline(SAMPLE)).toMatchObject({ research: [0, 42], style: [42, 50], strategy: [50, 59], production: [59, 88], review: 88 });
    const noStyle = timeline({ ...SAMPLE, style: null });
    expect(noStyle.style).toBeNull();
    expect(noStyle.strategy).toEqual([42, 51]);
  });

  it("walks through research, the format study, the strategy and production", () => {
    expect(campaignAt(0)).toMatchObject({ stage: "research", status: "running", plan: null, research: null, creatives: [] });
    expect(campaignAt(5).runs.filter((r) => r.status === "running").map((r) => r.phase)).toEqual(["A", "A", "A", "A", "A"]);
    expect(campaignAt(12).plan?.category).toBe("olive oil soap");
    expect(campaignAt(20).runs.some((r) => r.status === "running")).toBe(true);
    const style = campaignAt(43);
    expect(style.stage).toBe("style");
    expect(style.research?.videos).toHaveLength(24);
    expect(style.runs.filter((r) => r.status === "failed").map((r) => r.key)).toEqual(["aeo_perplexity"]);
    expect(campaignAt(51).stage).toBe("strategy");
    expect(campaignAt(51).style).not.toBeNull();
    const making = campaignAt(72);
    expect(making.stage).toBe("production");
    expect(making.strategy?.campaign.name).toBe("Clean Hands, Short Story");
    expect(new Set(making.creatives.map((c) => c.status))).toEqual(new Set(["producing"]));
  });

  it("finishes every video by the review and then waits for the presenter", () => {
    const review = campaignAt(88);
    expect(review).toMatchObject({ stage: "review", status: "review" });
    expect(review.creatives.every((c) => c.status === "ready" && c.posterUrl && !c.approved)).toBe(true);
    expect(review.spend.naive).toBeCloseTo(SAMPLE.spend.naive, 5);
    const waited = play(SAMPLE, at(82), 60);
    expect(waited.t).toBe(timeline(SAMPLE).review + REVIEW_HOLD);
  });

  it("keeps event timestamps fixed while the clock runs, so dispatches don't repeat", () => {
    const early = replay(SAMPLE, at(40)).events;
    const later = replay(SAMPLE, at(45)).events;
    for (const event of early) expect(later).toContainEqual(event);
  });

  it("builds views the camp can draw at every moment", () => {
    for (let t = 0; t <= 100; t += 0.5) {
      const plan = derive(replay(SAMPLE, at(t)));
      expect(Object.keys(plan.stations)).toHaveLength(6);
    }
  });
});

describe("the review and posting", () => {
  const ready = at(timeline(SAMPLE).review + 1);

  it("posts only approved videos, and only once something is approved", () => {
    expect(publish(SAMPLE, ready, "now")).toBe(ready);
    const one = publish(SAMPLE, { ...ready, approved: { 2: true } }, "now");
    expect(one.publish).toMatchObject({ mode: "now", ids: [2] });
    expect(publish(SAMPLE, one, "daily")).toBe(one);
  });

  it("can't approve or post before the videos are ready", () => {
    const early = at(75);
    expect(approveAll(SAMPLE, early)).toBe(early);
    expect(publish(SAMPLE, { ...early, approved: { 0: true } }, "now")).toEqual({ ...early, approved: { 0: true } });
  });

  it("posts now: queued, sent, out, then live", () => {
    const sent = publish(SAMPLE, approveAll(SAMPLE, ready), "now");
    const P = sent.publish!.at;
    const queued = replay(SAMPLE, { ...sent, t: P }).campaign!;
    expect(queued).toMatchObject({ stage: "review", status: "publishing" });
    expect(queued.posts.map((p) => p.status)).toEqual(["pending", "pending", "pending", "pending"]);
    const going = replay(SAMPLE, { ...sent, t: P + 5 }).campaign!;
    expect(going.posts.map((p) => p.status)).toContain("posted");
    expect(going.status).toBe("publishing");
    const done = replay(SAMPLE, { ...sent, t: limit(SAMPLE, sent, false) });
    expect(done.campaign).toMatchObject({ stage: "live", status: "live" });
    expect(done.campaign!.posts.every((p) => p.status === "posted" && p.analytics)).toBe(true);
    expect(done.events.map((e) => e.message)).toEqual(expect.arrayContaining(["Queued 4 posts to go out now", "Post submitted: tiktok, instagram", "4 of 4 videos are ready for review"]));
    // While they go out the agora works; once all are out it is done.
    expect(derive(replay(SAMPLE, { ...sent, t: P + 5 })).stations).toMatchObject({ theatre: { state: "done" }, agora: { state: "working" } });
    const plan = derive(done);
    expect(plan.stations.agora.state).toBe("done");
    expect(plan.stations.theatre.state).toBe("done");
  });

  it("posts one a day at 16:00 UTC, the first slot at least half an hour away", () => {
    const sent = publish(SAMPLE, approveAll(SAMPLE, ready), "daily");
    const done = replay(SAMPLE, { ...sent, t: limit(SAMPLE, sent, false) }).campaign!;
    expect(done.status).toBe("live");
    const slots = done.posts.map((p) => p.scheduledAt!);
    expect(done.posts.every((p) => p.status === "scheduled" && !p.analytics)).toBe(true);
    const sentAt = ORIGIN + sent.publish!.at * 1000;
    expect(Date.parse(slots[0]) - sentAt).toBeGreaterThanOrEqual(30 * 60 * 1000);
    slots.forEach((slot, i) => {
      expect(new Date(slot).getUTCHours()).toBe(16);
      if (i) expect(Date.parse(slot) - Date.parse(slots[i - 1])).toBe(86_400_000);
    });
  });

  it("autoplay approves each video and posts them without anyone touching it", () => {
    const end = play(SAMPLE, at(82), 40, true);
    expect(end.publish?.ids).toEqual([0, 1, 2, 3]);
    expect(replay(SAMPLE, end).campaign!.status).toBe("live");
  });

  it("autoplay leaves a video alone if the presenter unticked it", () => {
    const end = play(SAMPLE, at(82, { approved: { 1: false } }), 40, true);
    expect(end.publish?.ids).toEqual([0, 2, 3]);
  });
});

describe("the presenter's skips", () => {
  it("skips to the next stage, and at the review approves and posts everything", () => {
    let s = at(3);
    const visited: string[] = [];
    for (let i = 0; i < 5; i++) {
      s = jump(SAMPLE, s, 1);
      visited.push(replay(SAMPLE, s).campaign!.stage);
    }
    expect(visited).toEqual(["style", "strategy", "production", "review", "review"]);
    expect(s.publish?.mode).toBe("now");
    s = jump(SAMPLE, s, 1);
    expect(replay(SAMPLE, s).campaign!.status).toBe("live");
  });

  it("goes back a stage, undoing the review", () => {
    const posted = jump(SAMPLE, jump(SAMPLE, at(88), 1), 1);
    const back = jump(SAMPLE, posted, -1);
    expect(back.publish).toBeNull();
    expect(back.t).toBe(timeline(SAMPLE).review);
    const before = jump(SAMPLE, back, -1);
    expect(before).toMatchObject({ t: timeline(SAMPLE).production[0], approved: {}, publish: null });
    expect(jump(SAMPLE, at(0.5), -1).t).toBe(0);
  });
});

describe("event lines on the clock", () => {
  it("puts step lines exactly where the camp shows the step", () => {
    const lines = placeEvents(SAMPLE);
    const find = (start: string) => lines.find((l) => l.message.startsWith(start))!.at;
    const tl = timeline(SAMPLE);
    expect(find("Campaign started")).toBe(0);
    expect(find("Research done")).toBeCloseTo(tl.research[1] - 0.6);
    expect(find("Format study ready")).toBeCloseTo(tl.style![1] - 0.5);
    expect(find('Campaign "Clean Hands')).toBeCloseTo(tl.strategy[1] - 0.4);
    // A video's "is ready" line lands when that video turns ready.
    const third = find('"What\'s actually in it" is ready');
    expect(campaignAt(third - 0.05).creatives[2].status).toBe("producing");
    expect(campaignAt(third).creatives[2].status).toBe("ready");
  });

  it("maps a recording's real timeline onto the clock, monotonically, and drops review and posting lines", () => {
    const recorded: DemoScript = {
      ...SAMPLE,
      recorded: true,
      events: [
        { s: 0, level: "info", message: "Campaign started: 4 videos, 2 shots each, google/veo-3.1" },
        { s: 40, level: "info", message: "Research plan: olive oil soap; competitors none; searching soap" },
        { s: 300, level: "warn", message: "Monid balance is too low for some research. Top up at app.monid.ai/wallet." },
        { s: 600, level: "info", message: "Research done: 24 top videos, 12 live ads, 10 Reddit threads, 18 keywords (15/16 sources)" },
        { s: 700, level: "info", message: "Studying the format of 3 top-performing videos frame by frame" },
        { s: 900, level: "info", message: "The strategist is writing the brand brief and 4 concepts" },
        { s: 1100, level: "info", message: 'Campaign "Clean Hands, Short Story": 4 concepts, now producing' },
        { s: 1500, level: "info", message: "Shot 1 is rendering on Monid (Kling 3.0) because Naive is unavailable" },
        { s: 2400, level: "info", message: "4 of 4 videos are ready for review" },
        { s: 2500, level: "info", message: "Queued 4 posts one per day" },
      ],
    };
    const lines = placeEvents(recorded);
    const times = lines.map((l) => l.at);
    expect(lines.map((l) => l.message)).not.toContain("4 of 4 videos are ready for review");
    expect(lines.map((l) => l.message)).not.toContain("Queued 4 posts one per day");
    const tl = timeline(recorded);
    const balance = lines.find((l) => l.message.startsWith("Monid balance"))!.at;
    expect(balance).toBeGreaterThan(0);
    expect(balance).toBeLessThan(tl.research[1]);
    const kling = lines.find((l) => l.message.startsWith("Shot 1 is rendering"))!.at;
    expect(kling).toBeGreaterThan(tl.production[0]);
    expect(kling).toBeLessThan(tl.production[1]);
    expect(times.every((t) => t >= 0 && t <= tl.review)).toBe(true);
  });
});

describe("loading a recording", () => {
  const recording: DemoScript = {
    ...SAMPLE,
    recorded: true,
    brand: { ...SAMPLE.brand, name: "Acme", domain: "acme.example", profile: { ...SAMPLE.brand.profile!, logo: "logo.png" } },
    creatives: SAMPLE.creatives.map((c, i) => ({ ...c, video: `${i + 1}.mp4`, poster: i === 0 ? "https://cdn.example/1.jpg" : `${i + 1}.jpg` })),
  };
  const serve = (files: Record<string, unknown>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url in files ? new Response(JSON.stringify(files[url]), { status: 200 }) : new Response("Not found", { status: 404 }))),
    );
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("checks a script's shape", () => {
    expect(isScript(SAMPLE)).toBe(true);
    expect(isScript({ ...SAMPLE, version: 2 })).toBe(false);
    expect(isScript({ ...SAMPLE, creatives: [] })).toBe(false);
    expect(isScript(null)).toBe(false);
  });

  it("plays the sample when no recording is installed", async () => {
    serve({});
    expect(await loadDemoScript("acme.example")).toBe(SAMPLE);
  });

  it("finds the recording for the typed website, with its files in its folder", async () => {
    serve({ "/demo/index.json": { scripts: [{ id: "other", domain: "other.example" }, { id: "acme", domain: "acme.example" }] }, "/demo/acme/script.json": recording });
    const loaded = await loadDemoScript("https://www.Acme.example/pricing");
    expect(loaded.brand.name).toBe("Acme");
    expect(loaded.brand.profile?.logo).toBe("/demo/acme/logo.png");
    expect(loaded.creatives[0]).toMatchObject({ video: "/demo/acme/1.mp4", poster: "https://cdn.example/1.jpg" });
    expect(loaded.creatives[1].poster).toBe("/demo/acme/2.jpg");
  });

  it("finds a recording by another name it answers to", async () => {
    serve({ "/demo/index.json": { scripts: [{ id: "other", domain: "other.example" }, { id: "acme", domain: "acme.example", aliases: ["acme.ai"] }] }, "/demo/acme/script.json": recording });
    expect((await loadDemoScript("www.acme.ai")).brand.name).toBe("Acme");
  });

  it("plays the newest recording for any other website, and the sample if that one is broken", async () => {
    serve({ "/demo/index.json": { scripts: [{ id: "acme", domain: "acme.example" }] }, "/demo/acme/script.json": recording });
    expect((await loadDemoScript("someone-else.com")).brand.name).toBe("Acme");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    serve({ "/demo/index.json": { scripts: [{ id: "acme", domain: "acme.example" }] }, "/demo/acme/script.json": { version: 1 } });
    expect(await loadDemoScript("acme.example")).toBe(SAMPLE);
    serve({ "/demo/index.json": { scripts: [{ id: "../etc", domain: "acme.example" }] } });
    expect(await loadDemoScript("acme.example")).toBe(SAMPLE);
  });
});

describe("illustrative numbers", () => {
  // A recording's videos weren't posted: no numbers of their own, so the replay gives them some.
  const unposted: DemoScript = { ...SAMPLE, recorded: true, creatives: SAMPLE.creatives.map((c) => ({ ...c, analytics: null })) };

  /** Approves and posts every video at the review, then runs the clock to the end. */
  function posted(script: DemoScript) {
    const review = at(timeline(script).review);
    return play(script, publish(script, approveAll(script, review), "now"), 40);
  }

  it("gives a recording without numbers illustrative ones against its benchmark, and marks them", () => {
    expect(illustrativeNumbers(unposted)).toBe(true);
    const battle = derive(replay(unposted, posted(unposted))).battle;
    expect(battle.illustrative).toBe(true);
    const order = unposted.creatives.slice().sort((a, b) => a.idx - b.idx);
    battle.companies.forEach((company) => {
      const k = order.findIndex((c) => c.idx === company.idx);
      expect(company.ratio).toBeCloseTo(ILLUSTRATIVE_RATIOS[k % ILLUSTRATIVE_RATIOS.length], 2);
    });
  });

  it("keeps real numbers, and makes none up without a benchmark", () => {
    expect(illustrativeNumbers(SAMPLE)).toBe(false);
    expect(derive(replay(SAMPLE, posted(SAMPLE))).battle.illustrative).toBe(false);
    const noBenchmark: DemoScript = { ...unposted, research: unposted.research && { ...unposted.research, benchmark: null } };
    expect(illustrativeNumbers(noBenchmark)).toBe(false);
    expect(replay(noBenchmark, posted(noBenchmark)).campaign!.posts.every((p) => p.analytics === null)).toBe(true);
  });
});
