/**
 * Every CSV the app writes neutralises spreadsheet formulas in text (hostile customer names) and leaves money columns as plain
 * numbers; year-end dates for timestamps are Europe/London calendar dates (BST boundaries), DATE columns untouched.
 */
import { describe, expect, it } from "vitest";

import { calendarDate } from "@/lib/dates";
import { csvCell, csvField, neutraliseCsvText } from "@/lib/html";
import { paymentFromRow } from "@/lib/payments";
import { paymentExportRows, paymentsCsv, summaryCsv, type SummaryRow } from "@/lib/year-end-export";

const HOSTILE = ["=HYPERLINK(\"http://evil.example\",\"x\")", "+1+1", "-2+3", "@SUM(A1:A9)", "\t=1+1", "\r=1+1", "=cmd|' /C calc'!A0", "-@x", "+44 7700 900123"];

describe("neutraliseCsvText", () => {
  it("prefixes an apostrophe to anything that starts like a formula", () => {
    for (const text of HOSTILE) expect(neutraliseCsvText(text)).toBe(`'${text}`);
  });

  it("leaves ordinary text and well-formed numbers alone", () => {
    for (const text of ["Smith & Sons Ltd", "O'Brien", "A=B", "1 + 2", "", "12", "-12", "12.50", "-12.50", "0", "INV-0001"]) expect(neutraliseCsvText(text)).toBe(text);
    // Not well-formed numbers: still neutralised.
    for (const text of ["-", "+5", "-5-", "--5", "-1e5", "-5,00", "- 5", "-.5"]) expect(neutraliseCsvText(text)).toBe(`'${text}`);
  });
});

describe("csvField (accounting exports)", () => {
  it("numbers are written with two decimals and never altered, including negative amounts", () => {
    expect(csvField(120)).toBe("120.00");
    expect(csvField(-30)).toBe("-30.00");
    expect(csvField(0)).toBe("0.00");
  });

  it("text is neutralised and quoted only when it needs it; empty stays empty", () => {
    expect(csvField('=1+1,"x"')).toBe(`"'=1+1,""x"""`);
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField("\n=1")).toBe('"\n=1"'); // a newline is not a formula start: quoted, not prefixed
  });
});

describe("csvCell (record exports)", () => {
  it("always quotes, neutralises text and keeps numbers as numbers", () => {
    expect(csvCell("=2+2")).toBe(`"'=2+2"`);
    expect(csvCell(-12.5)).toBe('"-12.5"');
    expect(csvCell("-12.50")).toBe('"-12.50"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
  });
});

describe("summary.csv and payments.csv with hostile names", () => {
  const row = (party: string, over: Partial<SummaryRow> = {}): SummaryRow => ({ type: "Invoice", number: "INV-0001", date: "2026-03-04", party, net: 100, vat: 20, gross: 120, paid: 0, balance: 120, paidDate: "", status: "issued", pdf: "invoices/INV-0001.pdf", ...over });

  it("no cell of summary.csv can begin a formula, whatever the customer is called", () => {
    const csv = summaryCsv(HOSTILE.map((name, i) => row(name, { number: `INV-${i}` })));
    const body = csv.replace(/^﻿/, "").split("\r\n").slice(1).filter(Boolean).join("\r\n");
    // Parse the CSV (quotes, doubled quotes, embedded newlines) and look at every field.
    const fields: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i];
      if (quoted) {
        if (c === '"' && body[i + 1] === '"') { current += '"'; i += 1; } else if (c === '"') quoted = false; else current += c;
      } else if (c === '"') quoted = true;
      else if (c === "," || c === "\r" || c === "\n") { if (c !== "\n") { fields.push(current); current = ""; } } else current += c;
    }
    fields.push(current);
    for (const field of fields) expect({ field, formula: /^[=+\-@\t\r]/.test(field) && !/^-?\d+(\.\d+)?$/.test(field) }).toEqual({ field, formula: false });
    for (const name of HOSTILE) expect(fields).toContain(`'${name}`);
  });

  it("money columns stay plain numbers, negatives included", () => {
    const csv = summaryCsv([row("Ordinary Ltd", { net: -10, vat: -2, gross: -12, paid: null, balance: null })]);
    expect(csv).toContain("Invoice,INV-0001,2026-03-04,Ordinary Ltd,-10.00,-2.00,-12.00,,,,issued,invoices/INV-0001.pdf\r\n");
  });

  it("payments.csv neutralises references and reasons; the amount and its reversal stay numbers", () => {
    const payments = [
      paymentFromRow({ id: "p1", invoice_id: "i1", amount: 50, paid_on: "2026-03-05", method: "BACS", reference: "=cmd|' /C calc'!A0", source: "recorded", reverses_payment_id: null, void_reason: null, created_at: "2026-03-05T10:00:00Z" }),
      paymentFromRow({ id: "p2", invoice_id: "i1", amount: -50, paid_on: "2026-03-06", method: "BACS", reference: "", source: "recorded", reverses_payment_id: "p1", void_reason: "=Entered in error", created_at: "2026-03-06T10:00:00Z" }),
    ];
    const csv = paymentsCsv(paymentExportRows([{ id: "i1", invoice_ref: "-INV-1" }], payments));
    expect(csv).toContain(`'-INV-1,2026-03-05,50.00,BACS,'=cmd|' /C calc'!A0,recorded,Yes`);
    // "Reversal: ..." starts with a letter, so the reason inside it is not a cell start.
    expect(csv).toContain(`'-INV-1,2026-03-06,-50.00,BACS,,recorded,Reversal: =Entered in error`);
  });
});

describe("year-end dates: DATE columns as they are, timestamps as Europe/London dates", () => {
  it("a DATE is returned untouched", () => {
    expect(calendarDate("2026-07-01")).toBe("2026-07-01");
    expect(calendarDate("2026-12-31")).toBe("2026-12-31");
  });

  it("23:30 UTC in summer (BST) is the next day in London; in winter (GMT) it is the same day", () => {
    expect(calendarDate("2026-07-01T23:30:00+00:00")).toBe("2026-07-02");
    expect(calendarDate("2026-07-01T23:30:00Z")).toBe("2026-07-02");
    expect(calendarDate("2026-12-01T23:30:00+00:00")).toBe("2026-12-01");
    expect(calendarDate("2026-12-01T23:30:00Z")).toBe("2026-12-01");
  });

  it("around the clock changes: last day of GMT, first day of BST, and back", () => {
    // BST starts 29 March 2026 at 01:00 UTC; ends 25 October 2026 at 01:00 UTC.
    expect(calendarDate("2026-03-28T23:30:00Z")).toBe("2026-03-28"); // still GMT
    expect(calendarDate("2026-03-29T00:30:00Z")).toBe("2026-03-29"); // GMT
    expect(calendarDate("2026-03-29T23:30:00Z")).toBe("2026-03-30"); // BST: next day
    expect(calendarDate("2026-10-24T23:30:00Z")).toBe("2026-10-25"); // BST: next day
    expect(calendarDate("2026-10-25T23:30:00Z")).toBe("2026-10-25"); // GMT again
    // The financial year boundary: 31 March 23:30 UTC is already 1 April in London.
    expect(calendarDate("2026-03-31T23:30:00+00:00")).toBe("2026-04-01");
    expect(calendarDate("2026-04-05T23:30:00Z")).toBe("2026-04-06");
  });

  it("offsets other than UTC are converted too, and non-dates are empty", () => {
    expect(calendarDate("2026-07-01T23:30:00-05:00")).toBe("2026-07-02");
    expect(calendarDate("2026-07-02T00:30:00+01:00")).toBe("2026-07-02");
    expect(calendarDate(null)).toBe("");
    expect(calendarDate(undefined)).toBe("");
    expect(calendarDate("tomorrow")).toBe("");
    expect(calendarDate(20260701)).toBe("");
  });
});
