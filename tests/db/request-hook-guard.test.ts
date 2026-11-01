/**
 * Migration 017 never replaces someone else's PostgREST request hook (release validation): with a different
 * pgrst.db_pre_request configured for the authenticator role or database-wide, 017 stops with the existing value and
 * changes nothing; with its own hook already set it re-runs cleanly. Each case runs inside a rolled-back transaction.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

/** The booking day-plan migration's number, taken from its file name (numbers are given at merge time, so nothing here pins it). */
const DAY_PLAN_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_booking_day_plan.sql"))!.slice(0, 3);
// Also found by name: the file keeps its number while earlier-numbered migrations (photos, sign-off) land before it.
const INTERNAL_JOBS_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_internal_jobs_and_machines.sql"))!.slice(0, 3);
const SO_MACHINES_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_sales_order_machines.sql"))!.slice(0, 3);
const MACHINE_RUNS_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_machine_runs.sql"))!.slice(0, 3);
const JOB_SIGNOFF_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_job_signoff.sql"))!.slice(0, 3);
const BENCH_PAUSE_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_bench_pause.sql"))!.slice(0, 3);
const PAUSED_ACK_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_paused_machine_ack.sql"))!.slice(0, 3);
const QUOTE_TO_JOB_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_quote_to_job.sql"))!.slice(0, 3);
const AUTO_INVOICE_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_delivery_note_auto_invoice.sql"))!.slice(0, 3);
const AUTO_BOOK_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_auto_book_next_free.sql"))!.slice(0, 3);
const QUOTE_VERSIONS_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_quote_versions.sql"))!.slice(0, 3);
const DATE_FORMAT_MIGRATION = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => f.endsWith("_user_date_format.sql"))!.slice(0, 3);

const sql017 = readFileSync(path.resolve(__dirname, "../../supabase/migrations/017_session_and_deferred_link_checks.sql"), "utf8");
const hooks = (db: import("pg").Client) => db.query<{ cfg: string }>(
  "select cfg from pg_db_role_setting s, unnest(s.setconfig) cfg where (s.setrole = 0 or s.setrole = 'authenticator'::regrole) and cfg like 'pgrst.db_pre_request=%' order by 1").then((r) => r.rows.map((x) => x.cfg));

beforeAll(async () => {
  await verifyBackendIdentity();
});

async function inRolledBackTransaction(setup: string) {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query(setup);
      return await db.query(sql017).then(() => "applied", (err: { code?: string; message?: string }) => `${err.code}: ${err.message}`);
    } finally {
      await db.query("rollback");
    }
  });
}

describe("017 and an existing request hook", () => {
  it("its own hook already set: re-runs cleanly", async () => {
    expect(await inRolledBackTransaction("select 1")).toBe("applied");
  });

  it("a different hook on the authenticator role: stops, names it, changes nothing", async () => {
    const result = await inRolledBackTransaction("alter role authenticator set pgrst.db_pre_request = 'public.other_team_check'");
    expect(result).toMatch(/^55000: An existing PostgREST request hook is configured \(public\.other_team_check\)/);
  });

  it("a different hook set for the authenticator role in this database only: stops too", async () => {
    // (Database-wide settings are read by the same guard; the postgres role isn't allowed to create one to test with.)
    const result = await inRolledBackTransaction("alter role authenticator in database postgres set pgrst.db_pre_request = 'public.db_scoped_check'");
    expect(result).toMatch(/^55000: .*public\.db_scoped_check/);
  });

  it("afterwards the configured hook is still only 017's", async () => {
    expect(await withDb(hooks)).toEqual(["pgrst.db_pre_request=public.check_request_session"]);
  });
});

describe("release preflight (supabase/verify/release_preflight.sql)", () => {
  it("runs in a READ ONLY transaction and reports this database correctly", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/release_preflight.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin read only");
      try {
        return (await db.query<{ check: string; value: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    const get = (name: string) => rows.find((r) => r.check === name)?.value;
    expect(get("017 needs: may change authenticator settings")).toBe("true");
    expect(get("017 needs: may read auth.sessions")).toBe("true");
    expect(get("036 needs: may reference auth.sessions")).toBe("true");
    expect(get("040 needs: may read storage.objects past its row rules (finalise_job_photo checks the stored object)")).toBe("true");
    expect(get("existing PostgREST request hooks")).toBe("role authenticator: public.check_request_session");
    // One marker per migration from 013 to the newest file, in order, each exactly once, all applied. A migration
    // without a marker, a duplicate, or a marker that doesn't detect its migration fails here.
    const markers = rows.filter((r) => r.check.startsWith("marker "));
    const numbers = markers.map((r) => r.check.slice("marker ".length, "marker ".length + 3));
    const files = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f >= "013").sort();
    const expected = files.map((f) => f.slice(0, 3));
    // Found by name, not as the newest file: 042 (internal jobs, numbered ahead at merge time) sits after it.
    expect(files.some((f) => /^\d{3}_job_photos\.sql$/.test(f))).toBe(true);
    expect(expected).toContain(DAY_PLAN_MIGRATION);
    expect(expected).toContain("039");
    expect(expected).toContain(INTERNAL_JOBS_MIGRATION);
    expect(expected).toContain(SO_MACHINES_MIGRATION);
    expect(expected).toContain(MACHINE_RUNS_MIGRATION);
    expect(expected).toContain(JOB_SIGNOFF_MIGRATION);
    expect(expected).toContain(BENCH_PAUSE_MIGRATION);
    expect(expected).toContain(PAUSED_ACK_MIGRATION);
    expect(expected).toContain(QUOTE_TO_JOB_MIGRATION);
    expect(numbers).toEqual(expected);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(markers.map((r) => r.value)).toEqual(expected.map(() => "applied"));
  });

  it("a migration whose objects are missing shows as not applied (rolled back afterwards)", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/release_preflight.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("drop function public.set_archive_state(text, uuid, text)");
        await db.query("alter table public.jobs drop column inspected_by, drop column inspected_at");
        await db.query("drop function public.org_vat_registered(uuid)");
        await db.query("drop function public.record_inbound_email(text, text, text, text, text, timestamptz, text, text)");
        await db.query("drop function public.record_invoice_payment(uuid, numeric, date, text, text, uuid)");
        await db.query("drop function public.resolve_job_email(uuid, text)");
        await db.query("create or replace function public.audit_event_allowed(p_action text, p_table text) returns boolean language sql as $$ select false $$");
        await db.query("drop function public.company_people()");
        await db.query("drop function public.platform_enter_organization(uuid, text, numeric)");
        await db.query("drop function public.open_replacement_rework(uuid, text)");
        await db.query("alter table public.machine_bookings drop column day_plan");
        await db.query("drop function public.platform_create_organization(text, text, text)");
        await db.query("drop function public.finalise_job_photo(uuid)");
        await db.query("drop function public.create_job(text, text, boolean, uuid, date, jsonb, boolean, jsonb, text)");
        await db.query("drop function public.set_job_machines(uuid, jsonb, boolean, jsonb, text)");
        // 049 replaced the 6-argument form: one signature, with the acknowledgements and the explicit bench flag.
        await db.query("drop function public.start_machine_run(uuid, uuid[], uuid, timestamptz, boolean, text, jsonb, boolean)");
        await db.query("drop function public.sign_off_job(uuid, integer, text, text, text, date, text, text, text, uuid)");
        await db.query("drop function public.bench_runs_state()");
        await db.query("drop function public.acknowledge_paused_machine(uuid, uuid, uuid, uuid)");
        await db.query("drop function public.accept_quote(uuid, text, date, uuid[])");
        await db.query("drop function public.revise_quote(uuid)");
        await db.query("drop function public.uninvoiced_delivery_notes()");
        await db.query("drop function public.machine_next_free_start(uuid, uuid, numeric, timestamptz, timestamptz)");
        await db.query("drop function public.replace_draft_invoice(uuid, timestamptz, jsonb, jsonb)");
        await db.query("drop function public.void_invoice(uuid, text)");
        await db.query("drop table public.user_preferences");
        return (await db.query<{ check: string; value: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    const value = (n: string) => rows.find((r) => r.check.startsWith(`marker ${n}`))?.value;
    const photos = readdirSync(path.resolve(__dirname, "../../supabase/migrations")).find((f) => /^\d{3}_job_photos\.sql$/.test(f))!.slice(0, 3);
    expect(value(photos)).toBe("not applied");
    expect(value(SO_MACHINES_MIGRATION)).toBe("not applied");
    expect(value(MACHINE_RUNS_MIGRATION)).toBe("not applied");
    expect(value("028")).toBe("not applied");
    expect(value("029")).toBe("not applied");
    expect(value("030")).toBe("not applied");
    expect(value("031")).toBe("not applied");
    expect(value("032")).toBe("not applied");
    expect(value("033")).toBe("not applied");
    expect(value("034")).toBe("not applied");
    expect(value("035")).toBe("not applied");
    expect(value("036")).toBe("not applied");
    expect(value("037")).toBe("not applied");
    expect(value(DAY_PLAN_MIGRATION)).toBe("not applied");
    expect(value("039")).toBe("not applied");
    expect(value(INTERNAL_JOBS_MIGRATION)).toBe("not applied");
    expect(value(JOB_SIGNOFF_MIGRATION)).toBe("not applied");
    expect(value(BENCH_PAUSE_MIGRATION)).toBe("not applied");
    expect(value(PAUSED_ACK_MIGRATION)).toBe("not applied");
    expect(value(QUOTE_TO_JOB_MIGRATION)).toBe("not applied");
    expect(value(AUTO_INVOICE_MIGRATION)).toBe("not applied");
    expect(value("067")).toBe("not applied");
    expect(value("073")).toBe("not applied");
    expect(value(AUTO_BOOK_MIGRATION)).toBe("not applied");
    expect(value(QUOTE_VERSIONS_MIGRATION)).toBe("not applied");
    expect(value(DATE_FORMAT_MIGRATION)).toBe("not applied");
    expect(value("027")).toBe("applied");
    // And nothing changed: all are back.
    const back = await withDb(async (db) => (await db.query("select to_regprocedure('public.set_archive_state(text, uuid, text)') is not null as fn, to_regprocedure('public.org_vat_registered(uuid)') is not null as vat_fn, to_regprocedure('public.record_inbound_email(text, text, text, text, text, timestamptz, text, text)') is not null as inbound_fn, to_regprocedure('public.record_invoice_payment(uuid, numeric, date, text, text, uuid)') is not null as payment_fn, to_regprocedure('public.resolve_job_email(uuid, text)') is not null as job_email_fn, exists (select 1 from information_schema.columns where table_name = 'jobs' and column_name = 'inspected_at') as col")).rows[0]);
    expect(back).toEqual({ fn: true, vat_fn: true, inbound_fn: true, payment_fn: true, job_email_fn: true, col: true });
  });
});
