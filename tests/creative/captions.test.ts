import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MIN_CAPTION_SECONDS,
  assTime,
  balanceLines,
  chunkCaptions,
  escapeAssText,
  parseFontMetrics,
  roundedRect,
  stripStageDirections,
  textWidth,
  toAss,
  wrapOverlay,
} from "@/lib/creative/captions";

const metrics = parseFontMetrics(readFileSync(join(process.cwd(), "assets", "fonts", "Poppins-ExtraBold.ttf")));
const words = (text: string) => text.split(" ").length;

function expectWellFormed(chunks: Array<{ start: number; end: number; text: string }>) {
  for (let i = 0; i < chunks.length; i++) {
    expect(chunks[i].end).toBeGreaterThan(chunks[i].start);
    expect(chunks[i].end - chunks[i].start).toBeGreaterThanOrEqual(MIN_CAPTION_SECONDS - 0.001);
    if (i > 0) expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].end);
  }
}

describe("chunkCaptions", () => {
  it("splits a line into 1-3 word chunks that fill the segment exactly", () => {
    const chunks = chunkCaptions([{ start: 1, end: 4, text: "I tried every budgeting app so you don't have to." }]);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].start).toBe(1);
    expect(chunks.at(-1)!.end).toBe(4);
    for (const c of chunks) expect(words(c.text)).toBeLessThanOrEqual(3);
    expect(chunks.map((c) => c.text).join(" ")).toBe("I tried every budgeting app so you don't have to");
    // back to back: each chunk starts where the previous one ended
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBe(chunks[i - 1].end);
    expectWellFormed(chunks);
  });

  it("times chunks in proportion to their length", () => {
    const chunks = chunkCaptions([{ start: 0, end: 3, text: "Hi. Unbelievably extraordinary." }]);
    expect(chunks.map((c) => c.text)).toEqual(["Hi", "Unbelievably extraordinary"]);
    const [short, long] = chunks.map((c) => c.end - c.start);
    expect(long / short).toBeGreaterThan(5);
  });

  it("strips stage directions and keeps ? and ! but not commas or periods", () => {
    const chunks = chunkCaptions([{ start: 0, end: 4, text: "[pause] Okay, so... (beat) is this real? *laughs* Wow!" }]);
    const text = chunks.map((c) => c.text);
    expect(text).toEqual(["Okay", "so", "is this real?", "Wow!"]);
    expect(stripStageDirections("Wait [pause] what (sighs)")).toBe("Wait what");
    // a long parenthetical is speech, not a direction
    expect(stripStageDirections("it's cheap (like, really really cheap)")).toContain("(like, really really cheap)");
  });

  it("breaks at punctuation and avoids chunks that end on 'the' or 'my'", () => {
    const chunks = chunkCaptions([{ start: 0, end: 5, text: "So I opened the app, and my whole feed changed" }]);
    for (const c of chunks.slice(0, -1)) expect(c.text).not.toMatch(/\b(the|my|and|I)$/);
    expect(chunks.some((c) => c.text === "So I opened the app" || c.text.endsWith("app"))).toBe(true);
  });

  it("allows four words when they are all short", () => {
    expect(chunkCaptions([{ start: 0, end: 2, text: "I am so in." }]).map((c) => c.text)).toEqual(["I am so in"]);
    const long = chunkCaptions([{ start: 0, end: 2, text: "Absolutely everyone keeps recommending it" }]);
    expect(long.length).toBe(2);
  });

  it("merges chunks when the segment is too short for each to last 0.25 s", () => {
    const chunks = chunkCaptions([{ start: 0, end: 0.6, text: "one two three four five six seven eight" }]);
    expect(chunks.length).toBeLessThanOrEqual(2);
    expectWellFormed(chunks);
    expect(chunks.map((c) => c.text).join(" ")).toBe("one two three four five six seven eight");
  });

  it("never overlaps, even when segments do", () => {
    const chunks = chunkCaptions([
      { start: 2, end: 4, text: "second line here" },
      { start: 0, end: 2.5, text: "first line goes here now" },
    ]);
    expect(chunks[0].text.startsWith("first")).toBe(true);
    expectWellFormed(chunks);
    expect(chunks.at(-1)!.end).toBe(4);
  });

  it("honours maxWords and skips empty or broken segments", () => {
    const chunks = chunkCaptions([{ start: 0, end: 4, text: "alpha beta gamma delta epsilon zeta" }], 2);
    for (const c of chunks) expect(words(c.text)).toBeLessThanOrEqual(2);
    expect(chunkCaptions([{ start: 0, end: 1, text: "[pause]" }, { start: 3, end: 2, text: "backwards" }])).toEqual([]);
  });
});

describe("wrapOverlay", () => {
  it("leaves short text on one line", () => {
    expect(wrapOverlay("POV: you found it")).toBe("POV: you found it");
  });

  it("wraps into balanced lines of at most 22 characters", () => {
    const lines = wrapOverlay("I tried every budgeting app so you don't have to").split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(22);
    const lengths = lines.map((l) => l.length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(8);
  });

  it("never needs more than three lines", () => {
    const text = "this is a very long hook line that a writer should never have written for a video overlay";
    const lines = wrapOverlay(text).split("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.join(" ")).toBe(text);
  });

  it("keeps explicit line breaks and collapses spaces", () => {
    expect(wrapOverlay("  Day 1\nof   using it ")).toBe("Day 1\nof using it");
  });
});

describe("ASS helpers", () => {
  it("formats times as H:MM:SS.cc", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(1.006)).toBe("0:00:01.01");
    expect(assTime(59.999)).toBe("0:01:00.00"); // rounding carries into the minutes
    expect(assTime(61.234)).toBe("0:01:01.23");
    expect(assTime(3725.5)).toBe("1:02:05.50");
    expect(assTime(-1)).toBe("0:00:00.00");
  });

  it("escapes braces, backslashes and newlines", () => {
    expect(escapeAssText("a {b} c")).toBe("a \\{b\\} c");
    // a literal backslash is followed by a word joiner so "\N" stays two visible characters
    expect(escapeAssText("C:\\New")).toBe("C:\\\u2060New");
    expect(escapeAssText("one\ntwo")).toBe("one\\Ntwo");
    expect(escapeAssText("one\r\ntwo", "space")).toBe("one two");
    expect(escapeAssText("{\\b1}")).toBe("\\{\\\u2060b1\\}");
  });

  it("balances lines by pixel width", () => {
    const width = (s: string) => s.length * 10;
    expect(balanceLines(["a", "b", "c"], 100, width)).toEqual(["a b c"]);
    // greedy would give "aaaa bbbb" + "cc"; balanced keeps two lines but evens them
    expect(balanceLines(["aaaa", "bbbb", "cc"], 100, width)).toEqual(["aaaa", "bbbb cc"]);
    expect(balanceLines(["waytoolongforoneline", "ok"], 100, width)).toEqual(["waytoolongforoneline", "ok"]);
  });

  it("draws a closed rounded rectangle", () => {
    const path = roundedRect(200, 100, 20);
    expect(path.startsWith("m 20 0 l 180 0 b")).toBe(true);
    expect(path.endsWith("20 0")).toBe(true);
  });

  it("reads the bundled font's metrics", () => {
    expect(metrics.family).toBe("Poppins ExtraBold");
    expect(metrics.unitsPerEm).toBe(1000);
    expect(metrics.ascent + metrics.descent).toBeGreaterThan(1000);
    expect(metrics.advances.get("W".codePointAt(0)!)).toBeGreaterThan(metrics.advances.get("i".codePointAt(0)!)!);
    expect(textWidth("Hello", 100, metrics)).toBeGreaterThan(100);
  });
});

describe("toAss", () => {
  const timeline = {
    captions: [
      { start: 0, end: 0.8, text: "watch {this}" },
      { start: 0.8, end: 1.6, text: "back\\slash\nline" },
      { start: 2, end: 2, text: "zero length" },
    ],
    overlays: [{ start: 0, end: 2.5, text: "I tried every budgeting app so you don't have to" }],
  };
  const ass = toAss(timeline, { metrics });
  const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

  it("declares a 1080x1920 script with caption and overlay styles", () => {
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("ScaledBorderAndShadow: yes");
    const caption = ass.split("\n").find((l) => l.startsWith("Style: Caption,"))!.split(",");
    expect(caption[1]).toBe("Poppins ExtraBold");
    expect(Number(caption[16])).toBeGreaterThanOrEqual(6); // outline px
    expect(Number(caption[16])).toBeLessThanOrEqual(8);
    expect(caption[18]).toBe("2"); // bottom centre
    const marginV = Number(caption[21]);
    expect(1 - marginV / 1920).toBeGreaterThan(0.62);
    expect(1 - marginV / 1920).toBeLessThan(0.7);
  });

  it("writes two layers per caption, a box plus one event per line per overlay, skipping empty times", () => {
    const overlayLines = wrapOverlay(timeline.overlays[0].text).split("\n").length;
    expect(dialogues).toHaveLength(2 * 2 + 1 + overlayLines);
    expect(dialogues[0]).toMatch(/^Dialogue: 0,0:00:00\.00,0:00:00\.80,CaptionShadow,/);
    expect(dialogues[1]).toMatch(/^Dialogue: 1,0:00:00\.00,0:00:00\.80,Caption,/);
    expect(dialogues[1].endsWith("}watch \\{this\\}")).toBe(true);
    expect(dialogues[3].endsWith("}back\\\u2060slash line")).toBe(true);
    expect(ass).not.toContain("zero length");
  });

  it("puts the overlay on a rounded box inside the frame, wrapped to at most three lines", () => {
    const box = dialogues.find((l) => l.includes(",OverlayBox,"))!;
    const lines = dialogues.filter((l) => l.includes(",Overlay,"));
    const [, x0, y0] = box.match(/\\pos\((\d+),(\d+)\)/)!.map(Number);
    const coordinates = box.split("}")[1].split(" ").filter((t) => /^\d+$/.test(t)).map(Number);
    const boxWidth = Math.max(...coordinates.filter((_, i) => i % 2 === 0));
    const boxHeight = Math.max(...coordinates.filter((_, i) => i % 2 === 1));
    expect(x0).toBeGreaterThan(0);
    expect(x0 + boxWidth).toBeLessThan(1080);
    expect(x0 + boxWidth / 2).toBeCloseTo(540, -1);
    // centred around 18-24% from the top
    expect((y0 + boxHeight / 2) / 1920).toBeGreaterThan(0.18);
    expect((y0 + boxHeight / 2) / 1920).toBeLessThan(0.24);
    expect(box).toContain("\\p1");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    // every line is centred horizontally and sits inside the box, top to bottom
    const ys = lines.map((l) => Number(l.match(/\\pos\(540,(\d+)\)/)![1]));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    for (const y of ys) {
      expect(y).toBeGreaterThan(y0);
      expect(y).toBeLessThan(y0 + boxHeight);
    }
    expect(lines.map((l) => l.split("}").pop()).join(" ")).toBe(timeline.overlays[0].text);
  });

  it("moves an overlay shown mostly during a split screen to the seam, off the creator's face", () => {
    const centre = (ass: string) => {
      const box = ass.split("\n").find((l) => l.includes(",OverlayBox,"))!;
      const [, , y0] = box.match(/\\pos\((\d+),(\d+)\)/)!.map(Number);
      const ys = box.split("}")[1].split(" ").filter((t) => /^\d+$/.test(t)).map(Number).filter((_, i) => i % 2 === 1);
      return (y0 + Math.max(...ys) / 2) / 1920;
    };
    const overlay = { captions: [], overlays: [{ start: 2, end: 4, text: "One balance" }] };
    expect(centre(toAss(overlay, { metrics, splits: [{ start: 1.5, end: 5 }] }))).toBeCloseTo(0.5, 2);
    expect(centre(toAss(overlay, { metrics, splits: [{ start: 3.5, end: 5 }] }))).toBeLessThan(0.24);
  });

  it("wraps a long caption into tight lines that end around two thirds down", () => {
    const ass = toAss({ captions: [{ start: 0, end: 1, text: "Unbelievably extraordinary results" }], overlays: [] }, { metrics });
    const lines = ass.split("\n").filter((l) => l.includes(",Caption,"));
    expect(lines.length).toBe(2);
    const ys = lines.map((l) => Number(l.match(/\\pos\(540,(\d+)\)/)![1]));
    expect(ys[1] - ys[0]).toBeGreaterThan(60);
    expect(ys[1] - ys[0]).toBeLessThan(90); // ~1.1 em, not libass's 1.76 em
    expect(ys[1] / 1920).toBeGreaterThan(0.64);
    expect(ys[1] / 1920).toBeLessThan(0.7);
    for (const line of lines) expect(textWidth(line.split("}").pop()!, 123, metrics)).toBeLessThan(1080 - 140);
  });

  it("works without font metrics", () => {
    const ass = toAss({ captions: [{ start: 0, end: 1, text: "hi" }], overlays: [{ start: 0, end: 1, text: "a hook" }] });
    expect(ass).toContain("Style: Caption,Poppins ExtraBold,");
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:"))).toHaveLength(4);
  });
});

describe("emoji in caption text", () => {
  it("are dropped, since the caption font can't draw them", async () => {
    const { escapeAssText } = await import("@/lib/creative/captions");
    expect(escapeAssText("Ways to run a company with AI agents 🤖")).toBe("Ways to run a company with AI agents");
    expect(escapeAssText("ship it 🚀🔥 now")).toBe("ship it now");
    expect(escapeAssText("$3 → 2,000 tools")).toBe("$3 → 2,000 tools");
  });
});
