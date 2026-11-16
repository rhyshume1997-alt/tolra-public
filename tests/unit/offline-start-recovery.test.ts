/** Offline Synchronisation boundary: real scoped outbox/recovery and replay with an idempotent RPC model; no SQL or client fallback. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryBackend, scopeKey, setOfflineBackend } from "@/lib/offline/store";
import { conflictEntries, enqueue, pendingEntries, recoverStartEntry, rejectedEntries, replayOutbox, START_LEGACY_HELD, START_MACHINE_HELD, START_UNCONFIRMED, isUncertainStartOutcome, type HeldEntry, type OutboxOp, type ReplayOutcome, type RunStartOp } from "@/lib/offline/outbox";
import { executeOutboxOp, executeRunStartOp, executeStartRunOp, recoverStart } from "@/lib/offline/sync";
import { setOfflineScope, refreshCounts } from "@/lib/offline/scope";
import { OfflineBanner } from "@/components/offline-banner";

const h = vi.hoisted(() => ({
  mode: "busy" as "busy" | "ok" | "lost" | "denied" | "empty",
  records: new Map<string, { args: string; data: unknown }>(), starts: 0,
  user: "user-a", rpc: vi.fn(), from: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...args: unknown[]) => h.rpc(...args), from: (...args: unknown[]) => h.from(...args) } }));
vi.mock("@/lib/confirmed-user", () => ({ confirmedUser: async () => ({ data: { user: { id: h.user } }, error: null }), CONFIRMED_USER_REUSE_MS: 0 }));

const scope = { userId: "user-a", orgId: "org-a" };
const op: RunStartOp = { kind: "run_start", v: 2, jobRef: "job-a", jobNo: "J-A", at: "2026-11-15T08:00:00.000Z", clientOpId: "original-key", machines: ["mill"], bench: false, pausedAck: [] };
let storage: Map<string, unknown>;
beforeEach(() => {
  storage = new Map(); setOfflineBackend(memoryBackend(storage)); setOfflineScope(scope);
  h.mode = "busy"; h.records.clear(); h.starts = 0; h.user = scope.userId; h.rpc.mockReset(); h.from.mockReset();
  h.from.mockImplementation(() => { throw new Error("No direct jobs write permitted"); });
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "pause_machine_run") return { data: { ended: [] }, error: null };
    expect(name).toBe("start_machine_run");
    const key = String(args.p_client_op_id);
    const previous = h.records.get(key);
    if (previous) {
      if (previous.args !== JSON.stringify(args)) return { data: null, error: { code: "22023", hint: "client_op_reused", message: "Key reused with different arguments" } };
      return { data: previous.data, error: null };
    }
    if (h.mode === "busy") return { data: null, error: { code: "42501", hint: "machine_in_use", message: "Mill is in use by Sam on J-B." } };
    if (h.mode === "denied") return { data: null, error: { code: "42501", message: "not authorised" } };
    if (h.mode === "empty") return { data: null, error: null };
    const data = { runs: (args.p_machines as string[]).map((machine_id) => ({ machine_id, run_id: `run-${key}` })), bench_run: args.p_bench ? { run_id: `bench-${key}`, already: false } : null, time_conflicts: [] };
    h.records.set(key, { args: JSON.stringify(args), data }); h.starts += 1;
    if (h.mode === "lost") throw new TypeError("Failed to fetch");
    return { data, error: null };
  });
});
afterEach(() => { setOfflineScope(null); setOfflineBackend(null); });

async function heldWithPauses() {
  const start = await enqueue(scope, op, new Date(op.at));
  for (const [index, at] of ["2026-11-15T08:05:00.000Z", "2026-11-15T08:06:00.000Z"].entries()) await enqueue(scope, { kind: "run_pause", v: 2, jobRef: op.jobRef, jobNo: op.jobNo, at, clientOpId: `pause-${index}`, machines: null, afterStart: null }, new Date(at));
  const result = await replayOutbox(scope, executeOutboxOp);
  expect(result).toMatchObject({ applied: 0, conflicts: 1, rejected: 2, remaining: 0 });
  const [held] = await conflictEntries(scope);
  expect(held.id).toBe(start.id); expect(held.op).toEqual(op);
  return held;
}

describe("live Start refusal", () => {
  it("uses a typed unconfirmed code for an incomplete keyed legacy response, independent of its message", async () => {
    h.mode = "empty";
    const legacy = { kind: "start", jobId: op.jobRef, jobNo: op.jobNo, at: op.at, clientOpId: op.clientOpId, machines: op.machines } as const;
    const outcome = await executeStartRunOp(legacy, { rpc: h.rpc });
    expect(outcome).toMatchObject({ status: "conflict", code: START_UNCONFIRMED });
    if (outcome.status !== "conflict") throw new Error("Expected unconfirmed response");
    expect(isUncertainStartOutcome({ ...outcome, reason: "Different display wording" })).toBe(true);
    expect(isUncertainStartOutcome({ ...outcome, code: START_MACHINE_HELD, reason: "did not confirm" })).toBe(false);
  });
  it("never invokes jobs update or a fallback, and holds a truthful coded machine refusal", async () => {
    const held = await heldWithPauses();
    expect(held.code).toBe(START_MACHINE_HELD);
    expect(held.reason).toContain("J-A was NOT started");
    expect(held.reason).toContain("Mill is in use");
    expect(held.reason).not.toMatch(/recorded as started|was started while/);
    expect(h.starts).toBe(0); expect(h.from).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(await rejectedEntries(scope)).toHaveLength(2);
  });
  it("holds a keyless legacy Start rather than directly setting any job time", async () => {
    const outcome = await executeOutboxOp({ kind: "start", jobId: "job-a", jobNo: "J-A", at: op.at });
    expect(outcome).toMatchObject({ status: "conflict", code: START_LEGACY_HELD, opened: false });
    expect(h.from).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("keeps legacy callback semantics for explicitly supplied three-argument callers", async () => {
    const fallback = vi.fn(async (): Promise<ReplayOutcome> => ({ status: "network" }));
    const client = { rpc: h.rpc };
    expect(await executeStartRunOp({ kind: "start", jobId: "job-a", jobNo: "J-A", at: op.at, machines: ["mill"], clientOpId: "original-key" }, client, fallback)).toEqual({ status: "network" });
    expect(await executeRunStartOp(op, client, fallback)).toEqual({ status: "network" });
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});

describe("explicit recovery", () => {
  it("the typed uncertainty code keeps the attempt and Pauses even when the reason contains no marker text", async () => {
    const held = await heldWithPauses();
    const result = await recoverStartEntry(scope, held, { kind: "retry" }, async () => ({ status: "conflict", code: START_UNCONFIRMED, opened: false, reason: "Response incomplete" }));
    expect(result.status).toBe("held");
    expect((await conflictEntries(scope))[0].recoveryAttempt?.uncertain).toBe(true);
    expect((await recoverStartEntry(scope, held, { kind: "discard", confirmed: true }, executeOutboxOp)).status).toBe("held");
    expect(await rejectedEntries(scope)).toHaveLength(2);
  });
  it("an initially unconfirmed legacy Start is held with its original retry identity, not treated as a confirmed refusal", async () => {
    const legacy = { kind: "start", jobId: op.jobRef, jobNo: op.jobNo, at: op.at, clientOpId: op.clientOpId, machines: op.machines } as const;
    await enqueue(scope, legacy);
    await replayOutbox(scope, (entry) => executeStartRunOp(entry as typeof legacy, { rpc: vi.fn(async () => ({ data: null, error: null })) }));
    const [held] = await conflictEntries(scope);
    expect(held).toMatchObject({ code: START_UNCONFIRMED, recoveryAttempt: { choice: "retry", op: legacy, uncertain: true } });
    expect((await recoverStartEntry(scope, held, { kind: "discard", confirmed: true }, executeOutboxOp)).status).toBe("held");
  });
  it("an initially incomplete modern Start also keeps uncertainty, links its Pause and exposes recovery", async () => {
    h.mode = "empty";
    await enqueue(scope, op);
    await enqueue(scope, { kind: "run_pause", v: 2, jobRef: op.jobRef, jobNo: op.jobNo, at: op.at, clientOpId: "unconfirmed-pause", machines: null, afterStart: null });
    await replayOutbox(scope, executeOutboxOp);
    const [held] = await conflictEntries(scope);
    expect(held).toMatchObject({ code: "runs_missing", recoveryAttempt: { choice: "retry", op, uncertain: true } });
    expect(await rejectedEntries(scope)).toMatchObject([{ afterHeldStart: held.id }]);
    expect((await recoverStartEntry(scope, held, { kind: "discard", confirmed: true }, executeOutboxOp)).status).toBe("held");
    await refreshCounts();
    const html = renderToStaticMarkup(createElement(OfflineBanner));
    expect(html).toContain('data-testid="offline-start-blocked"');
    for (const label of ["Retry on the same machine", "Start on the bench", "Discard"]) expect(html).toContain(`>${label}</button>`);
    expect(h.starts).toBe(0); expect(await pendingEntries(scope)).toEqual([]);
  });
  it("the real banner shows blocked later work and all three recovery choices without opening the issues list", async () => {
    await heldWithPauses();
    await enqueue(scope, { kind: "finish", jobId: op.jobRef, jobNo: op.jobNo, at: op.at });
    await refreshCounts();
    const html = renderToStaticMarkup(createElement(OfflineBanner));
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).toContain("Later changes for J-A are blocked until this Start is resolved.");
    for (const label of ["Retry on the same machine", "Start on the bench", "Discard"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('data-testid="offline-start-blocked"');
    expect(text).not.toContain("recorded as started");
  });
  it("retries original arguments/key exactly once; a second recovery creates no duplicate", async () => {
    const held = await heldWithPauses(); const originalArgs = h.rpc.mock.calls[0][1]; h.mode = "ok";
    expect(await recoverStartEntry(scope, held, { kind: "retry" }, executeOutboxOp)).toEqual({ status: "applied" });
    expect(h.rpc.mock.calls[1][1]).toEqual(originalArgs); expect(h.starts).toBe(1);
    expect(await recoverStartEntry(scope, held, { kind: "retry" }, executeOutboxOp)).toEqual({ status: "missing" });
    expect(h.starts).toBe(1); expect(h.rpc).toHaveBeenCalledTimes(2);
    const pauses = await pendingEntries(scope);
    expect(pauses.map((item) => item.op.kind === "run_pause" ? item.op.clientOpId : null)).toEqual(["pause-0", "pause-1"]);
    expect(await replayOutbox(scope, executeOutboxOp)).toMatchObject({ applied: 2, remaining: 0 });
    expect(h.rpc.mock.calls.map((call) => call[0])).toEqual(["start_machine_run", "start_machine_run", "pause_machine_run", "pause_machine_run"]);
  });
  it("lost successful Retry response preserves the hold and server key; repeated Retry is idempotent", async () => {
    const held = await heldWithPauses(); h.mode = "lost";
    expect((await recoverStartEntry(scope, held, { kind: "retry" }, executeOutboxOp)).status).toBe("held");
    expect(h.starts).toBe(1); expect(await pendingEntries(scope)).toEqual([]);
    h.mode = "ok";
    expect((await recoverStartEntry(scope, held, { kind: "retry" }, executeOutboxOp)).status).toBe("applied");
    expect(h.starts).toBe(1);
  });
  it("bench uses a durable new key and explicit bench flag; audit links the original identity and time", async () => {
    const held = await heldWithPauses(); h.mode = "ok";
    expect((await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp)).status).toBe("applied");
    const args = h.rpc.mock.calls[1][1];
    expect(args).toMatchObject({ p_bench: true, p_machines: [], p_started_at: op.at });
    expect(args.p_client_op_id).not.toBe(op.clientOpId);
    expect(await conflictEntries(scope)).toEqual([]);
    expect(storage.get(`${scopeKey(scope)}|start-recovery-audit`)).toMatchObject([{ entryId: held.id, original: op, choice: "bench", recovered: { clientOpId: args.p_client_op_id, at: op.at } }]);
  });
  it.each(["denied", "empty"] as const)("bench %s response never removes the hold or sends its Pauses", async (mode) => {
    const held = await heldWithPauses(); h.mode = mode;
    expect((await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp)).status).toBe("held");
    expect(await conflictEntries(scope)).toHaveLength(1);
    expect(await rejectedEntries(scope)).toHaveLength(2);
    expect(await pendingEntries(scope)).toEqual([]);
    if (mode === "empty") expect((await recoverStartEntry(scope, held, { kind: "discard", confirmed: true }, executeOutboxOp)).status).toBe("held");
  });
  it("lost bench answer reuses its new key, survives reload of the held snapshot, and does not start twice", async () => {
    const held = await heldWithPauses(); h.mode = "lost";
    expect((await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp)).status).toBe("held");
    const [stored] = await conflictEntries(scope); h.mode = "ok";
    expect((await recoverStartEntry(scope, structuredClone(stored), { kind: "bench" }, executeOutboxOp)).status).toBe("applied");
    expect(h.rpc.mock.calls[2][1]).toEqual(h.rpc.mock.calls[1][1]); expect(h.starts).toBe(1);
  });
  it("cannot switch to another recovery while an answer is uncertain", async () => {
    const held = await heldWithPauses(); h.mode = "lost";
    await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp);
    const calls = h.rpc.mock.calls.length;
    expect((await recoverStartEntry(scope, held, { kind: "retry" }, executeOutboxOp)).status).toBe("held");
    expect(h.rpc).toHaveBeenCalledTimes(calls);
  });
  it("cannot discard the Pauses of a server-applied Start whose answer was lost", async () => {
    const held = await heldWithPauses(); h.mode = "lost";
    await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp);
    expect(h.starts).toBe(1);
    expect((await recoverStartEntry(scope, held, { kind: "discard", confirmed: true }, executeOutboxOp)).status).toBe("held");
    expect(await conflictEntries(scope)).toHaveLength(1); expect(await rejectedEntries(scope)).toHaveLength(2);
    h.mode = "ok";
    expect((await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp)).status).toBe("applied");
    expect(await pendingEntries(scope)).toHaveLength(2); expect(h.starts).toBe(1);
  });
  it("does not open a bench run that a machine-targeted historical Pause could not end unchanged", async () => {
    await enqueue(scope, op);
    await enqueue(scope, { kind: "run_pause", v: 2, jobRef: op.jobRef, jobNo: op.jobNo, at: op.at, clientOpId: "targeted-pause", machines: ["mill"], afterStart: null });
    await replayOutbox(scope, executeOutboxOp);
    const [held] = await conflictEntries(scope); h.mode = "ok";
    expect((await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp)).status).toBe("held");
    expect(h.starts).toBe(0); expect(await rejectedEntries(scope)).toHaveLength(1);
    expect((await rejectedEntries(scope))[0].op).toMatchObject({ machines: ["mill"] });
  });
  it("discard requires confirmation, then removes precisely the Start and its held Pauses", async () => {
    const held = await heldWithPauses();
    expect((await recoverStartEntry(scope, held, { kind: "discard", confirmed: false }, executeOutboxOp)).status).toBe("confirmation_required");
    expect(await conflictEntries(scope)).toHaveLength(1); expect(await rejectedEntries(scope)).toHaveLength(2);
    expect((await recoverStartEntry(scope, held, { kind: "discard", confirmed: true }, executeOutboxOp)).status).toBe("discarded");
    expect(await conflictEntries(scope)).toEqual([]); expect(await rejectedEntries(scope)).toEqual([]); expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it("another scope and an altered/stale operation cannot recover this scope's entry", async () => {
    const held = await heldWithPauses(); h.mode = "ok";
    expect((await recoverStartEntry({ ...scope, orgId: "org-b" }, held, { kind: "bench" }, executeOutboxOp)).status).toBe("missing");
    expect((await recoverStartEntry(scope, { ...held, op: { ...op, jobRef: "foreign" } }, { kind: "retry" }, executeOutboxOp)).status).toBe("missing");
    expect(h.starts).toBe(0);
  });
  it("serializes concurrent recovery calls and background replay under the same lock", async () => {
    const held = await heldWithPauses(); h.mode = "ok";
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = recoverStartEntry(scope, held, { kind: "retry" }, async (entry) => { await gate; return executeOutboxOp(entry); });
    await vi.waitFor(() => expect(storage.get(`${scopeKey(scope)}|conflicts`)).toMatchObject([{ recoveryAttempt: { choice: "retry" } }]));
    expect((await recoverStartEntry(scope, held, { kind: "retry" }, executeOutboxOp)).status).toBe("busy");
    expect((await replayOutbox(scope, executeOutboxOp)).applied).toBe(0);
    release(); await first; expect(h.starts).toBe(1);
  });
  it("does not replay queued later work while a Start remains held", async () => {
    await heldWithPauses(); await enqueue(scope, { kind: "finish", jobId: "job-a", jobNo: "J-A", at: op.at }); h.mode = "ok";
    const executor = vi.fn(executeOutboxOp);
    expect((await replayOutbox(scope, executor)).remaining).toBe(1); expect(executor).not.toHaveBeenCalled();
  });
  it("a Pause captured after the Start is held is linked, never replayed, and removed by deliberate Discard", async () => {
    await enqueue(scope, op); await replayOutbox(scope, executeOutboxOp);
    const [held] = await conflictEntries(scope);
    const pause = { kind: "run_pause", v: 2, jobRef: op.jobRef, jobNo: op.jobNo, at: op.at, clientOpId: "late-pause", machines: null, afterStart: null } as const;
    await enqueue(scope, pause); await enqueue(scope, pause);
    expect(await pendingEntries(scope)).toEqual([]);
    expect(await rejectedEntries(scope)).toMatchObject([{ afterHeldStart: held.id, op: { clientOpId: "late-pause", afterStart: op.clientOpId } }]);
    const execute = vi.fn(executeOutboxOp); await replayOutbox(scope, execute); expect(execute).not.toHaveBeenCalled();
    expect((await recoverStartEntry(scope, held, { kind: "discard", confirmed: true }, executeOutboxOp)).status).toBe("discarded");
    await replayOutbox(scope, execute); expect(execute).not.toHaveBeenCalled(); expect(await rejectedEntries(scope)).toEqual([]);
  });
  it("a late Pause is requeued unchanged after explicit bench success", async () => {
    await enqueue(scope, op); await replayOutbox(scope, executeOutboxOp);
    const [held] = await conflictEntries(scope);
    await enqueue(scope, { kind: "run_pause", v: 2, jobRef: op.jobRef, jobNo: op.jobNo, at: op.at, clientOpId: "late-pause", machines: null, afterStart: null });
    const [pause] = await rejectedEntries(scope); h.mode = "ok";
    expect((await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp)).status).toBe("applied");
    expect(await pendingEntries(scope)).toEqual([{ id: pause.id, queuedAt: pause.queuedAt, op: pause.op }]);
  });
  it("confirmed runs with adjusted server times preserve conflict attention and release their Pauses", async () => {
    const held = await heldWithPauses();
    h.rpc.mockResolvedValueOnce({ data: { runs: [{ machine_id: "mill", run_id: "run-1" }], time_conflicts: [{ machine_id: "mill", what: "start", why: "before_last_run_end", device_at: op.at, used_at: "2026-11-15T08:01:00Z" }] }, error: null });
    expect((await recoverStartEntry(scope, held, { kind: "retry" }, executeOutboxOp)).status).toBe("applied");
    expect(await conflictEntries(scope)).toMatchObject([{ id: held.id, code: "time_conflict" }]);
    expect(await pendingEntries(scope)).toHaveLength(2);
  });
  it("does not reinterpret or remove a code-less historical held entry", async () => {
    const entry: HeldEntry = { id: "old-held", queuedAt: op.at, op, heldAt: op.at, reason: "old client refusal" };
    storage.set(`${scopeKey(scope)}|conflicts`, [entry]);
    expect((await recoverStartEntry(scope, entry, { kind: "bench" }, executeOutboxOp)).status).toBe("missing");
    expect(await conflictEntries(scope)).toEqual([entry]); expect(h.rpc).not.toHaveBeenCalled();
  });
  it("unknown legacy machine/key stays held on Retry, rather than guessing a bench Start", async () => {
    const legacy = { kind: "start", jobId: "job-a", jobNo: "J-A", at: op.at } as const;
    await enqueue(scope, legacy); await replayOutbox(scope, executeOutboxOp);
    const [held] = await conflictEntries(scope);
    expect((await recoverStartEntry(scope, held, { kind: "retry" }, executeOutboxOp)).status).toBe("held"); expect(h.rpc).not.toHaveBeenCalled();
    h.mode = "ok"; expect((await recoverStartEntry(scope, held, { kind: "bench" }, executeOutboxOp)).status).toBe("applied");
  });
  it("unverified identity cannot recover a held Start through the server boundary", async () => {
    const held = await heldWithPauses(); h.user = "someone-else";
    expect((await recoverStart(scope, held, { kind: "bench" })).status).toBe("held"); expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

it("nothing under lib/offline writes a job start or finish time directly", () => {
  const root = path.resolve("lib/offline");
  const sources = readdirSync(root).filter((name) => name.endsWith(".ts")).map((name) => readFileSync(path.join(root, name), "utf8")).join("\n");
  expect(sources).not.toMatch(/(?:const|let)\s+\w+\s*=\s*\{\s*(?:started_at|finished_at)\s*:/);
  expect(sources).not.toMatch(/\.update\(\s*\{\s*(?:started_at|finished_at)\s*:/);
  expect(sources).not.toMatch(/\.update\(\s*\{[^}]*\b(?:started_at|finished_at)\s*:/);
});
