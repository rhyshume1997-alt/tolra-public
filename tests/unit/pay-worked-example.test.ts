/**
 * docs/PAY-WORKED-EXAMPLE.md, checked against the real code (lib/time-sheet.ts) with the default JNR settings.
 *
 * The controller's rules (Sun 18 Oct 2026): paid = clock in to clock out minus unpaid breaks; NO computed overtime (no 8 hour rule, no Saturday,
 * Sunday or bank holiday rule, no multiplier); overtime is only what a person ticked ("Overtime" day tick, migration 074); bank
 * holidays are holiday allowance, so a bank holiday worked is an ordinary day unless ticked. Rhys (Sun 18 Oct) confirmed the short-day
 * rule: "just do it as hours worked" (under 6 hours only clocked breaks come off).
 *
 * The figures below are the HAND-WORKED ones from the document, in minutes, row for row. The paid figures are unchanged from the
 * earlier version of this example. Do not edit a number here to make the code pass: if the code disagrees, re-check the hand
 * arithmetic against the rules, and if the hand figures are right the code has a bug.
 */
import { describe, expect, it } from "vitest";

import { type SavedDayFlags, DAY_FLAG_KEYS, NO_FLAGS, flagTotalsSnapshot, weekDayFlags } from "@/lib/time-day-flags";
import { type AttendanceEvent, DEFAULT_TIME_SETTINGS, approvalSnapshot, dayTotals, hm, localInstant, weekTotals } from "@/lib/time-sheet";

const S = DEFAULT_TIME_SETTINGS;
const LATER = new Date("2027-06-01T00:00:00Z").getTime();

let n = 0;
function ev(action: AttendanceEvent["action"], date: string, time: string): AttendanceEvent {
  n += 1;
  const r = localInstant(date, time);
  if (r.kind !== "ok") throw new Error(`${date} ${time}: ${r.kind}`);
  return { id: `w${n}`, user_id: "worker-a", action, at: r.at.toISOString(), received_at: new Date(2026, 0, 1, 0, 0, n).toISOString() };
}

type Row = {
  offset: number; // days after the Monday
  in: string;
  out: string;
  breaks: [string, string][]; // clocked breaks
  attendance: number;
  breakOff: number;
  rule: "clocked" | "allowance" | "none";
  paid: number;
  paidHm: string;
};

/** The document's table (Monday to Saturday), all minutes. */
const WEEK: Row[] = [
  { offset: 0, in: "08:00", out: "16:45", breaks: [], attendance: 525, breakOff: 45, rule: "allowance", paid: 480, paidHm: "8:00" },
  { offset: 1, in: "07:00", out: "17:30", breaks: [], attendance: 630, breakOff: 45, rule: "allowance", paid: 585, paidHm: "9:45" },
  { offset: 2, in: "08:00", out: "13:00", breaks: [["10:30", "10:40"]], attendance: 300, breakOff: 10, rule: "clocked", paid: 290, paidHm: "4:50" },
  { offset: 3, in: "07:30", out: "17:00", breaks: [["10:00", "10:10"], ["12:00", "13:00"]], attendance: 570, breakOff: 70, rule: "clocked", paid: 500, paidHm: "8:20" },
  { offset: 4, in: "08:00", out: "16:30", breaks: [["10:00", "10:15"]], attendance: 510, breakOff: 45, rule: "allowance", paid: 465, paidHm: "7:45" },
  { offset: 5, in: "07:00", out: "12:00", breaks: [], attendance: 300, breakOff: 0, rule: "none", paid: 300, paidHm: "5:00" },
];

/** The document's week totals (minutes). */
const TOTALS = { attendance: 2835, breakOff: 215, paid: 2620 };

function eventsFor(monday: string) {
  const dates = ["", "", "", "", "", ""].map((_, i) => addDay(monday, i));
  return WEEK.flatMap((row) => {
    const date = dates[row.offset];
    return [
      ev("in", date, row.in),
      ...row.breaks.flatMap(([a, b]) => [ev("break_start", date, a), ev("break_end", date, b)]),
      ev("out", date, row.out),
    ];
  });
}
const addDay = (date: string, days: number) => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

const MONDAY = "2026-10-19";
const NO_HOLIDAYS = new Map<string, string>();

describe("PAY-WORKED-EXAMPLE: week of Monday 19 October 2026 (default JNR settings)", () => {
  const events = eventsFor(MONDAY);

  it("the document's table adds up by hand (guards the figures in this file)", () => {
    for (const row of WEEK) expect(row.attendance - row.breakOff).toBe(row.paid);
    const sum = (k: "attendance" | "breakOff" | "paid") => WEEK.reduce((total, r) => total + r[k], 0);
    expect(sum("attendance")).toBe(TOTALS.attendance);
    expect(sum("breakOff")).toBe(TOTALS.breakOff);
    expect(sum("paid")).toBe(TOTALS.paid);
  });

  const labels = ["Mon 19: normal 8-hour day", "Tue 20: long day 07:00-17:30", "Wed 21: short day, one clocked break", "Thu 22: clocked breaks 70 min (more than 45)", "Fri 23: clocked break 15 min (less than 45)", "Sat 24: Saturday morning, short day"];
  WEEK.forEach((row, i) => {
    it(`${labels[i]}`, () => {
      const date = addDay(MONDAY, row.offset);
      const d = dayTotals({ date, events, labour: [], settings: S, bankHolidays: NO_HOLIDAYS, now: LATER });
      expect(d.attendance).toBe(row.attendance);
      expect(d.breakDeduction).toBe(row.breakOff);
      expect(d.breakRule).toBe(row.rule);
      expect(d.paid).toBe(row.paid);
      expect(hm(d.paid)).toBe(row.paidHm);
      // Paid is paid: no basic / overtime split is worked out, whatever the hours or the day (Tuesday is over 8 hours, Saturday is a Saturday).
      expect("basic" in d).toBe(false);
      expect("overtime" in d).toBe(false);
      expect(d.flags).toEqual([]);
    });
  });

  it("Sunday has no work and is all zeros", () => {
    const d = dayTotals({ date: addDay(MONDAY, 6), events, labour: [], settings: S, bankHolidays: NO_HOLIDAYS, now: LATER });
    expect([d.attendance, d.paid, d.worked]).toEqual([0, 0, false]);
  });

  it("week totals: paid 43:40, no overtime figure", () => {
    const w = weekTotals({ weekStart: MONDAY, events, labour: [], settings: S, bankHolidays: NO_HOLIDAYS, now: LATER });
    expect(w.attendance).toBe(TOTALS.attendance);
    expect(w.breakDeduction).toBe(TOTALS.breakOff);
    expect(w.paid).toBe(TOTALS.paid);
    expect(w.daysWorked).toBe(6);
    expect(w.flags).toEqual([]);
    expect("basic" in w).toBe(false);
    expect("overtime" in w).toBe(false);
    expect([hm(w.attendance), hm(w.breakDeduction), hm(w.paid)]).toEqual(["47:15", "3:35", "43:40"]);
  });

  describe("overtime is only what is ticked", () => {
    const w = weekTotals({ weekStart: MONDAY, events, labour: [], settings: S, bankHolidays: NO_HOLIDAYS, now: LATER });
    const saved = (day: string, f: Partial<Record<(typeof DAY_FLAG_KEYS)[number], boolean>>): SavedDayFlags => ({ user_id: "worker-a", day, ...NO_FLAGS, ...f, updated_by: null, updated_at: "2026-10-26T09:00:00Z" });

    it("nothing ticked: overtime 0, even with a 9:45 Tuesday and a Saturday; Saturday is suggested, Overtime never", () => {
      const flags = weekDayFlags(w, [], NO_HOLIDAYS);
      expect(flags.days.every((d) => !d.flags.overtime)).toBe(true);
      expect(flags.days[5].flags).toEqual({ ...NO_FLAGS, saturday: true });
      expect(flags.days[5].source).toBe("suggested");
      const snap = approvalSnapshot(w, flagTotalsSnapshot(flags.totals));
      expect([snap.paid_minutes, snap.basic_minutes, snap.overtime_minutes]).toEqual([2620, 2620, 0]);
    });

    it("Tuesday and Thursday ticked Overtime, Saturday ticked Saturday: overtime = their paid minutes, nothing else", () => {
      const flags = weekDayFlags(w, [saved("2026-10-20", { overtime: true }), saved("2026-10-22", { overtime: true }), saved("2026-10-24", { saturday: true })], NO_HOLIDAYS);
      expect(flags.totals.overtime).toEqual({ days: 2, paidMinutes: 585 + 500 });
      expect(flags.totals.saturday).toEqual({ days: 1, paidMinutes: 300 });
      expect(flags.totals.sunday).toEqual({ days: 0, paidMinutes: 0 });
      expect(hm(flags.totals.overtime.paidMinutes)).toBe("18:05");
      const snap = approvalSnapshot(w, flagTotalsSnapshot(flags.totals));
      expect([snap.paid_minutes, snap.basic_minutes, snap.overtime_minutes]).toEqual([2620, 2620, 1085]);
    });
  });
});

describe("PAY-WORKED-EXAMPLE: JNR's standard week (Mon-Thu 08:00-16:00, Fri 08:00-14:30), 9-13 November 2026, no bank holiday", () => {
  // Hand-worked in docs/PAY-WORKED-EXAMPLE.md: every day is 6 hours or more, so the 45 minute allowance comes off each day.
  const STD_MONDAY = "2026-11-09";
  const std = [
    { offset: 0, in: "08:00", out: "16:00", attendance: 480, paid: 435 },
    { offset: 1, in: "08:00", out: "16:00", attendance: 480, paid: 435 },
    { offset: 2, in: "08:00", out: "16:00", attendance: 480, paid: 435 },
    { offset: 3, in: "08:00", out: "16:00", attendance: 480, paid: 435 },
    { offset: 4, in: "08:00", out: "14:30", attendance: 390, paid: 345 },
  ];
  const events = std.flatMap((r) => [ev("in", addDay(STD_MONDAY, r.offset), r.in), ev("out", addDay(STD_MONDAY, r.offset), r.out)]);

  ["Mon", "Tue", "Wed", "Thu", "Fri"].forEach((name, i) => {
    it(`${name}: at work ${std[i].attendance}, 45 minute allowance, paid ${std[i].paid}`, () => {
      const d = dayTotals({ date: addDay(STD_MONDAY, i), events, labour: [], settings: S, bankHolidays: NO_HOLIDAYS, now: LATER });
      expect([d.kind, d.attendance, d.breakRule, d.breakDeduction, d.paid]).toEqual(["weekday", std[i].attendance, "allowance", 45, std[i].paid]);
      expect(d.flags).toEqual([]);
    });
  });

  it("week: paid 2085 (34:45), at work 2310 (38:30), breaks 225 (3:45)", () => {
    const w = weekTotals({ weekStart: STD_MONDAY, events, labour: [], settings: S, bankHolidays: NO_HOLIDAYS, now: LATER });
    expect([w.paid, w.attendance, w.breakDeduction, w.daysWorked]).toEqual([2085, 2310, 225, 5]);
    expect([hm(w.paid), hm(w.attendance), hm(w.breakDeduction)]).toEqual(["34:45", "38:30", "3:45"]);
  });
});

describe("PAY-WORKED-EXAMPLE: bank holidays are holiday allowance, not a pay rule", () => {
  // The same clock times in the week of Monday 4 May 2026, where Monday is the Early May bank holiday.
  const BH_MONDAY = "2026-05-04";
  const events = eventsFor(BH_MONDAY);
  const holidays = new Map([[BH_MONDAY, "Early May bank holiday"]]);

  it("a bank holiday worked is an ordinary day: same paid figures as any Monday, no flag, no overtime; the date only suggests the Bank holiday tick", () => {
    const mon = dayTotals({ date: BH_MONDAY, events, labour: [], settings: S, bankHolidays: holidays, now: LATER });
    expect([mon.kind, mon.paid, mon.flags]).toEqual(["bank_holiday", 480, []]);
    const w = weekTotals({ weekStart: BH_MONDAY, events, labour: [], settings: S, bankHolidays: holidays, now: LATER });
    expect(w.paid).toBe(TOTALS.paid);
    WEEK.forEach((row, i) => expect(w.days[i].paid).toBe(row.paid));
    const flags = weekDayFlags(w, [], holidays);
    expect(flags.days[0].flags).toEqual({ ...NO_FLAGS, bank_holiday: true });
    expect(flagTotalsSnapshot(flags.totals).overtime).toEqual({ days: 0, paid_minutes: 0 });
  });
});

describe("ChatGPT/Codex pay example for Worker A (PR #158, worked example in the private repository's docs): the same three days through Tolra (paid totals unchanged)", () => {
  // Hand figures from that document, in minutes, entered before this ran against the code. Saturday has no break clocked; under 6 hours
  // at work with nothing clocked, only clocked breaks come off, so nothing does (Rhys, Sun 18 Oct: "just do it as hours worked").
  const days = [
    { date: "2026-10-19", label: "Monday 08:00-16:00", in: "08:00", out: "16:00", attendance: 480, breakOff: 45, rule: "allowance", paid: 435, paidHm: "7:15" },
    { date: "2026-10-20", label: "Tuesday 08:00-17:30", in: "08:00", out: "17:30", attendance: 570, breakOff: 45, rule: "allowance", paid: 525, paidHm: "8:45" },
    { date: "2026-10-24", label: "Saturday 08:00-12:00, no break", in: "08:00", out: "12:00", attendance: 240, breakOff: 0, rule: "none", paid: 240, paidHm: "4:00" },
  ] as const;
  const events = days.flatMap((d) => [ev("in", d.date, d.in), ev("out", d.date, d.out)]);

  days.forEach((row) => {
    it(`${row.label}: paid ${row.paidHm}`, () => {
      const d = dayTotals({ date: row.date, events, labour: [], settings: S, bankHolidays: NO_HOLIDAYS, now: LATER });
      expect([d.attendance, d.breakDeduction, d.breakRule, d.paid]).toEqual([row.attendance, row.breakOff, row.rule, row.paid]);
      expect(hm(d.paid)).toBe(row.paidHm);
    });
  });

  it("sample totals: 21h30 attendance less 1h30 breaks = 20h paid", () => {
    const w = weekTotals({ weekStart: "2026-10-19", events, labour: [], settings: S, bankHolidays: NO_HOLIDAYS, now: LATER });
    expect([w.attendance, w.breakDeduction, w.paid]).toEqual([1290, 90, 1200]);
    expect([hm(w.attendance), hm(w.breakDeduction), hm(w.paid)]).toEqual(["21:30", "1:30", "20:00"]);
  });
});
