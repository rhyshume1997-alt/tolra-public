/**
 * Upgrade rehearsal (audit B10: SEC13, A1). Starts from a LOCAL database built only up to REHEARSAL_BASE (the
 * migration a production project is at before this release) and holding data written by the old code, then applies
 * every later migration the way the run sheet says (SQL editor = the postgres role, one transaction per file),
 * applies them all a second time, and proves the result is the same database as a fresh build: identical catalogue,
 * no permissive policies, clean verify scripts, and the existing data still readable and protected.
 * Data is loaded through the legacy importer, as on production. Run with scripts/upgrade-rehearsal.sh (it rebuilds the database before and after). Never against a hosted project.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { releaseSql } from "../../scripts/release-sql.mjs";
import { pendingRunView, runViewLabel } from "@/lib/job-actions";
import { isServerTooOld } from "@/lib/machine-runs";
import { enqueue, pendingEntries, replayOutbox, type OutboxOp, type ReplayOutcome, type RunPauseOp, type RunStartOp } from "@/lib/offline/outbox";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { executeRunPauseOp, executeRunStartOp, runStartArgs } from "@/lib/offline/sync";

import { INJECT_SQLSTATE, injectCandidates, injectPoint, probeMessage, probeSql } from "./inject-point";
import { isolatedBackend } from "../support/isolation";
import { buildLegacyExport } from "../support/legacy-export";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const BASE = process.env.REHEARSAL_BASE ?? "";
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f.split("_")[0] > BASE).sort();
// Production's 031/032 functions were pasted into the SQL editor and stored with CRLF line endings. 033 injects the second-step check into
// them, and 034 (and any later file) is applied after that. So the conversion to CRLF runs between 032 and 033, never later.
const BEFORE_033 = later.filter((f) => f.split("_")[0] < "033");
const F033 = later.find((f) => f.startsWith("033_"));
const F034 = later.find((f) => f.startsWith("034_"));
// Everything after 033 and 034 (035 and later files, if the branch has them); applied in order after the two checked steps.
const AFTER_034 = later.filter((f) => f.split("_")[0] > "034");
const CRLF_FUNCTIONS = ["record_invoice_payment(uuid,numeric,date,text,text,uuid)", "reverse_invoice_payment(uuid,text)", "confirm_invoice_payments(uuid,text)", "reserve_mail_send(text,text,text[],text,text,uuid)", "complete_mail_send(uuid,text)", "resolve_mail_send(uuid,text)", "save_mail_poll_state(text,timestamptz)", "record_inbound_email(text,text,text,text,text,timestamptz,text,text)"];
const VERIFY = ["cross_org_links", "duplicate_conversions", "document_totals", "unmarked_bans"];
const sql = (file: string) => readFileSync(file, "utf8");

let world: SyntheticWorld;
const preflight: Record<string, number> = {};

/**
 * Runs the exact release text (scripts/release-sql.mjs: the file inside BEGIN ... COMMIT) as one batch, as the run
 * sheet does in the SQL editor or psql. On an error Postgres skips the rest of the batch, COMMIT included; the
 * ROLLBACK here stands for the session ending, which discards the open transaction the same way.
 */
async function applyRelease(db: Client, file: string, text = sql(path.join(MIGRATIONS, file))) {
  try {
    await db.query(releaseSql(text, file));
  } catch (err) {
    await db.query("rollback");
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const catalogueRows = (db: Client) => db.query<{ kind: string; object: string; detail: string }>(sql(path.join(ROOT, "supabase/verify/catalogue.sql"))).then((r) => r.rows);

/**
 * Where a failing statement can go in the file, and which objects the part above it creates. The point is between two top-level
 * statements (see inject-point.ts; verified against PostgreSQL in inject-point.pg.test.ts). The candidates (latest first) are the
 * functions, tables and columns that part creates; the test picks one that does NOT exist yet, so its absence after the rollback means
 * something. Whether the part really ran is proved by the probe itself, which reports whether the object existed at that point.
 */
function injectionPlan(text: string, where: "middle" | "late") {
  const lines = text.split("\n");
  const at = injectPoint(lines, where);
  if (at === undefined || at === 0) throw new Error("no point between two statements to inject a failure at");
  const above = lines.slice(0, at).join("\n");
  // The functions, tables and columns that part creates, and (049) the signatures it drops (inject-point.ts injectCandidates).
  const candidates = injectCandidates(above);
  return { lines, at, candidates };
}

type Candidate = ReturnType<typeof injectionPlan>["candidates"][number];
const present = async (db: Client, c: Candidate) => (await db.query<{ present: boolean }>(`SELECT ${c.exists} AS present`)).rows[0].present;

/** Runs the broken release text; it MUST fail. Returns the PostgreSQL error (message, SQLSTATE) after rolling back the open transaction. */
async function failedRelease(db: Client, file: string, text: string): Promise<{ message: string; code?: string }> {
  try {
    await db.query(releaseSql(text, file));
  } catch (err) {
    await db.query("rollback");
    return err as { message: string; code?: string };
  }
  throw new Error(`${file}: the release text with the injected failure applied without error`);
}

const IS_042 = (file: string) => file.endsWith("_internal_jobs_and_machines.sql");

/** Every kind of thing 042 adds: present after a clean run, and none of it after a failed one (column, table, constraint, functions, triggers, grants). */
async function expect042(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["jobs.is_internal", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'is_internal') as v"],
    ["jobs.related_job_id", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'related_job_id') as v"],
    ["jobs.customer nullable", "select (select is_nullable = 'YES' from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'customer') as v"],
    ["job_machines table", "select to_regclass('public.job_machines') is not null as v"],
    ["jobs_customer_unless_internal", "select exists (select 1 from pg_constraint where conname = 'jobs_customer_unless_internal') as v"],
    ["create_job", "select exists (select 1 from pg_proc where proname = 'create_job') as v"],
    ["save_machine_booking", "select exists (select 1 from pg_proc where proname = 'save_machine_booking') as v"],
    ["delete_machine_booking", "select exists (select 1 from pg_proc where proname = 'delete_machine_booking') as v"],
    ["booking_intervals", "select exists (select 1 from pg_proc where proname = 'booking_intervals') as v"],
    ["job_despatch_billing_guard fn", "select exists (select 1 from pg_proc where proname = 'job_despatch_billing_guard') as v"],
    ["jobs_internal_immutable trigger", "select exists (select 1 from pg_trigger where tgname = 'jobs_internal_immutable') as v"],
    ["zz_same_org_related_job_id trigger", "select exists (select 1 from pg_trigger where tgname = 'zz_same_org_related_job_id') as v"],
    ["a_job_despatch_billing_guard triggers", "select (select count(*) from pg_trigger where tgname = 'a_job_despatch_billing_guard') = 2 as v"],
    ["machine_bookings: authenticated select only", "select (select array_agg(privilege_type::text order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'machine_bookings' and grantee = 'authenticated') = array['SELECT'] as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
}

const IS_043 = (file: string) => file.endsWith("_sales_order_machines.sql");

/** Every kind of thing 043 adds: the plan table with its policies, grants and guards, the source-line column and index, the two new
 *  functions, set_job_machines, and the guards' column lists. */
async function expect043(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["sales_order_line_machines table", "select to_regclass('public.sales_order_line_machines') is not null as v"],
    ["job_machines.source_so_line_id", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_machines' and column_name = 'source_so_line_id') as v"],
    ["idx_job_machines_source_line", "select to_regclass('public.idx_job_machines_source_line') is not null as v"],
    ["zz_same_org_source_so_line_id trigger", "select exists (select 1 from pg_trigger where tgname = 'zz_same_org_source_so_line_id') as v"],
    ["set_sales_order_line_machines", "select to_regprocedure('public.set_sales_order_line_machines(uuid,uuid,jsonb)') is not null as v"],
    ["carry_so_machines", "select to_regprocedure('public.carry_so_machines(uuid,uuid)') is not null as v"],
    ["set_job_machines 5 args", "select to_regprocedure('public.set_job_machines(uuid,jsonb,boolean,jsonb,text)') is not null as v"],
    ["convert_sales_order carries", "select pg_get_functiondef('public.convert_sales_order(uuid)'::regprocedure) like '%carry_so_machines%' as v"],
    ["job_machines guards leave out the link", "select (select count(*) from pg_trigger where tgrelid = 'public.job_machines'::regclass and tgname in ('admin_mfa', 'support_read_only') and tgattr::text <> '') = 2 as v"],
    ["job_rework guards leave out the link", "select (select count(*) from pg_trigger where tgrelid = 'public.job_rework'::regclass and tgname in ('admin_mfa', 'support_read_only') and tgattr::text <> '') = 2 as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
}

/** What the catalogue fingerprint does not hold: every column and index in public, and the full text of every function in public and
 *  security_audit (077 replaces only security_audit.set_audit_hash). */
const structure = (db: Client) => db.query<{ k: string; d: string }>(
  `select 'column ' || table_name || '.' || column_name as k, data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as d
     from information_schema.columns where table_schema = 'public'
   union all select 'index ' || indexname, indexdef from pg_indexes where schemaname = 'public'
   union all select 'function ' || p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'security_audit') and p.prokind = 'f'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
   union all select 'trigger ' || tgrelid::regclass::text || ' ' || tgname, pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
   order by 1`).then((r) => r.rows);

const IS_044 = (file: string) => file.endsWith("_machine_runs.sql");

/** Every kind of thing 044 adds: the runs table, its indexes, grants and guards, the assignment columns and trigger, the finish guard, the functions. */
async function expect044(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["machine_runs table", "select to_regclass('public.machine_runs') is not null as v"],
    ["machine_runs_one_open_per_machine", "select to_regclass('public.machine_runs_one_open_per_machine') is not null as v"],
    ["machine_runs_client_op", "select to_regclass('public.machine_runs_client_op') is not null as v"],
    ["jobs.assigned_to", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'assigned_to') as v"],
    ["jobs.assigned_at", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'assigned_at') as v"],
    ["jobs.assigned_by", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'assigned_by') as v"],
    ["idx_jobs_assigned_to", "select to_regclass('public.idx_jobs_assigned_to') is not null as v"],
    ["ab_assignment_keep trigger", "select exists (select 1 from pg_trigger where tgname = 'ab_assignment_keep') as v"],
    ["ac_finish_guard trigger", "select exists (select 1 from pg_trigger where tgname = 'ac_finish_guard') as v"],
    ["start_machine_run", "select to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)') is not null as v"],
    ["pause_machine_run", "select to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)') is not null as v"],
    ["finish_job", "select to_regprocedure('public.finish_job(uuid,uuid,timestamptz)') is not null as v"],
    ["release_machine", "select to_regprocedure('public.release_machine(uuid,text)') is not null as v"],
    ["assign_job", "select to_regprocedure('public.assign_job(uuid,uuid)') is not null as v"],
    ["machines_in_use", "select to_regprocedure('public.machines_in_use()') is not null as v"],
    ["assignable_people", "select to_regprocedure('public.assignable_people()') is not null as v"],
    ["machine_run_end", "select to_regprocedure('public.machine_run_end(uuid,timestamptz,text,uuid)') is not null as v"],
    ["btree_gist extension", "select exists (select 1 from pg_extension where extname = 'btree_gist') as v"],
    ["machine_runs_no_overlap exclusion constraint", "select exists (select 1 from pg_constraint where conname = 'machine_runs_no_overlap' and contype = 'x') as v"],
    ["machine_runs.device_started_at", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'machine_runs' and column_name = 'device_started_at') as v"],
    ["machine_run_ops table", "select to_regclass('public.machine_run_ops') is not null as v"],
    ["machine_time", "select to_regprocedure('public.machine_time(timestamptz,timestamptz)') is not null as v"],
    ["tstz_union_hours", "select to_regprocedure('public.tstz_union_hours(tstzrange[])') is not null as v"],
    ["machine_run_end_conflicts", "select to_regprocedure('public.machine_run_end_conflicts(jsonb)') is not null as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
}

const IS_045 = (file: string) => file.endsWith("_job_signoff.sql");

/**
 * Every kind of thing 045 adds: the sign-off table, its uniqueness (one per role per revision, one per client key), the signature shape
 * check, its policy, grants and triggers (immutability included), and the functions. Signatures are stored inline, never in Storage: no
 * storage bucket or storage policy for them exists before, after a failed run, or after a clean one.
 */
async function expect045(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["job_signoffs table", "select to_regclass('public.job_signoffs') is not null as v"],
    ["job_signoffs_one_per_kind", "select exists (select 1 from pg_constraint where conname = 'job_signoffs_one_per_kind' and contype = 'u') as v"],
    ["job_signoffs_client_op", "select exists (select 1 from pg_constraint where conname = 'job_signoffs_client_op' and contype = 'u') as v"],
    ["job_signoffs_signature_shape", "select exists (select 1 from pg_constraint where conname = 'job_signoffs_signature_shape') as v"],
    ["job_signoffs rbac select policy", "select exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'job_signoffs' and policyname = 'job_signoffs rbac select') as v"],
    ["authenticated select grant", "select exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'job_signoffs' and grantee = 'authenticated') as v"],
    ["six job_signoffs triggers", "select (select count(*) from pg_trigger where tgname in ('job_signoffs_immutable', 'job_signoffs_no_truncate', 'audit_job_signoffs_changes', 'zz_same_org_job_id', 'support_read_only', 'admin_mfa') and tgrelid = to_regclass('public.job_signoffs')) = 6 as v"],
    ["job_signoffs_immutable function", "select to_regprocedure('public.job_signoffs_immutable()') is not null as v"],
    ["canonical_jsonb", "select to_regprocedure('public.canonical_jsonb(jsonb)') is not null as v"],
    ["job_signoff_snapshot", "select exists (select 1 from pg_proc where proname = 'job_signoff_snapshot') as v"],
    ["job_signoff_revision", "select to_regprocedure('public.job_signoff_revision(uuid)') is not null as v"],
    ["sign_off_job (10 arguments)", "select to_regprocedure('public.sign_off_job(uuid,integer,text,text,text,date,text,text,text,uuid)') is not null as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  expect(await q("select not exists (select 1 from pg_proc where proname = 'sign_off_job' and pronargs <> 10) as v"), "no other sign_off_job form").toBe(true);
  expect(await q(`select (select count(*) from storage.buckets where id ilike '%sign%' or name ilike '%sign%') = 0
                    and (select count(*) from pg_policies where schemaname = 'storage' and (policyname ilike '%sign%' or coalesce(qual, '') ilike '%signoff%' or coalesce(with_check, '') ilike '%signoff%')) = 0 as v`), "no storage bucket or policy for signatures").toBe(true);
}

const IS_046 = (file: string) => file.endsWith("_bench_pause.sql");
const IS_049 = (file: string) => file.endsWith("_paused_machine_ack.sql");

/**
 * Every kind of thing 046 adds: machine_runs.machine_id nullable, the bench-run shape check, the per-job exclusion constraints (bench
 * runs among themselves, bench beside machine), the 'to_machine' end reason, the one-open and client-key unique indexes, the bench index,
 * bench_run_open and bench_runs_state (with the job's state), and start_machine_run's new body (it calls bench_run_open and ends the bench
 * run on a machine Start; after a failed run it is 044's body again).
 */
async function expect046(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["machine_runs.machine_id nullable", "select (select is_nullable = 'YES' from information_schema.columns where table_schema = 'public' and table_name = 'machine_runs' and column_name = 'machine_id') as v"],
    ["machine_runs_bench_shape", "select exists (select 1 from pg_constraint where conname = 'machine_runs_bench_shape' and contype = 'c') as v"],
    ["machine_runs_bench_no_overlap", "select exists (select 1 from pg_constraint where conname = 'machine_runs_bench_no_overlap' and contype = 'x') as v"],
    ["machine_runs_bench_machine_no_overlap", "select exists (select 1 from pg_constraint where conname = 'machine_runs_bench_machine_no_overlap' and contype = 'x') as v"],
    ["end reason 'to_machine'", "select exists (select 1 from pg_constraint where conname = 'machine_runs_end_reason_check' and pg_get_constraintdef(oid) like '%to_machine%') as v"],
    ["bench_runs_state reports the job's actual work", "select coalesce((select pg_get_function_result(p.oid) like '%state text%' from pg_proc p where p.proname = 'bench_runs_state'), false) as v"],
    ["start_machine_run ends the bench run on a machine Start", "select position('BENCH_TO_MACHINE' in pg_get_functiondef('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)'::regprocedure)) > 0 as v"],
    ["machine_runs_one_open_bench_per_job", "select to_regclass('public.machine_runs_one_open_bench_per_job') is not null as v"],
    ["machine_runs_bench_client_op", "select to_regclass('public.machine_runs_bench_client_op') is not null as v"],
    ["idx_machine_runs_bench_job", "select to_regclass('public.idx_machine_runs_bench_job') is not null as v"],
    ["bench_run_open", "select to_regprocedure('public.bench_run_open(uuid,uuid,timestamptz,uuid,uuid,boolean)') is not null as v"],
    ["bench_runs_state", "select to_regprocedure('public.bench_runs_state()') is not null as v"],
    ["start_machine_run opens bench runs", "select position('bench_run_open' in pg_get_functiondef('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)'::regprocedure)) > 0 as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  // 044's guarantees stand either way (its end-reason check with 044's four reasons after a failed 046).
  expect(await q("select exists (select 1 from pg_constraint where conname = 'machine_runs_no_overlap' and contype = 'x') and to_regclass('public.machine_runs_one_open_per_machine') is not null as v")).toBe(true);
  expect(await q("select exists (select 1 from pg_constraint where conname = 'machine_runs_end_reason_check' and pg_get_constraintdef(oid) like '%admin_released%') as v")).toBe(true);
}

const IS_059 = (file: string) => file.endsWith("_delivery_note_auto_invoice.sql");

/**
 * Every kind of thing 059 adds: invoice_queue_events (RLS, its two policies), the internal draft, the skip reasons and the one attempt,
 * the trigger on a note going out (a void invoice drafts nothing: no trigger on invoices) and the backlog function; create_invoice_from_delivery_notes runs as its owner
 * and calls the internal draft (after a failed run it is 034's caller-rights body again).
 */
async function expect059(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["invoice_queue_events table", "select to_regclass('public.invoice_queue_events') is not null as v"],
    ["invoice_queue_events policies", "select (select count(*) from pg_policies where schemaname = 'public' and tablename = 'invoice_queue_events') = 2 as v"],
    ["invoice_from_delivery_notes_draft", "select to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)') is not null as v"],
    ["delivery_note_draft_block", "select to_regprocedure('public.delivery_note_draft_block(uuid)') is not null as v"],
    ["delivery_note_try_draft", "select to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)') is not null as v"],
    ["uninvoiced_delivery_notes", "select to_regprocedure('public.uninvoiced_delivery_notes()') is not null as v"],
    ["delivery_notes_auto_invoice trigger", "select exists (select 1 from pg_trigger where tgname = 'delivery_notes_auto_invoice' and tgrelid = 'public.delivery_notes'::regclass) as v"],
    ["create_invoice_from_delivery_notes runs as owner", "select prosecdef as v from pg_proc where oid = 'public.create_invoice_from_delivery_notes(uuid[],date,date,text)'::regprocedure"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  // Either way, voiding an invoice drafts nothing (034's rule: its notes are freed for a person to invoice again).
  expect(await q("select not exists (select 1 from pg_trigger where tgname = 'invoices_void_redraft') and to_regprocedure('public.invoice_void_redraft()') is null as v")).toBe(true);
  // 034's manual path stands either way, with the second step.
  expect(await q("select position('assert_privileged_aal' in pg_get_functiondef('public.create_invoice_from_delivery_notes(uuid[],date,date,text)'::regprocedure)) > 0 as v")).toBe(true);
}

const IS_061 = (file: string) => file.endsWith("_auto_book_next_free.sql");

/**
 * Everything 061 changes: the internal next-free-slot helper (no API role may run it), set_job_machines and carry_so_machines booking
 * through it, finish_job completing the job's remaining bookings. After a failed run all of them are the 043/044 bodies again.
 */
async function expect061(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["machine_next_free_start", "select to_regprocedure('public.machine_next_free_start(uuid,uuid,numeric,timestamptz,timestamptz)') is not null as v"],
    ["set_job_machines books at the next free slot", "select position('machine_next_free_start' in pg_get_functiondef('public.set_job_machines(uuid,jsonb,boolean,jsonb,text)'::regprocedure)) > 0 as v"],
    ["carry_so_machines books at the next free slot", "select position('machine_next_free_start' in pg_get_functiondef('public.carry_so_machines(uuid,uuid)'::regprocedure)) > 0 as v"],
    ["finish_job completes the job's bookings", "select position('FINISH_COMPLETES_BOOKINGS' in pg_get_functiondef('public.finish_job(uuid,uuid,timestamptz)'::regprocedure)) > 0 as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  // Either way the three keep the second step and their grants.
  expect(await q("select bool_and(position('assert_privileged_aal' in pg_get_functiondef(f)) > 0 and has_function_privilege('authenticated', f, 'EXECUTE') and not has_function_privilege('anon', f, 'EXECUTE')) as v from unnest(array['public.set_job_machines(uuid,jsonb,boolean,jsonb,text)'::regprocedure, 'public.carry_so_machines(uuid,uuid)'::regprocedure, 'public.finish_job(uuid,uuid,timestamptz)'::regprocedure]) f")).toBe(true);
}

const IS_064 = (file: string) => file.endsWith("_booking_run_identity.sql");

/**
 * Everything 064 adds: the two guard functions (internal: no API role may run them) and their BEFORE UPDATE / INSERT triggers on
 * machine_bookings and machine_runs. After a failed run none of them exist (064 replaces nothing).
 */
async function expect064(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["guard_booking_run_identity", "select to_regprocedure('public.guard_booking_run_identity()') is not null as v"],
    ["guard_run_booking_identity", "select to_regprocedure('public.guard_run_booking_identity()') is not null as v"],
    ["ab_booking_run_identity trigger", "select exists (select 1 from pg_trigger where tgname = 'ab_booking_run_identity' and tgrelid = 'public.machine_bookings'::regclass and tgenabled = 'O') as v"],
    ["ab_run_booking_identity trigger", "select exists (select 1 from pg_trigger where tgname = 'ab_run_booking_identity' and tgrelid = 'public.machine_runs'::regclass and tgenabled = 'O') as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  // Either way no API role can run a guard directly.
  expect(await q("select not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('guard_booking_run_identity', 'guard_run_booking_identity') and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) as v")).toBe(true);
}

const IS_065 = (file: string) => file.endsWith("_admin_mfa_onboarding.sql");

/**
 * Everything 065 adds: the enrolment flag on memberships, the factor lookup (internal), the flag trigger, the guard that keeps
 * require_admin_mfa off while an admin has not enrolled, and the two readers (signed-in only). After a failed run none exist.
 */
async function expect065(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["organization_members.mfa_enrolment_required", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organization_members' and column_name = 'mfa_enrolment_required') as v"],
    ["member_has_verified_totp", "select to_regprocedure('public.member_has_verified_totp(uuid)') is not null as v"],
    ["admin_mfa_overview", "select to_regprocedure('public.admin_mfa_overview()') is not null as v"],
    ["my_mfa_enrolment_required", "select to_regprocedure('public.my_mfa_enrolment_required()') is not null as v"],
    ["organization_members_mfa_enrolment trigger", "select exists (select 1 from pg_trigger where tgname = 'organization_members_mfa_enrolment' and tgrelid = 'public.organization_members'::regclass and tgenabled = 'O') as v"],
    ["organizations_require_admin_mfa_guard trigger", "select exists (select 1 from pg_trigger where tgname = 'organizations_require_admin_mfa_guard' and tgrelid = 'public.organizations'::regclass and tgenabled = 'O') as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  // Either way no API role can run the internal functions directly.
  expect(await q("select not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('member_has_verified_totp', 'organization_members_mfa_enrolment', 'organizations_require_admin_mfa_guard') and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) as v")).toBe(true);
}

// ---- Time and pay (050 to 052): numbered before 058 to 065, applied on production AFTER 065 ---------------------------------------
const TIME_FILES = later.filter((f) => /^05[0-2]_/.test(f));
/** 074 (day flags) builds on 050 to 052 and replaces 052's time_week_revision: torn down and re-applied with them, after them. */
const IS_074 = (file: string) => file.endsWith("_time_day_flags.sql");
const F074 = later.find(IS_074);
/** 075 (site network check, refused sync reports) builds on 050 to 052 (a trigger on attendance_events, check rows referencing it). */
const IS_075 = (file: string) => file.endsWith("_site_network_and_sync_rejections.sql");
const F075 = later.find(IS_075);
/** 078 (clock-in addresses kept 30 days apart from the check rows; CRD credit note numbers). */
const IS_078 = (file: string) => file.endsWith("_ip_retention_and_crd_numbers.sql");
const F078 = later.find(IS_078);
/** 078 (clock-in addresses kept apart) replaces 075's check trigger function and CHECK: torn down and re-applied after 075. */
/**
 * 092 (an admin's release ends the operator's labour) adds operator_sessions.end_reason and its CHECK, replaces the end_source CHECK
 * and replaces 051's labour_close and machine_runs_labour: the teardown drops operator_sessions and those functions, so 092 is
 * re-applied last, after 051 (its guard accepts 051's bodies). Found by its own name (IS_092 below).
 */
const F092 = later.find((file) => file.endsWith("_release_ends_session.sql"));
const TIME_FILES_WITH_074 = [...TIME_FILES, ...(F074 ? [F074] : []), ...(F075 ? [F075] : []), ...(F078 ? [F078] : []), ...(F092 ? [F092] : [])];

/** Every function 050 to 052 create, and whether the API roles may run it (all others internal: no API role). */
const TIME_FUNCTIONS: Record<"050" | "051" | "052", { internal: string[]; callable: string[] }> = {
  "050": {
    internal: ["time_week_of(timestamp with time zone)", "time_week_locked(uuid,uuid,date)", "time_week_locked_at(uuid,uuid,timestamp with time zone)", "attendance_client_time(timestamp with time zone)", "time_caller_org()", "attendance_answer(attendance_events,boolean)", "attendance_events_immutable()", "time_company_lock(uuid)", "attendance_lock(uuid,uuid)"],
    callable: ["record_attendance_event(uuid,text,timestamp with time zone,text)", "correct_attendance_event(uuid,uuid,uuid,text,timestamp with time zone,text)", "save_time_settings(jsonb)"],
  },
  "051": {
    internal: ["labour_lock(uuid,uuid)", "labour_lock_job_people(uuid,uuid,uuid)", "labour_answer(operator_sessions,text,boolean,timestamp with time zone)", "labour_open(uuid,uuid,uuid,timestamp with time zone,text,uuid,uuid)", "labour_close(uuid,uuid,timestamp with time zone,text,uuid)", "labour_close_all(uuid,uuid,timestamp with time zone,text,uuid)", "labour_write_failed(uuid,text,uuid,text,text,text)", "labour_assert_week_open(uuid,uuid,timestamp with time zone)", "machine_runs_labour()", "jobs_finish_labour()", "labour_may_change(uuid,uuid,timestamp with time zone,timestamp with time zone,text)", "labour_check_times(timestamp with time zone,timestamp with time zone,boolean)"],
    callable: ["record_labour_event(uuid,uuid,text,timestamp with time zone)", "add_labour_session(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,text)", "correct_labour_session(uuid,timestamp with time zone,timestamp with time zone,text)", "void_labour_session(uuid,text)"],
  },
  "052": {
    internal: ["time_week_revision(uuid,uuid,date)", "time_week_approvals_immutable()"],
    callable: ["time_week_status(date,uuid)", "approve_time_week(uuid,date,text,jsonb,text)"],
  },
};
const TIME_TABLES = { "050": ["attendance_events", "time_settings", "bank_holidays"], "051": ["labour_ops", "operator_sessions"], "052": ["time_week_approvals"] } as const;

/** Everything one of 050 to 052 adds: tables with RLS on and no API writes, its functions (internal ones run by no API role), its triggers. */
async function expectTime(db: Client, n: "050" | "051" | "052", present: boolean) {
  const q = async (text: string, params: unknown[] = []) => (await db.query<{ v: boolean }>(text, params)).rows[0].v;
  for (const t of TIME_TABLES[n]) {
    expect(await q("select to_regclass($1) is not null as v", [`public.${t}`]), `${n} table ${t} present = ${present}`).toBe(present);
    if (present) {
      expect(await q("select relrowsecurity as v from pg_class where oid = $1::regclass", [`public.${t}`]), `${n} ${t} RLS`).toBe(true);
      expect(await q("select not (has_table_privilege('authenticated', $1, 'INSERT') or has_table_privilege('authenticated', $1, 'UPDATE') or has_table_privilege('authenticated', $1, 'DELETE')) as v", [`public.${t}`]), `${n} ${t} no API writes`).toBe(true);
    }
  }
  for (const f of TIME_FUNCTIONS[n].callable) {
    expect(await q("select to_regprocedure($1) is not null as v", [`public.${f}`]), `${n} ${f} present = ${present}`).toBe(present);
    if (present) expect(await q("select has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') and not has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') as v", [`public.${f}`]), `${n} ${f} signed-in only`).toBe(true);
  }
  // 050's two placeholders stay (052 replaces them) unless 050 itself is absent.
  for (const f of TIME_FUNCTIONS[n].internal) {
    expect(await q("select to_regprocedure($1) is not null as v", [`public.${f}`]), `${n} ${f} present = ${present}`).toBe(present);
    if (present) expect(await q("select not (has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE')) as v", [`public.${f}`]), `${n} ${f} internal`).toBe(true);
  }
  if (n === "051") {
    expect(await q("select exists (select 1 from pg_trigger where tgname = 'zz_machine_runs_labour' and tgrelid = 'public.machine_runs'::regclass and tgenabled = 'O') as v")).toBe(present);
    expect(await q("select exists (select 1 from pg_trigger where tgname = 'zz_jobs_finish_labour' and tgrelid = 'public.jobs'::regclass and tgenabled = 'O') as v")).toBe(present);
  }
  if (n === "052" && present) expect(await q("select prosrc like '%time_week_approvals%' as v from pg_proc where oid = 'public.time_week_locked(uuid,uuid,date)'::regprocedure")).toBe(true);
}

const expect050 = (db: Client, present: boolean) => expectTime(db, "050", present);
const expect051 = (db: Client, present: boolean) => expectTime(db, "051", present);
const expect052 = (db: Client, present: boolean) => expectTime(db, "052", present);
const expectTimeAll = async (db: Client, present: boolean) => {
  await expect050(db, present);
  await expect051(db, present);
  await expect052(db, present);
  if (F074) await expect074(db, present);
  if (F075) await expect075(db, present);
  if (F078) await expect078Time(db, present);
};

/**
 * Everything 074 adds: the two tables (RLS on, no API writes, the keyed answers not readable), the save function (signed-in only), and
 * 052's time_week_revision replaced by the body that also reads the saved flags. After a failed run none of it exists and
 * time_week_revision is 052's again.
 */
async function expect074(db: Client, present: boolean) {
  const q = async (text: string, params: unknown[] = []) => (await db.query<{ v: boolean }>(text, params)).rows[0].v;
  for (const t of ["time_day_flags", "time_day_flag_ops"]) {
    expect(await q("select to_regclass($1) is not null as v", [`public.${t}`]), `074 table ${t} present = ${present}`).toBe(present);
    if (present) {
      expect(await q("select relrowsecurity as v from pg_class where oid = $1::regclass", [`public.${t}`]), `074 ${t} RLS`).toBe(true);
      expect(await q("select not (has_table_privilege('authenticated', $1, 'INSERT') or has_table_privilege('authenticated', $1, 'UPDATE') or has_table_privilege('authenticated', $1, 'DELETE')) as v", [`public.${t}`]), `074 ${t} no API writes`).toBe(true);
    }
  }
  if (present) expect(await q("select not has_table_privilege('authenticated', 'public.time_day_flag_ops', 'SELECT') as v")).toBe(true);
  const save = "public.set_time_day_flags(uuid,uuid,date,boolean,boolean,boolean,boolean)";
  expect(await q("select to_regprocedure($1) is not null as v", [save]), `074 set_time_day_flags present = ${present}`).toBe(present);
  if (present) expect(await q("select has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') and not has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') as v", [save])).toBe(true);
  // 052's function is there either way; its body reads the flags only with 074.
  if (await q("select to_regprocedure('public.time_week_revision(uuid,uuid,date)') is not null as v")) {
    expect(await q("select prosrc like '%time_day_flags%' as v from pg_proc where oid = 'public.time_week_revision(uuid,uuid,date)'::regprocedure"), `074 revision reads flags = ${present}`).toBe(present);
  }
}

/**
 * Everything 075 adds: six tables (RLS on, no API writes, the keyed admin answers not readable), seven functions signed-in members may
 * run, nine internal ones, and the AFTER INSERT check trigger on attendance_events. After a failed run none of it exists and
 * attendance_events has 050's triggers only.
 */
const T075 = ["site_network_settings", "site_networks", "site_network_members", "attendance_event_networks", "site_network_ops", "time_sync_rejections"];
const F075_CALLABLE = ["set_site_network_check(uuid,text)", "add_site_network(uuid,text,text)", "remove_site_network(uuid,uuid)", "set_member_on_site_only(uuid,uuid,boolean)",
  "my_request_network()", "report_time_sync_rejection(uuid,text,text,timestamp with time zone,text,text,text,text)", "resolve_time_sync_rejection(uuid,text)"];
const F075_INTERNAL = ["site_network_host(text)", "site_network_private(inet)", "site_network_parse(text)", "request_client_ip()", "site_network_matches(uuid,inet)",
  "attendance_events_network()", "site_network_admin_org()", "site_network_replay(uuid,uuid,text,jsonb)"];
async function expect075(db: Client, present: boolean) {
  const q = async (text: string, params: unknown[] = []) => (await db.query<{ v: boolean }>(text, params)).rows[0].v;
  for (const t of T075) {
    expect(await q("select to_regclass($1) is not null as v", [`public.${t}`]), `075 table ${t} present = ${present}`).toBe(present);
    if (present) {
      expect(await q("select relrowsecurity as v from pg_class where oid = $1::regclass", [`public.${t}`]), `075 ${t} RLS`).toBe(true);
      expect(await q("select not (has_table_privilege('authenticated', $1, 'INSERT') or has_table_privilege('authenticated', $1, 'UPDATE') or has_table_privilege('authenticated', $1, 'DELETE')) as v", [`public.${t}`]), `075 ${t} no API writes`).toBe(true);
    }
  }
  if (present) expect(await q("select not has_table_privilege('authenticated', 'public.site_network_ops', 'SELECT') as v")).toBe(true);
  for (const f of F075_CALLABLE) {
    expect(await q("select to_regprocedure($1) is not null as v", [`public.${f}`]), `075 ${f} present = ${present}`).toBe(present);
    if (present) expect(await q("select has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') and not has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') as v", [`public.${f}`]), `075 ${f} signed-in only`).toBe(true);
  }
  for (const f of F075_INTERNAL) {
    expect(await q("select to_regprocedure($1) is not null as v", [`public.${f}`]), `075 ${f} present = ${present}`).toBe(present);
    if (present) expect(await q("select not (has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE')) as v", [`public.${f}`]), `075 ${f} internal`).toBe(true);
  }
  if (await q("select to_regclass('public.attendance_events') is not null as v")) {
    expect(await q("select exists (select 1 from pg_trigger where tgname = 'zz_attendance_events_network' and tgrelid = 'public.attendance_events'::regclass and tgenabled = 'O') as v"), `075 check trigger present = ${present}`).toBe(present);
  }
}

const IS_076 = (file: string) => file.endsWith("_data_import.sql");

/**
 * Everything 076 adds: five tables (RLS on; mappings written by admins through row rules, the rest read only), the five import functions
 * signed-in only, their helpers internal, and the import (or undo) line in the six guards it passes. After a failed run none of it
 * exists and the guards are their 075 selves.
 */
const T076 = ["import_mappings", "import_batches", "import_record_keys", "import_runs", "import_stage"];
const F076_CALLABLE = ["import_company_data(jsonb,boolean,uuid)", "import_stage_part(uuid,integer,jsonb)", "import_validate(uuid,integer,uuid)",
  "import_commit_part(uuid,uuid)", "import_undo(uuid,uuid)"];
const F076_INTERNAL = ["import_norm_name(text)", "import_clean_text(text)", "import_clean_record(jsonb)", "import_num(text)", "import_date(text)", "import_bool(text)",
  "import_mappings_stamp()", "import_batches_immutable()", "import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)",
  "import_admin_org()", "import_check_payload(jsonb)", "import_replay(uuid,uuid,text)", "import_failure(jsonb,text,text,text)", "import_merge_stage(uuid,uuid)",
  "import_plan(jsonb,integer)", "import_part_payload(jsonb,jsonb)", "import_undo_part(uuid,uuid)"];
async function expect076(db: Client, present: boolean) {
  const q = async (text: string, params: unknown[] = []) => (await db.query<{ v: boolean }>(text, params)).rows[0].v;
  for (const t of T076) {
    expect(await q("select to_regclass($1) is not null as v", [`public.${t}`]), `076 table ${t} present = ${present}`).toBe(present);
    if (present) expect(await q("select relrowsecurity as v from pg_class where oid = $1::regclass", [`public.${t}`]), `076 ${t} RLS`).toBe(true);
  }
  if (present) {
    expect(await q("select not (has_table_privilege('authenticated', 'public.import_batches', 'INSERT') or has_table_privilege('authenticated', 'public.import_record_keys', 'INSERT') or has_table_privilege('authenticated', 'public.import_runs', 'INSERT') or has_table_privilege('authenticated', 'public.import_stage', 'INSERT')) as v")).toBe(true);
  }
  for (const f of F076_CALLABLE) {
    expect(await q("select to_regprocedure($1) is not null as v", [`public.${f}`]), `076 ${f} present = ${present}`).toBe(present);
    if (present) expect(await q("select has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') and not has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') as v", [`public.${f}`]), `076 ${f} signed-in only`).toBe(true);
  }
  for (const f of F076_INTERNAL) {
    expect(await q("select to_regprocedure($1) is not null as v", [`public.${f}`]), `076 ${f} present = ${present}`).toBe(present);
    if (present) expect(await q("select not (has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE')) as v", [`public.${f}`]), `076 ${f} internal`).toBe(true);
  }
  for (const g of ["documents_start_as_drafts()", "invoice_lines_issue_lock()", "quote_lines_issue_lock()", "invoice_issue_lock()", "quote_lifecycle_guard()", "purchase_order_issue_lock()"]) {
    expect(await q("select coalesce((select prosrc like '%quoteflow.data_import%' from pg_proc where oid = to_regprocedure($1)), false) as v", [`public.${g}`]), `076 ${g} import line present = ${present}`).toBe(present);
  }
}

/** Removes 052, 051 and 050 (in that order) inside the caller's transaction, data included: only ever rolled back. */
const TIME_TEARDOWN = [
  // 078's part A first (its address rows reference 075's check rows). Its part B (credit note numbers) stays: re-applying 078 replaces it
  // with the same text.
  "drop function if exists public.purge_site_network_ips(boolean)",
  "drop function if exists public.site_network_ip_purge(uuid,integer)",
  "drop table if exists public.attendance_event_network_ips",
  "drop function if exists public.site_network_ip_retention()",
  // 075 first (its check rows reference attendance_events; its trigger is on it).
  "drop trigger if exists zz_attendance_events_network on public.attendance_events",
  ...[...F075_CALLABLE, ...F075_INTERNAL, "time_sync_rejection_answer(time_sync_rejections,boolean)"].map((f) => `drop function if exists public.${f}`),
  ...T075.map((t) => `drop table if exists public.${t}`),
  // 074 first (it needs 050 to 052).
  "drop function if exists public.set_time_day_flags(uuid,uuid,date,boolean,boolean,boolean,boolean)",
  "drop table if exists public.time_day_flag_ops",
  "drop table if exists public.time_day_flags",
  "drop trigger if exists zz_machine_runs_labour on public.machine_runs",
  "drop trigger if exists zz_jobs_finish_labour on public.jobs",
  // Functions first (two take a table's row type), then the tables (with their own triggers), then those triggers' functions.
  ...(["052", "051", "050"] as const).flatMap((n) => [...TIME_FUNCTIONS[n].callable, ...TIME_FUNCTIONS[n].internal].filter((f) => !f.endsWith("_immutable()")).map((f) => `drop function if exists public.${f}`)),
  ...(["052", "051", "050"] as const).flatMap((n) => TIME_TABLES[n].map((t) => `drop table if exists public.${t}`)),
  "drop function if exists public.time_week_approvals_immutable()",
  "drop function if exists public.attendance_events_immutable()",
];

const IS_066 = (file: string) => file.endsWith("_company_access.sql");

/**
 * Everything 066 adds: three SECURITY DEFINER functions (signed-in only), and set_member_access replaced (the last-company rule).
 * It changes no table, policy or trigger, so after a failed run none of the three exist, set_member_access is 036's, and nothing
 * else differs.
 */
async function expect066(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["my_admin_companies", "select to_regprocedure('public.my_admin_companies()') is not null as v"],
    ["admin_company_access", "select to_regprocedure('public.admin_company_access(uuid)') is not null as v"],
    ["admin_set_company_access", "select to_regprocedure('public.admin_set_company_access(uuid,uuid,text,text,boolean,boolean)') is not null as v"],
    // 066 also replaces set_member_access (Deactivate keeps a login's last company); a failed run leaves 036's body exactly.
    ["set_member_access last-company rule", "select position('''last_company''' in prosrc) > 0 as v from pg_proc where oid = to_regprocedure('public.set_member_access(uuid,text,boolean,text,boolean,text[])')"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  // Whenever present: anon can't run any of them.
  expect(await q("select not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('my_admin_companies', 'admin_company_access', 'admin_set_company_access') and has_function_privilege('anon', p.oid, 'EXECUTE')) as v")).toBe(true);
}

const IS_067 = (file: string) => file.endsWith("_document_attachments.sql");

/**
 * Everything 067 adds: quote_attachments.kind, the customer-PO kind and triggers on job_files, the document_attachments table, the
 * draft-invoice correction and the delivery-note link. After a failed run none exist (Storage policies are checked by the catalogue).
 */
async function expect067(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["quote_attachments.kind", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_attachments' and column_name = 'kind') as v"],
    ["document_attachments", "select to_regclass('public.document_attachments') is not null as v"],
    ["replace_draft_invoice", "select to_regprocedure('public.replace_draft_invoice(uuid, timestamptz, jsonb, jsonb)') is not null as v"],
    ["link_delivery_note_to_invoice", "select to_regprocedure('public.link_delivery_note_to_invoice(uuid, uuid)') is not null as v"],
    ["a_job_files_customer_po trigger", "select exists (select 1 from pg_trigger where tgname = 'a_job_files_customer_po' and tgrelid = 'public.job_files'::regclass) as v"],
    ["quote_attachments_customer_po_to_jobs trigger", "select exists (select 1 from pg_trigger where tgname = 'quote_attachments_customer_po_to_jobs' and tgrelid = 'public.quote_attachments'::regclass) as v"],
    ["job_file_quote_reference_ok", "select to_regprocedure('public.job_file_quote_reference_ok(uuid, text, text, uuid)') is not null as v"],
    ["job_files quote file references policy", "select exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'job_files' and policyname = 'job_files quote file references') as v"],
    ["job_files customer po not for viewers policy", "select exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'job_files' and policyname = 'job_files customer po not for viewers') as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  // job_files' kind rule lets customer_po in only with 067.
  expect(await q("select coalesce((select pg_get_constraintdef(oid) like '%customer_po%' from pg_constraint where conrelid = 'public.job_files'::regclass and conname = 'job_files_kind_check'), false) as v")).toBe(present);
}

const IS_068 = (file: string) => file.endsWith("_quote_versions.sql");

/**
 * Everything 068 adds: the version columns and chain index on quotes, the declined / part columns on lines, revise_quote, the two
 * quote triggers, and accept_quote's four-argument form in place of the three-argument one. After a failed run none of them exist and
 * the 058 accept_quote is still there.
 */
async function expect068(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["quotes.version", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'version') as v"],
    ["quote_line_items.declined", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_line_items' and column_name = 'declined') as v"],
    ["sales_order_lines.part_number", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sales_order_lines' and column_name = 'part_number') as v"],
    ["quotes_one_revision_each", "select to_regclass('public.quotes_one_revision_each') is not null as v"],
    ["revise_quote", "select to_regprocedure('public.revise_quote(uuid)') is not null as v"],
    ["accept_quote with p_lines", "select to_regprocedure('public.accept_quote(uuid, text, date, uuid[])') is not null as v"],
    ["quote_version_guard trigger", "select exists (select 1 from pg_trigger where tgname = 'quote_version_guard' and tgrelid = 'public.quotes'::regclass and tgenabled = 'O') as v"],
    ["quote_revision_withdrawn trigger", "select exists (select 1 from pg_trigger where tgname = 'quote_revision_withdrawn' and tgrelid = 'public.quotes'::regclass and tgenabled = 'O') as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  expect(await q("select to_regprocedure('public.accept_quote(uuid, text, date)') is not null as v"), "058 accept_quote").toBe(!present);
  // 067's customer-PO trigger matches the quote's own number through jobs.quote_id only with 068 (after a failed run: 067's body).
  expect(await q("select coalesce((select prosrc like '%quote_base_ref%' from pg_proc where oid = to_regprocedure('public.quote_attachments_customer_po_to_jobs()')), false) as v"), "customer PO trigger on the base ref").toBe(present);
  // Either way no API role can run the internal functions directly.
  expect(await q("select not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('quote_version_guard', 'quote_revision_withdrawn', 'quote_line_part_clean', 'create_sales_order_from_quote', 'quote_attachments_customer_po_to_jobs') and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) as v")).toBe(true);
}

const IS_072 = (file: string) => file.endsWith("_customer_signoff.sql");

/**
 * Everything 072 adds: the company setting and its guard (internal), the customer kind and columns on job_signoffs with their shape
 * check, and the two signed-in functions. After a failed run none exist and the kind check is 045's again.
 */
async function expect072(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const checks: [string, string][] = [
    ["organization_settings.customer_signoff_enabled", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organization_settings' and column_name = 'customer_signoff_enabled') as v"],
    ["job_signoffs.device_signed_at", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'job_signoffs' and column_name = 'device_signed_at') as v"],
    ["job_signoffs_customer_shape", "select exists (select 1 from pg_constraint where conrelid = 'public.job_signoffs'::regclass and conname = 'job_signoffs_customer_shape') as v"],
    ["job_signoffs_device_time_window", "select exists (select 1 from pg_constraint where conrelid = 'public.job_signoffs'::regclass and conname = 'job_signoffs_device_time_window') as v"],
    ["kind check allows customer", "select exists (select 1 from pg_constraint where conrelid = 'public.job_signoffs'::regclass and conname = 'job_signoffs_kind_check' and pg_get_constraintdef(oid) like '%customer%') as v"],
    ["sign_off_job_customer", "select to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)') is not null as v"],
    ["set_customer_signoff_enabled", "select to_regprocedure('public.set_customer_signoff_enabled(boolean)') is not null as v"],
    ["organization_settings_customer_signoff_guard trigger", "select exists (select 1 from pg_trigger where tgname = 'organization_settings_customer_signoff_guard' and tgrelid = 'public.organization_settings'::regclass and tgenabled = 'O') as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  // Either way 045's sign-off function keeps its one 10-argument form, and the kind check exists.
  expect(await q("select not exists (select 1 from pg_proc where proname = 'sign_off_job' and pronargs <> 10) as v")).toBe(true);
  expect(await q("select exists (select 1 from pg_constraint where conrelid = 'public.job_signoffs'::regclass and conname = 'job_signoffs_kind_check') as v")).toBe(true);
}

const IS_073 = (file: string) => file.endsWith("_invoice_screen.sql");

/**
 * Everything 073 adds: void_invoice, its guard and the invoice status allowlist, the text-only issue rule, the invoice-line check for £0 text lines (create_with_lines and
 * replace_draft_invoice use it), the invoice note, the delivery address and the customer's mobile. After a failed run none exist and
 * the invoice-line rule is 006's quantity > 0 again.
 */
async function expect073(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const column = (table: string, name: string) => `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name = '${name}') as v`;
  const checks: [string, string][] = [
    ["void_invoice", "select to_regprocedure('public.void_invoice(uuid, text)') is not null as v"],
    ["check_invoice_line", "select to_regprocedure('public.check_invoice_line(jsonb)') is not null as v"],
    ["invoices_void_guard trigger", "select exists (select 1 from pg_trigger where tgname = 'invoices_void_guard' and tgrelid = 'public.invoices'::regclass) as v"],
    ["invoices_status_allowlist trigger", "select exists (select 1 from pg_trigger where tgname = 'invoices_status_allowlist' and tgrelid = 'public.invoices'::regclass) as v"],
    ["invoices_issue_needs_priced_line trigger", "select exists (select 1 from pg_trigger where tgname = 'invoices_issue_needs_priced_line' and tgrelid = 'public.invoices'::regclass) as v"],
    ["invoices.invoice_note", column("invoices", "invoice_note")],
    ["invoices.delivery_address", column("invoices", "delivery_address")],
    ["customers.mobile", column("customers", "mobile")],
    ["create_with_lines uses check_invoice_line", "select position('check_invoice_line' in pg_get_functiondef('public.create_with_lines(text, jsonb, text, text, jsonb)'::regprocedure)) > 0 as v"],
    ["replace_draft_invoice takes the note", "select position('invoice_note' in pg_get_functiondef('public.replace_draft_invoice(uuid, timestamptz, jsonb, jsonb)'::regprocedure)) > 0 as v"],
    ["invoice text-line rule", "select coalesce((select pg_get_constraintdef(oid) like '%unit_price%' from pg_constraint where conrelid = 'public.invoice_line_items'::regclass and conname = 'invoice_line_items_quantity_positive'), false) as v"],
  ];
  for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
}

const IS_077 = (file: string) => file.endsWith("_audit_hash_index_lookup.sql");

/**
 * What 077 changes: security_audit.set_audit_hash's previous-hash lookup only (its body, compared without whitespace: 077's after a clean
 * run, 006's after a failed one), on the same trigger, with audit_log_org_created_idx (organization_id, created_at DESC) valid either way
 * (it has existed since 000). Either way the next row of every company chains to the same row under 006's and 077's lookups.
 */
async function expect077(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  const body = "select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = 'security_audit.set_audit_hash()'::regprocedure";
  expect((await db.query<{ v: string }>(body)).rows[0].v, `077 set_audit_hash is ${present ? "077's" : "006's"}`)
    .toBe(present ? "5f4b0bcedcdf8a8c044e2e78a88a7221" : "f52ea7c6a9b6178d866b73e7a84d784e");
  expect(await q("select exists (select 1 from pg_trigger where tgname = 'audit_log_set_hash' and tgrelid = 'security_audit.audit_log'::regclass and tgenabled = 'O' and tgfoid = 'security_audit.set_audit_hash()'::regprocedure) as v")).toBe(true);
  expect(await q("select exists (select 1 from pg_index i where i.indexrelid = to_regclass('security_audit.audit_log_org_created_idx') and i.indisvalid and pg_get_indexdef(i.indexrelid) = 'CREATE INDEX audit_log_org_created_idx ON security_audit.audit_log USING btree (organization_id, created_at DESC)') as v")).toBe(true);
  expect(await q(`select bool_and(by_006 is not distinct from by_077) as v from (
      select (select a.hash from security_audit.audit_log a where a.organization_id is not distinct from c.org order by a.created_at desc limit 1) as by_006,
             (select a.hash from security_audit.audit_log a where (a.organization_id = c.org or (c.org is null and a.organization_id is null)) order by a.organization_id, a.created_at desc limit 1) as by_077
      from (select id as org from public.organizations union all select null::uuid) c) x`), "077 same previous row for every company").toBe(true);
}

const IS_079 = (file: string) => file.endsWith("_import_safeupdate.sql");

/**
 * What 079 changes: public.import_company_data_run's body only (076's with WHERE TRUE on the eight UPDATEs pg-safeupdate refuses in API
 * sessions; compared without whitespace: 079's after a clean run, 076's after a failed one). Still internal: no API role may run it.
 */
async function expect079(db: Client, present: boolean) {
  const sig = "public.import_company_data_run(uuid,uuid,uuid,jsonb,text,uuid,text,uuid,integer,integer)";
  const body = await db.query<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = to_regprocedure($1)", [sig]);
  expect(body.rows[0]?.v, `079 import_company_data_run is ${present ? "079's" : "076's"}`)
    .toBe(present ? "f7c672e961be898619c046d76458680e" : "648b7e0652cf46eacf73685343ef9572");
  expect((await db.query<{ v: boolean }>("select not (has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE')) as v", [sig])).rows[0].v,
    "079 import_company_data_run internal").toBe(true);
}

const IS_080 = (file: string) => file.endsWith("_activity_labels_job_work.sql");

/**
 * What 080 changes: security_audit.activity_label(text, jsonb) (new, internal); org_activity's body (035's but for that call: compared
 * without whitespace, 080's after a clean run, 035's after a failed one) with its security and grants as before; convert_sales_order's
 * body (068's but for the job's description). Its backfill of 'Converted from SO-...' descriptions touches no catalogue object.
 */
async function expect080(db: Client, present: boolean) {
  const md5 = async (sig: string) => (await db.query<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = to_regprocedure($1)", [sig])).rows[0]?.v;
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  expect(await md5("public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)"), `080 org_activity is ${present ? "080's" : "035's"}`)
    .toBe(present ? "ae7e2416ce0a54b0d8ccb721aeb2d245" : "292d6e2612099e36dd107422bd50e1b5");
  expect(await md5("public.convert_sales_order(uuid)"), `080 convert_sales_order is ${present ? "080's" : "068's"}`)
    .toBe(present ? "dc8165549871bd15047765ac4fba811e" : "5555212a1d32070ce74209e718c3896d");
  expect(await q("select to_regprocedure('security_audit.activity_label(text,jsonb)') is not null as v"), `080 activity_label(text, jsonb) present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select not (has_function_privilege('anon', 'security_audit.activity_label(text,jsonb)'::regprocedure, 'EXECUTE') or has_function_privilege('authenticated', 'security_audit.activity_label(text,jsonb)'::regprocedure, 'EXECUTE')) as v"),
      "080 activity_label(text, jsonb) internal").toBe(true);
  }
  expect(await q("select p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE') as v from pg_proc p where p.oid = 'public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)'::regprocedure"),
    "080 org_activity security and grants unchanged").toBe(true);
}

const IS_081 = (file: string) => file.endsWith("_job_flow_release.sql");

/**
 * What 081 changes: job_release_state's body (037's but for the released line: Complete, or an admin's early release) and
 * delivery_note_try_draft's (059's but for putting a note on its job's invoice), compared without whitespace (081's after a clean run,
 * 037's / 059's after a failed one); new: flow_status(jobs) (worked out from the row), job_flow_events (RLS, read only), the job_inspections evidence
 * columns and triggers, inspect_job / reopen_job / release_job_early (signed-in only), the release gates on delivery notes and invoices.
 */
async function expect081(db: Client, present: boolean) {
  const md5 = async (sig: string) => (await db.query<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = to_regprocedure($1)", [sig])).rows[0]?.v;
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  expect(await md5("public.job_release_state(uuid)"), `081 job_release_state is ${present ? "081's" : "037's"}`)
    .toBe(present ? "c16ea537b0b5706ab6db6e160214e17d" : "a7454c7da7ee23564436acfa6a330cd6");
  expect(await md5("public.delivery_note_try_draft(uuid,uuid,text)"), `081 delivery_note_try_draft is ${present ? "081's" : "059's"}`)
    .toBe(present ? "52a9771fec832f0e20e9d780e7561caa" : "ef7acce200b6f0349c84f076725d77c1");
  expect(await q("select to_regclass('public.job_flow_events') is not null as v"), `081 job_flow_events present = ${present}`).toBe(present);
  expect(await q("select to_regprocedure('public.flow_status(public.jobs)') is not null as v"), `081 flow_status(jobs) present = ${present}`).toBe(present);
  expect(await q("select to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)') is not null as v"), `081 inspect_job present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select bool_and(has_function_privilege('authenticated', to_regprocedure(s), 'EXECUTE') and not has_function_privilege('anon', to_regprocedure(s), 'EXECUTE')) as v from unnest(array['public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)', 'public.reopen_job(uuid,text)', 'public.release_job_early(uuid,text)']) s"),
      "081 API functions signed-in only").toBe(true);
    expect(await q("select not (has_table_privilege('authenticated', 'public.job_flow_events', 'INSERT') or has_table_privilege('anon', 'public.job_flow_events', 'SELECT')) and (select relrowsecurity from pg_class where oid = 'public.job_flow_events'::regclass) as v"),
      "081 job_flow_events read only, RLS on").toBe(true);
  }
}

const IS_082 = (file: string) => file.endsWith("_traceability_records_suppliers.sql");

/**
 * What 082 changes: three tables gain a column (suppliers' status, customers' traceable default, jobs' traceable flag), six internal
 * trigger functions and their triggers. No policy or grant for an API role is added; nothing else is replaced.
 */
async function expect082(db: Client, present: boolean) {
  const q = async (text: string, params: unknown[] = []) => (await db.query<{ v: boolean }>(text, params)).rows[0].v;
  for (const [table, column] of [["suppliers", "supplier_status"], ["customers", "traceable_default"], ["jobs", "traceable"]]) {
    expect(await q("select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2) as v", [table, column]), `082 ${table}.${column} present = ${present}`).toBe(present);
  }
  for (const [table, name] of [["jobs", "jobs_traceability"], ["job_inspections", "job_inspections_traceability"], ["purchase_orders", "purchase_orders_supplier_status"],
    ["suppliers", "suppliers_status_guard"], ["suppliers", "suppliers_in_use_guard"], ["customers", "customers_in_use_guard"]]) {
    expect(await q("select to_regprocedure($1) is not null as v", [`public.${name}()`]), `082 ${name}() present = ${present}`).toBe(present);
    expect(await q("select exists (select 1 from pg_trigger where tgrelid = to_regclass($1) and tgname = $2 and tgenabled = 'O') as v", [`public.${table}`, name]), `082 trigger ${name} present = ${present}`).toBe(present);
    if (present) {
      expect(await q("select not (has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE')) as v", [`public.${name}()`]), `082 ${name}() internal`).toBe(true);
    }
  }
}

const IS_083 = (file: string) => file.endsWith("_authorised_inspectors.sql");

/**
 * What 083 changes: public.inspector_authorisations (RLS on, SELECT only for signed-in users), set_authorised_inspector and
 * set_job_drawing_revision (signed-in definer RPCs), the pass check on job_inspections and job_signoffs, the history trigger on
 * organization_members and the drawing revision check on jobs (internal trigger functions), jobs.drawing_revision(_required), and
 * inspect_job's body (081's but for its interim check: 083's after a clean run, 081's after a failed one). After a failed run none of it exists; after a clean run every active admin is on the
 * list and everyone on it has a history row.
 */
async function expect083(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  expect(await q("select to_regclass('public.inspector_authorisations') is not null as v"), `083 inspector_authorisations present = ${present}`).toBe(present);
  expect(await q("select to_regprocedure('public.set_authorised_inspector(uuid,boolean,text,text)') is not null as v"), `083 set_authorised_inspector present = ${present}`).toBe(present);
  expect(await q("select count(*) = 2 as v from pg_trigger where tgname = 'zz_inspection_pass_authorised' and tgrelid in ('public.job_inspections'::regclass, 'public.job_signoffs'::regclass)"),
    `083 pass check present = ${present}`).toBe(present);
  expect(await q("select exists (select 1 from pg_trigger where tgname = 'zz_inspector_history' and tgrelid = 'public.organization_members'::regclass) as v"), `083 history trigger present = ${present}`).toBe(present);
  expect((await db.query<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)')")).rows[0]?.v,
    `083 inspect_job is ${present ? "083's" : "081's"}`).toBe(present ? "b411b17ef7cb8a5f3700957d9a7a264f" : "c8dd01f7f385e60e1a4597e5f1da8fe8");
  expect(await q("select count(*) = 2 as v from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name in ('drawing_revision', 'drawing_revision_required')"),
    `083 drawing revision columns present = ${present}`).toBe(present);
  expect(await q("select exists (select 1 from pg_trigger where tgname = 'jobs_zz_drawing_revision' and tgrelid = 'public.jobs'::regclass) as v"), `083 drawing revision check present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select md5(regexp_replace(prosrc, '\\s', '', 'g')) = 'a3280e8e083ff65f62334c60d78fd997' as v from pg_proc where oid = 'public.inspection_pass_authorised()'::regprocedure"), "083 pass check body").toBe(true);
    expect(await q("select c.relrowsecurity and has_table_privilege('authenticated', c.oid, 'SELECT') and not has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE') and not has_table_privilege('anon', c.oid, 'SELECT') as v from pg_class c where c.oid = 'public.inspector_authorisations'::regclass"),
      "083 history table grants").toBe(true);
    expect(await q("select p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE') as v from pg_proc p where p.oid = 'public.set_authorised_inspector(uuid,boolean,text,text)'::regprocedure"),
      "083 set_authorised_inspector signed-in only").toBe(true);
    expect(await q("select not (has_function_privilege('authenticated', 'public.inspection_pass_authorised()'::regprocedure, 'EXECUTE') or has_function_privilege('authenticated', 'public.organization_members_inspector_history()'::regprocedure, 'EXECUTE')) as v"),
      "083 trigger functions internal").toBe(true);
    expect(await q("select not exists (select 1 from public.organization_members m where m.active and not m.support and not m.can_inspect and 'admin' in (m.role, coalesce(m.secondary_role, ''))) as v"),
      "083 backfill: every active admin on the list").toBe(true);
  }
}

const IS_084 = (file: string) => file.endsWith("_integrations_xero.sql");

/**
 * What 084 changes (integrations layer + Xero, G22): six tables (RLS on; the secrets and the OAuth states unreadable by signed-in users and
 * not audited; the other four SELECT for signed-in users, the company's admins by policy), the enqueue trigger on invoices and credit notes,
 * the signed-in RPCs (admin, two-step) and the server's functions (EXECUTE revoked from PUBLIC, anon and authenticated). After a failed run
 * none of it exists; after a clean run no company is connected (off by default) and nothing is queued.
 */
async function expect084(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  for (const table of ["integration_connections", "integration_secrets", "integration_oauth_states", "integration_mappings", "integration_contacts", "integration_sends"]) {
    expect(await q(`select to_regclass('public.${table}') is not null as v`), `084 ${table} present = ${present}`).toBe(present);
  }
  expect(await q("select count(*) = 2 as v from pg_trigger where tgname = 'zz_integration_enqueue' and tgrelid in ('public.invoices'::regclass, 'public.credit_notes'::regclass)"),
    `084 enqueue trigger present = ${present}`).toBe(present);
  expect(await q("select count(*) = 20 as v from pg_proc where pronamespace = 'public'::regnamespace and proname like 'integration\\_%'"), `084 functions present = ${present}`).toBe(present);
  if (present) {
    expect(await q(`select bool_and(c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'SELECT') and not has_table_privilege('anon', c.oid, 'SELECT'))
                    and not exists (select 1 from pg_policies p where p.tablename in ('integration_secrets', 'integration_oauth_states')) as v
                    from pg_class c where c.oid in ('public.integration_secrets'::regclass, 'public.integration_oauth_states'::regclass)`), "084 secrets unreadable").toBe(true);
    expect(await q(`select bool_and(c.relrowsecurity and has_table_privilege('authenticated', c.oid, 'SELECT') and not has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE'))
                    as v from pg_class c where c.oid in ('public.integration_connections'::regclass, 'public.integration_mappings'::regclass, 'public.integration_contacts'::regclass, 'public.integration_sends'::regclass)`),
      "084 readable tables SELECT only").toBe(true);
    expect(await q(`select bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')) as v from pg_proc p
                    where p.oid in ('public.integration_token_lease(uuid,text,uuid,integer)'::regprocedure, 'public.integration_claim_next(uuid,text,integer,text,uuid)'::regprocedure,
                                    'public.integration_store_connection(uuid,uuid,text,text,text,text,text,text,timestamp with time zone,integer)'::regprocedure, 'public.integration_enqueue()'::regprocedure)`),
      "084 server functions not in the API").toBe(true);
    expect(await q("select p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE') as v from pg_proc p where p.oid = 'public.integration_oauth_begin(text,text,text)'::regprocedure"),
      "084 connect signed-in only").toBe(true);
    expect(await q("select not exists (select 1 from public.integration_connections) and not exists (select 1 from public.integration_sends) as v"), "084 off by default: nothing connected or queued").toBe(true);
  }
}

const IS_085 = (file: string) => file.endsWith("_data_import_credit_delivery.sql");

/**
 * What 085 changes: ten function bodies (the four credit note and delivery note guards, 034's / 037's plus one block; 079's
 * import_company_data_run and five 076 import helpers, extended; compared without whitespace: 085's after a clean run, the bodies before
 * after a failed one), all internal but the guards (whose grants are unchanged); the people columns on invoices, purchase_orders and
 * delivery_notes with import_people_guard (internal) on each; the two import kinds on the record keys and saved mappings. After a failed
 * run none of it exists.
 */
async function expect085(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  for (const [name, before, after] of [
    ["credit_note_issue_lock", "fb8e80d48fc099c48df1e783baf29fc1", "8e0ff460c60a94bb1164dc39dd77aae1"],
    ["credit_note_lines_issue_lock", "d044647b5c7768cea71ed0a869b29428", "369bbaa5c6979d4bb9d70c5cbf68d9bd"],
    ["delivery_notes_link_guard", "d785f434d829cb12f0f3eccbd8c73908", "4c57607b1909f060d689df9ea5a99128"],
    ["delivery_note_items_link_guard", "699da71eb0c6c42410f94ca1e2ccb023", "612a2bc924a8ea1916ce1a66101ced97"],
    ["import_check_payload", "24dfe4ba953c462ccdf0fe83c41b064d", "7c041eb39e57ee9504308162bc3217c9"],
    ["import_merge_stage", "080be44b691830f8b5898e1ba2cc470a", "b24dbc8ae80269fca5d93345a1d3f50a"],
    ["import_plan", "a01903b90106d900cbdd6a5428411ef1", "ba1637348e59883e1473ee4645875c12"],
    ["import_part_payload", "08847bc25a95d21765fe9f5af0c4684f", "bcd8bc328cde95cceafefe0ca1b0990b"],
    ["import_company_data_run", "f7c672e961be898619c046d76458680e", "0a2fec5746b0b1262cb2af6fe792bd7c"],
    ["import_undo_part", "2a1f18cca913a8e2eb21ec7970285748", "177d5c7273b79670dd0c3f130b215652"],
  ]) {
    expect((await db.query<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [name])).rows[0]?.v,
      `085 ${name} is ${present ? "085's" : "the body before 085"}`).toBe(present ? after : before);
  }
  expect(await q("select count(*) = 5 as v from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (('invoices', 'sent_by_name'), ('invoices', 'sent_by_user_id'), ('purchase_orders', 'sent_by_name'), ('purchase_orders', 'sent_by_user_id'), ('delivery_notes', 'signed_by_user_id'))"),
    `085 people columns present = ${present}`).toBe(present);
  expect(await q("select count(*) = 3 as v from pg_trigger where tgname = 'import_people_guard' and not tgisinternal"), `085 people triggers present = ${present}`).toBe(present);
  expect(await q("select count(*) = 2 as v from pg_constraint where conname in ('import_mappings_kind_check', 'import_record_keys_kind_check') and pg_get_constraintdef(oid) like '%credit_notes%'"),
    `085 import kinds widened = ${present}`).toBe(present);
  if (present) {
    expect(await q("select md5(regexp_replace(prosrc, '\\s', '', 'g')) = '513ca1c3542ad19388992a58a8b78cdb' and not has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE') as v from pg_proc where oid = 'public.import_people_guard()'::regprocedure"),
      "085 people guard body, internal").toBe(true);
    expect(await q("select bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')) as v from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('import_check_payload', 'import_merge_stage', 'import_plan', 'import_part_payload', 'import_company_data_run', 'import_undo_part')"),
      "085 import engine internal").toBe(true);
  }
}

const IS_088 = (file: string) => file.endsWith("_converted_sales_order_guard.sql");

/**
 * What 088 changes: one trigger function (internal, definer) and its BEFORE UPDATE trigger on the four money / VAT columns of
 * sales_orders, and one more (internal, definer) with its BEFORE UPDATE OF converted_from_sales_order_id trigger on jobs. After a failed
 * run none exists. No data, policy or grant changes.
 */
async function expect088(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  expect(await q("select to_regprocedure('public.sales_orders_converted_money_guard()') is not null as v"), `088 guard present = ${present}`).toBe(present);
  expect(await q("select count(*) = 1 as v from pg_trigger where tgname = 'zz_converted_order_money' and tgrelid = 'public.sales_orders'::regclass"),
    `088 trigger present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select md5(regexp_replace(prosrc, '\\s', '', 'g')) = '6ef7d52b93dee149a290afec414ada86' and prosecdef and not has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE') as v from pg_proc where oid = 'public.sales_orders_converted_money_guard()'::regprocedure"),
      "088 guard body, internal").toBe(true);
  }
  expect(await q("select to_regprocedure('public.jobs_converted_order_link_guard()') is not null as v"), `088 job link guard present = ${present}`).toBe(present);
  expect(await q("select count(*) = 1 as v from pg_trigger where tgname = 'zz_converted_order_link' and tgrelid = 'public.jobs'::regclass"),
    `088 job link trigger present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select md5(regexp_replace(prosrc, '\\s', '', 'g')) = 'b81e2cea3f3051325c67bf065858b437' and prosecdef and not has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE') as v from pg_proc where oid = 'public.jobs_converted_order_link_guard()'::regprocedure"),
      "088 job link guard body, internal").toBe(true);
  }
}

const IS_089 = (file: string) => file.endsWith("_invoice_receipt_guard.sql");

/**
 * What 089 changes: one trigger function (internal, definer) and its BEFORE INSERT OR UPDATE OF status and the five receipt columns
 * trigger on invoices. After a failed run neither exists. No data, policy, grant or existing function changes.
 */
async function expect089(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  expect(await q("select to_regprocedure('public.invoice_receipts_guard()') is not null as v"), `089 guard present = ${present}`).toBe(present);
  expect(await q("select count(*) = 1 as v from pg_trigger where tgname = 'zz_invoice_receipts' and tgrelid = 'public.invoices'::regclass"),
    `089 trigger present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select md5(regexp_replace(prosrc, '\\s', '', 'g')) = '18851e08d5d58c3bb648bb13e0fe0e22' and prosecdef and not has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE') as v from pg_proc where oid = 'public.invoice_receipts_guard()'::regprocedure"),
      "089 guard body, internal").toBe(true);
  }
}

const IS_090 = (file: string) => file.endsWith("_attendance_expected_company.sql");

/**
 * What 090 changes: one new function, record_attendance_event_in_company (definer, signed-in only), beside 050's record_attendance_event,
 * which is unchanged. After a failed run it does not exist.
 */
async function expect090(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  expect(await q("select to_regprocedure('public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)') is not null as v"), `090 function present = ${present}`).toBe(present);
  expect(await q("select has_function_privilege('authenticated', 'public.record_attendance_event(uuid,text,timestamp with time zone,text)'::regprocedure, 'EXECUTE') as v"), "050's clock function kept").toBe(true);
  if (present) {
    expect(await q("select md5(regexp_replace(prosrc, '\\s', '', 'g')) = 'b27723bfaaf334678d8d23bb1c1f0756' and prosecdef and has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE') as v from pg_proc where oid = 'public.record_attendance_event_in_company(uuid,text,timestamp with time zone,text,uuid)'::regprocedure"),
      "090 function body, signed-in only").toBe(true);
  }
}

const IS_091 = (file: string) => file.endsWith("_invoice_issue_guard.sql");

/**
 * What 091 changes: one trigger function (internal, invoker) and its BEFORE UPDATE OF status, invoice_ref, issued_at, issued_by trigger on
 * invoices, and issue_invoice's body (034's plus the quoteflow.invoice_issue setting). After a failed run neither the function nor the
 * trigger exists and issue_invoice is 034's. No data, policy, grant or column changes.
 */
async function expect091(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  expect(await q("select to_regprocedure('public.invoice_issue_guard()') is not null as v"), `091 guard present = ${present}`).toBe(present);
  expect(await q("select count(*) = 1 as v from pg_trigger where tgname = 'zz_invoice_via_issue' and tgrelid = 'public.invoices'::regclass"),
    `091 trigger present = ${present}`).toBe(present);
  expect(await q(`select md5(regexp_replace(prosrc, '\\s', '', 'g')) = '${present ? "ee9b9005e060379ce9dcc8e45a7afd42" : "54622e5030816649217b963fb7ab5419"}' and not prosecdef as v from pg_proc where oid = 'public.issue_invoice(uuid)'::regprocedure`),
    `091 issue_invoice is ${present ? "091's" : "034's"}`).toBe(true);
  if (present) {
    expect(await q("select md5(regexp_replace(prosrc, '\\s', '', 'g')) = 'a601d6b3464100729d4c9b5055d6633e' and not prosecdef and not has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE') as v from pg_proc where oid = 'public.invoice_issue_guard()'::regprocedure"),
      "091 guard body, internal").toBe(true);
  }
}

const IS_092 = (file: string) => file.endsWith("_release_ends_session.sql");

/**
 * What 092 changes: three bodies (labour_close and machine_runs_labour, 051's plus an admin release ending labour with its reason;
 * release_machine, 044's plus the quoteflow.release_reason setting), operator_sessions.end_reason with its check, and 'admin_released'
 * in the end_source check. After a failed run all three bodies are the earlier ones and neither the column nor 092's checks exist.
 */
async function expect092(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  for (const [fn, before, after] of [
    ["public.labour_close(uuid, uuid, timestamptz, text, uuid)", "77bb57169c5235f1bbd7cc5823ead5b7", "05c6a7a7b87e77ff928a235bec2a4635"],
    ["public.machine_runs_labour()", "afb1ff078a608e7748c6f75f369e2249", "48f0b169d1beb1de9976f542ac182b3e"],
    ["public.release_machine(uuid, text)", "85a72dc839da55046880163014e87800", "f3d62432af1642a30ff8045c543f8d3d"],
  ]) {
    expect((await db.query<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = $1::regprocedure", [fn])).rows[0]?.v,
      `092 ${fn} is ${present ? "092's" : "the body before 092"}`).toBe(present ? after : before);
  }
  expect(await q("select count(*) = 1 as v from information_schema.columns where table_schema = 'public' and table_name = 'operator_sessions' and column_name = 'end_reason'"),
    `092 end_reason column present = ${present}`).toBe(present);
  expect(await q("select count(*) = 1 as v from pg_constraint where conrelid = 'public.operator_sessions'::regclass and conname = 'operator_sessions_end_reason'"),
    `092 end_reason check present = ${present}`).toBe(present);
  expect(await q("select pg_get_constraintdef(oid) like '%admin_released%' as v from pg_constraint where conrelid = 'public.operator_sessions'::regclass and conname = 'operator_sessions_end_source_check'"),
    `092 end_source allows admin_released = ${present}`).toBe(present);
  expect(await q("select count(*) = 1 as v from pg_trigger where tgname = 'zz_machine_runs_labour' and tgrelid = 'public.machine_runs'::regclass and tgfoid = 'public.machine_runs_labour()'::regprocedure"),
    "092 051's labour trigger on machine_runs").toBe(true);
}

const IS_093 = (file: string) => file.endsWith("_protect_platform_owner_login.sql");

/**
 * What 093 changes: admin_set_company_access and set_member_access (066's bodies plus the protected_login refusal; compared without
 * whitespace) and the new admin_login_is_protected (definer, signed-in only). After a failed run both bodies are 066's and the function
 * does not exist.
 */
async function expect093(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  expect((await db.query<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = 'public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)'::regprocedure")).rows[0]?.v,
    `093 admin_set_company_access is ${present ? "093's" : "066's"}`).toBe(present ? "378818d240f26ff55595ff4168f7a40e" : "a7f5c794e51fe1dc3c98bace9a5dd11d");
  expect((await db.query<{ v: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = 'public.set_member_access(uuid, text, boolean, text, boolean, text[])'::regprocedure")).rows[0]?.v,
    `093 set_member_access is ${present ? "093's" : "066's"}`).toBe(present ? "2fc2a6a96b80cc9f7a7f8baf9b67df04" : "e0031dfa2d9c89955a26119d3b65b307");
  expect(await q("select to_regprocedure('public.admin_login_is_protected(uuid)') is not null as v"), `093 admin_login_is_protected present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select md5(regexp_replace(prosrc, '\\s', '', 'g')) = 'a938b2269bd2554f36acf0beaf7bb8f3' and prosecdef and has_function_privilege('authenticated', oid, 'EXECUTE') and not has_function_privilege('anon', oid, 'EXECUTE') as v from pg_proc where oid = 'public.admin_login_is_protected(uuid)'::regprocedure"),
      "093 admin_login_is_protected body, definer, signed-in only").toBe(true);
  }
}

/**
 * What 078 changes, part A (clock-in addresses; torn down and re-applied with the time files): attendance_event_network_ips (RLS on, read
 * only, NOT audited), the purge (admin RPC signed-in only, retention and purge helpers internal), 075's check trigger writing the address
 * there, and attendance_event_networks' ip CHECK (ip IS NULL). After a failed run none of it exists, the trigger function and the CHECK are
 * 075's.
 */
async function expect078Time(db: Client, present: boolean) {
  const q = async (text: string, params: unknown[] = []) => (await db.query<{ v: boolean }>(text, params)).rows[0].v;
  expect(await q("select to_regclass('public.attendance_event_network_ips') is not null as v"), `078 table present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select relrowsecurity as v from pg_class where oid = 'public.attendance_event_network_ips'::regclass")).toBe(true);
    expect(await q("select not (has_table_privilege('authenticated', 'public.attendance_event_network_ips', 'INSERT') or has_table_privilege('authenticated', 'public.attendance_event_network_ips', 'UPDATE') or has_table_privilege('authenticated', 'public.attendance_event_network_ips', 'DELETE')) as v")).toBe(true);
    expect(await q("select not exists (select 1 from pg_trigger where tgrelid = 'public.attendance_event_network_ips'::regclass and tgname like 'audit_%') as v"), "078 addresses not audited").toBe(true);
  }
  expect(await q("select to_regprocedure('public.purge_site_network_ips(boolean)') is not null as v"), `078 purge present = ${present}`).toBe(present);
  if (present) expect(await q("select has_function_privilege('authenticated', 'public.purge_site_network_ips(boolean)'::regprocedure, 'EXECUTE') and not has_function_privilege('anon', 'public.purge_site_network_ips(boolean)'::regprocedure, 'EXECUTE') as v")).toBe(true);
  for (const f of ["site_network_ip_retention()", "site_network_ip_purge(uuid,integer)"]) {
    expect(await q("select to_regprocedure($1) is not null as v", [`public.${f}`]), `078 ${f} present = ${present}`).toBe(present);
    if (present) expect(await q("select not (has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') or has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE')) as v", [`public.${f}`]), `078 ${f} internal`).toBe(true);
  }
  if (await q("select to_regprocedure('public.attendance_events_network()') is not null as v")) {
    expect(await q("select prosrc like '%attendance_event_network_ips%' as v from pg_proc where oid = 'public.attendance_events_network()'::regprocedure"), `078 check trigger keeps the address apart = ${present}`).toBe(present);
    expect(await q("select pg_get_constraintdef(oid) = $1 as v from pg_constraint where conrelid = 'public.attendance_event_networks'::regclass and conname = 'attendance_event_networks_ip'",
      [present ? "CHECK ((ip IS NULL))" : "CHECK (((ip IS NOT NULL) = (status = ANY (ARRAY['on_site'::text, 'off_site'::text]))))"]), `078 ip CHECK = ${present}`).toBe(true);
  }
}

/**
 * Everything 078 changes: part A (above) and part B (CRD credit note numbers): next_doc_number accepts 'CRD', issue_credit_note takes it,
 * seed_credit_note_number owner only. After a failed run: 058's next_doc_number, 034's issue_credit_note, no seed function.
 */
async function expect078(db: Client, present: boolean) {
  const q = async (text: string) => (await db.query<{ v: boolean }>(text)).rows[0].v;
  await expect078Time(db, present);
  expect(await q("select prosrc like '%''CRD''%' as v from pg_proc where oid = 'public.next_doc_number(text)'::regprocedure"), `078 next_doc_number CRD = ${present}`).toBe(present);
  expect(await q("select prosrc like '%next_doc_number(''CRD'')%' as v from pg_proc where oid = 'public.issue_credit_note(uuid)'::regprocedure"), `078 issue_credit_note CRD = ${present}`).toBe(present);
  expect(await q("select prosrc like '%next_doc_number(''CN'')%' as v from pg_proc where oid = 'public.issue_credit_note(uuid)'::regprocedure"), `078 issue_credit_note CN = ${!present}`).toBe(!present);
  expect(await q("select to_regprocedure('public.seed_credit_note_number(uuid,text)') is not null as v"), `078 seed present = ${present}`).toBe(present);
  if (present) {
    expect(await q("select not (has_function_privilege('anon', 'public.seed_credit_note_number(uuid,text)'::regprocedure, 'EXECUTE') or has_function_privilege('authenticated', 'public.seed_credit_note_number(uuid,text)'::regprocedure, 'EXECUTE') or has_function_privilege('service_role', 'public.seed_credit_note_number(uuid,text)'::regprocedure, 'EXECUTE')) as v"), "078 seed owner only").toBe(true);
  }
}

async function releasePreflight() {
  const rows = await withDb(async (db) => (await db.query<{ check: string; value: string }>(sql(path.join(ROOT, "supabase/verify/release_preflight.sql")))).rows);
  const markers = rows.filter((r) => r.check.startsWith("marker "));
  return { markers: markers.map((r) => r.value), numbers: markers.map((r) => r.check.slice("marker ".length, "marker ".length + 3)), hooks: rows.find((r) => r.check === "existing PostgREST request hooks")?.value };
}

const verifyRows = (name: string) => withDb(async (db) => (await db.query(sql(path.join(ROOT, "supabase/verify", `${name}.sql`)))).rows.length);

describe.runIf(/^\d{3}$/.test(BASE))(`upgrade from ${BASE} with existing data`, () => {
  beforeAll(async () => {
    const identity = await verifyBackendIdentity();
    expect(identity.migrations.at(-1), "the database must have been rebuilt at REHEARSAL_BASE first").toBe(BASE);
    world = await createSyntheticWorld();
    // Data written the way production got it: the legacy import (quotes, invoices, orders, jobs with values,
    // delivery notes, e-mail history, audit archive) ...
    await withDb(async (db) => {
      await db.query(sql(path.join(ROOT, "supabase/import/import_legacy_tenant.sql")));
      const report = (await db.query("select public.import_legacy_tenant($1::jsonb, $2::uuid) as r", [JSON.stringify(buildLegacyExport(world)), world.tenants.alpha.id])).rows[0].r;
      expect(report.ok).toBe(true);
    });
    // ... plus states the new rules care about: a sent and a draft quote, a job whose two dates differ.
    const admin = adminClient();
    const org = world.tenants.alpha.id;
    expect((await admin.from("quotes").insert([
      { organization_id: org, quote_ref: `QUO-R1-${world.runId}`, customer: "Rehearsal Co", total_value: 120, status: "sent" },
      { organization_id: org, quote_ref: `QUO-R2-${world.runId}`, customer: "Rehearsal Co", total_value: 60, status: "draft" },
    ])).error).toBeNull();
    expect((await admin.from("jobs").insert({ organization_id: org, job_no: `J-R1-${world.runId}`, customer: "Rehearsal Co", due_date: "2026-01-10", date_required: "2026-01-12" })).error).toBeNull();
    for (const name of VERIFY) preflight[name] = await verifyRows(name);
    // The read-only release preflight sees the pre-release state: every migration up to BASE applied, nothing later; no request hook
    // before 017 (a base at 017 or later already has 017's own).
    const state = await releasePreflight();
    expect(state.markers).toEqual(state.numbers.map((num) => (num <= BASE ? "applied" : "not applied")));
    expect(state.markers[0]).toBe("applied");
    expect(state.hooks).toBe(BASE < "017" ? "none" : "role authenticator: public.check_request_session");
  });

  afterAll(async () => {
    if (world) await destroySyntheticWorld(world.runId);
  });

  /** The stored definition of each of the eight functions that exist at this point (a base after 031/032 has them all; an older one has fewer). */
  const definitions = (db: Client) => Promise.all(CRLF_FUNCTIONS.map(async (fn) => {
    const row = (await db.query<{ d: string | null }>("select pg_get_functiondef(to_regprocedure($1)) as d", [`public.${fn}`])).rows[0];
    return { fn, name: fn.split("(")[0], def: row.d };
  }));

  /** Applies 034 (when this branch has it) and checks what it did to the eight functions: the three payment functions it replaces are its own LF text, the five mail functions keep the CRLF bodies 033 injected into; all carry the check. */
  async function apply034AndCheck(db: Client, text?: string) {
    await applyRelease(db, F034!, text);
    const source = sql(path.join(MIGRATIONS, F034!));
    for (const { fn, name, def } of await definitions(db)) {
      if (!def) continue;
      expect(def, `${fn}: still starts with the second-step check after ${F034}`).toMatch(/\nBEGIN\r?\n  PERFORM public\.assert_privileged_aal\(\);\r?\n/);
      const replaced = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`).test(source);
      expect(def.includes("\r\n"), `${fn}: ${replaced ? `replaced by ${F034}, so no CRLF is left` : `untouched by ${F034}, so its CRLF body stays`}`).toBe(!replaced);
    }
  }

  // The newest file is not applied by the first test: the failure test below breaks it, rolls back and applies it cleanly.
  const newest = later.at(-1)!;

  it(`applies ${later.length - 1} of the ${later.length} later migrations as the postgres role, each as its release text; the CRLF bodies of 031/032 are in place before 033, which then injects the second step into them (034 and later files follow, each checked where it is applied)`, async () => {
    // From 013 (CI) many files follow; from 046 (the target projects for 049, R3.5) only 049, which the failure test below applies.
    expect(later.length).toBeGreaterThanOrEqual(1);
    await withDb(async (db) => {
      expect((await db.query("select current_user as u")).rows[0].u).toBe("postgres");
      // 1. Everything before 033 (013 to 032)...
      for (const file of BEFORE_033) await applyRelease(db, file);
      // 2. ... then production's state: the eight functions of 031/032 stored with CRLF line endings, as the SQL editor kept them. This is done
      // immediately before 033, because 033 is the file that rewrites those bodies.
      // (A base at 033 or later already has 033's injected bodies: production's CRLF state is part of that base, nothing to convert.)
      for (const fn of F033 ? CRLF_FUNCTIONS : []) {
        const oid = (await db.query<{ oid: string | null }>("select to_regprocedure($1)::oid::text as oid", [`public.${fn}`])).rows[0].oid;
        if (!oid) continue; // this base already predates the function; nothing to convert
        const def = (await db.query<{ d: string }>("select pg_get_functiondef($1::oid) as d", [oid])).rows[0].d;
        await db.query(def.replace(/\r?\n/g, "\r\n"));
        const stored = (await db.query<{ d: string }>("select pg_get_functiondef($1::oid) as d", [oid])).rows[0].d;
        expect(stored, `${fn} should be stored with CRLF`).toContain("\nBEGIN\r\n");
        expect(stored, `${fn} has no second-step check before 033`).not.toContain("assert_privileged_aal");
      }
      // 3. 033 applies over the CRLF bodies; checked straight away, before any later file can touch them: each keeps its own line ending and
      // gains the check as its first statement, exactly once.
      if (F033 && F033 !== newest) {
        await applyRelease(db, F033);
        await check033(db);
      }
      // 4. 034, when this branch has it and it is not the newest file (then the failure test below applies it, with the same checks).
      if (F034 && F034 !== newest) await apply034AndCheck(db);
      // 5. The remaining migrations in order, except the newest file.
      for (const file of AFTER_034) if (file !== newest) await applyRelease(db, file);
      // 6. When the newest file is 044: awkward existing data it must apply over (see seed044); 046: machine runs it must leave alone.
      if (IS_044(newest)) await seed044(db);
      if (IS_046(newest)) await seed046(db);
      if (IS_049(newest)) await seed049(db);
    });
  });

  /**
   * Awkward pre-044 data: two bookings 'running' on the SAME machine (for two different jobs) and a booking with no job link. 044 adds a new
   * table and backfills nothing, so it must apply cleanly and leave every one of these rows exactly as it was (and make no run from them).
   */
  let seeded044: { digest: string; bookings: number; running: number; unlinked: number; jobs: number } | undefined;
  const bookingsDigest = (db: Client) => db.query<{ digest: string; bookings: string; running: string; unlinked: string; jobs: string }>(
    `select (select md5(coalesce(string_agg(b::text, '|' order by b.id), '')) from public.machine_bookings b) as digest,
            (select count(*) from public.machine_bookings) as bookings,
            (select count(*) from public.machine_bookings where status = 'running') as running,
            (select count(*) from public.machine_bookings where job_id is null) as unlinked,
            (select count(*) from public.jobs) as jobs`).then((r) => ({ digest: r.rows[0].digest, bookings: Number(r.rows[0].bookings), running: Number(r.rows[0].running), unlinked: Number(r.rows[0].unlinked), jobs: Number(r.rows[0].jobs) }));
  async function seed044(db: Client) {
    const org = world.tenants.alpha.id;
    const machine = (await db.query<{ id: string }>("insert into public.machines (organization_id, name, active) values ($1, $2, true) returning id", [org, `Rehearsal Mill ${world.runId}`])).rows[0].id;
    const jobs = (await db.query<{ id: string; job_no: string }>("select id, job_no from public.jobs where organization_id = $1 order by job_no limit 2", [org])).rows;
    expect(jobs.length).toBe(2);
    await db.query(
      `insert into public.machine_bookings (organization_id, machine_id, job_id, job_no, description, start_at, estimated_hours, hours_done, status) values
         ($1, $2, $3, $4, 'running one', '2026-09-01T08:00:00Z', 4, 1, 'running'),
         ($1, $2, $5, $6, 'running two (same machine)', '2026-09-01T09:00:00Z', 3, 0.5, 'running'),
         ($1, $2, null, null, 'no job link', '2026-09-02T08:00:00Z', 2, 0, 'booked')`,
      [org, machine, jobs[0].id, jobs[0].job_no, jobs[1].id, jobs[1].job_no]);
    seeded044 = await bookingsDigest(db);
    expect(seeded044.running).toBeGreaterThanOrEqual(2);
    expect(seeded044.unlinked).toBeGreaterThanOrEqual(1);
    expect((await db.query("select to_regclass('public.machine_runs') as t")).rows[0].t, "machine_runs does not exist before 044").toBeNull();
  }
  /** After 044: the same bookings and jobs, byte for byte, and no run invented from the two 'running' bookings. */
  async function expectSeed044Untouched(db: Client) {
    if (!seeded044) return;
    expect(await bookingsDigest(db), "044 left the bookings and jobs exactly as seeded").toEqual(seeded044);
    expect(Number((await db.query("select count(*) as c from public.machine_runs")).rows[0].c), "no backfill: no run from a 'running' booking").toBe(0);
  }

  /**
   * Signatures recorded on 045 (a primary and an inspector co-signature through sign_off_job, as two people), so re-running 045 is shown
   * to leave every existing signature exactly as it was: same rows, same hashes.
   */
  let seeded045: { rows: number; digest: string } | undefined;
  const signoffDigest = (db: Client) => db.query<{ rows: string; digest: string }>(
    "select count(*) as rows, md5(coalesce(string_agg(id::text || ':' || kind || ':' || worksheet_version || ':' || snapshot_sha256 || ':' || record_sha256 || ':' || signature_data, '|' order by id), '')) as digest from public.job_signoffs")
    .then((r) => ({ rows: Number(r.rows[0].rows), digest: r.rows[0].digest }));
  async function seed045(db: Client) {
    const org = world.tenants.alpha.id;
    await db.query("update public.organization_members set can_inspect = true where organization_id = $1 and user_id = $2", [org, world.tenants.alpha.users.office.id]);
    const job = (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer, started_at, finished_at) values ($1, $2, 'Rehearsal Co', '2026-10-01T08:00:00Z', '2026-10-02T08:00:00Z') returning id", [org, `J-R045-${world.runId}`])).rows[0].id;
    const rev = (await db.query<{ v: number; sha: string }>("select j.worksheet_version as v, encode(extensions.digest(convert_to(public.canonical_jsonb(public.job_signoff_snapshot(j)), 'UTF8'), 'sha256'), 'hex') as sha from public.jobs j where j.id = $1", [job])).rows[0];
    for (const [who, kind, name] of [["workshop", "primary", "Will Barnes"], ["office", "inspector", "Olive Inspector"]] as const) {
      const client = await signedInClient(world.tenants.alpha.users[who]);
      const token = (await client.auth.getSession()).data.session!.access_token;
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub: string; session_id: string; aal?: string };
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.sub, role: "authenticated", aud: "authenticated", session_id: claims.session_id, aal: claims.aal ?? "aal1" })]);
        await db.query("select public.sign_off_job($1, $2, $3, 'WB', $4, '2026-10-12', 'typed', $4, $5, gen_random_uuid())", [job, rev.v, rev.sha, name, kind]);
        await db.query("commit");
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    }
    seeded045 = await signoffDigest(db);
    expect(seeded045.rows).toBeGreaterThanOrEqual(2);
  }
  /** After re-running 045: the same signatures, byte for byte (count and hashes). */
  async function expectSeed045Untouched(db: Client) {
    expect(seeded045, "signatures were recorded after 045 applied").toBeDefined();
    expect(await signoffDigest(db), "re-running 045 left every existing signature as it was").toEqual(seeded045);
  }

  /**
   * Machine runs recorded before 046 (a closed and an open run on one machine, through the 044 functions as a workshop user), so 046 is
   * shown to apply over them, leave every row exactly as it was (failed, clean and second run), and invent no bench run.
   */
  let seeded046: { rows: number; digest: string } | undefined;
  const runsDigest = (db: Client) => db.query<{ rows: string; digest: string }>(
    "select count(*) as rows, md5(coalesce(string_agg(r::text, '|' order by r.id), '')) as digest from public.machine_runs r")
    .then((r) => ({ rows: Number(r.rows[0].rows), digest: r.rows[0].digest }));
  async function seed046(db: Client) {
    const org = world.tenants.alpha.id;
    const machine = (await db.query<{ id: string }>("insert into public.machines (organization_id, name, active) values ($1, $2, true) returning id", [org, `Rehearsal 046 Mill ${world.runId}`])).rows[0].id;
    const jobs = (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Rehearsal Co'), ($1, $3, 'Rehearsal Co') returning id", [org, `J-R046A-${world.runId}`, `J-R046B-${world.runId}`])).rows;
    // Through 044's functions as the workshop user (their session's claims, as seed045), in SQL: the API's schema cache is not reloaded yet.
    const client = await signedInClient(world.tenants.alpha.users.workshop);
    const token = (await client.auth.getSession()).data.session!.access_token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub: string; session_id: string; aal?: string };
    for (const [job, pause] of [[jobs[0].id, true], [jobs[1].id, false]] as const) {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.sub, role: "authenticated", aud: "authenticated", session_id: claims.session_id, aal: claims.aal ?? "aal1" })]);
        await db.query("select public.start_machine_run($1, array[$2]::uuid[], null, now() - interval '2 hours', false, null)", [job, machine]);
        if (pause) await db.query("select public.pause_machine_run($1, null, null, now() - interval '1 hour')", [job]);
        await db.query("commit");
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    }
    seeded046 = await runsDigest(db);
    expect(seeded046.rows).toBeGreaterThanOrEqual(2);
    expect(Number((await db.query("select count(*) as c from public.machine_runs where machine_id is null")).rows[0].c)).toBe(0);
  }
  /** After 046 (failed, clean or re-run): the same runs, byte for byte, and no bench run invented. */
  async function expectSeed046Untouched(db: Client) {
    expect(seeded046, "machine runs were recorded before 046").toBeDefined();
    expect(await runsDigest(db), "046 left the existing machine runs exactly as they were").toEqual(seeded046);
  }

  // ----- 049 (plan R3.5): the paused-machine acknowledgement, the explicit bench Start, request-bound replays ----------------------
  /**
   * Data written through 046's functions before 049 (as the workshop user, in SQL as seed046): job A started on M1 and paused (M1 now has a
   * current paused run), job B bulk-started (a start time, no runs: "Started, not timed"), job C on the bench and paused, job D not
   * started; machine_run_ops keys K1 (A's start) and K2 (A's pause). The digest lists its columns, so 049's new column doesn't change it.
   */
  let seeded049: { digest: string; runs: number; ops: number; jobs: string[] } | undefined;
  let s049: { org: string; m1: string; a: string; b: string; c: string; d: string; k1: string; k2: string; startedA: string; pausedA: string; runA: string } | undefined;
  const claimsOf = async (who: "workshop" | "office") => {
    const client = await signedInClient(world.tenants.alpha.users[who]);
    const token = (await client.auth.getSession()).data.session!.access_token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub: string; session_id: string; aal?: string };
    return JSON.stringify({ sub: claims.sub, role: "authenticated", aud: "authenticated", session_id: claims.session_id, aal: claims.aal ?? "aal1" });
  };
  /** Runs `work` as `who` (their session's claims) inside a transaction that is always rolled back (or committed when `keep`). */
  async function asUser<T>(db: Client, who: "workshop" | "office", work: () => Promise<T>, keep = false): Promise<T> {
    const claims = await claimsOf(who);
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      const out = await work();
      await db.query(keep ? "commit" : "rollback");
      return out;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  }
  const digest049 = (db: Client, jobs: string[]) => db.query<{ digest: string; runs: string; ops: string }>(
    `select (select md5(coalesce(string_agg(concat_ws(':', r.id, r.organization_id, r.job_id, r.machine_id, r.booking_id, r.operator_id, r.started_at, r.ended_at, r.end_reason,
                                                     r.ended_by, r.override_of, r.client_op_id, r.ended_op_id, r.device_started_at, r.device_ended_at, r.created_by, r.created_at), '|' order by r.id), ''))
               from public.machine_runs r where r.job_id = any($1::uuid[]))
         || (select md5(coalesce(string_agg(concat_ws(':', o.organization_id, o.client_op_id, o.kind, o.job_id, o.result::text, o.created_by, o.created_at), '|' order by o.client_op_id), ''))
               from public.machine_run_ops o where o.job_id = any($1::uuid[]))
         || (select md5(coalesce(string_agg(concat_ws(':', j.id, j.started_at, j.finished_at), '|' order by j.id), '')) from public.jobs j where j.id = any($1::uuid[])) as digest,
            (select count(*) from public.machine_runs where job_id = any($1::uuid[])) as runs,
            (select count(*) from public.machine_run_ops where job_id = any($1::uuid[])) as ops`, [jobs])
    .then((r) => ({ digest: r.rows[0].digest, runs: Number(r.rows[0].runs), ops: Number(r.rows[0].ops), jobs }));
  async function seed049(db: Client) {
    const org = world.tenants.alpha.id;
    const m1 = (await db.query<{ id: string }>("insert into public.machines (organization_id, name, active) values ($1, $2, true) returning id", [org, `Rehearsal 049 Mill ${world.runId}`])).rows[0].id;
    const ids = (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Rehearsal Co'), ($1, $3, 'Rehearsal Co'), ($1, $4, 'Rehearsal Co'), ($1, $5, 'Rehearsal Co') returning id",
      [org, `J-R049A-${world.runId}`, `J-R049B-${world.runId}`, `J-R049C-${world.runId}`, `J-R049D-${world.runId}`])).rows.map((r) => r.id);
    const [a, b, c, d] = ids;
    const [k1, k2] = [randomUUID(), randomUUID()];
    const startedA = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const pausedA = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await asUser(db, "workshop", async () => {
      await db.query("select public.start_machine_run($1, array[$2]::uuid[], $3, $4, false, null)", [a, m1, k1, startedA]);
      await db.query("select public.pause_machine_run($1, null, $2, $3)", [a, k2, pausedA]);
      await db.query("select public.start_machine_run($1, array[]::uuid[], null, now() - interval '90 minutes', false, null)", [c]);
      await db.query("select public.pause_machine_run($1, null, null, now() - interval '80 minutes')", [c]);
    }, true);
    await db.query("update public.jobs set started_at = now() - interval '1 hour' where id = $1", [b]); // the bulk Start: no run
    const runA = (await db.query<{ id: string }>("select id from public.machine_runs where job_id = $1", [a])).rows[0].id;
    s049 = { org, m1, a, b, c, d, k1, k2, startedA, pausedA, runA };
    seeded049 = await digest049(db, ids);
    expect(seeded049).toMatchObject({ runs: 2, ops: 2 });
    expect(Number((await db.query("select count(*) as c from public.machine_runs where job_id = $1 and machine_id is null and end_reason = 'paused'", [c])).rows[0].c)).toBe(1);
  }
  async function expectSeed049Untouched(db: Client) {
    expect(seeded049, "data was written through 046 before 049").toBeDefined();
    expect(await digest049(db, seeded049!.jobs), "049 left the existing runs, keys and jobs exactly as they were").toEqual(seeded049);
  }
  const START6 = "public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)";
  const START8 = "public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)";
  let start046Md5: string | undefined;
  /** Every kind of thing 049 adds or replaces: present after a clean run, none of it (and 046's start_machine_run, text and grants) after a failed one. */
  async function expect049(db: Client, present: boolean) {
    const q = async (text: string, params: unknown[] = []) => (await db.query<{ v: boolean }>(text, params)).rows[0].v;
    expect(await q("select to_regprocedure($1) is not null as v", [START6]), "046's 6-argument start_machine_run").toBe(!present);
    expect(await q("select to_regprocedure($1) is not null as v", [START8]), "049's 8-argument start_machine_run").toBe(present);
    expect(await q("select count(*) = 1 as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'start_machine_run'"), "one signature").toBe(true);
    const sig = present ? START8 : START6;
    expect(await q("select has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') as v", [sig])).toBe(true);
    expect(await q("select has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') as v", [sig])).toBe(false);
    expect(await q("select not exists (select 1 from aclexplode((select proacl from pg_proc where oid = to_regprocedure($1))) a where a.grantee = 0) as v", [sig]), "no PUBLIC grant").toBe(true);
    if (!present) {
      expect(start046Md5, "046's text was recorded before the attempt").toBeDefined();
      expect((await db.query<{ m: string }>("select md5(pg_get_functiondef(to_regprocedure($1))) as m", [START6])).rows[0].m, "046's start_machine_run, byte for byte").toBe(start046Md5);
    }
    const checks: [string, string][] = [
      ["paused_machines", "select to_regprocedure('public.paused_machines()') is not null as v"],
      ["acknowledge_paused_machine", "select to_regprocedure('public.acknowledge_paused_machine(uuid,uuid,uuid,uuid)') is not null as v"],
      ["paused_machine_current", "select to_regprocedure('public.paused_machine_current(uuid,uuid,uuid)') is not null as v"],
      ["machine_run_request_sha256", "select exists (select 1 from pg_proc where proname = 'machine_run_request_sha256') as v"],
      ["paused_ack_ops", "select to_regclass('public.paused_ack_ops') is not null as v"],
      ["machine_run_ops.request_sha256", "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'machine_run_ops' and column_name = 'request_sha256') as v"],
    ];
    for (const [name, text] of checks) expect(await q(text), `${name} present = ${present}`).toBe(present);
  }
  /** As the workshop user, inside a rolled-back transaction: 046's behaviour is back after a failed 049. */
  async function expectBehaviour046(db: Client) {
    const s = s049!;
    await asUser(db, "workshop", async () => {
      const b = (await db.query("select public.start_machine_run($1, '{}'::uuid[], $2, now(), false, null) as r", [s.b, randomUUID()])).rows[0].r;
      expect(b).toMatchObject({ bench_skipped: "started_without_bench", bench_run: null });
      const d = (await db.query("select public.start_machine_run($1, array[$2]::uuid[], $3, now(), false, null) as r", [s.d, s.m1, randomUUID()])).rows[0].r;
      expect(d.runs).toHaveLength(1);
      expect(Object.keys(d)).not.toContain("paused_warnings");
      await db.query("savepoint bench");
      const refused = await db.query("select public.start_machine_run(p_job => $1, p_machines => '{}'::uuid[], p_client_op_id => null, p_started_at => now(), p_override => false, p_reason => null, p_bench => true)", [s.b])
        .then(() => null, (err: { code?: string }) => err.code);
      expect(refused, "a call with p_bench does not exist before 049").toBe("42883");
      await db.query("rollback to savepoint bench");
      const k1 = (await db.query("select public.start_machine_run($1, array[$2]::uuid[], $3, $4, false, null) as r", [s.a, s.m1, s.k1, s.startedA])).rows[0].r;
      expect(k1.replayed).toBe(true);
      await db.query("reset role"); // the audit trail, read as the owner
      expect(Number((await db.query("select count(*) as c from security_audit.audit_log where action = 'START_OVER_PAUSED_JOB' and entity_id = $1", [s.d])).rows[0].c)).toBe(0);
    });
  }
  /** After the clean apply, inside rolled-back transactions: 046's answers for old calls, the bench flag, the warning, the bound replay. */
  async function expectBehaviour049(db: Client) {
    const s = s049!;
    await asUser(db, "workshop", async () => {
      const b = (await db.query("select public.start_machine_run($1, '{}'::uuid[], $2, now(), false, null) as r", [s.b, randomUUID()])).rows[0].r;
      expect(b).toMatchObject({ bench_skipped: "started_without_bench", bench_run: null });
      const bench = (await db.query("select public.start_machine_run(p_job => $1, p_machines => '{}'::uuid[], p_client_op_id => $2, p_started_at => now(), p_override => false, p_reason => null, p_bench => true) as r", [s.b, randomUUID()])).rows[0].r;
      expect(bench.bench_run).toMatchObject({ already: false });
      const d = (await db.query("select public.start_machine_run($1, array[$2]::uuid[], $3, now(), false, null) as r", [s.d, s.m1, randomUUID()])).rows[0].r;
      expect(d.paused_warnings).toEqual([expect.objectContaining({ machine_id: s.m1, paused_run_id: s.runA })]);
      const k1 = (await db.query("select public.start_machine_run($1, array[$2]::uuid[], $3, $4, false, null) as r", [s.a, s.m1, s.k1, s.startedA])).rows[0].r;
      expect(k1.replayed, "K1 (a row without a hash) still replays for its own person").toBe(true);
      // The audit trail is not readable by the API role: read it as the owner, still inside this (rolled-back) transaction.
      await db.query("reset role");
      const events = (await db.query("select metadata from security_audit.audit_log where action = 'START_OVER_PAUSED_JOB' and entity_id = $1", [s.d])).rows;
      expect(events).toEqual([{ metadata: expect.objectContaining({ paused_run_id: s.runA, acknowledged: false }) }]);
    });
    await asUser(db, "office", async () => {
      const refused = await db.query("select public.start_machine_run($1, array[$2]::uuid[], $3, $4, false, null)", [s.a, s.m1, s.k1, s.startedA]).then(() => null, (err: { code?: string; hint?: string }) => [err.code, err.hint]);
      expect(refused, "K1 replayed by another person").toEqual(["22023", "client_op_reused"]);
    });
  }

  // ----- 049 D2 (plan R3.6): the new build's queue against a database still at 046 ----------------------------------------------
  const scope049 = { userId: "rehearsal-workshop", orgId: "rehearsal-alpha" };
  let d2: { jobX: string; jobY: string; start: RunStartOp; pause: RunPauseOp; startAt: string; pauseAt: string; runsBefore: number } | undefined;
  /** Waits until PostgREST's schema cache has `fn` (after a reload notice). */
  async function waitForApi(ok: () => Promise<boolean>) {
    for (let i = 0; i < 40; i += 1) {
      if (await ok()) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("PostgREST did not pick up the schema in time");
  }
  /** The replay executor of the new build, for the two kinds this test queues (the worksheet goes straight to the jobs row). */
  const executor = (client: Awaited<ReturnType<typeof signedInClient>>) => async (op: OutboxOp): Promise<ReplayOutcome> => {
    if (op.kind === "run_start") return executeRunStartOp(op, client);
    if (op.kind === "run_pause") return executeRunPauseOp(op, client);
    if (op.kind === "worksheet") {
      const { data, error } = await client.from("jobs").update({ heat_cast_no: String(op.worksheet.heat_cast_no) }).eq("id", op.jobId).select("id");
      return error ? { status: "rejected", reason: error.message } : data?.length ? { status: "applied" } : { status: "rejected", reason: "not updated" };
    }
    return { status: "rejected", reason: "unexpected" };
  };

  async function check033(db: Client) {
    for (const { fn, def } of await definitions(db)) {
      if (!def) continue;
      expect(def, `${fn}: 033 injected the check into the CRLF body`).toMatch(/\nBEGIN\r\n  PERFORM public\.assert_privileged_aal\(\);\r\n/);
      expect(def.split("assert_privileged_aal").length - 1, `${fn}: the check is injected once`).toBe(1);
    }
  }

  it.runIf(IS_049(newest))("D2: the new build's queue meets a 046 database: an explicit bench Start is blocked (kept, unchanged), its Pause waits, another job's change applies", async () => {
    setOfflineBackend(memoryBackend());
    const workshop = await signedInClient(world.tenants.alpha.users.workshop);
    await withDb(async (db) => { await db.query("notify pgrst, 'reload schema'"); });
    await waitForApi(async () => !(await workshop.rpc("bench_runs_state")).error);
    const org = world.tenants.alpha.id;
    const [jobX, jobY] = await withDb(async (db) => (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Rehearsal Co'), ($1, $3, 'Rehearsal Co') returning id",
      [org, `J-R049X-${world.runId}`, `J-R049Y-${world.runId}`])).rows.map((r) => r.id));
    const startAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const pauseAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const start: RunStartOp = { kind: "run_start", v: 2, jobRef: jobX, jobNo: "J-R049X", at: startAt, clientOpId: randomUUID(), machines: [], bench: true, pausedAck: [] };
    // Online: the direct call is refused as "server too old"; the board shows the update message and queues nothing (nothing is sent without p_bench).
    const online = await workshop.rpc("start_machine_run", runStartArgs({ ...start, clientOpId: randomUUID() }));
    expect(isServerTooOld(online.error), `online bench Start on 046: ${online.error?.code}`).toBe(true);
    // Offline: the Start, then a Pause of it, then a worksheet change of another job.
    await enqueue(scope049, start);
    await enqueue(scope049, { kind: "run_pause", v: 2, jobRef: jobX, jobNo: "J-R049X", at: pauseAt, clientOpId: randomUUID(), machines: null, afterStart: null });
    await enqueue(scope049, { kind: "worksheet", jobId: jobY, jobNo: "J-R049Y", worksheet: { heat_cast_no: "HC-049" }, baseVersion: null });
    const queued = await pendingEntries(scope049);
    const pause = queued[1].op as RunPauseOp;
    expect(pause.afterStart, "the Pause belongs to the pending Start").toBe(start.clientOpId);
    const runsBefore = await withDb(async (db) => Number((await db.query("select count(*) as c from public.machine_runs where job_id = $1", [jobX])).rows[0].c));
    const result = await replayOutbox(scope049, executor(workshop));
    expect(result).toMatchObject({ applied: 1, blocked: 1, rejected: 0, conflicts: 0, remaining: 2 });
    const left = await pendingEntries(scope049);
    expect(left.map((e) => e.op.kind)).toEqual(["run_start", "run_pause"]);
    expect(left[0].op, "the blocked Start is kept byte for byte (bench: true)").toEqual(start);
    expect(left[0].blocked).toMatchObject({ code: "server_upgrade_needed" });
    expect(left[1].blocked, "the Pause was skipped, not sent").toBeUndefined();
    expect(await withDb(async (db) => Number((await db.query("select count(*) as c from public.machine_runs where job_id = $1", [jobX])).rows[0].c))).toBe(runsBefore);
    expect(await withDb(async (db) => (await db.query("select heat_cast_no from public.jobs where id = $1", [jobY])).rows[0].heat_cast_no)).toBe("HC-049");
    // The board's fold: Paused, waiting to sync, needs an update; never synced.
    const view = pendingRunView({ jobId: jobX, machines: [], bench: false }, left);
    expect(runViewLabel(view)).toBe("Paused, waiting to sync · needs an app/server update");
    d2 = { jobX, jobY, start, pause, startAt, pauseAt, runsBefore };
  });

  it("a failure midway through a migration leaves none of that file applied; earlier migrations stay", async () => {
    const last = newest;
    await withDb(async (db) => {
      const before = await catalogueRows(db);
      const structureBefore = await structure(db);
      const markersBefore = (await releasePreflight()).markers;
      const checked: { where: string; chosen: Candidate }[] = [];
      expect(markersBefore.slice(0, -1)).toEqual(markersBefore.slice(0, -1).map(() => "applied"));
      expect(markersBefore.at(-1)).toBe("not applied");
      if (IS_042(last)) await expect042(db, false);
      if (IS_043(last)) await expect043(db, false);
      if (IS_044(last)) await expect044(db, false);
      if (IS_045(last)) await expect045(db, false);
      if (IS_046(last)) await expect046(db, false);
      if (IS_049(last)) {
        start046Md5 = (await db.query<{ m: string }>("select md5(pg_get_functiondef(to_regprocedure($1))) as m", [START6])).rows[0].m;
        await expect049(db, false);
        await expectBehaviour046(db);
      }
      if (IS_059(last)) await expect059(db, false);
      if (IS_061(last)) await expect061(db, false);
      if (IS_064(last)) await expect064(db, false);
      if (IS_065(last)) await expect065(db, false);
      if (IS_066(last)) await expect066(db, false);
      if (IS_067(last)) await expect067(db, false);
      if (IS_068(last)) await expect068(db, false);
      if (IS_072(last)) await expect072(db, false);
      if (IS_073(last)) await expect073(db, false);
      if (IS_074(last)) await expect074(db, false);
      if (IS_076(last)) await expect076(db, false);
      if (IS_075(last)) await expect075(db, false);
      if (IS_077(last)) await expect077(db, false);
      if (IS_078(last)) await expect078(db, false);
      if (IS_079(last)) await expect079(db, false);
      if (IS_080(last)) await expect080(db, false);
      if (IS_081(last)) await expect081(db, false);
      if (IS_082(last)) await expect082(db, false);
      if (IS_083(last)) await expect083(db, false);
      if (IS_084(last)) await expect084(db, false);
      if (IS_085(last)) await expect085(db, false);
      if (IS_088(last)) await expect088(db, false);
      if (IS_089(last)) await expect089(db, false);
      if (IS_090(last)) await expect090(db, false);
      if (IS_091(last)) await expect091(db, false);
      if (IS_092(last)) await expect092(db, false);
      if (IS_093(last)) await expect093(db, false);
      // Twice: a failure late in the file (its last section still to come) and one midway.
      for (const where of ["late", "middle"] as const) {
        const plan = injectionPlan(sql(path.join(MIGRATIONS, last)), where);
        // An object the first part creates that is NOT there yet: its presence mid-file and absence after the rollback prove the first part ran and was undone.
        let chosen: Candidate | undefined;
        for (const c of plan.candidates) if (!(await present(db, c))) { chosen = c; break; }
        if (!chosen) throw new Error(`${last}: nothing created before the ${where} injection point (line ${plan.at}) is new in this migration; cannot prove a rollback`);
        const unique = `rehearsal-injected-failure-${randomUUID()}`;
        const broken = [...plan.lines.slice(0, plan.at), probeSql(unique, chosen.what, chosen.exists), ...plan.lines.slice(plan.at)].join("\n");
        // The release rejects with the probe's own exception: its unique message (saying the object existed mid-file) and its SQLSTATE. A syntax error from bad placement
        // has neither, and fails here.
        const failure = await failedRelease(db, last, broken);
        expect(failure.code, `${where}: SQLSTATE of the failure: ${failure.message}`).toBe(INJECT_SQLSTATE);
        expect(failure.message).toBe(probeMessage(unique, chosen.what, true));
        // ... and none of it is left: same catalogue as before (so every column or function of the file is gone, also
        // those after the failure point), that object gone, and every earlier migration still applied.
        expect(await present(db, chosen)).toBe(false);
        expect(await catalogueRows(db)).toEqual(before);
        // ... and the columns, indexes, triggers and full function texts (a replaced function is back to its previous body) are as before.
        expect(await structure(db)).toEqual(structureBefore);
        expect((await releasePreflight()).markers).toEqual(markersBefore);
        if (IS_042(last)) await expect042(db, false);
        if (IS_043(last)) await expect043(db, false);
        if (IS_044(last)) await expect044(db, false);
        if (IS_044(last) && seeded044) expect(await bookingsDigest(db), "a failed 044 left the seeded bookings as they were").toEqual(seeded044);
        if (IS_045(last)) await expect045(db, false);
        if (IS_046(last)) {
          await expect046(db, false);
          await expectSeed046Untouched(db);
        }
        if (IS_049(last)) {
          // 049: the start_machine_run text (md5), its grants and 046's behaviour are back; nothing of 049 remains; the seed is untouched.
          await expect049(db, false);
          await expectBehaviour046(db);
          await expectSeed049Untouched(db);
        }
        if (IS_059(last)) await expect059(db, false);
        if (IS_061(last)) await expect061(db, false);
        if (IS_064(last)) await expect064(db, false);
        if (IS_065(last)) await expect065(db, false);
        if (IS_066(last)) await expect066(db, false);
        if (IS_067(last)) await expect067(db, false);
        if (IS_068(last)) await expect068(db, false);
        if (IS_072(last)) await expect072(db, false);
        if (IS_073(last)) await expect073(db, false);
        if (IS_074(last)) await expect074(db, false);
        if (IS_076(last)) await expect076(db, false);
        if (IS_075(last)) await expect075(db, false);
        if (IS_077(last)) await expect077(db, false);
        if (IS_078(last)) await expect078(db, false);
        if (IS_079(last)) await expect079(db, false);
        if (IS_080(last)) await expect080(db, false);
        if (IS_081(last)) await expect081(db, false);
        if (IS_082(last)) await expect082(db, false);
        if (IS_083(last)) await expect083(db, false);
        if (IS_084(last)) await expect084(db, false);
        if (IS_085(last)) await expect085(db, false);
        if (IS_088(last)) await expect088(db, false);
        if (IS_089(last)) await expect089(db, false);
        if (IS_090(last)) await expect090(db, false);
        if (IS_091(last)) await expect091(db, false);
        if (IS_092(last)) await expect092(db, false);
        if (IS_093(last)) await expect093(db, false);
        checked.push({ where, chosen });
      }
      // A clean run of the same file then applies normally. When the newest file is 033 or 034 it is the one whose effect on the CRLF bodies is checked here.
      if (last === F033) {
        await applyRelease(db, last);
        await check033(db);
      } else if (last === F034) {
        await apply034AndCheck(db);
      } else {
        await applyRelease(db, last);
      }
      // The same file without the failure does create each of those objects (the late probe's and the midway probe's).
      for (const { chosen } of checked) expect(await present(db, chosen)).toBe(true);
      if (IS_042(last)) await expect042(db, true);
      if (IS_043(last)) await expect043(db, true);
      if (IS_044(last)) await expect044(db, true);
      if (IS_044(last)) await expectSeed044Untouched(db);
      if (IS_045(last)) {
        await expect045(db, true);
        await seed045(db);
      }
      if (IS_046(last)) {
        await expect046(db, true);
        await expectSeed046Untouched(db);
      }
      if (IS_049(last)) {
        await expect049(db, true);
        await expectSeed049Untouched(db);
        await expectBehaviour049(db);
        await expectSeed049Untouched(db);
      }
      if (IS_059(last)) await expect059(db, true);
      if (IS_061(last)) await expect061(db, true);
      if (IS_064(last)) await expect064(db, true);
      if (IS_065(last)) await expect065(db, true);
      if (IS_066(last)) await expect066(db, true);
      if (IS_067(last)) await expect067(db, true);
      if (IS_068(last)) await expect068(db, true);
      if (IS_072(last)) await expect072(db, true);
      if (IS_073(last)) await expect073(db, true);
      if (IS_074(last)) await expect074(db, true);
      if (IS_076(last)) await expect076(db, true);
      if (IS_075(last)) await expect075(db, true);
      if (IS_077(last)) await expect077(db, true);
      if (IS_078(last)) await expect078(db, true);
      if (IS_079(last)) await expect079(db, true);
      if (IS_080(last)) await expect080(db, true);
      if (IS_081(last)) await expect081(db, true);
      if (IS_082(last)) await expect082(db, true);
      if (IS_083(last)) await expect083(db, true);
      if (IS_084(last)) await expect084(db, true);
      if (IS_085(last)) await expect085(db, true);
      if (IS_088(last)) await expect088(db, true);
      if (IS_089(last)) await expect089(db, true);
      if (IS_090(last)) await expect090(db, true);
      if (IS_091(last)) await expect091(db, true);
      if (IS_092(last)) await expect092(db, true);
      if (IS_093(last)) await expect093(db, true);
      expect(await structure(db)).not.toEqual(structureBefore);
      await db.query("notify pgrst, 'reload schema'");
      await db.query("notify pgrst, 'reload config'");
    });
  });

  it("applies them all a second time without error (each file is safe to re-run)", async () => {
    await withDb(async (db) => {
      for (const file of later) await applyRelease(db, file);
      if (IS_044(newest)) await expectSeed044Untouched(db);
      if (IS_045(newest)) await expectSeed045Untouched(db);
      if (IS_046(newest)) {
        await expect046(db, true);
        await expectSeed046Untouched(db);
      }
      if (IS_049(newest)) {
        await expect049(db, true);
        await expectSeed049Untouched(db);
      }
      if (IS_059(newest)) await expect059(db, true);
      if (IS_061(newest)) await expect061(db, true);
      if (IS_064(newest)) await expect064(db, true);
      if (IS_065(newest)) await expect065(db, true);
      if (IS_066(newest)) await expect066(db, true);
      if (IS_067(newest)) await expect067(db, true);
      if (IS_068(newest)) await expect068(db, true);
      if (IS_072(newest)) await expect072(db, true);
      if (IS_073(newest)) await expect073(db, true);
      if (IS_074(newest)) await expect074(db, true);
      if (IS_076(newest)) await expect076(db, true);
      if (IS_075(newest)) await expect075(db, true);
      if (IS_077(newest)) await expect077(db, true);
      if (IS_078(newest)) await expect078(db, true);
      if (IS_079(newest)) await expect079(db, true);
      if (IS_080(newest)) await expect080(db, true);
      if (IS_081(newest)) await expect081(db, true);
      if (IS_082(newest)) await expect082(db, true);
      if (IS_083(newest)) await expect083(db, true);
      if (IS_084(newest)) await expect084(db, true);
      if (IS_085(newest)) await expect085(db, true);
      if (IS_088(newest)) await expect088(db, true);
      if (IS_089(newest)) await expect089(db, true);
      if (IS_090(newest)) await expect090(db, true);
      if (IS_091(newest)) await expect091(db, true);
      if (IS_092(newest)) await expect092(db, true);
      if (IS_093(newest)) await expect093(db, true);
    });
  });

  it.runIf(TIME_FILES.length === 3)("050 to 052 (and 074) applied AFTER 065 (production's order) give the same database as the fresh in-order build", async () => {
    await withDb(async (db) => {
      await expectTimeAll(db, true);
      const fresh = await catalogueRows(db);
      const structureFresh = await structure(db);
      await db.query("begin");
      try {
        for (const text of TIME_TEARDOWN) await db.query(text);
        await expectTimeAll(db, false);
        // As production will: every other migration up to 065 in place, then 050, 051, 052 (then 074) in turn.
        for (const file of TIME_FILES_WITH_074) await db.query(sql(path.join(MIGRATIONS, file)));
        await expectTimeAll(db, true);
        expect(await catalogueRows(db)).toEqual(fresh);
        expect(await structure(db)).toEqual(structureFresh);
        // And a second time (each file safe to re-run).
        for (const file of TIME_FILES_WITH_074) await db.query(sql(path.join(MIGRATIONS, file)));
        expect(await catalogueRows(db)).toEqual(fresh);
      } finally {
        await db.query("rollback");
      }
      await expectTimeAll(db, true);
    });
  });

  it.runIf(IS_049(newest))("D2, after 049 is applied: the next pass applies the blocked bench Start and its Pause; one bench run with the captured times, one START_MACHINE_RUN", async () => {
    expect(d2, "the D2 queue was made before 049").toBeDefined();
    const workshop = await signedInClient(world.tenants.alpha.users.workshop);
    await withDb(async (db) => { await db.query("notify pgrst, 'reload schema'"); });
    await waitForApi(async () => !(await workshop.rpc("paused_machines")).error);
    const result = await replayOutbox(scope049, executor(workshop));
    expect(result).toMatchObject({ applied: 2, blocked: 0, rejected: 0, conflicts: 0, remaining: 0 });
    const runs = await withDb(async (db) => (await db.query<{ machine_id: string | null; started_at: Date; ended_at: Date | null; end_reason: string | null }>(
      "select machine_id, started_at, ended_at, end_reason from public.machine_runs where job_id = $1", [d2!.jobX])).rows);
    expect(runs).toHaveLength(d2!.runsBefore + 1);
    expect(runs.map((r) => ({ machine: r.machine_id, start: r.started_at.toISOString(), end: r.ended_at?.toISOString(), why: r.end_reason })))
      .toEqual([{ machine: null, start: d2!.startAt, end: d2!.pauseAt, why: "paused" }]);
    const events = await withDb(async (db) => Number((await db.query("select count(*) as c from security_audit.audit_log where action = 'START_MACHINE_RUN' and entity_id = $1", [d2!.jobX])).rows[0].c));
    expect(events).toBe(1);
    setOfflineBackend(null);
  });

  it("ends identical to a fresh build: catalogue snapshot, no permissive or legacy policies", async () => {
    const rows = await withDb(async (db) => (await db.query<{ kind: string; object: string; detail: string }>(sql(path.join(ROOT, "supabase/verify/catalogue.sql")))).rows);
    const expected: typeof rows = JSON.parse(readFileSync(path.join(ROOT, "tests/db/catalogue.snapshot.json"), "utf8"));
    const key = (r: { kind: string; object: string }) => `${r.kind} ${r.object}`;
    const want = new Map(expected.map((r) => [key(r), r.detail]));
    // The importer's own archive tables and function exist on any project that ran the import; not part of the chain.
    const importer = /legacy_import_map|legacy_audit_log|import_legacy_tenant/;
    const have = new Map(rows.filter((r) => !importer.test(`${r.object} ${r.detail}`)).map((r) => [key(r), r.detail]));
    const diff = {
      missing: [...want.keys()].filter((k) => !have.has(k)),
      extra: [...have.keys()].filter((k) => !want.has(k)),
      changed: [...want.keys()].filter((k) => have.has(k) && have.get(k) !== want.get(k)),
    };
    expect(diff).toEqual({ missing: [], extra: [], changed: [] });
    const forAll = await withDb(async (db) => (await db.query("select tablename, policyname from pg_policies where schemaname = 'public' and cmd = 'ALL' and permissive = 'PERMISSIVE'")).rows);
    expect(forAll).toEqual([]);
  });

  it("the release preflight now sees every migration and only 017's request hook", async () => {
    const state = await releasePreflight();
    expect(state.markers).toEqual(Array(state.markers.length).fill("applied"));
    expect(state.hooks).toBe("role authenticator: public.check_request_session");
  });

  it("verify scripts: nothing to fix before or after", async () => {
    const after: Record<string, number> = {};
    for (const name of VERIFY) after[name] = await verifyRows(name);
    expect({ preflight, after }).toEqual({
      preflight: Object.fromEntries(VERIFY.map((n) => [n, 0])),
      after: Object.fromEntries(VERIFY.map((n) => [n, 0])),
    });
  });

  it("existing data: still readable by its company, issued documents now locked, drafts still editable", async () => {
    const office = await signedInClient(world.tenants.alpha.users.office);
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const quotes = await office.from("quotes").select("quote_ref, status").order("quote_ref");
    expect(quotes.error).toBeNull();
    expect(quotes.data!.length).toBeGreaterThanOrEqual(5); // 3 imported + 2 added
    const invoices = await admin.from("invoices").select("id, invoice_ref, status, total");
    expect(invoices.error).toBeNull();
    expect(invoices.data!.length).toBe(3);
    const issued = invoices.data!.find((i) => i.status === "sent")!;
    expect((await admin.from("invoices").update({ total: Number(issued.total) + 1 }).eq("id", issued.id)).error).not.toBeNull();
    const sent = await office.from("quotes").update({ total_value: 999 }).eq("quote_ref", `QUO-R1-${world.runId}`).select("id");
    expect(sent.error).not.toBeNull();
    const draft = await office.from("quotes").update({ description: "Still a draft" }).eq("quote_ref", `QUO-R2-${world.runId}`).select("id");
    expect(draft.error).toBeNull();
    expect(draft.data).toHaveLength(1);
    // Imported before 027 without payment details: flagged on upgrade, not assumed unpaid (paid stays paid).
    const flags = await admin.from("invoices").select("invoice_ref, payment_unverified").order("invoice_ref");
    expect(flags.data?.map((r) => [r.invoice_ref, r.payment_unverified])).toEqual([["INV-7001", false], ["INV-7002", true], ["INV-7003", true]]);
    const beta = await signedInClient(world.tenants.beta.users.admin);
    expect((await beta.from("quotes").select("id").eq("organization_id", world.tenants.alpha.id)).data).toEqual([]);
  });

  it("existing jobs: worksheet version starts at 0; the next change makes the two dates agree", async () => {
    const workshop = await signedInClient(world.tenants.alpha.users.workshop);
    const before = await workshop.from("jobs").select("id, worksheet_version").eq("job_no", `J-R1-${world.runId}`).single();
    expect(before.data?.worksheet_version).toBe(0);
    const saved = await workshop.from("jobs").update({ date_required: "2026-01-20" }).eq("id", before.data!.id).select("date_required, due_date, worksheet_version").single();
    expect(saved.error).toBeNull();
    expect(saved.data).toEqual({ date_required: "2026-01-20", due_date: "2026-01-20", worksheet_version: 1 });
  });

  it("a signed-out session can no longer write (pre-request hook active after the config reload)", async () => {
    const office = await signedInClient(world.tenants.alpha.users.office);
    const { data: session } = await office.auth.getSession();
    const token = session.session!.access_token;
    await office.auth.signOut();
    const backend = isolatedBackend();
    const url = `${backend.apiUrl}/rest/v1/quotes?quote_ref=eq.QUO-R2-${world.runId}`;
    let status = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { apikey: backend.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ description: "written after sign-out" }),
      });
      status = response.status;
      if (status === 401 || status === 403) break;
      await new Promise((resolve) => setTimeout(resolve, 500)); // PostgREST picks up the reloaded config asynchronously
    }
    expect([401, 403]).toContain(status);
  });
});
