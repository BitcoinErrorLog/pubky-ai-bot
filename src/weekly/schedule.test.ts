import { describe, expect, it } from "vitest";
import { weeklyFiresDue, shouldCollectTags } from "./schedule.js";
import { feedbackWindow, isoWeekKey, isoWeekKeyFromYmd, mondayOfIsoWeek, nextIssueWeekKey, previousIsoWeekKey, updatesWindow, zonedParts } from "./week-key.js";
import { parseWeekKey } from "./types.js";

describe("iso week_key", () => {
  it("assigns Sunday 5 Sep 2026 to 2026-W36", () => {
    expect(isoWeekKeyFromYmd(2026, 9, 5)).toBe("2026-W36");
    expect(isoWeekKey(new Date("2026-09-05T12:00:00+01:00"), "Europe/London")).toBe("2026-W36");
  });
  it("monday of 2026-W36 is 31 Aug 2026 UTC", () => {
    const mon = mondayOfIsoWeek("2026-W36");
    expect(mon.toISOString().slice(0, 10)).toBe("2026-08-31");
  });
  it("previous week from Monday 7 Sep 2026 is 2026-W36", () => {
    expect(previousIsoWeekKey(new Date("2026-09-07T10:00:00+01:00"), "Europe/London")).toBe("2026-W36");
  });
  it("rejects a bad --week", () => {
    expect(() => parseWeekKey("2026-36")).toThrow(/YYYY-Www/);
  });
});

describe("weeklyFiresDue (fake clock)", () => {
  const tz = "Europe/London";
  it("does not fire before 09:00 on Sunday", () => {
    expect(weeklyFiresDue(new Date("2026-09-06T08:59:00+01:00"), tz)).toEqual([]);
  });
  it("fires feedback on Sunday at 09:00 and later the same day (catch-up)", () => {
    expect(weeklyFiresDue(new Date("2026-09-06T09:00:00+01:00"), tz)).toEqual([
      { series: "feedback", weekKey: "2026-W36" },
    ]);
    expect(weeklyFiresDue(new Date("2026-09-06T22:10:00+01:00"), tz)).toEqual([
      { series: "feedback", weekKey: "2026-W36" },
    ]);
  });
  it("fires updates on Monday at 09:00 for the previous ISO week", () => {
    expect(weeklyFiresDue(new Date("2026-09-07T09:00:00+01:00"), tz)).toEqual([
      { series: "updates", weekKey: "2026-W36" },
    ]);
  });
  it("does not catch up a missed Sunday once it is Monday", () => {
    const fires = weeklyFiresDue(new Date("2026-09-07T10:00:00+01:00"), tz);
    expect(fires.some((f) => f.series === "feedback")).toBe(false);
  });
  it("reads London weekday across BST", () => {
    expect(zonedParts(new Date("2026-09-06T08:00:00Z"), tz).weekday).toBe(7);
    expect(zonedParts(new Date("2026-09-06T08:00:00Z"), tz).hour).toBe(9);
  });
});

describe("shouldCollectTags", () => {
  it("fires immediately then waits the interval", () => {
    expect(shouldCollectTags(null, 1000, 3600_000)).toBe(true);
    expect(shouldCollectTags(1000, 1000 + 3_599_000, 3600_000)).toBe(false);
    expect(shouldCollectTags(1000, 1000 + 3_600_000, 3600_000)).toBe(true);
  });
});

describe("next issue week (Saturday dry-run)", () => {
  const tz = "Europe/London";
  it("Saturday 5 Sep 2026 selects 2026-W36 for both series", () => {
    const sat = new Date("2026-09-05T11:00:00+01:00");
    expect(nextIssueWeekKey("feedback", sat, tz)).toBe("2026-W36");
    expect(nextIssueWeekKey("updates", sat, tz)).toBe("2026-W36");
  });
  it("Tuesday selects next Monday's previous week for updates", () => {
    const tue = new Date("2026-09-08T11:00:00+01:00");
    expect(nextIssueWeekKey("feedback", tue, tz)).toBe("2026-W37");
    expect(nextIssueWeekKey("updates", tue, tz)).toBe("2026-W37");
  });
});

describe("week windows", () => {
  const tz = "Europe/London";
  it("feedback W36 is 7 days ending Sunday 6 Sep 09:00 London", () => {
    const w = feedbackWindow("2026-W36", tz);
    expect(new Date(w.untilMs).toISOString()).toBe("2026-09-06T08:00:00.000Z");
    expect(new Date(w.sinceMs).toISOString()).toBe("2026-08-30T08:00:00.000Z");
  });
  it("updates W36 is Monday 00:00 through Sunday 23:59:59.999 London", () => {
    const w = updatesWindow("2026-W36", tz);
    expect(new Date(w.sinceMs).toISOString()).toBe("2026-08-30T23:00:00.000Z");
    expect(new Date(w.untilMs).toISOString()).toBe("2026-09-06T22:59:59.999Z");
  });
});
