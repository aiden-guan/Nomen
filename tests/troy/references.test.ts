import { describe, expect, it } from "vitest";
import type { BrandView } from "@/components/troy/api";
import { compact, remakeLine } from "@/components/troy/camp/format";
import { derive, scriptRoom, stationForEvent, studyStep } from "@/components/troy/scenes/derive";
import type { CreativeState } from "@/lib/pipeline";
import type { Video } from "@/lib/research";
import { referencesView, studyView } from "@/lib/views";

// The camp follows the creative engine live: the oracle's reference study (which viral videos it
// broke down, which it set aside and why), the director's briefs and the script room, and which of
// our videos remakes which reference.

const video = (url: string, extra: Partial<Video> = {}): Video => ({
  platform: "tiktok",
  url,
  caption: `caption of ${url}`,
  views: 1_200_000,
  likes: 80_000,
  comments: 900,
  shares: 2_000,
  saves: 3_000,
  duration: 23,
  author: url.split("/")[3]?.replace("@", "") ?? "someone",
  followers: 12_000,
  paid: false,
  thumbnail: `https://cdn.example/${url.split("/").pop()}.jpg`,
  media_url: null,
  source: "tiktok_0",
  ...extra,
});

const breakdown = (id: string, url: string, author: string) => ({
  id,
  url,
  platform: "tiktok" as const,
  author,
  views: 1_200_000,
  followers: 12_000,
  outlier: 100,
  duration: 23,
  format: "talking head with screen cutaways",
  hook: { line: "Stop paying for twelve API keys", on_screen_text: "12 keys??", visual: "deadpan", mechanic: "absurd number + command" },
  beats: [{ start: 0, end: 2, job: "hook" as const, shot: "talking_head" as const, visual: "creator", on_screen_text: "", line: "Stop" }],
  pacing: { cuts: 4, avg_shot_seconds: 4, words_per_minute: 160 },
  caption_style: "white bold",
  delivery: "deadpan",
  why_it_works: "an absurd number in the first second",
  fit: { score: 9, reason: "same buyer" },
  transcript: "Stop paying for twelve API keys",
});

const A = "https://www.tiktok.com/@dev/video/1";
const B = "https://www.tiktok.com/@rival/video/2";
const C = "https://www.tiktok.com/@chef/video/3";
const D = "https://www.tiktok.com/@cat/video/4";

const score = (why: string) => ({ outlier: 100, engagement: 0.07, total: 9, why });

const state: CreativeState = {
  slug: null,
  version: null,
  skill_md: "",
  samples: [A],
  product: { name: "Monid", one_liner: "One balance for every API", kind: "software", audience: "", problem: "", aha: "", features: [], claims: [], proof: [], objections: [], offer: "", voice: "", look: "", visuals: [{ id: "k1", kind: "photo", url: "/kit/logo.png", caption: "logo", source: "brandkit:upload" }] },
  captured: true,
  screened: [
    { url: A, relevance: 9, reason: "same buyer, same pain" },
    { url: B, relevance: 7, reason: "a competitor's demo" },
    { url: C, relevance: 3, reason: "a cooking video: nothing to remake for an API" },
    { url: D, relevance: 7, reason: "a format that transfers" },
  ],
  candidates: [
    { url: A, platform: "tiktok", author: "dev", views: 1_200_000, followers: 12_000, origin: "category", score: score("100x the account's followers"), relevance: 9, relevance_reason: "same buyer, same pain" },
    { url: B, platform: "tiktok", author: "rival", views: 400_000, followers: 50_000, origin: "competitor", score: score("8x the account's followers"), relevance: 7 },
    { url: D, platform: "tiktok", author: "cat", views: 90_000, followers: 1_000, origin: "adjacent", score: score("90x"), relevance: 7 },
  ],
  picked: [A, B],
  breakdowns: [breakdown("ref_1", A, "dev")],
  failures: [{ url: B, error: "the video could not be downloaded" }],
  retry: [],
};

const videos = new Map([A, B, C, D].map((url) => [url, video(url, url === B ? { source: "tiktok_comp_0", views: 400_000 } : {})]));

describe("the reference view", () => {
  it("lists what was broken down, what failed and what was set aside, with the video's numbers", () => {
    const refs = referencesView(state, videos, [{ id: "ref_1", url: A, title: "Twelve keys", creativeId: "crv_1" }]);
    expect(refs.map((r) => [r.author, r.status])).toEqual([
      ["dev", "studied"],
      ["rival", "unreadable"],
      ["cat", "shortlisted"],
      ["chef", "dropped"],
    ]);
    const [studied, failed, , dropped] = refs;
    expect(studied).toMatchObject({
      id: "ref_1",
      thumbnail: "https://cdn.example/1.jpg",
      views: 1_200_000,
      followers: 12_000,
      outlier: 100,
      likes: 80_000,
      saves: 3_000,
      shares: 2_000,
      comments: 900,
      duration: 23,
      lane: "category",
      hook: { line: "Stop paying for twelve API keys", mechanic: "absurd number + command" },
      fit: { score: 9 },
      whyItWorks: "an absurd number in the first second",
      remadeBy: [{ title: "Twelve keys", creativeId: "crv_1" }],
      role: null,
      conversion: null,
      signals: [],
      paidAd: false,
    });
    expect(failed).toMatchObject({ lane: "competitor", error: "the video could not be downloaded", remadeBy: [] });
    // The screen's reason travels with a dropped video, and its lane comes from the search that found it.
    expect(dropped).toMatchObject({ relevance: 3, relevanceReason: "a cooking video: nothing to remake for an API", lane: "category" });
  });

  it("shows the shortlist as being broken down while the breakdowns run", () => {
    const running: CreativeState = { ...state, breakdowns: undefined, failures: undefined };
    const refs = referencesView(running, videos);
    expect(refs.filter((r) => r.status === "studying").map((r) => r.author)).toEqual(["dev", "rival"]);
    expect(studyView(running)).toMatchObject({ picked: 2, studied: 0, done: false, kept: 3, screened: 4, product: { name: "Monid", fromKit: 1 } });
  });

  it("shows research steering's role, conversion score and signals, from the breakdown or the candidate", () => {
    const steered: CreativeState = {
      ...state,
      breakdowns: [{ ...breakdown("ref_1", A, "dev"), role: "convert", conversion: { score: 8, signals: ["asks for the sale", "saves per like 2.1x the pool's"] } }],
      candidates: state.candidates!.map((c) => (c.url === D ? { ...c, score: { ...c.score, role: "reach" as const, conversion: 2, signals: ["a meme format"] } } : c)),
    };
    const refs = referencesView(steered, videos);
    expect(refs[0]).toMatchObject({ role: "convert", conversion: 8, signals: ["asks for the sale", "saves per like 2.1x the pool's"] });
    expect(refs.find((r) => r.url === D)).toMatchObject({ role: "reach", conversion: 2, signals: ["a meme format"] });
  });

  it("marks a paid ad from an ad library, whose views are unknown", () => {
    const AD = "https://www.facebook.com/ads/library/?id=42";
    const ads = new Map([...videos, [AD, video(AD, { views: 0, likes: 0, saves: 0, shares: 0, comments: 0, followers: null, author: "rivalco", source: "meta_ads_conv_0", ad: { network: "meta", days: 94, active: true } as never })]]);
    const withAd: CreativeState = { ...state, picked: [...state.picked!, AD], breakdowns: [...state.breakdowns!, { ...breakdown("ref_ad", AD, "rivalco"), views: 0, followers: null, outlier: null, origin: "ad", role: "convert", conversion: { score: 9, signals: ["ran 94 days"] } }] };
    const ad = referencesView(withAd, ads).find((r) => r.url === AD)!;
    expect(ad).toMatchObject({ status: "studied", lane: "ad", paidAd: true, views: 0, outlier: null, role: "convert", conversion: 9, signals: ["ran 94 days"] });
    expect(remakeLine({ author: "rivalco", views: 0, outlier: null, paidAd: true })).toBe("Remake of @rivalco's paid ad (views unknown)");
  });

  it("is empty for campaigns from before the creative engine", () => {
    expect(referencesView({ slug: "nomen-style-acme", version: 1, skill_md: "# study", samples: [] } as unknown as CreativeState, videos)).toEqual([]);
    expect(studyView(null)).toBeNull();
  });

  it("says a remake in a few words", () => {
    expect(compact(1_234_567)).toBe("1.2M");
    expect(compact(45_200)).toBe("45K");
    expect(remakeLine({ author: "dev", views: 1_200_000, outlier: 100 })).toBe("Remake of @dev, 1.2M views (100× followers)");
    expect(remakeLine(null)).toBeNull();
  });
});

type Campaign = NonNullable<BrandView["campaign"]>;
const campaign = (fields: Partial<Campaign>) =>
  ({ id: "cmp_1", status: "running", stage: "style", stageIndex: 1, error: null, options: { concepts: 3 }, style: null, strategy: null, runs: [], creatives: [], posts: [], references: [], spend: { naive: 0, monid: 0, style: 0, strategy: 0 }, ...fields }) as unknown as Campaign;
const brand = (c: Campaign) => ({ brand: { id: "brd_1", name: "Monid", domain: "monid.ai" }, campaign: c, campaigns: [], events: [] }) as unknown as BrandView;

describe("the camp on the creative engine", () => {
  it("follows the oracle through the reference study", () => {
    expect(studyStep(campaign({ study: null }))?.status).toBe("Reading the product");
    const running = studyView({ ...state, breakdowns: undefined, failures: undefined })!;
    expect(studyStep(campaign({ study: running }))).toMatchObject({ status: "Breaking down 2 viral videos" });
    const plan = derive(brand(campaign({ study: running })));
    expect(plan.stations.oracle).toMatchObject({ state: "working", status: "Breaking down 2 viral videos" });
    expect(plan.agents.find((a) => a.id === "watcher")?.task).toMatch(/second by second/);
    // A replayed demo has no study: the generic line stays.
    expect(studyStep(campaign({ study: undefined }))).toBeNull();
  });

  it("shows the script room's progress in the war tent", () => {
    const strategy = { campaign: { name: "Keys", briefs: [{ title: "A" }, { title: "B" }, { title: "C" }], concepts: [{ title: "A", brief: { title: "A" } }] } };
    const c = campaign({ stage: "strategy", stageIndex: 2, strategy: strategy as never, study: studyView(state) });
    expect(scriptRoom(c)).toEqual({ total: 3, written: 1 });
    const plan = derive(brand(c));
    expect(plan.stations.tent.status).toBe("Script room: 1 of 3 scripts");
    expect(plan.agents.find((a) => a.id === "general")?.role).toBe("Director");
    expect(plan.agents.find((a) => a.id === "scribe")?.role).toBe("Script room");
  });

  it("says what a faceless video is waiting on", () => {
    const creative = { id: "crv_1", idx: 0, status: "producing", concept: { title: "Keys" }, shots: [], qcScore: null };
    const plan = derive(brand(campaign({ stage: "production", stageIndex: 3, creatives: [creative] as never })));
    expect(plan.agents.find((a) => a.id === "editor:0")?.task).toBe("“Keys”: building screens, the voice-over and the edit");
    expect(plan.stations.workshop.status).toBe("0 of 1 ready · building screens and cutting");
  });

  it("sends the engine's dispatches to the right station", () => {
    const cases: Array<[string, string]> = [
      ['Product brief: software, "One balance for every API" (6 visuals, 2 from the brand kit)', "oracle"],
      ["Captured 5 phone-size screenshots of monid.ai to show the product on screen", "oracle"],
      ["Could not screenshot monid.ai: the browser is busy", "oracle"],
      ["Relevance screen: 4 of 20 top-ranked videos could be remade for Monid", "oracle"],
      ["Breaking down 6 outlier videos beat by beat (transcript, cuts, frames): @dev 100x", "oracle"],
      ["Reference study ready: 6 videos broken down", "oracle"],
      ["The creative director is choosing which reference videos to transplant for 3 videos", "tent"],
      ['Campaign "Keys": "A" (talking head broll). The script room is writing them.', "tent"],
      ['Scripts ready: "A" 18s, critic 8/10. Now producing.', "tent"],
      ['"Keys": built 3 of 4 product screens', "workshop"],
      ['"Keys": remaking shot 1\'s first frame before rendering it (warped hands)', "workshop"],
      ["Research done: 120 short videos to rank, 12 live ads, 10 Reddit threads, 18 keywords (16/16 sources)", "scouts"],
      ["Scout: breakouts cluster around agent demos. Digging into \"mcp server\" (tiktok)", "scouts"],
      ["Monid balance is too low for some research. Top up at app.monid.ai/wallet.", "scouts"],
    ];
    for (const [message, station] of cases) expect(stationForEvent(message, "research"), message).toBe(station);
  });
});
