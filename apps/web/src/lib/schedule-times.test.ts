import { SCHEDULE_AHEAD_MS } from "@ember/protocol";
import { describe, expect, it, vi } from "vitest";
import { customTimeStart, sameTimeOf, scheduleChoices, scheduleDayLabel, scheduleDays, scheduleTimes, sendAtLabel, timeZoneLabel } from "./schedule-times";

// Tuesday, November 17, 2026, at 10:30 AM, when Slack's menu was read.
const TUESDAY = new Date(2026, 10, 17, 10, 30);
const labels = (now: Date) => scheduleChoices(now).map((choice) => choice.label);

/** The module as it reads times in `zone`, and puts the zone back afterwards. */
async function inZone<T>(zone: string, run: (module: typeof import("./schedule-times")) => T): Promise<T> {
  const was = process.env.TZ;
  process.env.TZ = zone;
  vi.resetModules();
  try {
    return run(await import("./schedule-times"));
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
}

describe("Schedule for later's menu", () => {
  it("offers later today, tomorrow and Monday, as Slack's did on a Tuesday morning", () => {
    expect(labels(TUESDAY)).toEqual(["Later today at 1:00 PM", "Tomorrow at 9:00 AM", "Monday at 9:00 AM"]);
    expect(scheduleChoices(TUESDAY).map((choice) => choice.at)).toEqual([new Date(2026, 10, 17, 13), new Date(2026, 10, 18, 9), new Date(2026, 10, 23, 9)]);
  });

  it("leaves later today out once it would be tomorrow, and Monday when tomorrow is Monday", () => {
    expect(labels(new Date(2026, 10, 17, 20, 59))).toEqual(["Later today at 11:00 PM", "Tomorrow at 9:00 AM", "Monday at 9:00 AM"]);
    expect(labels(new Date(2026, 10, 17, 21, 0))).toEqual(["Tomorrow at 9:00 AM", "Monday at 9:00 AM"]);
    expect(labels(new Date(2026, 10, 22, 8, 0))).toEqual(["Later today at 11:00 AM", "Tomorrow at 9:00 AM"]);
    expect(labels(new Date(2026, 10, 23, 8, 0))).toEqual(["Later today at 11:00 AM", "Tomorrow at 9:00 AM", "Next Monday at 9:00 AM"]);
  });

  it("says when a message is to be sent", () => {
    expect(sendAtLabel(new Date(2026, 10, 17, 13), TUESDAY)).toBe("today at 1:00 PM");
    expect(sendAtLabel(new Date(2026, 10, 18, 9), TUESDAY)).toBe("tomorrow at 9:00 AM");
    expect(sendAtLabel(new Date(2026, 10, 16, 9), TUESDAY)).toBe("yesterday at 9:00 AM");
    expect(sendAtLabel(new Date(2026, 10, 23, 9), TUESDAY)).toBe("Monday at 9:00 AM");
    expect(sendAtLabel(new Date(2026, 10, 24, 9), TUESDAY)).toBe("Tuesday, November 24 at 9:00 AM");
    expect(sendAtLabel(new Date(2027, 0, 4, 9), TUESDAY)).toBe("Monday, January 4, 2027 at 9:00 AM");
  });
});

describe("Schedule for later's custom time", () => {
  it("offers today through 120 days on, each half hour still to come, starting half an hour on", () => {
    const days = scheduleDays(TUESDAY);
    expect(days).toHaveLength(121);
    expect(days.slice(0, 3).map((day) => scheduleDayLabel(day, TUESDAY))).toEqual(["Today", "Tomorrow", "Thursday, November 19"]);
    expect(scheduleDayLabel(days.at(-1)!, TUESDAY)).toBe("Wednesday, March 17, 2027");

    const today = scheduleTimes(days[0]!, TUESDAY);
    expect([today[0], today.at(-1), today.length]).toEqual([new Date(2026, 10, 17, 11), new Date(2026, 10, 17, 23, 30), 26]);
    expect(scheduleTimes(days[1]!, TUESDAY)).toHaveLength(48);
    const last = scheduleTimes(days.at(-1)!, TUESDAY).at(-1)!.getTime();
    expect(last).toBeLessThanOrEqual(TUESDAY.getTime() + SCHEDULE_AHEAD_MS);
    expect(last + 30 * 60_000).toBeGreaterThan(TUESDAY.getTime() + SCHEDULE_AHEAD_MS);

    expect(customTimeStart(TUESDAY)).toEqual(new Date(2026, 10, 17, 11));
    expect(customTimeStart(new Date(2026, 10, 17, 10, 31))).toEqual(new Date(2026, 10, 17, 11, 30));
  });

  it("starts at tomorrow once today's half hours have gone", () => {
    const late = new Date(2026, 10, 17, 23, 45);
    const days = scheduleDays(late);
    expect([days.length, scheduleDayLabel(days[0]!, late)]).toEqual([120, "Tomorrow"]);
    expect(customTimeStart(late)).toEqual(new Date(2026, 10, 18, 0, 30));
  });

  it("keeps the time picked as the day changes, where that day has it", () => {
    const [today, tomorrow] = scheduleDays(TUESDAY).map((day) => scheduleTimes(day, TUESDAY));
    expect(sameTimeOf(tomorrow!, new Date(2026, 10, 17, 11))).toEqual(new Date(2026, 10, 18, 11));
    expect(sameTimeOf(today!, new Date(2026, 10, 18, 9))).toEqual(new Date(2026, 10, 17, 11));
  });

  it("offers a half hour that the clocks skip once, and names the zone", async () => {
    await inZone("America/Los_Angeles", ({ scheduleTimes, timeZoneLabel }) => {
      const springForward = scheduleTimes(new Date(2027, 2, 14), new Date(2027, 2, 1));
      expect(springForward).toHaveLength(46);
      expect(springForward.slice(3, 6).map((at) => at.getHours() * 60 + at.getMinutes())).toEqual([90, 180, 210]);
      expect(scheduleTimes(new Date(2026, 10, 1), new Date(2026, 9, 1))).toHaveLength(48);
      expect(timeZoneLabel()).toBe("Pacific Time");
    });
    await inZone("UTC", ({ timeZoneLabel }) => expect(timeZoneLabel()).toBe("Coordinated Universal Time"));
    expect(timeZoneLabel()).toMatch(/\S/);
  });
});
