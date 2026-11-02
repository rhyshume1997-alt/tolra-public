/**
 * Migration 142 (working number): timesheet e-mails on chosen days of the week (email_schedules.weekdays, ISO 1 = Monday ... 7 = Sunday).
 *
 *   - The checks: NULL, or distinct values in 1..7 (no 0, no 8, no repeat, no NULL element, one dimension); an enabled timesheet schedule
 *     that is not 'once' has at least one day; off, it may have none; an old enabled 'once' timesheet row needs none. Invoice reminders
 *     are untouched (daily / weekly / once save exactly as before, weekdays NULL).
 *   - Row security unchanged: an admin of the company sets the days; office, workshop and viewer cannot; another company's admin can
 *     neither see nor change them.
 *   - The old rows (inside a rolled-back transaction: 142's rollback, rows written in 108's shape, 142's release again): daily becomes all
 *     seven days, weekly on weekday d becomes {d as ISO} (Sunday 0 becomes 7), once and invoice reminders are left as they were (their
 *     updated_at too); a second run changes nothing. The rollback puts days back as daily (seven) or weekly on the first chosen day.
 *   - The release refuses when 108's row trigger email_schedules_guard is not 108's body (md5 without whitespace).
 *   - Release preflight marker 142: applied with 142; not applied after the rollback, with a check dropped or left NOT VALID, or with the
 *     column of another type (the negative tests). The verify script is all TRUE.
 *
 * Plain SQL with synthetic rows and forged session claims (no Auth API), as the 134 suite does.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const RELEASE = "supabase/release/142_email_schedule_weekdays.release.sql";
const ROLLBACK = "supabase/release/142_email_schedule_weekdays.rollback.sql";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });

const orgs: string[] = [];
async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')",
    [id, `142 ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-142-${label}-${counter}`]);
  orgs.push(id);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(
    `insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
     values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

/** One API request: its own transaction, as role authenticated with the person's claims (as PostgREST runs it). */
async function as<T>(p: Person, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

/** fn inside one transaction that is always rolled back (as postgres, as the SQL editor runs a release). */
async function rolledBack<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}

/** An insert or update as postgres inside a savepoint: "ok", or the name of the check it broke (or the error code). */
async function attempt(db: Client, text: string, params: unknown[] = []): Promise<string> {
  await db.query("savepoint a");
  try {
    await db.query(text, params);
    await db.query("release savepoint a");
    return "ok";
  } catch (error) {
    await db.query("rollback to savepoint a");
    return (error as { constraint?: string; code?: string }).constraint ?? (error as { code?: string }).code ?? "error";
  }
}

const marker142 = async (db: Client) =>
  (await db.query<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).rows.find((r) => r.check.startsWith("marker 142 "))?.value;

const A = { admin: person("a-admin"), office: person("a-office"), workshop: person("a-workshop"), viewer: person("a-viewer") };
const B = { admin: person("b-admin") };
let orgA = "";
let orgB = "";

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    orgA = await makeOrg(db, "alpha");
    orgB = await makeOrg(db, "beta");
    for (const [role, p] of Object.entries(A)) await member(db, orgA, p, role);
    await member(db, orgB, B.admin, "admin");
  });
});

afterAll(async () => {
  const people = [...Object.values(A), ...Object.values(B)].map((p) => p.id);
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query("delete from public.email_schedules where organization_id = any($1)", [orgs]);
    for (const t of ["security_audit.audit_log", "public.organization_members", "public.user_profiles"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
    await db.query("delete from auth.users where id = any($1)", [people]);
  });
});

describe("142: the weekdays checks", () => {
  it("the column is SMALLINT[], nullable, no default; NULL for every invoice reminder", async () => {
    await withDb(async (db) => {
      expect((await db.query("select udt_name, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'email_schedules' and column_name = 'weekdays'")).rows)
        .toEqual([{ udt_name: "_int2", is_nullable: "YES", column_default: null }]);
      expect((await db.query("select 1 from public.email_schedules where kind = 'invoice_reminder' and weekdays is not null")).rows).toHaveLength(0);
    });
  });

  it.each([
    ["{5}", true, "ok"], ["{1,3,5}", true, "ok"], ["{1,2,3,4,5,6,7}", true, "ok"], ["{7}", true, "ok"], ["{5,1,3}", true, "ok"],
    ["{}", false, "ok"], [null, false, "ok"],
    ["{}", true, "email_schedules_timesheet_days"], [null, true, "email_schedules_timesheet_days"],
    ["{0}", true, "email_schedules_weekdays_valid"], ["{8}", true, "email_schedules_weekdays_valid"], ["{1,1}", true, "email_schedules_weekdays_valid"],
    ["{1,3,1}", false, "email_schedules_weekdays_valid"], ["{1,NULL}", true, "email_schedules_weekdays_valid"], ["{-1}", false, "email_schedules_weekdays_valid"],
    ["{{1,2},{3,4}}", true, "email_schedules_weekdays_valid"], ["{1,2,3,4,5,6,7,1}", true, "email_schedules_weekdays_valid"],
  ] as Array<[string | null, boolean, string]>)("a timesheet with weekdays %s, enabled %s: %s", async (days, enabled, expected) => {
    await rolledBack(async (db) => {
      expect(await attempt(db, "insert into public.email_schedules (organization_id, kind, enabled, frequency, weekdays) values ($1, 'timesheet', $2, 'daily', $3::smallint[])", [orgA, enabled, days])).toBe(expected);
    });
  });

  it("an old enabled 'once' timesheet row needs no days; invoice reminders save daily / weekly / once exactly as before", async () => {
    await rolledBack(async (db) => {
      expect(await attempt(db, "insert into public.email_schedules (organization_id, kind, enabled, frequency, run_at) values ($1, 'timesheet', true, 'once', now() + interval '1 day')", [orgA])).toBe("ok");
      expect(await attempt(db, "insert into public.email_schedules (organization_id, kind, enabled, frequency, weekday) values ($1, 'invoice_reminder', true, 'weekly', 3)", [orgB])).toBe("ok");
      expect(await attempt(db, "update public.email_schedules set frequency = 'daily', weekday = null where organization_id = $1 and kind = 'invoice_reminder'", [orgB])).toBe("ok");
      expect(await attempt(db, "update public.email_schedules set frequency = 'once', run_at = now() + interval '2 days' where organization_id = $1 and kind = 'invoice_reminder'", [orgB])).toBe("ok");
      // 108's own checks still hold: a weekly row needs its weekday.
      expect(await attempt(db, "update public.email_schedules set frequency = 'weekly', weekday = null where organization_id = $1 and kind = 'invoice_reminder'", [orgB])).toBe("email_schedules_weekly_has_weekday");
    });
  });
});

describe("142: row security unchanged (the company reads, only an admin writes)", () => {
  it("an admin sets Mon + Wed + Fri; office, workshop and viewer cannot change them; another company's admin can neither see nor change them", async () => {
    await as(A.admin, (db) => db.query("insert into public.email_schedules (organization_id, kind, enabled, frequency, weekdays, time_of_day) values ($1, 'timesheet', true, 'daily', '{1,3,5}', '16:30')", [orgA]));
    const days = async () => (await withDb((db) => db.query<{ weekdays: number[] }>("select weekdays from public.email_schedules where organization_id = $1 and kind = 'timesheet'", [orgA]))).rows[0]?.weekdays;
    expect(await days()).toEqual([1, 3, 5]);

    for (const p of [A.office, A.workshop, A.viewer]) {
      // They can read their company's schedule (108's member select) ...
      expect((await as(p, (db) => db.query("select weekdays from public.email_schedules where organization_id = $1 and kind = 'timesheet'", [orgA]))).rows).toEqual([{ weekdays: [1, 3, 5] }]);
      // ... but an update changes nothing (the admin-only policy hides the row from UPDATE).
      expect((await as(p, (db) => db.query("update public.email_schedules set weekdays = '{2}' where organization_id = $1 and kind = 'timesheet'", [orgA]))).rowCount).toBe(0);
    }
    expect(await days()).toEqual([1, 3, 5]);

    expect((await as(B.admin, (db) => db.query("select id from public.email_schedules where organization_id = $1", [orgA]))).rows).toEqual([]);
    expect((await as(B.admin, (db) => db.query("update public.email_schedules set weekdays = '{2}' where organization_id = $1", [orgA]))).rowCount).toBe(0);
    await expect(as(B.admin, (db) => db.query("insert into public.email_schedules (organization_id, kind, enabled, frequency, weekdays) values ($1, 'invoice_reminder', false, 'daily', null)", [orgA])))
      .rejects.toMatchObject({ code: "42501" });
    expect(await days()).toEqual([1, 3, 5]);

    // The admin changes them (and the checks apply to the admin too).
    await as(A.admin, (db) => db.query("update public.email_schedules set weekdays = '{1,2,3,4,5,6,7}' where organization_id = $1 and kind = 'timesheet'", [orgA]));
    expect(await days()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await expect(as(A.admin, (db) => db.query("update public.email_schedules set weekdays = '{}' where organization_id = $1 and kind = 'timesheet'", [orgA])))
      .rejects.toMatchObject({ code: "23514", constraint: "email_schedules_timesheet_days" });
  });
});

describe("142: the old rows, the guard, the rollback", () => {
  type Row = { org: string; kind: string; enabled: boolean; frequency: string; weekday: number | null; weekdays: number[] | null; moved: boolean };
  /** 108-shaped rows (rollback first, so there is no weekdays column), written with an old updated_at that the release then moves only where it changes a row. */
  async function oldRows(db: Client) {
    await db.query(unwrapped(read(ROLLBACK)));
    const o = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of o.entries()) await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `142 old ${i}`, `${SYNTHETIC_SLUG_PREFIX}${run}-142-old-${i}`]);
    await db.query("alter table public.email_schedules disable trigger email_schedules_guard");
    await db.query(`insert into public.email_schedules (organization_id, kind, enabled, frequency, weekday, run_at, updated_at) values
      ($1, 'timesheet', true, 'daily', null, null, '2026-01-01'), ($2, 'timesheet', true, 'weekly', 0, null, '2026-01-01'),
      ($3, 'timesheet', false, 'weekly', 5, null, '2026-01-01'), ($4, 'timesheet', true, 'once', null, '2026-12-01T09:00Z', '2026-01-01'),
      ($5, 'invoice_reminder', true, 'weekly', 3, null, '2026-01-01'), ($1, 'invoice_reminder', true, 'daily', null, null, '2026-01-01')`, o);
    await db.query("alter table public.email_schedules enable trigger email_schedules_guard");
    return o;
  }
  const rows = async (db: Client, o: string[]) => (await db.query<Row>(
    `select array_position($1::uuid[], organization_id) as org, kind, enabled, frequency, weekday, weekdays, updated_at > '2026-06-01' as moved
     from public.email_schedules where organization_id = any($1) order by 1, 2`, [o])).rows;

  it("daily becomes all seven days, weekly on d becomes {d} (Sunday 7), once and invoice reminders stay as they were; a second run changes nothing", async () => {
    await rolledBack(async (db) => {
      const o = await oldRows(db);
      expect(await marker142(db)).toBe("not applied");
      await db.query(unwrapped(read(RELEASE)));
      const after = await rows(db, o);
      expect(after).toEqual([
        { org: 1, kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, weekdays: null, moved: false },
        { org: 1, kind: "timesheet", enabled: true, frequency: "daily", weekday: null, weekdays: [1, 2, 3, 4, 5, 6, 7], moved: true },
        { org: 2, kind: "timesheet", enabled: true, frequency: "daily", weekday: null, weekdays: [7], moved: true },
        { org: 3, kind: "timesheet", enabled: false, frequency: "daily", weekday: null, weekdays: [5], moved: true },
        { org: 4, kind: "timesheet", enabled: true, frequency: "once", weekday: null, weekdays: null, moved: false },
        { org: 5, kind: "invoice_reminder", enabled: true, frequency: "weekly", weekday: 3, weekdays: null, moved: false },
      ]);
      expect(await marker142(db)).toBe("applied");
      const stamp = async () => (await db.query("select organization_id, kind, updated_at from public.email_schedules where organization_id = any($1) order by 1, 2", [o])).rows;
      const before = await stamp();
      await db.query(unwrapped(read(RELEASE)));
      expect(await rows(db, o)).toEqual(after);
      expect(await stamp()).toEqual(before);
    });
  });

  it("the rollback: seven days back to daily, one to six days back to weekly on the first chosen day; once and reminders untouched", async () => {
    await rolledBack(async (db) => {
      const o = await oldRows(db);
      await db.query(unwrapped(read(RELEASE)));
      await db.query("update public.email_schedules set weekdays = '{5,3}' where organization_id = $1 and kind = 'timesheet'", [o[2]]);
      await db.query(unwrapped(read(ROLLBACK)));
      const back = (await db.query<{ org: number; kind: string; frequency: string; weekday: number | null }>(
        "select array_position($1::uuid[], organization_id) as org, kind, frequency, weekday from public.email_schedules where organization_id = any($1) order by 1, 2", [o])).rows;
      expect(back).toEqual([
        { org: 1, kind: "invoice_reminder", frequency: "daily", weekday: null }, { org: 1, kind: "timesheet", frequency: "daily", weekday: null },
        { org: 2, kind: "timesheet", frequency: "weekly", weekday: 0 }, { org: 3, kind: "timesheet", frequency: "weekly", weekday: 3 },
        { org: 4, kind: "timesheet", frequency: "once", weekday: null }, { org: 5, kind: "invoice_reminder", frequency: "weekly", weekday: 3 },
      ]);
      expect((await db.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'email_schedules' and column_name = 'weekdays'")).rows).toHaveLength(0);
      // A second rollback is a no-op.
      await db.query(unwrapped(read(ROLLBACK)));
    });
  });

  it("the release refuses when email_schedules_guard is not 108's body", async () => {
    await rolledBack(async (db) => {
      await db.query(`do $d$ begin execute regexp_replace(pg_get_functiondef('public.email_schedules_guard()'::regprocedure), E'\\nBEGIN\\n', E'\\nBEGIN\\n  -- an unknown version\\n'); end $d$`);
      await expect(db.query(unwrapped(read(RELEASE)))).rejects.toThrow(/142: public.email_schedules_guard is not 108's/);
    });
  });
});

describe("142 and the release preflight: marker 142 and the verify script", () => {
  it("applied with 142; the verify script is all TRUE", async () => {
    await withDb(async (db) => {
      expect(await marker142(db)).toBe("applied");
      const verify = (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/email_schedule_weekdays_142.sql"))).rows;
      expect(verify).toHaveLength(7);
      expect(verify.filter((r) => !r.ok)).toEqual([]);
    });
  });

  it.each([
    ["a check dropped", "alter table public.email_schedules drop constraint email_schedules_timesheet_days"],
    ["the other check dropped", "alter table public.email_schedules drop constraint email_schedules_weekdays_valid"],
    ["a check left NOT VALID", "alter table public.email_schedules drop constraint email_schedules_timesheet_days; alter table public.email_schedules add constraint email_schedules_timesheet_days check (true) not valid"],
    ["the column of another type", "alter table public.email_schedules drop constraint email_schedules_weekdays_valid; alter table public.email_schedules alter column weekdays type integer[]; alter table public.email_schedules add constraint email_schedules_weekdays_valid check (true)"],
    ["142 rolled back", unwrapped(read(ROLLBACK))],
  ])("not applied with %s", async (_name, change) => {
    await rolledBack(async (db) => {
      await db.query(change);
      expect(await marker142(db)).toBe("not applied");
    });
  });
});
