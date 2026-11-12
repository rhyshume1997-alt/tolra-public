/**
 * BOUNDARY: guardrail for Revenue stage 1. Input: the source text of the revenue files (lib/reports/revenue, components/reports/revenue,
 * the page). Output: failing assertions if one of them could write, use the service role, keep a filter anywhere, or add the revenue
 * bases together. Must not change: loosening a rule here needs Rhys's decision.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const DIRS = ["lib/reports/revenue", "components/reports/revenue", "app/(dashboard)/reports/revenue"];

const files = DIRS.flatMap((dir) => readdirSync(path.join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${dir}/${f}`));
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
/** Code without comments, so the boundary comments can say what the file must not do. */
const code = (file: string) => source(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("revenue stage 1 is read only", () => {
  it("covers every file of the module", () => {
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  it("every file states its boundary at the top", () => {
    for (const file of files) expect(source(file).replace(/^"use client";\s*/, "").trimStart().startsWith("/**"), file).toBe(true);
  });

  it("has no write call, no rpc and no service role", () => {
    for (const file of files) {
      const text = code(file);
      for (const banned of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /service[_-]?role/i, /SUPABASE_SERVICE/, /fetch\(["'`]\/api\//, /method:\s*["'](POST|PUT|PATCH|DELETE)/i]) {
        expect(text, `${file} ${banned}`).not.toMatch(banned);
      }
    }
  });

  it("every database read is a select on a table of the report, nothing else", () => {
    const text = code("lib/reports/revenue/load-revenue.ts");
    const tables = [...text.matchAll(/\.from\("([a-z_]+)"\)\.select\(/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(["credit_notes", "invoice_line_items", "invoice_payments", "invoices", "invoices", "quote_line_items", "quotes", "sales_order_lines"]);
    expect([...text.matchAll(/\.from\(/g)]).toHaveLength(tables.length);
  });

  it("keeps filters in React state only: no address parameters, no storage", () => {
    for (const file of files) {
      const text = code(file);
      for (const banned of [/useSearchParams/, /usePathname/, /useRouter/, /router\.(push|replace)/, /window\.location/, /history\.(push|replace)State/, /localStorage/, /sessionStorage/, /document\.cookie/, /\bsaveOrgSettings\b/]) {
        expect(text, `${file} ${banned}`).not.toMatch(banned);
      }
    }
  });

  it("bounds every table read by the range (a date, or the ids the range produced) and pages with fetchAll", () => {
    const text = code("lib/reports/revenue/load-revenue.ts");
    for (const table of ["invoices", "credit_notes", "invoice_payments", "quotes"]) {
      const read = text.split(`.from("${table}")`)[1]?.split(".range(")[0] ?? "";
      expect(read, table).toMatch(/range\.from|startAt|credit_date|paid_on|sent_at/);
    }
    for (const table of ["invoice_line_items", "sales_order_lines", "quote_line_items"]) expect(text.split(`.from("${table}")`)[1]?.split(".range(")[0], table).toMatch(/\.in\(/);
    expect(text.split(`.from("invoices")`)[2]?.split(".range(")[0], "invoices of payments").toMatch(/\.in\("id"/);
    expect(text).toContain("fetchAll");
    expect(text).toContain("MAX_LIST_ROWS");
  });

  it("never adds the bases together: no combined or grand total", () => {
    for (const file of files) {
      const text = code(file);
      expect(text, file).not.toMatch(/grand total|combined|invoiced\s*\+\s*(received|cash|quoted)|received\s*\+\s*(invoiced|quoted)|quotedTotal\s*\+|\+\s*quotedTotal|invoicedTotal\s*\+\s*receivedTotal/i);
    }
    // The export columns of each table name one basis only.
    expect(source("components/reports/revenue/pipeline-card.tsx")).toContain("Pipeline (not revenue)");
  });

  it("is switched off by default and gated to admin and office", () => {
    expect(source("app/(dashboard)/reports/revenue/page.tsx")).toContain('allowed={["admin", "office"]}');
    const view = source("components/reports/revenue/revenue-view.tsx");
    expect(view).toContain("revenueEnabled(hiddenNav)");
    expect(view).toContain("if (!on)");
    // The read starts only inside the effect that is guarded by the switch.
    expect(view).toMatch(/if \(!on \|\| problem\) return;[\s\S]*loadRevenue\(/);
  });

  it("a hidden Invoices or Quotes section is never read and never shown as zero", () => {
    const loader = code("lib/reports/revenue/load-revenue.ts");
    expect(loader).toMatch(/!allow\.invoices \? FAILED[^;]*db\.from\("invoices"\)/);
    expect(loader).toMatch(/!allow\.invoices \? FAILED[^;]*db\.from\("credit_notes"\)/);
    expect(loader).toMatch(/!allow\.invoices \? FAILED[^;]*db\.from\("invoice_payments"\)/);
    expect(loader).toMatch(/!allow\.quotes \? FAILED[^;]*db\.from\("quotes"\)/);
    const view = code("components/reports/revenue/revenue-view.tsx");
    expect(view).toContain("sections.invoices ?");
    expect(view).toContain("sections.quotes ?");
    expect(view).toContain("INVOICES_HIDDEN_NOTICE");
    expect(view).toContain("QUOTES_HIDDEN_NOTICE");
  });
});
