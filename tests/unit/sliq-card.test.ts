import { describe, expect, it } from "vitest";

import { MISSING_152, countersKey, importBlockers, isMissingImportFunction, loadCountersBefore, matchFiles, normaliseRunLabel, saveCountersBefore } from "@/lib/sliq-card";
import type { SliqPreflight } from "@/lib/sliq-import-route";
import type { SliqMapping } from "@/lib/sliq-validate";

const mapping = {
  version: 1, confirmed: true, dateFormat: "YYYY-MM-DD",
  entities: {
    customers: { file: "customers.csv", columns: { key: "A", name: "N" } },
    suppliers: { file: "suppliers.csv", columns: { key: "A", name: "N" } },
    invoices: { file: "invoices.csv", columns: { ref: "R", customerKey: "A", date: "D", gross: "G" } },
    payments: { file: "payments.csv", columns: { invoiceRef: "R", date: "D", amount: "M" } },
  },
} as SliqMapping;

describe("run label", () => {
  it("says when the label it uses is not what was typed, and refuses a bad one", () => {
    expect(normaliseRunLabel("live")).toEqual({ label: "live", valid: true, note: null });
    expect(normaliseRunLabel(" Live-2 ")).toMatchObject({ label: "live-2", valid: true, note: expect.stringContaining('"live-2"') });
    expect(normaliseRunLabel("live 2").valid).toBe(false);
    expect(normaliseRunLabel("").note).toMatch(/lower-case letters/);
  });
});

describe("file names against the mapping", () => {
  it("matches exact names only and says what is wrong otherwise", () => {
    const ok = matchFiles(mapping, ["mapping.json", "customers.csv", "suppliers.csv", "invoices.csv", "payments.csv"]);
    expect(ok.problems).toEqual([]);
    expect(ok.byEntity.invoices).toBe("invoices.csv");
    const off = matchFiles(mapping, ["Customers.csv", "suppliers.csv", "invoices.csv", "extra.csv"]);
    expect(off.problems).toEqual([
      '"Customers.csv" is not named exactly as the mapping says ("customers.csv"): rename the copy or fix the mapping.',
      '"extra.csv" is not a file the mapping names: it is not used.',
      'No file for customers: the mapping expects "customers.csv".',
      'No file for payments: the mapping expects "payments.csv".',
    ]);
  });
  it("says when no mapping .json was chosen", () => {
    expect(matchFiles(null, ["customers.csv"]).problems).toEqual(["No mapping (.json) was chosen: choose it together with the SliQ files."]);
    expect(matchFiles(null, ["mapping.json"]).problems).toEqual([]);
  });
});

describe("why Import is disabled", () => {
  const pf = (ok: boolean) => ({ ok, error_count: ok ? 0 : 3 }) as SliqPreflight;
  it("lists every reason, and none when it can run", () => {
    expect(importBlockers({ preflighted: true, preflight: pf(true), orphanPayments: 0, orphanCredits: 0, labelValid: true, running: false })).toEqual([]);
    expect(importBlockers({ preflighted: false, preflight: null, orphanPayments: 0, orphanCredits: 0, labelValid: true, running: false })).toEqual(["Run the preflight first."]);
    const all = importBlockers({ preflighted: true, preflight: pf(false), orphanPayments: 2, orphanCredits: 1, labelValid: false, running: true });
    expect(all).toEqual([
      "An import is running.",
      "The preflight found 3 problem(s): fix them in the source files or the mapping, then check again.",
      "2 payment(s) name an invoice that is not in the invoices file.",
      "1 credit note(s) name an invoice that is not in the invoices file.",
      "The run label is not valid.",
    ]);
  });
});

describe("release 152 missing", () => {
  it("recognises PostgREST's and Postgres's 'no such function'", () => {
    expect(isMissingImportFunction({ code: "PGRST202", message: "Could not find the function public.import_sliq_preflight" })).toBe(true);
    expect(isMissingImportFunction({ code: "42883", message: "function public.import_sliq_reconcile() does not exist" })).toBe(true);
    expect(isMissingImportFunction({ code: "42501", message: "Only an admin can import data." })).toBe(false);
    expect(isMissingImportFunction(null)).toBe(false);
    expect(MISSING_152).toMatch(/release 152/);
  });
});

describe("counters before survive a reload and a label change", () => {
  it("are kept per file set only, written once, and anything malformed reads as none", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(saveCountersBefore(store, "a".repeat(64), { INV: 10, DLN: 12 })).toEqual({ INV: 10, DLN: 12 });
    // A later preflight (after part of the import) does not replace them.
    expect(saveCountersBefore(store, "a".repeat(64), { INV: 1060, DLN: 12 })).toEqual({ INV: 10, DLN: 12 });
    expect(loadCountersBefore(store, "a".repeat(64))).toEqual({ INV: 10, DLN: 12 });
    // After a restore of the pre-import backup nothing of the file set is imported: the fresh reading replaces the stored one.
    expect(saveCountersBefore(store, "a".repeat(64), { INV: 7, DLN: 12 }, { nothingImportedYet: true })).toEqual({ INV: 7, DLN: 12 });
    expect(loadCountersBefore(store, "a".repeat(64))).toEqual({ INV: 7, DLN: 12 });
    expect(loadCountersBefore(store, "c".repeat(64))).toBeNull();
    m.set(countersKey("b".repeat(64)), "{\"INV\":\"x\"}");
    expect(loadCountersBefore(store, "b".repeat(64))).toBeNull();
    expect(loadCountersBefore(null, "a".repeat(64))).toBeNull();
  });
});

describe("preflight size limit (release 152: preflight_too_large)", () => {
  it("is checked in the page before anything is sent", async () => {
    const { preflightTooLarge } = await import("@/lib/sliq-import-route");
    const base = { source_sha256: "a".repeat(64), source_files: [] };
    expect(preflightTooLarge({ ...base, customers: Array.from({ length: 6000 }, (_, i) => ({ source_row_id: `C:${i}` })) })).toBeNull();
    expect(preflightTooLarge({ ...base, customers: Array.from({ length: 6001 }, (_, i) => ({ source_row_id: `C:${i}` })) })).toMatch(/too large for one preflight \(6001 records/);
    expect(preflightTooLarge({ ...base, customers: [{ source_row_id: "C:1", notes: "x".repeat(4 * 1024 * 1024) }] })).toMatch(/4\.0 MB/);
  });
});
