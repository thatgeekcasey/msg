import { describe, expect, it } from "vitest";
import { PAUSE_CHOICES, pauseEnd, pauseEndLabel, pausedUntilOf } from "./notifications-pause";

/** A time today in the browser's time zone, at `hours` and `minutes`. */
const today = (hours: number, minutes = 0) => new Date(2026, 10, 20, hours, minutes);

describe("Pause notifications' choices", () => {
  it("offers Slack's first four: 30 minutes, 1 hour, 2 hours and until tomorrow", () => {
    expect(PAUSE_CHOICES.map(({ label }) => label)).toEqual(["30 minutes", "1 hour", "2 hours", "Until tomorrow"]);
  });

  it("ends a pause so many minutes on, or at 9 AM tomorrow in the browser's time zone, however late it's chosen", () => {
    const [half, hour, two, tomorrow] = PAUSE_CHOICES;
    expect(pauseEnd(half!, today(15, 10))).toEqual(today(15, 40));
    expect(pauseEnd(hour!, today(23, 30))).toEqual(new Date(2026, 10, 21, 0, 30));
    expect(pauseEnd(two!, today(15, 10))).toEqual(today(17, 10));
    expect(pauseEnd(tomorrow!, today(15, 10))).toEqual(new Date(2026, 10, 21, 9));
    expect(pauseEnd(tomorrow!, today(0, 5))).toEqual(new Date(2026, 10, 21, 9));
    // The last day of a month.
    expect(pauseEnd(tomorrow!, new Date(2026, 10, 30, 22))).toEqual(new Date(2026, 11, 1, 9));
  });
});

describe("Who's paused", () => {
  it("counts someone paused until the time the directory lists, and no longer", () => {
    const until = today(16).toISOString();
    expect(pausedUntilOf({ pausedUntil: until }, today(15).getTime())).toBe(until);
    expect(pausedUntilOf({ pausedUntil: until }, today(16).getTime())).toBeNull();
    expect(pausedUntilOf({}, today(15).getTime())).toBeNull();
    expect(pausedUntilOf(undefined, today(15).getTime())).toBeNull();
  });

  it("says when a pause ends: its time today, tomorrow at its time, or its weekday and time", () => {
    const now = today(15);
    expect(pauseEndLabel(today(15, 30), now)).toBe(today(15, 30).toLocaleTimeString(undefined, { timeStyle: "short" }));
    expect(pauseEndLabel(new Date(2026, 10, 21, 9), now)).toMatch(/^tomorrow at 9:00\sAM$/);
    expect(pauseEndLabel(new Date(2026, 10, 23, 9), now)).toMatch(/^Monday at 9:00\sAM$/);
  });
});
