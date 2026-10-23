/**
 * Attendance (migration 050): clock in and out, breaks, corrections and the company's time settings.
 *
 *   * a clock action is stored once per key: the same key again (a lost answer, the outbox retrying, a second tab) returns the first
 *     answer and records nothing new; the key reused for another action is refused (client_op_reused);
 *   * two devices, reversed order: the clock-out that arrives first is stored as sent, the clock-in that arrives later is stored as
 *     sent; nothing is guessed or overwritten (the app pairs them by time, tests/unit/time-sheet.test.ts);
 *   * two connections sending the same key at once: one row;
 *   * device times: a future time is clamped to now (the device time kept), a time older than 14 days is refused;
 *   * corrections keep the original: a new row naming the row it replaces or voids, with a reason; one replacement per row; the person
 *     may correct their own, someone else's needs an admin; audited ATTENDANCE_CORRECTED;
 *   * rows are never changed or removed (also not by the database owner);
 *   * read: own rows for workshop, the company's for admin and office, nothing for viewer, nothing across companies; no direct writes;
 *   * settings: admin only, defaults when no row, approver roles always include admin; bank holidays readable.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { clock, hoursAgo, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

const rowsFor = (user: string) => withDb(async (db) => (await db.query("select * from public.attendance_events where user_id = $1 order by received_at", [user])).rows);

describe("clock actions", () => {
  it("stores one row per key; a replay answers the first result; a reused key is refused", async () => {
    const key = randomUUID();
    const at = hoursAgo(3);
    const first = await clock(A().workshop, "in", at, key, "Workshop tablet 1");
    expect(first).toMatchObject({ action: "in", user_id: A().workshop.id, replayed: false, time_adjusted: false, source: "clock" });
    expect(new Date(first.at as string).toISOString()).toBe(at);
    const again = await clock(A().workshop, "in", hoursAgo(1), key);
    expect(again).toEqual({ ...first, replayed: true });
    expect((await rowsFor(A().workshop.id)).length).toBe(1);
    expect(await refusal(A().workshop, "select public.record_attendance_event($1, 'out', null)", [key])).toMatchObject({ code: "22023", hint: "client_op_reused" });
    // Another person sending the same key (same company) is refused too, never answered with someone else's record.
    expect(await refusal(A().office, "select public.record_attendance_event($1, 'in', null)", [key])).toMatchObject({ hint: "client_op_reused" });
    expect(await refusal(A().workshop, "select public.record_attendance_event(null, 'in', null)")).toMatchObject({ hint: "client_op_missing" });
    expect(await refusal(A().workshop, "select public.record_attendance_event($1, 'lunch', null)", [randomUUID()])).toMatchObject({ hint: "bad_action" });
  });

  it("two devices, reversed order: the clock-out arriving first and the clock-in arriving later are both stored as sent", async () => {
    const who = A().office;
    const inAt = hoursAgo(9);
    const outAt = hoursAgo(1);
    const out = await clock(who, "out", outAt, randomUUID(), "Phone");
    const inn = await clock(who, "in", inAt, randomUUID(), "Tablet");
    const rows = await rowsFor(who.id);
    expect(rows.map((r) => [r.action, new Date(r.at).toISOString(), r.device_label])).toEqual([["out", outAt, "Phone"], ["in", inAt, "Tablet"]]);
    expect(new Date(out.received_at as string).getTime()).toBeLessThan(new Date(inn.received_at as string).getTime());
  });

  it("the same key from two connections at once makes one row and the same answer", async () => {
    const key = randomUUID();
    const at = hoursAgo(2);
    const [a, b] = await Promise.all([clock(A().admin, "break_start", at, key), clock(A().admin, "break_start", at, key)]);
    expect(withoutReplay(a)).toEqual(withoutReplay(b));
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await rowsFor(A().admin.id)).filter((r) => r.client_op_id === key).length).toBe(1);
  });

  it("device times: future clamped to now (device time kept), older than 14 days refused", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const r = await clock(A().workshop, "break_start", future);
    expect(r.time_adjusted).toBe(true);
    expect(new Date(r.device_at as string).toISOString()).toBe(future);
    expect(Math.abs(new Date(r.at as string).getTime() - Date.now())).toBeLessThan(60_000);
    expect(await refusal(A().workshop, "select public.record_attendance_event($1, 'in', $2)", [randomUUID(), hoursAgo(15 * 24)])).toMatchObject({ code: "22023", hint: "time_too_old" });
  });

  it("viewer, anon and a person with no company are refused", async () => {
    expect(await refusal(A().viewer, "select public.record_attendance_event($1, 'in', null)", [randomUUID()])).toMatchObject({ code: "42501", hint: "not_allowed" });
    expect(await refusal({ id: randomUUID() }, "select public.record_attendance_event($1, 'in', null)", [randomUUID()])).toMatchObject({ code: "42501" });
    const anon = await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role anon");
      try { await db.query("select public.record_attendance_event($1, 'in', null)", [randomUUID()]); return null; } catch (e) { return (e as { code: string }).code; } finally { await db.query("rollback"); }
    });
    expect(anon).toBe("42501");
  });
});

describe("corrections", () => {
  const correct = (who: { id: string }, user: string | null, supersedes: string | null, action: string, at: string | null, reason: string | null, key = randomUUID()) =>
    q<{ r: Record<string, unknown> }>(who, "select public.correct_attendance_event($1, $2, $3, $4, $5, $6) as r", [key, user, supersedes, action, at, reason]).then((rows) => rows[0].r);

  it("the person adds a missing clock-out to their own record, with a reason; replay answers the first", async () => {
    const key = randomUUID();
    const at = hoursAgo(20);
    const r = await correct(A().workshop, null, null, "out", at, "Forgot to clock out", key);
    expect(r).toMatchObject({ action: "out", source: "correction", user_id: A().workshop.id, supersedes: null, replayed: false });
    expect(await correct(A().workshop, null, null, "out", at, "Forgot to clock out", key)).toMatchObject({ event_id: r.event_id, replayed: true });
    expect(await refusal(A().workshop, "select public.correct_attendance_event($1, null, null, 'out', $2, 'x')", [randomUUID(), at])).toMatchObject({ hint: "reason_required" });
    expect(await refusal(A().workshop, "select public.correct_attendance_event($1, null, null, 'out', $2, 'Typo time')", [randomUUID(), new Date(Date.now() + 86_400_000).toISOString()])).toMatchObject({ hint: "bad_time" });
  });

  it("someone else's record needs an admin; the admin replaces and voids, the originals stay; one replacement per row", async () => {
    const original = await clock(A().workshop, "in", hoursAgo(30));
    expect(await refusal(A().office, "select public.correct_attendance_event($1, $2, $3, 'in', $4, 'Wrong time')", [randomUUID(), A().workshop.id, original.event_id, hoursAgo(29)])).toMatchObject({ code: "42501", hint: "admin_only" });
    const fixed = await correct(A().admin, A().workshop.id, original.event_id as string, "in", hoursAgo(29), "Clocked in late on the tablet");
    expect(fixed).toMatchObject({ supersedes: original.event_id, source: "correction", user_id: A().workshop.id });
    expect(await refusal(A().admin, "select public.correct_attendance_event($1, $2, $3, 'in', $4, 'Again')", [randomUUID(), A().workshop.id, original.event_id, hoursAgo(28)])).toMatchObject({ hint: "already_corrected" });
    const voided = await correct(A().admin, A().workshop.id, fixed.event_id as string, "void", null, "Not at work that day");
    expect(voided).toMatchObject({ action: "void", supersedes: fixed.event_id });
    const rows = await rowsFor(A().workshop.id);
    expect(rows.find((r) => r.id === original.event_id)).toMatchObject({ action: "in", source: "clock" });
    const audit = await withDb(async (db) => (await db.query("select action, actor_user_id, metadata from security_audit.audit_log where entity_table = 'attendance_events' and entity_id = $1 and action = 'ATTENDANCE_CORRECTED'", [fixed.event_id])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: A().admin.id, metadata: { reason: "Clocked in late on the tablet", replaced_action: "in" } });
    expect(await refusal(A().admin, "select public.correct_attendance_event($1, $2, null, 'void', null, 'Nothing named')", [randomUUID(), A().workshop.id])).toMatchObject({ hint: "bad_action" });
  });

  it("another company's person or record is out of reach", async () => {
    const theirs = await clock(B().workshop, "in", hoursAgo(5));
    expect(await refusal(A().admin, "select public.correct_attendance_event($1, $2, null, 'out', $3, 'Cross company')", [randomUUID(), B().workshop.id, hoursAgo(4)])).toMatchObject({ code: "P0002", hint: "not_member" });
    expect(await refusal(A().admin, "select public.correct_attendance_event($1, $2, $3, 'void', null, 'Cross company')", [randomUUID(), A().workshop.id, theirs.event_id])).toMatchObject({ code: "P0002", hint: "event_missing" });
    expect(await refusal(A().workshop, "select public.correct_attendance_event($1, null, $2, 'void', null, 'Cross company')", [randomUUID(), theirs.event_id])).toMatchObject({ code: "P0002" });
  });
});

describe("the table", () => {
  it("rows are never changed or removed, also not by the owner", async () => {
    const r = await clock(A().office, "break_end", hoursAgo(1));
    for (const sql of ["update public.attendance_events set at = now() where id = $1", "delete from public.attendance_events where id = $1"]) {
      const err = await withDb(async (db) => { try { await db.query(sql, [r.event_id]); return null; } catch (e) { return (e as { hint?: string }).hint; } });
      expect(err).toBe("attendance_immutable");
    }
  });

  it("read: own rows for workshop, the company's for admin and office, none for viewer or the other company; no direct writes", async () => {
    const mine = await q<{ user_id: string }>(A().workshop, "select distinct user_id from public.attendance_events");
    expect(mine.map((r) => r.user_id)).toEqual([A().workshop.id]);
    for (const who of [A().admin, A().office]) {
      const all = await q<{ organization_id: string; user_id: string }>(who, "select organization_id, user_id from public.attendance_events");
      expect(new Set(all.map((r) => r.organization_id))).toEqual(new Set([world.tenants.alpha.id]));
      expect(new Set(all.map((r) => r.user_id)).size).toBeGreaterThan(1);
    }
    expect(await q(A().viewer, "select 1 from public.attendance_events")).toEqual([]);
    expect(await q(B().admin, "select 1 from public.attendance_events where organization_id = $1", [world.tenants.alpha.id])).toEqual([]);
    expect(await refusal(A().admin, "insert into public.attendance_events (organization_id, user_id, client_op_id, action, at, source) values ($1, $2, gen_random_uuid(), 'in', now(), 'clock')", [world.tenants.alpha.id, A().admin.id])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "update public.attendance_events set at = now()")).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "delete from public.attendance_events")).toMatchObject({ code: "42501" });
  });
});

describe("settings", () => {
  it("admin saves; office and workshop can't; everyone but viewer reads them; approver roles always include admin", async () => {
    expect(await q(A().workshop, "select * from public.time_settings")).toEqual([]);
    const saved = await q<{ s: Record<string, unknown> }>(A().admin, "select to_jsonb(public.save_time_settings($1::jsonb)) as s", [JSON.stringify({ sunday_overtime: false, approver_roles: ["office", "admin"] })]);
    expect(saved[0].s).toMatchObject({ breaks_paid: false, lunch_minutes: 30, break_minutes: 15, daily_overtime_hours: 8, saturday_overtime: true, sunday_overtime: false, overtime_multiplier: 1.5, approver_roles: ["admin", "office"] });
    expect(await refusal(A().office, "select public.save_time_settings('{}'::jsonb)")).toMatchObject({ code: "42501", hint: "admin_only" });
    expect(await refusal(A().admin, "select public.save_time_settings($1::jsonb)", [JSON.stringify({ approver_roles: ["office"] })])).toMatchObject({ code: "23514" });
    expect(await refusal(A().admin, "select public.save_time_settings($1::jsonb)", [JSON.stringify({ daily_overtime_hours: 30 })])).toMatchObject({ code: "23514" });
    for (const who of [A().office, A().workshop]) expect((await q(who, "select sunday_overtime from public.time_settings"))).toEqual([{ sunday_overtime: false }]);
    expect(await q(A().viewer, "select 1 from public.time_settings")).toEqual([]);
    expect(await q(B().admin, "select 1 from public.time_settings")).toEqual([]);
    expect(await refusal(A().admin, "update public.time_settings set breaks_paid = true")).toMatchObject({ code: "42501" });
  });

  it("bank holidays are readable and include 25 Dec 2026 and its Boxing Day substitute", async () => {
    const rows = await q<{ day: string }>(A().workshop, "select to_char(day, 'YYYY-MM-DD') as day from public.bank_holidays where region = 'england-and-wales' and day between '2026-12-01' and '2026-12-31' order by day");
    expect(rows.map((r) => r.day)).toEqual(["2026-12-25", "2026-12-28"]);
  });
});

function withoutReplay(r: Record<string, unknown>) {
  const copy = { ...r };
  delete copy.replayed;
  return copy;
}

