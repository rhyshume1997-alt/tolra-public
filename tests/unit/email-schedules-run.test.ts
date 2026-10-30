import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type EmailScheduleRow, MAX_ATTEMPTS, RETRY_AFTER_MS, SCHEDULES_NOT_APPLIED, claimRun, finishRun, listEnabledSchedules, noteScheduleRan } from "@/lib/email/schedules/store";
import { type RunnerDeps, runDueSchedules } from "@/lib/email/schedules/run";
import { FakeDb } from "../support/fake-db";

const NOW = new Date("2026-10-26T09:05:00Z");
const row = (id: string, extra: Partial<EmailScheduleRow> = {}): EmailScheduleRow => ({
  id, organization_id: `org-${id}`, kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null,
  timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z", ...extra,
});
const ok = { sent: 1, drafted: 0, skipped: 0, failed: 0, error: null, retryable: true };

describe("claiming a period: the database is the lock", () => {
  let db: FakeDb;
  beforeEach(() => { db = new FakeDb(); });

  it("two overlapping calls: exactly one claims", async () => {
    const results = await Promise.all([claimRun(db as never, "s1", "2026-10-26", NOW), claimRun(db as never, "s1", "2026-10-26", NOW)]);
    expect([...results].sort()).toEqual(["busy", "claimed"]);
    expect(db.rows("email_schedule_runs")).toHaveLength(1);
    expect(db.rows("email_schedule_runs")[0]).toMatchObject({ error: "running", attempts: 1 });
  });

  it("a finished period is never claimed again", async () => {
    await claimRun(db as never, "s1", "k", NOW);
    await finishRun(db as never, "s1", "k", { sent: 3, error: null, final: false });
    expect(await claimRun(db as never, "s1", "k", new Date(NOW.getTime() + 3_600_000))).toBe("done");
    expect(db.rows("email_schedule_runs")[0]).toMatchObject({ sent_count: 3, error: null });
  });

  it("another period or another schedule is its own claim", async () => {
    expect(await claimRun(db as never, "s1", "a", NOW)).toBe("claimed");
    expect(await claimRun(db as never, "s1", "b", NOW)).toBe("claimed");
    expect(await claimRun(db as never, "s2", "a", NOW)).toBe("claimed");
  });

  it("a period that failed (or died) is tried again after 10 minutes, at most 3 times in all", async () => {
    await claimRun(db as never, "s1", "k", NOW);
    await finishRun(db as never, "s1", "k", { sent: 0, error: "1 reminder not sent (provider_error)", final: false });
    expect(await claimRun(db as never, "s1", "k", new Date(NOW.getTime() + RETRY_AFTER_MS - 1000))).toBe("busy");
    expect(await claimRun(db as never, "s1", "k", new Date(NOW.getTime() + RETRY_AFTER_MS + 1000))).toBe("claimed");
    expect(db.rows("email_schedule_runs")[0]).toMatchObject({ attempts: 2, error: "running" });
    await finishRun(db as never, "s1", "k", { sent: 0, error: "again", final: false });
    expect(await claimRun(db as never, "s1", "k", new Date(NOW.getTime() + 2 * RETRY_AFTER_MS + 2000))).toBe("claimed");
    await finishRun(db as never, "s1", "k", { sent: 0, error: "again", final: false });
    expect(db.rows("email_schedule_runs")[0].attempts).toBe(MAX_ATTEMPTS);
    expect(await claimRun(db as never, "s1", "k", new Date(NOW.getTime() + 10 * RETRY_AFTER_MS))).toBe("done");
  });

  it("a final failure is not retried", async () => {
    await claimRun(db as never, "s1", "k", NOW);
    await finishRun(db as never, "s1", "k", { sent: 1, error: "1 timesheet e-mail not sent", final: true });
    expect(await claimRun(db as never, "s1", "k", new Date(NOW.getTime() + 10 * RETRY_AFTER_MS))).toBe("done");
  });

  it("a run that never finished (a crash) is marked running and is retried like a failure", async () => {
    await claimRun(db as never, "s1", "k", NOW);
    expect(await claimRun(db as never, "s1", "k", new Date(NOW.getTime() + RETRY_AFTER_MS + 1000))).toBe("claimed");
  });

  it("a once schedule that ran cleanly switches itself off; a failed one stays on; daily stays on", async () => {
    const d = new FakeDb({ email_schedules: [{ id: "o", enabled: true }, { id: "d", enabled: true }, { id: "f", enabled: true }] });
    await noteScheduleRan(d as never, { id: "o", frequency: "once" }, NOW, true);
    await noteScheduleRan(d as never, { id: "d", frequency: "daily" }, NOW, true);
    await noteScheduleRan(d as never, { id: "f", frequency: "once" }, NOW, false);
    expect(d.rows("email_schedules")).toEqual([
      { id: "o", enabled: false, last_run_at: NOW.toISOString() }, { id: "d", enabled: true, last_run_at: NOW.toISOString() }, { id: "f", enabled: true, last_run_at: NOW.toISOString() },
    ]);
  });
});

describe("listing the schedules", () => {
  it("only enabled schedules of active companies", async () => {
    const db = new FakeDb({
      organizations: [{ id: "a", status: "active" }, { id: "b", status: "paused" }],
      email_schedules: [{ id: "1", organization_id: "a", enabled: true }, { id: "2", organization_id: "a", enabled: false }, { id: "3", organization_id: "b", enabled: true }],
    });
    const listed = await listEnabledSchedules(db as never);
    expect("rows" in listed && listed.rows.map((r) => r.id)).toEqual(["1"]);
  });
  it("says 108 isn't applied when the table is missing, and throws for any other failure", async () => {
    const db = new FakeDb();
    db.failing.email_schedules = { code: "PGRST205", message: "Could not find the table 'public.email_schedules' in the schema cache" };
    expect(await listEnabledSchedules(db as never)).toEqual({ notApplied: true });
    db.failing.email_schedules = { code: "42501", message: "denied" };
    await expect(listEnabledSchedules(db as never)).rejects.toThrow(/list schedules/);
  });
});

describe("running what is due", () => {
  const make = (rows: EmailScheduleRow[], over: Partial<RunnerDeps> = {}): RunnerDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      list: async () => ({ rows }),
      claim: async (id) => { calls.push(`claim:${id}`); return "claimed"; },
      execute: async (s) => { calls.push(`execute:${s.id}`); return ok; },
      finish: async (id, _k, r) => { calls.push(`finish:${id}:${r.error ?? "ok"}:${r.final}`); },
      note: async (s, _n, succeeded) => { calls.push(`note:${s.id}:${succeeded}`); },
      ...over,
    };
  };

  it("does nothing when nothing is due", async () => {
    const deps = make([row("1", { time_of_day: "23:00", updated_at: "2026-10-26T08:00:00Z" })]);
    expect(await runDueSchedules(deps, NOW)).toMatchObject({ schedules: 1, due: 0, ran: 0 });
    expect(deps.calls).toEqual([]);
  });

  it("runs a due schedule: claim, execute, finish, note", async () => {
    const deps = make([row("1")]);
    expect(await runDueSchedules(deps, NOW)).toEqual({ schedules: 1, due: 1, ran: 1, emails: 1, drafted: 0, failed: 0, errors: 0 });
    expect(deps.calls).toEqual(["claim:1", "execute:1", "finish:1:ok:false", "note:1:true"]);
  });

  it("skips a period someone else holds or has done", async () => {
    const deps = make([row("1")], { claim: async () => "busy" });
    expect(await runDueSchedules(deps, NOW)).toMatchObject({ due: 1, ran: 0 });
    expect(deps.calls).toEqual([]);
  });

  it("one company's failure never stops the others, however it fails", async () => {
    const deps = make([row("1"), row("2"), row("3"), row("4")], {
      claim: async (id) => { if (id === "1") throw new Error("claim blew up"); return "claimed"; },
      execute: async (s) => { if (s.id === "2") throw new Error("send blew up: a@b.test"); return ok; },
      finish: async (id) => { if (id === "3") throw new Error("finish blew up"); },
    });
    const out = await runDueSchedules(deps, NOW);
    expect(out).toMatchObject({ schedules: 4, due: 4, ran: 2, emails: 1, errors: 3 }); // 1: claim threw; 2: execute threw (still finished, as an error, so it counts as run); 3: finish threw; 4: fine
    expect(JSON.stringify(out)).not.toContain("b.test");
  });

  it("a thrown execute is recorded as an error on the run, which may be retried", async () => {
    const deps = make([row("1")], { execute: async () => { throw new Error("x"); } });
    await runDueSchedules(deps, NOW);
    expect(deps.calls).toEqual(["claim:1", "finish:1:unexpected error:false", "note:1:false"]);
  });

  it("a non-retryable failure is finished as final", async () => {
    const deps = make([row("1", { kind: "timesheet" })], { execute: async () => ({ ...ok, sent: 0, failed: 1, error: "1 timesheet e-mail not sent (provider_error)", retryable: false }) });
    expect(await runDueSchedules(deps, NOW)).toMatchObject({ failed: 1, ran: 1 });
    expect(deps.calls).toContain("finish:1:1 timesheet e-mail not sent (provider_error):true");
    expect(deps.calls).toContain("note:1:false");
  });

  it("answers skipped while 108 isn't applied", async () => {
    const out = await runDueSchedules(make([], { list: async () => ({ notApplied: true }) }), NOW);
    expect(out).toMatchObject({ skipped: SCHEDULES_NOT_APPLIED, schedules: 0, ran: 0 });
    expect(SCHEDULES_NOT_APPLIED).toBe("database update 108 not applied");
  });
});
