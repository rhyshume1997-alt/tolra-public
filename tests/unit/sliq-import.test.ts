/**
 * SliQ importer groundwork (PR B): mapping, strict parsing, every reconciliation list and the write-mode guard. Synthetic
 * fixtures only (tests/fixtures/sliq); no database is touched here (the database suite covers the write).
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dryRun, writeRun } from "../../scripts/sliq-import/cli.mjs";
import { GuardError, PROD_REF, assertWriteAllowed, checkDatabaseUrl } from "../../scripts/sliq-import/guard.mjs";
import { legacyId } from "../../scripts/sliq-import/ids.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { loadResolutions } from "../../scripts/sliq-import/resolutions.mjs";
import { MappingError, getProfile } from "../../scripts/sliq-import/mapping.mjs";
import { ParseError, parseCsv, parseDate, parseMoneyPence, parsePercentCenti, parseQuantityMilli } from "../../scripts/sliq-import/parse.mjs";
import { analyse, renderMarkdown } from "../../scripts/sliq-import/reconcile.mjs";

const FIXTURE = path.resolve(__dirname, "../fixtures/sliq/basic");
const ORG = "11111111-2222-4333-8444-555555555555";
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const RES = path.resolve(__dirname, "../fixtures/sliq/basic-resolutions.json");
const REHEARSAL = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
// Reverse charge and discount (needs review), then what else stops a write in the basic fixture: S1003 (a credit-note allocation)
// and S1016 (an undated payment) are payment exceptions; S1008, Q2003 and PO-0002 name a customer or supplier that is not in the files.
const REVIEW = ["S1011", "S1012", "Q2004"];
const BLOCKERS = ["S1003", "S1016", "S1008", "Q2003", "PO-0002"];
const EXCL = [...REVIEW, ...BLOCKERS];

function copyFixture(edit?: (file: string, text: string) => string) {
  const dir = mkdtempSync(path.join(tmpdir(), "sliq-unit-"));
  cpSync(FIXTURE, dir, { recursive: true });
  if (edit) {
    for (const f of ["customers", "invoices", "quotes", "invoice-lines", "payments", "credit-notes", "products"]) {
      const p = path.join(dir, `${f}.csv`);
      writeFileSync(p, edit(`${f}.csv`, readFileSync(p, "utf8")));
    }
  }
  return dir;
}
const synthetic = getProfile("synthetic");
const analyseFixture = (opts = {}) => analyse(loadFolder(FIXTURE, synthetic), opts).report;
const numbers = (xs: { number: string }[]) => xs.map((x) => x.number).sort();

describe("mapping", () => {
  it("stops with a list when a required column is missing, and writes nothing", () => {
    const dir = copyFixture((f, t) => (f === "invoices.csv" ? t.replace("Gross", "Total") : t));
    let err: unknown;
    try {
      loadFolder(dir, synthetic);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MappingError);
    expect((err as MappingError).message).toContain('column "Gross" (for "gross") is not in the file');
    expect((err as MappingError).problems).toHaveLength(1);
  });

  it("lists every missing column and a missing required file together", () => {
    const dir = copyFixture((f, t) => (f === "customers.csv" ? t.replace("Name", "Full name") : f === "payments.csv" ? t.replace("Amount", "Sum") : t));
    expect(() => loadFolder(dir, synthetic)).toThrowError(/"Name".*\n.*"Amount"|"Amount".*\n.*"Name"|Name[\s\S]*Amount/);
    const empty = mkdtempSync(path.join(tmpdir(), "sliq-empty-"));
    expect(() => loadFolder(empty, synthetic)).toThrowError(/required file customers\.csv[^\n]*was not found[\s\S]*required file invoices\.csv[^\n]*was not found/);
  });

  it("a stub mapping stops: nothing is guessed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sliq-stub-"));
    writeFileSync(path.join(dir, "stub.json"), JSON.stringify({ id: "stub", status: "stub", files: {} }));
    expect(getProfile(path.join(dir, "stub.json")).isStub).toBe(true);
    expect(() => loadFolder(FIXTURE, getProfile(path.join(dir, "stub.json")))).toThrowError(/STUB[\s\S]*no source column is mapped to "number"/);
  });

  it("the sliq mapping is provisional, not a stub: it says so and is not confirmed", () => {
    const p = getProfile("sliq");
    expect(p).toMatchObject({ status: "provisional", isStub: false, isProvisional: true, confirmed: false });
    // the synthetic fixtures do not have SliQ's headers: the stop message carries the provisional notice
    expect(() => loadFolder(FIXTURE, p)).toThrowError(/Provisional mapping, confirm against the real headers[\s\S]*Company Name/);
  });

  it("matches headers by name, ignoring case and extra spaces, and lists unmapped columns", () => {
    const dir = copyFixture((f, t) => {
      if (f !== "customers.csv") return t;
      const [head, ...rows] = t.trimEnd().split("\n");
      const h = head.replace("Name,Contact", "  NAME ,Contact").replace("Email,", "e-mail  ,");
      return [`${h},Extra Col`, ...rows.map((r) => `${r},x`)].join("\n") + "\n";
    });
    // "Email" is now spelt "e-mail" (not the mapped name), so that optional column is absent; "Extra Col" is unknown
    const loaded = loadFolder(dir, synthetic);
    const c = loaded.inputs.find((i: { kind: string }) => i.kind === "customers");
    expect(c.unmappedColumns).toEqual(expect.arrayContaining(["e-mail", "Extra Col"]));
    expect(c.optionalColumnsMissing).toContain("email");
    expect(loaded.records.customers[0].name).toBe("Alpha Fabrications Ltd");
  });

  it("refuses an unknown status word instead of guessing it", () => {
    const dir = copyFixture((f, t) => (f === "invoices.csv" ? t.replace("S1003,Invoice,03/03/2026,02/04/2026,C001,250.00,50.00,300.00,Issued", "S1003,Invoice,03/03/2026,02/04/2026,C001,250.00,50.00,300.00,Pending") : t));
    const loaded = loadFolder(dir, synthetic);
    expect(loaded.errors).toEqual([expect.objectContaining({ file: "invoices.csv", column: "Status", message: expect.stringContaining('"Pending"') })]);
    expect(analyse(loaded).report.writable).toBe(false);
  });
});

describe("money, quantity, VAT rate and date parsing", () => {
  it("parses exact pennies", () => {
    expect(parseMoneyPence("12.34")).toBe(1234);
    expect(parseMoneyPence("£1,234.50")).toBe(123450);
    expect(parseMoneyPence("1,234,567.00")).toBe(123456700);
    expect(parseMoneyPence("(12.00)")).toBe(-1200);
    expect(parseMoneyPence("-0.05")).toBe(-5);
    expect(parseMoneyPence("7")).toBe(700);
    expect(parseMoneyPence("  ")).toBeNull();
    expect(parseMoneyPence("0.1")).toBe(10);
  });

  it("refuses ambiguous or lossy formats, never rounding", () => {
    for (const bad of ["12.345", "1.234,50", "1,23", "1,234", "12.3.4", "USD 12", "1 234.50", "12,34", "abc", "1,2345.00", "--5", "£-5"]) {
      expect(() => parseMoneyPence(bad), bad).toThrow(ParseError);
    }
  });

  it("parses quantities and rates strictly", () => {
    expect(parseQuantityMilli("2.5")).toBe(2500);
    expect(() => parseQuantityMilli("1.2345")).toThrow(ParseError);
    expect(() => parseQuantityMilli("1,000")).toThrow(ParseError);
    expect(parsePercentCenti("20%")).toBe(2000);
    expect(parsePercentCenti("17.5")).toBe(1750);
    expect(() => parsePercentCenti("twenty")).toThrow(ParseError);
  });

  it("parses dates only in the stated format and only real dates", () => {
    expect(parseDate("05/03/2026", "DD/MM/YYYY")).toBe("2026-03-05");
    expect(parseDate("2026-03-05", "YYYY-MM-DD")).toBe("2026-03-05");
    expect(parseDate("", "DD/MM/YYYY")).toBeNull();
    expect(() => parseDate("03/05/26", "DD/MM/YYYY")).toThrow(ParseError);
    expect(() => parseDate("2026-03-05", "DD/MM/YYYY")).toThrow(ParseError);
    expect(() => parseDate("31/02/2026", "DD/MM/YYYY")).toThrow(ParseError);
    expect(() => parseDate("05/03/2026", "YYYY/MM/DD")).toThrow(ParseError);
    expect(parseDate("03/25/2026", "MM/DD/YYYY")).toBe("2026-03-25");
    expect(() => parseDate("25/03/2026", "MM/DD/YYYY")).toThrow(ParseError);
  });

  it("a bad value in a file is reported with file, row and column, and the report is not writable", () => {
    const dir = copyFixture((f, t) => (f === "invoices.csv" ? t.replace("600.00,Unpaid", '"6,00.00",Unpaid').replace("04/03/2026", "2026-03-04") : t));
    const loaded = loadFolder(dir, synthetic);
    expect(loaded.errors.map((e: { file: string; row: number; column: string }) => [e.file, e.row, e.column])).toEqual(expect.arrayContaining([["invoices.csv", 3, "Gross"], ["invoices.csv", 5, "Date"]]));
    expect(analyse(loaded).report.writable).toBe(false);
  });

  it("reads quoted CSV fields, embedded commas and CRLF", () => {
    const { headers, rows } = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n3,4\r\n');
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([["x, y", 'say "hi"'], ["3", "4"]]);
    expect(() => parseCsv("a,b\n1\n")).toThrow(ParseError);
  });
});

describe("checksums and counts", () => {
  it("records sha256, byte size and row count of each file", () => {
    const r = analyseFixture();
    const inv = r.inputs.find((i: { kind: string }) => i.kind === "invoices");
    const bytes = readFileSync(path.join(FIXTURE, "invoices.csv"));
    expect(inv).toMatchObject({ kind: "invoices", file: "invoices.csv", sheet: null, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, rows: 17 });
    expect(r.inputs.map((i: { kind: string }) => i.kind).sort()).toEqual(["allocations", "creditNotes", "customers", "invoiceLines", "invoices", "payments", "products", "purchaseOrders", "quotes", "suppliers"]);
    expect(r.products.read).toBe(2);
  });

  it("a changed file changes its checksum", () => {
    const dir = copyFixture((f, t) => (f === "payments.csv" ? `${t}S1003,01/03/2026,1.00,BACS,\n` : t));
    const a = analyseFixture().inputs.find((i: { kind: string }) => i.kind === "payments");
    const b = analyse(loadFolder(dir, synthetic)).report.inputs.find((i: { kind: string }) => i.kind === "payments");
    expect(b.sha256).not.toBe(a.sha256);
    expect(b.rows).toBe(a.rows + 1);
  });
});

describe("reconciliation lists", () => {
  const r = analyseFixture();

  it("duplicates: a number used twice is renamed, not dropped; the same customer by normalised name is listed", () => {
    expect(r.duplicates.documents).toEqual([]);
    expect(r.renames.map((x: { sourceNumber: string; number: string; row: number }) => [x.sourceNumber, x.number, x.row])).toEqual([["S1009", "S1009", 10], ["S1009", "S1009-B", 11]]);
    expect(r.duplicates.customers).toEqual([expect.objectContaining({ normalisedName: "alpha fabrications ltd" })]);
    expect(r.held.filter((h: { number: string }) => h.number.startsWith("S1009"))).toHaveLength(0);
  });

  it("missing relationships: customer, lines without a header, payments for unknown invoices", () => {
    expect(numbers(r.missingRelationships.invoicesWithoutCustomer)).toEqual(["S1008"]);
    expect(numbers(r.missingRelationships.quotesWithoutCustomer)).toEqual(["Q2003"]);
    expect(r.missingRelationships.orphanLines).toEqual([expect.objectContaining({ documentNumber: "S7777" })]);
    expect(r.missingRelationships.paymentsForUnknownInvoice).toEqual([expect.objectContaining({ invoiceNumber: "S8888" })]);
  });

  it("amounts: lines against the stated header, header kept as stated", () => {
    expect(r.documentAmounts.mismatches.map((m: { number: string; field: string }) => `${m.number}:${m.field}`)).toEqual(["S1010:net", "S1010:vat", "S1010:gross"]);
    const net = r.documentAmounts.mismatches[0];
    expect(net).toMatchObject({ stated: 10000, fromLines: 9000, difference: 1000 });
  });

  it("balances: paid, an explicit PARTIAL list, unpaid and overpaid", () => {
    const by = Object.fromEntries(r.balances.items.map((b: { number: string; state: string }) => [b.number, b]));
    expect(by.S1001.state).toBe("paid");
    expect(by.S1004.state).toBe("paid");
    expect(by.S1005.state).toBe("unpaid");
    expect(by.S1003.state).toBe("exception"); // a credit-note allocation touches it
    expect(by.S1006.state).toBe("overpaid");
    expect(r.balances.partial).toEqual([expect.objectContaining({ number: "S1002", gross: 60000, paid: 20000, balance: 40000, payments: 2, exception: false })]);
    expect(r.balances.customerCredit).toEqual([expect.objectContaining({ number: "S1006", gross: 12000, paid: 15000, credit: 3000 })]);
    expect(r.balances.summary.PARTIAL).toBe(1);
  });

  it("no Payment to confirm: evidence that disagrees is an exception that stops the write, never invented", () => {
    expect(r.balances.exceptions.map((e: { number: string; blocksWrite: boolean }) => [e.number, e.blocksWrite])).toEqual([["S1003", true], ["S1016", true]]);
    expect(r.balances.exceptions.find((b: { number: string }) => b.number === "S1016").reason).toMatch(/no date/);
    expect(r.unresolvedPaymentCount).toBe(2);
    expect(r.writePlan.payments).toBe(5); // S1001 x1, S1002 x2, S1004 x1, S1006 x1 (overpaid: paid, the surplus is credit)
    const ok = analyseFixture({ excludeNumbers: EXCL });
    expect(ok.unresolvedPaymentCount).toBe(0);
    expect(ok.writePlan.invoicesPaymentToConfirm).toBe(0);
    // owed straight after the import: S1005 96.00 + S1007 48.00 + S1009 12.00 + S1009-B 12.00 + S1010 120.00 + S1002's 400.00 balance
    expect(ok.balances.owedAfterImport).toBe(68800);
    expect(ok.balances.creditAfterImport).toBe(3000);
  });

  it("a header that says paid with no payment record is an exception that stops the write", () => {
    const dir = copyFixture((f, t) => (f === "payments.csv" ? t.replace("S1001,05/03/2026,120.00,BACS,REF1\n", "") : t));
    const rep = analyse(loadFolder(dir, synthetic)).report;
    const b = rep.balances.exceptions.find((x: { number: string }) => x.number === "S1001");
    expect(b).toMatchObject({ blocksWrite: true, reason: expect.stringMatching(/£120.00 paid but there are no payment records/) });
  });

  it("without a payments file balances are unknown, not unpaid", () => {
    const dir = copyFixture();
    writeFileSync(path.join(dir, "payments.csv"), "x\n");
    const loaded = loadFolder(FIXTURE, synthetic);
    loaded.inputs = loaded.inputs.filter((i: { kind: string }) => i.kind !== "payments");
    const rep = analyse(loaded).report;
    expect(rep.balances.summary.unknown).toBeGreaterThan(0);
    expect(rep.balances.summary.unpaid).toBe(0);
    // without payments no balance is known: every issued invoice that would be written stops the write
    expect(rep.unresolvedPaymentCount).toBe(rep.balances.items.filter((b: { state: string; held: boolean }) => b.state === "unknown" && !b.held).length);
    expect(rep.unresolvedPaymentCount).toBeGreaterThan(0);
  });

  it("credit notes are listed with how each would be represented, never netted", () => {
    const cn = Object.fromEntries(r.creditNotes.map((c: { number: string }) => [c.number, c]));
    expect(Object.keys(cn).sort()).toEqual(["CN-001", "CN-002", "CN-003", "S1015"]);
    expect(cn["CN-001"]).toMatchObject({ linkedInvoice: "S1001", proposedGross: -2400, written: false });
    expect(cn["CN-002"]).toMatchObject({ linkedInvoice: null, link: expect.stringContaining("no invoice reference") });
    expect(cn["CN-003"].link).toContain("S9999 not found");
    expect(cn.S1015.source).toContain("negative total");
    expect(r.balances.items.some((b: { number: string }) => b.number === "CN-001")).toBe(false);
    expect(r.writePlan.invoices).toBe(12);
  });

  it("invoices missing lines are listed and keep their stated header", () => {
    expect(numbers(r.invoicesMissingLines)).toEqual(["S1005", "S1008", "S1009", "S1009-B"]);
    expect(r.invoicesMissingLines.find((x: { number: string }) => x.number === "S1009-B").note).toMatch(/SliQ number S1009, which 2 invoices share: header only/);
    expect(r.invoicesMissingLines.find((x: { number: string }) => x.number === "S1005").gross).toBe(9600);
  });

  it("unresolved VAT: a line with no rate or amount, and a document whose lines disagree with the header", () => {
    expect(r.unresolvedVat).toEqual([
      expect.objectContaining({ kind: "line", number: "S1007", reason: "no VAT rate or amount in the source" }),
      expect.objectContaining({ kind: "document", number: "S1010" }),
    ]);
  });

  it("collisions are 'not checked' without a database, and found when a target is read", () => {
    expect(r.collisions).toMatchObject({ checked: false, status: "not checked" });
    const loaded = loadFolder(FIXTURE, synthetic);
    const target = {
      invoices: new Map([["S1001", "uuid-existing"], ["S1002", "uuid-own"]]),
      quotes: new Map([["Q2001", "uuid-q"]]),
      purchaseOrders: new Map([["PO-0001", "uuid-po"]]),
      stock: new Map([["P001", "uuid-sku"]]),
      customerNames: new Map([["beta engineering ltd", ["Beta Engineering Ltd"]]]),
      supplierNames: new Map(),
      mapped: { invoices: new Map([[String(legacyId(ORG, "invoices", "S1002")), "uuid-own"]]), quotes: new Map(), purchaseOrders: new Map(), stock: new Map() },
    };
    const rep = analyse(loaded, { organizationId: ORG, target }).report;
    expect(rep.collisions.checked).toBe(true);
    expect(numbers(rep.collisions.invoices)).toEqual(["S1001"]); // S1002 was created by an earlier run of this import, so it is not a collision
    expect(numbers(rep.collisions.quotes)).toEqual(["Q2001"]);
    expect(numbers(rep.collisions.purchaseOrders)).toEqual(["PO-0001"]);
    expect(numbers(rep.collisions.stock)).toEqual(["P001"]);
    expect(rep.collisions.customerReview).toHaveLength(1);
    expect(rep.held.find((h: { number: string }) => h.number === "S1001").reasons.join()).toContain("already used");
  });

  it("anything not in the source is blank and listed", () => {
    expect(r.blanks).toEqual(expect.arrayContaining([expect.objectContaining({ entity: "customers", field: "email", blank: 2 }), expect.objectContaining({ entity: "payments", field: "reference" })]));
  });

  it("the Markdown report has every section", () => {
    const md = renderMarkdown(r);
    for (const h of ["Source files", "Duplicates", "Missing relationships", "Document amounts", "Balances", "PARTIAL", "Credit notes", "Invoices missing lines", "Unresolved VAT", "Needs review", "Number collisions", "Not in the source"]) expect(md).toContain(h);
    expect(md).toContain("not checked");
  });
});

describe("reverse charge and discounts need review", () => {
  const r = analyseFixture();

  it("flags reverse-charge wording and codes, and discount lines, without touching VAT", () => {
    expect(r.needsReview.map((n: { number: string }) => n.number).sort()).toEqual(["Q2004", "S1011", "S1012"]);
    const rc = r.needsReview.find((n: { number: string }) => n.number === "S1011");
    expect(rc.reasons.map((x: { code: string }) => x.code)).toContain("reverse_charge");
    expect(rc.reasons.map((x: { detail: string }) => x.detail).join()).toMatch(/wording on the header/);
    expect(r.needsReview.find((n: { number: string }) => n.number === "S1012").reasons[0].code).toBe("discount");
    expect(r.unresolvedReviewCount).toBe(3);
  });

  it("flags a discount column, and a header lower than the lines", () => {
    const dir = copyFixture((f, t) => {
      if (f === "invoices.csv") return t.replace("S1003,Invoice,03/03/2026,02/04/2026,C001,250.00,50.00,300.00,Issued,,,,,", "S1003,Invoice,03/03/2026,02/04/2026,C001,250.00,50.00,300.00,Issued,,,,,5.00").replace("S1006,Invoice,06/03/2026,05/04/2026,C001,100.00,20.00,120.00", "S1006,Invoice,06/03/2026,05/04/2026,C001,80.00,16.00,96.00");
      return t;
    });
    const rep = analyse(loadFolder(dir, synthetic)).report;
    const reasons = (n: string) => rep.needsReview.find((x: { number: string }) => x.number === n).reasons.map((y: { detail: string }) => y.detail).join();
    expect(reasons("S1003")).toMatch(/discount on the header \("5\.00"/);
    expect(reasons("S1006")).toMatch(/lower than the lines/);
  });

  it("excluding by number removes it from the unresolved count and holds it; an unknown number is an error", () => {
    const rep = analyseFixture({ excludeNumbers: ["S1011", "S1012", "Q2004"] });
    expect(rep.unresolvedReviewCount).toBe(0);
    expect(rep.held.filter((h: { reasons: string[] }) => h.reasons.some((x) => x.includes("excluded by number"))).map((h: { number: string }) => h.number).sort()).toEqual(["Q2004", "S1011", "S1012"]);
    const bad = analyseFixture({ excludeNumbers: ["S1011", "NOPE-1"] });
    expect(bad.unknownExcludedNumbers).toEqual(["NOPE-1"]);
    expect(analyseFixture({ excludeNumbers: ["s1011"] }).unknownExcludedNumbers).toEqual(["s1011"]); // numbers are compared exactly as written
    expect(bad.writable).toBe(false);
  });
});

describe("write-mode guard", () => {
  const folder = FIXTURE;
  const base = async () => {
    const out = mkdtempSync(path.join(tmpdir(), "sliq-report-"));
    const { report } = await dryRunLocal(out);
    return { out, report };
  };
  // A report as a dry run with a checked target would write it (the unit suite has no database, so mark collisions checked).
  async function dryRunLocal(out: string, excludeNumbers: string[] = EXCL) {
    const { report } = await dryRun({ folder, outDir: out, mapping: "synthetic", excludeNumbers, resolutionsPath: RES });
    const checked = { ...report, organizationId: ORG, collisions: { ...report.collisions, checked: true }, rehearsal: { checked: true, id: REHEARSAL } };
    writeFileSync(path.join(out, "report.json"), JSON.stringify(checked));
    return { report: checked };
  }
  const current = (excludeNumbers: string[] = EXCL, dir = folder) => analyse(loadFolder(dir, synthetic), { organizationId: ORG, excludeNumbers, resolutions: loadResolutions(RES) }).report;
  const allow = (over: object = {}) => {
    const { report } = over as { report?: unknown };
    return assertWriteAllowed({ write: true, databaseUrl: LOCAL, organizationId: ORG, report, current: current(), excludeNumbers: EXCL, ...over });
  };

  it("accepts local and disposable databases", async () => {
    const { report } = await base();
    expect(allow({ report })).toMatchObject({ host: "127.0.0.1", organizationId: ORG });
    expect(checkDatabaseUrl("postgresql://u:p@db.internal:5432/quoteflow_rehearsal_2026")).toMatchObject({ database: "quoteflow_rehearsal_2026" });
    expect(checkDatabaseUrl("postgresql://u:p@localhost:5432/anything").host).toBe("localhost");
    expect(checkDatabaseUrl("postgres://u:p@10.0.0.5/disposable-copy").database).toBe("disposable-copy");
  });

  it("refuses hosted, production, JNREng and unnamed remote databases", () => {
    const refuse = (url: string, why: RegExp) => expect(() => checkDatabaseUrl(url), url).toThrowError(why);
    refuse("postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:5432/postgres", /hosted Supabase/);
    refuse("postgresql://postgres.abc:x@aws-0-eu-west-2.pooler.supabase.com:6543/postgres", /hosted Supabase/);
    refuse(`postgresql://postgres:x@db.${PROD_REF}.supabase.co:5432/postgres`, /hosted Supabase/);
    refuse(`postgresql://postgres:x@127.0.0.1:5432/${PROD_REF}`, /production project reference/);
    refuse("postgresql://postgres:x@127.0.0.1:5432/JNREng", /JNREng/);
    refuse("postgresql://postgres:x@127.0.0.1:5432/jnreng_rehearsal", /JNREng/);
    refuse("postgresql://postgres:x@127.0.0.1:5432/quoteflow-prod", /production/);
    refuse("postgresql://postgres:x@db.example.com:5432/postgres", /neither on 127\.0\.0\.1/);
    refuse("", /no target database URL/);
    refuse("mysql://root@127.0.0.1/rehearsal", /not a postgres/);
  });

  it("never prints the password", () => {
    try {
      checkDatabaseUrl("postgresql://postgres:s3cret@db.abc.supabase.co:5432/postgres");
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cret");
    }
  });

  it("refuses without --write, without an organisation, without a report", async () => {
    const { report } = await base();
    expect(() => allow({ report, write: false })).toThrowError(/dry run unless --write/);
    expect(() => allow({ report, organizationId: undefined })).toThrowError(/--organization-id/);
    expect(() => allow({ report, organizationId: "not-a-uuid" })).toThrowError(/--organization-id/);
    expect(() => allow({ report: undefined })).toThrowError(/report is required/);
    await expect(writeRun({ folder, reportPath: "/nonexistent.json", mapping: "synthetic", databaseUrl: LOCAL, organizationId: ORG, write: false })).rejects.toThrow(GuardError);
  });

  it("refuses a stale report: a file changed after the report was made", async () => {
    const { report } = await base();
    const dir = copyFixture((f, t) => (f === "invoices.csv" ? t.replace("100.00,20.00,120.00,Paid", "100.00,20.00,120.00,Issued") : t));
    expect(() => allow({ report, current: current(EXCL, dir) })).toThrowError(/report is stale[\s\S]*invoices\.csv/);
  });

  it("refuses a report made for another organisation, with different exclusions, or without a collision check", async () => {
    const { report } = await base();
    expect(() => allow({ report: { ...report, organizationId: "99999999-2222-4333-8444-555555555555" } })).toThrowError(/different organisation/);
    expect(() => allow({ report, excludeNumbers: ["S1011"] })).toThrowError(/different list of excluded/);
    expect(() => allow({ report: { ...report, collisions: { checked: false } } })).toThrowError(/did not check number collisions/);
  });

  it("refuses while reverse-charge or discount documents are unresolved and not excluded", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "sliq-report-"));
    const { report } = await dryRunLocal(out, BLOCKERS);
    expect(() => allow({ report, excludeNumbers: BLOCKERS, current: current(BLOCKERS) })).toThrowError(/unresolved: Q2004, S1011, S1012/);
    expect(() => allow({ report, excludeNumbers: ["S1011", ...BLOCKERS], current: current(["S1011", ...BLOCKERS]) })).toThrowError();
  });

  it("refuses while a customer or supplier is unmatched (decision 3), or a payment exception is left (decision 1)", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "sliq-report-"));
    const noParty = [...REVIEW, "S1003", "S1016"];
    const { report } = await dryRunLocal(out, noParty);
    expect(() => allow({ report, excludeNumbers: noParty, current: current(noParty) })).toThrowError(/3 customer or supplier match\(es\) are ambiguous or unmatched \(invoice S1008, quote Q2003, purchase_order PO-0002\)[\s\S]*ambiguity\.csv/);
    const noPay = [...REVIEW, "S1008", "Q2003", "PO-0002"];
    const r2 = await dryRunLocal(mkdtempSync(path.join(tmpdir(), "sliq-report-")), noPay);
    expect(() => allow({ report: r2.report, excludeNumbers: noPay, current: current(noPay) })).toThrowError(/payment exceptions are unresolved: S1003, S1016/);
  });

  it("refuses the stub mapping", async () => {
    const { report } = await base();
    expect(() => allow({ report, current: { ...current(), mapping: { ...current().mapping, isStub: true } } })).toThrowError(/stub/);
  });

  it("the cheap refusals happen before any file is read", async () => {
    await expect(writeRun({ folder: "/does/not/exist", reportPath: "x", mapping: "synthetic", databaseUrl: "postgresql://a:b@db.x.supabase.co/postgres", organizationId: ORG, write: true })).rejects.toThrowError(/hosted Supabase/);
  });
});
