import { describe, expect, it } from "vitest";
import { type Casting, type CastingDeps, type CastingInput, creatorsFromResearch, MAX_CREATORS, profilesIn, searchKeywords, stepCasting } from "@/lib/creative/casting";
import type { ProductBrief } from "@/lib/creative/types";
import type { Video } from "@/lib/research";

const video = (over: Partial<Video>): Video => ({ platform: "tiktok", url: "https://www.tiktok.com/@x/video/1", caption: "", views: 100_000, likes: 0, comments: 0, shares: 0, saves: 0, duration: 20, author: "x", followers: 10_000, paid: false, thumbnail: null, media_url: null, source: "tiktok_search", ...over });

const research: Video[] = [
  video({ author: "hannahlearnsstuff", url: "https://www.tiktok.com/@hannahlearnsstuff/video/1", views: 1_903_312, followers: 1_049, caption: "I'm actually upset I didn't know about this sooner" }),
  video({ author: "empeer.den", url: "https://www.tiktok.com/@empeer.den/video/2", views: 596_701, followers: 758, caption: "API keys explained" }),
  video({ author: "empeer.den", url: "https://www.tiktok.com/@empeer.den/video/3", views: 20_000, followers: 758, caption: "older one" }),
  video({ author: "bigmedia", views: 9_000_000, followers: 4_000_000 }), // too big to brief
  video({ author: "tiny", views: 900, followers: 300 }), // too small to brief
  video({ author: "monidofficial", views: 50_000, followers: 20_000 }), // the brand itself
  video({ author: "someadvertiser", paid: true }),
  video({ platform: "youtube", author: "yt" }),
];

describe("finding creators", () => {
  it("takes the research's authors who already make this kind of video, best evidence first", () => {
    const found = creatorsFromResearch(research, { name: "Monid", domain: "monid.ai" });
    expect(found.map((c) => c.handle)).toEqual(["hannahlearnsstuff", "empeer.den"]);
    expect(found[0]).toMatchObject({ platform: "tiktok", followers: 1_049, url: "https://www.tiktok.com/@hannahlearnsstuff", source: "research" });
    expect(found[0].evidence).toContain("1.9M views on 1K followers");
    expect(found[1].evidence).toContain("API keys explained"); // their best video, not their older one
  });

  it("reads profiles out of either people search's answer", () => {
    const tiktok = { data: { user_list: [{ user_info: { unique_id: "agentbuilder", nickname: "Agent Builder", follower_count: 42_000, signature: "I build AI agents" } }, { user_info: { unique_id: "agentbuilder", follower_count: 42_000 } }] } };
    expect(profilesIn(tiktok, "tiktok")).toEqual([{ platform: "tiktok", handle: "agentbuilder", name: "Agent Builder", followers: 42_000, bio: "I build AI agents", url: "https://www.tiktok.com/@agentbuilder", source: "search", evidence: "" }]);
    const instagram = { users: [{ username: "devwithsam", full_name: "Sam", followers: "15300", biography: "dev tips" }] };
    expect(profilesIn(instagram, "instagram")[0]).toMatchObject({ handle: "devwithsam", followers: 15_300, url: "https://www.instagram.com/devwithsam" });
  });

  it("searches people by the brief's category and angle, two short keywords", () => {
    expect(searchKeywords({ category: "Developer tools: tool and API access layer for AI agents", angle: "No more sign-ups for your agent" })).toEqual(["developer tools tool", "no more sign"]);
    expect(searchKeywords({})).toEqual([]);
  });
});

// ---------- the casting loop ----------

const product = { name: "Monid", one_liner: "One balance and one skill file for every tool your agent needs", audience: "developers building AI agents", claims: ["2,900+ tools"] } as unknown as ProductBrief;
const input: CastingInput = {
  concept: { title: "We gave an agent $3", hook: "We gave an agent three dollars and one skill file", lines: ["We gave an agent three dollars and one skill file"], format: "one-to-one remake" },
  reference: { url: "https://www.tiktok.com/@cluelyextras/video/7544005050146770189", format: "talking head" },
  product,
  taste: { name: "Monid", tone: "Plain, developer-casual", audience: "agent builders", values: ["no sign-ups"], competitors: ["Composio"] },
  research,
  brand: { name: "Monid", domain: "monid.ai" },
  keywords: [],
  fee: "$150 flat",
};

/** A fake model: answers each tool from a script of verdicts. */
function fakeModel(verdicts: Array<{ approve: boolean; changes?: string[] }>) {
  const seen: Array<{ tool: string; user: string }> = [];
  let v = 0;
  const message: CastingDeps["message"] = async (req) => {
    const tool = (req.tools?.[0] as { name: string }).name;
    const user = String(req.messages[0].content);
    seen.push({ tool, user });
    const answer =
      tool === "rank_creators"
        ? { ranked: [{ handle: "hannahlearnsstuff", fit: 8, why: "makes discovery-hook videos" }, { handle: "empeer.den", fit: 7, why: "explains API keys" }, { handle: "made-up", fit: 9, why: "not a candidate" }] }
        : tool === "briefing"
          ? { title: "Three dollars and a skill file", summary: "s", hook: "We gave an agent three dollars", talking_points: ["p"], shots: ["face to camera"], reference: { url: input.reference.url, why: "pacing" }, deliverables: ["one 20 s video"], dos: ["d"], donts: ["no claims beyond the brief"], timeline: "5 days", fee: "$150 flat" }
          : tool === "verdict"
            ? (() => {
                const next = verdicts[Math.min(v++, verdicts.length - 1)];
                return { approve: next.approve, score: next.approve ? 8 : 4, reasons: [next.approve ? "on brand" : "wrong audience"], changes: next.changes ?? [] };
              })()
            : { message: "Hey! Loved your API keys video. Want to film a 20 s video for Monid? $150 flat, 5 days. Interested?" };
    return { content: [{ type: "tool_use", name: tool, input: answer }] } as unknown as Awaited<ReturnType<CastingDeps["message"]>>;
  };
  return { message, seen };
}

async function castUntilSettled(deps: CastingDeps) {
  let casting: Casting | null = null;
  for (let i = 0; i < 10; i++) {
    casting = await stepCasting(deps, input, casting);
    if (casting.status === "approved" || casting.status === "no_match") break;
  }
  return casting!;
}

describe("casting a brief", () => {
  it("ranks, briefs and asks the client; a no moves to the next creator, a yes gets an outreach draft", async () => {
    const { message, seen } = fakeModel([{ approve: false }, { approve: true }]);
    const logs: string[] = [];
    const casting = await castUntilSettled({ message, monid: null, log: (m) => void logs.push(m) });
    expect(casting.status).toBe("approved");
    expect(casting.ranked.map((r) => r.handle)).toEqual(["hannahlearnsstuff", "empeer.den"]); // made-up handles are dropped
    expect(casting.tried).toEqual(["hannahlearnsstuff", "empeer.den"]);
    expect(casting.pick?.handle).toBe("empeer.den");
    expect(casting.reviews.map((r) => [r.creator, r.approve])).toEqual([
      ["hannahlearnsstuff", false],
      ["empeer.den", true],
    ]);
    expect(casting.outreach).toEqual({ channel: "tiktok_dm", message: expect.stringContaining("Monid") });
    // The client sees its earlier verdicts when it judges the next creator.
    expect(seen.filter((s) => s.tool === "verdict")[1].user).toContain("your_earlier_verdicts");
    expect(logs).toContainEqual(expect.stringMatching(/^Client taste turned down "We gave an agent \$3" with @hannahlearnsstuff \(4\/10\)/));
    expect(logs).toContainEqual(expect.stringMatching(/outreach to @empeer.den drafted, waiting for you to send it$/));
  });

  it("revises the brief for the same creator when the client asks for changes", async () => {
    const { message, seen } = fakeModel([{ approve: false, changes: ["lead with the price"] }, { approve: true }]);
    const casting = await castUntilSettled({ message, monid: null, log: () => undefined });
    expect(casting.status).toBe("approved");
    expect(casting.tried).toEqual(["hannahlearnsstuff"]);
    expect(seen.filter((s) => s.tool === "briefing")[1].user).toContain("lead with the price");
  });

  it(`sets the brief aside after ${MAX_CREATORS} creators are turned down`, async () => {
    const many = { ...input, research: [...research, video({ author: "third", views: 300_000, followers: 3_000 }), video({ author: "fourth", views: 200_000, followers: 4_000 })] };
    const { message } = fakeModel([{ approve: false }]);
    const ranking: CastingDeps["message"] = async (req) => {
      if ((req.tools?.[0] as { name: string }).name === "rank_creators")
        return { content: [{ type: "tool_use", name: "rank_creators", input: { ranked: ["hannahlearnsstuff", "empeer.den", "third", "fourth"].map((handle) => ({ handle, fit: 7, why: "w" })) } }] } as never;
      return message(req);
    };
    let casting: Casting | null = null;
    for (let i = 0; i < 10 && casting?.status !== "no_match"; i++) casting = await stepCasting({ message: ranking, monid: null, log: () => undefined }, many, casting);
    expect(casting!.status).toBe("no_match");
    expect(casting!.tried).toHaveLength(MAX_CREATORS);
  });
});
