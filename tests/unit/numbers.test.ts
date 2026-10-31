/**
 * The Numbers page's calculations (lib/numbers): London calendar months (the clocks changed on 29 Mar and 25 Oct 2026), credit notes off
 * once on their own date, customer shares, cash by month, and machine hours. The page and its tenant isolation: tests/e2e/numbers.spec.ts.
 */
import { describe, expect, it } from "vitest";

import {
  cashByMonth,
  customerConcentration,
  invoiceNetPence,
  invoicedByMonth,
  londonMidnight,
  londonMonthsEnding,
  machineHours,
  receivedByMonth,
  sumOrNull,
  windowOf,
  type NumberCredit,
  type NumberInvoice,
} from "@/lib/numbers";

const invoice = (customer: string, date: string, net: number, extra: Partial<NumberInvoice> = {}): NumberInvoice => ({ customer, status: "sent", invoice_date: date, subtotal: net, vat: net * 0.2, total: net * 1.2, ...extra });
const credit = (customer: string, date: string, net: number, status = "issued"): NumberCredit => ({ customer, status, credit_date: date, vat: net * 0.2, total: net * 1.2 });

describe("London months", () => {
  it("London midnight is 23:00 UTC the evening before in summer time and 00:00 UTC in winter time", () => {
    expect(londonMidnight("2026-03-28")).toBe("2026-03-28T00:00:00.000Z"); // still GMT
    expect(londonMidnight("2026-03-29")).toBe("2026-03-29T00:00:00.000Z"); // the day the clocks go forward (at 01:00)
    expect(londonMidnight("2026-03-30")).toBe("2026-03-29T23:00:00.000Z"); // BST
    expect(londonMidnight("2026-04-01")).toBe("2026-03-31T23:00:00.000Z");
    expect(londonMidnight("2026-10-24")).toBe("2026-10-23T23:00:00.000Z"); // BST
    expect(londonMidnight("2026-10-25")).toBe("2026-10-24T23:00:00.000Z"); // the day the clocks go back (at 02:00)
    expect(londonMidnight("2026-10-26")).toBe("2026-10-26T00:00:00.000Z"); // GMT
    expect(londonMidnight("2026-10-31")).toBe("2026-10-31T00:00:00.000Z");
    expect(londonMidnight("2026-11-01")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("months run first to last London day: March is 743 hours (one short) and October 745 (one long)", () => {
    const [mar, apr, , , , , , oct] = londonMonthsEnding(new Date("2026-10-15T12:00:00Z"), 8);
    expect([mar.start, mar.end, apr.start]).toEqual(["2026-03-01", "2026-04-01", "2026-04-01"]);
    const hours = (p: { startAt: string; endAt: string }) => (Date.parse(p.endAt) - Date.parse(p.startAt)) / 3_600_000;
    expect(hours(mar)).toBe(743);
    expect(hours(oct)).toBe(745);
    expect(oct.end).toBe("2026-11-01");
  });

  it("31 Mar / 1 Apr: 23:59 on 31 March (BST) is still March, 00:00 on 1 April is April", () => {
    const month = (iso: string) => londonMonthsEnding(new Date(iso), 1)[0].key;
    expect(month("2026-03-31T22:59:59Z")).toBe("2026-03");
    expect(month("2026-03-31T23:00:00Z")).toBe("2026-04");
    expect(londonMonthsEnding(new Date("2026-04-15T12:00:00Z"), 2).map((p) => p.key)).toEqual(["2026-03", "2026-04"]);
  });

  it("31 Oct / 1 Nov: London is on GMT, so 23:59 UTC on 31 October is still October and midnight UTC is November", () => {
    const month = (iso: string) => londonMonthsEnding(new Date(iso), 1)[0].key;
    expect(month("2026-10-31T23:59:59Z")).toBe("2026-10");
    expect(month("2026-11-01T00:00:00Z")).toBe("2026-11");
  });

  it("counts back across a year end and labels each month", () => {
    const periods = londonMonthsEnding(new Date("2026-01-15T12:00:00Z"), 3);
    expect(periods.map((p) => p.key)).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(periods.map((p) => p.label)).toEqual(["Nov 25", "Dec 25", "Jan 26"]);
    expect(windowOf(periods)).toMatchObject({ start: "2025-11-01", end: "2026-02-01" });
  });
});

describe("invoiced ex VAT, credit notes off once on their own date", () => {
  const periods = londonMonthsEnding(new Date("2026-11-10T12:00:00Z"), 3); // Sep, Oct, Nov

  it("takes the VAT off (total minus VAT, carriage included) and leaves drafts, void and cancelled out", () => {
    expect(invoiceNetPence({ total: 1200, vat: 200 })).toBe(100000);
    expect(invoiceNetPence({ subtotal: 800, carriage: 25 })).toBe(82500);
    expect(invoiceNetPence({})).toBeNull();
    const m = invoicedByMonth([
      invoice("A", "2026-10-10", 1000),
      invoice("A", "2026-10-11", 500, { status: "draft" }),
      invoice("A", "2026-10-12", 500, { status: "void" }),
      invoice("A", "2026-10-13", 500, { status: "cancelled" }),
      invoice("A", "2026-10-14", 250, { status: "paid" }),
    ], [], periods);
    expect(m.get("2026-10")).toBe(1250);
    expect(m.get("2026-09")).toBe(0);
  });

  it("a credit note lowers the month it was issued in, once: the credited invoice stays where it was issued", () => {
    const m = invoicedByMonth([invoice("A", "2026-10-10", 1000, { status: "credited" })], [credit("A", "2026-11-03", 300)], periods);
    expect(m.get("2026-10")).toBe(1000);
    expect(m.get("2026-11")).toBe(-300);
    expect(sumOrNull([...m.values()])).toBe(700);
  });

  it("a draft credit note takes nothing off", () => {
    const m = invoicedByMonth([invoice("A", "2026-10-10", 1000)], [credit("A", "2026-10-20", 300, "draft")], periods);
    expect(m.get("2026-10")).toBe(1000);
  });

  it("dates by the London calendar: 31 Mar / 1 Apr and 31 Oct / 1 Nov, for an invoice date, a made-at time and a credit date", () => {
    const spring = londonMonthsEnding(new Date("2026-04-20T12:00:00Z"), 2); // Mar, Apr
    const m = invoicedByMonth([
      invoice("A", "2026-03-31", 100),
      invoice("A", "2026-04-01", 200),
      // no invoice date: made at 23:30 UTC on 31 March = 00:30 on 1 April in London (BST), so April
      { customer: "A", status: "sent", total: 1200, vat: 200, created_at: "2026-03-31T23:30:00+00:00" },
      // made at 22:30 UTC on 31 March = 23:30 in London: still March
      { customer: "A", status: "sent", total: 1200, vat: 200, created_at: "2026-03-31T22:30:00+00:00" },
    ], [credit("A", "2026-03-31", 10), credit("A", "2026-04-01", 20)], spring);
    expect(m.get("2026-03")).toBe(100 + 1000 - 10);
    expect(m.get("2026-04")).toBe(200 + 1000 - 20);

    const autumn = londonMonthsEnding(new Date("2026-11-20T12:00:00Z"), 2); // Oct, Nov
    const n = invoicedByMonth([
      invoice("A", "2026-10-31", 100),
      invoice("A", "2026-11-01", 200),
      { customer: "A", status: "sent", total: 1200, vat: 200, created_at: "2026-10-31T23:30:00+00:00" }, // GMT: still 31 October
      { customer: "A", status: "sent", total: 1200, vat: 200, created_at: "2026-11-01T00:30:00+00:00" }, // 1 November
    ], [credit("A", "2026-10-31", 5), credit("A", "2026-11-01", 7)], autumn);
    expect(n.get("2026-10")).toBe(100 + 1000 - 5);
    expect(n.get("2026-11")).toBe(200 + 1000 - 7);
  });

  it("a counted invoice with no figures makes that month unknown (null), never 0, and the other months stand", () => {
    const m = invoicedByMonth([invoice("A", "2026-10-10", 1000), { customer: "A", status: "sent", invoice_date: "2026-11-02" }], [credit("A", "2026-11-05", 50)], periods);
    expect(m.get("2026-10")).toBe(1000);
    expect(m.get("2026-11")).toBeNull();
    expect(sumOrNull([...m.values()])).toBeNull();
  });

  it("ignores months outside the chosen ones", () => {
    const m = invoicedByMonth([invoice("A", "2026-01-10", 1000)], [credit("A", "2026-01-12", 100)], periods);
    expect([...m.keys()]).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(sumOrNull([...m.values()])).toBe(0);
  });
});

describe("money received by month and the cash table", () => {
  const periods = londonMonthsEnding(new Date("2026-11-10T12:00:00Z"), 2); // Oct, Nov

  it("sums payments by the date received, reversals on their own date, in pence", () => {
    const m = receivedByMonth([
      { paid_on: "2026-10-31", amount: 0.1 },
      { paid_on: "2026-10-31", amount: 0.2 },
      { paid_on: "2026-11-01", amount: 500 },
      { paid_on: "2026-11-02", amount: -100 },
      { paid_on: "2026-09-30", amount: 999 },
      { paid_on: null, amount: 999 },
    ], periods);
    expect(m.get("2026-10")).toBe(0.3);
    expect(m.get("2026-11")).toBe(400);
  });

  it("the gap is invoiced less received in the month; an unread side is null, never 0", () => {
    const invoiced = new Map<string, number | null>([["2026-10", 1000], ["2026-11", null]]);
    const received = new Map([["2026-10", 600], ["2026-11", 50]]);
    expect(cashByMonth(periods, invoiced, received)).toEqual([
      { key: "2026-10", label: "Oct 26", invoiced: 1000, received: 600, gap: 400 },
      { key: "2026-11", label: "Nov 26", invoiced: null, received: 50, gap: null },
    ]);
    expect(cashByMonth(periods, null, received).map((m) => [m.invoiced, m.received, m.gap])).toEqual([[null, 600, null], [null, 50, null]]);
    expect(cashByMonth(periods, invoiced, null).map((m) => [m.invoiced, m.received, m.gap])).toEqual([[1000, null, null], [null, null, null]]);
  });
});

describe("customer concentration", () => {
  const window = { start: "2026-05-01", end: "2026-11-01" };

  it("shares are of everyone's total, every customer in the denominator, biggest first", () => {
    const result = customerConcentration([
      invoice("Acme", "2026-10-10", 600),
      invoice("Beta", "2026-10-12", 300),
      invoice("Gamma", "2026-09-01", 100),
      invoice("Draft Co", "2026-10-12", 5000, { status: "draft" }),
      invoice("Old Co", "2026-04-30", 5000),
      invoice("Future Co", "2026-11-01", 5000),
    ], [], window)!;
    expect(result.total).toBe(1000);
    expect(result.rows).toEqual([
      { customer: "Acme", value: 600, share: 60 },
      { customer: "Beta", value: 300, share: 30 },
      { customer: "Gamma", value: 100, share: 10 },
    ]);
    expect(result).toMatchObject({ topCustomer: "Acme", topShare: 60 });
  });

  it("takes each customer's issued credit notes off them, once, in the window only", () => {
    const result = customerConcentration(
      [invoice("Acme", "2026-10-10", 600), invoice("Beta", "2026-10-12", 400)],
      [credit("Acme", "2026-10-20", 200), credit("Acme", "2026-10-21", 50, "draft"), credit("Acme", "2026-12-01", 999)],
      window,
    )!;
    expect(result.total).toBe(800);
    expect(result.rows.map((r) => [r.customer, r.value, r.share])).toEqual([["Acme", 400, 50], ["Beta", 400, 50]]);
  });

  it("a customer whose credits outweigh their invoices is not a row, but their negative still reduces the total", () => {
    const result = customerConcentration([invoice("Acme", "2026-10-10", 100), invoice("Beta", "2026-10-12", 300)], [credit("Beta", "2026-10-20", 500)], window)!;
    expect(result.rows).toEqual([{ customer: "Acme", value: 100, share: 0 }]); // no share is meaningful against a total that is not above zero
    expect(result.total).toBe(-100);
    expect(result.topShare).toBeNull();
  });

  it("names a blank customer 'No customer', has no share with nothing invoiced, and is null when an invoice has no figures", () => {
    expect(customerConcentration([invoice("  ", "2026-10-10", 100)], [], window)!.rows[0].customer).toBe("No customer");
    expect(customerConcentration([], [], window)).toEqual({ rows: [], total: 0, topCustomer: null, topShare: null });
    expect(customerConcentration([invoice("Acme", "2026-10-10", 100), { customer: "Beta", status: "sent", invoice_date: "2026-10-11" }], [], window)).toBeNull();
  });

  it("uses London dates at the edges of the window (31 Oct is in, 1 Nov is out)", () => {
    const result = customerConcentration([invoice("Acme", "2026-10-31", 100), invoice("Beta", "2026-11-01", 100)], [], window)!;
    expect(result.rows.map((r) => r.customer)).toEqual(["Acme"]);
  });
});

describe("machine hours", () => {
  const machines = [{ id: "m1", name: "Haas VF2" }, { id: "m2", name: "Doosan" }, { id: "m3", name: "Idle Mill" }];
  const now = new Date("2026-11-20T12:00:00Z");
  const october = londonMonthsEnding(new Date("2026-10-15T12:00:00Z"), 1)[0];
  const november = londonMonthsEnding(now, 1)[0];

  it("counts overlapping runs on one machine once and lists a machine with no runs at 0 h (the read worked)", () => {
    const rows = machineHours([
      { machine_id: "m1", started_at: "2026-10-01T09:00:00Z", ended_at: "2026-10-01T11:00:00Z" },
      { machine_id: "m1", started_at: "2026-10-01T10:00:00Z", ended_at: "2026-10-01T12:00:00Z" },
      { machine_id: "m2", started_at: "2026-10-02T09:00:00Z", ended_at: "2026-10-02T09:30:00Z" },
    ], machines, october, now);
    expect(rows).toEqual([
      { id: "m1", machine: "Haas VF2", hours: 3 },
      { id: "m2", machine: "Doosan", hours: 0.5 },
      { id: "m3", machine: "Idle Mill", hours: 0 },
    ]);
  });

  it("a paused run has ended, so the gap between runs is not counted", () => {
    const rows = machineHours([
      { machine_id: "m1", started_at: "2026-10-01T09:00:00Z", ended_at: "2026-10-01T10:00:00Z" },
      { machine_id: "m1", started_at: "2026-10-01T11:00:00Z", ended_at: "2026-10-01T12:00:00Z" },
    ], machines, october, now);
    expect(rows[0].hours).toBe(2);
  });

  it("a run still going counts to now, and no further", () => {
    const rows = machineHours([{ machine_id: "m1", started_at: "2026-11-20T08:00:00Z", ended_at: null }], machines, november, now);
    expect(rows[0]).toEqual({ id: "m1", machine: "Haas VF2", hours: 4 });
  });

  it("a run across a month boundary is split at the London midnight: 31 Mar / 1 Apr (BST)", () => {
    const [march, april] = londonMonthsEnding(new Date("2026-04-15T12:00:00Z"), 2);
    const run = [{ machine_id: "m1", started_at: "2026-03-31T22:30:00Z", ended_at: "2026-04-01T00:30:00Z" }];
    // 23:00 UTC is midnight in London: 30 minutes fall in March, 90 minutes in April
    expect(machineHours(run, machines, march, new Date("2026-04-15T12:00:00Z"))[0].hours).toBe(0.5);
    expect(machineHours(run, machines, april, new Date("2026-04-15T12:00:00Z"))[0].hours).toBe(1.5);
  });

  it("a run across a month boundary is split at the London midnight: 31 Oct / 1 Nov (GMT)", () => {
    const [oct, nov] = londonMonthsEnding(new Date("2026-11-15T12:00:00Z"), 2);
    const run = [{ machine_id: "m1", started_at: "2026-10-31T23:30:00Z", ended_at: "2026-11-01T00:30:00Z" }];
    expect(machineHours(run, machines, oct, new Date("2026-11-15T12:00:00Z"))[0].hours).toBe(0.5);
    expect(machineHours(run, machines, nov, new Date("2026-11-15T12:00:00Z"))[0].hours).toBe(0.5);
  });

  it("clips a run that started before the window, keeps a run on a machine no longer listed, and ignores a backwards or invalid one", () => {
    const rows = machineHours([
      // October starts at 23:00 UTC on 30 September (midnight in London, on summer time): the hour before it is September's
      { machine_id: "m1", started_at: "2026-09-30T22:00:00Z", ended_at: "2026-10-01T02:00:00Z" },
      { machine_id: "gone", started_at: "2026-10-05T09:00:00Z", ended_at: "2026-10-05T10:00:00Z" },
      { machine_id: "gone", started_at: "2026-10-05T09:30:00Z", ended_at: "2026-10-05T10:30:00Z" },
      { machine_id: "m2", started_at: "2026-10-06T10:00:00Z", ended_at: "2026-10-06T09:00:00Z" },
      { machine_id: "m2", started_at: "not a date", ended_at: null },
    ], machines, october, now);
    expect(rows.find((r) => r.id === "m1")!.hours).toBe(3);
    expect(rows.find((r) => r.id === "removed")).toEqual({ id: "removed", machine: "Removed machine", hours: 1.5 });
    expect(rows.find((r) => r.id === "m2")!.hours).toBe(0);
  });
});
