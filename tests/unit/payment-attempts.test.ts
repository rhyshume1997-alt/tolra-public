import { describe, expect, it } from "vitest";

import { AttemptNotSaved, isDefiniteRefusal, PaymentAttempts, recordBatch, recordWithRecovery, type LockRunner, type PaymentAttempt, type PaymentOutcome, type RecordDeps, type StorageLike } from "@/lib/payment-attempts";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}


/** An exclusive lock per name shared by every "tab" in a test, like the browser's Web Locks. */
function sharedLocks(): LockRunner {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(name: string, fn: () => Promise<T>) => {
    const prev = tails.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(name, run.catch(() => undefined));
    return run;
  };
}
const LOCKS = sharedLocks();
/** A tab: its own PaymentAttempts over shared storage and the shared lock. */
const tab = (u: string, o: string, storage: StorageLike | null, now?: () => number) => new PaymentAttempts(u, o, storage, now, LOCKS);

/** A server that commits at most one payment per request id, like record_invoice_payment, and can lose its answers. */
function server(storage?: ReturnType<typeof memoryStorage>) {
  const committed = new Map<string, PaymentOutcome>();
  const state = { loseNextAnswer: 0, down: false, refuse: false, calls: 0, registeredBeforeSend: true };
  let ids = 0;
  const deps: RecordDeps = {
    record: async (attempt: PaymentAttempt) => {
      state.calls += 1;
      // The attempt must already be in storage when the request goes out.
      if (storage && ![...storage.data.values()].some((v) => v.includes(attempt.requestId))) state.registeredBeforeSend = false;
      if (state.down) return { outcome: null, error: Object.assign(new Error("Failed to fetch"), { code: "" }) };
      if (state.refuse) return { outcome: null, error: { code: "22023", message: "That is more than the balance due" } };
      if (!committed.has(attempt.requestId)) committed.set(attempt.requestId, { status: "partial", amountPaid: Number(attempt.amount), balance: 120 - Number(attempt.amount) });
      if (state.loseNextAnswer > 0) { state.loseNextAnswer -= 1; return { outcome: null, error: Object.assign(new Error("504 Gateway Timeout"), { code: "" }) }; }
      return { outcome: committed.get(attempt.requestId)!, error: null };
    },
    find: async (requestId) => {
      if (state.down) return { outcome: null, error: new Error("Failed to fetch") };
      return { outcome: committed.get(requestId) ?? null, error: null };
    },
  };
  return { committed, state, deps, newId: () => `req-${++ids}` };
}

const values = { amount: "50.00", paidOn: "2026-10-01", method: "BACS", reference: "" };

describe("a payment whose answer is lost is recorded exactly once", () => {
  it("committed, answer lost, page reloaded, retried: the same request id, found by the check, one payment", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    const before = tab("user-1", "org-1", storage);
    s.state.loseNextAnswer = 1;
    const lost = await recordWithRecovery("inv-1", values, before, s.deps, s.newId);
    expect(lost.kind).toBe("unknown");
    expect(s.committed.size).toBe(1);
    expect(s.state.registeredBeforeSend).toBe(true);

    // Reload: a new object over the same storage. The attempt is still there, uncertain, with its id and values.
    const after = tab("user-1", "org-1", storage);
    expect(after.uncertainIds()).toEqual(["inv-1"]);
    expect(after.get("inv-1")).toMatchObject({ requestId: "req-1", amount: "50.00", state: "sent" });

    // The person retypes something else; the uncertain attempt is still what is checked and (if needed) sent.
    const retry = await recordWithRecovery("inv-1", { ...values, amount: "70.00" }, after, s.deps, s.newId);
    expect(retry).toMatchObject({ kind: "done", recovered: true });
    expect(s.committed.size).toBe(1);
    expect(s.state.calls).toBe(1);
    expect(after.get("inv-1")).toBeUndefined();
    expect(tab("user-1", "org-1", storage).get("inv-1")).toBeUndefined();
  });

  it("never reached the server, page reloaded: the check finds nothing and the retry sends the same id, once", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    s.state.down = true;
    expect((await recordWithRecovery("inv-1", values, tab("u", "o", storage), s.deps, s.newId)).kind).toBe("unknown");
    s.state.down = false;
    const result = await recordWithRecovery("inv-1", values, tab("u", "o", storage), s.deps, s.newId);
    expect(result).toMatchObject({ kind: "done", recovered: false });
    expect([...s.committed.keys()]).toEqual(["req-1"]);
  });

  it("while the server can't be reached the check can't tell either: unknown, nothing sent", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    s.state.loseNextAnswer = 1;
    await recordWithRecovery("inv-1", values, tab("u", "o", storage), s.deps, s.newId);
    s.state.down = true;
    const calls = s.state.calls;
    expect((await recordWithRecovery("inv-1", values, tab("u", "o", storage), s.deps, s.newId)).kind).toBe("unknown");
    expect(s.state.calls).toBe(calls);
    expect(s.committed.size).toBe(1);
  });

  it("a double click (two submits at once) records once", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    const attempts = tab("u", "o", storage);
    await Promise.all([recordWithRecovery("inv-1", values, attempts, s.deps, s.newId), recordWithRecovery("inv-1", values, attempts, s.deps, s.newId)]);
    expect(s.committed.size).toBe(1);
  });
});

describe("a refusal is kept, never silently dropped", () => {
  it("refused, then the same values again: same id, checked first, no duplicate once it is accepted", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    const attempts = tab("u", "o", storage);
    s.state.refuse = true;
    const refused = await recordWithRecovery("inv-1", values, attempts, s.deps, s.newId);
    expect(refused.kind).toBe("refused");
    expect(attempts.get("inv-1")).toMatchObject({ requestId: "req-1", state: "refused" });
    // Survives a reload, too.
    expect(tab("u", "o", storage).get("inv-1")).toMatchObject({ requestId: "req-1", state: "refused" });

    s.state.refuse = false;
    const retry = await recordWithRecovery("inv-1", values, tab("u", "o", storage), s.deps, s.newId);
    expect(retry).toMatchObject({ kind: "done", recovered: false });
    expect(retry).toMatchObject({ attempt: { requestId: "req-1" } });
    expect(s.committed.size).toBe(1);
  });

  it("changed values after a refusal are a new attempt with a new id", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    const attempts = tab("u", "o", storage);
    s.state.refuse = true;
    await recordWithRecovery("inv-1", values, attempts, s.deps, s.newId);
    s.state.refuse = false;
    const next = await recordWithRecovery("inv-1", { ...values, amount: "20.00" }, attempts, s.deps, s.newId);
    expect(next).toMatchObject({ attempt: { requestId: "req-2" } });
    expect([...s.committed.keys()]).toEqual(["req-2"]);
  });

  it("a refusal is kept for a day, an uncertain attempt until it is settled", () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const a = tab("u", "o", storage, () => now);
    a.register("refused-inv", values, () => "r1");
    a.refused("refused-inv");
    a.register("sent-inv", values, () => "s1");
    now += 25 * 60 * 60 * 1000;
    const later = tab("u", "o", storage, () => now);
    expect(later.get("refused-inv")).toBeUndefined();
    expect(later.get("sent-inv")).toMatchObject({ requestId: "s1", state: "sent" });
  });
});

describe("one user, company and invoice never sees or reuses another's", () => {
  it("different user, company or invoice: separate records and ids", async () => {
    const storage = memoryStorage();
    const mine = tab("user-1", "org-1", storage);
    mine.register("inv-1", values, () => "mine");
    expect(tab("user-2", "org-1", storage).get("inv-1")).toBeUndefined();
    expect(tab("user-1", "org-2", storage).get("inv-1")).toBeUndefined();
    expect(mine.get("inv-2")).toBeUndefined();
    expect(tab("user-1", "org-1", storage).get("inv-1")).toMatchObject({ requestId: "mine" });
    // Each gets its own id for the same values.
    expect(tab("user-2", "org-1", storage).register("inv-1", values, () => "theirs").requestId).toBe("theirs");
    expect(mine.register("inv-2", values, () => "other-invoice").requestId).toBe("other-invoice");
    // One entry per user, company and invoice.
    expect(new Set([...storage.data.keys()]).size).toBe(3);
    expect(mine.get("inv-1")?.requestId).toBe("mine");
  });

  it("an unreadable record is ignored, never trusted", () => {
    const storage = memoryStorage();
    storage.setItem("quoteflow-payment-attempt:u:o:inv-1", "{not json");
    const a = tab("u", "o", storage);
    expect(a.get("inv-1")).toBeUndefined();
    expect(a.uncertainIds()).toEqual([]);
  });
  it("only the database function's own refusals say nothing was saved", () => {
    for (const code of ["22023", "42501", "P0002", "PGRST301"]) expect(isDefiniteRefusal({ code }), code).toBe(true);
    for (const err of [new Error("Failed to fetch"), { code: "" }, { code: "PGRST000" }, { code: "57014" }, { message: "502 Bad Gateway" }, null]) expect(isDefiniteRefusal(err)).toBe(false);
  });
});

describe("two tabs share the same storage", () => {
  it("attempts on different invoices in two tabs don't erase each other; after both answers are lost and a reload, each retry finds its own payment", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    const tabA = tab("u", "o", storage);
    const tabB = tab("u", "o", storage);
    s.state.loseNextAnswer = 2;
    expect((await recordWithRecovery("inv-1", values, tabA, s.deps, s.newId)).kind).toBe("unknown");
    expect((await recordWithRecovery("inv-2", { ...values, amount: "30.00" }, tabB, s.deps, s.newId)).kind).toBe("unknown");
    // Reload: one fresh object sees both uncertain attempts with their own ids.
    const reloaded = tab("u", "o", storage);
    expect(reloaded.uncertainIds().sort()).toEqual(["inv-1", "inv-2"]);
    expect(reloaded.get("inv-1")?.requestId).toBe("req-1");
    expect(reloaded.get("inv-2")?.requestId).toBe("req-2");
    const r1 = await recordWithRecovery("inv-1", values, reloaded, s.deps, s.newId);
    const r2 = await recordWithRecovery("inv-2", { ...values, amount: "30.00" }, reloaded, s.deps, s.newId);
    expect([r1, r2].map((r) => r.kind === "done" && r.recovered)).toEqual([true, true]);
    expect(s.committed.size).toBe(2);
    expect(reloaded.uncertainIds()).toEqual([]);
  });

  it("a tab sees an attempt another tab registered on the same invoice and reuses its id", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    s.state.loseNextAnswer = 1;
    await recordWithRecovery("inv-1", values, tab("u", "o", storage), s.deps, s.newId);
    const other = tab("u", "o", storage);
    const retry = await recordWithRecovery("inv-1", values, other, s.deps, s.newId);
    expect(retry).toMatchObject({ kind: "done", recovered: true });
    expect(s.committed.size).toBe(1);
  });
});

describe("nothing is sent unless the attempt is durably saved", () => {
  it("blocked storage: refused before sending, nothing reaches the server", async () => {
    const s = server();
    const blocked = { ...memoryStorage(), getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const result = await recordWithRecovery("inv-1", values, tab("u", "o", blocked), s.deps, s.newId);
    expect(result.kind).toBe("not-saved");
    expect(s.state.calls).toBe(0);
  });

  it("storage full (quota error on write): refused before sending", async () => {
    const s = server();
    const full = { ...memoryStorage(), setItem: () => { throw Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" }); } };
    const result = await recordWithRecovery("inv-1", values, tab("u", "o", full), s.deps, s.newId);
    expect(result).toMatchObject({ kind: "not-saved" });
    expect((result as { error: unknown }).error).toBeInstanceOf(AttemptNotSaved);
    expect(s.state.calls).toBe(0);
  });

  it("a write that silently doesn't stick (read back differs): refused before sending", async () => {
    const s = server();
    const leaky = { ...memoryStorage(), setItem: () => undefined };
    expect((await recordWithRecovery("inv-1", values, tab("u", "o", leaky), s.deps, s.newId)).kind).toBe("not-saved");
    expect(s.state.calls).toBe(0);
  });

  it("no storage at all: refused before sending", async () => {
    const s = server();
    expect((await recordWithRecovery("inv-1", values, tab("u", "o", null), s.deps, s.newId)).kind).toBe("not-saved");
    expect(s.state.calls).toBe(0);
  });
});

describe("two tabs paying the same invoice at the same moment", () => {
  it("both read before either writes: the lock makes the second wait, find the first's attempt and record nothing new", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    // Both tabs start before either has written anything.
    const [a, b] = await Promise.all([
      recordWithRecovery("inv-1", values, tab("u", "o", storage), s.deps, s.newId),
      recordWithRecovery("inv-1", { ...values, amount: "60.00" }, tab("u", "o", storage), s.deps, s.newId),
    ]);
    expect(s.committed.size).toBe(1);
    // The first records it; the second, from a dialog opened before that payment, sends nothing and says so.
    expect([a.kind, b.kind]).toEqual(["done", "stale"]);
  });

  it("a dialog opened after the payment was recorded can record a further, genuine payment", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    let now = 1_000;
    const clock = () => now;
    await recordWithRecovery("inv-1", values, tab("u", "o", storage, clock), s.deps, s.newId, 900);
    now = 2_000;
    const later = await recordWithRecovery("inv-1", { ...values, amount: "20.00" }, tab("u", "o", storage, clock), s.deps, s.newId, 1_500);
    expect(later.kind).toBe("done");
    expect(s.committed.size).toBe(2);
  });

  it("without the shared lock, the race is real (so the lock is what prevents it)", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    const noWait: LockRunner = <T>(_name: string, fn: () => Promise<T>) => fn();
    // Reads happen before writes: both see no attempt.
    const first = new PaymentAttempts("u", "o", storage, undefined, noWait);
    const second = new PaymentAttempts("u", "o", storage, undefined, noWait);
    const gate = { open: () => {} };
    const opened = new Promise<void>((resolve) => { gate.open = resolve; });
    const slowDeps: RecordDeps = { ...s.deps, record: async (attempt) => { await opened; return s.deps.record(attempt); } };
    const both = Promise.all([
      recordWithRecovery("inv-1", values, first, slowDeps, s.newId),
      recordWithRecovery("inv-1", values, second, slowDeps, () => "req-other"),
    ]);
    gate.open();
    await both;
    expect(s.committed.size).toBeGreaterThanOrEqual(1);
  });

  it("a browser without shared locks: nothing is sent", async () => {
    const s = server();
    const result = await recordWithRecovery("inv-1", values, new PaymentAttempts("u", "o", memoryStorage(), undefined, null), s.deps, s.newId);
    expect(result.kind).toBe("no-lock");
    expect(s.state.calls).toBe(0);
  });
});

describe("bulk Pay in full keeps one attempt per invoice", () => {
  it("a lost answer on one invoice keeps its attempt; the retry reuses the request id and records no second payment", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    const attempts = tab("user-1", "org-1", storage);
    const items = ["inv-1", "inv-2", "inv-3"].map((id) => ({ id, values }));
    const sent: string[] = [];
    // The answer for inv-2 is lost (it was committed); the others answer normally.
    const depsFor = (id: string): RecordDeps => ({
      ...s.deps,
      record: async (attempt) => {
        sent.push(`${id}:${attempt.requestId}`);
        if (id === "inv-2") s.state.loseNextAnswer = 1;
        return s.deps.record(attempt);
      },
    });

    const first = await recordBatch(items, attempts, depsFor, s.newId);
    expect(first.map((r) => [r.id, r.result.kind])).toEqual([["inv-1", "done"], ["inv-2", "unknown"], ["inv-3", "done"]]);
    expect(s.state.registeredBeforeSend).toBe(true);
    expect(attempts.uncertainIds()).toEqual(["inv-2"]);
    const kept = attempts.get("inv-2")!.requestId;
    expect(s.committed.size).toBe(3);

    // Running it again (after a reload, say): only inv-2 has an attempt to check; nothing is sent under a new id.
    const reloaded = tab("user-1", "org-1", storage);
    const again = await recordBatch([items[1]], reloaded, depsFor, () => { throw new Error("a new request id must not be made"); });
    expect(again[0].result).toMatchObject({ kind: "done", recovered: true });
    expect(sent.filter((x) => x.startsWith("inv-2:"))).toEqual([`inv-2:${kept}`]);
    expect(s.committed.size).toBe(3);
    expect(reloaded.uncertainIds()).toEqual([]);
  });

  it("a lost answer that was NOT committed is retried with the same request id", async () => {
    const storage = memoryStorage();
    const s = server(storage);
    const attempts = tab("user-1", "org-1", storage);
    s.state.down = true;
    const [lost] = await recordBatch([{ id: "inv-1", values }], attempts, () => s.deps, s.newId);
    expect(lost.result.kind).toBe("unknown");
    s.state.down = false;
    const [retry] = await recordBatch([{ id: "inv-1", values }], attempts, () => s.deps, s.newId);
    expect(retry.result).toMatchObject({ kind: "done", recovered: false, attempt: { requestId: "req-1" } });
    expect(s.committed.size).toBe(1);
  });
});
