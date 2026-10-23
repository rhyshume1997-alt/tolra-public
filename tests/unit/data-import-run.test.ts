/**
 * Admin > Data: how a file is sent (lib/data-import.ts). A small import is one call; a large one is staged, validated whole and committed
 * in parts, stopping at the first part that fails; an undo runs one part per call until it says done.
 */
import { describe, expect, it } from "vitest";

import {
  IMPORT_PART_WEIGHT, type Rpc, chunkPayload, commitParts, commitSingle, runDryRun, undoImport,
} from "@/lib/data-import";
import type { ImportPayload } from "@/lib/import-build";
import { describeMessage, isClean, nextNumbers, previewRows } from "@/lib/import-preview";
import type { BuiltImport } from "@/lib/import-build";

const base = { file_name: "f.xlsx", file_sha256: "b".repeat(64) };
const customers = (n: number) => Array.from({ length: n }, (_, i) => ({ row: i + 2, name: `Customer ${i}` }));
const invoice = (ref: string, lines: number) => ({ row: 2, invoice_ref: ref, lines: Array.from({ length: lines }, () => ({ description: "x" })) });

type Call = { fn: string; args: Record<string, unknown> };
function recorder(answer: (call: Call, n: number) => { data?: unknown; error?: { message: string; code?: string } }) {
  const calls: Call[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    const out = answer({ fn, args }, calls.length);
    return { data: out.data ?? null, error: out.error ?? null };
  };
  return { rpc, calls };
}

describe("chunkPayload", () => {
  it("cuts by weight (a record 1, each line 1, an invoice 1 more), in kind order, every part naming the file", () => {
    const payload: ImportPayload = { ...base, customers: customers(5), invoices: [invoice("INV-1", 2), invoice("INV-2", 2)] };
    const parts = chunkPayload(payload, 6);
    expect(parts.map((p) => [p.customers?.length ?? 0, p.invoices?.length ?? 0])).toEqual([[5, 0], [0, 1], [0, 1]]);
    for (const part of parts) expect(part).toMatchObject(base);
  });

  it("every record goes in exactly one part", () => {
    const payload: ImportPayload = { ...base, customers: customers(1203) };
    const parts = chunkPayload(payload);
    expect(parts).toHaveLength(Math.ceil(1203 / IMPORT_PART_WEIGHT));
    expect(parts.flatMap((p) => p.customers ?? [])).toEqual(payload.customers);
  });
});

describe("the dry run", () => {
  it("a small file is one dry-run call", async () => {
    const { rpc, calls } = recorder(() => ({ data: { ok: true } }));
    const { path } = await runDryRun(rpc, { ...base, customers: customers(10) }, { importId: "i", opId: "o" });
    expect(path.mode).toBe("single");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ fn: "import_company_data", args: { p_dry_run: true, p_client_op_id: "o" } });
  });

  it("a large file is staged part by part, then validated whole (never a single dry run: it would pass 8 s)", async () => {
    const { rpc, calls } = recorder((c) => (c.fn === "import_validate" ? { data: { ok: true, parts: 5 } } : { data: {} }));
    const progress: string[] = [];
    const { path, result } = await runDryRun(rpc, { ...base, customers: customers(2300) }, { importId: "imp", opId: "o" }, (p) => progress.push(`${p.phase}:${p.done}/${p.total}`));
    expect(path.mode).toBe("parts");
    expect(calls.map((c) => c.fn)).toEqual(["import_stage_part", "import_stage_part", "import_stage_part", "import_stage_part", "import_stage_part", "import_validate"]);
    expect(calls.slice(0, 5).map((c) => c.args.p_part)).toEqual([1, 2, 3, 4, 5]);
    expect(calls[5].args).toMatchObject({ p_import_id: "imp", p_part_weight: IMPORT_PART_WEIGHT, p_client_op_id: "o" });
    expect(progress.at(-1)).toBe("checking:5/5");
    expect(result.ok).toBe(true);
  });

  it("a database refusal comes up with its message and code", async () => {
    const { rpc } = recorder(() => ({ error: { message: "Only an admin can import data.", code: "42501" } }));
    await expect(runDryRun(rpc, { ...base, customers: customers(1) }, { importId: "i", opId: "o" })).rejects.toMatchObject({ message: "Only an admin can import data.", code: "42501" });
  });
});

describe("a check that failed on the road is sent once more, with the same key", () => {
  it("a 502 from the gateway or a dropped connection: the dry run is repeated; a database refusal is not", async () => {
    let n = 0;
    const flaky = recorder(() => { n += 1; return n === 1 ? { error: { message: "An invalid response was received from the upstream server" } } : { data: { ok: true } }; });
    const { result } = await runDryRun(flaky.rpc, { ...base, customers: customers(3) }, { importId: "i", opId: "same-key" });
    expect(result.ok).toBe(true);
    expect(flaky.calls.map((c) => c.args.p_client_op_id)).toEqual(["same-key", "same-key"]);

    const refused = recorder(() => ({ error: { message: "Only an admin can import data.", code: "42501" } }));
    await expect(runDryRun(refused.rpc, { ...base, customers: customers(3) }, { importId: "i", opId: "k" })).rejects.toMatchObject({ code: "42501" });
    expect(refused.calls).toHaveLength(1);
  });

  it("a part that is committed is never sent again by itself: the admin's Retry this part does that", async () => {
    const { rpc, calls } = recorder(() => ({ error: { message: "Failed to fetch" } }));
    const out = await commitParts(rpc, "imp", new Map());
    expect(out.failed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("an answer that is not a record is refused, never read as clean; a record sent as JSON text is read", async () => {
    const { rpc } = recorder(() => ({ data: "not json" }));
    await expect(runDryRun(rpc, { ...base, customers: customers(1) }, { importId: "i", opId: "k" })).rejects.toThrow(/answer wasn't one this page understands/);
    const text = recorder(() => ({ data: JSON.stringify({ ok: true }) }));
    expect((await runDryRun(text.rpc, { ...base, customers: customers(1) }, { importId: "i", opId: "k" })).result.ok).toBe(true);
  });
});

describe("committing", () => {
  it("a small import is one call with its own key", async () => {
    const { rpc, calls } = recorder(() => ({ data: { ok: true, committed: true } }));
    await commitSingle(rpc, { ...base, customers: customers(2) }, "key-1");
    expect(calls).toEqual([{ fn: "import_company_data", args: { p_payload: { ...base, customers: customers(2) }, p_dry_run: false, p_client_op_id: "key-1" } }]);
  });

  it("parts go in one call each until the last; a retry of a part reuses its key", async () => {
    const keys = new Map<number, string>();
    let part = 0;
    const { rpc, calls } = recorder(() => { part += 1; return { data: { ok: true, part, parts: 3, parts_committed: part } }; });
    const progress: number[] = [];
    const out = await commitParts(rpc, "imp", keys, (p) => progress.push(p.done));
    expect(out.failed).toBe(false);
    expect(calls).toHaveLength(3);
    expect(progress).toEqual([1, 2, 3]);
    expect([...keys.keys()]).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.args.p_client_op_id)).toEqual([keys.get(1), keys.get(2), keys.get(3)]);
  });

  it("stops at the first part that fails and says which, so the admin is offered Undo", async () => {
    let n = 0;
    const { rpc, calls } = recorder(() => { n += 1; return n === 2 ? { data: { ok: false, part: 2, parts: 4, parts_committed: 1, errors: [{ message: "nope" }] } } : { data: { ok: true, part: n, parts: 4, parts_committed: n } }; });
    const out = await commitParts(rpc, "imp", new Map());
    expect(out.failed).toBe(true);
    expect(out.last?.parts_committed).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("an error in a part (timeout, network) is a failed part too", async () => {
    let n = 0;
    const { rpc } = recorder(() => { n += 1; return n === 1 ? { data: { ok: true, parts: 2, parts_committed: 1 } } : { error: { message: "canceling statement due to statement timeout", code: "57014" } }; });
    const out = await commitParts(rpc, "imp", new Map());
    expect(out.failed).toBe(true);
    expect(out.error?.message).toContain("statement timeout");
  });
});

describe("retrying a part that failed", () => {
  it("sends the same key again, from that part, so a part that did go in (its answer lost) is not committed twice", async () => {
    const keys = new Map<number, string>();
    let call = 0;
    const { rpc, calls } = recorder(() => {
      call += 1;
      if (call === 3) return { error: { message: "Failed to fetch" } }; // part 3's answer is lost
      // The retry of part 3 is answered from the first attempt (076 replays a part it already committed under that key).
      const part = call <= 2 ? call : call === 4 ? 3 : call - 1;
      return { data: { ok: true, part, parts: 4, parts_committed: part, ...(call === 4 ? { replayed: true } : {}) } };
    });
    const first = await commitParts(rpc, "imp", keys);
    expect(first.failed).toBe(true);
    expect(first.part).toBe(3);
    const failedKey = keys.get(3);
    expect(failedKey).toBeTruthy();

    const retry = await commitParts(rpc, "imp", keys, undefined, first.part);
    expect(retry.failed).toBe(false);
    // Part 3 again with its own key (not a new one), then part 4 with a new one: nothing before part 3 is sent again.
    expect(calls.map((c) => c.args.p_client_op_id)).toEqual([keys.get(1), keys.get(2), failedKey, failedKey, keys.get(4)]);
    expect(keys.size).toBe(4);
    expect(new Set(calls.map((c) => c.args.p_client_op_id)).size).toBe(4);
  });
});

describe("undo", () => {
  it("one part per call, last first, until it says undone", async () => {
    const answers = [{ status: "undoing", parts_left: 2 }, { status: "undoing", parts_left: 1 }, { status: "undone", parts_left: 0, refused_count: 1 }];
    let i = 0;
    const { rpc, calls } = recorder(() => ({ data: answers[i++] }));
    const out = await undoImport(rpc, "imp");
    expect(out.status).toBe("undone");
    expect(out.refused_count).toBe(1);
    expect(calls.map((c) => c.fn)).toEqual(["import_undo", "import_undo", "import_undo"]);
    expect(new Set(calls.map((c) => c.args.p_client_op_id)).size).toBe(3);
  });

  it("an import nothing of which was committed is cancelled in one call", async () => {
    const { rpc, calls } = recorder(() => ({ data: { status: "cancelled" } }));
    expect((await undoImport(rpc, "imp")).status).toBe("cancelled");
    expect(calls).toHaveLength(1);
  });
});

describe("preview", () => {
  const built = {
    records: { customers: 2, suppliers: 0, stock: 0, quotes: 0, sales_orders: 0, jobs: 2, purchase_orders: 0, invoices: 1, payments: 1 },
    payload: { ...base, jobs: [{ row: 2, job_no: "J1", quote_ref: "Q1" }, { row: 3, job_no: "J2" }], invoices: [{ row: 2, invoice_ref: "INV-1", job_no: "J9" }] },
    problems: [], notices: [], order: [],
  } as unknown as BuiltImport;

  it("per kind: created, matched (skipped), linked (given a link and not warned as not linked), problems, warnings", () => {
    const rows = previewRows(built, {
      ok: true,
      counts: { customers: { created: 1, matched_existing: 1, errors: 0 }, jobs: { created: 2, matched_existing: 0 }, invoices: { created: 1 }, payments: { created: 1 } },
      warnings: [{ kind: "invoices", row: 2, field: "job_no", message: "Not linked to job J9 (not found, or an internal job)." }],
    });
    expect(rows.find((r) => r.kind === "customers")).toMatchObject({ created: 1, matched: 1, linked: null });
    expect(rows.find((r) => r.kind === "jobs")).toMatchObject({ created: 2, linked: 1 }); // only J1 was given a link
    expect(rows.find((r) => r.kind === "invoices")).toMatchObject({ created: 1, linked: 0, warnings: 1 });
    expect(rows.find((r) => r.kind === "payments")).toMatchObject({ created: 1, linked: 1 });
  });

  it("one line per problem: the kind, the row, the field and the message", () => {
    expect(describeMessage({ kind: "invoices", row: 4, field: "invoice_ref", message: "Invoice number is required." })).toBe("Invoices, row 4, invoice_ref: Invoice number is required.");
    expect(describeMessage({ kind: null, row: null, field: null, message: "The database refused the import." })).toBe("The database refused the import.");
  });

  it("confirm needs a clean dry run: ok, no problem, and no problem found before the database was asked", () => {
    expect(isClean({ ok: true, error_count: 0 }, 0)).toBe(true);
    expect(isClean({ ok: false, error_count: 2 }, 0)).toBe(false);
    expect(isClean({ ok: true, error_count: 0 }, 1)).toBe(false);
    expect(isClean(null, 0)).toBe(false);
  });

  it("the next numbers continue after the highest imported", () => {
    expect(nextNumbers({ INV: 0, QUO: 9, PO: 99, CRD: 7 })).toEqual(["INV-0001", "QUO-0010", "PO-0100"]);
  });
});
