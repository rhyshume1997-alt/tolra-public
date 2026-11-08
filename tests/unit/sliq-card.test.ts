import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MISSING_152, countersKey, importBlockers, isMissingImportFunction, isStatementTimeout, loadCountersBefore, matchFiles, normaliseRunLabel, recordsCreated, saveCountersBefore, statementTimeoutMessage } from "@/lib/sliq-card";
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
  it("F6 (candidate 2F): measures the bytes as Postgres's jsonb text does (\", \" and \": \"), the figure release 152 checks", async () => {
    const { jsonbTextBytes } = await import("@/lib/sliq-import-route");
    // octet_length(<this>::jsonb::text) on local Postgres 16.15 = 227 (escapes, accents, a control character, astral emoji, empty [] and {}).
    const sample = { customers: [{ source_row_id: "C:é\n\"q\\", name: "Café \u0001 ☃ 😀", external_ref: "x" }, { source_row_id: "C:2", name: "B", tags: [], meta: {} }],
      invoices: [], payments: [{ amount: "12.50", row: 7 }], suppliers: undefined };
    expect(jsonbTextBytes(sample)).toBe(227);
    expect(new TextEncoder().encode(JSON.stringify(sample)).length).toBeLessThan(227);
  });
  it("F6 (candidate 2F): the 4 MiB boundary in jsonb bytes: just under and exactly at pass, one byte over is refused", async () => {
    const { jsonbTextBytes, preflightTooLarge, SLIQ_PREFLIGHT_MAX_BYTES } = await import("@/lib/sliq-import-route");
    const base = { source_sha256: "a".repeat(64), source_files: [] };
    const sized = (k: number) => ({ ...base, customers: [{ source_row_id: "C:1", notes: "x".repeat(k) }] });
    const k0 = SLIQ_PREFLIGHT_MAX_BYTES - jsonbTextBytes({ customers: [{ source_row_id: "C:1", notes: "" }] });
    const sent = (k: number) => jsonbTextBytes({ customers: sized(k).customers });
    expect(sent(k0)).toBe(SLIQ_PREFLIGHT_MAX_BYTES);
    expect(preflightTooLarge(sized(k0 - 1))).toBeNull();
    expect(preflightTooLarge(sized(k0))).toBeNull();
    expect(preflightTooLarge(sized(k0 + 1))).toMatch(/too large for one preflight/);
  });
  it("F6 (candidate 2F): a payload under 4 MiB as compact JSON but over it as jsonb text is refused in the page", async () => {
    const { jsonbTextBytes, preflightTooLarge, SLIQ_PREFLIGHT_MAX_BYTES } = await import("@/lib/sliq-import-route");
    const rows = (pad: number) => Array.from({ length: 6000 }, (_, i) => ({ source_row_id: `C:${i}`, name: "n".repeat(pad), external_ref: `${i}` }));
    // Compact length grows by 6,000 bytes per padding character: the largest padding still under the limit as compact JSON.
    const pad = Math.floor((SLIQ_PREFLIGHT_MAX_BYTES - new TextEncoder().encode(JSON.stringify({ customers: rows(0) })).length) / 6000);
    const customers = rows(pad);
    expect(new TextEncoder().encode(JSON.stringify({ customers })).length).toBeLessThanOrEqual(SLIQ_PREFLIGHT_MAX_BYTES);
    expect(jsonbTextBytes({ customers })).toBeGreaterThan(SLIQ_PREFLIGHT_MAX_BYTES);
    expect(preflightTooLarge({ source_sha256: "a".repeat(64), source_files: [], customers })).toMatch(/too large for one preflight \(6000 records/);
  });
});

describe("the done line's records created", () => {
  it("records created counts only batches that wrote: an already-imported batch (a replay carries the first run's counts) adds nothing", () => {
    expect(recordsCreated([{ already_imported: false, created: 3 }, { already_imported: false, created: 4 }])).toBe(7);
    expect(recordsCreated([{ already_imported: true, created: 3 }, { already_imported: true, created: 4 }])).toBe(0);
    expect(recordsCreated([])).toBe(0);
  });
});

describe("statement timeout (Postgres 57014; candidate 2F)", () => {
  const timeout = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
  it("each step says in plain words that nothing was written and not to keep retrying; no database text", () => {
    expect(isStatementTimeout({ code: "57014" })).toBe(true);
    expect(isStatementTimeout({ code: "57P01" })).toBe(false);
    expect(isStatementTimeout(null)).toBe(false);
    expect(statementTimeoutMessage("preflight")).toMatch(/^The preflight took longer than the database's time limit and was stopped\. Nothing was written/);
    expect(statementTimeoutMessage("batch")).toMatch(/Nothing in this batch was written: it was rolled back whole/);
    expect(statementTimeoutMessage("reconcile")).toMatch(/It only reads, so nothing was changed/);
    for (const step of ["preflight", "batch", "reconcile"] as const) {
      expect(statementTimeoutMessage(step)).toContain("Don't keep retrying");
      expect(statementTimeoutMessage(step)).not.toMatch(/canceling|57014|statement/i);
    }
  });
  it("is not retried: one call for the preflight, and a batch run stops at the timed-out batch after one call to it", async () => {
    const { sliqPreflight, sliqRunBatches } = await import("@/lib/sliq-import-route");
    const p = { source_sha256: "a".repeat(64), source_files: [], customers: [{ source_row_id: "C:1", name: "A", external_ref: "1" }] };
    let n = 0;
    const err = await sliqPreflight(async () => { n += 1; return timeout; }, p).catch((e) => e);
    expect(n).toBe(1);
    expect(isStatementTimeout(err)).toBe(true);
    n = 0;
    const run = await sliqRunBatches(async () => { n += 1; return timeout; }, p, "live");
    expect(n).toBe(1);
    expect(run.failedAt).toBe(0);
    expect(isStatementTimeout(run.error as { code?: string })).toBe(true);
  });
  it("the card shows these words for the preflight, a batch and the reconciliation", async () => {
    // The preflight and the batches go through lib/sliq-card's steps (tests/unit/sliq-card-steps.test.ts pins their words); the
    // reconciliation read is in the component.
    const src = readFileSync(path.resolve(__dirname, "../../components/sliq-import.tsx"), "utf8");
    expect(src).toContain(`statementTimeoutMessage("reconcile")`);
    expect(src).toContain("runSliqPreflightStep(rpc, payload, allowInvGap)");
    expect(src).toContain("runSliqImportStep(rpc, payload, label, startAt, allowInvGap, setProgress)");
    const lib = readFileSync(path.resolve(__dirname, "../../lib/sliq-card.ts"), "utf8");
    for (const step of ["preflight", "batch"]) expect(lib).toContain(`statementTimeoutMessage("${step}")`);
  });
});
