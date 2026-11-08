import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http";
import { DAY_MS, clampDays, describeApiError, describeTaskOutcome, phoneAction, phoneCaption, postOutcome, scheduleDay, scheduleSummary, sessionStatusFor, taskLimits } from "@/lib/phones/rules";

const start = "2026-11-07T18:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(start) + ms);

describe("scheduleDay", () => {
  const schedule = { enabled: true, days: 3, startedAt: start };

  it("counts whole days from the start", () => {
    expect(scheduleDay(schedule, at(0))).toBe(0);
    expect(scheduleDay(schedule, at(DAY_MS - 1))).toBe(0);
    expect(scheduleDay(schedule, at(DAY_MS))).toBe(1);
    expect(scheduleDay(schedule, at(2 * DAY_MS + 5))).toBe(2);
  });

  it("is null when off, before the start, or after the last day", () => {
    expect(scheduleDay({ ...schedule, enabled: false }, at(0))).toBeNull();
    expect(scheduleDay({ ...schedule, startedAt: null }, at(0))).toBeNull();
    expect(scheduleDay(schedule, at(-1))).toBeNull();
    expect(scheduleDay(schedule, at(3 * DAY_MS))).toBeNull();
  });

  it("summarises progress for the panel", () => {
    expect(scheduleSummary(schedule, at(DAY_MS + 10))).toMatchObject({ state: "running", day: 2, days: 3, nextAt: at(2 * DAY_MS).toISOString() });
    expect(scheduleSummary(schedule, at(2 * DAY_MS + 10))).toMatchObject({ state: "running", day: 3, nextAt: null });
    expect(scheduleSummary(schedule, at(3 * DAY_MS))).toMatchObject({ state: "finished", day: null });
    expect(scheduleSummary({ ...schedule, enabled: false }, at(0))).toMatchObject({ state: "off" });
  });

  it("clamps the number of days", () => {
    expect(clampDays(7)).toBe(7);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(999)).toBe(30);
    expect(clampDays("abc")).toBe(7);
  });
});

describe("task mapping", () => {
  it("maps Mobilerun task states onto session states", () => {
    expect(sessionStatusFor({ status: "prepared" })).toBe("queued");
    expect(sessionStatusFor({ status: "queued" })).toBe("queued");
    expect(sessionStatusFor({ status: "created" })).toBe("queued");
    expect(sessionStatusFor({ status: "running" })).toBe("running");
    expect(sessionStatusFor({ status: "cancelling" })).toBe("running");
    expect(sessionStatusFor({ status: "completed", succeeded: true })).toBe("succeeded");
    expect(sessionStatusFor({ status: "completed", succeeded: false })).toBe("failed");
    expect(sessionStatusFor({ status: "failed" })).toBe("failed");
    expect(sessionStatusFor({ status: "cancelled" })).toBe("cancelled");
  });

  it("keeps the limits inside Mobilerun's bounds", () => {
    expect(taskLimits(12)).toEqual({ minutes: 12, maxSteps: 144, executionTimeout: 1020 });
    expect(taskLimits(500).executionTimeout).toBeLessThanOrEqual(2700);
    expect(taskLimits(0).minutes).toBe(12);
    expect(taskLimits(-5).minutes).toBe(1);
  });

  it("explains failures in plain language", () => {
    expect(describeTaskOutcome({ status: "completed", succeeded: true, message: "Watched 14 videos, liked 6." }, 12)).toBe("Watched 14 videos, liked 6.");
    expect(describeTaskOutcome({ status: "failed", execution: { terminationReason: "execution_timeout" } }, 12)).toMatch(/Ran out of time/);
    expect(describeTaskOutcome({ status: "failed", execution: { terminationReason: "worker_lost" } }, 12)).toMatch(/lost contact/);
    expect(describeTaskOutcome({ status: "failed", message: "Login asked for a code", execution: { terminationReason: "agent_failed" } }, 12)).toBe(
      "The phone agent couldn't finish: Login asked for a code.",
    );
    expect(describeTaskOutcome({ status: "cancelled" }, 12)).toBe("Stopped before it finished.");
  });

  it("decides what to do with the phone", () => {
    expect(phoneAction("ready")).toBe("run");
    expect(phoneAction("stopped")).toBe("resume");
    expect(phoneAction("terminated")).toBe("fail");
    expect(phoneAction("creating")).toBe("wait");
    expect(phoneAction("maintenance")).toBe("wait");
  });
});

describe("describeApiError", () => {
  it("separates retryable trouble from problems the user must fix", () => {
    expect(describeApiError(new ApiError("mobilerun", 401, "401", "unauthorized"))).toEqual({ message: expect.stringMatching(/API key/), retry: false });
    expect(describeApiError(new ApiError("mobilerun", 402, "MINUTE_BALANCE_EXHAUSTED", "spent"))).toEqual({ message: expect.stringMatching(/minutes are used up/), retry: false });
    expect(describeApiError(new ApiError("mobilerun", 402, "PAYMENT_REQUIRED", "no"))).toEqual({ message: expect.stringMatching(/out of credits/), retry: false });
    expect(describeApiError(new ApiError("mobilerun", 409, "409", "busy")).retry).toBe(true);
    expect(describeApiError(new ApiError("mobilerun", 503, "503", "down")).retry).toBe(true);
    expect(describeApiError(new ApiError("mobilerun", 0, "network_error", "ECONNRESET")).retry).toBe(true);
    expect(describeApiError(new ApiError("mobilerun", 401, "not_configured", "no key")).message).toMatch(/Settings/);
  });
});

describe("posting through a phone", () => {
  const done = { status: "completed" as const, succeeded: true, message: "Done.", execution: null };
  const report = (fields: Record<string, unknown>) => ({ posted: true, postUrl: "", aiLabel: true, onlyYou: false, reason: "", ...fields });

  it("reads a post the agent made, with its link", () => {
    expect(postOutcome({ ...done, output: report({ postUrl: " https://www.tiktok.com/@acme/video/1 " }) })).toEqual({
      status: "posted",
      url: "https://www.tiktok.com/@acme/video/1",
      warn: false,
      message: "Posted on TikTok.",
    });
  });

  it("keeps a post whose link the agent couldn't copy, and only takes web links", () => {
    for (const postUrl of ["", "Link copied!"]) {
      expect(postOutcome({ ...done, output: report({ postUrl }) })).toMatchObject({ status: "posted", url: null, message: expect.stringMatching(/couldn't copy the post's link/) });
    }
  });

  it("counts a video the agent says it posted as posted, even when its task then failed", () => {
    expect(postOutcome({ status: "failed", succeeded: false, message: "lost the share sheet", execution: { terminationReason: "agent_failed" }, output: report({}) })).toMatchObject({
      status: "posted",
    });
  });

  it("flags a post that went out without TikTok's AI-generated label", () => {
    expect(postOutcome({ ...done, output: report({ aiLabel: false }) })).toMatchObject({ status: "posted", warn: true, message: expect.stringMatching(/AI-generated label/) });
  });

  it("reads a private test post the agent set to “Only you”", () => {
    expect(postOutcome({ ...done, output: report({ onlyYou: true, postUrl: "https://www.tiktok.com/@acme/video/2" }) }, "private")).toEqual({
      status: "posted",
      url: "https://www.tiktok.com/@acme/video/2",
      warn: false,
      message: "Posted on TikTok as “Only you” (private).",
    });
  });

  it("warns when a private test post may be public, or a public one went out as “Only you”", () => {
    expect(postOutcome({ ...done, output: report({ onlyYou: false }) }, "private")).toMatchObject({ status: "posted", warn: true, message: expect.stringMatching(/may be public/) });
    expect(postOutcome({ ...done, output: report({ onlyYou: true }) }, "public")).toMatchObject({ status: "posted", warn: true, message: expect.stringMatching(/went out as “Only you”/) });
  });

  it("gives the agent's reason when it did not post", () => {
    expect(postOutcome({ ...done, succeeded: false, output: report({ posted: false, reason: "TikTok asked for a verification code" }) })).toEqual({
      status: "failed",
      url: null,
      warn: true,
      message: "Not posted: TikTok asked for a verification code.",
    });
  });

  it("says the video may be out when the task ended without a report", () => {
    expect(postOutcome({ status: "failed", succeeded: false, message: null, output: null, execution: { terminationReason: "worker_lost" } })).toMatchObject({
      status: "failed",
      url: null,
      message: expect.stringMatching(/check the brand's TikTok profile before posting it again/i),
    });
  });

  it("reads a stopped task as cancelled", () => {
    expect(postOutcome({ status: "cancelled", succeeded: null, message: null, output: null, execution: null })).toMatchObject({ status: "cancelled", url: null });
  });

  it("writes the caption on one line, labeled AI-generated, inside TikTok's 2,200 characters", () => {
    expect(phoneCaption("Three steps.\n\n#skincare  #glow")).toBe("Three steps. #skincare #glow #AIgenerated");
    expect(phoneCaption("Made with AI #aigenerated")).toBe("Made with AI #aigenerated");
    const long = phoneCaption("x".repeat(3000));
    expect(long).toHaveLength(2200);
    expect(long.endsWith(" #AIgenerated")).toBe(true);
  });
});
