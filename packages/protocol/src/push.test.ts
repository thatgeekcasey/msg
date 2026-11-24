import { describe, expect, it } from "vitest";
import { LONGEST_PAUSE_MS, parseNotificationsPause } from "./push.ts";

describe("Pausing notifications", () => {
  const now = Date.parse("2026-11-20T23:30:00.000Z");
  /** `ms` after `now`, as toISOString writes it. */
  const after = (ms: number) => new Date(now + ms).toISOString();

  it("takes an end after now, as toISOString writes one, up to a week on, or null to resume", () => {
    expect(parseNotificationsPause({ until: after(30 * 60_000) }, now)).toEqual({ until: "2026-11-21T00:00:00.000Z" });
    expect(parseNotificationsPause({ until: after(LONGEST_PAUSE_MS) }, now)).toEqual({ until: "2026-11-27T23:30:00.000Z" });
    expect(parseNotificationsPause({ until: null }, now)).toEqual({ until: null });
  });

  it("refuses an end that's passed, more than a week on, written otherwise, or left out", () => {
    expect(parseNotificationsPause({ until: after(0) }, now)).toBe("A pause can't end in the past");
    expect(parseNotificationsPause({ until: after(-60_000) }, now)).toBe("A pause can't end in the past");
    expect(parseNotificationsPause({ until: after(LONGEST_PAUSE_MS + 1) }, now)).toBe("Notifications can be paused for a week at most");
    for (const until of ["2026-11-21T00:00:00Z", "2026-11-21", "tomorrow", "", now + 60_000, true, undefined]) {
      expect(parseNotificationsPause({ until }, now), String(until)).toBe("A pause needs the time it ends, or null to resume notifications");
    }
    expect(parseNotificationsPause(null, now)).toBe("A pause needs the time it ends, or null to resume notifications");
  });
});
