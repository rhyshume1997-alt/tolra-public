import { describe, expect, it } from "vitest";
import { balanceDue, customerCredit, daysPastDue, invoiceLifecycle, owed, paidOnTime } from "@/lib/receivables";
import { fromPence, linePence, toPence } from "@/lib/money";

describe("extra receivables calendar and money boundaries", () => {
  it.each([
    ["2026-11-02", "2026-11-02", 0], ["2026-11-03", "2026-11-02", -1],
    ["2026-11-01", "2026-11-02", 1], ["2026-12-31", "2027-01-01", 1],
    ["2028-02-28", "2028-03-01", 2], ["2027-02-28", "2027-03-01", 1],
    ["2026-03-28", "2026-03-30", 2], ["2026-10-24", "2026-10-26", 2],
  ])("counts calendar days from %s to %s as %s", (due, today, expected) => expect(daysPastDue(due, today)).toBe(expected));
  it.each([null, undefined, "", "not-a-date", "2026-02-30", "2026-13-01", "2026-00-01"])("does not invent overdue days for invalid date %s", (due) => expect(daysPastDue(due, "2026-11-02")).toBeNull());
  it("does not invent overdue days with an invalid current day", () => expect(daysPastDue("2026-11-01", "invalid")).toBeNull());
  it.each(["draft", " VOID ", "cancelled", "canceled", "credited", "written_off", null, undefined])("excludes closed/draft status %s from amounts owed", (status) => {
    expect(owed({ status, total: 100, amount_paid: 0 })).toBe(0);
    expect(invoiceLifecycle(status)).toBe("closed");
  });
  it("keeps partial receipts and credits distinct, using pence", () => {
    expect(balanceDue(100.29, 40.1, 10.09)).toBe(50.1);
    expect(balanceDue(100.29, 40.1, 10.09, 0.01)).toBe(50.11);
  });
  it("keeps imported unknown payment state out of receivables and credits", () => {
    expect(owed({ status: "sent", total: 100, payment_unverified: true })).toBe(0);
    expect(customerCredit({ status: "paid", total: 100, amount_paid: 120, payment_unverified: true })).toBe(0);
  });
  it("caps owed at zero while retaining real customer credit", () => {
    expect(balanceDue(100, 110)).toBe(0);
    expect(customerCredit({ status: "paid", total: 100, amount_paid: 110, refunded_amount: 4.01 })).toBe(5.99);
  });
  it("excludes missing payment dates from paid-on-time maths", () => {
    expect(paidOnTime([{ status: "paid", due_date: "2026-11-02", paid_at: "2026-11-02" }, { status: "paid", due_date: "2026-11-02" }, { status: "sent", due_date: "2026-11-02", paid_at: "2026-11-01" }])).toEqual({ counted: 1, onTime: 1, excluded: 1, rate: 100 });
  });
});
describe("extra integer-pence cases", () => {
  it.each([[1.005, 101], [-1.005, -101], [0.145, 15], [-0.145, -15], [1e-7, 0], [0.29, 29], [999999.995, 100000000]])("rounds %s to %s pence", (pounds, pence) => expect(toPence(pounds)).toBe(pence));
  it.each([NaN, Infinity, -Infinity])("rejects non-finite money %s", (value) => expect(() => toPence(value)).toThrow(RangeError));
  it("rounds a decimal product once and symmetrically", () => {
    expect(linePence(7.25, 0.02)).toBe(15); expect(linePence(-7.25, 0.02)).toBe(-15);
    expect(linePence(3, 0.335)).toBe(101);
  });
  it("round-trips positive and negative whole pennies", () => {
    for (const pence of [-123456789, -1, 0, 1, 29, 123456789]) expect(toPence(fromPence(pence))).toBe(pence);
  });
});
