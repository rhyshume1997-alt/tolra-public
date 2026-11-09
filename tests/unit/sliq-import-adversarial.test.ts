/**
 * Regression tests proposed by the candidate 2F red team (RT-2F Sonnet B, 23 tests, adapted: C11 now passes because an empty line in
 * the middle is refused at its own row; types tightened), plus the final-pass LOW fixes: empty lines keep row numbers, invoices
 * header-only with customers present, control characters, the 32-character invoice ref cap, and the hash / supplier cross-checks.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceTotalsFromValidated, validateAndBuild, buildSliqPayload } from "@/lib/sliq-import-build";
import { type Rpc, SliqCallError, sliqRunBatches, planSliqBatches, sortInvoices } from "@/lib/sliq-import-route";
import { isMissingImportFunction } from "@/lib/sliq-card";
import { normName } from "@/lib/sliq-reconcile/reconcile";
import { checkMapping, normaliseName, validateSliqExportWith } from "@/lib/sliq-validate/validate";
import { detectDelimiter } from "@/lib/sliq-validate/csv";
import { MAPPING, syntheticFiles } from "../support/sliq-152";

const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const baseMap = (over: Record<string, unknown> = {}, cn = false) => ({
  version: 1, confirmed: true, dateFormat: "YYYY-MM-DD",
  entities: {
    customers: { file: "c.csv", columns: { key: "Account", name: "Name" } }, suppliers: { file: "s.csv", columns: { key: "Account", name: "Name" } },
    invoices: { file: "i.csv", columns: { ref: "Ref", customerKey: "Account", date: "Date", gross: "Gross" } },
    payments: { file: "p.csv", columns: { invoiceRef: "Ref", date: "Date", amount: "Amount" } },
    ...(cn ? { creditNotes: { file: "n.csv", columns: { ref: "Credit", invoiceRef: "Ref", date: "Date", gross: "Gross", net: "Net", vat: "VAT", reason: "Reason" } } } : {}),
  }, ...over,
});
const F = (name: string, t: string) => ({ name, bytes: enc.encode(t) });
const v = (o: { c?: string; s?: string; i?: string; p?: string; n?: string }, map: unknown = baseMap({}, o.n !== undefined)) =>
  validateSliqExportWith({ files: { customers: F("c.csv", o.c ?? "Account,Name\nA1,Acme\n"), suppliers: F("s.csv", o.s ?? "Account,Name\nS1,Steel\n"),
    invoices: F("i.csv", o.i ?? "Ref,Account,Date,Gross\nINV-100,A1,2026-01-10,100.00\n"), payments: F("p.csv", o.p ?? "Ref,Date,Amount\nINV-100,2026-01-11,1.00\n"),
    ...(o.n !== undefined ? { creditNotes: F("n.csv", o.n) } : {}) } as never, mapping: map }, sha);
const reasons = (r: ReturnType<typeof v>) => r.errors.map((e) => e.reason).join(" | ");

describe("RT-2F-B proposed: validator", () => {
  it("V13: a negative invoice total is refused", () => { expect(reasons(v({ i: "Ref,Account,Date,Gross\nINV-100,A1,2026-01-10,-10.00\n", p: "Ref,Date,Amount\nINV-100,2026-01-11,0.01\n" }))).toMatch(/negative invoice total/); });
  it("V3: a ref with no digits is refused", () => { expect(reasons(v({ i: "Ref,Account,Date,Gross\nINV-,A1,2026-01-10,1.00\n" }))).toMatch(/not a prefix followed by digits/); });
  it("R2: a ref-shape pattern longer than 100 characters is refused", () => { expect(checkMapping({ ...baseMap(), invoiceRefPattern: "A".repeat(101) }).problems.join()).toMatch(/invoiceRefPattern/); expect(checkMapping({ ...baseMap(), invoiceRefPattern: "A".repeat(100) }).problems).toEqual([]); });
  it("V15: a credit note against 'inv-100' counts the payment made against 'INV-100'", () => {
    const r = v({ p: "Ref,Date,Amount\nINV-100,2026-01-11,40.00\n", n: "Credit,Ref,Date,Gross,Net,VAT,Reason\nCN-1,inv-100,2026-01-12,60.01,,,\n" });
    expect(reasons(r)).toMatch(/more than its total/);
  });
  it("C10: a header with two delimiters tied is refused, not guessed", () => { expect(reasons(v({ c: "Account,Name;Extra\nA1,Acme;x\n" }))).toMatch(/cannot detect a single delimiter/); });
  it("X5: a comma inside a quoted header name is not a delimiter", () => { expect(detectDelimiter('"A,B";"C"\n')).toBe(";"); });
  it("X34: a header with the mapped column twice is refused", () => { expect(reasons(v({ i: "Ref,Ref,Account,Date,Gross\nINV-100,INV-100,A1,2026-01-10,1.00\n" }))).toMatch(/appears more than once/); });
  it("X11: credit note net + vat must equal gross", () => { expect(reasons(v({ n: "Credit,Ref,Date,Gross,Net,VAT,Reason\nCN-1,INV-100,2026-01-12,10.00,5.00,1.00,\n" }))).toMatch(/does not equal gross/); });
  it("X13: credit reason longer than 500 is refused", () => { expect(reasons(v({ n: `Credit,Ref,Date,Gross,Net,VAT,Reason\nCN-1,INV-100,2026-01-12,10.00,,,${"r".repeat(501)}\n` }))).toMatch(/longer than 500/); });
  it("X13b: credit ref longer than 60 is refused", () => { expect(reasons(v({ n: `Credit,Ref,Date,Gross,Net,VAT,Reason\n${"C".repeat(61)}1,INV-100,2026-01-12,10.00,,,\n` }))).toMatch(/longer than 60/); });
  it("X31: duplicate supplier names are refused", () => { expect(reasons(v({ s: "Account,Name\nS1,Steel Ltd\nS2,steel limited\n" }))).toMatch(/duplicate name/); });
  it("X20/X21/X22: normaliseName matches the database's import_norm_name (vector generated from the database)", () => {
    const vec: Record<string, string> = { "Zoë Ltd": "zoe ltd", "Zoë LIMITED": "zoe ltd", "Smith & Co": "smith and co", "M\u00fcller GmbH": "muller gmbh", "Smith&Co": "smith and co", "Acme  Ltd.": "acme ltd", "O’Brien": "o brien", "株式会社": "" };
    for (const [k, want] of Object.entries(vec)) expect(normaliseName(k), k).toBe(want);
  });
  it("X24: the reconciliation compares names with runs of spaces collapsed", () => { expect(normName("  Acme   Co ")).toBe("acme co"); });
  it("C11: a literally empty line in the middle is refused at its own row, and the rows after it keep their file row numbers", () => {
    const r = v({ i: "Ref,Account,Date,Gross\nINV-100,A1,2026-01-10,100.00\n\nINV-101,A1,2026-13-11,5.00\n", p: "Ref,Date,Amount\nINV-100,2026-01-11,1.00\n" });
    expect(r.errors.map((e) => `${e.row}:${e.field}:${e.reason}`)).toEqual(expect.arrayContaining([
      "3:null:row is empty (every field blank) with data after it: delete the empty row and save the file again", expect.stringMatching(/^4:date:/)]));
  });
});

describe("RT-2F-B proposed: build and sign-off", () => {
  it("B15/B16/B24/B23: the signing-sheet source files are the validator's hashes; suppliers are in the payload; keyed payments keep their key", async () => {
    const { report, payload } = await validateAndBuild(syntheticFiles(), MAPPING);
    expect(report.ok).toBe(true);
    const src = sourceTotalsFromValidated(report, payload!);
    for (const f of src.files) { const e = Object.values(report.totals.entities).find((t) => t!.file === f.name)!; expect(f.sha256).toBe(e.sha256); expect(f.sha256).toMatch(/^[0-9a-f]{64}$/); }
    expect(payload!.suppliers!.length).toBe(3);
    expect(payload!.payments![0].source_row_id).toMatch(/^P:R\d+$/);
  });
  it("B3/B4/B5/B17/B18: source totals refuse a payload that no longer matches the validator's report", async () => {
    const { report, payload } = await validateAndBuild(syntheticFiles(), MAPPING);
    const clone = () => JSON.parse(JSON.stringify(payload));
    const t = (mut: (p: Record<string, Array<Record<string, string>>>) => void, re: RegExp) => { const p = clone(); mut(p); expect(() => sourceTotalsFromValidated(report, p)).toThrow(re); };
    t((p) => { p.customers.pop(); }, /customers/);
    t((p) => { p.invoices[0].total = "1.00"; }, /invoice total/);
    t((p) => { p.payments[0].amount = "0.01"; }, /payments total/);
    t((p) => { p.credit_notes[0].total = "0.01"; }, /credits total/);
    t((p) => { p.credit_notes.pop(); }, /credit notes/);
  });
  it("B22: a payment written against 'inv-1001' is attached to the invoice 'INV-1001' in the payload", async () => {
    const files = syntheticFiles();
    const text = new TextDecoder().decode(files.payments.bytes).replace("INV-1001", "inv-1001");
    const out = await validateAndBuild({ ...files, payments: { name: files.payments.name, bytes: enc.encode(text) } }, MAPPING);
    expect(out.report.ok).toBe(true);
    expect(out.payload!.payments!.every((p) => p.invoice_ref !== "inv-1001")).toBe(true);
    expect(planSliqBatches(out.payload!).orphanPayments.length).toBe(0);
  });
  void buildSliqPayload;
});

describe("RT-2F-B proposed: route", () => {
  const rows = { invoices: [{ source_row_id: "I:INV-1", invoice_ref: "INV-1", total: "1.00" }], payments: [{ source_row_id: "P:1", invoice_ref: "INV-1", amount: "1.00" }] };
  const payload = { source_sha256: "a".repeat(64), source_files: [{ entity: "customers", name: "c.csv", sha256: "b".repeat(64) }], ...rows } as never;
  it("T4/T5: a failure of the road is retried exactly once (two calls), never more", async () => {
    let n = 0; const rpc: Rpc = async () => { n += 1; return { data: null, error: { message: "TypeError: Failed to fetch" } }; };
    const r = await sliqRunBatches(rpc, payload, "live", undefined, 0, 500);
    expect(r.failedAt).toBe(0); expect(n).toBe(2);
  });
  it("T1b: an error that has a database code is never retried, whatever its text", async () => {
    let n = 0; const rpc: Rpc = async () => { n += 1; return { data: null, error: { message: "bad gateway", code: "XX000" } }; };
    await sliqRunBatches(rpc, payload, "live", undefined, 0, 500); expect(n).toBe(1);
  });
  it("T17/T18: a JSON-text answer is parsed; an array answer is refused", async () => {
    const ok: Rpc = async () => ({ data: JSON.stringify({ ok: true, entity: "invoices", batch_no: 1, rows: 1, created: 1 }), error: null });
    expect((await sliqRunBatches(ok, payload, "live", undefined, 0, 500)).failedAt).toBeNull();
    const arr: Rpc = async () => ({ data: [1], error: null });
    const r = await sliqRunBatches(arr, payload, "live", undefined, 0, 500);
    expect(r.failedAt).toBe(0); expect(r.error).toBeInstanceOf(SliqCallError);
  });
  it("T9: a duplicated invoice number does not carry its payments twice", () => {
    const p = { ...(payload as object), invoices: [...(rows.invoices), { ...rows.invoices[0], source_row_id: "I:dup" }] } as never;
    const sent = planSliqBatches(p).batches.flatMap((b) => b.rows.payments ?? []);
    expect(sent.length).toBe(1);
  });
  it("T14: lower-case inv-5 is not an INV number in the invoice order", () => {
    const sorted = sortInvoices([{ source_row_id: "a", invoice_ref: "inv-5" }, { source_row_id: "b", invoice_ref: "INV-10" }]);
    expect(sorted.map((x) => x.source_row_id)).toEqual(["b", "a"]);
  });
  it("K10: SQLSTATE 42883 alone means release 152 is not applied", () => { expect(isMissingImportFunction({ code: "42883", message: "x" })).toBe(true); });
});

describe("final pass (candidate 2F): empty lines, header-only invoices, control characters, ref length", () => {
  it("an empty first line is refused: the header must be row 1", () => {
    expect(v({ c: "\nAccount,Name\nA1,Acme\n" }).errors.map((e) => `${e.file}:${e.row}:${e.reason}`)).toContain("c.csv:1:row 1 is empty: the header must be the first row of the file");
  });
  it("empty lines at the end are still ignored (with a warning) and do not shift anything", () => {
    const r = v({ p: "Ref,Date,Amount\nINV-100,2026-01-11,1.00\n\n\n" });
    expect(r.errors).toEqual([]);
    expect(r.totals.entities.payments?.rows).toBe(1);
    expect(r.warnings.map((w) => w.reason)).toContain("2 empty rows at the end of the file (every field blank, as Excel leaves them) ignored");
  });
  it("an invoices file with no data rows while customers has rows is refused, with the reason in words", () => {
    const r = v({ i: "Ref,Account,Date,Gross\n", p: "Ref,Date,Amount\n" });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => `${e.file}:${e.reason}`)).toEqual(["i.csv:the invoices file has its header row but no data rows, while the customers file has 1: check the invoices export was not cut short. (To bring in customers only, use the ordinary customer import.)"]);
  });
  it("invoices with no payments yet are fine (a payments file with only its header)", () => {
    expect(v({ p: "Ref,Date,Amount\n" }).ok).toBe(true);
  });
  it("NUL and other control characters in any field are refused with the character named; tab is not refused", () => {
    expect(reasons(v({ c: "Account,Name\nA1,Ac\u0000me\n" }))).toContain("contains a control character (U+0000): remove it from the file and export again");
    expect(reasons(v({ c: "Account,Name\nA1,Acme\u0007\n" }))).toContain("U+0007");
    expect(reasons(v({ s: "Account,Name\nS1,Ste\u007Fel\n" }))).toContain("U+007F");
    expect(reasons(v({ i: "Ref,Account,Date,Gross\nINV-100,A1,2026-01-10,100.00\u001B\n" }))).toContain("U+001B");
    expect(v({ c: "Account,Name\nA1,\"Ac\tme\"\n" }).ok).toBe(true);
  });
  it("an invoice ref of 32 characters is accepted; 33 is refused for its length", () => {
    const ref = (n: number) => "S" + "1".repeat(n - 1);
    const at = (n: number) => v({ i: `Ref,Account,Date,Gross\n${ref(n)},A1,2026-01-10,100.00\n`, p: `Ref,Date,Amount\n${ref(n)},2026-01-11,1.00\n` });
    expect(at(32).errors).toEqual([]);
    expect(reasons(at(33))).toBe("invoice ref is longer than 32 characters");
    const t0 = performance.now();
    expect(reasons(at(1_000_000))).toContain("longer than 32 characters");
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("final pass (candidate 2F): the sheet's hashes and the report-to-payload cross-checks", () => {
  it("source totals refuse a payload whose file hash is blank, wrong or missing, or whose suppliers were dropped", async () => {
    const { report, payload } = await validateAndBuild(syntheticFiles(), MAPPING);
    const clone = () => JSON.parse(JSON.stringify(payload)) as NonNullable<typeof payload>;
    const t = (mut: (p: NonNullable<typeof payload>) => void, re: RegExp) => { const p = clone(); mut(p); expect(() => sourceTotalsFromValidated(report, p)).toThrow(re); };
    t((p) => { p.source_files[0].sha256 = ""; }, /SHA-256 is not the one the file checks recorded/);
    t((p) => { p.source_files[1].sha256 = "f".repeat(64); }, /SHA-256 is not the one the file checks recorded/);
    t((p) => { p.source_files.pop(); }, /is not among the files sent/);
    t((p) => { p.suppliers = []; }, /suppliers: the files have 3 rows but 0 were built to send/);
    expect(() => sourceTotalsFromValidated(report, clone())).not.toThrow();
  });
  it("the signing sheet prints FAIL when a source hash is blank or malformed, even for a passing report", async () => {
    const { renderSigningSheet } = await import("@/lib/sliq-reconcile/sheet");
    const { reconcile } = await import("@/lib/sliq-reconcile/reconcile");
    const src = (sha: string) => ({ files: [{ name: "i.csv", sha256: sha }], counts: {}, invoiceTotalPence: 0, paymentsTotalPence: 0, outstandingPence: 0, customerBalancesPence: {}, invoiceRefsNotInvFormat: 0 });
    const pass = reconcile(src("a".repeat(64)), [], { countersBefore: {} });
    expect(pass.pass).toBe(true);
    const meta = { company: "t", importedOn: "2026-11-08" };
    expect(renderSigningSheet(src("a".repeat(64)), pass, meta)).toContain("Overall result: PASS");
    for (const bad of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      const sheet = renderSigningSheet(src(bad), pass, meta);
      expect(sheet, bad).toContain("Overall result: FAIL - do not sign");
      expect(sheet).not.toContain("PASS - all differences are zero");
    }
    expect(renderSigningSheet({ ...src("a".repeat(64)), files: [] }, pass, meta)).toContain("FAIL - do not sign");
  });
});
