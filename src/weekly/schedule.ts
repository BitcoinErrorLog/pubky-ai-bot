import { WEEKLY_FIRE_HOUR, type WeeklySeries } from "./types.js";
import { isoWeekKey, isMondayInZone, isSundayInZone, previousIsoWeekKey, zonedParts } from "./week-key.js";

export interface WeeklyFire {
  series: WeeklySeries;
  weekKey: string;
}

/**
 * Which autonomous series should run at `now` in `timeZone`.
 * Sunday 09:00+ → feedback for the ISO week containing that Sunday.
 * Monday 09:00+ → updates for the previous ISO week.
 * Catch-up: same weekday after fire hour still returns the slot.
 */
export function weeklyFiresDue(now: Date, timeZone: string): WeeklyFire[] {
  const z = zonedParts(now, timeZone);
  if (z.hour < WEEKLY_FIRE_HOUR) return [];
  const out: WeeklyFire[] = [];
  if (isSundayInZone(now, timeZone)) {
    out.push({ series: "feedback", weekKey: isoWeekKey(now, timeZone) });
  }
  if (isMondayInZone(now, timeZone)) {
    out.push({ series: "updates", weekKey: previousIsoWeekKey(now, timeZone) });
  }
  return out;
}

export function shouldCollectTags(lastCollectMs: number | null, nowMs: number, intervalMs: number): boolean {
  if (lastCollectMs === null) return true;
  return nowMs - lastCollectMs >= intervalMs;
}
