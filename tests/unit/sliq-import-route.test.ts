import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildSliqPayload, sourceKeyText, sourceTotalsFromPayload } from "@/lib/sliq-import-build";
import { SLIQ_BATCH_MAX_LINES, SLIQ_BATCH_MAX_RECORDS, type SliqPayload, isRunLabel, parseSliqPayload, planSliqBatches, sliqRunBatches } from "@/lib/sliq-import-route";
import { validateSliqExport } from "@/lib/sliq-validate";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const root = path.resolve(__dirname, "../..");

function payload(invoices: number, paymentsPer: number, lines = 0): SliqPayload {
  const p: SliqPayload = { source_sha256: "a".repeat(64), source_files: [{ entity: "invoices", name: "i.csv", sha256: "b".repeat(64) }], customers: [], suppliers: [], invoices: [], payments: [] };
  for (let i = 0; i < 30; i += 1) p.customers!.push({ source_row_id: `C:${i}`, name: `C ${i}` });
  for (let i = 0; i < invoices; i += 1) {
    p.invoices!.push({ source_row_id: `I:${i}`, invoice_ref: `INV-${i}`, total: "10.00", lines: Array.from({ length: lines }, () => ({ description: "x" })) });
    for (let j = 0; j < paymentsPer; j += 1) p.payments!.push({ source_row_id: `P:${i}:${j}`, invoice_ref: `INV-${i}`, amount: "1.00" });
  }
  return p;
}

describe("planSliqBatches", () => {
  it("orders customers, suppliers, invoices; every payment rides with its invoice; no batch over the weight or the server's limits", () => {
    const p = payload(300, 2, 3);
    const { batches, orphanPayments } = planSliqBatches(p, 100);
    expect(orphanPayments).toEqual([]);
    const order = batches.map((b) => b.entity);
    expect(order).toEqual([...order].sort((a, b) => ["customers", "suppliers", "invoices"].indexOf(a) - ["customers", "suppliers", "invoices"].indexOf(b)));
    for (const b of batches) {
      expect(b.weight).toBeLessThanOrEqual(100);
      expect(b.records).toBeLessThanOrEqual(SLIQ_BATCH_MAX_RECORDS);
      expect(b.lines).toBeLessThanOrEqual(SLIQ_BATCH_MAX_LINES);
      const refs = new Set((b.rows.invoices ?? []).map((i) => i.invoice_ref));
      for (const pay of b.rows.payments ?? []) expect(refs.has(pay.invoice_ref)).toBe(true);
    }
    expect(batches.flatMap((b) => b.rows.payments ?? []).length).toBe(600);
    expect(batches.filter((b) => b.entity === "invoices").map((b) => b.batchNo)).toEqual(batches.filter((b) => b.entity === "invoices").map((_, i) => i + 1));
  });

  it("is deterministic (a retry sends the very same batches) and keeps payments of an unknown invoice out", () => {
    const p = payload(50, 1);
    p.payments!.push({ source_row_id: "P:orphan", invoice_ref: "INV-NOPE", amount: "1.00" });
    expect(JSON.stringify(planSliqBatches(p, 40))).toBe(JSON.stringify(planSliqBatches(structuredClone(p), 40)));
    expect(planSliqBatches(p, 40).orphanPayments.map((r) => r.source_row_id)).toEqual(["P:orphan"]);
  });

  it("an invoice heavier than the weight still goes alone in one batch", () => {
    const { batches } = planSliqBatches(payload(2, 0, 50), 10);
    expect(batches.filter((b) => b.entity === "invoices").map((b) => b.rows.invoices!.length)).toEqual([1, 1]);
  });
});

describe("sliqRunBatches", () => {
  it("stops at the first batch that fails and resumes from it with the same arguments", async () => {
    const calls: Record<string, unknown>[] = [];
    let fail = true;
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      calls.push(args);
      if (args.p_entity === "invoices" && args.p_batch_no === 2 && fail) return { data: null, error: { message: "boom", code: "57014" } };
      return { data: { ok: true, entity: args.p_entity, batch_no: args.p_batch_no, created: 1, rows: 1 }, error: null };
    };
    const p = payload(40, 1);
    const first = await sliqRunBatches(rpc, p, "live", undefined, 0, 20);
    expect(first.failedAt).not.toBeNull();
    const failed = calls[calls.length - 1];
    fail = false;
    const again = await sliqRunBatches(rpc, p, "live", undefined, first.failedAt!, 20);
    expect(again.failedAt).toBeNull();
    expect(JSON.stringify(calls[calls.length - again.results.length])).toBe(JSON.stringify(failed));
    expect(calls.every((c) => c.p_dry_run === false && c.p_run_label === "live" && Array.isArray(c.p_source_files))).toBe(true);
  });

  it("retries a failure of the road once with the same arguments", async () => {
    let n = 0;
    const rpc = async () => (n++ === 0 ? { data: null, error: { message: "fetch failed" } } : { data: { ok: true, created: 0, rows: 1 }, error: null });
    const out = await sliqRunBatches(rpc as never, { source_sha256: "a".repeat(64), source_files: [], customers: [{ source_row_id: "C:1", name: "x" }] }, "live");
    expect(out.failedAt).toBeNull();
    expect(n).toBe(2);
  });
});

describe("payload file and labels", () => {
  it("parseSliqPayload refuses a file without source key, source files or row ids", () => {
    expect(() => parseSliqPayload("{")).toThrow(/not JSON/);
    expect(() => parseSliqPayload(JSON.stringify({ customers: [] }))).toThrow(/source_sha256/);
    expect(() => parseSliqPayload(JSON.stringify({ source_sha256: "a".repeat(64), customers: [] }))).toThrow(/source_files/);
    const files = [{ entity: "customers", name: "c.csv", sha256: "b".repeat(64) }];
    expect(() => parseSliqPayload(JSON.stringify({ source_sha256: "a".repeat(64), source_files: files, customers: [{ name: "x" }] }))).toThrow(/source_row_id/);
    expect(() => parseSliqPayload(JSON.stringify({ source_sha256: "a".repeat(64), source_files: files, stock: [] }))).toThrow(/Unknown section/);
    expect(parseSliqPayload(JSON.stringify({ source_sha256: "A".repeat(64), source_files: files, customers: [{ source_row_id: "C:1" }] })).source_sha256).toBe("a".repeat(64));
  });
  it("run labels", () => {
    expect(["live", "live-2", "r1"].every(isRunLabel)).toBe(true);
    expect(["", "Live", "-x", "a b", "x".repeat(41)].some(isRunLabel)).toBe(false);
  });
});

describe("buildSliqPayload (after the validator says ok)", () => {
  const enc = new TextEncoder();
  const mapping = {
    version: 1, confirmed: true, dateFormat: "DD/MM/YYYY",
    entities: {
      customers: { file: "c.csv", columns: { key: "Acc", name: "Name" } },
      suppliers: { file: "s.csv", columns: { key: "Acc", name: "Name" } },
      invoices: { file: "i.csv", columns: { ref: "No", customerKey: "Acc", date: "Date", gross: "Gross" } },
      payments: { file: "p.csv", columns: { invoiceRef: "No", date: "Date", amount: "Amount" } },
    },
  };
  const files = {
    customers: { name: "c.csv", bytes: enc.encode("Acc,Name\r\nA1,Alpha Ltd\r\nB2,Beta Ltd\r\n") },
    suppliers: { name: "s.csv", bytes: enc.encode("Acc,Name\r\nS1,Steel Ltd\r\n") },
    invoices: { name: "i.csv", bytes: enc.encode("No,Acc,Date,Gross\r\nINV-10,A1,03/02/2026,120.00\r\nINV-11,B2,04/02/2026,60.50\r\n") },
    payments: { name: "p.csv", bytes: enc.encode("No,Date,Amount\r\nINV-10,05/02/2026,60.00\r\nINV-10,05/02/2026,60.00\r\n") },
  };

  it("maps the confirmed columns; the source key is the SHA-256 p152 recomputes from the per-file hashes", async () => {
    expect(validateSliqExport({ files, mapping }).ok).toBe(false); // two identical payments without a receipt key: the validator refuses them
    const ok = { ...files, payments: { name: "p.csv", bytes: enc.encode("No,Date,Amount\r\nINV-10,05/02/2026,60.00\r\nINV-10,06/02/2026,60.00\r\n") } };
    expect(validateSliqExport({ files: ok, mapping }).ok).toBe(true);
    const { payload, sourceFiles } = await buildSliqPayload(ok, mapping as never);
    expect(sourceFiles.map((f) => f.sha256)).toEqual((["customers", "invoices", "payments", "suppliers"] as const).map((e) => sha(Buffer.from(ok[e].bytes).toString("latin1"))));
    expect(payload.source_sha256).toBe(sha(sourceKeyText(sourceFiles)));
    expect(sourceKeyText(sourceFiles).split("\n").map((l) => l.split(":")[0])).toEqual(["customers", "invoices", "payments", "suppliers"]);
    expect(payload.customers).toEqual([{ source_row_id: "C:A1", name: "Alpha Ltd", external_ref: "A1" }, { source_row_id: "C:B2", name: "Beta Ltd", external_ref: "B2" }]);
    expect(payload.invoices![0]).toEqual({ source_row_id: "I:INV-10", invoice_ref: "INV-10", customer: "Alpha Ltd", invoice_date: "2026-02-03", total: "120.00", status: "sent" });
    expect(payload.payments!.map((p) => p.source_row_id)).toEqual(["P:INV-10|2026-02-05|60.00|1", "P:INV-10|2026-02-06|60.00|1"]);
    const totals = sourceTotalsFromPayload(payload);
    expect(totals).toMatchObject({ counts: { customers: 2, invoices: 2, payments: 2, credit_notes: 0 }, invoiceTotalPence: 18050, paymentsTotalPence: 12000,
      outstandingPence: 6050, customerBalancesPence: { "Alpha Ltd": 0, "Beta Ltd": 6050 }, invoiceRefMin: 10, invoiceRefMax: 11 });
    expect(totals.files.length).toBe(4);
  });
});

describe("p152 files", () => {
  it("the release carries the proposal verbatim, and the rehearsal CLI's hosted-database refusal is unchanged", () => {
    const proposal = readFileSync(path.join(root, "supabase/proposals/p152_sliq_import_route.sql"), "utf8");
    const release = readFileSync(path.join(root, "supabase/release/152_sliq_import_route.release.sql"), "utf8");
    expect(release.includes(proposal)).toBe(true);
    expect(release.trimStart().startsWith("--")).toBe(true);
    expect(release.trimEnd().endsWith("COMMIT;")).toBe(true);
    const guard = readFileSync(path.join(root, "scripts/sliq-import/guard.mjs"), "utf8");
    expect(guard).toMatch(/supabase\.co/);
  });
});
