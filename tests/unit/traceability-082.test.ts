/** Migration 082's app side: supplier status words and colours, the PO form's notice, traceability on the worksheet, customers' default. */
import { describe, expect, it } from "vitest";

import { customerPayload, type TraceableReader, withTraceableDefaults } from "@/lib/customers";
import { missingTraceability } from "@/lib/job-worksheet";
import { STATUS_MAP } from "@/lib/status-colours";
import { SUPPLIER_STATUS_BADGE, SUPPLIER_STATUS_LABELS, SUPPLIER_STATUSES, canChangeSupplierStatus, isSupplierStatus, supplierKey, supplierOrderNotice } from "@/lib/supplier-status";

describe("supplier status (8.4)", () => {
  it("approved green, conditional yellow, blocked red, each with its word", () => {
    expect(SUPPLIER_STATUSES).toEqual(["approved", "conditional", "blocked"]);
    expect(SUPPLIER_STATUSES.map((s) => STATUS_MAP[SUPPLIER_STATUS_BADGE[s]].colour)).toEqual(["green", "yellow", "red"]);
    expect(SUPPLIER_STATUSES.map((s) => SUPPLIER_STATUS_LABELS[s])).toEqual(["Approved", "Conditional", "Blocked"]);
    expect(isSupplierStatus("blocked")).toBe(true);
    expect(isSupplierStatus("good")).toBe(false);
    expect(isSupplierStatus(null)).toBe(false);
  });

  it("the Issue dialog warns on a conditional supplier, says a blocked one can't be issued, says nothing otherwise", () => {
    expect(supplierOrderNotice("conditional")).toEqual({ tone: "warning", text: "Conditional supplier: check this order before you issue it." });
    expect(supplierOrderNotice("blocked")).toEqual({ tone: "blocked", text: "Blocked supplier: this order can't be issued until an admin changes its status on the Suppliers page." });
    expect(supplierOrderNotice("approved")).toBeNull();
    expect(supplierOrderNotice(undefined)).toBeNull();
  });
});

describe("traceability (8.5.2)", () => {
  it("only an admin changes a supplier's status; an order's supplier matches the list ignoring case and surrounding spaces", () => {
    expect(["admin", "office", "workshop", "viewer", null, undefined].map(canChangeSupplierStatus)).toEqual([true, false, false, false, false, false]);
    expect(supplierKey("  Steel LTD ")).toBe(supplierKey("steel ltd"));
    expect(supplierKey(null)).toBe("");
  });

  it("names what a traceable job still needs before a pass", () => {
    expect(missingTraceability({ material_cert_no: "", heat_cast_no: " " })).toEqual(["Material Cert #", "Heat / Cast #"]);
    expect(missingTraceability({ material_cert_no: "MC-1", heat_cast_no: "" })).toEqual(["Heat / Cast #"]);
    expect(missingTraceability({ material_cert_no: "MC-1", heat_cast_no: "HC-2" })).toEqual([]);
  });

  it("a customer's traceable default is read when the database has it and sent only when read", async () => {
    const customers = [{ id: "c1", name: "Aero", contactName: "", email: "", phone: "", address: "", notes: "" }, { id: "c2", name: "Plain", contactName: "", email: "", phone: "", address: "", notes: "" }];
    const reader = (result: { data: unknown[] | null; error: { code?: string; message?: string } | null }): TraceableReader => ({ from: () => ({ select: () => Promise.resolve(result) }) });
    const read = await withTraceableDefaults(reader({ data: [{ id: "c1", traceable_default: true }, { id: "c2", traceable_default: false }], error: null }), customers);
    expect(read.map((c) => c.traceableDefault)).toEqual([true, false]);
    // Before 082: the column is missing, the records are as they were (and the field is never sent).
    const before = await withTraceableDefaults(reader({ data: null, error: { code: "42703", message: "column customers.traceable_default does not exist" } }), customers);
    expect(before.map((c) => c.traceableDefault)).toEqual([undefined, undefined]);
    expect("traceable_default" in customerPayload(before[0], "org")).toBe(false);
    expect(customerPayload(read[0], "org")).toMatchObject({ traceable_default: true });
    // Any other failure is not hidden.
    await expect(withTraceableDefaults(reader({ data: null, error: { code: "08006", message: "offline" } }), customers)).rejects.toMatchObject({ code: "08006" });
  });
});
