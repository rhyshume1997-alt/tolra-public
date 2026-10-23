import { describe, expect, it } from "vitest";

import { balanceDue, daysPastDue, invoiceLifecycle, isRaised, owed, paidOnTime, paidOnTimeNote } from "@/lib/receivables";

describe("receivables (audit D23, A2)", () => {
  it("classifies lifecycle states", () => {
    expect(invoiceLifecycle("paid")).toBe("paid");
    for (const status of ["draft", "void", "Cancelled", "credited"]) expect(invoiceLifecycle(status)).toBe("closed");
    for (const status of ["sent", "overdue", "outstanding", "partial"]) expect(invoiceLifecycle(status)).toBe("collectible");
    // A missing status is a draft, as on the server (coalesce(status, 'draft'), migration 027): not collectible.
    for (const status of [null, undefined, ""]) expect(invoiceLifecycle(status)).toBe("closed");
  });

  it("owes the face value minus receipts, exactly, never below zero", () => {
    expect(balanceDue(120, 50)).toBe(70);
    expect(balanceDue(120, 0)).toBe(120);
    expect(balanceDue(120, 120)).toBe(0);
    expect(balanceDue(120, 130)).toBe(0); // overpaid
    expect(balanceDue(0.3, 0.1)).toBe(0.2);
  });

  it("counts only collectible invoices as owed", () => {
    expect(owed({ status: "sent", total: 120, amount_paid: 50 })).toBe(70);
    expect(owed({ status: "paid", total: 120, amount_paid: 120 })).toBe(0);
    expect(owed({ status: "draft", total: 120, amount_paid: 0 })).toBe(0);
    expect(owed({ status: "cancelled", total: 120, amount_paid: 0 })).toBe(0);
  });

  it("due today isn't overdue; no due date is explicit", () => {
    expect(daysPastDue("2026-10-09", "2026-10-09")).toBe(0);
    expect(daysPastDue("2026-10-08", "2026-10-09")).toBe(1);
    expect(daysPastDue("2026-10-10", "2026-10-09")).toBe(-1);
    expect(daysPastDue(undefined, "2026-10-09")).toBeNull();
  });
});

describe("paid on time (go-live polish item 12)", () => {
  const onTime = { status: "paid", due_date: "2026-10-10", paid_at: "2026-10-10T12:00:00+00:00" }; // on the due date
  const late = { status: "paid", due_date: "2026-10-10", paid_at: "2026-10-11T12:00:00+00:00" }; // a day late
  const noDue = { status: "paid", due_date: null, paid_at: "2026-10-11T12:00:00+00:00" };
  const noPayment = { status: "paid", due_date: "2026-10-10", paid_at: null };

  it("is on-time / paid invoices with both dates", () => {
    expect(paidOnTime([onTime, late])).toEqual({ counted: 2, onTime: 1, excluded: 0, rate: 50 });
    expect(paidOnTimeNote(paidOnTime([onTime, late]))).toBe("1 of 2 paid on time");
  });
  it("a paid invoice with no due date is unknown: left out of both, and counted as excluded", () => {
    expect(paidOnTime([onTime, onTime, onTime, late, noDue])).toEqual({ counted: 4, onTime: 3, excluded: 1, rate: 75 });
    expect(paidOnTimeNote(paidOnTime([onTime, onTime, onTime, late, noDue]))).toBe("3 of 4 paid on time · 1 without dates not counted");
  });
  it("a paid invoice with no payment date is unknown too", () => {
    expect(paidOnTime([late, noPayment])).toEqual({ counted: 1, onTime: 0, excluded: 1, rate: 0 });
  });
  it("none qualifying is '—' (null), never 100%; unpaid and unconfirmed invoices aren't counted at all", () => {
    const unpaid = [{ status: "issued", due_date: "2026-12-01" }, { status: "partial", due_date: "2026-12-01", paid_at: null }, { status: "draft" }, { status: "issued", due_date: "2026-01-01" }];
    expect(paidOnTime(unpaid)).toEqual({ counted: 0, onTime: 0, excluded: 0, rate: null });
    expect(paidOnTime([noDue, noPayment])).toEqual({ counted: 0, onTime: 0, excluded: 2, rate: null });
    expect(paidOnTimeNote(paidOnTime([noDue, noPayment]))).toBe("No paid invoices with a due date and payment date · 2 without dates not counted");
    expect(paidOnTime([{ ...onTime, payment_unverified: true }])).toEqual({ counted: 0, onTime: 0, excluded: 0, rate: null });
    expect(paidOnTime([...unpaid, onTime])).toEqual({ counted: 1, onTime: 1, excluded: 0, rate: 100 });
  });
  it("raised means issued: not drafts, void or cancelled", () => {
    expect(["issued", "partial", "paid", "draft", null, "void", "cancelled"].map((s) => isRaised(s))).toEqual([true, true, true, false, false, false, false]);
  });
});
