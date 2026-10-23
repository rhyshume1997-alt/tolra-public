import { describe, expect, it } from "vitest";

import { invoicesEmptyHint, jobsEmptyHint, purchaseOrdersEmptyHint, scheduleEmptyHint, supplierPickerHint } from "@/lib/empty-hints";

describe("empty-state hints", () => {
  it("Job Board: only points at New job for people who have it", () => {
    expect(jobsEmptyHint("admin")).toMatch(/New job/);
    expect(jobsEmptyHint("office")).toMatch(/sales order/);
    expect(jobsEmptyHint("workshop")).toMatch(/New job/);
    expect(jobsEmptyHint("viewer")).not.toMatch(/New job|press/i);
  });
  it("Machine Schedule: machines first, then New booking", () => {
    expect(scheduleEmptyHint("admin", 0)).toMatch(/Add your machines/);
    expect(scheduleEmptyHint("workshop", 0)).toMatch(/admin or the office adds the machines/);
    expect(scheduleEmptyHint("workshop", 2)).toMatch(/New booking/);
    expect(scheduleEmptyHint("viewer", 2)).not.toMatch(/press/i);
  });
  it("POs and invoices: one line, the next step", () => {
    for (const hint of [purchaseOrdersEmptyHint(), invoicesEmptyHint()]) {
      expect(hint.split(". ").length).toBe(1);
      expect(hint.length).toBeLessThan(110);
    }
  });
  it("New purchase order supplier picker: says why there is nothing to pick, and says nothing when there is", () => {
    expect(supplierPickerHint(2, null)).toBeNull();
    expect(supplierPickerHint(2, "Couldn't load your suppliers.")).toBeNull();
    expect(supplierPickerHint(0, null)).toMatch(/Suppliers page/);
    expect(supplierPickerHint(0, "Couldn't load your suppliers.")).toBe("Couldn't load your suppliers.");
  });
});
