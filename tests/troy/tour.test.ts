import { describe, expect, it } from "vitest";
import { advance, approveAll, type DemoScript, type DemoState, freshState, publish, seek, timeline } from "@/components/troy/camp/demo";
import { SAMPLE } from "@/components/troy/camp/sample";
import { tourSteps } from "@/components/troy/camp/tour";

// The presenter's tour walks a replay one part of the work at a time. These tests pin which steps
// it has, where each one moves and holds the clock, and that its captions read the recording.

const at = (t: number, extra: Partial<DemoState> = {}): DemoState => ({ ...freshState(0), t, ...extra });

/** The sample, as a recording with format checks in its scouts' lines and a reason per video. */
const recording: DemoScript = {
  ...SAMPLE,
  recorded: true,
  events: [
    ...SAMPLE.events,
    { s: 30, level: "info", message: 'Scout: format check, 3D "what if" simulation shorts are breaking out: @a 11.5M views, @b 11.0M views.' },
    { s: 31, level: "info", message: "Scout: format check, brainrot memes break out on tiny accounts: @c 102.8M views on 42K followers (2457x)." },
  ],
  creatives: SAMPLE.creatives.map((c, i) => ({ ...c, concept: c.concept && { ...c.concept, format: i === 0 ? "code ad (3D animation)" : "brainrot meme", why: `Reason ${i + 1} from the research.` } })),
};

describe("the tour", () => {
  const steps = tourSteps(recording);
  const tl = timeline(recording);
  const videos = recording.creatives.slice().sort((a, b) => a.idx - b.idx);

  it("walks the campaign from the website to the next campaign, one step per part of the work", () => {
    expect(steps.map((s) => s.key)).toEqual([
      "start",
      "scouts",
      "findings",
      ...(tl.style ? ["oracle"] : []),
      "tent",
      "workshop",
      ...videos.map((c) => `video-${c.idx}`),
      "post",
      "battle",
      "loop",
    ]);
    expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length);
  });

  it("pulls the camera back while the scouts ride, and opens the station each step is about", () => {
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(by.scouts).toMatchObject({ camera: "world", station: null });
    expect(by.findings.station).toBe("scouts");
    expect(by.tent).toMatchObject({ station: "tent", focus: "concepts" });
    expect(by.workshop.station).toBe("workshop");
    expect(by[`video-${videos[0].idx}`]).toMatchObject({ station: "theatre", video: videos[0].idx });
    expect(by.post).toMatchObject({ station: "agora", post: true, run: 6 });
    expect(by.loop.hold).toBe("end");
  });

  it("holds each stage until what it made is on screen, and never before the step starts", () => {
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(by.findings.hold).toBeGreaterThanOrEqual(tl.research[1]);
    expect(by.tent.hold).toBeGreaterThanOrEqual(tl.strategy[1]);
    expect(by.workshop.hold).toBeLessThan(tl.review);
    for (const step of steps) if (step.at !== undefined && typeof step.hold === "number") expect(step.hold, step.key).toBeGreaterThanOrEqual(step.at);
  });

  it("reads its captions from the recording", () => {
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(by.start.title).toBe(`${recording.brand.domain} goes in`);
    expect(by.findings.body).toContain(`${recording.research!.videos} top videos`);
    expect(by.findings.body).toContain('Format checks found that 3D "what if" simulation shorts are breaking out and brainrot memes break out on tiny accounts.');
    expect(by.tent.body).toContain("a code ad (3D animation) and three brainrot meme videos.");
    expect(by.workshop.body).toContain("the 3D ad is animated in code");
    expect(tourSteps({ ...recording, creatives: recording.creatives.map((c) => ({ ...c, concept: c.concept && { ...c.concept, format: "organic talking head" } })) }).find((s) => s.key === "workshop")!.body).toContain("an original on the research's best formula, with an AI creator");
    expect(by[`video-${videos[0].idx}`].body).toBe("Code ad (3D animation). Reason 1 from the research.");
    expect(by[`video-${videos[0].idx}`].title).toBe(`Video 1: ${videos[0].concept?.title}`);
  });
});

describe("the tour's real creators", () => {
  it("adds a step for the briefs cast to creators, with the client's verdicts", () => {
    const casting = { status: "approved", pick: { handle: "maker" }, reviews: [{ creator: "loud", approve: false, score: 3.5 }, { creator: "maker", approve: true, score: 8 }] };
    const script: DemoScript = { ...recording, creatives: recording.creatives.map((c, i) => (i === 1 ? { ...c, concept: c.concept && ({ ...c.concept, casting } as typeof c.concept) } : c)) };
    const steps = tourSteps(script);
    const creators = steps.find((s) => s.key === "creators")!;
    expect(creators).toMatchObject({ station: "theatre", focus: "creators" });
    expect(creators.body).toContain("turned down 1 of them and approved @maker (8/10)");
    expect(steps.map((s) => s.key).indexOf("creators")).toBe(steps.map((s) => s.key).indexOf("post") - 1);
    expect(tourSteps(recording).some((s) => s.key === "creators")).toBe(false);
    // One creator approved for two briefs is named once.
    const twice: DemoScript = { ...recording, creatives: recording.creatives.map((c, i) => (i < 2 ? { ...c, concept: c.concept && ({ ...c.concept, casting } as typeof c.concept) } : c)) };
    expect(tourSteps(twice).find((s) => s.key === "creators")!.body).toContain("approved @maker (8/10) for two briefs.");
  });
});

describe("the clock under the tour", () => {
  it("stops at a step's hold, and a hold already passed leaves it where it is", () => {
    expect(advance(SAMPLE, at(10), 5, false, 12).t).toBe(12);
    expect(advance(SAMPLE, at(10), 5, false, 8).t).toBe(10);
    expect(advance(SAMPLE, at(10), 1, false).t).toBe(11);
  });

  it("seeks back before the review with nothing approved or posted, and before the posting un-posts", () => {
    const tl = timeline(SAMPLE);
    const posted = publish(SAMPLE, approveAll(SAMPLE, at(tl.review)), "now");
    expect(posted.publish).not.toBeNull();
    const back = seek(SAMPLE, { ...posted, t: tl.review + 5 }, tl.review);
    expect(back.publish).toBeNull();
    expect(Object.values(back.approved).every(Boolean)).toBe(true);
    expect(seek(SAMPLE, posted, tl.strategy[0])).toMatchObject({ t: tl.strategy[0], approved: {}, publish: null });
  });
});
