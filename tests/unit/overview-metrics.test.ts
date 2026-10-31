/** The owner's Overview figures beyond the leaks row (lib/overview-metrics): each rule on rows the Dashboard reads. */
import { describe, expect, it } from "vitest";

import {
  cuttingHoursByMachine,
  daysToGetPaid,
  estimateByJob,
  grossMargin,
  invoicedByJob,
  invoicedByMonth,
  invoiceNetPence,
  jobsVsEstimate,
  owedTrend,
  quotesWon,
  revenuePerMachineHour,
  runHoursByJob,
  topCustomersInvoiced,
} from "@/lib/overview-metrics";

const inv = (over: Record<string, unknown>) => ({ id: "i", customer: "Acme", status: "sent", total: 120, vat: 20, invoice_date: "2026-10-05", ...over });

describe("invoiced ex VAT", () => {
  it("is total minus VAT, so carriage counts and VAT does not; with no total, lines plus carriage", () => {
    expect(invoiceNetPence({ total: 132, vat: 22, subtotal: 100, carriage: 10 })).toBe(11000);
    expect(invoiceNetPence({ subtotal: 100, carriage: 10 })).toBe(11000);
    expect(invoiceNetPence({})).toBeNull();
  });

  it("counts issued invoices on their invoice date, never drafts, void or cancelled; credit notes come off on their own date", () => {
    const months = invoicedByMonth([
      inv({ total: 1200, vat: 200 }),
      inv({ status: "paid", total: 600, vat: 100, invoice_date: "2026-09-30" }),
      inv({ status: "credited", total: 240, vat: 40 }), // issued then credited: counted here, its credit note comes off below
      inv({ status: "draft", total: 9999, vat: 0 }),
      inv({ status: null, total: 9999, vat: 0 }), // no status is a draft
      inv({ status: "void", total: 9999, vat: 0 }),
      inv({ status: "cancelled", total: 9999, vat: 0 }),
      inv({ status: "sent", total: 9999, vat: 0, invoice_date: "2026-04-01" }), // outside the months asked
    ], [
      { status: "issued", total: 240, vat: 40, credit_date: "2026-10-20" },
      { status: "draft", total: 5000, vat: 0, credit_date: "2026-10-20" },
    ], ["2026-09", "2026-10"]);
    expect(months).toEqual(new Map([["2026-09", 500], ["2026-10", 1000]]));
  });

  it("an invoice with no figures at all makes the series a dash, never a guess", () => {
    expect(invoicedByMonth([inv({ total: null, vat: null, subtotal: null })], [], ["2026-10"])).toBeNull();
  });

  it("an invoice with no invoice date counts on the London day it was made", () => {
    expect(invoicedByMonth([inv({ invoice_date: null, created_at: "2026-09-30T23:30:00Z" })], [], ["2026-09", "2026-10"])).toEqual(new Map([["2026-09", 0], ["2026-10", 100]]));
  });
});

describe("top customers", () => {
  it("ranks invoiced ex VAT per customer, takes their credit notes off, and the share has every customer in the denominator", () => {
    const top = topCustomersInvoiced([
      inv({ customer: "Acme", total: 720, vat: 120 }),
      inv({ customer: "Beta", total: 360, vat: 60 }),
      inv({ customer: "Gamma", total: 120, vat: 20 }),
      inv({ customer: "Delta", total: 120, vat: 20 }),
      inv({ customer: " ", total: 120, vat: 20 }),
      inv({ customer: "Old", total: 99999, vat: 0, invoice_date: "2025-01-01" }),
    ], [{ customer: "Acme", status: "issued", total: 120, vat: 20, credit_date: "2026-10-10" }], "2026-05-01", 2);
    // 500 of 1,100 (Acme 500, Beta 300, Gamma, Delta and "No customer" 100 each): 45%, though only two rows are shown.
    expect(top).toEqual({ rows: [{ customer: "Acme", value: 500 }, { customer: "Beta", value: 300 }], share: 45, topCustomer: "Acme", total: 1100 });
  });

  it("nothing invoiced: no rows and no share", () => {
    expect(topCustomersInvoiced([], [], "2026-05-01")).toEqual({ rows: [], share: null, topCustomer: null, total: 0 });
  });
});

describe("days to get paid", () => {
  it("averages invoice date to paid for invoices paid since the date, leaving out unconfirmed imports and other statuses", () => {
    expect(daysToGetPaid([
      inv({ status: "paid", invoice_date: "2026-10-01", paid_at: "2026-10-21T10:00:00Z" }),
      inv({ status: "paid", invoice_date: "2026-09-01", paid_at: "2026-10-01T10:00:00Z" }),
      inv({ status: "paid", invoice_date: "2026-01-01", paid_at: "2026-02-01T10:00:00Z" }), // paid before the window
      inv({ status: "paid", invoice_date: "2026-10-01", paid_at: "2026-10-02T10:00:00Z", payment_unverified: true }),
      inv({ status: "sent", invoice_date: "2026-10-01", paid_at: "2026-10-02T10:00:00Z" }),
      inv({ status: "paid", invoice_date: null, paid_at: "2026-10-02T10:00:00Z" }),
    ], "2026-08-01")).toEqual({ average: 25, count: 2 });
    expect(daysToGetPaid([], "2026-08-01")).toEqual({ average: null, count: 0 });
  });
});

describe("quotes won", () => {
  it("counts accepted quotes by the date accepted (London), never the date sent; an undated accepted quote is counted apart", () => {
    expect(quotesWon([
      { status: "accepted", accepted_at: "2026-10-03T09:00:00Z" },
      { status: "accepted", accepted_at: "2026-09-30T23:30:00Z" }, // 00:30 on 1 Oct in London (summer time)
      { status: "accepted", accepted_at: "2026-09-29T09:00:00Z" },
      { status: "accepted", accepted_at: null },
      { status: "sent", accepted_at: null },
      { status: "rejected", accepted_at: null },
    ], "2026-10-01")).toEqual({ count: 2, undated: 1 });
  });
});

describe("machine time", () => {
  const run = (machine: string, job: string, from: string, to: string | null) => ({ machine_id: machine, job_id: job, started_at: from, ended_at: to });

  it("cutting time counts overlapping runs on one machine once, clips to the window, and a run still going ends now", () => {
    const hours = cuttingHoursByMachine([
      run("m1", "j1", "2026-10-26T09:00:00Z", "2026-10-26T11:00:00Z"),
      run("m1", "j2", "2026-10-26T10:00:00Z", "2026-10-26T12:00:00Z"),
      run("m1", "j3", "2026-10-25T22:00:00Z", "2026-10-26T01:00:00Z"), // 1 h of it is in the window
      run("m2", "j1", "2026-10-27T08:00:00Z", null),
      run("m3", "j1", "2026-10-20T08:00:00Z", "2026-10-20T09:00:00Z"), // before the window
    ], "2026-10-26T00:00:00Z", "2026-10-27T09:30:00Z");
    expect(hours).toEqual(new Map([["m1", 4], ["m2", 1.5]]));
  });

  it("paused time is never counted: a paused run has ended, and the next run starts later", () => {
    const hours = cuttingHoursByMachine([
      run("m1", "j1", "2026-10-26T09:00:00Z", "2026-10-26T10:00:00Z"),
      run("m1", "j1", "2026-10-26T11:00:00Z", "2026-10-26T12:00:00Z"),
    ], "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z");
    expect(hours.get("m1")).toBe(2);
  });

  it("machine hours per job add machines together (two machines at once are two machine hours)", () => {
    expect(runHoursByJob([
      run("m1", "j1", "2026-10-26T09:00:00Z", "2026-10-26T11:00:00Z"),
      run("m2", "j1", "2026-10-26T09:00:00Z", "2026-10-26T10:00:00Z"),
      run("m1", "j2", "2026-10-26T12:00:00Z", null),
    ], "2026-10-26T12:30:00Z")).toEqual(new Map([["j1", 3], ["j2", 0.5]]));
  });

  it("£ per machine hour only uses jobs with both invoiced value and recorded run time", () => {
    const revenue = invoicedByJob([
      inv({ job_id: "j1", total: 1440, vat: 240 }),
      inv({ job_id: "j2", total: 600, vat: 100 }), // no run time: left out, not spread
      inv({ job_id: null, total: 600, vat: 100 }),
      inv({ job_id: "j3", status: "draft", total: 600, vat: 100 }),
    ], "2026-08-01");
    expect(revenue).toEqual(new Map([["j1", 1200], ["j2", 500]]));
    expect(revenuePerMachineHour(revenue, new Map([["j1", 10], ["j9", 4]]))).toEqual({ perHour: 120, jobs: 1, revenue: 1200, hours: 10 });
    expect(revenuePerMachineHour(revenue, new Map())).toBeNull();
  });
});

describe("margin and estimates", () => {
  it("margin is unknown without a recorded cost, never revenue as profit", () => {
    expect(grossMargin(1000, null)).toBeNull();
    expect(grossMargin(null, 100)).toBeNull();
    expect(grossMargin(0, 0)).toBeNull();
    expect(grossMargin(1000, 700)).toBe(30);
  });

  it("jobs vs estimate: recorded hours against planned, over jobs with both; how many went over", () => {
    const plans = estimateByJob([{ job_id: "j1", estimated_hours: 6 }, { job_id: "j1", estimated_hours: 4 }, { job_id: "j2", estimated_hours: "10" }, { job_id: "j3", estimated_hours: 5 }]);
    expect(plans).toEqual(new Map([["j1", 10], ["j2", 10], ["j3", 5]]));
    expect(jobsVsEstimate(["j1", "j2", "j3", "j4"], plans, new Map([["j1", 12], ["j2", 8], ["j4", 3]]))).toEqual({ percent: 100, jobs: 2, over: 1 });
    expect(jobsVsEstimate(["j3"], plans, new Map())).toBeNull();
  });
});

describe("owed trend", () => {
  it("is the snapshots in date order, nothing filled in between", () => {
    expect(owedTrend([
      { snapshot_date: "2026-10-28", owed_amount: "1500.50", late_amount: "200.00" },
      { snapshot_date: "2026-10-26", owed_amount: 1000, late_amount: 0 },
    ])).toEqual([{ date: "2026-10-26", owed: 1000, late: 0 }, { date: "2026-10-28", owed: 1500.5, late: 200 }]);
  });
});
