import { WEEK_KEY_RE } from "./types.js";

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number;
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
