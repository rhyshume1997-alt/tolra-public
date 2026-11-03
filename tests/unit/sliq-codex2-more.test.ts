import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCsv, parseDate, parseMoneyPence, parsePercentCenti, parseQuantityMilli } from "../../scripts/sliq-import/parse.mjs";
import { getProfile, MappingError } from "../../scripts/sliq-import/mapping.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { analyse } from "../../scripts/sliq-import/reconcile.mjs";
const folders: string[] = [];
const fixture = path.resolve(__dirname, "../fixtures/sliq/basic");
function copy() { const dir = mkdtempSync(path.join(tmpdir(), "codex2-sliq-")); folders.push(dir); cpSync(fixture, dir, { recursive: true }); return dir; }
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("blank rows and missing headers", () => {
  it("ignores empty and whitespace-only rows without removing blank lines inside a quoted field", () => {
    const result = parseCsv('\ufeffName,Address\r\n\r\n , \r\nAcme,"Line 1\n\nLine 3"\r\n,,'.replace(',,', ','));
    expect(result.headers).toEqual(["Name", "Address"]);
    expect(result.rows).toEqual([["Acme", "Line 1\n\nLine 3"]]);
  });
  it.each(["", "\n\r\n", " , \n,\n"])("refuses an empty/headerless CSV: %j", (text) => expect(() => parseCsv(text)).toThrow(/empty/));
  it("refuses source data with its required header row removed", () => {
    const dir = copy(); const file = path.join(dir, "customers.csv");
    writeFileSync(file, readFileSync(file, "utf8").split("\n").slice(1).join("\n"));
    expect(() => loadFolder(dir, getProfile("synthetic"))).toThrow(MappingError);
    expect(() => loadFolder(dir, getProfile("synthetic"))).toThrow(/Name/);
  });
});

describe("explicit date formats, never guessed", () => {
  it.each([
    ["29/02/2024", "DD/MM/YYYY", "2024-02-29"], ["02/29/2024", "MM/DD/YYYY", "2024-02-29"],
    ["29-02-2024", "DD-MM-YYYY", "2024-02-29"], ["29.02.2024", "DD.MM.YYYY", "2024-02-29"],
    ["2024-02-29", "YYYY-MM-DD", "2024-02-29"], ["03/04/2026", "DD/MM/YYYY", "2026-04-03"],
    ["03/04/2026", "MM/DD/YYYY", "2026-03-04"],
  ])("parses %s only as %s", (raw, format, expected) => expect(parseDate(raw, format)).toBe(expected));
  it.each(["29/02/2025", "31/04/2026", "00/01/2026", "01/13/2026"])("rejects impossible date %s", (raw) => expect(() => parseDate(raw, "DD/MM/YYYY")).toThrow(/real calendar date/));
  it("does not guess a dotted date with slash mapping", () => expect(() => parseDate("03.04.2026", "DD/MM/YYYY")).toThrow(/does not match/));
});

describe("exact source pennies and numerical limits", () => {
  it.each([["0.00", 0], ["0.01", 1], ["-0.01", -1], ["(£1,234.56)", -123456], ["90071992547409.91", Number.MAX_SAFE_INTEGER]])
    ("keeps every penny of %s", (raw, expected) => expect(parseMoneyPence(raw)).toBe(expected));
  it.each(["0.005", "-0.005", "1.005", "-1.005", "12.345"])("refuses fractional source pennies instead of rounding %s", raw => expect(() => parseMoneyPence(raw)).toThrow(/not rounded/));
  it.each(["90071992547409.92", "-90071992547409.92", "9".repeat(400)])("refuses money too large: %s", raw => expect(() => parseMoneyPence(raw)).toThrow(/too large/));
  it.each(["9007199254740.992", "-9007199254740.992", "9".repeat(400)])("refuses quantity outside exact integer range: %s", raw => expect(() => parseQuantityMilli(raw)).toThrow(/too large/));
  it.each(["90071992547409.92", "9".repeat(400)])("refuses percentage outside exact integer range: %s", raw => expect(() => parsePercentCenti(raw)).toThrow(/too large/));
  it("keeps signed exact thousandths and percentage boundaries", () => {
    expect(parseQuantityMilli("9007199254740.991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseQuantityMilli("-9007199254740.991")).toBe(-Number.MAX_SAFE_INTEGER);
    expect(parsePercentCenti("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

it("reports duplicate customer names as separate records without choosing a mailbox or merging them", () => {
  const loaded = loadFolder(fixture, getProfile("synthetic"));
  const before = structuredClone(loaded.records.customers);
  const { report } = analyse(loaded);
  const duplicate = report.duplicates.customers.find((row: { normalisedName: string }) => row.normalisedName === "alpha fabrications ltd");
  expect(duplicate.records).toHaveLength(2);
  expect(duplicate.records.map((row: { key: string }) => row.key).sort()).toEqual(["C001", "C004"]);
  expect(loaded.records.customers).toEqual(before);
  expect(report.counts.customers).toBe(before.length);
});
