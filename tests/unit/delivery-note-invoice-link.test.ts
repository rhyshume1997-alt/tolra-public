import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type InvoiceRow, type LinkNote, ITEMS_NOT_ADDED, LINK_REFUSALS, draftCandidates, invoiceLive, noteJobIds, noteLinkBlocked, sameCustomer } from "@/lib/delivery-note-invoice-link";

const note = (extra: Partial<LinkNote> = {}): LinkNote => ({ id: "dn-1", dnNumber: "DN-0101", customer: "Acme Ltd", jobId: "job-1", salesOrderId: null, invoiceId: null, invoiceRef: null, ...extra });
const invoice = (extra: Partial<InvoiceRow> = {}): InvoiceRow => ({ id: "inv-1", status: "draft", invoice_ref: null, customer: "Acme Ltd", job_id: "job-1", total: "240.00", invoice_date: "2026-10-18", ...extra });

describe("which draft invoices a delivery note can go on (as link_delivery_note_to_invoice decides)", () => {
  it("same customer as the function compares it: case, outer spaces and runs of white space ignored", () => {
    expect(sameCustomer("ACME  ltd", "Acme Ltd")).toBe(true);
    expect(sameCustomer(" Acme\tLtd ", "acme ltd")).toBe(true);
    expect(sameCustomer("Acme Ltd", "Acme Limited")).toBe(false);
    expect(sameCustomer(null, "")).toBe(true);
  });

  it("only drafts, of the note's jobs, for the same customer", () => {
    const rows = [
      invoice({ id: "ok", customer: "ACME  LTD" }),
      invoice({ id: "null-status", status: null }),
      invoice({ id: "issued", status: "issued", invoice_ref: "INV-1" }),
      invoice({ id: "other-job", job_id: "job-2" }),
      invoice({ id: "no-job", job_id: null }),
      invoice({ id: "other-customer", customer: "Bolt Co" }),
      invoice({ id: "Draft-case", status: "Draft" }),
    ];
    const found = draftCandidates(note(), rows, ["job-1"]);
    expect(found.map((c) => c.id)).toEqual(["ok", "null-status"]);
    expect(found[0]).toEqual({ id: "ok", customer: "ACME  LTD", jobId: "job-1", total: 240, invoiceDate: "2026-10-18" });
  });

  it("the note's jobs are its own job and the job its sales order became", () => {
    expect(noteJobIds(note(), [])).toEqual(["job-1"]);
    expect(noteJobIds(note({ jobId: null, salesOrderId: "so-1" }), ["job-9"])).toEqual(["job-9"]);
    expect(noteJobIds(note(), ["job-1", "job-9"])).toEqual(["job-1", "job-9"]);
    expect(noteJobIds(note({ jobId: null }), [])).toEqual([]);
  });

  it("a note with a hand-typed invoice number can't be put on an invoice; one already on a live invoice is shown as linked", () => {
    expect(noteLinkBlocked(note({ invoiceRef: " INV-0456 " }), null)).toBe("Delivery note DN-0101 records invoice INV-0456, so it can't be put on another one.");
    expect(noteLinkBlocked(note({ invoiceId: "inv-1", invoiceRef: "INV-0456" }), { id: "inv-1", ref: "INV-0456", draft: false })).toBeNull();
    expect(noteLinkBlocked(note(), null)).toBeNull();
  });

  it("void and cancelled invoices are not live", () => {
    for (const status of ["void", "Voided", "cancelled", "canceled"]) expect(invoiceLive(status)).toBe(false);
    for (const status of [null, "draft", "issued", "paid"]) expect(invoiceLive(status)).toBe(true);
  });
});

describe("the words shown are the function's own", () => {
  const sql = readFileSync(path.join(__dirname, "../../supabase/migrations/067_document_attachments.sql"), "utf8");
  // RAISE EXCEPTION 'text with % and ''quotes''', args: as the user sees it, with each % filled in.
  const raised = [...sql.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const fill = (template: string, ...values: string[]) => values.reduce((text, value) => text.replace("%", value), template);
  const has = (message: string) => raised.some((template) => {
    const count = (template.match(/%/g) ?? []).length;
    const pattern = new RegExp(`^${template.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+)")}$`);
    return count > 0 ? pattern.test(message) : template === message;
  });

  it("each refusal matches a RAISE in link_delivery_note_to_invoice", () => {
    expect(has(LINK_REFUSALS.issued("INV-7"))).toBe(true);
    expect(has(LINK_REFUSALS.onAnother("DN-1"))).toBe(true);
    expect(has(LINK_REFUSALS.typedRef("DN-1", "INV-9"))).toBe(true);
    expect(has(LINK_REFUSALS.otherJob("DN-1"))).toBe(true);
    expect(has(LINK_REFUSALS.otherCustomer("DN-1"))).toBe(true);
    expect(fill("Delivery note % records invoice %, so it can't be put on another one.", "DN-1", "INV-9")).toBe(LINK_REFUSALS.typedRef("DN-1", "INV-9"));
  });

  it("attaching says plainly that the note's items are not added", () => {
    expect(ITEMS_NOT_ADDED).toMatch(/items are not added/);
    expect(ITEMS_NOT_ADDED).toMatch(/Edit Draft/);
  });
});
