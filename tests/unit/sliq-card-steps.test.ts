/**
 * Candidate 2F final pass: the SliQ card's decisions, extracted from components/sliq-import.tsx into lib/sliq-card.ts so they are
 * unit-tested (the red team found 21 component mutants no test saw). Pins: the INV-gap override is off unless the admin ticks the
 * box, and a tick voids the preflight; no write before a clean preflight; stop at the first failed batch; the 57014 words; the plan
 * must carry every row (suppliers included) or nothing is sent. The last block checks the component is wired to these.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MISSING_152, afterInvGapChange, canStartImport, importBlockers, invGapOptions, planCountProblems, runSliqImportStep, runSliqPreflightStep, statementTimeoutMessage,
} from "@/lib/sliq-card";
import { type Rpc, type SliqPayload, type SliqPreflight, SLIQ_PREFLIGHT_MAX_RECORDS } from "@/lib/sliq-import-route";

const base = { source_sha256: "a".repeat(64), source_files: [] };
const payload = (n: number, suppliers = 0): SliqPayload => ({
  ...base,
  customers: [{ source_row_id: "C:A", name: "A Ltd", external_ref: "A" }],
  suppliers: Array.from({ length: suppliers }, (_, i) => ({ source_row_id: `S:${i}`, name: `S ${i}`, external_ref: `${i}` })),
  invoices: Array.from({ length: n }, (_, i) => ({ source_row_id: `I:INV-${i + 1}`, invoice_ref: `INV-${i + 1}`, customer: "A Ltd", total: "1.00" })),
  payments: Array.from({ length: n }, (_, i) => ({ source_row_id: `P:${i + 1}`, invoice_ref: `INV-${i + 1}`, amount: "1.00" })),
});
const okBatch = (args: Record<string, unknown>) => ({ data: { ok: true, entity: args.p_entity, batch_no: args.p_batch_no, created: 1, rows: 1 }, error: null });
const timeout = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
const goodPreflight = { ok: true, error_count: 0, errors: [], counts: {}, money: {} } as unknown as SliqPreflight;

describe("INV-gap override", () => {
  it("is on only for a strict true: unset, false and look-alikes are off", () => {
    for (const v of [undefined, null, false, "true", 1, {}, []]) expect(invGapOptions(v), String(v)).toEqual({ allowInvGap: false });
    expect(invGapOptions(true)).toEqual({ allowInvGap: true });
  });
  it("changing the box voids the preflight; a preflighted or failed card goes back to checked", () => {
    expect(afterInvGapChange("preflighted")).toEqual({ phase: "checked", clearPreflight: true, clearFailure: true });
    expect(afterInvGapChange("failed")).toEqual({ phase: "checked", clearPreflight: true, clearFailure: true });
    for (const ph of ["idle", "checked", "done"] as const) expect(afterInvGapChange(ph)).toEqual({ phase: ph, clearPreflight: true, clearFailure: false });
  });
  it("the preflight sends false unless the box is ticked", async () => {
    const seen: unknown[] = [];
    const rpc: Rpc = async (_f, a) => { seen.push(a.p_allow_inv_gap); return { data: goodPreflight, error: null }; };
    await runSliqPreflightStep(rpc, payload(1), false);
    await runSliqPreflightStep(rpc, payload(1), true);
    expect(seen).toEqual([false, true]);
  });
  it("every batch sends false unless the box is ticked", async () => {
    const seen: unknown[] = [];
    const rpc: Rpc = async (_f, a) => { seen.push(a.p_allow_inv_gap); return okBatch(a); };
    const off = await runSliqImportStep(rpc, payload(600), "live", 0, false);
    expect(off.failedAt).toBeNull();
    const n = seen.length;
    expect(n).toBeGreaterThan(1);
    expect(seen.every((v) => v === false)).toBe(true);
    await runSliqImportStep(rpc, payload(600), "live", 0, true);
    expect(seen.slice(n)).toHaveLength(n);
    expect(seen.slice(n).every((v) => v === true)).toBe(true);
  });
});

describe("no write before a clean preflight", () => {
  const blockers = (preflight: SliqPreflight | null, preflighted = true) => importBlockers({ preflighted, preflight, orphanPayments: 0, orphanCredits: 0, labelValid: true, running: false });
  it("Import can start only from a clean preflight, with nothing blocking, not while running", () => {
    expect(canStartImport("preflighted", blockers(goodPreflight), false)).toBe(true);
    expect(canStartImport("preflighted", blockers(goodPreflight), true)).toBe(false);
    expect(canStartImport("preflighted", blockers({ ...goodPreflight, ok: false, error_count: 1 }), false)).toBe(false);
    expect(canStartImport("preflighted", blockers(null), false)).toBe(false);
    for (const ph of ["idle", "checked", "importing", "done", "failed"] as const) expect(canStartImport(ph, [], false), ph).toBe(false);
  });
  it("a file set too large for one preflight is refused in the page: nothing is sent", async () => {
    let calls = 0;
    const big = { ...base, customers: Array.from({ length: SLIQ_PREFLIGHT_MAX_RECORDS + 1 }, (_, i) => ({ source_row_id: `C:${i}` })) };
    const out = await runSliqPreflightStep(async () => { calls += 1; return { data: goodPreflight, error: null }; }, big, false);
    expect(calls).toBe(0);
    expect(out.message).toMatch(/too large for one preflight/);
  });
  it("a missing release 152 and a timeout are said in plain words", async () => {
    expect((await runSliqPreflightStep(async () => ({ data: null, error: { code: "42883", message: "function x does not exist" } }), payload(1), false)).message).toBe(MISSING_152);
    let calls = 0;
    const t = await runSliqPreflightStep(async () => { calls += 1; return timeout; }, payload(1), false);
    expect(t.message).toBe(statementTimeoutMessage("preflight"));
    expect(calls).toBe(1);
  });
});

describe("the import run", () => {
  it("stops at the first batch the database answers not ok: no later batch is sent", async () => {
    const calls: unknown[] = [];
    const rpc: Rpc = async (_f, a) => { calls.push(a); return calls.length === 2 ? { data: { ok: false, errors: [{ source_row_id: "I:INV-9", message: "refused" }] }, error: null } : okBatch(a); };
    const out = await runSliqImportStep(rpc, payload(600), "live", 0, false);
    expect(out.failedAt).toBe(1);
    expect(calls).toHaveLength(2);
    expect(out.failure).toBe("I:INV-9 refused");
  });
  it("a timed-out batch: one call, stopped there, the batch words", async () => {
    let calls = 0;
    const out = await runSliqImportStep(async () => { calls += 1; return timeout; }, payload(600), "live", 0, false);
    expect(calls).toBe(1);
    expect(out.failedAt).toBe(0);
    expect(out.failure).toBe(statementTimeoutMessage("batch"));
  });
  it("a retry starts from the failed batch", async () => {
    const first: number[] = [];
    await runSliqImportStep(async (_f, a) => { first.push(Number(a.p_batch_no)); return okBatch(a); }, payload(600), "live", 0, false);
    const again: number[] = [];
    await runSliqImportStep(async (_f, a) => { again.push(Number(a.p_batch_no)); return okBatch(a); }, payload(600), "live", 2, false);
    expect(again).toEqual(first.slice(2));
  });
});

describe("the plan carries every row (suppliers are not reconciled in the database, so this is their count check)", () => {
  it("matches for a payload with suppliers, credit notes and an orphan payment", () => {
    const p = { ...payload(30, 7), credit_notes: [{ source_row_id: "N:1", invoice_ref: "INV-3", total: "0.10" }], payments: [...payload(30).payments!, { source_row_id: "P:X", invoice_ref: "INV-NOPE", amount: "1.00" }] };
    expect(planCountProblems(p)).toEqual([]);
    expect(planCountProblems(p, 2)).toEqual([]);
  });
  it("a plan that does not carry every row sends nothing and says why", async () => {
    let calls = 0;
    const out = await runSliqImportStep(async (_f, a) => { calls += 1; return okBatch(a); }, payload(5, 7), "live", 0, false, undefined, ["suppliers: 7 in the files but 0 in the import plan"]);
    expect(calls).toBe(0);
    expect(out.failedAt).toBe(0);
    expect(out.failure).toBe("Nothing was sent: the import plan does not carry every row of the files (suppliers: 7 in the files but 0 in the import plan).");
  });
  it("every supplier goes to the database in the run", async () => {
    const sent: string[] = [];
    await runSliqImportStep(async (_f, a) => { for (const s of ((a.p_rows as { suppliers?: { source_row_id: string }[] }).suppliers ?? [])) sent.push(s.source_row_id); return okBatch(a); }, payload(5, 7), "live", 0, false);
    expect(sent).toEqual(Array.from({ length: 7 }, (_, i) => `S:${i}`));
  });
});

describe("the component is wired to these decisions", () => {
  const src = readFileSync(path.resolve(__dirname, "../../components/sliq-import.tsx"), "utf8");
  it("the INV-gap box starts unticked, its change goes through afterInvGapChange, and no call forces the override", () => {
    expect(src).toMatch(/const \[allowInvGap, setAllowInvGap\] = useState\(false\);/);
    expect(src).toContain("const next = afterInvGapChange(phase);\n            if (next.clearPreflight) setPreflight(null);\n            setPhase(next.phase);\n            if (next.clearFailure) { setFailedAt(null); setFailure(null); }");
    expect(src).not.toMatch(/allowInvGap:\s*true/);
    expect(src).not.toMatch(/\bsliqRunBatches\(|\bsliqPreflight\(/);
  });
  it("the preflight, the import and the Import button use the lib steps", () => {
    expect(src).toContain("runSliqPreflightStep(rpc, payload, allowInvGap)");
    expect(src).toContain("runSliqImportStep(rpc, payload, label, startAt, allowInvGap, setProgress)");
    expect(src).toContain("const ready = canStartImport(phase, blockers, importing);");
    expect(src).toContain("disabled={!ready || importing} onClick={() => setConfirm(true)}");
    expect(src).toContain("...(payload ? planCountProblems(payload) : [])");
  });
});
