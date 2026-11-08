import type { DemoCreative, DemoScript } from "./demo";

// The made-up campaign the demo camp plays when no recording is installed: a fictional soap brand
// on the reserved .example domain, labeled "(demo)". It has pixel-art stills instead of videos.

const SHOT_SECONDS = 8;
const USD_PER_SECOND = 0.4; // the core's measured google/veo-3.1 price (src/lib/views.ts)
const RENDER_USD = SHOT_SECONDS * USD_PER_SECOND;

/** A pixel-art still for each made-up video: someone holding the bar of soap, in four rooms (36×64 PNGs). */
function poster(i: number) {
  return STILLS[i % STILLS.length];
}

const STILLS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAABACAIAAAD9B0KDAAABmUlEQVR42mP8dGQBA70AEwMdwahlQ88yFmoZxGHsh0f2x9lN1LSMgYFh2/13EIaXohCcDeGOJpDBmECQ4waNTRPLCCYQApZ5pjUQbVdD6Zo9o8XVaGokVABS6rO+FBv8CormHBmtPAejZUn9O3CJ9KXYbJ/VQE3L5hV6EBShKDVun9Vw/dSeAQjGw1efEBShWgliqy2DZrqttgwNiytSTR8EBfHHL9/4ebiwskkybukdnMVjtIofC36b+Hm4+M1c9u3YgN8OJ48AYlzGgt8mCNvYxg3CRrMVLo6mPjl8DrKyuStToHFG0CZkNhogRg0cfPzyDWec2dUcYGBg4BGQQNZQooNaW/bcQI+YABSvoLmMhXh/MDAw9FzRoCg1Em8TQdBr92TFjdc4pVUYWKiS4uEgQkweztY0c0Ezk4mkFEESwDSTiUY2YU2rTDSyCav/mKgbZ/hDkoWKcVZ8CFonbCvRoGucYTWTiW420SrOcJnJsvfKJapXkrjMZFFXksKh5R15Ns3KEhltfo9aNmrZqGWjlo1aNpwtAwDDOv97ZeWTEgAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAABACAIAAAD9B0KDAAABsklEQVR42mPccO0OA70AEwMdwahlo5aNWjZqGTUsY08JhTBql+6BMCR3xlHXMhZkDntK6M85qyH2NUe7MDAw7C7xJ94s156No3E23CxjhNTUT9e0YZW+duIkFRMICzGm1OUk4lfQNGU+CUlfOqQKh8/8RxMIdS1zSu/AJVKXk0gwdZBm2b6ZFQRFKEqNrj0bLR9sGIBg3HXyGkERKuQzCHAz10Iz3c1ci1aWkWH6QCZ9qM++fv7EzcuHlU2Scc9PleGSkjTrYsFvEzcv33HeANlTBIq+x2aJxLiMBb9NEPYNzWAIG81WuDhcPcS25PA5yMrmrkyBxhlBm5DZaIAYNXDw9fMnnHG20duegYFBkpMdWYNsWSQy91SIG5qJsmUGyF5BcxkL8f5gYGBY27WcotRIvE0EQX5PVsehjbhTIwMLVVI8HFTYISrb4woBaGYykZQiSAKYZjLRyCasaZWJRjZh9R8TdeMMf0iyUDHOJpZMgzDM1uyia5xhNZOJbjbRKs5wmcny/xA0oLkYGP7DVHNR5jNcZrKoK0lRN63HTMgabX6PWjZq2ahlo5aNWjacLQMAp0gERoYuf0sAAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAABACAIAAAD9B0KDAAABvElEQVR42mN8c28LA70AEwMdwahlVAEscBafpBUedZ+eH6OmZQwMDJdffcOqSFeMazTOyLaMWqFH2DJdMS5cUUhly2hhE3bLaGQTetLHtCnI0ph4s84emUuaz2jkpwEtrmiR1nFaRpXSb7AGIy5Q7qaOX0HnrpujBfFgtGzq3mu4RMrd1AkWH6RZlu2sRVCEIsvOHplLMCnSJBgvP35LUIQK+QxamMkKo5muKytMK8vIMH0QFFcfP33l5+PGyibJuNWH5uGSCrVLYsFvEz8fd1hd2YyyJvx2ZHTVEeMyFvw2QdiRNcUQNpqtcHE09cnhc5CVzV2ZAo0zgjYhs9EAMWrg4OOnrzjjzKLlKAMDA6ekPAMDAwPDe4hUOKp+x7lPkHjvGRgYslRRvILmMhbi/cHAwLBSPYmi1Ei8TQRB5tNlt/7+xyltx8BClRQPB6ovGOHssLoyNDOZSEoRJAFMM5loZBPWtMpEI5uw+o+JunGGPyRZqBhn06WjIIz9yTJ0jTOsZjLRzSZaxRkuM1kO79qHQws72ZbhMpNFXUkKu45Tb8mzaaX9FwYGqdHm96hlo5aNWjZq2ahlw9YyAFWHCBodx6diAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAABACAIAAAD9B0KDAAABm0lEQVR42mO8s+8ZA70AEwMdwahlo5aNWjZq2RCxjAW/9Lo5/sSbFZSycTTORi2jXWqEAB83a/wKtuw6Ohpng9Gy0NoluER83KwJFh+kWba6OYagCEWpMShl469HXQMQjPsv3CMoQoV8BgGOBkpopjsaKNHKMjJMp8gyIkHHlkQ4u8JnPrpln7584uPhw8rmIMWa3Y9yGBgYjPW40UQYGBhc5aaw4LeJj4ePgafswbka/HYoGLVA1BMIRgI2MTAwMDAIqZVB2Gi2wsUh6qcdyIf4KTl8DrKyuStToEmfoE3IbDRAjBo4+PTlEyOk54lpesncIAYGBhFxfmQNEVLSyNwVz56imYgcW2iAQJxhAkzTSUv6xNtEEBTpac6+cRa3zxhYcMUTefalahjD2X2XriPntk9fPjGRlCLIAxCb+Hj4mGhtk9OHr3AzWWhnk9OHr2g5hIm6cYY/n7FQMc7gKQLuJ2Sb6BFnyGYy0dqmgYuzy7d6qG4up5kZMhduBYu6khR2HYfJLbQ8XEeb36OWjVo2atmoZaOWDWfLAMbf44JSTX0/AAAAAElFTkSuQmCC",
];

const FIRST_SWEEP = ["brand", "site", "similar", "seo_rating", "seo_keywords"];
const SECOND_SWEEP = ["tiktok_brand", "tiktok_0", "tiktok_1", "reels", "shorts", "tiktok_ads", "meta_ads_brand", "meta_ads_0", "reddit", "aeo_chatgpt", "aeo_perplexity"];

const CONCEPTS = [
  { title: "The ten-second hand wash", angle: "product demo", hook: "“Watch how fast this lathers.”", caption: "Ten seconds, three ingredients, zero bottles. #oliveoilsoap #handwash" },
  { title: "Bathroom shelf glow-up", angle: "day-in-the-life", hook: "“I replaced five bottles with one bar.”", caption: "My shelf, before and after one bar of soap. #shelfie #lesswaste" },
  { title: "What's actually in it", angle: "myth-busting", hook: "“Three ingredients. I counted.”", caption: "Olive oil, water, lye. That's the list. #ingredients #cleanbeauty" },
  { title: "First wash, honest take", angle: "first reaction", hook: "“Okay, the smell is unreal.”", caption: "First wash with an olive oil bar, no script. #honestreview #selfcare" },
];

/** QC scores per shot, and how many renders each shot took (the third video's first shot was sent back once). */
const SHOTS = [
  [{ score: 8, renders: 1 }, { score: 9, renders: 1 }],
  [{ score: 9, renders: 1 }, { score: 9, renders: 1 }],
  [{ score: 8, renders: 2 }, { score: 8, renders: 1 }],
  [{ score: 9, renders: 1 }, { score: 9, renders: 1 }],
];

const ANALYTICS = [
  { views: 1240, likes: 96 },
  { views: 860, likes: 51 },
  { views: 2310, likes: 188 },
  { views: 640, likes: 37 },
];

const concept = (c: (typeof CONCEPTS)[number]) => ({
  ...c,
  format: "UGC",
  platforms: ["tiktok", "instagram"],
  creator: "",
  setting: "",
  shots: [],
  reference_images: [],
  hashtags: [],
  cta: "",
  inspired_by: [],
  why: "",
});

const creatives: DemoCreative[] = CONCEPTS.map((c, idx) => {
  const shots = SHOTS[idx];
  const renders = shots.reduce((n, s) => n + s.renders, 0);
  return {
    idx,
    concept: concept(c),
    caption: c.caption,
    platforms: ["tiktok", "instagram"],
    qcScore: Math.min(...shots.map((s) => s.score)),
    cost: Math.round(renders * RENDER_USD * 100) / 100,
    generation: 1,
    shots: shots.map((s, k) => ({ n: k + 1, provider: "naive", renders: s.renders, qc: { score: s.score, pass: true, issues: [], fix_prompt: "" } })),
    video: null,
    poster: poster(idx),
    analytics: ANALYTICS[idx],
  };
});

export const SAMPLE: DemoScript = {
  version: 1,
  recorded: false,
  brand: {
    name: "Olive & Ash (demo)",
    domain: "oliveandash.example",
    url: "https://oliveandash.example",
    profile: { name: "Olive & Ash", description: "", slogan: "", industry: "Personal care", colors: ["#647247", "#ead6ad"], logo: null, socials: [], images: [] },
  },
  options: { concepts: 4, shotsPerConcept: 2, secondsPerShot: SHOT_SECONDS, videoModel: "google/veo-3.1", learnStyle: true },
  estimateUsd: 4 * 2 * SHOT_SECONDS * USD_PER_SECOND,
  plan: {
    brand_name: "Olive & Ash",
    category: "olive oil soap",
    audience: "People who read the back of the bottle",
    competitors: [{ name: "Dr. Bronner's" }, { name: "Savon de Marseille" }],
    content_queries: ["olive oil soap review", "natural soap haul"],
    ads_query: "natural soap",
    reddit_query: "best olive oil soap",
    aeo_prompts: [],
  } as unknown as DemoScript["plan"],
  research: { videos: 24, ads: 12, reddit: 10, keywords: 18, domainRating: 41 },
  runs: [
    ...FIRST_SWEEP.map((key) => ({ key, phase: "A", provider: "context.dev", status: "done" as const, error: null, cost: 0.032 })),
    ...SECOND_SWEEP.map((key) =>
      key === "aeo_perplexity"
        ? { key, phase: "C", provider: "anyapi", status: "failed" as const, error: "provider HTTP 502", cost: 0 }
        : { key, phase: "C", provider: "anyapi", status: "done" as const, error: null, cost: 0.032 },
    ),
  ],
  style: { slug: "nomen-style-demo", version: 1, samples: 3 },
  strategy: {
    brand: { name: "Olive & Ash", one_liner: "Olive & Ash: a three-ingredient olive oil bar.", category: "olive oil soap", value_props: [], tone: "Calm, a little funny, never preachy", visual_style: "", product_look: "", proof_points: [] },
    audience: [
      { name: "Label readers", description: "", pains: [], motivations: [] },
      { name: "Shelf minimalists", description: "", pains: [], motivations: [] },
    ],
    competitors: [],
    content_patterns: [],
    search: { seo_keywords: [], seo_actions: [], aeo_status: "", aeo_actions: [], geo_actions: [] },
    campaign: { name: "Clean Hands, Short Story", objective: "Get people to try one bar instead of five bottles.", concepts: CONCEPTS.map(concept), posting_plan: { cadence: "One video a day for four days", best_times: [], notes: "" } },
  },
  creatives,
  events: [
    { s: 0, level: "info", message: "Campaign started: 4 videos, 2 shots each, google/veo-3.1" },
    { s: 5.5, level: "info", message: "Research plan: olive oil soap; competitors Dr. Bronner's, Savon de Marseille; searching olive oil soap review, natural soap haul" },
    { s: 19, level: "info", message: "Research done: 24 top videos, 12 live ads, 10 Reddit threads, 18 keywords (15/16 sources)" },
    { s: 21, level: "info", message: "Studying the format of 3 top-performing videos frame by frame" },
    { s: 27.5, level: "info", message: "Format study ready: 3 top videos analyzed" },
    { s: 29, level: "info", message: "The strategist is writing the brand brief and 4 concepts" },
    { s: 36.5, level: "info", message: 'Campaign "Clean Hands, Short Story": 4 concepts, now producing' },
    { s: 50, level: "info", message: 'QC sent "What\'s actually in it" shot 1 back (6/10): the bar\'s label is garbled' },
    { s: 58, level: "info", message: '"The ten-second hand wash" is ready (QC 8/10)' },
    { s: 60.5, level: "info", message: '"Bathroom shelf glow-up" is ready (QC 9/10)' },
    { s: 63, level: "info", message: '"What\'s actually in it" is ready (QC 8/10)' },
    { s: 65.5, level: "info", message: '"First wash, honest take" is ready (QC 9/10)' },
  ],
  spend: {
    naive: creatives.reduce((n, c) => n + c.cost, 0),
    monid: 0.48,
    style: 0.6,
    strategy: 0.9,
  },
};
