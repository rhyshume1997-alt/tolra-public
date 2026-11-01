/**
 * Xero batch send (E3), the pure parts: which documents a date range covers and which of them each mode sends (range edges inclusive;
 * sent, failed, pending, none), what happens to each document when its turn comes, and the accountant's summary rows, CSV and file name.
 */
import { describe, expect, it } from "vitest";

import {
  type BatchDoc, type BatchSend, SUMMARY_COLUMNS, chunkAction, creditDocument, defaultFrom, startsBeforeConnection, invoiceDocument, isIssuedForXero, londonDate, pauseSeconds, parseRange,
  selectBatch, summaryFileName, summaryRows,
} from "@/lib/integrations/xero/batch";
import { toCsv } from "@/lib/spreadsheet";

const doc = (id: string, date: string, over: Partial<BatchDoc> = {}): BatchDoc =>
  ({ docType: "invoice", id, ref: `INV-${id}`, customer: "Acme", date, status: "issued", subtotal: 100, vat: 20, total: 120, ...over });
const send = (docId: string, status: BatchSend["status"], over: Partial<BatchSend> = {}): BatchSend =>
  ({ id: `s-${docId}`, docType: "invoice", docId, status, attempts: status === "pending" ? 0 : 1, externalId: status === "sent" ? "x1" : null, externalNumber: null, lastError: null, nextAttemptAt: null, sentAt: null, ...over });
const range = { from: "2026-10-01", to: "2026-10-31" };
const ids = (docs: Array<{ doc: BatchDoc }>) => docs.map((d) => d.doc.id);

describe("selection by mode", () => {
  const docs = [doc("none", "2026-10-05"), doc("sent", "2026-10-06"), doc("failed", "2026-10-07"), doc("pending", "2026-10-08"), doc("check", "2026-10-09"),
    doc("sending", "2026-10-10"), doc("skipped", "2026-10-11")];
  const sends = [send("sent", "sent"), send("failed", "failed", { lastError: "No" }), send("pending", "pending"), send("check", "needs_check"), send("sending", "sending"), send("skipped", "skipped")];

  it("unsent: no row and waiting rows; never sent, failed, to check, sending or skipped", () => {
    const r = selectBatch({ docs, sends, range, mode: "unsent" });
    expect(ids(r.selected)).toEqual(["none", "pending"]);
    expect(r.counts).toMatchObject({ sent: 1, failed: 1, needsCheck: 1, sending: 1, skipped: 1, waiting: 1, notQueued: 1, selected: 2 });
  });

  it("failed_only: failed rows and nothing else (a document never sent is not 'failed')", () => {
    expect(ids(selectBatch({ docs, sends, range, mode: "failed_only" }).selected)).toEqual(["failed"]);
  });

  it("a document already sent is selected in no mode", () => {
    for (const mode of ["unsent", "failed_only"] as const) expect(ids(selectBatch({ docs, sends, range, mode }).selected)).not.toContain("sent");
  });

  it("a void row is not the document's create row", () => {
    // selectBatch is given create rows only; the route filters the void rows out.
    expect(ids(selectBatch({ docs: [doc("a", "2026-10-05")], sends: [], range, mode: "unsent" }).selected)).toEqual(["a"]);
  });
});

describe("the range", () => {
  it("includes both end days and nothing outside", () => {
    const docs = [doc("before", "2026-09-30"), doc("first", "2026-10-01"), doc("mid", "2026-10-15"), doc("last", "2026-10-31"), doc("after", "2026-11-01")];
    expect(ids(selectBatch({ docs, sends: [], range, mode: "unsent" }).selected)).toEqual(["first", "mid", "last"]);
  });
  it("a one-day range is that day", () => {
    const docs = [doc("a", "2026-10-14"), doc("b", "2026-10-15"), doc("c", "2026-10-16")];
    expect(ids(selectBatch({ docs, sends: [], range: { from: "2026-10-15", to: "2026-10-15" }, mode: "unsent" }).selected)).toEqual(["b"]);
  });
  it("parseRange: real dates, from <= to", () => {
    expect(parseRange("2026-10-15", "2026-10-15")).toEqual({ ok: true, range: { from: "2026-10-15", to: "2026-10-15" } });
    expect(parseRange("2026-10-16", "2026-10-15").ok).toBe(false);
    expect(parseRange("2026-02-30", "2026-03-01").ok).toBe(false);
    expect(parseRange("15/10/2026", "2026-10-16").ok).toBe(false);
    expect(parseRange(undefined, "2026-10-16").ok).toBe(false);
  });
  it("the document date is the one 084 sends: invoice date, tax point, London day of issue, created", () => {
    const base = { id: "i", invoice_ref: "I1", customer: " Acme ", status: "issued", subtotal: "1", vat: "0.2", total: "1.2", created_at: "2026-01-01T00:00:00Z" };
    expect(invoiceDocument({ ...base, invoice_date: "2026-10-01", tax_point: "2026-09-01", issued_at: null })?.date).toBe("2026-10-01");
    expect(invoiceDocument({ ...base, invoice_date: null, tax_point: "2026-09-01", issued_at: null })?.date).toBe("2026-09-01");
    // 23:30 UTC on 30 June is 00:30 on 1 July in London (BST).
    expect(invoiceDocument({ ...base, invoice_date: null, tax_point: null, issued_at: "2026-06-30T23:30:00Z" })?.date).toBe("2026-07-01");
    expect(londonDate("2026-12-31T23:30:00Z")).toBe("2026-12-31");
    expect(creditDocument({ id: "c", credit_ref: "C1", customer: "A", status: "issued", credit_date: "2026-10-02", issued_at: null, created_at: null, subtotal: 1, vat: 0, total: 1 })).toMatchObject({ docType: "credit_note", date: "2026-10-02", total: 1 });
  });
});

describe("what is never selected", () => {
  it("drafts, voided and cancelled documents, imported records", () => {
    const docs = [doc("draft", "2026-10-05", { status: "draft" }), doc("void", "2026-10-05", { status: "void" }), doc("canc", "2026-10-05", { status: "Cancelled" }),
      doc("imp", "2026-10-05"), doc("ok", "2026-10-05", { status: "paid" })];
    const r = selectBatch({ docs, sends: [], range, mode: "unsent", imported: new Set(["imp"]) });
    expect(ids(r.selected)).toEqual(["ok"]);
    expect(r.counts.imported).toBe(1);
    expect(isIssuedForXero("sent")).toBe(true);
    expect(isIssuedForXero("")).toBe(false);
  });
  it("is sent oldest first, invoices before credit notes on the same day", () => {
    const docs = [doc("c1", "2026-10-05", { docType: "credit_note", ref: "CN-1" }), doc("i2", "2026-10-05", { ref: "INV-10" }), doc("i1", "2026-10-05", { ref: "INV-9" }), doc("old", "2026-10-01")];
    expect(ids(selectBatch({ docs, sends: [], range, mode: "unsent" }).selected)).toEqual(["old", "i1", "i2", "c1"]);
  });
});

describe("what the server does with each document (decided again from the database)", () => {
  const d = doc("a", "2026-10-05");
  const now = Date.parse("2026-10-30T12:00:00Z");
  it("unsent mode", () => {
    expect(chunkAction(d, null, "unsent", now)).toEqual({ kind: "enqueue_first" });
    expect(chunkAction(d, send("a", "pending"), "unsent", now)).toEqual({ kind: "send_first" });
    expect(chunkAction(d, send("a", "pending", { attempts: 2, nextAttemptAt: "2026-10-30T11:00:00Z" }), "unsent", now)).toEqual({ kind: "send_queued" });
    expect(chunkAction(d, send("a", "pending", { attempts: 2, nextAttemptAt: "2026-10-30T13:00:00Z" }), "unsent", now).kind).toBe("leave");
    for (const s of ["sent", "sending", "needs_check", "skipped", "failed"] as const) expect(chunkAction(d, send("a", s), "unsent", now).kind).toBe("leave");
  });
  it("failed_only mode retries failed rows and touches nothing else, not even a document with no row", () => {
    expect(chunkAction(d, send("a", "failed"), "failed_only", now)).toEqual({ kind: "retry_then_send" });
    expect(chunkAction(d, null, "failed_only", now).kind).toBe("leave");
    for (const s of ["sent", "sending", "needs_check", "skipped", "pending"] as const) expect(chunkAction(d, send("a", s), "failed_only", now).kind).toBe("leave");
  });
  it("a voided or missing document is left", () => {
    expect(chunkAction(doc("v", "2026-10-05", { status: "void" }), null, "unsent", now).kind).toBe("leave");
    expect(chunkAction(null, null, "unsent", now).kind).toBe("leave");
  });
  it("rate-limit pause is what the row says, between 1 and 90 s", () => {
    const now2 = Date.parse("2026-10-30T12:00:00Z");
    expect(pauseSeconds("2026-10-30T12:00:30Z", now2)).toBe(30);
    expect(pauseSeconds("2026-10-30T11:00:00Z", now2)).toBe(1);
    expect(pauseSeconds("2026-10-30T14:00:00Z", now2)).toBe(90);
    expect(pauseSeconds(null, now2)).toBe(60);
  });
});

describe("the summary", () => {
  const docs = [doc("a", "2026-10-05", { customer: '=HYPERLINK("http://x")' }), doc("b", "2026-10-06", { customer: "+44 Ltd" }), doc("c", "2026-10-07", { customer: "@home" }),
    doc("d", "2026-10-08", { customer: "-minus" }), doc("e", "2026-10-09"), doc("f", "2026-11-09"), doc("g", "2026-10-10", { status: "draft" }),
    doc("h", "2026-10-11", { docType: "credit_note", ref: "CN-1", total: -50, vat: -10, subtotal: -40 })];
  const sends = [
    { ...send("a", "sent", { externalNumber: "INV-a", sentAt: "2026-10-30T10:00:00Z", externalId: "x-a" }), action: "create" as const },
    { ...send("b", "failed", { lastError: "=cmd|' /C calc'!A0" }), action: "create" as const },
    { ...send("f", "sent"), action: "create" as const },
  ];
  const rows = summaryRows({ docs, sends, range });

  it("has the sent, the failed and a 'Not sent' line for each issued document with no row; not drafts or out-of-range documents", () => {
    expect(rows.map((r) => `${r.number}:${r.status}`)).toEqual(["INV-a:Sent", "INV-b:Failed", "INV-c:Not sent", "INV-d:Not sent", "INV-e:Not sent", "CN-1:Not sent"]);
    expect(rows[0]).toMatchObject({ type: "Invoice", xeroId: "x-a", xeroNumber: "INV-a", total: 120, vat: 20, error: null });
    expect(rows.at(-1)).toMatchObject({ type: "Credit note", total: -50 });
  });
  it("CSV: cells starting = + - @ are prefixed with a quote (also the error text), amounts are plain numbers", () => {
    const csv = toCsv(SUMMARY_COLUMNS, rows);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Document number,Type,Action,Customer,Issued date,Net,VAT,Total,Xero number,Xero id,Sent at,Status,Error");
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain("'+44 Ltd");
    expect(csv).toContain("'-minus");
    expect(csv).toContain("'@home");
    expect(csv).toContain(",Failed,'=cmd|' /C calc'!A0");
    expect(lines.find((l) => l.startsWith("CN-1"))).toContain(",-50.00");
    expect(csv).not.toMatch(/(^|,)=/m);
  });
  it("file name has the company and the range, and nothing unsafe", () => {
    expect(summaryFileName("Marpet Engineering Ltd", range, "csv")).toBe("Xero-summary-Marpet-Engineering-Ltd-2026-10-01-to-2026-10-31.csv");
    expect(summaryFileName('../"evil\r\n/co', range, "xlsx")).toBe("Xero-summary-evilco-2026-10-01-to-2026-10-31.xlsx");
    expect(summaryFileName(null, range, "csv")).toContain("-company-");
  });
});

describe("the pre-connection default", () => {
  it("From defaults to 1 January of this year, whenever Xero was connected (earlier documents are offered, ticked)", () => {
    expect(defaultFrom("2026-10-30")).toBe("2026-01-01");
    expect(defaultFrom("2027-02-03")).toBe("2027-01-01");
  });
  it("an earlier From needs the tick; the connection day itself does not", () => {
    expect(startsBeforeConnection("2026-10-11", "2026-10-12")).toBe(true);
    expect(startsBeforeConnection("2026-10-12", "2026-10-12")).toBe(false);
    expect(startsBeforeConnection("2020-01-01", null)).toBe(false);
  });
});
