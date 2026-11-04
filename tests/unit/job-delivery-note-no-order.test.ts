/**
 * C17: a delivery note for a job that did NOT come from a sales order, linked to the job and its customer by key. The button rule, the
 * customer the form starts on, and the arguments sent to create_job_delivery_note (one request id per form, so a double submit makes one note).
 */
import { describe, expect, it } from "vitest";

import { canOfferJobDeliveryNote } from "@/lib/job-delivery-note";
import {
  JOB_DELIVERY_NOTE_RPC,
  buildJobDeliveryNoteArgs,
  canOfferJobDeliveryNoteWithoutOrder,
  customerForJob,
} from "@/lib/job-delivery-note-no-order";

const ready = { from_sales_order: false, is_internal: false, inspected_at: "2026-10-01T10:00:00Z", stage: "complete" };
const REQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB = "11111111-1111-4111-8111-111111111111";
const CUS = "22222222-2222-4222-8222-222222222222";

describe("canOfferJobDeliveryNoteWithoutOrder (Job Board button on a job with no sales order)", () => {
  it("shows for admin and office on a ready job with no order", () => {
    expect(canOfferJobDeliveryNoteWithoutOrder("admin", ready)).toBe(true);
    expect(canOfferJobDeliveryNoteWithoutOrder("office", ready)).toBe(true);
  });
  it("is not shown to workshop, viewer or no role (as the order button)", () => {
    for (const r of ["workshop", "viewer", null, undefined]) expect(canOfferJobDeliveryNoteWithoutOrder(r, ready)).toBe(false);
  });
  it("is not shown on a job made from a sales order (that one uses the order's lines), an internal job, or a job not ready", () => {
    expect(canOfferJobDeliveryNoteWithoutOrder("admin", { ...ready, from_sales_order: true })).toBe(false);
    expect(canOfferJobDeliveryNoteWithoutOrder("admin", { ...ready, is_internal: true })).toBe(false);
    expect(canOfferJobDeliveryNoteWithoutOrder("admin", { ...ready, inspected_at: "", stage: "machining" })).toBe(false);
  });
  it("never offers both buttons for the same job", () => {
    for (const from_sales_order of [true, false]) {
      const job = { ...ready, from_sales_order };
      expect(canOfferJobDeliveryNote("admin", job) && canOfferJobDeliveryNoteWithoutOrder("admin", job)).toBe(false);
    }
  });
});

describe("customerForJob (the customer record the form starts on)", () => {
  const customers = [{ id: CUS, name: "Acme Ltd" }, { id: "x", name: "Other Ltd" }];
  it("picks the one record whose name is the job's customer, ignoring case and spaces", () => {
    expect(customerForJob(" acme ltd ", customers)).toBe(CUS);
  });
  it("picks none when no record or more than one matches (the person chooses; the database checks the name)", () => {
    expect(customerForJob("Nobody Ltd", customers)).toBeNull();
    expect(customerForJob("Acme Ltd", [...customers, { id: "y", name: "ACME LTD" }])).toBeNull();
  });
});

describe("buildJobDeliveryNoteArgs", () => {
  const form = { jobId: JOB, customerId: CUS, requestId: REQ, shipDate: "2026-11-04", taxDate: "2026-11-04", shipVia: " Van ", notes: "", lines: [{ description: " Bracket ", quantity: "4" }, { description: "", quantity: "" }] };
  it("calls the one RPC with the job, the customer, the request id and the filled lines", () => {
    expect(JOB_DELIVERY_NOTE_RPC).toBe("create_job_delivery_note");
    expect(buildJobDeliveryNoteArgs(form)).toEqual({
      ok: true,
      args: { p_job: JOB, p_customer: CUS, p_request: REQ, p_ship_date: "2026-11-04", p_tax_date: "2026-11-04", p_ship_via: "Van", p_notes: null, p_lines: [{ description: "Bracket", quantity: 4 }] },
    });
  });
  it("refuses with a plain reason before calling when something is missing or wrong", () => {
    expect(buildJobDeliveryNoteArgs({ ...form, customerId: "" })).toEqual({ ok: false, error: "Choose the customer this job is for." });
    expect(buildJobDeliveryNoteArgs({ ...form, lines: [{ description: "", quantity: "" }] })).toEqual({ ok: false, error: "Add at least one line with a description and a quantity." });
    expect(buildJobDeliveryNoteArgs({ ...form, lines: [{ description: "Bracket", quantity: "0" }] })).toEqual({ ok: false, error: "Each quantity must be more than zero, with at most three decimal places." });
    expect(buildJobDeliveryNoteArgs({ ...form, lines: [{ description: "Bracket", quantity: "1.2345" }] })).toEqual({ ok: false, error: "Each quantity must be more than zero, with at most three decimal places." });
    expect(buildJobDeliveryNoteArgs({ ...form, lines: [{ description: "", quantity: "3" }] })).toEqual({ ok: false, error: "Every line needs a description." });
    expect(buildJobDeliveryNoteArgs({ ...form, shipDate: "" })).toEqual({ ok: false, error: "The ship date and tax date are required." });
  });
  it("keeps the same request id for a second submit of the same form (the database returns the first note)", () => {
    const a = buildJobDeliveryNoteArgs(form), b = buildJobDeliveryNoteArgs(form);
    expect(a.ok && b.ok && a.args.p_request === b.args.p_request).toBe(true);
  });
});
