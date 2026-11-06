/**
 * DEFECTS FOUND IN THE IMPORTER (scripts/sliq-import), each with a failing test. App code is NOT changed by this work.
 *
 * Each case is written as the behaviour it SHOULD have. While the defect stands the case fails, so it is marked `it.fails` (the suite stays
 * green and the defect stays on record, and the day it is fixed `it.fails` itself fails and says "remove the .fails"). To see the red:
 *     IMPORT_DEFECTS_STRICT=1 npx vitest run --config tests/import/vitest.config.ts tests/import/defects.test.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile } from "../../scripts/sliq-import/mapping.mjs";
import { normaliseName } from "../../scripts/sliq-import/ids.mjs";
import { analyse } from "../../scripts/sliq-import/reconcile.mjs";
import { MAPPING } from "./support/db";

const defect = process.env.IMPORT_DEFECTS_STRICT ? it : it.fails;

function folderOf(customers: string[], invoices: [string, string][]) {
  const dir = mkdtempSync(path.join(tmpdir(), "sliq-defect-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "customers.csv"), ["Company Name,Contact Name,Email Address,Phone Number,Address,Notes", ...customers.map((n) => `${n},,,,,`)].join("\r\n") + "\r\n", "utf8");
  writeFileSync(
    path.join(dir, "invoices.csv"),
    ["Number,Customer,Invoice Date,Due Date,Net,VAT,Gross,Status,Discount", ...invoices.map(([no, c]) => `${no},${c},15/03/2026,14/04/2026,100.00,20.00,120.00,Unpaid,`)].join("\r\n") + "\r\n",
    "utf8",
  );
  return dir;
}

describe("DEFECT 1: customer names written in non-Latin letters (or starting with Ł, Ø, Ð ...) are reduced to nothing and different customers are treated as the same", () => {
  // scripts/sliq-import/ids.mjs, normaliseName(), line 32: `.normalize("NFKD").replace(/[̀-ͯ]/g, "")` removes accents only, then
  // `.replace(/[^a-z0-9 ]+/g, " ")` deletes EVERY other non-ASCII letter. "Мир Ltd" and "Дом Ltd" both become "ltd".
  defect("two different Cyrillic customers normalise differently", () => {
    expect(normaliseName("Мир Ltd")).not.toBe(normaliseName("Дом Ltd"));
  });

  defect("a Polish name is not equal to the same name without its first letter (Łukasz Ltd vs ukasz Ltd)", () => {
    expect(normaliseName("Łukasz Ltd")).not.toBe(normaliseName("ukasz Ltd"));
  });

  defect("end to end: an invoice for the SECOND of two different Cyrillic customers is filed under that customer, not the first", () => {
    const folder = folderOf(["Мир Ltd", "Дом Ltd"], [["INV-0001", "Мир Ltd"], ["INV-0002", "Дом Ltd"]]);
    const { plan } = analyse(loadFolder(folder, getProfile(MAPPING)), { organizationId: "11111111-2222-4333-8444-555555555555" });
    expect(plan.invoices.map((i: { number: string; customerName: string }) => [i.number, i.customerName])).toEqual([["INV-0001", "Мир Ltd"], ["INV-0002", "Дом Ltd"]]);
  });
});
