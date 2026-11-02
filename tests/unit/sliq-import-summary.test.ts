/**
 * The safe summaries of the REAL dry run (scripts/sliq-import/summary.mjs, REAL-DRY-RUN.md): what Rhys pastes back holds only file
 * names, column names, counts and totals. Synthetic fixtures only (tests/fixtures/sliq/basic).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dryRun } from "../../scripts/sliq-import/cli.mjs";
import { headersSummary, reportSummary } from "../../scripts/sliq-import/summary.mjs";

const FIXTURE = path.resolve(__dirname, "../fixtures/sliq/basic");
// The fixture's names, document numbers, dates and references (not bare amounts or one-word status words such as "Open", which are
// vocabulary): none of them may appear in a summary.
function cellValues() {
  const values = new Set<string>();
  for (const f of ["customers.csv", "suppliers.csv", "invoices.csv", "payments.csv", "quotes.csv", "purchase-orders.csv", "credit-notes.csv"]) {
    const [, ...rows] = readFileSync(path.join(FIXTURE, f), "utf8").split(/\r?\n/).filter(Boolean);
    for (const r of rows) for (const v of r.split(",")) if (v.trim().length >= 4 && !/^\d+(\.\d+)?$/.test(v.trim()) && !/^[A-Za-z]+$/.test(v.trim())) values.add(v.trim().replace(/^"|"$/g, ""));
  }
  return [...values];
}

describe("REAL dry run: safe-to-share summaries", () => {
  it("headers: the file names, row counts and header rows, and no row value", async () => {
    const out = await headersSummary(FIXTURE);
    expect(out).toContain('customers.csv: 5 data rows; columns: "Account", "Name", "Contact"');
    expect(cellValues().filter((v) => out.includes(v))).toEqual([]);
  });
  it("report: counts and totals only; no customer name, document number or row value", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sliq-summary-"));
    const { report } = await dryRun({ folder: FIXTURE, outDir: dir, mapping: "synthetic" });
    const out = reportSummary(report);
    expect(out).toMatch(/Money owed after the import \(total\): £\d+\.\d\d/);
    expect(out).toContain("Ambiguous or unmatched (ambiguity.csv):");
    expect(cellValues().filter((v) => out.includes(v))).toEqual([]);
    for (const a of report.customerMatching.ambiguities) expect(out).not.toContain(String(a.number));
  });
});
