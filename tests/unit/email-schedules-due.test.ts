import { describe, expect, it } from "vitest";

import {
  type ScheduleTiming, CATCH_UP_MS, DAILY_PASS_UTC_HOUR, describeInstant, dueOccurrence, isDue, isoWeekKey, latestOccurrence, localDate, localInstant, mondayOf, nextDailyPassAtOrAfter, nextRun, parseTimeOfDay, safeZone,
} from "@/lib/email/schedules/due";

const at = (iso: string) => new Date(iso);
const daily = (time = "08:00", extra: Partial<ScheduleTiming> = {}): ScheduleTiming => ({ enabled: true, frequency: "daily", weekday: null, time_of_day: time, run_at: null, timezone: "Europe/London", ...extra });
const weekly = (weekday: number, time = "09:00", extra: Partial<ScheduleTiming> = {}): ScheduleTiming => ({ enabled: true, frequency: "weekly", weekday, time_of_day: time, run_at: null, timezone: "Europe/London", ...extra });
const once = (run_at: string, extra: Partial<ScheduleTiming> = {}): ScheduleTiming => ({ enabled: true, frequency: "once", weekday: null, time_of_day: "08:00", run_at, timezone: "Europe/London", ...extra });
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("local time in a zone, across the clock changes", () => {
  it("08:00 in London is 07:00 UTC in summer and 08:00 UTC in winter", () => {
    expect(iso(localInstant("2026-10-24", 8, 0, "Europe/London"))).toBe("2026-10-24T07:00:00.000Z");
    expect(iso(localInstant("2026-10-25", 8, 0, "Europe/London"))).toBe("2026-10-25T08:00:00.000Z");
  });

  it("a local time that happens twice (01:30 on 25 Oct 2026) is the first one", () => {
    expect(iso(localInstant("2026-10-25", 1, 30, "Europe/London"))).toBe("2026-10-25T00:30:00.000Z");
  });

  it("a local time that does not exist (01:30 on 29 Mar 2026, and on 28 Mar 2027) happens an hour later, not never", () => {
    expect(iso(localInstant("2026-03-29", 1, 30, "Europe/London"))).toBe("2026-03-29T01:30:00.000Z"); // = 02:30 BST
    expect(iso(localInstant("2027-03-28", 1, 30, "Europe/London"))).toBe("2027-03-28T01:30:00.000Z");
    expect(iso(localInstant("2026-03-29", 2, 30, "Europe/London"))).toBe("2026-03-29T01:30:00.000Z"); // 02:30 local also exists once, as BST
  });

  it("other zones work, and an unknown zone falls back to London instead of throwing", () => {
    expect(iso(localInstant("2026-10-25", 8, 0, "America/New_York"))).toBe("2026-10-25T12:00:00.000Z");
    expect(safeZone("Mars/Olympus")).toBe("Europe/London");
    expect(safeZone(null)).toBe("Europe/London");
    expect(iso(localInstant("2026-10-24", 8, 0, "Mars/Olympus"))).toBe("2026-10-24T07:00:00.000Z");
  });

  it("the local date of an instant follows the zone, not UTC", () => {
    expect(localDate(at("2026-07-01T23:30:00Z"), "Europe/London")).toBe("2026-07-02");
    expect(localDate(at("2026-12-01T23:30:00Z"), "Europe/London")).toBe("2026-12-01");
  });
});

describe("daily schedules and the clock change on 25 Oct 2026", () => {
  it("runs at 08:00 local on both sides: 07:00 UTC on Sat 24 Oct (BST), 08:00 UTC on Sun 25 Oct (GMT)", () => {
    expect(iso(nextRun(daily(), at("2026-10-23T12:00:00Z")))).toBe("2026-10-24T07:00:00.000Z");
    expect(iso(nextRun(daily(), at("2026-10-24T12:00:00Z")))).toBe("2026-10-25T08:00:00.000Z");
    expect(iso(nextRun(daily(), at("2026-10-25T12:00:00Z")))).toBe("2026-10-26T08:00:00.000Z");
  });

  it("a new period starts at the scheduled minute, not a minute before (isDue stays true for the catch-up window; the key says which period)", () => {
    expect(dueOccurrence(daily(), at("2026-10-25T07:59:59Z"))?.periodKey).toBe("2026-10-24"); // 07:59 GMT: Sunday's 08:00 hasn't come; Saturday's (24 h 59 min ago, the day is 25 h long) is still the one to send
    expect(dueOccurrence(daily(), at("2026-10-25T08:00:00Z"))?.periodKey).toBe("2026-10-25");
    expect(dueOccurrence(daily(), at("2026-10-24T06:59:59Z"))?.periodKey).toBe("2026-10-23"); // 07:59 BST
    expect(dueOccurrence(daily(), at("2026-10-24T07:00:00Z"))?.periodKey).toBe("2026-10-24");
    expect(isDue(daily(), at("2026-10-25T08:00:00Z"))).toBe(true);
    expect(isDue(daily("08:00", { updated_at: "2026-10-25T07:30:00Z" }), at("2026-10-25T07:59:59Z"))).toBe(false); // nothing earlier than the last change
  });

  it("01:30 daily: the repeated hour runs once (the first 01:30), and the period key is the local date", () => {
    const s = daily("01:30");
    expect(iso(nextRun(s, at("2026-10-24T12:00:00Z")))).toBe("2026-10-25T00:30:00.000Z");
    expect(dueOccurrence(s, at("2026-10-25T00:30:00Z"))?.periodKey).toBe("2026-10-25");
    // At the second 01:30 (01:30Z) the latest occurrence is still the first one, with the same key: the database refuses a second run.
    expect(dueOccurrence(s, at("2026-10-25T01:30:00Z"))?.periodKey).toBe("2026-10-25");
    expect(iso(nextRun(s, at("2026-10-25T01:30:00Z")))).toBe("2026-10-26T01:30:00.000Z");
  });

  it("is due all day after the time, with one key per local day", () => {
    expect(dueOccurrence(daily(), at("2026-10-25T20:00:00Z"))?.periodKey).toBe("2026-10-25");
    expect(dueOccurrence(daily(), at("2026-10-26T07:59:00Z"))?.periodKey).toBe("2026-10-25"); // before 08:00 on the 26th: still yesterday's, within 24 h
  });
});

describe("daily schedules and the clock change in late March", () => {
  it("08:00 local is 08:00 UTC on Sat 28 Mar 2026 (GMT) and 07:00 UTC on Sun 29 Mar (BST)", () => {
    expect(iso(nextRun(daily(), at("2026-03-27T12:00:00Z")))).toBe("2026-03-28T08:00:00.000Z");
    expect(iso(nextRun(daily(), at("2026-03-28T12:00:00Z")))).toBe("2026-03-29T07:00:00.000Z");
  });

  it("01:30 on 29 Mar 2026 does not exist: it runs at 02:30 BST (01:30 UTC), once", () => {
    const s = daily("01:30");
    expect(iso(nextRun(s, at("2026-03-28T12:00:00Z")))).toBe("2026-03-29T01:30:00.000Z");
    expect(dueOccurrence(s, at("2026-03-29T01:29:59Z"))?.periodKey).toBe("2026-03-28"); // still yesterday's slot: nothing new for the 29th yet
    expect(dueOccurrence(s, at("2026-03-29T01:30:00Z"))?.periodKey).toBe("2026-03-29");
    expect(iso(nextRun(s, at("2026-03-29T01:30:00Z")))).toBe("2026-03-30T00:30:00.000Z"); // 01:30 BST on the 30th
  });

  it("and in 2027 (28 Mar)", () => {
    expect(iso(nextRun(daily("01:30"), at("2027-03-27T12:00:00Z")))).toBe("2027-03-28T01:30:00.000Z");
  });
});

describe("weekly schedules", () => {
  it("Monday 09:00 London: next from Fri 23 Oct 2026 is Mon 26 Oct 09:00 GMT; from Sun 25 Oct 00:30 UTC too", () => {
    expect(iso(nextRun(weekly(1), at("2026-10-23T12:00:00Z")))).toBe("2026-10-26T09:00:00.000Z");
    expect(iso(nextRun(weekly(1), at("2026-10-26T09:00:00Z")))).toBe("2026-11-02T09:00:00Z".replace("Z", ".000Z"));
  });

  it("Sunday 09:00 across the October change: Sun 18 Oct is BST (08:00Z), Sun 25 Oct is GMT (09:00Z)", () => {
    expect(iso(nextRun(weekly(0), at("2026-10-18T12:00:00Z")))).toBe("2026-10-25T09:00:00.000Z");
    expect(iso(nextRun(weekly(0), at("2026-10-11T12:00:00Z")))).toBe("2026-10-18T08:00:00.000Z");
  });

  it("is due from its weekday and time until the catch-up window ends (48 h), with the ISO week as the key", () => {
    const s = weekly(1, "09:00");
    expect(dueOccurrence(s, at("2026-10-26T09:00:00Z"))?.periodKey).toBe("2026-W44");
    expect(isDue(s, at("2026-10-26T08:59:59Z"))).toBe(false);
    expect(isDue(s, at("2026-10-27T08:00:00Z"))).toBe(true); // 23 h late: still sent
    expect(isDue(s, at("2026-10-27T10:00:00Z"))).toBe(true); // 25 h late: a once-a-day pass that ran a little later than the day before still sends it
    expect(isDue(s, at("2026-10-28T09:00:00Z"))).toBe(true); // exactly 48 h
    expect(isDue(s, at("2026-10-28T09:00:01Z"))).toBe(false); // older than that: skipped, not sent days late
  });

  it("a weekly schedule without a weekday is never due and never has a next run", () => {
    const s = weekly(1, "09:00", { weekday: null });
    expect(isDue(s, at("2026-10-26T09:00:00Z"))).toBe(false);
    expect(nextRun(s, at("2026-10-23T12:00:00Z"))).toBeNull();
    expect(latestOccurrence(s, at("2026-10-26T09:00:00Z"))).toBeNull();
  });
});

describe("once", () => {
  const s = once("2026-11-03T14:30:00.000Z");
  it("is due from the moment, within 48 h, and its key is the moment", () => {
    expect(isDue(s, at("2026-11-03T14:29:59Z"))).toBe(false);
    expect(dueOccurrence(s, at("2026-11-03T14:30:00Z"))?.periodKey).toBe("2026-11-03T14:30:00.000Z");
    expect(isDue(s, at("2026-11-05T14:30:00Z"))).toBe(true);
    expect(isDue(s, at("2026-11-05T14:30:01Z"))).toBe(false);
  });
  it("has a next run only while it is ahead", () => {
    expect(iso(nextRun(s, at("2026-11-01T00:00:00Z")))).toBe("2026-11-03T14:30:00.000Z");
    expect(nextRun(s, at("2026-11-03T14:30:00Z"))).toBeNull();
  });
});

describe("off, changed-after, and bad data", () => {
  it("an off schedule is never due and has no next run", () => {
    expect(isDue(daily("08:00", { enabled: false }), at("2026-10-25T09:00:00Z"))).toBe(false);
    expect(nextRun(daily("08:00", { enabled: false }), at("2026-10-25T09:00:00Z"))).toBeNull();
  });

  it("switching a schedule on after today's time waits for tomorrow instead of sending at once", () => {
    const s = daily("08:00", { updated_at: "2026-10-26T14:00:00Z" });
    expect(isDue(s, at("2026-10-26T14:05:00Z"))).toBe(false);
    expect(isDue(s, at("2026-10-27T08:00:00Z"))).toBe(true);
    // Changed at 07:00, before the 08:00 slot: that slot still runs.
    expect(isDue(daily("08:00", { updated_at: "2026-10-26T07:00:00Z" }), at("2026-10-26T08:00:00Z"))).toBe(true);
  });

  it("a time of day that can't be read falls back to 08:00; a bad run_at is never due", () => {
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("08:00:00")).toEqual([8, 0]);
    expect(parseTimeOfDay("8:05")).toEqual([8, 5]);
    expect(parseTimeOfDay("")).toBeNull();
    expect(iso(nextRun(daily("nonsense"), at("2026-10-23T12:00:00Z")))).toBe("2026-10-24T07:00:00.000Z");
    expect(isDue(once("not a date"), at("2026-11-03T14:30:00Z"))).toBe(false);
  });

  it("the catch-up window is 48 hours: wider than the gap between two once-a-day passes (up to ~25 h, Vercel Hobby starts a cron anywhere in its hour) so one missed pass is still caught", () => {
    expect(CATCH_UP_MS).toBe(48 * 3_600_000);
    expect(CATCH_UP_MS).toBeGreaterThan(25 * 3_600_000);
  });
});

describe("a once-a-day pass (Vercel Hobby): a chosen time that has passed is sent at the next pass, once", () => {
  // The pass runs at 05:00 UTC every day (vercel.json "0 5 * * *"); Vercel Hobby may start it anywhere in that hour.
  const passes = (days: string[], minute = 0) => days.map((d) => at(`${d}T05:${String(minute).padStart(2, "0")}:00Z`));
  /** The period keys that would be sent over these passes (a key is sent the first time it is due; the database refuses the second). */
  const sent = (s: ScheduleTiming, times: Date[]) => {
    const keys: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const t of times) {
      const key = dueOccurrence(s, t)?.periodKey;
      if (key && !seen.has(key)) { seen.add(key); keys.push([t.toISOString(), key]); }
    }
    return keys;
  };

  it("a daily 08:00 reminder goes out at the next 05:00 pass (21 h late), every day, never twice", () => {
    const days = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"];
    expect(sent(daily("08:00"), [...passes(days), ...passes(days, 59), ...passes(days)])).toEqual([
      ["2026-10-26T05:00:00.000Z", "2026-10-25"], ["2026-10-27T05:00:00.000Z", "2026-10-26"], ["2026-10-28T05:00:00.000Z", "2026-10-27"], ["2026-10-29T05:00:00.000Z", "2026-10-28"],
    ]);
  });

  it("a time before the pass (04:00) goes out at the same day's pass", () => {
    expect(sent(daily("04:00"), passes(["2026-11-02", "2026-11-03"]))).toEqual([["2026-11-02T05:00:00.000Z", "2026-11-02"], ["2026-11-03T05:00:00.000Z", "2026-11-03"]]);
  });

  it("a time just after the pass (05:01) waits for the next pass; if Vercel starts a pass late (05:59) only the newest slot goes, never two at once", () => {
    expect(sent(daily("05:01"), [at("2026-11-02T05:00:00Z"), at("2026-11-03T05:00:00Z")])).toEqual([["2026-11-02T05:00:00.000Z", "2026-11-01"], ["2026-11-03T05:00:00.000Z", "2026-11-02"]]);
    expect(sent(daily("05:01"), [at("2026-11-02T05:00:00Z"), at("2026-11-03T05:59:00Z")])).toEqual([["2026-11-02T05:00:00.000Z", "2026-11-01"], ["2026-11-03T05:59:00.000Z", "2026-11-03"]]);
  });

  it("never before it was saved: saved at 14:00 on the 26th, the 08:00 slot of the 26th is not sent; the 27th's goes at the 28th's pass", () => {
    const saved = daily("08:00", { updated_at: "2026-10-26T14:00:00Z" });
    expect(sent(saved, passes(["2026-10-27", "2026-10-28", "2026-10-29"]))).toEqual([["2026-10-28T05:00:00.000Z", "2026-10-27"], ["2026-10-29T05:00:00.000Z", "2026-10-28"]]);
    // Saved at 06:00 on the 26th, before that day's 08:00: the 26th's slot is the first, sent at the 27th's pass.
    expect(sent(daily("08:00", { updated_at: "2026-10-26T06:00:00Z" }), passes(["2026-10-26", "2026-10-27"]))).toEqual([["2026-10-27T05:00:00.000Z", "2026-10-26"]]);
  });

  it("weekly Monday 09:00 goes out at Tuesday's pass, once, and the passes between send nothing", () => {
    const week = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"];
    expect(sent(weekly(1, "09:00"), passes(week))).toEqual([["2026-10-27T05:00:00.000Z", "2026-W44"], ["2026-11-03T05:00:00.000Z", "2026-W45"]]);
  });

  it("a once-only moment goes out at the next pass, once", () => {
    expect(sent(once("2026-11-03T14:30:00.000Z"), passes(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]))).toEqual([["2026-11-04T05:00:00.000Z", "2026-11-03T14:30:00.000Z"]]);
  });

  it("one missed pass is caught by the next", () => {
    expect(sent(daily("08:00"), [at("2026-10-29T05:00:00Z")])).toEqual([["2026-10-29T05:00:00.000Z", "2026-10-28"]]);
  });

  it("works the same in summer (BST): a daily 08:00 (07:00 UTC) goes out at the next 05:00 UTC pass", () => {
    expect(sent(daily("08:00"), passes(["2027-07-06", "2027-07-07"]))).toEqual([["2027-07-06T05:00:00.000Z", "2027-07-05"], ["2027-07-07T05:00:00.000Z", "2027-07-06"]]);
  });

  it("the pass that first sends an occurrence is the first 05:00 UTC at or after it", () => {
    expect(iso(nextDailyPassAtOrAfter(at("2026-10-26T07:00:00Z")))).toBe("2026-10-27T05:00:00.000Z");
    expect(iso(nextDailyPassAtOrAfter(at("2026-10-26T04:59:00Z")))).toBe("2026-10-26T05:00:00.000Z");
    expect(iso(nextDailyPassAtOrAfter(at("2026-10-26T05:00:00Z")))).toBe("2026-10-26T05:00:00.000Z");
    expect(DAILY_PASS_UTC_HOUR).toBe(5);
  });
});

describe("period keys", () => {
  it("ISO weeks, including the year edges", () => {
    expect(isoWeekKey("2026-10-26")).toBe("2026-W44");
    expect(isoWeekKey("2026-11-01")).toBe("2026-W44"); // Sunday
    expect(isoWeekKey("2026-12-31")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-04")).toBe("2027-W01");
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(mondayOf("2026-11-01")).toBe("2026-10-26");
  });

  it("a daily key is the local date even when UTC is already the next day", () => {
    // 00:30 BST on 2 Jul is 23:30Z on 1 Jul.
    expect(dueOccurrence(daily("00:30"), at("2026-07-01T23:30:00Z"))?.periodKey).toBe("2026-07-02");
  });

  it("the same period gives the same key on every call, a new period a new key", () => {
    const a = dueOccurrence(weekly(1), at("2026-10-26T09:05:00Z"))?.periodKey;
    const b = dueOccurrence(weekly(1), at("2026-10-26T20:00:00Z"))?.periodKey;
    const c = dueOccurrence(weekly(1), at("2026-11-02T09:05:00Z"))?.periodKey;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe("the Next run words", () => {
  it("names the day, date, time and the zone", () => {
    expect(describeInstant(at("2026-10-26T09:00:00Z"), "Europe/London")).toBe("Mon 26 Oct 2026 at 09:00 (GMT)");
    expect(describeInstant(at("2026-07-06T08:00:00Z"), "Europe/London")).toBe("Mon 6 Jul 2026 at 09:00 (BST)");
  });
});
