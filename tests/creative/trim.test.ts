import { describe, expect, it } from "vitest";
import { parseSilences, speechWindow } from "@/lib/creative/trim";

describe("trimming dead air around a rendered line", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 0",
    "[silencedetect @ 0x1] silence_end: 0.62 | silence_duration: 0.62",
    "[silencedetect @ 0x1] silence_start: 3.1",
    "[silencedetect @ 0x1] silence_end: 3.6 | silence_duration: 0.5",
    "[silencedetect @ 0x1] silence_start: 6.55",
  ].join("\n");

  it("reads silences, including one that runs to the end", () => {
    expect(parseSilences(stderr, 8)).toEqual([
      { start: 0, end: 0.62 },
      { start: 3.1, end: 3.6 },
      { start: 6.55, end: 8 },
    ]);
  });

  it("keeps the speech with a little air and drops the dead time", () => {
    const window = speechWindow(parseSilences(stderr, 8), 8)!;
    expect(window.from).toBeCloseTo(0.5);
    expect(window.to).toBeCloseTo(6.85);
  });

  it("trims past the click a rendered clip ends on", () => {
    // Real Veo shot: the line ends at 6.66 s, then silence, then a click in the last 30 ms.
    const clicked = "[silencedetect @ 0x1] silence_start: 6.6611\n[silencedetect @ 0x1] silence_end: 7.97071 | silence_duration: 1.3096";
    const window = speechWindow(parseSilences(clicked, 8), 8)!;
    expect(window.from).toBe(0);
    expect(window.to).toBeCloseTo(6.96, 1);
  });

  it("leaves tight or silent clips alone", () => {
    expect(speechWindow([{ start: 3, end: 3.4 }], 8)).toBeNull();
    expect(speechWindow([{ start: 0, end: 8 }], 8)).toBeNull();
  });
});
