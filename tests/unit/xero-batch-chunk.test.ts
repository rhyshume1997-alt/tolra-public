/**
 * Xero batch send (E3): the chunk runner against an in-memory send table that behaves like 084 (one row per document, the engine claims
 * only a pending row; a first attempt for `only`, the oldest due pending row otherwise). Proves the batch never re-sends a sent
 * document, enqueues once, retries only failed rows in failed-only mode, pauses on a rate limit and reports per document.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RunSummary } from "@/lib/integrations/engine";
import { type BatchDoc, type BatchDocType, type BatchSend } from "@/lib/integrations/xero/batch";
import { type ChunkDeps, runBatchChunk } from "@/lib/integrations/xero/batch-server";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const doc = (id: string, over: Partial<BatchDoc> = {}): BatchDoc => ({ docType: "invoice", id, ref: `INV-${id}`, customer: "Acme", date: "2026-10-05", status: "issued", subtotal: 1, vat: 0.2, total: 1.2, ...over });
const row = (id: string, status: BatchSend["status"], over: Partial<BatchSend> = {}): BatchSend =>
  ({ id: `s-${id}`, docType: "invoice", docId: id, status, attempts: status === "pending" ? 0 : 1, externalId: status === "sent" ? "x" : null, externalNumber: null, lastError: null, nextAttemptAt: null, sentAt: null, ...over });

function world(docs: BatchDoc[], sends: BatchSend[], opts: { imported?: string[]; outcome?: (id: string) => "sent" | "failed" | "rate_limited" | "blocked_unmapped" } = {}) {
  const table = new Map(sends.map((s) => [s.docId, { ...s }]));
  const log = { runs: [] as Array<string | null>, enqueued: [] as string[], retried: [] as string[], pushed: [] as string[] };
  const outcome = opts.outcome ?? (() => "sent" as const);
  const deps: ChunkDeps = {
    loadDoc: async (_t: BatchDocType, id: string) => docs.find((d) => d.id === id) ?? null,
    loadSend: async (_t, id) => (table.get(id) ? { ...table.get(id)! } : null),
    isImported: async (id) => (opts.imported ?? []).includes(id),
    enqueue: async (d) => { log.enqueued.push(d.id); if (!table.has(d.id)) table.set(d.id, row(d.id, "pending")); },
    retry: async (sendId) => { const r = [...table.values()].find((x) => x.id === sendId)!; log.retried.push(r.docId); r.status = "pending"; },
    run: async (only) => {
      log.runs.push(only?.docId ?? null);
      const summary: RunSummary = { sent: 0, failed: 0, needsCheck: 0, retryLater: 0, skipped: 0, blocked: null, unmapped: [] };
      const pending = [...table.values()].filter((r) => r.status === "pending" && (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= NOW)
        && (!only || (r.docId === only.docId && r.attempts === 0)));
      const r = pending[0];
      if (!r) return summary;
      r.attempts += 1;
      const o = outcome(r.docId);
      log.pushed.push(r.docId);
      if (o === "sent") { r.status = "sent"; r.externalId = "x1"; summary.sent = 1; }
      else if (o === "failed") { r.status = "failed"; r.lastError = "Xero said no"; summary.failed = 1; }
      else if (o === "rate_limited") { r.status = "pending"; r.nextAttemptAt = "2026-10-30T12:00:20Z"; summary.blocked = "rate_limited"; }
      else summary.blocked = "unmapped";
      return summary;
    },
    dueQueue: async () => [...table.values()].filter((r) => r.status === "pending" && (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= NOW)).map((r) => ({ ...r })),
    loadSendById: async (id) => { const r = [...table.values()].find((x) => x.id === id); return r ? { ...r } : null; },
    now: () => NOW,
  };
  return { deps, table, log };
}
const items = (...ids: string[]) => ids.map((id) => ({ docType: "invoice" as const, id }));

describe("unsent mode", () => {
  it("queues a document that has no row once and sends it; reports each document", async () => {
    const w = world([doc("a"), doc("b")], []);
    const out = await runBatchChunk(w.deps, items("a", "b"), "unsent");
    expect(w.log.enqueued).toEqual(["a", "b"]);
    expect(out.results.map((r) => [r.docId, r.outcome])).toEqual([["a", "sent"], ["b", "sent"]]);
    expect(out.stopped).toBeNull();
  });

  it("never pushes a document already sent (a second run after a lost response, a double click)", async () => {
    const w = world([doc("a")], [row("a", "sent")]);
    const out = await runBatchChunk(w.deps, items("a", "a"), "unsent");
    expect(w.log.runs).toEqual([]);
    expect(w.log.enqueued).toEqual([]);
    expect(out.results.every((r) => r.outcome === "sent" && /Already sent/.test(r.detail ?? ""))).toBe(true);
  });

  it("running the same chunk twice pushes each document once", async () => {
    const w = world([doc("a"), doc("b")], []);
    await runBatchChunk(w.deps, items("a", "b"), "unsent");
    await runBatchChunk(w.deps, items("a", "b"), "unsent");
    expect(w.log.pushed).toEqual(["a", "b"]);
  });

  it("leaves failed, to-check, sending, skipped, voided and imported documents alone", async () => {
    const docs = [doc("f"), doc("c"), doc("s"), doc("k"), doc("v", { status: "void" }), doc("i")];
    const w = world(docs, [row("f", "failed"), row("c", "needs_check"), row("s", "sending"), row("k", "skipped")], { imported: ["i"] });
    const out = await runBatchChunk(w.deps, items("f", "c", "s", "k", "v", "i"), "unsent");
    expect(w.log.runs).toEqual([]);
    expect(w.log.retried).toEqual([]);
    expect(out.results.map((r) => r.outcome)).toEqual(["left", "left", "left", "left", "left", "left"]);
  });

  it("a document from another company (not readable) is not sent", async () => {
    const w = world([], []);
    const out = await runBatchChunk(w.deps, items("alien"), "unsent");
    expect(w.log.enqueued).toEqual([]);
    expect(out.results[0]).toMatchObject({ outcome: "left", detail: "Not found in Tolra." });
  });

  it("a failure is reported with Xero's reason and the batch carries on", async () => {
    const w = world([doc("a"), doc("b")], [], { outcome: (id) => (id === "a" ? "failed" : "sent") });
    const out = await runBatchChunk(w.deps, items("a", "b"), "unsent");
    expect(out.results.map((r) => [r.docId, r.outcome, r.detail])).toEqual([["a", "failed", "Xero said no"], ["b", "sent", null]]);
  });
});

describe("failed-only mode", () => {
  it("queues a failed row again and sends it; never a sent one, a pending one or a document with no row", async () => {
    const w = world([doc("f"), doc("s"), doc("p"), doc("n")], [row("f", "failed", { attempts: 1 }), row("s", "sent"), row("p", "pending")]);
    const out = await runBatchChunk(w.deps, items("f", "s", "p", "n"), "failed_only");
    expect(w.log.retried).toEqual(["f"]);
    expect(w.log.pushed).toEqual(["f"]);
    expect(w.log.enqueued).toEqual([]);
    expect(out.results.map((r) => [r.docId, r.outcome])).toEqual([["f", "sent"], ["s", "sent"], ["p", "left"], ["n", "left"]]);
  });
});

describe("Xero's rate limit and other stops", () => {
  it("stops on a 429 with the pause from the row and hands back the document and the rest", async () => {
    const w = world([doc("a"), doc("b"), doc("c")], [], { outcome: (id) => (id === "b" ? "rate_limited" : "sent") });
    const out = await runBatchChunk(w.deps, items("a", "b", "c"), "unsent");
    expect(out.stopped).toEqual({ reason: "rate_limited", pauseSeconds: 20 });
    expect(out.remaining).toEqual(items("b", "c"));
    expect(out.results.map((r) => [r.docId, r.outcome])).toEqual([["a", "sent"], ["b", "waiting"]]);
    expect(w.log.pushed).toEqual(["a", "b"]);
  });

  it("resumes after the pause: the held document is picked up by the engine's normal claim, not sent twice", async () => {
    let limited = true;
    const w = world([doc("a")], [], { outcome: () => (limited ? "rate_limited" : "sent") });
    await runBatchChunk(w.deps, items("a"), "unsent");
    limited = false;
    // Its time has come (the fake clock is fixed, so move the row's time back).
    w.table.get("a")!.nextAttemptAt = "2026-10-30T11:59:00Z";
    const out = await runBatchChunk(w.deps, items("a"), "unsent");
    expect(out.results[0].outcome).toBe("sent");
    expect(w.log.runs).toEqual(["a", null]);
    expect(w.log.pushed).toEqual(["a", "a"]);
  });

  it("an unmapped or disconnected company stops the batch with the reason, and the rest is not touched", async () => {
    const w = world([doc("a"), doc("b")], [], { outcome: () => "blocked_unmapped" });
    const out = await runBatchChunk(w.deps, items("a", "b"), "unsent");
    expect(out.stopped?.reason).toBe("unmapped");
    expect(out.remaining).toEqual(items("b"));
    expect(w.log.enqueued).toEqual(["a"]);
  });

  it("stops starting new documents after the time budget", async () => {
    const w = world([doc("a"), doc("b")], []);
    let t = NOW;
    w.deps.now = () => (t += 30_000);
    const out = await runBatchChunk(w.deps, items("a", "b"), "unsent");
    expect(out.stopped?.reason).toBe("time");
    expect(out.remaining).toEqual(items("b"));
  });
});

describe("the batch only ever sends what it listed", () => {
  // A document queued earlier (waiting for an admin's Send now, or held back), OUTSIDE this batch's range, is the engine's oldest due row.
  const outOfRange = () => doc("z", { date: "2025-01-15" });
  const waiting = () => row("z", "pending", { attempts: 2, nextAttemptAt: "2026-10-30T11:00:00Z" });

  it("a held-back document behind an out-of-range pending row is left queued; the out-of-range row is not touched", async () => {
    const w = world([outOfRange(), doc("a")], [waiting(), row("a", "pending", { attempts: 2, nextAttemptAt: "2026-10-30T11:30:00Z" })]);
    const out = await runBatchChunk(w.deps, items("a"), "unsent");
    expect(w.log.runs).toEqual([]);
    expect(w.log.pushed).toEqual([]);
    expect(w.table.get("z")!.status).toBe("pending");
    expect(out.results).toEqual([expect.objectContaining({ docId: "a", outcome: "waiting", detail: expect.stringMatching(/queued ahead/) })]);
  });

  it("failed-only: a failed document is queued again but not run while another is ahead of it; the other is not sent", async () => {
    const w = world([outOfRange(), doc("f")], [waiting(), row("f", "failed")]);
    const out = await runBatchChunk(w.deps, items("f"), "failed_only");
    expect(w.log.retried).toEqual(["f"]);
    expect(w.log.pushed).toEqual([]);
    expect(w.table.get("z")!.status).toBe("pending");
    expect(out.results[0]).toMatchObject({ docId: "f", outcome: "waiting" });
  });

  it("when the batch's document is the oldest due row it runs, and nothing else is sent", async () => {
    const w = world([outOfRange(), doc("a")], [row("a", "pending", { attempts: 2, nextAttemptAt: "2026-10-30T11:30:00Z" }), waiting()]);
    const out = await runBatchChunk(w.deps, items("a"), "unsent");
    expect(w.log.pushed).toEqual(["a"]);
    expect(w.table.get("z")!.status).toBe("pending");
    expect(out.results.map((r) => r.docId)).toEqual(["a"]);
  });

  it("if the engine still sends another row (a race), the extra send is reported, not silent", async () => {
    const w = world([outOfRange(), doc("a")], [row("a", "pending", { attempts: 2, nextAttemptAt: "2026-10-30T11:30:00Z" }), waiting()]);
    const run = w.deps.run;
    w.deps.run = async (only) => {
      const summary = await run(only);
      const z = w.table.get("z")!;
      z.status = "sent"; z.attempts += 1; z.externalId = "xz";
      return summary;
    };
    const out = await runBatchChunk(w.deps, items("a"), "unsent");
    expect(out.results.map((r) => [r.docId, r.outcome])).toEqual([["z", "sent"], ["a", "sent"]]);
    expect(out.results[0].detail).toMatch(/Also processed from the waiting queue/);
  });
});

describe("documents issued before Xero was connected", () => {
  const options = { connectedOn: "2026-10-01" };
  it("with no row they are left, not queued and not sent, unless the box is ticked", async () => {
    const w = world([doc("old", { date: "2026-09-30" }), doc("new", { date: "2026-10-01" })], []);
    const out = await runBatchChunk(w.deps, items("old", "new"), "unsent", options);
    expect(w.log.enqueued).toEqual(["new"]);
    expect(w.log.pushed).toEqual(["new"]);
    expect(out.results[0]).toMatchObject({ docId: "old", outcome: "left", detail: expect.stringMatching(/before Xero was connected/) });
  });
  it("with the box ticked they go through the engine like any other", async () => {
    const w = world([doc("old", { date: "2026-09-30" })], []);
    const out = await runBatchChunk(w.deps, items("old"), "unsent", { ...options, includeBefore: true });
    expect(w.log.pushed).toEqual(["old"]);
    expect(out.results[0].outcome).toBe("sent");
  });
  it("a connection day that is unknown restricts nothing", async () => {
    const w = world([doc("old", { date: "2020-01-01" })], []);
    await runBatchChunk(w.deps, items("old"), "unsent", { connectedOn: null });
    expect(w.log.pushed).toEqual(["old"]);
  });
});
