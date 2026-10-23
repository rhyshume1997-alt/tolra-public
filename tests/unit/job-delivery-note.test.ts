import { describe, expect, it } from "vitest";

import { canOfferJobDeliveryNote, jobReadyForDeliveryNote } from "@/lib/job-delivery-note";

const inspected = { from_sales_order: true, inspected_at: "2026-10-01T10:00:00Z", stage: "complete" };

describe("jobReadyForDeliveryNote (the rule the From a job picker uses)", () => {
  it("is ready once inspected", () => expect(jobReadyForDeliveryNote({ inspected_at: "2026-10-01T10:00:00Z", stage: "complete" })).toBe(true));
  it("is ready in rework or inspection, where a released part may still go", () => {
    expect(jobReadyForDeliveryNote({ inspected_at: "", stage: "rework" })).toBe(true);
    expect(jobReadyForDeliveryNote({ inspected_at: "", stage: "inspection" })).toBe(true);
  });
  it("is not ready while the job is still being made", () => {
    expect(jobReadyForDeliveryNote({ inspected_at: "", stage: "material" })).toBe(false);
    expect(jobReadyForDeliveryNote({ stage: null })).toBe(false);
  });
});

describe("canOfferJobDeliveryNote (Job Board button)", () => {
  it("shows for admin and office on an inspected job made from a sales order", () => {
    expect(canOfferJobDeliveryNote("admin", inspected)).toBe(true);
    expect(canOfferJobDeliveryNote("office", inspected)).toBe(true);
  });
  it("hides for workshop, viewer and no role", () => {
    expect(canOfferJobDeliveryNote("workshop", inspected)).toBe(false);
    expect(canOfferJobDeliveryNote("viewer", inspected)).toBe(false);
    expect(canOfferJobDeliveryNote(null, inspected)).toBe(false);
  });
  it("hides for a job that did not come from a sales order (nothing to despatch from)", () => {
    expect(canOfferJobDeliveryNote("admin", { ...inspected, from_sales_order: false })).toBe(false);
    expect(canOfferJobDeliveryNote("admin", { inspected_at: inspected.inspected_at, stage: "complete" })).toBe(false);
  });
  it("hides for a job not yet inspected", () => {
    expect(canOfferJobDeliveryNote("office", { from_sales_order: true, inspected_at: "", stage: "machining" })).toBe(false);
  });
});
