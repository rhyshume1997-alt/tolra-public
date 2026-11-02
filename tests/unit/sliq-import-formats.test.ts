/**
 * SliQ importer: Excel workbooks, encodings, date formats, the provisional mapping, and the SliQ-specific traps (part-paid
 * invoices that read "Unpaid", credit-note allocations, percentage discounts, prefixed numbers with leading zeros).
 * Synthetic fixtures only.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dryRun, writeRun } from "../../scripts/sliq-import/cli.mjs";
import { decodeBytes, detectDateFormat, detectEncoding } from "../../scripts/sliq-import/detect.mjs";
import { GuardError, assertWriteAllowed } from "../../scripts/sliq-import/guard.mjs";
import { legacyId } from "../../scripts/sliq-import/ids.mjs";
import { loadFolder, readWorkbooks } from "../../scripts/sliq-import/load.mjs";
import { MappingError, getProfile } from "../../scripts/sliq-import/mapping.mjs";
import { analyse, renderMarkdown } from "../../scripts/sliq-import/reconcile.mjs";
import { buildXlsx } from "../support/make-xlsx.mjs";

const FIX = path.resolve(__dirname, "../fixtures/sliq");
const BASIC = path.join(FIX, "basic");
const PROV = path.join(FIX, "provisional");
const XLSX = path.join(FIX, "xlsx");
const ORG = "11111111-2222-4333-8444-555555555555";
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const tmp = (p = "sliq-fmt-") => mkdtempSync(path.join(tmpdir(), p));
const nums = (xs: { number: string }[]) => xs.map((x) => x.number).sort();

/** A copy of the provisional SliQ mapping marked confirmed (what the file would look like after a real check). */
function confirmedMapping(extra: Record<string, unknown> = {}) {
  const raw = JSON.parse(readFileSync(path.resolve(__dirname, "../../scripts/sliq-import/mappings/sliq.json"), "utf8"));
  const file = path.join(tmp("sliq-map-"), "confirmed.json");
  writeFileSync(file, JSON.stringify({ ...raw, status: "confirmed", confirmed: true, ...extra }));
  return file;
}

describe("Excel workbooks", () => {
  it("reads several worksheets, matches each to a kind by its headers, and lists the ones that match nothing", async () => {
    const wb = await readWorkbooks(XLSX);
    expect(wb).toHaveLength(1);
    expect(wb[0].sheets.map((s: { name: string }) => s.name)).toEqual(["Summary", "Sales Invoices", "Customer List", "Receipts"]);
    const loaded = loadFolder(XLSX, getProfile("sliq"), { workbooks: wb, sheets: { customers: "Customer List" } });
    expect(loaded.inputs.map((i: { kind: string; sheet: string }) => [i.kind, i.sheet]).sort()).toEqual([["customers", "Customer List"], ["invoices", "Sales Invoices"], ["payments", "Receipts"]]);
    expect(loaded.unmatchedSheets.map((s: { sheet: string }) => s.sheet)).toEqual(["Summary"]);
    expect(loaded.inputs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // identifiers stored as text keep their prefix and leading zeros; date cells are real dates
    expect(loaded.records.invoices.map((r: { number: string }) => r.number)).toEqual(["INV-00123", "00045"]);
    expect(loaded.records.invoices[0]).toMatchObject({ date: "2026-03-05", dueDate: "2026-04-04", net: 10000, status: "sent", statusRaw: "Unpaid" });
    expect(loaded.records.payments[0]).toMatchObject({ date: "2026-03-10", amount: 4000 });
  });

  it("stops when a worksheet could be two kinds, until --sheet says which", async () => {
    const wb = await readWorkbooks(XLSX);
    expect(() => loadFolder(XLSX, getProfile("sliq"), { workbooks: wb })).toThrowError(/worksheet "Customer List" has the headers of customers and suppliers: say which with --sheet/);
    expect(() => loadFolder(XLSX, getProfile("sliq"), { workbooks: wb, sheets: { customers: "No Such Sheet" } })).toThrowError(/no such worksheet/);
    expect(() => loadFolder(XLSX, getProfile("sliq"), { workbooks: wb, sheets: { customers: "Customer List", suppliers: "Customer List" } })).not.toThrow();
  });

  it("a dry run on a workbook writes a report that names the sheets and has no CSV encoding", async () => {
    const out = tmp();
    const { report } = await dryRun({ folder: XLSX, outDir: out, mapping: "sliq", sheets: { customers: "Customer List" } });
    expect(report.inputs.find((i: { kind: string }) => i.kind === "invoices")).toMatchObject({ file: "reports.xlsx", sheet: "Sales Invoices", rows: 2 });
    expect(report.formats.encoding.perFile).toEqual([]);
    expect(readFileSync(path.join(out, "report.md"), "utf8")).toContain("Worksheets matched to nothing");
  });

  it("refuses an identifier stored as a numeric cell (00045 would become 45) and a fraction VAT rate", async () => {
    const dir = tmp();
    cpSync(path.join(PROV, "customers.csv"), path.join(dir, "customers.csv"));
    writeFileSync(
      path.join(dir, "ledger.xlsx"),
      buildXlsx([{ name: "Invoices", rows: [["Number", "Customer", "Invoice Date", "Net", "VAT", "Gross", "Status"], [45, "North Plate Ltd", { date: "2026-03-20" }, 100, 20, 120, "Unpaid"]] }]),
    );
    expect(() => loadFolder(dir, getProfile("sliq"), { workbooks: [], encoding: "windows-1252" })).toThrowError(MappingError); // no invoices at all
    const wbs = await readWorkbooks(dir);
    expect(() => loadFolder(dir, getProfile("sliq"), { workbooks: wbs, encoding: "windows-1252" })).toThrowError(/1 identifier\(s\) are numeric spreadsheet cells[\s\S]*row 2, column "Number": 45[\s\S]*Export document numbers[\s\S]*as text/);
    // a text cell keeps its zeros and is accepted
    writeFileSync(path.join(dir, "ledger.xlsx"), buildXlsx([{ name: "Invoices", rows: [["Number", "Customer", "Invoice Date", "Net", "VAT", "Gross", "Status"], ["00045", "North Plate Ltd", { date: "2026-03-20" }, 100, 20, 120, "Unpaid"]] }]));
    const ok = loadFolder(dir, getProfile("sliq"), { workbooks: await readWorkbooks(dir), encoding: "windows-1252" });
    expect(ok.records.invoices[0].number).toBe("00045");
    writeFileSync(path.join(dir, "lines.xlsx"), buildXlsx([{ name: "Detail", rows: [["Document Number", "Description", "Quantity", "Unit Price", "VAT Rate"], ["00045", "Plate", 1, 100, 0.2]] }]));
    const frac = loadFolder(dir, getProfile("sliq"), { workbooks: await readWorkbooks(dir), encoding: "windows-1252" });
    expect(frac.errors).toEqual([expect.objectContaining({ column: "VAT Rate", message: expect.stringContaining("fraction") })]);
  });
});

describe("encoding", () => {
  it("detects ASCII, UTF-8, UTF-8 with BOM, UTF-16 and Windows-1252", () => {
    expect(detectEncoding(Buffer.from("plain"))).toBe("ascii");
    expect(detectEncoding(Buffer.from("Müller £"))).toBe("utf-8");
    expect(detectEncoding(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]))).toBe("utf-8-bom");
    expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe("utf-16le");
    expect(detectEncoding(Buffer.from([0x43, 0x6f, 0x73, 0x74, 0x20, 0xa3, 0x35]))).toBe("windows-1252");
    expect(decodeBytes(Buffer.from([0x43, 0x6f, 0x73, 0x74, 0x20, 0xa3, 0x35]), "windows-1252")).toBe("Cost £5");
  });

  it("reads a Windows-1252 file with a pound sign correctly and reports what it detected", () => {
    const loaded = loadFolder(PROV, getProfile("sliq"));
    expect(loaded.records.customers[0]).toMatchObject({ name: "Müller Fabrications Ltd", contact: "Hans Müller", notes: "Credit limit £5000" });
    expect(loaded.formats.encoding.perFile.find((e: { file: string }) => e.file === "customers.csv")).toEqual({ file: "customers.csv", detected: "windows-1252", used: "windows-1252" });
    expect(loaded.formats.encoding.confirmed).toBeNull();
  });

  it("a confirmed encoding that cannot decode the file stops the run", () => {
    expect(() => loadFolder(PROV, getProfile("sliq"), { encoding: "utf-8" })).toThrowError(/customers\.csv cannot be decoded as utf-8 \(the confirmed encoding\)[\s\S]*Detected: windows-1252/);
  });
});

describe("date format", () => {
  it("proposes a format from the data", () => {
    expect(detectDateFormat(["13/03/2026", "01/02/2026"])).toMatchObject({ format: "DD/MM/YYYY", ambiguous: false });
    expect(detectDateFormat(["03/13/2026", "01/02/2026"])).toMatchObject({ format: "MM/DD/YYYY", ambiguous: false });
    expect(detectDateFormat(["2026-03-13"])).toMatchObject({ format: "YYYY-MM-DD", ambiguous: false });
    expect(detectDateFormat(["01/02/2026", "03/04/2026", "12/12/2025"])).toMatchObject({ format: "DD/MM/YYYY", ambiguous: true });
    expect(detectDateFormat(["13/03/2026", "03/13/2026"]).format).toBeNull();
    expect(detectDateFormat(["13/03/2026", "2026-03-13"]).conflict).toMatch(/mixed/);
    expect(detectDateFormat([])).toMatchObject({ format: null, ambiguous: false });
  });

  const ambiguousFolder = () => {
    const dir = tmp();
    cpSync(PROV, dir, { recursive: true });
    for (const f of ["invoices.csv", "payments.csv", "quotes.csv"]) {
      writeFileSync(path.join(dir, f), readFileSync(path.join(dir, f), "utf8").replace(/(\d\d)\/(\d\d)\/2026/g, (_m, d: string, mo: string) => `${String(Number(d) % 12 || 12).padStart(2, "0")}/${mo}/2026`));
    }
    return dir;
  };

  it("when every day is 12 or less it will not guess, even for a dry run, until --date-format is given", () => {
    const dir = ambiguousFolder();
    expect(() => loadFolder(dir, getProfile("sliq"), { encoding: "windows-1252" })).toThrowError(/dates are ambiguous[\s\S]*--date-format explicitly, even for a dry run/i);
    const ok = loadFolder(dir, getProfile("sliq"), { encoding: "windows-1252", dateFormat: "DD/MM/YYYY" });
    expect(ok.formats.dateFormat).toMatchObject({ detected: "DD/MM/YYYY", ambiguous: true, confirmed: "DD/MM/YYYY", used: "DD/MM/YYYY" });
    const us = loadFolder(dir, getProfile("sliq"), { encoding: "windows-1252", dateFormat: "MM/DD/YYYY" });
    expect(us.records.invoices[0].date).not.toBe(ok.records.invoices[0].date);
  });

  it("an unambiguous detection is used for a dry run but is not a confirmation", () => {
    const loaded = loadFolder(PROV, getProfile("sliq"));
    expect(loaded.formats.dateFormat).toMatchObject({ detected: "DD/MM/YYYY", ambiguous: false, confirmed: null, used: "DD/MM/YYYY" });
  });
});

describe("write confirmation of format and mapping", () => {
  const prep = (mapping: string, opts: Record<string, unknown> = {}) => {
    const loaded = loadFolder(PROV, getProfile(mapping), opts);
    const current = analyse(loaded, { organizationId: ORG }).report;
    const report = { ...current, collisions: { ...current.collisions, checked: true }, rehearsal: { checked: true, id: "99999999-aaaa-4bbb-8ccc-dddddddddddd" } };
    return { current, report };
  };
  const allow = (p: { current: unknown; report: unknown }) => assertWriteAllowed({ write: true, databaseUrl: LOCAL, organizationId: ORG, report: p.report, current: p.current, excludeNumbers: [] });

  it("refuses the provisional sliq mapping", () => {
    expect(() => allow(prep("sliq", { encoding: "windows-1252", dateFormat: "DD/MM/YYYY" }))).toThrowError(/provisional mapping, confirm against the real headers/);
  });

  it("a confirmed mapping still needs the encoding and date format confirmed, and equal to what was detected", () => {
    expect(() => allow(prep(confirmedMapping()))).toThrowError(/encoding is not confirmed \(detected windows-1252, ascii\)/);
    expect(() => allow(prep(confirmedMapping({ encoding: "windows-1252" })))).toThrowError(/date format is not confirmed/);
    const ok = prep(confirmedMapping({ encoding: "windows-1252", dateFormat: "DD/MM/YYYY" }));
    // INV-00045 needs review (a 10% discount), so exclude it for the success path
    expect(() => allow(ok)).toThrowError(/discounts are unresolved: 00045/);
    const loaded = loadFolder(PROV, getProfile(confirmedMapping({ encoding: "windows-1252", dateFormat: "DD/MM/YYYY" })));
    const current = analyse(loaded, { organizationId: ORG, excludeNumbers: ["00045"] }).report;
    expect(assertWriteAllowed({ write: true, databaseUrl: LOCAL, organizationId: ORG, report: { ...current, collisions: { ...current.collisions, checked: true }, rehearsal: { checked: true, id: "99999999-aaaa-4bbb-8ccc-dddddddddddd" } }, current, excludeNumbers: ["00045"] })).toMatchObject({ host: "127.0.0.1" });
    // a confirmation that disagrees with the detection
    const wrongEnc = { ...current, collisions: { checked: true }, formats: { ...current.formats, encoding: { ...current.formats.encoding, confirmed: "utf-8" } } };
    expect(() => assertWriteAllowed({ write: true, databaseUrl: LOCAL, organizationId: ORG, report: wrongEnc, current: wrongEnc, excludeNumbers: ["00045"] })).toThrowError(/confirmed encoding utf-8 does not match what was detected \(customers\.csv: windows-1252/);
    const wrongDate = { ...current, collisions: { checked: true }, formats: { ...current.formats, dateFormat: { ...current.formats.dateFormat, confirmed: "MM/DD/YYYY", used: "MM/DD/YYYY" } } };
    expect(() => assertWriteAllowed({ write: true, databaseUrl: LOCAL, organizationId: ORG, report: wrongDate, current: wrongDate, excludeNumbers: ["00045"] })).toThrowError(/confirmed date format MM\/DD\/YYYY does not match what was detected \(DD\/MM\/YYYY\)/);
  });

  it("writeRun on the provisional mapping refuses before it connects", async () => {
    const out = tmp();
    await dryRun({ folder: PROV, outDir: out, mapping: "sliq", databaseUrl: null, organizationId: ORG, excludeNumbers: ["00045"], encoding: "windows-1252", dateFormat: "DD/MM/YYYY" });
    const rep = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"));
    writeFileSync(path.join(out, "report.json"), JSON.stringify({ ...rep, collisions: { ...rep.collisions, checked: true } }));
    await expect(writeRun({ folder: PROV, reportPath: path.join(out, "report.json"), mapping: "sliq", databaseUrl: LOCAL, organizationId: ORG, excludeNumbers: ["00045"], write: true, encoding: "windows-1252", dateFormat: "DD/MM/YYYY" })).rejects.toThrow(GuardError);
    await expect(writeRun({ folder: PROV, reportPath: path.join(out, "report.json"), mapping: "sliq", databaseUrl: LOCAL, organizationId: ORG, excludeNumbers: ["00045"], write: true, encoding: "windows-1252", dateFormat: "DD/MM/YYYY" })).rejects.toThrowError(/provisional mapping/);
  });

  it("the report carries the provisional notice and the 'not in the export' note", () => {
    const { report } = analyse(loadFolder(PROV, getProfile("sliq")));
    const md = renderMarkdown(report);
    expect(report.provisionalNotice).toBe("Provisional mapping, confirm against the real headers.");
    expect(md).toContain("Provisional mapping, confirm against the real headers.");
    expect(md).toMatch(/PDFs of invoices and quotes, attachments.*do not export from SliQ/);
    expect(md).toContain("NOT CONFIRMED");
  });
});

describe("SliQ traps", () => {
  const prov = () => analyse(loadFolder(PROV, getProfile("sliq")), { organizationId: ORG });

  it("never trusts the status word for payment: 'Unpaid' with a payment is PARTIAL, 'Paid' needs a payment record", () => {
    const { report } = prov();
    const by = Object.fromEntries(report.balances.items.map((b: { number: string }) => [b.number, b]));
    expect(by["INV-000123"]).toMatchObject({ state: "PARTIAL", paid: 10000, balance: 14000, statusWord: "Unpaid", exception: false });
    expect(report.balances.partial.map((b: { number: string }) => b.number)).toEqual(["INV-000123"]);
    expect(by["INV-000124"]).toMatchObject({ state: "paid", statusWord: "Paid" });
    expect(by["00045"]).toMatchObject({ state: "unpaid", exception: false }); // no payment record: owed in full
    expect(report.balances.statusWordConflicts).toEqual([expect.objectContaining({ number: "INV-000123", statusWord: "Unpaid", fromPayments: "PARTIAL" })]);

    const dir = tmp();
    cpSync(PROV, dir, { recursive: true });
    writeFileSync(path.join(dir, "payments.csv"), "Invoice Number,Date,Amount,Method,Reference\nINV-000123,15/03/2026,100.00,BACS,PART1\n");
    const r2 = analyse(loadFolder(dir, getProfile("sliq")), { organizationId: ORG }).report;
    const paidNoPay = r2.balances.items.find((b: { number: string }) => b.number === "INV-000124");
    // the word "Paid" proves nothing, and with no payment record it contradicts the payments file: the write stops until it is fixed
    expect(paidNoPay).toMatchObject({ state: "exception", exception: true, statusWord: "Paid", reason: expect.stringContaining('"Paid" says paid but the payment records add up to £0.00') });
    expect(r2.unresolvedPaymentCount).toBe(1);
  });

  it("plan: evidenced part payment is written, the rest stays unverified", () => {
    const { plan } = analyse(loadFolder(PROV, getProfile("sliq")), { organizationId: ORG, excludeNumbers: ["00045"] });
    const by = Object.fromEntries(plan.invoices.map((i: { number: string }) => [i.number, i]));
    expect(by["INV-000123"].final).toMatchObject({ status: "partial", amountPaid: 10000, unverified: false });
    expect(by["INV-000123"].payments).toHaveLength(1);
    expect(by["INV-000124"].final).toMatchObject({ status: "paid", amountPaid: 12000, paidAt: "2026-03-22" });
    expect(by["00045"]).toBeUndefined(); // excluded
  });

  it("keeps document numbers as text exactly as given and compares collisions exactly", () => {
    const { report } = prov();
    expect(report.balances.items.map((b: { number: string }) => b.number)).toEqual(["INV-000123", "00045", "INV-000124"]);
    expect(legacyId(ORG, "invoices", "00045")).not.toBe(legacyId(ORG, "invoices", "45"));
    const target = {
      invoices: new Map([["45", "uuid-1"], ["inv-000123", "uuid-2"], ["00045", "uuid-3"]]),
      quotes: new Map(), purchaseOrders: new Map(), stock: new Map(), customerNames: new Map(), supplierNames: new Map(),
      mapped: { invoices: new Map(), quotes: new Map(), purchaseOrders: new Map(), stock: new Map() },
    };
    const rep = analyse(loadFolder(PROV, getProfile("sliq")), { organizationId: ORG, target }).report;
    expect(nums(rep.collisions.invoices)).toEqual(["00045"]); // "45" and "inv-000123" are different text
  });

  it("flags a percentage discount, an absolute discount and a separate discount item, and ignores zero discounts", () => {
    const { report } = prov();
    expect(report.needsReview).toEqual([expect.objectContaining({ number: "00045", reasons: [expect.objectContaining({ code: "discount", detail: expect.stringContaining('"10%"') })] })]);
    const dir = tmp();
    cpSync(PROV, dir, { recursive: true });
    writeFileSync(path.join(dir, "invoice-lines.csv"), "Document Number,Description,Quantity,Unit Price,VAT Rate,Discount\nINV-000123,Bracket,10,20.00,20,5.00\n00045,Plate,1,100.00,20,0%\nINV-000124,Frame,1,100.00,20,0.00\nINV-000124,Carriage discount,1,0.00,20,\n");
    const r2 = analyse(loadFolder(dir, getProfile("sliq")), { organizationId: ORG }).report;
    const flagged = Object.fromEntries(r2.needsReview.map((n: { number: string; reasons: { detail: string }[] }) => [n.number, n.reasons.map((x) => x.detail).join(";")]));
    expect(Object.keys(flagged).sort()).toEqual(["INV-000123", "INV-000124"]);
    expect(flagged["INV-000123"]).toContain('"5.00"');
    expect(flagged["INV-000124"]).toContain("reads as a discount");
    // nothing was applied: the header and the lines are exactly as stated
    const p = analyse(loadFolder(dir, getProfile("sliq")), { organizationId: ORG, excludeNumbers: ["INV-000123", "INV-000124"] }).plan;
    expect(p.invoices.map((i: { number: string }) => i.number)).toEqual(["00045"]);
    expect(p.invoices[0].lines).toEqual([{ position: 0, description: "Plate", quantityMilli: 1000, unitPence: 10000, vatCenti: 2000 }]);
  });
});

describe("credit-note allocations", () => {
  const r = analyse(loadFolder(BASIC, getProfile("synthetic")), { organizationId: ORG, excludeNumbers: ["S1011", "S1012", "Q2004"] });

  it("lists allocations with the credit notes and never as payments", () => {
    expect(r.report.allocations).toEqual([
      expect.objectContaining({ creditNote: "CN-001", invoice: "S1003", amount: 2400, status: "ok" }),
      expect.objectContaining({ creditNote: "CN-002", invoice: "S9998", amount: 1000, status: "invoice not found" }),
    ]);
    const cn1 = r.report.creditNotes.find((c: { number: string }) => c.number === "CN-001");
    expect(cn1).toMatchObject({ allocated: 2400, allocations: [{ invoice: "S1003", amount: 2400, status: "ok" }], written: false });
    expect(r.report.missingRelationships.allocationsWithoutDocument.map((a: { creditNote: string }) => a.creditNote)).toEqual(["CN-002"]);
    expect(renderMarkdown(r.report)).toContain("never cash, never a payment row");
    expect(r.report.counts.payments).toBe(7);
    expect(r.plan.invoices.flatMap((i: { payments: unknown[] }) => i.payments)).toHaveLength(5); // unchanged by the allocation (S1006 overpaid is paid)
  });

  it("an invoice touched by an allocation is an exception that stops the write, not settled by it", () => {
    const b = r.report.balances.items.find((x: { number: string }) => x.number === "S1003");
    expect(b).toMatchObject({ allocated: 2400, exception: true, state: "exception" });
    expect(r.report.balances.exceptions.find((x: { number: string }) => x.number === "S1003").blocksWrite).toBe(true);
    expect(b.reason).toContain("an allocation is not cash");
    const inv = r.plan.invoices.find((i: { number: string }) => i.number === "S1003");
    expect(inv.final).toMatchObject({ status: "sent", amountPaid: 0, paidAt: null, unverified: true });
  });

  it("allocation pointing at a part-paid invoice withholds its cash payments rather than guessing the balance", () => {
    const dir = tmp();
    cpSync(BASIC, dir, { recursive: true });
    writeFileSync(path.join(dir, "allocations.csv"), "Credit No,Invoice No,Amount,Date\nCN-001,S1002,24.00,21/03/2026\n");
    const rep = analyse(loadFolder(dir, getProfile("synthetic")), { organizationId: ORG, excludeNumbers: ["S1011", "S1012", "Q2004"] });
    const s1002 = rep.plan.invoices.find((i: { number: string }) => i.number === "S1002");
    expect(s1002.payments).toEqual([]);
    expect(s1002.final.unverified).toBe(true);
    expect(rep.report.balances.exceptions.map((e: { number: string }) => e.number)).toContain("S1002");
  });
});

describe("suppliers, products, purchase orders and quote lines", () => {
  const { report, plan } = analyse(loadFolder(BASIC, getProfile("synthetic")), { organizationId: ORG, excludeNumbers: ["S1011", "S1012", "Q2004"] });

  it("suppliers are written like customers; only products with a Stock figure are stock items", () => {
    expect(report.writePlan).toMatchObject({ suppliers: 2, stockItems: 1 });
    expect(plan.suppliers.map((s: { name: string }) => s.name)).toEqual(["Steel Supplies Ltd", "Tooling Co"]);
    expect(report.products.notWritten).toEqual([expect.objectContaining({ code: "P002", reason: expect.stringContaining("price-list item") })]);
    expect(plan.stock).toEqual([expect.objectContaining({ code: "P001", stock: 40, unitPrice: 1000 })]);
  });

  it("purchase orders: header only; those that cannot be written are listed with the reason", () => {
    expect(report.purchaseOrders).toMatchObject({ read: 3, written: 1 });
    expect(report.purchaseOrders.notWritten.map((p: { number: string; reasons: string[] }) => [p.number, p.reasons.join()])).toEqual([
      ["PO-0002", "supplier unmatched: no record has this account or name (see the ambiguity report)"],
      ["PO-0003", expect.stringContaining("status not in the source")],
    ]);
    expect(plan.purchaseOrders).toEqual([expect.objectContaining({ number: "PO-0001", supplierName: "Steel Supplies Ltd", status: "sent", total: 25000 })]);
  });

  it("a quote keeps its source date and gets its lines from the same detail report", () => {
    const q = plan.quotes.find((x: { number: string }) => x.number === "Q2001");
    expect(q).toMatchObject({ date: "2026-02-01" });
    expect(q.lines).toEqual([{ position: 0, description: "Fabrication", quantityMilli: 2000, unitPence: 10000, vatCenti: 2000 }]);
    expect(report.documentAmounts.mismatches.filter((m: { number: string }) => m.number === "Q2001")).toEqual([]);
  });
});
