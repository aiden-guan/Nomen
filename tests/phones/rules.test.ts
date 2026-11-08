import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http";
import { DAY_MS, clampDays, describeApiError, describeTaskOutcome, phoneAction, scheduleDay, scheduleSummary, sessionStatusFor, taskLimits } from "@/lib/phones/rules";

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
