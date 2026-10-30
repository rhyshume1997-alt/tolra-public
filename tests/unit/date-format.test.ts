/**
 * Each person's date format (Rhys, Wed 21 Oct 2026; migration 109): one formatter (lib/dates) for every date the app shows, the order
 * and the month as the person chose, DD/MM/YYYY by default exactly as before. Exports stay fixed. And 109's own files: the release
 * text is the migration wrapped, the rollback drops only its table, the app's nine values are the CHECK's, and the test fixtures
 * (the 013 upgrade rehearsal's included) never write the setting.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ukDateTime } from "@/lib/auto-booking";
import {
  DATE_FORMATS, DEFAULT_DATE_FORMAT, type DateFormat, fmtDate, fmtDateText, fmtDateTime, fmtDateTimeText, fmtDayDateTime, fmtTime, getDateFormat,
  parseDateFormat, setDateFormat, subscribeDateFormat,
} from "@/lib/dates";
import { primeForUser } from "@/lib/date-format-preference";
import { cellValue } from "@/lib/import-build";
import { formatSignedAt, formatSignedOn } from "@/lib/job-signoff";
import { formatPlanDate } from "@/lib/machine-schedule";
import { shortDay } from "@/lib/time-day-flags";
import { summaryCsv } from "@/lib/year-end-export";
import { releaseSql } from "../../scripts/release-sql.mjs";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// setDateFormat only works in a browser (the module's setting is shared by every request on a server).
const withWindow = (fn: () => void) => {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  g.window = g.window ?? {};
  try {
    fn();
  } finally {
    if (!had) delete g.window;
  }
};
afterEach(() => withWindow(() => setDateFormat(DEFAULT_DATE_FORMAT)));

const SUMMER = "2026-10-21T13:05:00Z"; // 14:05 in London (BST)
const WINTER = "2026-01-05T23:30:00Z"; // 23:30 in London (GMT)

describe("the date formats", () => {
  it("are the nine order x month combinations, DD/MM/YYYY by default", () => {
    expect(DATE_FORMATS).toEqual(["dmy-number", "dmy-short", "dmy-full", "mdy-number", "mdy-short", "mdy-full", "ymd-number", "ymd-short", "ymd-full"]);
    expect(DEFAULT_DATE_FORMAT).toBe("dmy-number");
    expect(parseDateFormat("nonsense")).toBe("dmy-number");
    expect(parseDateFormat("mdy-full")).toBe("mdy-full");
  });

  it("write a date in each format (full month: 21 October 2026; the ISO option YYYY-MM-DD)", () => {
    const expected: Record<DateFormat, string> = {
      "dmy-number": "21/10/2026", "dmy-short": "21 Oct 2026", "dmy-full": "21 October 2026",
      "mdy-number": "10/21/2026", "mdy-short": "Oct 21, 2026", "mdy-full": "October 21, 2026",
      "ymd-number": "2026-10-21", "ymd-short": "2026 Oct 21", "ymd-full": "2026 October 21",
    };
    for (const format of DATE_FORMATS) {
      expect(fmtDate("2026-10-21", format)).toBe(expected[format]);
      expect(fmtDate(SUMMER, format)).toBe(expected[format]);
    }
    expect(fmtDate("2026-03-01", "dmy-short")).toBe("1 Mar 2026");
    expect(fmtDate("2026-03-01", "dmy-number")).toBe("01/03/2026");
  });

  it("by default are exactly what the app showed before (en-GB, UK time)", () => {
    const enGb = (v: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(v));
    const enGbTime = (v: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" }).format(new Date(v));
    for (const v of [SUMMER, WINTER, "2026-07-01T23:30:00Z", "2026-12-31", "2026-03-29T00:30:00Z"]) {
      expect(fmtDate(v)).toBe(enGb(v));
      expect(fmtDateTime(v)).toBe(enGbTime(v));
    }
    expect(fmtDate(null)).toBe("");
    expect(fmtDate("")).toBe("");
    expect(fmtDate("not a date")).toBe("not a date");
    expect(fmtDateTime("not a date")).toBe("not a date");
    expect(fmtTime(SUMMER)).toBe("14:05");
    // Labels keep their words with the numeric default: "Wed 21 Oct", "Wed, 21 Oct 2026", "Wednesday, 21 October 2026".
    expect(fmtDateText("2026-10-21", { weekday: "short" })).toBe("Wed 21 Oct");
    expect(fmtDateText("2026-10-21", { weekday: "short", year: true })).toBe("Wed, 21 Oct 2026");
    expect(fmtDateText(SUMMER, { weekday: "long", year: true, numberAs: "full" })).toBe("Wednesday, 21 October 2026");
    expect(fmtDateTimeText(SUMMER, { weekday: "short" })).toBe("Wed 21 Oct, 14:05");
    expect(fmtDateTimeText(SUMMER, { numberAs: "number" })).toBe("21/10, 14:05");
    expect(fmtDayDateTime(SUMMER)).toBe("Wed 21 Oct 14:05");
    // The moved helpers keep their outputs.
    expect(ukDateTime("2026-10-20T09:00:00Z")).toBe("Tue 20 Oct 10:00");
    expect(formatSignedAt("2026-10-17T13:03:00Z")).toBe("17 Oct 2026, 14:03");
    expect(formatSignedOn("2026-10-13")).toBe("13 Oct 2026");
  });

  it("read a timestamp as its UK calendar day and a plain date as that day", () => {
    expect(fmtDate("2026-07-01T23:30:00Z")).toBe("02/07/2026"); // BST: already the next day
    expect(fmtDate(WINTER)).toBe("05/01/2026"); // GMT
  });

  it("follow the person's setting once applied, and tell subscribers", () => {
    let told = 0;
    const stop = subscribeDateFormat(() => { told += 1; });
    withWindow(() => setDateFormat("mdy-full"));
    expect(getDateFormat()).toBe("mdy-full");
    expect(told).toBe(1);
    expect(fmtDate(SUMMER)).toBe("October 21, 2026");
    expect(fmtDateTime(SUMMER)).toBe("October 21, 2026, 14:05");
    expect(fmtDateText(SUMMER, { weekday: "short" })).toBe("Wed, October 21");
    expect(fmtDayDateTime(SUMMER)).toBe("Wed, October 21 14:05");
    expect(formatSignedOn("2026-10-13")).toBe("October 13, 2026");
    withWindow(() => setDateFormat("ymd-number"));
    expect(fmtDate(SUMMER)).toBe("2026-10-21");
    expect(fmtDateText(SUMMER, { weekday: "short" })).toBe("Wed, Oct 21");
    expect(fmtDateText(SUMMER, { numberAs: "number" })).toBe("10-21");
    withWindow(() => setDateFormat("dmy-short"));
    expect(fmtDateTimeText(SUMMER, { numberAs: "number" })).toBe("21 Oct, 14:05");
    withWindow(() => setDateFormat("dmy-short")); // the same: nobody told
    expect(told).toBe(3);
    withWindow(() => setDateFormat("bad value"));
    expect(getDateFormat()).toBe("dmy-number");
    stop();
  });

  it("is never changed on the server (the module is shared by every request there)", () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    setDateFormat("mdy-full");
    expect(getDateFormat()).toBe("dmy-number");
  });

  it("leave the year-end CSVs in ISO YYYY-MM-DD whoever exports them (Rhys, Wed 21 Oct), which the data import reads", () => {
    withWindow(() => setDateFormat("dmy-full"));
    const csv = summaryCsv([{ type: "Invoice", number: "INV-0001", date: "2026-03-04", party: "Ordinary Ltd", net: 100, vat: 20, gross: 120, paid: 0, balance: 120, paidDate: "2026-03-05", status: "issued", pdf: "invoices/INV-0001.pdf" }]);
    expect(csv).toContain("Invoice,INV-0001,2026-03-04,Ordinary Ltd,100.00,20.00,120.00,0.00,120.00,2026-03-05,issued");
    expect(cellValue("2026-03-04", "date")).toBe("2026-03-04");
  });

  it("write September as en-GB does in this runtime (Sept where its ICU says so), byte for byte as before 109", () => {
    const old = (v: string, o: Intl.DateTimeFormatOptions) => new Date(`${v}T12:00:00Z`).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
    for (const v of ["2026-09-07", "2026-09-21", "2026-09-30"]) {
      expect(fmtDateText(v, { weekday: "short" })).toBe(old(v, { weekday: "short", day: "numeric", month: "short" }));
      expect(fmtDateText(v, { weekday: "short", year: true })).toBe(old(v, { weekday: "short", day: "numeric", month: "short", year: "numeric" }));
      expect(fmtDateText(v)).toBe(old(v, { day: "numeric", month: "short" }));
      expect(fmtDateText(v, { weekday: "long", year: true, numberAs: "full" })).toBe(old(v, { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
      expect(formatSignedOn(v)).toBe(old(v, { day: "numeric", month: "short", year: "numeric" }));
      expect(formatPlanDate(v)).toBe(old(v, { weekday: "short", day: "numeric", month: "short" }));
      expect(shortDay(v)).toBe(old(v, { weekday: "short", day: "numeric" }));
    }
    // tests/e2e/day-split.spec.ts:37 builds its expectation from the same en-GB month name.
    const sept = new Date("2026-09-27T12:00:00Z").toLocaleDateString("en-GB", { month: "short" });
    expect(fmtDateText("2026-09-27", { weekday: "short" })).toMatch(new RegExp(`Sun,? 27 ${sept}`));
  });

  it("show an impossible calendar date as it is, never rolled over (2026-02-30 is not 02/03/2026)", () => {
    expect(fmtDate("2026-02-30")).toBe("2026-02-30");
    expect(fmtDateText("2026-02-30", { weekday: "short" })).toBe("2026-02-30");
    expect(fmtDate("2026-13-01")).toBe("2026-13-01");
  });
});

describe("the format follows the person signed in, in the same tab", () => {
  it("user A with MM/DD/YYYY, then signed out, then user B with no copy here: B gets the default, never A's", () => {
    const store = new Map<string, string>([["tolra-date-format:user-a", "mdy-full"]]);
    const g = globalThis as { window?: unknown };
    g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) } };
    try {
      expect(primeForUser("user-a")).toBe(true);
      expect(getDateFormat()).toBe("mdy-full");
      expect(fmtDate("2026-10-21")).toBe("October 21, 2026");
      expect(primeForUser("user-a")).toBe(false); // the same person: nothing re-read
      expect(primeForUser(null)).toBe(true); // signed out (the shell has no user)
      expect(getDateFormat()).toBe("dmy-number");
      expect(primeForUser("user-b")).toBe(true); // signed in again without a reload (router.replace)
      expect(getDateFormat()).toBe("dmy-number");
      expect(fmtDate("2026-10-21")).toBe("21/10/2026");
      // Straight from A to B with no sign-out in between, too.
      expect(primeForUser("user-a")).toBe(true);
      expect(getDateFormat()).toBe("mdy-full");
      expect(primeForUser("user-b")).toBe(true);
      expect(getDateFormat()).toBe("dmy-number");
    } finally {
      delete g.window;
    }
  });
});

describe("109's files", () => {
  const MIGRATION = "supabase/migrations/109_user_date_format.sql";

  it("the release text is exactly release-sql.mjs's wrapping of the migration", () => {
    expect(read("supabase/release/109_user_date_format.release.sql")).toBe(releaseSql(read(MIGRATION), "109_user_date_format.sql"));
  });

  it("the CHECK lists exactly the app's nine formats and defaults to the app's default", () => {
    const sql = read(MIGRATION);
    const check = /CHECK \(date_format IN \(([\s\S]*?)\)\)/.exec(sql)![1];
    expect(check.match(/'([a-z-]+)'/g)!.map((v) => v.slice(1, -1))).toEqual(DATE_FORMATS);
    expect(sql).toContain(`date_format TEXT NOT NULL DEFAULT '${DEFAULT_DATE_FORMAT}'`);
  });

  it("the policies are own row only and nothing is granted to anon or for DELETE", () => {
    const sql = read(MIGRATION).replace(/--.*$/gm, "");
    expect(sql.match(/CREATE POLICY/g)).toHaveLength(3);
    expect(sql).not.toMatch(/FOR ALL|FOR DELETE|TO anon|GRANT [^;]*DELETE/);
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE ON public.user_preferences TO authenticated;");
  });

  it("the rollback is one transaction that drops only 109's table", () => {
    const rollback = read("supabase/release/109_user_date_format.rollback.sql");
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(rollback.match(/^DROP /gm)).toEqual(["DROP "]);
    expect(rollback).toContain("DROP TABLE IF EXISTS public.user_preferences;");
  });

  it("the test fixtures and the upgrade rehearsal never write the setting", () => {
    const files = ["tests/support/fixtures.ts", ...readdirSync(path.join(ROOT, "tests/rehearsal")).map((f) => `tests/rehearsal/${f}`)]
      .filter((f) => /\.(ts|sql)$/.test(f));
    for (const file of files) expect({ file, mentions: /user_preferences|date_format/.test(read(file)) }).toEqual({ file, mentions: false });
  });
});
