/**
 * Approving a week while time is being written for it (migrations 050 to 052; the Astra review of PR #141).
 *
 * approve_time_week holds the person's clock and labour locks while it works out the revision and records the approval; every clock
 * and labour write takes the lock of each person it writes FIRST and only then asks whether the week is approved. So the two are
 * serialised whichever comes first, and an approved week can never silently hold time its approver didn't see:
 *
 *   (a) the approval commits first: the write, which waited on the lock, is refused whole (42501, week_approved) and nothing of it
 *       is kept (no session, no run, no clock record): the approval is still current;
 *   (b) the write commits first: the approval, which waited on the lock, works its revision out after it and refuses the revision the
 *       approver saw (stale_revision); approving again covers the write (the approved revision is the current one, with it).
 *
 * Never both, never a deadlock. Two connections, the interleaving forced (the second is seen waiting on the advisory lock before the
 * first commits), every write path: the sheet's Start and Stop, the Job Board's Start, Pause of one machine, Pause of the whole job
 * (several people, one of them only joined from the sheet), Finish through finish_job and the plain Finish of a job with no machine,
 * a clock action, and the person's own add / correct / void of job time. Several rounds of each, then free-running rounds.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, become, q } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

const ROUNDS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { ok: true } | { ok: false; code?: string; hint?: string; message: string };
const settle = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(() => ({ ok: true as const }), (e: { code?: string; hint?: string; message: string }) => ({ ok: false as const, code: e.code, hint: e.hint, message: e.message }));

const newJob = () =>
  withDb(async (db) => (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Race Co') returning id", [world.tenants.alpha.id, `J-R-${randomUUID().slice(0, 8)}`])).rows[0].id);
const newMachine = () =>
  withDb(async (db) => (await db.query<{ id: string }>("insert into public.machines (organization_id, name) values ($1, $2) returning id", [world.tenants.alpha.id, `Race mill ${randomUUID().slice(0, 6)}`])).rows[0].id);
const one = <R>(sql: string, params: unknown[] = []) => withDb(async (db) => (await db.query(sql, params)).rows[0] as R);

/** A time just now (later than every approval made so far) and its week: a write sent with it is back-dated once a later approval exists. */
const justNow = () => one<{ t: string; week: string }>("select clock_timestamp()::text as t, to_char(public.time_week_of(clock_timestamp()), 'YYYY-MM-DD') as week");
/** Wednesday 10:00 (Europe/London) of the week n weeks back, and that week's Monday: a person-week of its own for the corrections. */
const weeksBack = (n: number) =>
  one<{ at: string; week: string }>("select (((public.time_week_of(now()) - 7 * $1)::date + 2)::timestamp + interval '10 hours') at time zone 'Europe/London' as at, to_char(public.time_week_of(now()) - 7 * $1, 'YYYY-MM-DD') as week", [n]);
const revision = (user: string, week: string) => one<{ r: string }>("select public.time_week_revision($1, $2, $3::date) as r", [world.tenants.alpha.id, user, week]).then((r) => r.r);
const state = (user: string, week: string) =>
  q<{ state: string; revision: string; approved_revision: string | null }>(A().admin, "select state, revision, approved_revision from public.time_week_status($1::date, $2)", [week, user]).then((r) => r[0]);
const approveNow = (user: string, week: string, rev: string) =>
  q(A().admin, "select public.approve_time_week($1, $2::date, $3, '{\"paid_minutes\": 0}'::jsonb, null)", [user, week, rev]);

/** Waits until connection `pid` is blocked on an advisory lock (true), or gives up after ~5 s (false). */
async function waitsOnAdvisoryLock(watch: Client, pid: number) {
  for (let i = 0; i < 500; i += 1) {
    const r = await watch.query<{ t: string | null; e: string | null }>("select wait_event_type as t, wait_event as e from pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.t === "Lock" && r.rows[0]?.e === "advisory") return true;
    await sleep(10);
  }
  return false;
}

type Write = { who: Who; sql: string; params: unknown[] };
type Order = "approval first" | "write first";

/**
 * One forced interleaving: the first side runs and holds its transaction open; the second starts and must be seen waiting on the
 * advisory lock; then the first commits and the second finishes (committed if it succeeded). Returns both outcomes.
 */
async function race(order: Order, person: string, week: string, seenRevision: string, write: Write) {
  return withDb((ca) => withDb((cb) => withDb(async (watch) => {
    const pidOf = async (c: Client) => (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    const [pa, pb] = [await pidOf(ca), await pidOf(cb)];
    await ca.query("begin");
    await become(ca, A().admin);
    await cb.query("begin");
    await become(cb, write.who);
    const approve = () => settle(ca.query("select public.approve_time_week($1, $2::date, $3, '{\"paid_minutes\": 0}'::jsonb, null)", [person, week, seenRevision]));
    const doWrite = () => settle(cb.query(write.sql, write.params));
    const [first, second, firstConn, secondConn, secondPid] = order === "approval first" ? [approve, doWrite, ca, cb, pb] : [doWrite, approve, cb, ca, pa];
    const a = await first();
    expect(a, `${order}: the first side succeeds on its own`).toEqual({ ok: true });
    const pending = second();
    const waited = await waitsOnAdvisoryLock(watch, secondPid);
    await firstConn.query("commit");
    const b = await pending;
    await secondConn.query(b.ok ? "commit" : "rollback");
    return order === "approval first" ? { approval: a, write: b, waited } : { approval: b, write: a, waited };
  })));
}

/** Both orders, ROUNDS each: (a) the write is refused whole and the approval stays current; (b) the approval is refused as stale,
 *  and approving again covers the write. `setup` prepares a fresh case and returns the person, the week and the write; `kept` says
 *  whether the write's effect is in the database. */
async function bothOrders(setup: (round: number, order: Order) => Promise<{ person: string; week: string; write: Write; kept: () => Promise<boolean> }>) {
  for (const order of ["approval first", "write first"] as const) {
    for (let round = 0; round < ROUNDS; round += 1) {
      const c = await setup(round, order);
      const seen = await revision(c.person, c.week);
      const out = await race(order, c.person, c.week, seen, c.write);
      const label = `${order}, round ${round}`;
      expect(out.waited, `${label}: the second side waited on the person's lock`).toBe(true);
      expect([out.approval.ok, out.write.ok].filter(Boolean), `${label}: exactly one side succeeds`).toHaveLength(1);
      if (order === "approval first") {
        expect(out.write, label).toMatchObject({ ok: false, code: "42501", hint: "week_approved" });
        expect(await c.kept(), `${label}: nothing of the refused write is kept`).toBe(false);
        expect(await state(c.person, c.week), `${label}: the approval is still current`).toMatchObject({ state: "approved", approved_revision: seen, revision: seen });
      } else {
        expect(out.approval, label).toMatchObject({ ok: false, code: "22023", hint: "stale_revision" });
        expect(await c.kept(), `${label}: the write is kept`).toBe(true);
        const now = await revision(c.person, c.week);
        expect(now, `${label}: the write changed the revision`).not.toBe(seen);
        await approveNow(c.person, c.week, now);
        expect(await state(c.person, c.week), `${label}: approving again covers it`).toMatchObject({ state: "approved", approved_revision: now });
      }
    }
  }
}

const sessionCount = (job: string, where = "true") =>
  one<{ n: number }>(`select count(*)::int as n from public.operator_sessions where job_id = $1 and ${where}`, [job]).then((r) => r.n);
const startRun = (who: Who, job: string, machines: string[]) =>
  q(who, "select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => null, p_override => false, p_reason => null)", [job, machines, randomUUID()]);
const sheetStart = (who: Who, job: string) => q(who, "select public.record_labour_event($1, $2, 'start', null)", [randomUUID(), job]);

describe("an approval and a write of the same person's time, at the same moment", () => {
  it("the sheet's Start", async () => {
    const w = A().workshop;
    await bothOrders(async () => {
      const job = await newJob();
      const { t, week } = await justNow();
      return { person: w.id, week, write: { who: w, sql: "select public.record_labour_event($1, $2, 'start', $3)", params: [randomUUID(), job, t] }, kept: async () => (await sessionCount(job)) === 1 };
    });
  });

  it("the sheet's Stop", async () => {
    const w = A().workshop;
    await bothOrders(async () => {
      const job = await newJob();
      await sheetStart(w, job);
      const { t, week } = await justNow();
      return { person: w.id, week, write: { who: w, sql: "select public.record_labour_event($1, $2, 'stop', $3)", params: [randomUUID(), job, t] }, kept: async () => (await sessionCount(job, "ended_at is not null")) === 1 };
    });
  });

  it("the Job Board's Start (refused whole: no run either)", async () => {
    const w = A().workshop;
    await bothOrders(async () => {
      const [job, mill] = [await newJob(), await newMachine()];
      const { t, week } = await justNow();
      return {
        person: w.id, week,
        write: { who: w, sql: "select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => $4, p_override => false, p_reason => null)", params: [job, [mill], randomUUID(), t] },
        kept: async () => {
          const runs = (await one<{ n: number }>("select count(*)::int as n from public.machine_runs where job_id = $1", [job])).n;
          const s = await sessionCount(job);
          expect(runs, "the run and the labour go together").toBe(s);
          return s === 1;
        },
      };
    });
  });

  it("the Job Board's Pause of one machine (the operator's time; the other operator's carries on)", async () => {
    const [w, o] = [A().workshop, A().office];
    await bothOrders(async () => {
      const [job, m1, m2] = [await newJob(), await newMachine(), await newMachine()];
      await startRun(w, job, [m1]);
      await startRun(o, job, [m2]);
      const { t, week } = await justNow();
      return {
        person: w.id, week,
        write: { who: w, sql: "select public.pause_machine_run($1, $2::uuid[], $3, $4)", params: [job, [m1], randomUUID(), t] },
        kept: async () => {
          expect(await sessionCount(job, `user_id = '${o.id}' and ended_at is null`), "the other operator's time carries on").toBe(1);
          return (await sessionCount(job, `user_id = '${w.id}' and ended_at is not null`)) === 1;
        },
      };
    });
  });

  it("the Job Board's Pause of the whole job: everyone's time, including someone who only joined from the sheet (their week is the one approved)", async () => {
    const [w, joiner] = [A().workshop, A().office];
    await bothOrders(async () => {
      const [job, m1] = [await newJob(), await newMachine()];
      await startRun(w, job, [m1]);
      await sheetStart(joiner, job);
      const { t, week } = await justNow();
      return {
        person: joiner.id, week,
        write: { who: w, sql: "select public.pause_machine_run($1, null, $2, $3)", params: [job, randomUUID(), t] },
        kept: async () => {
          const ended = await sessionCount(job, "ended_at is not null");
          expect([0, 2], "both people's time ends, or neither").toContain(ended);
          return ended === 2;
        },
      };
    });
  });

  it("Finish through finish_job", async () => {
    const w = A().workshop;
    await bothOrders(async () => {
      const [job, m1] = [await newJob(), await newMachine()];
      await startRun(w, job, [m1]);
      const { t, week } = await justNow();
      return {
        person: w.id, week,
        write: { who: w, sql: "select public.finish_job($1, $2, $3)", params: [job, randomUUID(), t] },
        kept: async () => {
          const finished = (await one<{ f: boolean }>("select finished_at is not null as f from public.jobs where id = $1", [job])).f;
          const ended = await sessionCount(job, "ended_at is not null");
          expect(ended, "the Finish and the labour go together").toBe(finished ? 1 : 0);
          return finished;
        },
      };
    });
  });

  it("the plain Finish of a job with no machine (everyone's sheet time on it)", async () => {
    const [w, joiner] = [A().workshop, A().office];
    await bothOrders(async () => {
      const job = await newJob();
      await sheetStart(w, job);
      await sheetStart(joiner, job);
      const { t, week } = await justNow();
      return {
        person: joiner.id, week,
        write: { who: w, sql: "update public.jobs set finished_at = $2 where id = $1", params: [job, t] },
        kept: async () => {
          const finished = (await one<{ f: boolean }>("select finished_at is not null as f from public.jobs where id = $1", [job])).f;
          expect(await sessionCount(job, "ended_at is not null"), "the Finish and the labour go together").toBe(finished ? 2 : 0);
          return finished;
        },
      };
    });
  });

  it("a clock action (050 shares the clock lock with the approval)", async () => {
    const w = A().workshop;
    await bothOrders(async () => {
      const key = randomUUID();
      const { t, week } = await justNow();
      return {
        person: w.id, week,
        write: { who: w, sql: "select public.record_attendance_event($1, 'in', $2)", params: [key, t] },
        kept: async () => (await one<{ n: number }>("select count(*)::int as n from public.attendance_events where client_op_id = $1", [key])).n === 1,
      };
    });
  });

  // The person's own corrections are refused once the week has any approval, so each case has a person-week of its own (weeks back).
  let back = 2;
  it("the person adding their own job time", async () => {
    const w = A().workshop;
    await bothOrders(async () => {
      const job = await newJob();
      const { at, week } = await weeksBack(back++);
      return {
        person: w.id, week,
        write: { who: w, sql: "select public.add_labour_session($1, null, $2, $3::timestamptz, $3::timestamptz + interval '1 hour', 'Forgot to log it')", params: [randomUUID(), job, at] },
        kept: async () => (await sessionCount(job)) === 1,
      };
    });
  });

  it("the person correcting their own job time", async () => {
    const w = A().workshop;
    await bothOrders(async () => {
      const job = await newJob();
      const { at, week } = await weeksBack(back++);
      const added = (await q<{ r: { session_id: string } }>(w, "select public.add_labour_session($1, null, $2, $3::timestamptz, $3::timestamptz + interval '1 hour', 'Forgot to log it') as r", [randomUUID(), job, at]))[0].r;
      return {
        person: w.id, week,
        write: { who: w, sql: "select public.correct_labour_session($1, $2::timestamptz, $2::timestamptz + interval '2 hours', 'Ran over')", params: [added.session_id, at] },
        kept: async () => (await sessionCount(job, "corrected_by is not null and original_started_at is not null")) === 1,
      };
    });
  });

  it("the person voiding their own job time", async () => {
    const w = A().workshop;
    await bothOrders(async () => {
      const job = await newJob();
      const { at, week } = await weeksBack(back++);
      const added = (await q<{ r: { session_id: string } }>(w, "select public.add_labour_session($1, null, $2, $3::timestamptz, $3::timestamptz + interval '1 hour', 'Forgot to log it') as r", [randomUUID(), job, at]))[0].r;
      return {
        person: w.id, week,
        write: { who: w, sql: "select public.void_labour_session($1, 'Logged it twice')", params: [added.session_id] },
        kept: async () => (await sessionCount(job, "voided_at is not null")) === 1,
      };
    });
  });
});

describe("free-running: both sent at once, head start alternating", () => {
  it("twelve rounds each of the sheet's Start and the Job Board's Start: exactly one side succeeds, the other is refused cleanly; never a deadlock or another error", async () => {
    const w = A().workshop;
    const tally = { approvalWon: 0, writeWon: 0 };
    for (const kind of ["sheet", "board"] as const) {
      for (let round = 0; round < 12; round += 1) {
        const [job, mill] = [await newJob(), await newMachine()];
        const { t, week } = await justNow();
        const seen = await revision(w.id, week);
        const write = kind === "sheet"
          ? () => q(w, "select public.record_labour_event($1, $2, 'start', $3)", [randomUUID(), job, t])
          : () => q(w, "select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => $4, p_override => false, p_reason => null)", [job, [mill], randomUUID(), t]);
        const [approval, written] = await Promise.all([
          sleep(round % 2 ? 0 : 3).then(() => settle(approveNow(w.id, week, seen))),
          sleep(round % 2 ? 3 : 0).then(() => settle(write())),
        ]);
        const label = `${kind}, round ${round}`;
        expect([approval.ok, written.ok].filter(Boolean), `${label}: exactly one side succeeds`).toHaveLength(1);
        if (approval.ok) {
          tally.approvalWon += 1;
          expect(written, label).toMatchObject({ ok: false, code: "42501", hint: "week_approved" });
          expect(await sessionCount(job), label).toBe(0);
        } else {
          tally.writeWon += 1;
          expect(approval, label).toMatchObject({ ok: false, code: "22023", hint: "stale_revision" });
          expect(await sessionCount(job), label).toBe(1);
          await approveNow(w.id, week, await revision(w.id, week));
        }
        expect(await state(w.id, week), `${label}: the week ends approved, with what it holds`).toMatchObject({ state: "approved" });
      }
    }
    expect(tally.approvalWon + tally.writeWon).toBe(24);
  });
});
