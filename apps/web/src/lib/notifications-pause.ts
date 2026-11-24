import type { DirectoryUser } from "@ember/protocol";

/** One of Pause notifications' choices: for a while, or until tomorrow morning. */
export interface PauseChoice {
  label: string;
  /** How many minutes it pauses them for, or null for until tomorrow morning. */
  minutes: number | null;
}

/** Pause notifications' choices, as Slack's first four: 30 minutes, 1 hour, 2 hours and until tomorrow. */
export const PAUSE_CHOICES: readonly PauseChoice[] = [
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "Until tomorrow", minutes: null },
];

/** The hour, in the browser's time zone, that a pause until tomorrow ends at, as a working day starts. */
export const TOMORROW_AT = 9;

/**
 * When a pause chosen at `now` ends: so many minutes on, or at 9 AM tomorrow in the browser's own time
 * zone, which the browser works out, since Ember keeps nobody's.
 */
export function pauseEnd({ minutes }: PauseChoice, now = new Date()): Date {
  if (minutes !== null) return new Date(now.getTime() + minutes * 60_000);
  const end = new Date(now);
  end.setDate(now.getDate() + 1);
  end.setHours(TOMORROW_AT, 0, 0, 0);
  return end;
}

/** When the pause of `person`'s notifications ends, as the people directory lists them, or null at `now` while they haven't paused them. */
export function pausedUntilOf(person: Pick<DirectoryUser, "pausedUntil"> | undefined, now = Date.now()): string | null {
  const until = person?.pausedUntil;
  return until !== undefined && Date.parse(until) > now ? until : null;
}

// In the reader's locale and time zone, as messages' times are (messages.ts).
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });

/** When a pause ends, as of `now`: "3:45 PM" today, "tomorrow at 9:00 AM", or "Monday at 9:00 AM" in the week after. */
export function pauseEndLabel(end: Date, now = new Date()): string {
  const time = timeFormat.format(end);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (dayFormat.format(end) === dayFormat.format(now)) return time;
  if (dayFormat.format(end) === dayFormat.format(tomorrow)) return `tomorrow at ${time}`;
  return `${weekdayFormat.format(end)} at ${time}`;
}
