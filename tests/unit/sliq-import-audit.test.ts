/**
 * Regression tests for the PR B audit: duplicate receipts, unresolved credit notes blocking a write, approval of the whole mapping
 * file and every option, the rehearsal identity, and the per-document figures. Synthetic fixtures only.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertWriteAllowed } from "../../scripts/sliq-import/guard.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile } from "../../scripts/sliq-import/mapping.mjs";
import { analyse, renderMarkdown } from "../../scripts/sliq-import/reconcile.mjs";
import { loadResolutions } from "../../scripts/sliq-import/resolutions.mjs";

const BASIC = path.resolve(__dirname, "../fixtures/sliq/basic");
const RES = path.resolve(__dirname, "../fixtures/sliq/basic-resolutions.json");
const ORG = "11111111-2222-4333-8444-555555555555";
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REH = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const EXCL = ["S1011", "S1012", "Q2004"];
const synthetic = getProfile("synthetic");
const tmp = () => mkdtempSync(path.join(tmpdir(), "sliq-audit-"));
const copy = (edit?: (file: string, text: string) => string) => {
  const dir = tmp();
  cpSync(BASIC, dir, { recursive: true });
  if (edit) for (const f of ["payments.csv", "invoices.csv"]) writeFileSync(path.join(dir, f), edit(f, readFileSync(path.join(dir, f), "utf8")));
  return dir;
};
type Run = { dir?: string; profile?: unknown; options?: Record<string, unknown>; excludeNumbers?: string[]; resolutions?: string | null };
const run = ({ dir = BASIC, profile = synthetic, options = {}, excludeNumbers = EXCL, resolutions = RES }: Run = {}) =>
  analyse(loadFolder(dir, profile, options), { organizationId: ORG, excludeNumbers, resolutions: resolutions ? loadResolutions(resolutions) : null });
const approved = (r: Run = {}) => ({ ...run(r).report, collisions: { checked: true }, rehearsal: { checked: true, id: REH } });
const check = (report: unknown, r: Run = {}) => assertWriteAllowed({ write: true, databaseUrl: LOCAL, organizationId: ORG, report, current: run(r).report, excludeNumbers: r.excludeNumbers ?? EXCL });

describe("duplicate payment rows are never summed", () => {
  const dir = copy((f, t) => (f === "payments.csv" ? t.replace("S1006,15/03/2026,150.00,BACS,", "S1006,15/03/2026,60.00,BACS,R9\nS1006,15/03/2026,60.00,BACS,R9") : t));
  const { report, plan } = run({ dir });

  it("lists the duplicate, keeps the invoice at Payment to confirm and imports no payment for it", () => {
    expect(report.duplicatePayments).toEqual([expect.objectContaining({ invoiceNumber: "S1006", date: "2026-03-15", amount: 6000, reference: "R9", times: 2 })]);
    const b = report.balances.items.find((x: { number: string }) => x.number === "S1006");
    expect(b).toMatchObject({ state: "exception", paymentToConfirm: true, paid: 6000 }); // shown once, never doubled to the 120.00 that would clear it
    expect(b.reason).toMatch(/listed more than once/);
    const inv = plan.invoices.find((i: { number: string }) => i.number === "S1006");
    expect(inv.payments).toEqual([]);
    expect(inv.final).toEqual({ status: "sent", amountPaid: 0, paidAt: null, unverified: true });
    expect(renderMarkdown(report)).toContain("Duplicate payment rows");
  });

  it("two different receipts of the same amount on different dates are not duplicates", () => {
    const d2 = copy((f, t) => (f === "payments.csv" ? t.replace("S1006,15/03/2026,150.00,BACS,", "S1006,15/03/2026,60.00,BACS,R9\nS1006,16/03/2026,60.00,BACS,R9") : t));
    const r = run({ dir: d2 });
    expect(r.report.duplicatePayments).toEqual([]);
    // both receipts are counted (60.00 + 60.00); the invoice list still says 150.00 paid, so it stays to confirm for that reason, not as a duplicate
    expect(r.report.balances.items.find((x: { number: string }) => x.number === "S1006").reason).toMatch(/add up to £120\.00/);
  });
});

describe("credit notes and allocations block a write until resolved", () => {
  it("refuses with no resolution file, naming every credit note", () => {
    const r = run({ resolutions: null });
    expect(r.report.unresolvedCreditNoteCount).toBe(4);
    expect(() => check({ ...r.report, collisions: { checked: true }, rehearsal: { checked: true, id: REH } }, { resolutions: null })).toThrowError(/credit notes or allocations are unresolved: S1015, CN-001, CN-002, CN-003|credit notes or allocations are unresolved: .*CN-001/);
  });

  it("accepts a reviewed resolution file, and checksums it into the report", () => {
    const report = approved();
    expect(report.unresolvedCreditNoteCount).toBe(0);
    expect(report.creditNoteResolution.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.creditNoteResolution.covered.map((c: { number: string }) => c.number).sort()).toEqual(["CN-001", "CN-002", "CN-003", "S1015"]);
    expect(report.approval.options.resolutionsSha256).toBe(report.creditNoteResolution.sha256);
    expect(check(report)).toMatchObject({ host: "127.0.0.1" });
  });

  it("a resolution that is invalid, or does not repeat the source allocation, does not count", () => {
    const write = (mut: (r: { resolutions: Record<string, unknown>[] }) => void) => {
      const data = JSON.parse(readFileSync(RES, "utf8"));
      mut(data);
      const f = path.join(tmp(), "res.json");
      writeFileSync(f, JSON.stringify(data));
      return run({ resolutions: f }).report;
    };
    expect(write((d) => (d.resolutions[0].decision = "maybe")).creditNoteResolution.unresolved[0]).toMatchObject({ number: "CN-001", reason: expect.stringContaining("decision must be one of") });
    expect(write((d) => (d.resolutions[0].allocation = { invoice: "S1003", amount: "25.00" })).creditNoteResolution.unresolved[0].reason).toMatch(/does not repeat it exactly/);
    expect(write((d) => (d.resolutions[0].allocation = { invoice: "S5555", amount: "24.00" })).creditNoteResolution.unresolved[0].reason).toMatch(/not in the invoice file/);
    expect(write((d) => d.resolutions.pop()).unresolvedCreditNoteCount).toBe(1);
    const extra = write((d) => d.resolutions.push({ number: "CN-999", decision: "excluded", allocation: null }));
    expect(extra.creditNoteResolution.problems).toEqual(["resolution for CN-999, which is not a credit note in the source"]);
    expect(extra.writable).toBe(false);
  });
});

describe("approval covers the whole mapping file and every option", () => {
  const report = approved();

  it("the same inputs pass", () => {
    expect(check(report)).toMatchObject({ organizationId: ORG });
  });

  it("a changed mapping file refuses, even when only whitespace changed", () => {
    const text = readFileSync(path.resolve(__dirname, "../../scripts/sliq-import/mappings/synthetic.json"), "utf8");
    const f = path.join(tmp(), "synthetic.json");
    writeFileSync(f, `${text}\n `);
    expect(() => check(report, { profile: getProfile(f) })).toThrowError(/what was approved differs from what is being run \(the mapping file\)/);
    // a mapping that maps another column is a different approval too
    writeFileSync(f, text.replace('"vatCode": "VAT Code", ', ""));
    expect(() => check(report, { profile: getProfile(f) })).toThrowError(/the mapping file/);
  });

  it("a changed option refuses: encoding, date format, sheet choice, exclusion, resolutions", () => {
    // encoding and date format are recorded in the mapping file for the synthetic profile, so a flag that overrides them changes the approval
    expect(() => check(report, { options: { encoding: "windows-1252" } })).toThrowError(/encoding/);
    expect(() => check(report, { options: { dateFormat: "YYYY-MM-DD" } })).toThrowError();
    expect(() => check(report, { options: { sheets: { customers: "Sheet1" } } })).toThrowError();
    expect(() => check(report, { excludeNumbers: ["S1011", "S1012"] })).toThrowError(/excluded numbers|exclusions/);
    const other = JSON.parse(readFileSync(RES, "utf8"));
    other.resolutions[0].note = "changed after approval";
    const f = path.join(tmp(), "res.json");
    writeFileSync(f, JSON.stringify(other));
    expect(() => check(report, { resolutions: f })).toThrowError(/what was approved differs from what is being run \(the credit-note resolution file\)/);
  });

  it("a tampered approval record refuses", () => {
    expect(() => check({ ...report, approval: { ...report.approval, sha256: "0".repeat(64) } })).toThrowError(/what was approved differs/);
    expect(() => check({ ...report, approval: undefined })).toThrowError(/what was approved differs/);
  });
});

describe("rehearsal identity", () => {
  it("a report with no rehearsal identity refuses (the target was not a prepared copy, or was never read)", () => {
    const r = approved();
    expect(() => check({ ...r, rehearsal: { checked: true, id: null } })).toThrowError(/no rehearsal identity[\s\S]*prepare-rehearsal/);
    expect(() => check({ ...r, rehearsal: { checked: false, id: null } })).toThrowError(/no rehearsal identity/);
    expect(() => check({ ...r, rehearsal: undefined })).toThrowError(/no rehearsal identity/);
    expect(run().report.rehearsal).toEqual({ checked: false, id: null }); // a pure dry run records none
  });
});

describe("every document's figures are in the report", () => {
  const { report } = run();
  const docs = report.documentAmounts.documents;

  it("lists all invoices, credit notes and quotes, not only the mismatches", () => {
    expect(docs).toHaveLength(report.counts.invoices + report.counts.creditNotes + report.counts.quotes);
    expect(report.documentAmounts.documentsChecked).toBe(docs.length);
    const by = Object.fromEntries(docs.map((d: { number: string }) => [d.number, d]));
    expect(by.S1001).toMatchObject({ kind: "invoice", statedNet: 10000, statedVat: 2000, statedGross: 12000, lines: 1, linesNet: 10000, linesVat: 2000, linesGross: 12000, differenceNet: 0, differenceVat: 0, differenceGross: 0, result: "match" });
    expect(by.S1010).toMatchObject({ statedNet: 10000, linesNet: 9000, differenceNet: 1000, differenceGross: 1200, result: "MISMATCH" });
    expect(by.S1005).toMatchObject({ statedGross: 9600, lines: 0, linesNet: null, result: "no lines" });
    expect(by.S1007.result).toBe("not comparable"); // a line with no VAT cannot be compared
    expect(by.Q2001).toMatchObject({ kind: "quote", lines: 1, result: "match" });
    expect(by.Q2002).toMatchObject({ kind: "quote", result: "no lines" });
    expect(by["CN-001"]).toMatchObject({ kind: "credit_note", lines: 1, statedGross: 2400 });
    expect(docs.filter((d: { result: string }) => d.result === "match").length).toBeGreaterThan(5);
  });

  it("the Markdown lists them all too", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("Every document: source figures beside the lines");
    for (const d of docs) expect(md).toContain(`| ${d.kind} | ${d.number} |`);
  });
});
