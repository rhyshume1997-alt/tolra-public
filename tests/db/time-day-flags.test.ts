/**
 * Day flags on the daily job sheet (migration 074): "Overtime", "Saturday", "Sunday", "Bank holiday" per person and day.
 *
 *   * set_time_day_flags: the person for their own days; office and admin for anyone in their company; workshop never for someone
 *     else; viewer never; another company's person refused; a future day refused; all four flags saved together;
 *   * keyed: the same key and request answers the first result (replayed) and records nothing new; the same key for something else is
 *     refused (client_op_reused); a replay after the week was approved still answers the first result;
 *   * 052's approved-week lock, exactly as for times: the person and the office are refused (week_approved); an admin may, and the week
 *     shows changed_since_approval; a week with no saved flags keeps its revision;
 *   * races with approve_time_week (050's lock order), forced on two connections in both orders, free-running, and two people crossing:
 *     either the save is refused (week_approved) or the approval's revision includes it; never both, never a deadlock;
 *   * audit: the row change and TIME_DAY_FLAGS_SET (before and after, who); reads: own rows for workshop, the company's for office and
 *     admin, nothing for viewer or the other company; no direct writes; two-step sign-in for an admin where the company requires it.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

import { type Who, become, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

type Flags = { overtime: boolean; saturday: boolean; sunday: boolean; bank_holiday: boolean };
const NONE: Flags = { overtime: false, saturday: false, sunday: false, bank_holiday: false };
const SET = "select public.set_time_day_flags($1, $2, $3::date, $4, $5, $6, $7) as r";
const args = (key: string, user: string | null, day: string, f: Flags) => [key, user, day, f.overtime, f.saturday, f.sunday, f.bank_holiday];
const setFlags = (who: Who, user: string | null, day: string, f: Flags, key = randomUUID()) =>
  q<{ r: Record<string, unknown> }>(who, SET, args(key, user, day, f)).then((r) => r[0].r);
const stored = (user: string, day: string) =>
  withDb(async (db) => (await db.query("select overtime, saturday, sunday, bank_holiday, updated_by from public.time_day_flags where user_id = $1 and day = $2::date", [user, day])).rows[0] ?? null);

/** Monday `weeksAgo` weeks before this week's (Europe/London), and a day in that week (offset from Monday). */
async function pastWeek(weeksAgo: number) {
  return withDb(async (db) => (await db.query<{ week: string }>("select to_char(public.time_week_of(now()) - $1::int * 7, 'YYYY-MM-DD') as week", [weeksAgo])).rows[0].week);
}
const plus = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
type Status = { user_id: string; revision: string; state: string };
const status = (week: string, user: string) => q<Status>(A().admin, "select * from public.time_week_status($1::date, $2)", [week, user]).then((r) => r[0]);
const approve = (user: string, week: string, revision: string) =>
  q(A().admin, "select public.approve_time_week($1, $2::date, $3, '{\"paid_minutes\": 0}'::jsonb, null)", [user, week, revision]);

describe("who may tick a day", () => {
  it("the person ticks their own day; workshop is refused on someone else's; the answer is the stored row", async () => {
    const week = await pastWeek(6);
    const sat = plus(week, 5);
    const r = await setFlags(A().workshop, null, sat, { ...NONE, saturday: true, overtime: true });
    expect(r).toMatchObject({ user_id: A().workshop.id, day: sat, saturday: true, overtime: true, sunday: false, bank_holiday: false, changed: true, replayed: false, updated_by: A().workshop.id });
    expect(await stored(A().workshop.id, sat)).toMatchObject({ saturday: true, overtime: true, updated_by: A().workshop.id });
    // Someone else's day: refused, nothing written.
    expect(await refusal(A().workshop, SET, args(randomUUID(), A().office.id, sat, { ...NONE, sunday: true }))).toMatchObject({ code: "42501", hint: "own_only" });
    expect(await stored(A().office.id, sat)).toBeNull();
    // Unticking is a save too (all four together).
    expect(await setFlags(A().workshop, A().workshop.id, sat, NONE)).toMatchObject({ saturday: false, overtime: false, changed: true });
    expect(await stored(A().workshop.id, sat)).toMatchObject({ saturday: false, overtime: false });
  });

  it("office and admin tick anyone's day in their company; the other company's person, a viewer and a future day are refused", async () => {
    const week = await pastWeek(7);
    const sun = plus(week, 6);
    expect(await setFlags(A().office, A().workshop.id, sun, { ...NONE, sunday: true })).toMatchObject({ user_id: A().workshop.id, sunday: true, updated_by: A().office.id });
    expect(await setFlags(A().admin, A().workshop.id, sun, { ...NONE, sunday: true, overtime: true })).toMatchObject({ overtime: true, updated_by: A().admin.id });
    // Another company's person (beta's workshop) from alpha's office or admin: not in this company.
    expect(await refusal(A().office, SET, args(randomUUID(), B().workshop.id, sun, { ...NONE, sunday: true }))).toMatchObject({ code: "P0002", hint: "not_member" });
    expect(await refusal(A().admin, SET, args(randomUUID(), B().workshop.id, sun, { ...NONE, sunday: true }))).toMatchObject({ code: "P0002", hint: "not_member" });
    expect(await stored(B().workshop.id, sun)).toBeNull();
    // A viewer: never (own or anyone's).
    expect(await refusal(A().viewer, SET, args(randomUUID(), null, sun, NONE))).toMatchObject({ code: "42501", hint: "not_allowed" });
    expect(await refusal(A().viewer, SET, args(randomUUID(), A().workshop.id, sun, NONE))).toMatchObject({ code: "42501", hint: "not_allowed" });
    // Not a future day; every flag needs a yes or no.
    const tomorrow = await withDb(async (db) => (await db.query<{ d: string }>("select to_char((now() at time zone 'Europe/London')::date + 1, 'YYYY-MM-DD') as d")).rows[0].d);
    expect(await refusal(A().workshop, SET, args(randomUUID(), null, tomorrow, NONE))).toMatchObject({ code: "22023", hint: "bad_day" });
    expect(await refusal(A().workshop, SET, [randomUUID(), null, sun, null, false, false, false])).toMatchObject({ code: "22023", hint: "bad_flags" });
    expect(await refusal(A().workshop, SET, args(null as unknown as string, null, sun, NONE))).toMatchObject({ code: "22023", hint: "client_op_missing" });
  });

  it("an admin needs the second sign-in step when the company requires it", async () => {
    const day = plus(await pastWeek(8), 2);
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query("update public.organizations set require_admin_mfa = true where id = $1", [world.tenants.alpha.id]);
      await db.query("commit");
    });
    try {
      expect(await refusal(A().admin, SET, args(randomUUID(), A().workshop.id, day, NONE))).toMatchObject({ code: "42501", hint: "mfa_required" });
      const r = await withDb(async (db) => {
        await db.query("begin");
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A().admin.id, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: "aal2" })]);
        const out = (await db.query(SET, args(randomUUID(), A().workshop.id, day, { ...NONE, overtime: true }))).rows[0].r;
        await db.query("commit");
        return out;
      });
      expect(r).toMatchObject({ overtime: true });
      // Workshop and office are not admins: their own day is unaffected by the admin rule.
      expect(await setFlags(A().workshop, null, day, NONE)).toMatchObject({ overtime: false });
    } finally {
      await withDb(async (db) => {
        await db.query("begin");
        await db.query("set local session_replication_role = replica");
        await db.query("update public.organizations set require_admin_mfa = false where id = $1", [world.tenants.alpha.id]);
        await db.query("commit");
      });
    }
  });
});

describe("keyed saves", () => {
  it("a replay of the same key answers the first result and records nothing new; the key for something else is refused", async () => {
    const day = plus(await pastWeek(9), 0);
    const key = randomUUID();
    const first = await setFlags(A().workshop, null, day, { ...NONE, bank_holiday: true }, key);
    // Something else changes the day in between (the office); the replay still answers the first result and changes nothing.
    await setFlags(A().office, A().workshop.id, day, { ...NONE, overtime: true });
    const again = await setFlags(A().workshop, null, day, { ...NONE, bank_holiday: true }, key);
    expect(again).toEqual({ ...first, replayed: true });
    expect(await stored(A().workshop.id, day)).toMatchObject({ overtime: true, bank_holiday: false });
    const ops = await withDb(async (db) => (await db.query("select count(*)::int as n from public.time_day_flag_ops where client_op_id = $1", [key])).rows[0].n);
    expect(ops).toBe(1);
    const events = await withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where action = 'TIME_DAY_FLAGS_SET' and metadata ->> 'user_id' = $1 and metadata ->> 'day' = $2", [A().workshop.id, day])).rows[0].n);
    expect(events).toBe(2);
    // The same key with another request: refused.
    expect(await refusal(A().workshop, SET, args(key, null, day, { ...NONE, sunday: true }))).toMatchObject({ code: "22023", hint: "client_op_reused" });
    // A save that changes nothing is answered (changed false) and not audited again.
    expect(await setFlags(A().office, A().workshop.id, day, { ...NONE, overtime: true })).toMatchObject({ changed: false, overtime: true });
    const after = await withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where action = 'TIME_DAY_FLAGS_SET' and metadata ->> 'user_id' = $1 and metadata ->> 'day' = $2", [A().workshop.id, day])).rows[0].n);
    expect(after).toBe(2);
  });

  it("who ticked what and when is in the audit log: the row change and TIME_DAY_FLAGS_SET with before and after", async () => {
    const day = plus(await pastWeek(10), 1);
    await setFlags(A().workshop, null, day, { ...NONE, overtime: true });
    await setFlags(A().office, A().workshop.id, day, NONE);
    const rows = await withDb(async (db) => (await db.query(
      "select actor_user_id, metadata from security_audit.audit_log where action = 'TIME_DAY_FLAGS_SET' and metadata ->> 'user_id' = $1 and metadata ->> 'day' = $2 order by created_at, id",
      [A().workshop.id, day])).rows);
    expect(rows.map((r) => r.actor_user_id)).toEqual([A().workshop.id, A().office.id]);
    expect(rows[0].metadata).toMatchObject({ before: null, after: { overtime: true, saturday: false, sunday: false, bank_holiday: false } });
    expect(rows[1].metadata).toMatchObject({ before: { overtime: true }, after: { overtime: false } });
    const rowChanges = await withDb(async (db) => (await db.query(
      "select count(*)::int as n from security_audit.audit_log a join public.time_day_flags f on f.id::text = a.entity_id where a.entity_table = 'time_day_flags' and f.user_id = $1 and f.day = $2::date and a.action <> 'TIME_DAY_FLAGS_SET'",
      [A().workshop.id, day])).rows[0].n);
    expect(rowChanges).toBe(2);
  });
});

describe("approved weeks (052's lock)", () => {
  it("after approval the person and the office are refused; an admin may, and the week shows changed since approval; a replay still answers", async () => {
    const week = await pastWeek(3);
    const who = A().workshop;
    const sat = plus(week, 5);
    const key = randomUUID();
    await setFlags(who, null, sat, { ...NONE, saturday: true }, key);
    const r1 = (await status(week, who.id)).revision;
    await approve(who.id, week, r1);
    expect((await status(week, who.id)).state).toBe("approved");
    // The person (any day of that week) and the office: refused.
    expect(await refusal(who, SET, args(randomUUID(), null, sat, NONE))).toMatchObject({ code: "42501", hint: "week_approved" });
    expect(await refusal(who, SET, args(randomUUID(), null, week, { ...NONE, overtime: true }))).toMatchObject({ code: "42501", hint: "week_approved" });
    expect(await refusal(A().office, SET, args(randomUUID(), who.id, plus(week, 6), { ...NONE, sunday: true }))).toMatchObject({ code: "42501", hint: "week_approved" });
    expect(await stored(who.id, sat)).toMatchObject({ saturday: true });
    // The device's retry of the save made before the approval answers the first result.
    expect(await setFlags(who, null, sat, { ...NONE, saturday: true }, key)).toMatchObject({ replayed: true, saturday: true });
    expect((await status(week, who.id)).state).toBe("approved");
    // The week before and after are not locked.
    await setFlags(who, null, plus(week, -1), { ...NONE, sunday: true });
    // An admin may: the week shows changed since approval, then approved again.
    await setFlags(A().admin, who.id, sat, { ...NONE, saturday: true, overtime: true });
    const s = await status(week, who.id);
    expect(s.state).toBe("changed_since_approval");
    expect(s.revision).not.toBe(r1);
    await approve(who.id, week, s.revision);
    expect((await status(week, who.id)).state).toBe("approved");
  });

  it("a week with no saved flags keeps its revision; saving one changes it, saving the same again does not", async () => {
    const week = await pastWeek(4);
    const who = A().office;
    const r0 = (await status(week, who.id)).revision;
    expect((await status(week, who.id)).revision).toBe(r0);
    const tue = plus(week, 1);
    await setFlags(who, null, tue, { ...NONE, overtime: true });
    const r1 = (await status(week, who.id)).revision;
    expect(r1).not.toBe(r0);
    await setFlags(A().admin, who.id, tue, { ...NONE, overtime: true });
    expect((await status(week, who.id)).revision).toBe(r1);
    // A flag on a day of another week leaves this week's revision alone.
    await setFlags(who, null, plus(week, 7), { ...NONE, overtime: true });
    expect((await status(week, who.id)).revision).toBe(r1);
  });
});

describe("races with approve_time_week (050's lock order: company lock, then the person's; the week asked after both)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  type Outcome = { ok: true } | { ok: false; code?: string; hint?: string; message: string };
  const settle = (p: Promise<unknown>): Promise<Outcome> =>
    p.then(() => ({ ok: true as const }), (e: { code?: string; hint?: string; message: string }) => ({ ok: false as const, code: e.code, hint: e.hint, message: e.message }));
  const revision = (user: string, week: string) =>
    withDb(async (db) => (await db.query<{ r: string }>("select public.time_week_revision($1, $2, $3::date) as r", [world.tenants.alpha.id, user, week])).rows[0].r);

  /** Waits until connection `pid` is blocked on an advisory lock (true), or gives up after ~5 s (false). */
  async function waitsOnAdvisoryLock(watch: Client, pid: number) {
    for (let i = 0; i < 500; i += 1) {
      const r = await watch.query<{ t: string | null; e: string | null }>("select wait_event_type as t, wait_event as e from pg_stat_activity where pid = $1", [pid]);
      if (r.rows[0]?.t === "Lock" && r.rows[0]?.e === "advisory") return true;
      await sleep(10);
    }
    return false;
  }

  type Order = "approval first" | "save first";
  /** One forced interleaving on two connections: the first side runs and holds its transaction; the second is seen waiting on the lock; then the first commits. */
  async function race(order: Order, person: string, week: string, seen: string, saver: Who, day: string) {
    return withDb((ca) => withDb((cb) => withDb(async (watch) => {
      const pidOf = async (c: Client) => (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      const [pa, pb] = [await pidOf(ca), await pidOf(cb)];
      await ca.query("begin");
      await become(ca, A().admin);
      await cb.query("begin");
      await become(cb, saver);
      const approveIt = () => settle(ca.query("select public.approve_time_week($1, $2::date, $3, '{\"paid_minutes\": 0}'::jsonb, null)", [person, week, seen]));
      const saveIt = () => settle(cb.query(SET, args(randomUUID(), person, day, { ...NONE, overtime: true, saturday: true })));
      const [first, second, firstConn, secondConn, secondPid] = order === "approval first" ? [approveIt, saveIt, ca, cb, pb] : [saveIt, approveIt, cb, ca, pa];
      const a = await first();
      expect(a, `${order}: the first side succeeds on its own`).toEqual({ ok: true });
      const pending = second();
      const waited = await waitsOnAdvisoryLock(watch, secondPid);
      await firstConn.query("commit");
      const b = await pending;
      await secondConn.query(b.ok ? "commit" : "rollback");
      return order === "approval first" ? { approval: a, save: b, waited } : { approval: b, save: a, waited };
    })));
  }

  let back = 20;
  it("forced, both orders, three rounds each, the person and the office saving: exactly one side wins; refused whole, or covered by the approval", async () => {
    const who = A().workshop;
    for (const order of ["approval first", "save first"] as const) {
      for (let round = 0; round < 3; round += 1) {
        const week = await pastWeek(back++);
        const day = plus(week, 5);
        const saver = round % 2 ? A().office : who;
        const seen = await revision(who.id, week);
        const out = await race(order, who.id, week, seen, saver, day);
        const label = `${order}, round ${round}`;
        expect(out.waited, `${label}: the second side waited on the lock`).toBe(true);
        expect([out.approval.ok, out.save.ok].filter(Boolean), `${label}: exactly one side succeeds`).toHaveLength(1);
        if (order === "approval first") {
          expect(out.save, label).toMatchObject({ ok: false, code: "42501", hint: "week_approved" });
          expect(await stored(who.id, day), `${label}: nothing of the refused save is kept`).toBeNull();
          expect(await status(week, who.id), `${label}: the approval is still current`).toMatchObject({ state: "approved", revision: seen });
        } else {
          expect(out.approval, label).toMatchObject({ ok: false, code: "22023", hint: "stale_revision" });
          expect(await stored(who.id, day), `${label}: the save is kept`).toMatchObject({ overtime: true, saturday: true });
          const now = await revision(who.id, week);
          expect(now, `${label}: the save changed the revision`).not.toBe(seen);
          await approve(who.id, week, now);
          expect(await status(week, who.id), `${label}: approving again covers the save`).toMatchObject({ state: "approved", revision: now });
        }
      }
    }
  });

  it("free-running, twelve rounds: one side wins each time, the other is refused cleanly; never a deadlock or another error", async () => {
    const who = A().workshop;
    const tally = { approvalWon: 0, saveWon: 0 };
    for (let round = 0; round < 12; round += 1) {
      const week = await pastWeek(back++);
      const day = plus(week, 2);
      const seen = await revision(who.id, week);
      const saver = round % 3 === 2 ? A().office : who;
      const [approval, saved] = await Promise.all([
        sleep(round % 2 ? 0 : 3).then(() => settle(approve(who.id, week, seen))),
        sleep(round % 2 ? 3 : 0).then(() => settle(setFlags(saver, who.id, day, { ...NONE, bank_holiday: true }))),
      ]);
      const label = `round ${round}`;
      expect([approval.ok, saved.ok].filter(Boolean), `${label}: exactly one side succeeds`).toHaveLength(1);
      if (approval.ok) {
        tally.approvalWon += 1;
        expect(saved, label).toMatchObject({ ok: false, code: "42501", hint: "week_approved" });
        expect(await stored(who.id, day), label).toBeNull();
      } else {
        tally.saveWon += 1;
        expect(approval, label).toMatchObject({ ok: false, code: "22023", hint: "stale_revision" });
        expect(await stored(who.id, day), label).toMatchObject({ bank_holiday: true });
        await approve(who.id, week, await revision(who.id, week));
      }
      expect(await status(week, who.id), `${label}: the week ends approved, with what it holds`).toMatchObject({ state: "approved" });
    }
    expect(tally.approvalWon + tally.saveWon).toBe(12);
  });

  it("two people's saves and approvals crossing (A's save with B's approval, and back) never deadlock", async () => {
    const [x, y] = [A().workshop, A().office];
    for (let round = 0; round < 6; round += 1) {
      const week = await pastWeek(back++);
      const [rx, ry] = [await revision(x.id, week), await revision(y.id, week)];
      const results = await Promise.all([
        settle(setFlags(x, null, plus(week, 1), { ...NONE, overtime: true })),
        settle(approve(y.id, week, ry)),
        settle(setFlags(y, null, plus(week, 1), { ...NONE, overtime: true })),
        settle(approve(x.id, week, rx)),
      ]);
      for (const r of results) if (!r.ok) expect(["week_approved", "stale_revision"], `round ${round}: ${r.message}`).toContain(r.hint);
      expect(results.some((r) => !r.ok && r.code === "40P01"), `round ${round}: no deadlock`).toBe(false);
      // For each person exactly one of their save and their approval succeeds.
      expect([results[0].ok, results[3].ok].filter(Boolean), `round ${round}: one side for ${x.id}`).toHaveLength(1);
      expect([results[2].ok, results[1].ok].filter(Boolean), `round ${round}: one side for ${y.id}`).toHaveLength(1);
    }
  });
});

describe("reads and writes", () => {
  it("workshop reads its own rows, office and admin the company's, viewer and the other company nothing; no direct writes", async () => {
    const day = plus(await pastWeek(13), 0);
    await setFlags(A().workshop, null, day, { ...NONE, overtime: true });
    await setFlags(A().office, null, day, { ...NONE, sunday: true });
    await setFlags(B().workshop, null, day, { ...NONE, saturday: true });
    const seen = (who: Who) => q<{ user_id: string }>(who, "select user_id from public.time_day_flags where day = $1::date order by user_id", [day]).then((r) => r.map((x) => x.user_id));
    expect(await seen(A().workshop)).toEqual([A().workshop.id]);
    expect((await seen(A().office)).sort()).toEqual([A().workshop.id, A().office.id].sort());
    expect((await seen(A().admin)).sort()).toEqual([A().workshop.id, A().office.id].sort());
    expect(await seen(A().viewer)).toEqual([]);
    expect(await seen(B().admin)).toEqual([B().workshop.id]);
    // No direct writes (the function is the only way in), and the keyed answers table is not readable.
    expect(await refusal(A().admin, "insert into public.time_day_flags (organization_id, user_id, day) values ($1, $2, $3::date)", [world.tenants.alpha.id, A().admin.id, day])).toMatchObject({ code: "42501" });
    expect(await refusal(A().workshop, "update public.time_day_flags set overtime = false where user_id = $1", [A().workshop.id])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "delete from public.time_day_flags where user_id = $1", [A().workshop.id])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "select * from public.time_day_flag_ops limit 1")).toMatchObject({ code: "42501" });
  });
});
