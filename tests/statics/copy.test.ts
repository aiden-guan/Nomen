import { describe, expect, it } from "vitest";
import { appearsIn, checkSearchAssets, cleanXPost, googleProblems, keepValid, normalize, type SearchAssets, slopIn, unsupportedNumbers } from "@/lib/statics/validate";
import { type Concept, conceptProblems, downgrade } from "@/lib/statics/writer";

const SITE = `Monid
One skill unlocks 1,800+ tools & APIs for your agent.
Connect your agent to every tool it needs.
Give this to your agent: set up https://monid.ai/SKILL.md and let it take it from there.
No sign-ups, no subscriptions. Pay per call from one balance. Start with $1 of free credit.
"Monid is the fastest way to give an agent tools." — Dev Weekly`;

const concept = (over: Partial<Concept> = {}): Concept => ({
  archetype: "editorial",
  scheme: "white",
  angle: "One integration instead of many",
  copy: { headline: "Connect your agent to *every tool*", cta: "Get started" },
  visual: { kind: "none", site_photo: -1, prompt: "" },
  meta: { primary_text: ["Give your agent 1,800+ tools with one skill file."], headline: "Every tool, one skill", description: "Pay per call", cta: "Learn more" },
  x: { post: "One skill file gives your agent 1,800+ tools.", card_headline: "Every tool your agent needs" },
  reddit: { headline: "Tired of signing up for every API your agent uses?", cta: "Learn More" },
  inspired_by: [],
  why: "",
  sources: ["One skill unlocks 1,800+ tools & APIs for your agent."],
  ...over,
});

describe("facts", () => {
  it("accepts numbers the site states, with or without separators", () => {
    expect(unsupportedNumbers("Over 1800+ tools", SITE)).toEqual([]);
    expect(unsupportedNumbers("1,800+ tools and $1 of credit", SITE)).toEqual([]);
  });

  it("rejects numbers the site never states", () => {
    expect(unsupportedNumbers("Trusted by 10,000 developers", SITE)).toEqual(["10,000"]);
    expect(unsupportedNumbers("2x faster", SITE)).toEqual(["2x"]);
  });

  it("matches quotes and commands word for word, ignoring quote styles and spacing", () => {
    expect(appearsIn("“Monid is the fastest way to give an agent tools.”", SITE)).toBe(true);
    expect(appearsIn("set up  https://monid.ai/SKILL.md", SITE)).toBe(true);
    expect(appearsIn("Monid is the best way to give an agent tools", SITE)).toBe(false);
  });

  it("normalizes dashes, quotes and thousands separators", () => {
    expect(normalize("It’s 1,800+ — really")).toBe("it's 1800+ - really");
  });
});

describe("generic phrasing", () => {
  it("flags machine-sounding phrases", () => {
    expect(slopIn("Supercharge your workflow and elevate your agent", SITE)).toEqual(["supercharge", "elevate"]);
  });

  it("allows a phrase the brand's own site uses", () => {
    expect(slopIn("One skill unlocks every tool", SITE)).toEqual([]);
  });
});

describe("Google editorial rules", () => {
  it("rejects exclamation marks, emoji, repeated punctuation and shouting", () => {
    expect(googleProblems("Try it today!", SITE)).toContain("exclamation mark");
    expect(googleProblems("Fast tools 🚀", SITE)).toContain("emoji");
    expect(googleProblems("Really fast..", SITE)).toContain("repeated punctuation");
    expect(googleProblems("FREE tools for agents", SITE).join()).toMatch(/capitals: FREE/);
  });

  it("allows capitals the brand writes itself", () => {
    expect(googleProblems("Read the SKILL file", SITE)).toEqual([]);
  });

  it("keeps lines within the limit and never truncates", () => {
    const { value, problems } = keepValid(["Every tool your agent needs", "This headline is far too long for a search ad"], 30);
    expect(value).toEqual(["Every tool your agent needs"]);
    expect(problems[0]).toMatch(/limit 30/);
  });

  it("drops failing Google assets and says what is still missing", () => {
    const raw: SearchAssets = {
      rsa: { headlines: ["Tools for AI agents", "One skill, every tool", "Pay per call!", "Monid", "10,000 happy devs"], descriptions: ["Give your agent 1,800+ tools with one skill file. Pay per call from one balance."], path1: "Agent Tools", path2: "skill" },
      sitelinks: [{ text: "Docs", line1: "Set up in one line", line2: "" }],
      callouts: ["No subscriptions", "Pay per call"],
      snippet: { header: "Nonsense", values: ["Scraping", "Weather"] },
      display: { short_headlines: ["Every tool"], long_headline: "Connect your agent to every tool it needs", descriptions: ["One balance."], business_name: "Monid" },
      pmax: { headlines: ["Every tool", "One skill", "Monid"], long_headlines: ["Connect your agent to every tool it needs"], descriptions: ["One balance.", "Pay per call."], business_name: "Monid" },
    };
    const { assets, problems, short } = checkSearchAssets(raw, SITE);
    expect(assets.rsa.headlines).toEqual(["Tools for AI agents", "One skill, every tool", "Monid"]);
    expect(assets.rsa.path1).toBe("agent-tools");
    expect(assets.sitelinks).toEqual([]);
    expect(assets.snippet.header).toBe("Types");
    expect(assets.snippet.values).toEqual([]);
    expect(problems.join("\n")).toMatch(/exclamation mark/);
    expect(problems.join("\n")).toMatch(/number not on the site: 10,000/);
    expect(short.join("\n")).toMatch(/needs 2 descriptions/);
  });
});

describe("X posts", () => {
  it("removes hashtags, which X does not allow in ads, and weighs links as 23 characters", () => {
    const { text, weighted } = cleanXPost("One skill, every tool #AI #agents https://monid.ai/very/long/link/that/goes/on");
    expect(text).toBe("One skill, every tool https://monid.ai/very/long/link/that/goes/on");
    expect(weighted).toBe("One skill, every tool ".length + 23);
  });
});

describe("concept checks", () => {
  const opts = { hasScreenshot: true, photos: 0 };

  it("passes a concept whose facts are on the site", () => {
    expect(conceptProblems(concept(), SITE, opts)).toEqual([]);
  });

  it("catches invented numbers, quotes, offers and commands", () => {
    expect(conceptProblems(concept({ copy: { headline: "Used by 50,000 teams", cta: "Start" } }), SITE, opts).join()).toMatch(/50,000/);
    expect(conceptProblems(concept({ archetype: "quote", copy: { headline: "", cta: "Start", quote: { text: "Best tool ever", source: "A user" } } }), SITE, opts).join()).toMatch(/word for word/);
    expect(conceptProblems(concept({ archetype: "offer", copy: { headline: "Try it", cta: "Start", offer: "50% off" } }), SITE, opts).join()).toMatch(/not stated/);
    expect(conceptProblems(concept({ archetype: "code", copy: { headline: "One line", cta: "Start", code: { lines: ["$ npm install monid"] } } }), SITE, opts).join()).toMatch(/not on the site/);
  });

  it("turns an unsupported stat into a plain headline instead of shipping it", () => {
    const bad = concept({ archetype: "stat", copy: { headline: "Every tool", cta: "Start", stat: { value: "99%", label: "uptime" } } });
    const fixed = downgrade(bad, SITE, opts);
    expect(fixed?.archetype).toBe("editorial");
  });

  it("keeps the real command lines of a code concept and drops invented ones", () => {
    const mixed = concept({ archetype: "code", copy: { headline: "One line", cta: "Start", code: { lines: ["$ set up https://monid.ai/SKILL.md", "$ monid deploy --prod"] } } });
    expect(downgrade(mixed, SITE, opts)?.copy.code?.lines).toEqual(["$ set up https://monid.ai/SKILL.md"]);
  });

  it("drops a concept whose headline itself is unsupported", () => {
    expect(downgrade(concept({ copy: { headline: "Rated 4.9 by 2,000 developers", cta: "Start" } }), SITE, opts)).toBeNull();
  });
});

describe("code-like copy", () => {
  it("rejects calls and paths the site never shows", () => {
    const problems = conceptProblems(concept({ copy: { headline: "Every tool", cta: "Start", eyebrow: "monid.discover()" } }), SITE, { hasScreenshot: true, photos: 0 });
    expect(problems.join()).toMatch(/"monid\.discover\(\)" looks like code/);
  });

  it("drops an invented terminal title and keeps the real command", () => {
    const c = concept({ archetype: "code", copy: { headline: "One line", cta: "Start", code: { title: "~/agents/research-bot", lines: ["$ set up https://monid.ai/SKILL.md"] } } });
    expect(conceptProblems(c, SITE, { hasScreenshot: true, photos: 0 }).join()).toMatch(/terminal title/);
    expect(downgrade(c, SITE, { hasScreenshot: true, photos: 0 })?.copy.code?.title).toBeUndefined();
  });
});
