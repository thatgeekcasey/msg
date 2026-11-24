import { SCHEDULE_AHEAD_MS } from "@ember/protocol";
import { timeLabel } from "./messages";

// The times Schedule for later offers, as Slack's does, in the reader's locale and time zone.

/** A time the schedule menu offers: "Tomorrow at 9:00 AM". */
export interface ScheduleChoice {
  label: string;
  at: Date;
}

/** The hour the menu's mornings start at, as Slack's do. */
const MORNING = 9;
/** How many hours on the menu's "Later today" is, to the hour, as Slack's is. */
const LATER_HOURS = 3;
/** How far apart Custom time's times are. */
const SLOT_MINUTES = 30;
const DAY_MS = 24 * 60 * 60_000;

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const yearDateFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/** `day`'s date `days` days on, at `minutes` past midnight as the clock reads then. */
const dayAt = (day: Date, days: number, minutes = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + days, 0, minutes);

/** How many days on from `now` `at` is, as the calendar counts them, so -1 is yesterday. */
const daysOn = (at: Date, now: Date) => Math.round((dayAt(at, 0).getTime() - dayAt(now, 0).getTime()) / DAY_MS);

/** Whether `a` and `b` are on the same day, as the calendar has them. */
export const sameDay = (a: Date, b: Date) => daysOn(a, b) === 0;

/** "Thursday, November 26", or "Monday, January 4, 2027" in a year other than `now`'s. */
const dateOf = (at: Date, now: Date) => (at.getFullYear() === now.getFullYear() ? dateFormat : yearDateFormat).format(at);

/**
 * The times the schedule menu offers as of `now`, as Slack's does: three hours on, to the hour, while that's
 * still today; tomorrow at 9:00 AM; and Monday at 9:00 AM, which tomorrow is already on a Sunday.
 */
export function scheduleChoices(now = new Date()): ScheduleChoice[] {
  const choices: ScheduleChoice[] = [];
  const later = dayAt(now, 0, (now.getHours() + LATER_HOURS) * 60);
  if (daysOn(later, now) === 0) choices.push({ label: `Later today at ${timeLabel(later)}`, at: later });
  const tomorrow = dayAt(now, 1, MORNING * 60);
  choices.push({ label: `Tomorrow at ${timeLabel(tomorrow)}`, at: tomorrow });
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday > 1) {
    const monday = dayAt(now, toMonday, MORNING * 60);
    choices.push({ label: `${toMonday === 7 ? "Next " : ""}${weekdayFormat.format(monday)} at ${timeLabel(monday)}`, at: monday });
  }
  return choices;
}

/**
 * When a scheduled message is to be sent, or was to be, as of `now`: "today at 1:00 PM", "tomorrow at 9:00 AM",
 * "Monday at 9:00 AM" within the week, or "Thursday, November 26 at 9:00 AM".
 */
export function sendAtLabel(at: Date, now = new Date()): string {
  const days = daysOn(at, now);
  const time = timeLabel(at);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${weekdayFormat.format(at)} at ${time}`;
  return `${dateOf(at, now)} at ${time}`;
}

/**
 * The times Custom time offers on `day` as of `now`: each half hour of it still to come, up to 120 days on.
 * A half hour a clock change skips is offered once, as the time it comes to.
 */
export function scheduleTimes(day: Date, now = new Date()): Date[] {
  const last = now.getTime() + SCHEDULE_AHEAD_MS;
  const times = new Map<number, Date>();
  for (let minutes = 0; minutes < 24 * 60; minutes += SLOT_MINUTES) {
    const at = dayAt(day, 0, minutes);
    if (at > now && at.getTime() <= last && daysOn(at, day) === 0) times.set(at.getTime(), at);
  }
  return [...times.values()];
}

/** The days Custom time offers as of `now`, each as its midnight: today, while it has a time to come, through 120 days on. */
export function scheduleDays(now = new Date()): Date[] {
  const last = Math.ceil(SCHEDULE_AHEAD_MS / DAY_MS);
  const days = Array.from({ length: last + 1 }, (_, i) => dayAt(now, i));
  return days.filter((day, i) => (i > 0 && i < last) || scheduleTimes(day, now).length > 0);
}

/** A day as Custom time's date select offers it: "Today", "Tomorrow", or "Thursday, November 19". */
export function scheduleDayLabel(day: Date, now = new Date()): string {
  const days = daysOn(day, now);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return dateOf(day, now);
}

/** The time Custom time starts at, as Slack's does: the first half hour at least half an hour on. */
export function customTimeStart(now = new Date()): Date {
  const soon = new Date(now.getTime() + SLOT_MINUTES * 60_000);
  return dayAt(soon, 0, Math.ceil((soon.getHours() * 60 + soon.getMinutes()) / SLOT_MINUTES) * SLOT_MINUTES);
}

/** Which of `times`, a day's, reads on the clock as `time` does, or the first, as Custom time keeps its time as its day changes. */
export function sameTimeOf(times: Date[], time: Date): Date | undefined {
  return times.find((at) => at.getHours() === time.getHours() && at.getMinutes() === time.getMinutes()) ?? times[0];
}

/** How the reader's locale names `at`'s time zone, as `timeZoneName` has it. */
const zoneNameOf = (at: Date, timeZoneName: "long" | "longGeneric") =>
  new Intl.DateTimeFormat(undefined, { timeZoneName }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value;

/**
 * The zone Custom time's times are in, as the reader's locale names it: "Pacific Time", or as "long" does,
 * "Coordinated Universal Time", for a zone it can only name by its offset generically, or in a browser
 * that can't name zones generically.
 */
export function timeZoneLabel(at = new Date()): string {
  const generic = genericZoneNameOf(at);
  if (generic && !/^(GMT|UTC)[+\-−]/.test(generic)) return generic;
  return zoneNameOf(at, "long") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function genericZoneNameOf(at: Date): string | undefined {
  try {
    return zoneNameOf(at, "longGeneric");
  } catch {
    // An older browser, which can't name a zone generically.
    return undefined;
  }
}
