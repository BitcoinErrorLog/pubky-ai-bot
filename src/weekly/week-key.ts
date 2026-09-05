import { WEEKLY_FIRE_HOUR, WEEK_KEY_RE, type WeeklySeries } from "./types.js";

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number;
}

export interface WeekWindow {
  sinceMs: number;
  untilMs: number;
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Calendar parts of `at` in `timeZone` (hour 0–23, weekday ISO Mon=1 … Sun=7). */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const weekday = WEEKDAY_TO_ISO[map.weekday ?? ""];
  if (!weekday) throw new Error(`unrecognised weekday in ${timeZone}`);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    weekday,
  };
}

/** Offset of `timeZone` at instant `at`: zone wall time minus UTC. */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUTC - at.getTime();
}

/** Instant at which `timeZone` shows this civil wall time. */
export function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = zoneOffsetMs(new Date(utcGuess), timeZone);
  const adjusted = new Date(utcGuess - offset1);
  const offset2 = zoneOffsetMs(adjusted, timeZone);
  return new Date(utcGuess - offset2);
}

/** ISO week of the calendar day of `at` in `timeZone`. */
export function isoWeekKey(at: Date, timeZone: string): string {
  const z = zonedParts(at, timeZone);
  return isoWeekKeyFromYmd(z.year, z.month, z.day);
}

export function isoWeekKeyFromYmd(year: number, month: number, day: number): string {
  const tmp = new Date(Date.UTC(year, month - 1, day));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const isoYear = tmp.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Monday (UTC noon) of an ISO week, for titles. */
export function mondayOfIsoWeek(weekKey: string): Date {
  const m = WEEK_KEY_RE.exec(weekKey);
  if (!m) throw new Error("week must be YYYY-Www");
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  return monday;
}

function ymdOfMonday(weekKey: string): { year: number; month: number; day: number } {
  const mon = mondayOfIsoWeek(weekKey);
  return { year: mon.getUTCFullYear(), month: mon.getUTCMonth() + 1, day: mon.getUTCDate() };
}

function addUtcDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function formatWeekOfDate(weekKey: string): string {
  return formatDayMonthYear(mondayOfIsoWeek(weekKey));
}

export function formatDayMonthYear(at: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** Previous ISO week relative to the calendar day of `at` in `timeZone`. */
export function previousIsoWeekKey(at: Date, timeZone: string): string {
  const z = zonedParts(at, timeZone);
  const prev = new Date(Date.UTC(z.year, z.month - 1, z.day - 7));
  return isoWeekKeyFromYmd(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
}

export function isSundayInZone(at: Date, timeZone: string): boolean {
  return zonedParts(at, timeZone).weekday === 7;
}

export function isMondayInZone(at: Date, timeZone: string): boolean {
  return zonedParts(at, timeZone).weekday === 1;
}

/** Instant of 00:00 in `timeZone` on the calendar day of `at`. */
export function startOfZonedDay(at: Date, timeZone: string): Date {
  const z = zonedParts(at, timeZone);
  return zonedLocalToUtc(z.year, z.month, z.day, 0, 0, 0, timeZone);
}

/** Sunday 09:00 fire instant for this ISO week in `timeZone`. */
export function sundayFireInstant(weekKey: string, timeZone: string): Date {
  const mon = ymdOfMonday(weekKey);
  const sun = addUtcDays(mon.year, mon.month, mon.day, 6);
  return zonedLocalToUtc(sun.year, sun.month, sun.day, WEEKLY_FIRE_HOUR, 0, 0, timeZone);
}

/**
 * Sunday feedback window: 7 days ending at the Sunday 09:00 fire in `timeZone`.
 */
export function feedbackWindow(weekKey: string, timeZone: string): WeekWindow {
  const untilMs = sundayFireInstant(weekKey, timeZone).getTime();
  return { sinceMs: untilMs - 7 * 86_400_000, untilMs };
}

/**
 * Monday updates window: that ISO week's Monday 00:00 → Sunday 23:59:59.999 in `timeZone`.
 */
export function updatesWindow(weekKey: string, timeZone: string): WeekWindow {
  const mon = ymdOfMonday(weekKey);
  const since = zonedLocalToUtc(mon.year, mon.month, mon.day, 0, 0, 0, timeZone);
  const sun = addUtcDays(mon.year, mon.month, mon.day, 6);
  const until = zonedLocalToUtc(sun.year, sun.month, sun.day, 23, 59, 59, timeZone);
  return { sinceMs: since.getTime(), untilMs: until.getTime() + 999 };
}

export function seriesWindow(series: WeeklySeries, weekKey: string, timeZone: string): WeekWindow {
  return series === "feedback" ? feedbackWindow(weekKey, timeZone) : updatesWindow(weekKey, timeZone);
}

/**
 * ISO week of the issue that would fire next (or is already due today).
 * Saturday with no `--week` → this ISO week for both series (feedback fires
 * tomorrow; Monday's updates cover this week).
 */
export function nextIssueWeekKey(series: WeeklySeries, now: Date, timeZone: string): string {
  if (series === "feedback") return isoWeekKey(now, timeZone);
  const z = zonedParts(now, timeZone);
  if (z.weekday === 1) return previousIsoWeekKey(now, timeZone);
  const daysAhead = z.weekday === 7 ? 1 : 8 - z.weekday;
  const nextMon = new Date(Date.UTC(z.year, z.month - 1, z.day + daysAhead, 12, 0, 0));
  return previousIsoWeekKey(nextMon, timeZone);
}
