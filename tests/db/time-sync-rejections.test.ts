/**
 * Refused late time actions made visible to the office (migration 075, G18).
 *
 *   * report_time_sync_rejection: the caller's own refused clock or labour action in their own company, checked by the server (a time
 *     in a week approved after it, week_approved; a time over 14 days old, time_too_old; an action recorded under that key, op_applied);
 *   * idempotent per key: the same key and request answers the first row (replayed), one row; the same key for something else, or
 *     another person using that key, is refused (client_op_reused);
 *   * reads: admin and office the company's rows; workshop its own; viewer and the other company none; no direct writes;
 *   * resolve_time_sync_rejection: office or admin, audited, a second call answers the row; workshop refused; another company's row not
 *     found.
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

const REPORT = "select public.report_time_sync_rejection($1, $2, $3, $4, $5, $6, $7, $8) as r";
type Report = { key: string; kind: "clock" | "labour"; action: string; at: string; code: "week_approved" | "time_too_old"; reason?: string | null; job?: string | null; device?: string | null };
const args = (r: Report) => [r.key, r.kind, r.action, r.at, r.code, r.reason ?? null, r.job ?? null, r.device ?? null];
const report = (who: Who, r: Report) => q<{ r: Record<string, unknown> }>(who, REPORT, args(r)).then((rows) => rows[0].r);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const rowsFor = (key: string) => withDb(async (db) => (await db.query("select * from public.time_sync_rejections where client_op_id = $1", [key])).rows);

describe("time_too_old", () => {
  it("the refused clock action is reported once per key; a replay answers the first row; the key can't be reused", async () => {
    const key = randomUUID();
    const at = daysAgo(20);
    // What the device saw at sync: refused as too old.
    expect(await refusal(A().workshop, "select public.record_attendance_event($1, 'in', $2, 'Phone')", [key, at])).toMatchObject({ code: "22023", hint: "time_too_old" });
    const r: Report = { key, kind: "clock", action: "in", at, code: "time_too_old", reason: "Clock in at 29/09/2026 is more than 14 days old", device: "Phone" };
    const first = await report(A().workshop, r);
    expect(first).toMatchObject({ user_id: A().workshop.id, op_kind: "clock", action: "in", code: "time_too_old", client_op_id: key, replayed: false, resolved_at: null });
    const again = await report(A().workshop, { ...r, reason: "different words on a retry" });
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect(await rowsFor(key)).toHaveLength(1);
    expect((await rowsFor(key))[0]).toMatchObject({ device_reason: r.reason, device_label: "Phone", organization_id: world.tenants.alpha.id });
    // The same key for another action, or by someone else (own ops only): refused, nothing written.
    expect(await refusal(A().workshop, REPORT, args({ ...r, action: "out" }))).toMatchObject({ code: "22023", hint: "client_op_reused" });
    expect(await refusal(A().office, REPORT, args(r))).toMatchObject({ code: "22023", hint: "client_op_reused" });
    expect(await rowsFor(key)).toHaveLength(1);
    const audit = await withDb(async (db) => (await db.query("select actor_user_id, metadata from security_audit.audit_log where action = 'TIME_SYNC_REJECTION_REPORTED' and entity_id = $1", [String(first.id)])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: A().workshop.id, metadata: { code: "time_too_old", kind: "clock", action: "in" } });
  });

  it("the server checks the claim: a recent time is not too old; a recorded action was not refused; bad input refused", async () => {
    expect(await refusal(A().workshop, REPORT, args({ key: randomUUID(), kind: "clock", action: "in", at: daysAgo(3), code: "time_too_old" }))).toMatchObject({ code: "22023", hint: "not_refused" });
    const recorded = randomUUID();
    await clock(A().workshop, "out", daysAgo(1), recorded);
    expect(await refusal(A().workshop, REPORT, args({ key: recorded, kind: "clock", action: "out", at: daysAgo(20), code: "time_too_old" }))).toMatchObject({ code: "22023", hint: "op_applied" });
    expect(await refusal(A().workshop, REPORT, args({ key: randomUUID(), kind: "clock", action: "start", at: daysAgo(20), code: "time_too_old" }))).toMatchObject({ code: "22023", hint: "bad_action" });
    expect(await refusal(A().workshop, REPORT, args({ key: randomUUID(), kind: "labour", action: "start", at: daysAgo(20), code: "refused" as "time_too_old" }))).toMatchObject({ code: "22023", hint: "bad_code" });
    expect(await refusal(A().workshop, REPORT, [null, "clock", "in", daysAgo(20), "time_too_old", null, null, null])).toMatchObject({ code: "22023", hint: "client_op_missing" });
    expect(await refusal(A().viewer, REPORT, args({ key: randomUUID(), kind: "clock", action: "in", at: daysAgo(20), code: "time_too_old" }))).toMatchObject({ code: "42501", hint: "not_allowed" });
  });
});

describe("week_approved", () => {
  it("a clock and a labour action in a week approved before they synced are reported; after the approval is not", async () => {
    const week = await withDb(async (db) => (await db.query<{ w: string }>("select to_char(public.time_week_of(now()) - 7, 'YYYY-MM-DD') as w")).rows[0].w);
    const tue = new Date(Date.parse(`${week}T12:00:00Z`) + 86_400_000).toISOString();
    const st = (await q<{ revision: string }>(A().admin, "select * from public.time_week_status($1::date, $2)", [week, A().workshop.id]))[0];
    await q(A().admin, "select public.approve_time_week($1, $2::date, $3, '{\"paid_minutes\": 0}'::jsonb, null)", [A().workshop.id, week, st.revision]);
    const key = randomUUID();
    expect(await refusal(A().workshop, "select public.record_attendance_event($1, 'in', $2, 'Phone')", [key, tue])).toMatchObject({ code: "42501", hint: "week_approved" });
    expect(await report(A().workshop, { key, kind: "clock", action: "in", at: tue, code: "week_approved" })).toMatchObject({ code: "week_approved", replayed: false });
    expect(await report(A().workshop, { key: randomUUID(), kind: "labour", action: "start", at: tue, code: "week_approved", job: "J-1042" })).toMatchObject({ op_kind: "labour", action: "start" });
    // The office's own week is not approved: not a refusal the server would make.
    expect(await refusal(A().office, REPORT, args({ key: randomUUID(), kind: "clock", action: "in", at: tue, code: "week_approved" }))).toMatchObject({ hint: "not_refused" });
  });

  it("an admin is never refused for an approved week (050/051), so an admin's week_approved claim is not_refused", async () => {
    const week = await withDb(async (db) => (await db.query<{ w: string }>("select to_char(public.time_week_of(now()) - 7, 'YYYY-MM-DD') as w")).rows[0].w);
    const tue = new Date(Date.parse(`${week}T12:00:00Z`) + 86_400_000).toISOString();
    const st = (await q<{ revision: string }>(A().admin, "select * from public.time_week_status($1::date, $2)", [week, A().admin.id]))[0];
    await q(A().admin, "select public.approve_time_week($1, $2::date, $3, '{\"paid_minutes\": 0}'::jsonb, null)", [A().admin.id, week, st.revision]);
    // The admin's own clock action into their approved week is recorded, not refused ...
    expect(await clock(A().admin, "in", tue, randomUUID())).toMatchObject({ action: "in", replayed: false });
    // ... so a report claiming such an action was refused is not believed.
    expect(await refusal(A().admin, REPORT, args({ key: randomUUID(), kind: "clock", action: "out", at: tue, code: "week_approved" }))).toMatchObject({ code: "22023", hint: "not_refused" });
    expect(await refusal(A().admin, REPORT, args({ key: randomUUID(), kind: "labour", action: "start", at: tue, code: "week_approved" }))).toMatchObject({ hint: "not_refused" });
  });
});

describe("reads and resolving", () => {
  it("admin and office read the company's rows; workshop its own; viewer and the other company nothing; no direct writes", async () => {
    await report(A().office, { key: randomUUID(), kind: "clock", action: "out", at: daysAgo(16), code: "time_too_old" });
    const n = (who: Who) => q<{ n: number; others: number }>(who, "select count(*)::int as n, count(*) filter (where user_id <> auth.uid())::int as others from public.time_sync_rejections").then((r) => r[0]);
    expect(await n(A().admin)).toEqual({ n: 4, others: 4 });
    expect(await n(A().office)).toEqual({ n: 4, others: 3 });
    expect(await n(A().workshop)).toEqual({ n: 3, others: 0 });
    expect(await n(A().viewer)).toEqual({ n: 0, others: 0 });
    expect(await n(B().admin)).toEqual({ n: 0, others: 0 });
    expect(await refusal(A().workshop, "insert into public.time_sync_rejections (organization_id, user_id, client_op_id, op_kind, action, intended_at, code) values ($1, $2, $3, 'clock', 'in', now(), 'time_too_old')", [world.tenants.alpha.id, A().workshop.id, randomUUID()])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "update public.time_sync_rejections set resolved_at = now()")).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "delete from public.time_sync_rejections")).toMatchObject({ code: "42501" });
  });

  it("the office marks one resolved (audited); a second call answers the row; workshop refused; another company's row not found", async () => {
    const [row] = await q<{ id: string }>(A().office, "select id from public.time_sync_rejections where user_id = $1 order by reported_at limit 1", [A().workshop.id]);
    const RESOLVE = "select public.resolve_time_sync_rejection($1, $2) as r";
    expect(await refusal(A().workshop, RESOLVE, [row.id, null])).toMatchObject({ code: "42501", hint: "office_only" });
    expect(await refusal(B().office, RESOLVE, [row.id, null])).toMatchObject({ code: "P0002", hint: "rejection_missing" });
    const done = (await q<{ r: Record<string, unknown> }>(A().office, RESOLVE, [row.id, "Added as a correction"]))[0].r;
    expect(done).toMatchObject({ id: row.id, resolved_by: A().office.id, replayed: false });
    expect(done.resolved_at).toBeTruthy();
    expect((await q<{ r: Record<string, unknown> }>(A().admin, RESOLVE, [row.id, "again"]))[0].r).toMatchObject({ resolved_by: A().office.id, replayed: true });
    const stored = await withDb(async (db) => (await db.query("select resolution_note, resolved_by from public.time_sync_rejections where id = $1", [row.id])).rows[0]);
    expect(stored).toEqual({ resolution_note: "Added as a correction", resolved_by: A().office.id });
    const audit = await withDb(async (db) => (await db.query("select actor_user_id, metadata ->> 'note' as note from security_audit.audit_log where action = 'TIME_SYNC_REJECTION_RESOLVED' and entity_id = $1", [row.id])).rows);
    expect(audit).toEqual([{ actor_user_id: A().office.id, note: "Added as a correction" }]);
  });
});

describe("caps per person (checked before the company lock)", () => {
  /** Rows written straight into the table (replica mode: no triggers) for the person: `n` of them, reported `hoursAgo` ago. */
  const seed = (user: string, n: number, hoursAgo: number, resolved = false) => withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(`insert into public.time_sync_rejections (organization_id, user_id, client_op_id, op_kind, action, intended_at, code, reported_at, resolved_at)
      select $1, $2, gen_random_uuid(), 'clock', 'in', now() - interval '20 days', 'time_too_old', now() - make_interval(hours => $4::int), case when $5::boolean then now() end
      from generate_series(1, $3::int)`, [world.tenants.beta.id, user, n, hoursAgo, resolved]);
    await db.query("commit");
  });
  const fresh = (): Report => ({ key: randomUUID(), kind: "clock", action: "in", at: daysAgo(20), code: "time_too_old" });

  it("50 reported in 24 hours: the next is refused (too_many_rejections); a replay of a reported key is still answered", async () => {
    const who = B().workshop;
    const r = fresh();
    const first = await report(who, r);
    await seed(who.id, 49, 1);
    expect(await refusal(who, REPORT, args(fresh()))).toMatchObject({ code: "54000", hint: "too_many_rejections" });
    expect(await report(who, r)).toMatchObject({ id: first.id, replayed: true });
    // Another person in the same company is not capped by it.
    expect(await report(B().office, fresh())).toMatchObject({ replayed: false });
  });

  it("200 unresolved: the next is refused; resolved ones don't count", async () => {
    const who = B().admin;
    await seed(who.id, 150, 48, true);
    expect(await report(who, fresh())).toMatchObject({ replayed: false });
    await seed(who.id, 199, 48);
    expect(await refusal(who, REPORT, args(fresh()))).toMatchObject({ code: "54000", hint: "too_many_rejections" });
    const open = await withDb(async (db) => (await db.query("select count(*)::int as n from public.time_sync_rejections where user_id = $1 and resolved_at is null", [who.id])).rows[0].n);
    expect(open).toBe(200);
  });
});
