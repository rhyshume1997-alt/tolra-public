/**
 * The customer's sign-off (migration 072) on the delivery note PDF and on the invoice PDF made from that job's delivery notes: the data
 * selection (the job's latest customer sign-off; none gives nothing), the PDF props, and the printed block. No sign-off leaves the PDF as it was.
 */
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { DeliveryNotePDF, type DeliveryNotePdfData } from "@/components/pdf/DeliveryNotePDF";
import { InvoicePDF, type InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { JNR_PROFILE } from "@/lib/company";
import {
  customerSignOffPdfProps, deliveryNoteCustomerSignOff, fetchJobCustomerSignOff, invoiceCustomerSignOff, latestCustomerSignOff, singleJobOfNotes,
} from "@/lib/customer-signoff-print";
import type { InvoiceNote } from "@/lib/invoice-delivery-notes";
import { CUSTOMER_SIGNOFF_STATEMENT, type JobSignOff } from "@/lib/job-signoff";
import { pdfText } from "../support/pdf-text";

const JOB = "11111111-1111-4111-8111-111111111111";
const JOB2 = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(64);
const PATH = "M10 10L60 40L120 20L200 80";

const row = (extra: Partial<JobSignOff>): JobSignOff => ({
  id: "r", job_id: JOB, worksheet_version: 2, snapshot: {}, snapshot_sha256: SHA, record_sha256: SHA, initials: "JS", signer_name: "Jane Smith",
  signed_on: "2026-10-17", signature_kind: "drawn", signature_data: PATH, signed_by: "u-1", kind: "customer", created_at: "2026-10-17T13:00:00Z",
  statement: CUSTOMER_SIGNOFF_STATEMENT, device_signed_at: "2026-10-17T13:03:00Z", ...extra,
});

/** A stand-in for the signed-in client: a table's rows filtered by the eq() calls, as row security would leave them. */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>, options: { failTable?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    from: (name: string) => {
      calls.push(name);
      const filters: Array<[string, unknown]> = [];
      let single = false;
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        limit: () => builder,
        maybeSingle: () => { single = true; return builder; },
        then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
          if (options.failTable === name) return Promise.resolve({ data: null, error: { code: "42P01", message: "relation does not exist" } }).then(resolve);
          const rows = (tables[name] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

describe("which customer sign-off is printed", () => {
  it("is the latest customer sign-off, never an internal one", () => {
    const rows = [
      row({ id: "old", created_at: "2026-10-10T09:00:00Z", signer_name: "Earlier Person" }),
      row({ id: "new", created_at: "2026-10-17T13:00:00Z" }),
      row({ id: "op", kind: "primary", created_at: "2026-10-18T09:00:00Z", signer_name: "Operator" }),
    ];
    expect(latestCustomerSignOff(rows)?.id).toBe("new");
  });

  it("is nothing when the job has no customer sign-off", () => {
    expect(latestCustomerSignOff([])).toBeNull();
    expect(latestCustomerSignOff([row({ kind: "primary" }), row({ kind: "inspector" })])).toBeNull();
    expect(customerSignOffPdfProps(null)).toBeUndefined();
    expect(customerSignOffPdfProps(row({ kind: "primary" }))).toBeUndefined();
  });

  it("reads only the job's customer rows, through the client given", async () => {
    const db = fakeDb({ job_signoffs: [
      row({ id: "a", created_at: "2026-10-01T09:00:00Z" }), row({ id: "b", created_at: "2026-10-05T09:00:00Z" }),
      row({ id: "c", job_id: JOB2, created_at: "2026-10-30T09:00:00Z" }), row({ id: "d", kind: "primary", created_at: "2026-10-31T09:00:00Z" }),
    ] });
    expect((await fetchJobCustomerSignOff(db, JOB))?.id).toBe("b");
    expect(await fetchJobCustomerSignOff(db, null)).toBeNull();
    expect(await fetchJobCustomerSignOff(db, "not-an-id")).toBeNull();
  });

  it("is nothing when 072 isn't applied or the table can't be read", async () => {
    expect(await fetchJobCustomerSignOff(fakeDb({ job_signoffs: [row({ kind: "primary" })] }), JOB)).toBeNull();
    expect(await fetchJobCustomerSignOff(fakeDb({}, { failTable: "job_signoffs" }), JOB)).toBeNull();
    expect(await deliveryNoteCustomerSignOff(fakeDb({ delivery_notes: [{ id: NOTE, job_id: JOB }] }, { failTable: "job_signoffs" }), NOTE)).toBeUndefined();
  });
});

describe("the PDF props", () => {
  it("carry the worksheet's wording: name line, statement, the phone's time and the signature", () => {
    const props = customerSignOffPdfProps(row({ signer_position: "Site Manager", signer_company: "Acme Ltd" }));
    expect(props).toEqual({
      name: "Jane Smith, Site Manager, Acme Ltd",
      statement: CUSTOMER_SIGNOFF_STATEMENT,
      signedAt: "17 Oct 2026, 14:03 (phone time)",
      signature: { kind: "drawn", data: PATH },
    });
  });

  it("fall back to the UK date without a phone time, and carry a typed signature as it is", () => {
    const props = customerSignOffPdfProps(row({ device_signed_at: null, statement: null, signature_kind: "typed", signature_data: "Jane Smith" }));
    expect(props?.signedAt).toBe("17 Oct 2026 (phone time)");
    expect(props?.statement).toBeUndefined();
    expect(props?.signature).toEqual({ kind: "typed", data: "Jane Smith" });
  });
});

describe("a delivery note's sign-off", () => {
  const db = fakeDb({
    delivery_notes: [{ id: NOTE, job_id: JOB, job_ref: null }, { id: "n2", job_id: null, job_ref: "J-0007" }, { id: "n3", job_id: null, job_ref: "" }],
    jobs: [{ id: JOB2, job_no: "J-0007" }],
    job_signoffs: [row({ id: "x" }), row({ id: "y", job_id: JOB2, signer_name: "Second Job" })],
  });
  it("comes from the note's job (job_id)", async () => {
    expect((await deliveryNoteCustomerSignOff(db, NOTE))?.name).toBe("Jane Smith");
  });
  it("comes from the job whose number is the note's job_ref when it has no job_id", async () => {
    expect((await deliveryNoteCustomerSignOff(db, "n2"))?.name).toBe("Second Job");
  });
  it("is nothing for a note on no job", async () => {
    expect(await deliveryNoteCustomerSignOff(db, "n3")).toBeUndefined();
    expect(await deliveryNoteCustomerSignOff(db, "missing")).toBeUndefined();
  });
});

describe("an invoice's sign-off", () => {
  const note = (id: string, jobId: string | null, via: "invoice" | "job" = "invoice"): InvoiceNote => ({ id, ref: id, date: "2026-10-01", status: "delivered", jobId, salesOrderId: null, via });
  const db = fakeDb({ job_signoffs: [row({ id: "x" })] });

  it("comes from the one job its own delivery notes are on", async () => {
    expect(singleJobOfNotes([note("a", JOB), note("b", JOB)])).toBe(JOB);
    expect((await invoiceCustomerSignOff(db, [note("a", JOB), note("b", JOB)]))?.name).toBe("Jane Smith");
  });
  it("is nothing for notes of several jobs, notes only on the job (not on the invoice), or no notes", async () => {
    expect(singleJobOfNotes([note("a", JOB), note("b", JOB2)])).toBeNull();
    expect(singleJobOfNotes([note("a", JOB, "job")])).toBeNull();
    expect(singleJobOfNotes([note("a", null)])).toBeNull();
    // A note on no job beside a note on the job: the sign-off may not cover the whole invoice, so none is printed.
    expect(singleJobOfNotes([note("a", JOB), note("b", null)])).toBeNull();
    // Notes only on the job (not on this invoice) don't count against it.
    expect(singleJobOfNotes([note("a", JOB), note("b", null, "job")])).toBe(JOB);
    expect(await invoiceCustomerSignOff(db, [note("a", JOB), note("b", JOB2)])).toBeUndefined();
    expect(await invoiceCustomerSignOff(db, [note("a", JOB, "job")])).toBeUndefined();
    expect(await invoiceCustomerSignOff(db, [])).toBeUndefined();
  });
});

describe("the printed block", () => {
  const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
  const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  const dn: DeliveryNotePdfData = { number: "DLN-0456", taxDate: "07/03/2026", shipDate: "07/03/2026", billTo: ["Example Customer Ltd"], items: [{ description: "Bush", quantity: 2 }], company };
  const inv: InvoicePdfData = {
    number: "INV-7300", date: "07/03/2026", billTo: ["Example Customer Ltd"], lineItems: [{ description: "Machining", quantity: 3, unitPrice: 33.33, vatPct: 20 }],
    carriage: 10, vatEnabled: true, payments: 0, company, storedTotals: { reference: "INV-7300", issued: true, subtotal: 99.99, vat: 20, total: 129.99 },
  };
  const renderDn = (data: DeliveryNotePdfData) => renderToBuffer(createElement(DeliveryNotePDF, { data }) as Parameters<typeof renderToBuffer>[0]);
  const renderInv = (data: InvoicePdfData) => renderToBuffer(createElement(InvoicePDF, { data }) as Parameters<typeof renderToBuffer>[0]);
  const signOff = customerSignOffPdfProps(row({ signer_company: "Acme Ltd" }));

  it("prints on the delivery note, on one page, with name, statement and time", async () => {
    const pdf = await renderDn({ ...dn, customerSignOff: signOff });
    const out = pdfText(pdf);
    expect(out).toContain("Customer sign-off");
    expect(out).toContain("Jane Smith, Acme Ltd");
    expect(out).toContain(CUSTOMER_SIGNOFF_STATEMENT);
    expect(out).toContain("17 Oct 2026, 14:03 (phone time)");
    expect(pages(pdf)).toBe(1);
  });

  it("prints on the invoice, on one page, beside the totals", async () => {
    const pdf = await renderInv({ ...inv, customerSignOff: signOff });
    const out = pdfText(pdf);
    expect(out).toContain("Customer sign-off");
    expect(out).toContain("Jane Smith, Acme Ltd");
    expect(out).toContain("Balance due");
    expect(pages(pdf)).toBe(1);
  });

  it("prints a typed signature as text", async () => {
    const out = pdfText(await renderDn({ ...dn, customerSignOff: customerSignOffPdfProps(row({ signature_kind: "typed", signature_data: "Jane S Smith" })) }));
    expect(out).toContain("Jane S Smith");
  });

  it("draws a drawn signature (the same note with an unreadable path has no stroke)", async () => {
    const drawn = await renderDn({ ...dn, customerSignOff: signOff });
    const unreadable = await renderDn({ ...dn, customerSignOff: customerSignOffPdfProps(row({ signature_data: "not a path" })) });
    const strokes = (pdf: Buffer) => (pdf.toString("latin1").match(/ l\b| m\b/g) ?? []).length;
    expect(drawn.length).not.toBe(unreadable.length);
    expect(pdfText(unreadable)).toContain("Customer sign-off");
    expect(strokes(drawn)).toBeGreaterThanOrEqual(strokes(unreadable));
  });

  it("without a sign-off the documents are exactly as before", async () => {
    const without = pdfText(await renderDn(dn));
    expect(without).not.toContain("Customer sign-off");
    expect(pdfText(await renderDn({ ...dn, customerSignOff: undefined }))).toBe(without);
    const invWithout = pdfText(await renderInv(inv));
    expect(invWithout).not.toContain("Customer sign-off");
    expect(pdfText(await renderInv({ ...inv, customerSignOff: undefined }))).toBe(invWithout);
  });
});

describe("long sign-off text on the PDF", () => {
  it("clips the name and statement so the fixed-height block keeps to its lines", () => {
    const props = customerSignOffPdfProps(row({ statement: "x".repeat(500) }));
    expect(props!.statement!.length).toBe(180);
    expect(props!.statement!.endsWith("\u2026")).toBe(true);
    expect(customerSignOffPdfProps(row({ statement: "Received in good order." }))!.statement).toBe("Received in good order.");
  });
});
