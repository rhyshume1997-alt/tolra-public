/**
 * The reviewer's three decisions on the SliQ importer (Mon 2 Nov), on synthetic fixtures only:
 *   1. imported invoices get their real status and balance (unpaid, part paid, paid, overpaid), never "Payment to confirm";
 *   2. a number SliQ used twice keeps every copy under a deterministic Tolra number, the SliQ number kept as the source ref;
 *   3. customers are matched on an account or a name exactly one record has, never a guess; anything else stops the write and is
 *      listed in the ambiguity report until the resolutions file names the account.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dryRun } from "../../scripts/sliq-import/cli.mjs";
import { legacyId } from "../../scripts/sliq-import/ids.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile } from "../../scripts/sliq-import/mapping.mjs";
import { analyse, renderAmbiguityCsv, renderMarkdown } from "../../scripts/sliq-import/reconcile.mjs";
import { loadResolutions } from "../../scripts/sliq-import/resolutions.mjs";
import { buildLegacyExport } from "../../scripts/sliq-import/write.mjs";

const BASIC = path.resolve(__dirname, "../fixtures/sliq/basic");
const RES = path.resolve(__dirname, "../fixtures/sliq/basic-resolutions.json");
const ORG = "11111111-2222-4333-8444-555555555555";
const EXCL = ["S1011", "S1012", "Q2004", "S1003", "S1016", "S1008", "Q2003", "PO-0002"];
const synthetic = getProfile("synthetic");
const tmp = () => mkdtempSync(path.join(tmpdir(), "sliq-dec-"));
const FILES = ["customers", "suppliers", "invoices", "quotes", "invoice-lines", "payments", "purchase-orders"];
function copy(edit?: (file: string, text: string) => string) {
  const dir = tmp();
  cpSync(BASIC, dir, { recursive: true });
  if (edit) for (const f of FILES) writeFileSync(path.join(dir, `${f}.csv`), edit(`${f}.csv`, readFileSync(path.join(dir, `${f}.csv`), "utf8")));
  return dir;
}
function resolutions(extra: object) {
  const f = path.join(tmp(), "res.json");
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(RES, "utf8")), ...extra }));
  return loadResolutions(f);
}
const run = (dir = BASIC, opts: { excludeNumbers?: string[]; resolutions?: unknown } = {}) =>
  analyse(loadFolder(dir, synthetic), { organizationId: ORG, excludeNumbers: opts.excludeNumbers ?? EXCL, resolutions: opts.resolutions ?? loadResolutions(RES) });
const inv = (plan: { invoices: { number: string }[] }, n: string) => plan.invoices.find((i) => i.number === n) as unknown as Record<string, unknown> & { final: object; payments: unknown[] };

describe("decision 1: the real balance, never Payment to confirm", () => {
  const { report, plan } = run();

  it("unpaid, part paid, paid and overpaid are written as they are", () => {
    expect(inv(plan, "S1005").final).toMatchObject({ status: "sent", amountPaid: 0, paidAt: null, unverified: false }); // no payment record: owed in full
    expect(inv(plan, "S1002").final).toMatchObject({ status: "partial", amountPaid: 20000, paidAt: null, unverified: false });
    expect(inv(plan, "S1001").final).toMatchObject({ status: "paid", amountPaid: 12000, paidAt: "2026-03-05", unverified: false });
    // overpaid: every payment is written, the invoice is paid, the surplus is the customer's credit (lib/receivables.ts customerCredit)
    expect(inv(plan, "S1006").final).toMatchObject({ status: "paid", amountPaid: 15000, paidAt: "2026-03-15", unverified: false });
    expect(inv(plan, "S1006").payments).toHaveLength(1);
    expect(plan.invoices.filter((i: { final: { unverified: boolean } }) => i.final.unverified)).toEqual([]);
    expect(report.writePlan.invoicesPaymentToConfirm).toBe(0);
  });

  it("states money owed and customer credit straight after the import", () => {
    expect(report.balances.owedAfterImport).toBe(68800);
    expect(report.balances.creditAfterImport).toBe(3000);
    expect(renderMarkdown(report)).toContain('Money owed in Tolra straight after the import: **£688.00**');
    expect(renderMarkdown(report)).toContain('No imported invoice is left "Payment to confirm"');
  });

  it("evidence that disagrees stops the write; excluding the invoice clears it", () => {
    const all = run(BASIC, { excludeNumbers: ["S1011", "S1012", "Q2004", "S1008", "Q2003", "PO-0002"] }).report;
    expect(all.balances.exceptions.filter((e: { blocksWrite: boolean }) => e.blocksWrite).map((e: { number: string }) => e.number)).toEqual(["S1003", "S1016"]);
    expect(report.unresolvedPaymentCount).toBe(0);
  });

  it("a status word that says paid with payments short of the total is an exception (never imported as owed)", () => {
    const dir = copy((f, t) => (f === "invoices.csv" ? t.replace("S1005,Invoice,05/03/2026,04/04/2026,C002,80.00,16.00,96.00,Issued", "S1005,Invoice,05/03/2026,04/04/2026,C002,80.00,16.00,96.00,Paid") : t));
    const b = run(dir).report.balances.exceptions.find((e: { number: string }) => e.number === "S1005");
    expect(b).toMatchObject({ blocksWrite: true, reason: expect.stringContaining('"Paid" says paid but the payment records add up to £0.00 of £96.00') });
  });
});

describe("decision 2: numbers SliQ used twice", () => {
  it("every copy is kept: the earliest keeps the number, the next gets -B, the SliQ number is kept", () => {
    const { report, plan } = run();
    expect(report.renames.map((x: { sourceNumber: string; number: string; keeps: boolean; party: string }) => [x.sourceNumber, x.number, x.keeps, x.party])).toEqual([["S1009", "S1009", true, "C001"], ["S1009", "S1009-B", false, "C002"]]);
    expect(inv(plan, "S1009")).toMatchObject({ sourceRef: "S1009", customerName: "Alpha Fabrications Ltd" });
    expect(inv(plan, "S1009-B")).toMatchObject({ sourceRef: "S1009", customerName: "Beta Engineering Limited" });
    expect(inv(plan, "S1009").oldId).toBe(legacyId(ORG, "invoices", "S1009"));
    expect(inv(plan, "S1009-B").oldId).toBe(legacyId(ORG, "invoices", "S1009-B"));
    expect(report.writePlan.renamedDocuments).toBe(1);
    expect(renderMarkdown(report)).toMatch(/\| invoice \| S1009 \| S1009-B \| no \|/);
  });

  it("the same result every run, whatever the row order: the earlier date keeps the number", () => {
    const later = copy((f, t) => (f === "invoices.csv" ? t.replace("S1009,Invoice,09/03/2026,08/04/2026,C001", "S1009,Invoice,10/03/2026,08/04/2026,C001") : t));
    const a = run(later).report.renames.map((x: { number: string; party: string }) => `${x.number}=${x.party}`);
    const swapped = copy((f, t) => {
      if (f !== "invoices.csv") return t;
      const rows = t.replace("S1009,Invoice,09/03/2026,08/04/2026,C001", "S1009,Invoice,10/03/2026,08/04/2026,C001").split("\n");
      const i = rows.findIndex((r) => r.startsWith("S1009,"));
      [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
      return rows.join("\n");
    });
    const b = run(swapped).report.renames.map((x: { number: string; party: string }) => `${x.number}=${x.party}`);
    expect(a.sort()).toEqual(["S1009-B=C001", "S1009=C002"]);
    expect(b.sort()).toEqual(a.sort());
    expect(JSON.stringify(run().report.renames)).toBe(JSON.stringify(run().report.renames));
  });

  it("skips a suffix already used, and handles quotes and purchase orders the same way", () => {
    const dir = copy((f, t) => {
      if (f === "invoices.csv") return `${t}S1009-B,Invoice,12/03/2026,11/04/2026,C003,10.00,2.00,12.00,Issued,,,,,\n`;
      if (f === "quotes.csv") return `${t}Q2001,06/02/2026,C002,200.00,40.00,240.00,Sent,06/05/2026,\n`;
      if (f === "purchase-orders.csv") return `${t}PO-0001,Tooling Co,04/03/2026,,30.00,Open\n`;
      return t;
    });
    const { report, plan } = run(dir);
    expect(report.renames.filter((x: { keeps: boolean }) => !x.keeps).map((x: { kind: string; number: string }) => `${x.kind}:${x.number}`)).toEqual(["invoice:S1009-C", "quote:Q2001-B", "purchase_order:PO-0001-B"]);
    expect(plan.quotes.find((q: { number: string }) => q.number === "Q2001-B")).toMatchObject({ sourceRef: "Q2001", lines: [], linesWithheld: expect.stringContaining("cannot be told apart") });
    expect(plan.purchaseOrders.map((p: { number: string; sourceRef: string; supplierName: string }) => [p.number, p.sourceRef, p.supplierName])).toEqual([["PO-0001", "PO-0001", "Steel Supplies Ltd"], ["PO-0001-B", "PO-0001", "Tooling Co"]]);
  });

  it("lines under a shared number go on neither copy; a payment under it stops the write", () => {
    const dir = copy((f, t) => {
      if (f === "invoice-lines.csv") return `${t}S1009,Bracket,1,10.00,10.00,20,2.00,,\n`;
      if (f === "payments.csv") return `${t}S1009,12/03/2026,12.00,BACS,R1\n`;
      return t;
    });
    const { report, plan } = run(dir);
    expect(inv(plan, "S1009")).toMatchObject({ lines: [], linesWithheld: expect.stringContaining("cannot be told apart") });
    expect(report.missingRelationships.ambiguousLines).toEqual([expect.objectContaining({ number: "S1009", reason: expect.stringContaining("2 documents") })]);
    expect(report.balances.exceptions.filter((e: { blocksWrite: boolean }) => e.blocksWrite).map((e: { number: string }) => e.number)).toEqual(["S1009", "S1009-B"]);
    // excluding the SliQ number excludes every copy
    const ex = run(dir, { excludeNumbers: [...EXCL, "S1009"] }).report;
    expect(ex.unresolvedPaymentCount).toBe(0);
    expect(ex.held.filter((h: { reasons: string[] }) => h.reasons.includes("excluded by number (operator decision)")).map((h: { number: string }) => h.number)).toEqual(expect.arrayContaining(["S1009", "S1009-B"]));
    expect(ex.unknownExcludedNumbers).toEqual([]);
  });
});

describe("decision 3: customers matched on stable identifiers only", () => {
  const twin = (f: string, t: string) => (f === "customers.csv" ? `${t}C006,Gamma Supplies,,9 Far Road,,York,YO9 9ZZ,,,\n` : t);

  it("by account; a name that only one customer has; an exact name beside a Ltd/Limited twin", () => {
    const named = copy((f, t) => (f === "invoices.csv" ? t.replace("S1005,Invoice,05/03/2026,04/04/2026,C002", "S1005,Invoice,05/03/2026,04/04/2026,Beta Engineering Limited").replace("S1001,Invoice,01/03/2026,31/03/2026,C001", "S1001,Invoice,01/03/2026,31/03/2026,Alpha Fabrications Ltd") : t));
    const { report, plan } = run(named);
    expect(inv(plan, "S1002")).toMatchObject({ customerAccount: "C002", matchedVia: "account" });
    expect(inv(plan, "S1005")).toMatchObject({ customerAccount: "C002", matchedVia: "name (the only record with this name)" });
    // C004 "Alpha Fabrications, Ltd." normalises the same, but the name as written is C001's alone
    expect(inv(plan, "S1001")).toMatchObject({ customerAccount: "C001", matchedVia: expect.stringContaining("name exactly as written") });
    expect(report.unresolvedMatchCount).toBe(0);
  });

  it("a name that matches only after normalising, an account used twice, or nothing: stops the write with the candidates", () => {
    const dir = copy((f, t) => {
      if (f === "invoices.csv") return t.replace("S1005,Invoice,05/03/2026,04/04/2026,C002", "S1005,Invoice,05/03/2026,04/04/2026,Beta Engineering Ltd");
      if (f === "customers.csv") return `${t}C003,Gamma Supplies Two,,,,,,,,\n`;
      return t;
    });
    const r = run(dir).report;
    const by = Object.fromEntries(r.customerMatching.ambiguities.map((a: { number: string }) => [a.number, a]));
    expect(by.S1005).toMatchObject({ status: "ambiguous", reason: expect.stringContaining("only after normalising"), candidates: [expect.objectContaining({ account: "C002" })], blocksWrite: true });
    expect(by.S1004).toMatchObject({ status: "ambiguous", reason: "account C003 belongs to 2 records", blocksWrite: true });
    expect(r.unresolvedMatchCount).toBe(Object.values(by).filter((a) => (a as { blocksWrite: boolean }).blocksWrite).length);
    expect(r.held.find((h: { number: string }) => h.number === "S1005").reasons[0]).toMatch(/customer ambiguous/);
  });

  it("two customers with exactly the same name: each document of theirs, and both customers, until resolved; then 0 wrong", () => {
    // Documents name the customer (no account), and C003 and C006 are both "Gamma Supplies".
    const dir = copy((f, t) => {
      const u = twin(f, t);
      if (f === "invoices.csv") return u.replace(/,C003,/g, ",Gamma Supplies,");
      return u;
    });
    const before = run(dir).report;
    const amb = before.customerMatching.ambiguities.filter((a: { blocksWrite: boolean }) => a.blocksWrite);
    expect(amb.map((a: { kind: string; number: string }) => `${a.kind}:${a.number}`).sort()).toEqual(["customer:C003", "customer:C006", "invoice:S1004", "invoice:S1007"]);
    expect(amb.find((a: { number: string }) => a.number === "S1007")).toMatchObject({ reason: "2 records have exactly this name", candidates: [expect.objectContaining({ account: "C003" }), expect.objectContaining({ account: "C006" })] });
    const csv = renderAmbiguityCsv(before);
    expect(csv.split("\r\n")[0]).toBe("kind,tolra_number,sliq_number,file,row,reference_as_written,status,reason,candidates,stops_write,resolve_with");
    expect(csv).toContain('invoice,S1007,S1007,invoices.csv,8,Gamma Supplies,ambiguous,2 records have exactly this name,C003=Gamma Supplies (row 4); C006=Gamma Supplies (row 7),yes,"customerMatches: {""kind"":""invoice"",""number"":""S1007"",""row"":8,""account"":""<account>""} or --exclude S1007"');

    const res = resolutions({ customerMatches: [{ kind: "invoice", number: "S1004", row: 5, account: "C003" }, { kind: "invoice", number: "S1007", row: 8, account: "C006" }], customerNames: [{ account: "C006", name: "Gamma Supplies (Far Road)" }] });
    const after = run(dir, { resolutions: res });
    expect(after.report.unresolvedMatchCount).toBe(0);
    expect(after.report.writable).toBe(true);
    expect(inv(after.plan, "S1004")).toMatchObject({ customerAccount: "C003", customerName: "Gamma Supplies" });
    expect(inv(after.plan, "S1007")).toMatchObject({ customerAccount: "C006", customerName: "Gamma Supplies (Far Road)", matchedVia: "resolutions file (customerMatches)" });
    expect(after.report.customerMatching.renamedParties).toEqual([{ account: "C006", sliqName: "Gamma Supplies", tolraName: "Gamma Supplies (Far Road)" }]);
    // the customer record carries the Tolra name and keeps the SliQ name in its notes
    const json = buildLegacyExport(after.plan, ORG);
    const c6 = json.customers.find((c: { name: string }) => c.name === "Gamma Supplies (Far Road)");
    expect(c6.notes).toContain("Name in SliQ: Gamma Supplies (account C006)");
    expect(json.invoices.find((i: { invoice_ref: string }) => i.invoice_ref === "S1007").customer).toBe("Gamma Supplies (Far Road)");
    expect(new Set(json.customers.map((c: { name: string }) => c.name.toLowerCase())).size).toBe(json.customers.length);
  });

  it("a resolution that names an unknown account, fits no document, or is malformed stops the write", () => {
    const bad = (extra: object) => run(BASIC, { resolutions: resolutions(extra) }).report;
    expect(bad({ customerMatches: [{ kind: "invoice", number: "S9999", account: "C001" }] }).customerMatching.problems).toEqual(["customerMatches entry 1 (invoice S9999) fits no document in the source"]);
    expect(bad({ customerMatches: [{ kind: "invoice", number: "S9999", account: "C001" }] }).writable).toBe(false);
    expect(bad({ customerMatches: [{ kind: "invoice", number: "S1008", account: "C777" }] }).customerMatching.ambiguities.find((a: { number: string }) => a.number === "S1008").reason).toMatch(/names account C777, which is not in the file/);
    expect(bad({ customerMatches: [{ kind: "invoice", number: "S1008", account: "C777" }] }).unresolvedMatchCount).toBe(0); // S1008 is excluded in EXCL
    expect(bad({ customerMatches: [{ kind: "invoice", number: "S1008", account: "C777" }] }).customerMatching.ambiguities.find((a: { number: string }) => a.number === "S1008").blocksWrite).toBe(false);
    expect(bad({ customerNames: [{ account: "C999", name: "Nobody" }] }).customerMatching.problems[0]).toMatch(/customer account C999 is not exactly one record/);
    expect(bad({ customerMatches: [{ kind: "job", number: "S1001", account: "C001" }] }).customerMatching.problems[0]).toMatch(/kind must be one of invoice, quote, purchase_order/);
  });

  it("an unknown customer can be mapped to an account through the resolutions file", () => {
    const res = resolutions({ customerMatches: [{ kind: "invoice", number: "S1008", account: "C003" }, { kind: "quote", number: "Q2003", account: "C001" }, { kind: "purchase_order", number: "PO-0002", account: "SUP2" }] });
    const r = run(BASIC, { resolutions: res, excludeNumbers: ["S1011", "S1012", "Q2004", "S1003", "S1016"] });
    expect(r.report.unresolvedMatchCount).toBe(0);
    expect(inv(r.plan, "S1008")).toMatchObject({ customerAccount: "C003", customerName: "Gamma Supplies" });
    expect(r.plan.purchaseOrders.find((p: { number: string }) => p.number === "PO-0002").supplierName).toBe("Tooling Co");
  });

  it("the dry run writes ambiguity.csv beside the report", async () => {
    const out = tmp();
    await dryRun({ folder: BASIC, outDir: out, mapping: "synthetic", excludeNumbers: ["S1011", "S1012", "Q2004"], resolutionsPath: RES });
    const csv = readFileSync(path.join(out, "ambiguity.csv"), "utf8").trim().split("\r\n");
    expect(csv.slice(1).map((l) => l.split(",").slice(0, 2).join(","))).toEqual(["invoice,S1008", "quote,Q2003", "purchase_order,PO-0002"]);
    expect(readFileSync(path.join(out, "report.md"), "utf8")).toContain("## 14. Customer matching (decision 3: never on a name alone)");
  });
});

describe("credit notes imported as customer credit (each customer's balance = Aged Debtors)", () => {
  const cnRes = (decisions: Record<string, string>) => resolutions({ resolutions: JSON.parse(readFileSync(RES, "utf8")).resolutions.map((e: { number: string }) => (decisions[e.number] ? { ...e, decision: decisions[e.number], allocation: null } : e)) });
  const dir = copy((f, t) => (f === "invoices.csv" ? t : t));
  writeFileSync(path.join(dir, "credit-notes.csv"), "Credit No,Date,Account,Net,VAT,Gross,Against,Reason,Notes\nCN-002,21/03/2026,C001,50.00,10.00,60.00,,Goods returned,\nCN-003,22/03/2026,C003,10.00,2.00,12.00,S1004,Price adjustment,\n");

  it("no link: applied to the customer's latest paid invoice on or before its date, so money owed is unchanged and credit grows", () => {
    const base = run(dir).report;
    const { report, plan } = run(dir, { resolutions: cnRes({ "CN-002": "import-as-credit", "CN-003": "import-as-credit" }) });
    expect(report.unresolvedCreditNoteCount).toBe(0);
    expect(report.unresolvedPaymentCount).toBe(0);
    expect(plan.creditNotes.map((c: { number: string; carrierNumber: string; via: string; grossPence: number }) => [c.number, c.carrierNumber, c.via, c.grossPence])).toEqual([
      // C001's latest invoice paid in full on or before 21/03/2026 is S1006 (06/03, overpaid; S1001 is 01/03)
      ["CN-002", "S1006", "no link in SliQ: carried as customer credit on a paid invoice of the customer", 6000],
      ["CN-003", "S1004", "linked in SliQ", 1200],
    ]);
    expect(inv(plan, "S1006").final).toMatchObject({ status: "paid", amountPaid: 15000, credited: 6000 });
    expect(inv(plan, "S1001").final).toMatchObject({ status: "paid", amountPaid: 12000, credited: 0 });
    expect(report.balances.owedAfterImport).toBe(base.balances.owedAfterImport);
    expect(report.balances.creditAfterImport).toBe(base.balances.creditAfterImport + 6000 + 1200);
    expect(report.creditNotes.find((c: { number: string }) => c.number === "CN-002")).toMatchObject({ written: true, carriedOn: "S1006" });
    expect(report.writePlan).toMatchObject({ creditNotes: 2 });
    expect(report.held.some((h: { number: string }) => h.number === "CN-002")).toBe(false);
  });

  it("a link to an invoice that is not written, or a credit note with allocations, stops the write", () => {
    const d2 = copy();
    writeFileSync(path.join(d2, "credit-notes.csv"), "Credit No,Date,Account,Net,VAT,Gross,Against,Reason,Notes\nCN-002,21/03/2026,C002,50.00,10.00,60.00,,Goods returned,\nCN-003,22/03/2026,C003,10.00,2.00,12.00,S9999,Price adjustment,\n");
    const r = run(d2, { resolutions: cnRes({ "CN-003": "import-as-credit" }) }).report;
    expect(r.balances.exceptions.find((e: { number: string }) => e.number === "CN-003")).toMatchObject({ blocksWrite: true, reason: expect.stringContaining("SliQ links it to S9999, which is not in the invoice file") });
    const withAlloc = run(BASIC, { resolutions: cnRes({ "CN-001": "import-as-credit" }) }).report;
    expect(withAlloc.creditNoteResolution.unresolved.find((u: { number: string }) => u.number === "CN-001").reason).toMatch(/with allocations cannot be imported as customer credit/);
  });
});

