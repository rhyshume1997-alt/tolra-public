/**
 * Weekly review and approval (migration 052).
 *
 *   * time_week_status: per person, the revision of their week, the latest approval, and the state (not approved, approved, changed
 *     since approval); workshop sees their own row only, admin and office everyone, viewer refused, the other company never;
 *   * approve_time_week: admin by default (the company's approver roles; office once added); the revision the approver saw must still
 *     be current (stale_revision otherwise); a week that hasn't started, a non-Monday, someone of another company refused; audited;
 *   * after approval the person can't change that week themselves (clock or job time); an admin can, and the week then shows
 *     changed_since_approval until approved again (a new row; approvals are never changed or removed);
 *   * read: own approvals for workshop, the company's for admin and office; no direct writes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, clock, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

/** This week's Monday (Europe/London) and an instant in this week that is not in the future. */
async function thisWeek() {
  return withDb(async (db) => (await db.query<{ week: string; at: string }>(
    "select to_char(public.time_week_of(now()), 'YYYY-MM-DD') as week, least(now(), greatest(public.time_week_of(now())::timestamp at time zone 'Europe/London' + interval '1 second', now() - interval '20 hours'))::text as at")).rows[0]);
}
type Status = { user_id: string; revision: string; state: string; approved_revision: string | null; totals: Record<string, unknown> | null };
const status = (who: Who, week: string, user: string | null = null) =>
  q<Status>(who, "select * from public.time_week_status($1::date, $2)", [week, user]);
const approve = (who: Who, user: string, week: string, revision: string, totals: Record<string, unknown> = { paid_minutes: 480 }) =>
  q<{ r: Record<string, unknown> }>(who, "select public.approve_time_week($1, $2::date, $3, $4::jsonb, null) as r", [user, week, revision, JSON.stringify(totals)]).then((r) => r[0].r);

describe("weekly approval", () => {
  it("not approved -> approved -> changed since approval (an admin's correction) -> approved again; the person is locked out of an approved week", async () => {
    const { week, at } = await thisWeek();
    const inn = await clock(A().workshop, "in", at);
    let rows = await status(A().admin, week, A().workshop.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: A().workshop.id, state: "not_approved", approved_revision: null });
    const r1 = rows[0].revision;
    const ok = await approve(A().admin, A().workshop.id, week, r1, { paid_minutes: 465, overtime_minutes: 0 });
    expect(ok).toMatchObject({ state: "approved", revision: r1 });
    rows = await status(A().workshop, week);
    expect(rows).toEqual([expect.objectContaining({ user_id: A().workshop.id, state: "approved", approved_revision: r1, totals: { paid_minutes: 465, overtime_minutes: 0 } })]);
    // The person can't change the approved week: clock records or job time.
    expect(await refusal(A().workshop, "select public.correct_attendance_event($1, null, $2, 'in', $3, 'Wrong time')", [randomUUID(), inn.event_id, at])).toMatchObject({ code: "42501", hint: "week_approved" });
    const job = (await withDb((db) => db.query("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Week Co') returning id", [world.tenants.alpha.id, `J-W-${randomUUID().slice(0, 6)}`]))).rows[0].id;
    expect(await refusal(A().workshop, "select public.add_labour_session($1, null, $2, $3, $3::timestamptz + interval '1 hour', 'Forgot')", [randomUUID(), job, at])).toMatchObject({ hint: "week_approved" });
    // An admin can; the week then shows changed since approval.
    await q(A().admin, "select public.correct_attendance_event($1, $2, $3, 'in', $4::timestamptz, 'Re-recorded by the office')", [randomUUID(), A().workshop.id, inn.event_id, at]);
    rows = await status(A().admin, week, A().workshop.id);
    expect(rows[0]).toMatchObject({ state: "changed_since_approval", approved_revision: r1 });
    expect(rows[0].revision).not.toBe(r1);
    // Approving with the old revision is refused; with the current one it is approved again (a second row).
    expect(await refusal(A().admin, "select public.approve_time_week($1, $2::date, $3, '{}'::jsonb)", [A().workshop.id, week, r1])).toMatchObject({ code: "22023", hint: "stale_revision" });
    await approve(A().admin, A().workshop.id, week, rows[0].revision);
    expect((await status(A().admin, week, A().workshop.id))[0]).toMatchObject({ state: "approved" });
    const count = await withDb(async (db) => (await db.query("select count(*)::int as n from public.time_week_approvals where user_id = $1 and week_start = $2", [A().workshop.id, week])).rows[0].n);
    expect(count).toBe(2);
    const audit = await withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where action = 'TIME_WEEK_APPROVED' and metadata ->> 'user_id' = $1", [A().workshop.id])).rows[0].n);
    expect(audit).toBe(2);
  });

  it("after approval the person can't back-date a clock action or job time into the approved hours; live ones after it are kept and show the change; an admin may", async () => {
    const { week, at } = await thisWeek();
    const who = A().office;
    await clock(who, "in", at);
    const rev = (await status(A().admin, week, who.id))[0].revision;
    await approve(A().admin, who.id, week, rev);
    // A device sending a time before the approval (offline for a while), in the approved week: refused.
    expect(await refusal(who, "select public.record_attendance_event($1, 'out', $2)", [randomUUID(), at])).toMatchObject({ code: "42501", hint: "week_approved" });
    const job = (await withDb((db) => db.query("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Week Co') returning id", [world.tenants.alpha.id, `J-W-${randomUUID().slice(0, 6)}`]))).rows[0].id;
    expect(await refusal(who, "select public.record_labour_event($1, $2, 'start', $3)", [randomUUID(), job, at])).toMatchObject({ code: "42501", hint: "week_approved" });
    // Clocking out now (after the approval) is recorded, and the week shows the change.
    await clock(who, "out", null);
    expect((await status(A().admin, week, who.id))[0]).toMatchObject({ state: "changed_since_approval" });
    // An admin is never refused (they can correct anything).
    await clock(A().admin, "in", at);
    const adminRev = (await status(A().admin, week, A().admin.id))[0].revision;
    await approve(A().admin, A().admin.id, week, adminRev);
    await clock(A().admin, "break_start", at);
  });

  it("the Job Board can't back-date labour into approved hours either: a late Start or Pause is refused; doing it now is kept and flagged", async () => {
    const { week } = await thisWeek();
    const who = A().workshop;
    const org = world.tenants.alpha.id;
    const [job, mill] = await withDb(async (db) => [
      (await db.query("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Week Co') returning id", [org, `J-W-${randomUUID().slice(0, 6)}`])).rows[0].id,
      (await db.query("insert into public.machines (organization_id, name) values ($1, $2) returning id", [org, `Mill ${randomUUID().slice(0, 6)}`])).rows[0].id,
    ]);
    const start = (at: string | null) => q(who, "select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => $4, p_override => false, p_reason => null)", [job, [mill], randomUUID(), at]);
    // The week is approved now; a Start sent late with a time before the approval (in the same week) is refused, nothing written.
    await approve(A().admin, who.id, week, (await status(A().admin, week, who.id))[0].revision);
    const before = new Date(Date.now() - 60_000).toISOString();
    const late = await withDb(async (db) => (await db.query("select greatest($1::timestamptz, public.time_week_of(now())::timestamp at time zone 'Europe/London') as t", [before])).rows[0].t);
    expect(await refusal(who, "select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => $4, p_override => false, p_reason => null)", [job, [mill], randomUUID(), late])).toMatchObject({ code: "42501", hint: "week_approved" });
    expect((await withDb((db) => db.query("select count(*)::int as n from public.machine_runs where job_id = $1", [job]))).rows[0].n).toBe(0);
    // Starting now is accepted and the week shows the change.
    await start(null);
    expect((await withDb((db) => db.query("select count(*)::int as n from public.operator_sessions where job_id = $1 and ended_at is null", [job]))).rows[0].n).toBe(1);
    expect((await status(A().admin, week, who.id))[0]).toMatchObject({ state: "changed_since_approval" });
    // Approved again while the machine runs; a Pause sent late with a time before that approval is refused; Pause now works.
    const startedAt = (await withDb((db) => db.query("select started_at from public.machine_runs where job_id = $1", [job]))).rows[0].started_at as Date;
    await approve(A().admin, who.id, week, (await status(A().admin, week, who.id))[0].revision);
    const between = new Date(startedAt.getTime() + 1).toISOString();
    expect(await refusal(who, "select public.pause_machine_run($1, null, $2, $3)", [job, randomUUID(), between])).toMatchObject({ code: "42501", hint: "week_approved" });
    await q(who, "select public.pause_machine_run($1, null, $2, null)", [job, randomUUID()]);
    expect((await withDb((db) => db.query("select end_source from public.operator_sessions where job_id = $1", [job]))).rows).toEqual([{ end_source: "machine_pause" }]);
    expect((await status(A().admin, week, who.id))[0]).toMatchObject({ state: "changed_since_approval" });
  });

  it("a change to the hours settings shows as changed since approval", async () => {
    const { week } = await thisWeek();
    const rev = (await status(A().admin, week, A().workshop.id))[0].revision;
    await approve(A().admin, A().workshop.id, week, rev);
    await q(A().admin, "select public.save_time_settings($1::jsonb)", [JSON.stringify({ approver_roles: ["admin", "office"] })]);
    expect((await status(A().admin, week, A().workshop.id))[0]).toMatchObject({ state: "approved" }); // who approves: not a figure
    await q(A().admin, "select public.save_time_settings($1::jsonb)", [JSON.stringify({ sunday_overtime: false, approver_roles: ["admin"] })]);
    expect((await status(A().admin, week, A().workshop.id))[0]).toMatchObject({ state: "changed_since_approval" });
    await q(A().admin, "select public.save_time_settings($1::jsonb)", [JSON.stringify({ sunday_overtime: true })]);
    expect((await status(A().admin, week, A().workshop.id))[0]).toMatchObject({ state: "approved" });
  });

  it("job time changes the revision too", async () => {
    const { week } = await thisWeek();
    const before = (await status(A().office, week, A().office.id))[0].revision;
    const job = (await withDb((db) => db.query("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Week Co') returning id", [world.tenants.alpha.id, `J-W-${randomUUID().slice(0, 6)}`]))).rows[0].id;
    await q(A().office, "select public.record_labour_event($1, $2, 'start', $3)", [randomUUID(), job, null]);
    expect((await status(A().office, week, A().office.id))[0].revision).not.toBe(before);
  });

  it("approver roles: admin by default; office once the company adds it; workshop and viewer never", async () => {
    const { week } = await thisWeek();
    const rev = (await status(A().admin, week, A().office.id))[0].revision;
    expect(await refusal(A().office, "select public.approve_time_week($1, $2::date, $3, '{}'::jsonb)", [A().office.id, week, rev])).toMatchObject({ code: "42501", hint: "not_approver" });
    expect(await refusal(A().workshop, "select public.approve_time_week($1, $2::date, $3, '{}'::jsonb)", [A().workshop.id, week, rev])).toMatchObject({ code: "42501", hint: "not_approver" });
    await q(A().admin, "select public.save_time_settings($1::jsonb)", [JSON.stringify({ approver_roles: ["admin", "office"] })]);
    expect(await approve(A().office, A().office.id, week, rev)).toMatchObject({ state: "approved" });
    await q(A().admin, "select public.save_time_settings($1::jsonb)", [JSON.stringify({ approver_roles: ["admin"] })]);
    expect(await refusal(A().viewer, "select * from public.time_week_status($1::date)", [week])).toMatchObject({ code: "42501", hint: "not_allowed" });
  });

  it("checks the week and the person: a non-Monday, a week not started, someone of the other company", async () => {
    const { week } = await thisWeek();
    const rev = (await status(A().admin, week, A().admin.id))[0].revision;
    const tuesday = new Date(new Date(`${week}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
    const next = new Date(new Date(`${week}T12:00:00Z`).getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    expect(await refusal(A().admin, "select public.approve_time_week($1, $2::date, $3, '{}'::jsonb)", [A().admin.id, tuesday, rev])).toMatchObject({ hint: "bad_week" });
    expect(await refusal(A().admin, "select public.approve_time_week($1, $2::date, $3, '{}'::jsonb)", [A().admin.id, next, rev])).toMatchObject({ hint: "future_week" });
    expect(await refusal(A().admin, "select public.approve_time_week($1, $2::date, $3, '{}'::jsonb)", [B().workshop.id, week, rev])).toMatchObject({ code: "P0002", hint: "not_member" });
    expect(await refusal(A().admin, "select public.approve_time_week($1, $2::date, $3, '[]'::jsonb)", [A().admin.id, week, rev])).toMatchObject({ hint: "bad_totals" });
  });

  it("status: workshop sees only their own; admin and office see the company's people, never the other company's", async () => {
    const { week } = await thisWeek();
    expect((await status(A().workshop, week)).map((r) => r.user_id)).toEqual([A().workshop.id]);
    expect(await refusal(A().workshop, "select * from public.time_week_status($1::date, $2)", [week, A().office.id])).toMatchObject({ code: "42501", hint: "own_only" });
    for (const who of [A().admin, A().office]) {
      const ids = (await status(who, week)).map((r) => r.user_id);
      expect(ids).toEqual(expect.arrayContaining([A().admin.id, A().office.id, A().workshop.id]));
      expect(ids).not.toContain(A().viewer.id); // a viewer records no time
      for (const u of Object.values(B())) expect(ids).not.toContain(u.id);
    }
    expect(await status(A().admin, week, B().workshop.id)).toEqual([]);
  });
});

describe("the table", () => {
  it("approvals are never changed or removed; read own (workshop) or the company's (admin, office); no direct writes", async () => {
    const id = (await withDb((db) => db.query("select id from public.time_week_approvals where organization_id = $1 limit 1", [world.tenants.alpha.id]))).rows[0].id;
    for (const sql of ["update public.time_week_approvals set note = 'x' where id = $1", "delete from public.time_week_approvals where id = $1"]) {
      const hint = await withDb(async (db) => { try { await db.query(sql, [id]); return null; } catch (e) { return (e as { hint?: string }).hint; } });
      expect(hint).toBe("approval_immutable");
    }
    expect((await q<{ user_id: string }>(A().workshop, "select distinct user_id from public.time_week_approvals")).map((r) => r.user_id)).toEqual([A().workshop.id]);
    expect((await q(A().office, "select distinct user_id from public.time_week_approvals")).length).toBeGreaterThan(1);
    expect(await q(A().viewer, "select 1 from public.time_week_approvals")).toEqual([]);
    expect(await q(B().admin, "select 1 from public.time_week_approvals")).toEqual([]);
    expect(await refusal(A().admin, "insert into public.time_week_approvals (organization_id, user_id, week_start, revision, totals) values ($1, $2, '2026-10-12', repeat('a', 32), '{}')", [world.tenants.alpha.id, A().admin.id])).toMatchObject({ code: "42501" });
  });
});
