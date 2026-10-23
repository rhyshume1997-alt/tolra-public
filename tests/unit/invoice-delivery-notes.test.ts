import { describe, expect, it } from "vitest";

import { canCreateDeliveryNote, canOfferCreateDeliveryNote, deliveryNoteSource, deliveryNotesPrintedLine, fetchInvoiceNotes, invoiceNotesFilter, toInvoiceNotes } from "@/lib/invoice-delivery-notes";

const INV = "11111111-1111-4111-8111-111111111111";
const OTHER_INV = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const OTHER_JOB = "44444444-4444-4444-8444-444444444444";
const SO = "55555555-5555-4555-8555-555555555555";

const row = (over: Record<string, unknown>) => ({ id: "n1", dn_number: "DLN-0001", delivery_date: "2026-10-01", status: "despatched", invoice_id: null, job_id: null, sales_order_id: null, ...over });

describe("delivery notes on an invoice", () => {
  it("lists notes on the invoice, and unlinked notes on its job, sorted by number", () => {
    const notes = toInvoiceNotes([
      row({ id: "b", dn_number: "DLN-0010", invoice_id: INV, sales_order_id: SO }),
      row({ id: "a", dn_number: "DLN-0002", job_id: JOB }),
      row({ id: "c", dn_number: "DLN-0003", invoice_id: INV, job_id: JOB }),
    ], { id: INV, jobId: JOB });
    expect(notes.map((note) => [note.ref, note.via])).toEqual([["DLN-0002", "job"], ["DLN-0003", "invoice"], ["DLN-0010", "invoice"]]);
    expect(notes[2]).toMatchObject({ id: "b", date: "2026-10-01", status: "despatched", salesOrderId: SO });
  });

  it("never lists a note on another invoice, or on another job, or a job note when the invoice has no job", () => {
    const rows = [row({ id: "x", invoice_id: OTHER_INV, job_id: JOB }), row({ id: "y", job_id: OTHER_JOB }), row({ id: "z", job_id: JOB })];
    expect(toInvoiceNotes(rows, { id: INV, jobId: JOB }).map((note) => note.id)).toEqual(["z"]);
    expect(toInvoiceNotes(rows, { id: INV })).toEqual([]);
  });

  it("builds the filter from checked ids only", () => {
    expect(invoiceNotesFilter(INV)).toBe(`invoice_id.eq.${INV}`);
    expect(invoiceNotesFilter(INV, JOB)).toBe(`invoice_id.eq.${INV},and(invoice_id.is.null,job_id.eq.${JOB})`);
    expect(invoiceNotesFilter(INV, "x),invoice_id.not.is.null")).toBe(`invoice_id.eq.${INV}`);
    expect(invoiceNotesFilter("not-an-id", JOB)).toBeNull();
  });

  it("makes a new note from the invoice's job, else from the order of a note already on it", () => {
    expect(deliveryNoteSource({ jobId: JOB }, [])).toEqual({ source: "job", id: JOB });
    const onInvoice = toInvoiceNotes([row({ invoice_id: INV, sales_order_id: SO })], { id: INV });
    expect(deliveryNoteSource({}, onInvoice)).toEqual({ source: "order", id: SO });
    const sameJobOnly = toInvoiceNotes([row({ job_id: JOB, sales_order_id: SO })], { id: INV, jobId: JOB });
    expect(deliveryNoteSource({}, sameJobOnly)).toBeNull();
    expect(deliveryNoteSource({ jobId: "bad" }, [])).toBeNull();
  });

  it("offers Create delivery note only when a note is already on this invoice (the invoice came from delivery notes)", () => {
    const onInvoice = toInvoiceNotes([row({ invoice_id: INV, job_id: JOB })], { id: INV, jobId: JOB });
    const sameJobOnly = toInvoiceNotes([row({ job_id: JOB })], { id: INV, jobId: JOB });
    expect(canOfferCreateDeliveryNote({ jobId: JOB }, onInvoice)).toBe(true);
    expect(canOfferCreateDeliveryNote({ jobId: JOB }, sameJobOnly)).toBe(false);
    expect(canOfferCreateDeliveryNote({ jobId: JOB }, [])).toBe(false);
    // A note on the invoice but no job and no order to make another from: nothing to offer.
    expect(canOfferCreateDeliveryNote({}, toInvoiceNotes([row({ invoice_id: INV })], { id: INV }))).toBe(false);
    expect(canOfferCreateDeliveryNote({}, toInvoiceNotes([row({ invoice_id: INV, sales_order_id: SO })], { id: INV }))).toBe(true);
  });

  it("offers the button only to the roles that can already make a delivery note", () => {
    expect(["admin", "office", "workshop"].every(canCreateDeliveryNote)).toBe(true);
    expect(canCreateDeliveryNote("viewer")).toBe(false);
    expect(canCreateDeliveryNote(undefined)).toBe(false);
    expect(canCreateDeliveryNote(null)).toBe(false);
  });

  it("prints only the notes on the invoice itself, short", () => {
    const notes = toInvoiceNotes([
      row({ id: "a", dn_number: "DLN-0001", invoice_id: INV }), row({ id: "b", dn_number: "DLN-0002", invoice_id: INV }), row({ id: "c", dn_number: "DLN-0009", job_id: JOB }),
    ], { id: INV, jobId: JOB });
    expect(deliveryNotesPrintedLine(notes)).toBe("DLN-0001, DLN-0002");
    expect(deliveryNotesPrintedLine([])).toBeUndefined();
    expect(deliveryNotesPrintedLine(toInvoiceNotes([row({ job_id: JOB })], { id: INV, jobId: JOB }))).toBeUndefined();
    const many = toInvoiceNotes([1, 2, 3, 4, 5, 6].map((n) => row({ id: `n${n}`, dn_number: `DLN-000${n}`, invoice_id: INV })), { id: INV });
    expect(deliveryNotesPrintedLine(many)).toBe("DLN-0001, DLN-0002 +4 more");
    expect(deliveryNotesPrintedLine(many, 4)).toBe("DLN-0001, DLN-0002, DLN-0003, DLN-0004 +2 more");
  });

  it("reads the table once, and passes a database error on", async () => {
    const calls: string[] = [];
    const db = (result: { data: unknown; error: unknown }) => ({
      from: (table: string) => ({
        select: (columns: string) => ({
          or: (filter: string) => ({ order: (column: string) => ({ limit: async (n: number) => { calls.push(`${table}|${columns.split(",").length}|${filter}|${column}|${n}`); return result; } }) }),
        }),
      }),
    });
    const notes = await fetchInvoiceNotes(db({ data: [row({ invoice_id: INV })], error: null }), { id: INV });
    expect(notes).toHaveLength(1);
    expect(calls).toEqual([`delivery_notes|7|invoice_id.eq.${INV}|dn_number|100`]);
    await expect(fetchInvoiceNotes(db({ data: null, error: new Error("denied") }), { id: INV })).rejects.toThrow("denied");
    expect(await fetchInvoiceNotes(db({ data: [], error: null }), { id: "bad" })).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
