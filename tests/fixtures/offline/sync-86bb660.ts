/**
 * FROZEN: the previous build's replay dispatcher, `executeOutboxOp` of lib/offline/sync.ts at main 86bb660 (plan R3.6 D1b), copied
 * verbatim except that the Supabase client is passed in (there it was the module's global). Do not update it with the app: it stands for
 * the build already on devices. An entry kind it does not know (049's run_start / run_pause) falls through to its plain started_at update
 * with `.eq("id", op.jobId)`, which is undefined for those entries. `drain86bb660` is that build's replay loop (lib/offline/outbox.ts drain at
 * 86bb660, verbatim but for the in-tab lock, which a test doesn't need): it holds a refused entry without a code and knows nothing of run
 * entries.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { friendlyError } from "@/lib/friendly-error";
import type { HeldEntry, OutboxEntry, ReplayOutcome } from "@/lib/offline/outbox";
import { isNetworkError, offlineBackend, scopeKey, type Scope } from "@/lib/offline/store";
import { executeFinishOp, executePauseOp, executeSignOffOp, executeStartRunOp } from "@/lib/offline/sync";

const refusal = (err: unknown): ReplayOutcome => (isNetworkError(err) ? { status: "network" } : { status: "rejected", reason: friendlyError(err, "The server refused this change.") });

export function executor86bb660(supabase: any) {
  async function executeOutboxOp(op: any): Promise<ReplayOutcome> {
    if (!supabase) return { status: "network" };
    if (op.kind === "signoff") {
      try {
        const { data } = await supabase.auth.getSession();
        return await executeSignOffOp(op, supabase, data.session?.user.id ?? null);
      } catch (err) {
        return refusal(err);
      }
    }
    if (op.kind === "finish") {
      try {
        return await executeFinishOp(op, supabase);
      } catch (err) {
        return refusal(err);
      }
    }
    if (op.kind === "pause") {
      try {
        return await executePauseOp(op, supabase);
      } catch (err) {
        return refusal(err);
      }
    }
    // A Start with a client key: with machines (044) or a bench Start, machines [] (046). Without a key (queued before 044) it is the plain
    // started_at update below.
    if (op.kind === "start" && op.clientOpId && Array.isArray(op.machines)) {
      try {
        return await executeStartRunOp(op, supabase, () => executeOutboxOp({ kind: "start", jobId: op.jobId, jobNo: op.jobNo, at: op.at }));
      } catch (err) {
        return refusal(err);
      }
    }
    if (op.kind === "photo" || op.kind === "worksheet") {
      // (Photos and worksheets: unchanged since; not exercised by the downgrade test.)
      return { status: "network" };
    }
    const column = "started_at";
    const patch = { started_at: op.at };
    try {
      // Only fills an empty time: a Start someone already recorded is never overwritten.
      const { data, error } = await supabase.from("jobs").update(patch).eq("id", op.jobId).is(column, null).select("id");
      if (error) return refusal(error);
      if (data?.length === 1) return { status: "applied" };
      const { data: row, error: readError } = await supabase.from("jobs").select(`id, ${column}`).eq("id", op.jobId).maybeSingle();
      if (readError) return refusal(readError);
      if (!row) return { status: "rejected", reason: "This job no longer exists or you no longer have access to it." };
      return { status: "conflict", reason: "This job was already started at a different time while you were offline. Their time is kept.", server: row };
    } catch (err) {
      return refusal(err);
    }
  }
  return executeOutboxOp;
}

type List = "outbox" | "conflicts" | "rejected";
const key = (scope: Scope, list: List) => `${scopeKey(scope)}|${list}`;
const listOf = <T>(values: Record<string, unknown>, k: string) => (values[k] as T[] | undefined) ?? [];
const attachmentKeys = (op: any): string[] => (op.kind === "photo" ? [op.blobKey] : []);

export async function drain86bb660(scope: Scope, execute: (op: any) => Promise<ReplayOutcome>, now = () => new Date()) {
  const result = { applied: 0, conflicts: 0, rejected: 0, remaining: 0 };
  const store = offlineBackend();
  if (!store) return result;
  const out = key(scope, "outbox");
  for (;;) {
    // Claim the oldest entry: mark it in flight in the same step that reads it.
    const next = await store.transact<OutboxEntry | undefined>([out], (values) => {
      const queue = listOf<OutboxEntry>(values, out);
      const head = queue[0];
      return head ? { set: { [out]: [{ ...head, inFlight: true }, ...queue.slice(1)] }, result: head } : { set: {} };
    });
    if (!next) break;
    let outcome: ReplayOutcome;
    try {
      outcome = await execute(next.op);
    } catch {
      outcome = { status: "network" };
    }
    if (outcome.status === "network") {
      result.remaining = await store.transact<number>([out], (values) => {
        const queue = listOf<OutboxEntry>(values, out).map((item) => (item.id === next.id ? { ...item, inFlight: false } : item));
        return { set: { [out]: queue }, result: queue.length };
      });
      break;
    }
    const settled = outcome as Exclude<ReplayOutcome, { status: "network" } | { status: "blocked" }>;
    const held = settled.status === "applied" ? null : key(scope, settled.status === "conflict" ? "conflicts" : "rejected");
    const owned = settled.status === "applied" ? attachmentKeys(next.op) : [];
    await store.transact([out, ...(held ? [held] : []), ...owned], (values) => {
      const current = listOf<OutboxEntry>(values, out);
      if (!current.some((item) => item.id === next.id)) return { set: {} };
      let queue = current.filter((item) => item.id !== next.id);
      const set: Record<string, unknown> = {};
      const sent: any = next.op;
      if (settled.status === "applied") {
        for (const o of owned) set[o] = undefined;
        const version = settled.version;
        if (sent.kind === "worksheet" && typeof version === "number") {
          queue = queue.map((item: any) => (item.op.kind === "worksheet" && item.op.jobId === sent.jobId && item.op.baseVersion === sent.baseVersion ? { ...item, op: { ...item.op, baseVersion: version } } : item));
        }
      } else if (held) {
        const entry: OutboxEntry = { id: next.id, queuedAt: next.queuedAt, op: next.op };
        set[held] = [...listOf<HeldEntry>(values, held), { ...entry, reason: settled.reason, server: settled.status === "conflict" ? settled.server : undefined, heldAt: now().toISOString(), ...(settled.status === "rejected" && settled.code ? { code: settled.code } : {}) }];
      }
      set[out] = queue;
      return { set };
    });
    if (settled.status === "conflict") result.conflicts += 1;
    else if (settled.status === "rejected") result.rejected += 1;
    else result.applied += 1;
  }
  return result;
}
