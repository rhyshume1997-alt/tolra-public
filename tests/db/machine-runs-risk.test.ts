/**
 * Risk-audit tests for live machine use (migration 044), through the real API path (Supabase Auth + PostgREST) plus the postgres role where
 * the database's own rules are the point. Complements tests/db/machine-runs.test.ts:
 *
 *   * an admin's override racing a normal workshop Start on the same machine, from two connections, several rounds;
 *   * a Start replayed twice under one client_op_id leaves machine_bookings, job_machines and the runs exactly as the first call did;
 *   * two companies with machines of the same name start at the same moment: each sees only its own run; a cross-company machine id is refused;
 *   * "active now" across the clock changes (29 March and 25 October 2026, Europe/London): at every sampled instant at most one run per
 *     machine is active, and the one-open-run index holds whatever the timestamps;
 *   * 044's release text (then each later file, in order) re-run on a database with an audited override: runs, audit rows, definitions and guards unchanged.
 *     (Migrations are forward-only: there is no down migration for 044.)
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { releaseSql } from "../../scripts/release-sql.mjs";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let n = 0;

type StartArgs = { p_job: string; p_machines: string[] | null; p_client_op_id?: string | null; p_started_at?: string | null; p_override?: boolean; p_reason?: string | null };
const start = (client: SupabaseClient, args: StartArgs) => client.rpc("start_machine_run", { p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null, ...args });
const pause = (client: SupabaseClient, job: string) => client.rpc("pause_machine_run", { p_job: job, p_machines: null, p_client_op_id: null, p_ended_at: null });
const runs = async (job: string) => (await adminClient().from("machine_runs").select("id, machine_id, started_at, ended_at, end_reason, override_of, client_op_id, booking_id").eq("job_id", job).order("started_at").order("created_at")).data!;
const openOn = async (machine: string) => (await adminClient().from("machine_runs").select("id, job_id").eq("machine_id", machine).is("ended_at", null)).data!;
const audit = (job: string, action: string) => withDb((db) => db.query("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2 order by created_at", [job, action]));
const newMachine = async (org: string, name: string) => (await adminClient().from("machines").insert({ organization_id: org, name, active: true }).select("id").single()).data!.id as string;

async function newJob(options: { bookMachine?: string } = {}) {
  n += 1;
  const day = String(1 + (n % 27)).padStart(2, "0");
  const month = n > 27 ? "05" : "04";
  const machines = options.bookMachine ? [{ machine_id: options.bookMachine, hours: 2, start_at: `2028-${month}-${day}T08:00:00Z` }] : [];
  const { data, error } = await as.admin.rpc("create_job", { p_customer: "Risk Co", p_description: `Risk job ${n}`, p_internal: false, p_related: null, p_required: null, p_machines: machines, p_clash_override: false, p_clashes: [], p_override_reason: null });
  if (error) throw new Error(error.message);
  return { id: data.job_id as string, no: data.job_no as string };
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("an admin's override racing a normal Start", () => {
  it("two connections, same machine, six rounds: exactly one open run at the end (the admin's), the loser is cleanly refused or displaced with the override audited, never two open runs or a server error", async () => {
    const press = await newMachine(world.tenants.alpha.id, `RK Press ${world.runId}`);
    const tally = { workshopFirst: 0, adminFirst: 0 };
    for (let round = 0; round < 6; round += 1) {
      const w = await newJob();
      const a = await newJob();
      const reason = `Urgent order round ${round}`;
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      // Alternate which side is nudged late so both interleavings are met.
      const [workshop, admin] = await Promise.all([
        (round % 2 ? delay(15) : Promise.resolve()).then(() => start(as.workshop, { p_job: w.id, p_machines: [press] })),
        (round % 2 ? Promise.resolve() : delay(15)).then(() => start(as.admin, { p_job: a.id, p_machines: [press], p_override: true, p_reason: reason })),
      ]);
      // The admin with a reason is never refused and never hits a server error; the workshop either got in first or was cleanly refused.
      expect(admin.error, `round ${round}: admin start`).toBeNull();
      if (workshop.error) {
        expect(workshop.error.code, `round ${round}: workshop refusal`).toBe("42501");
        expect(workshop.error.hint).toBe("machine_in_use");
      }
      const open = await openOn(press);
      expect(open, `round ${round}: exactly one open run`).toEqual([expect.objectContaining({ job_id: a.id })]);
      const adminRuns = await runs(a.id);
      expect(adminRuns).toHaveLength(1);
      const workshopRuns = await runs(w.id);
      const overrideEvents = (await audit(a.id, "OVERRIDE_MACHINE_IN_USE")).rows;
      if (workshop.error) {
        tally.adminFirst += 1;
        expect(workshopRuns, "the refused Start left nothing").toEqual([]);
        expect(overrideEvents, "nothing was displaced, so no override event").toEqual([]);
        expect(adminRuns[0].override_of).toBeNull();
      } else {
        tally.workshopFirst += 1;
        expect(workshopRuns.map((r) => [r.end_reason, r.ended_at !== null])).toEqual([["override", true]]);
        expect(adminRuns[0].override_of).toBe(workshopRuns[0].id);
        expect(overrideEvents).toHaveLength(1);
        expect(overrideEvents[0].metadata).toMatchObject({ reason, actor_user_id: world.tenants.alpha.users.admin.id });
        expect(overrideEvents[0].metadata.displaced).toEqual([expect.objectContaining({ job_no: w.no })]);
        expect(new Date(workshopRuns[0].ended_at!).getTime()).toBeLessThanOrEqual(new Date(adminRuns[0].started_at).getTime());
      }
      expect((await pause(as.admin, a.id)).error).toBeNull();
      expect(await openOn(press)).toEqual([]);
    }
    expect(tally.workshopFirst + tally.adminFirst).toBe(6);
  });
});

describe("a Start replayed with the same client_op_id", () => {
  it("changes nothing but the answer: machine_bookings (every column), the booking's status, job_machines, runs, job start and the audit trail are identical after two replays", async () => {
    const mill = await newMachine(world.tenants.alpha.id, `RK Mill ${world.runId}`);
    const job = await newJob({ bookMachine: mill });
    const op = randomUUID();
    const service = adminClient();
    const snapshot = async () => ({
      bookings: (await service.from("machine_bookings").select("*").eq("organization_id", world.tenants.alpha.id).order("id")).data!,
      plan: (await service.from("job_machines").select("*").eq("job_id", job.id).order("position")).data!,
      runs: await runs(job.id),
      job: (await service.from("jobs").select("started_at, started_by, finished_at, updated_at").eq("id", job.id).single()).data!,
      audit: (await audit(job.id, "START_MACHINE_RUN")).rows.length,
    });
    const first = await start(as.workshop, { p_job: job.id, p_machines: [mill], p_client_op_id: op });
    expect(first.error).toBeNull();
    expect(first.data.replayed).toBe(false);
    const after = await snapshot();
    expect(after.runs).toHaveLength(1);
    expect(after.plan).toHaveLength(1);
    const booking = after.bookings.find((b) => b.id === after.plan[0].booking_id)!;
    expect(booking.status).toBe("running");
    for (let i = 0; i < 2; i += 1) {
      const replay = await start(as.workshop, { p_job: job.id, p_machines: [mill], p_client_op_id: op });
      expect(replay.error).toBeNull();
      expect(replay.data.replayed).toBe(true);
      expect(await snapshot()).toEqual(after);
    }
    // 049 (R3.1): another person's replay of the key is refused, and changes nothing either.
    expect((await start(as.admin, { p_job: job.id, p_machines: [mill], p_client_op_id: op })).error?.hint).toBe("client_op_reused");
    expect(await snapshot()).toEqual(after);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });
});

describe("company boundary", () => {
  it("machines with the same name in two companies, started at the same moment: both succeed, each company sees only its own run, and a cross-company machine id is refused", async () => {
    const name = `RK Twin ${world.runId}`;
    const alphaMachine = await newMachine(world.tenants.alpha.id, name);
    const betaMachine = await newMachine(world.tenants.beta.id, name);
    const alphaJob = await newJob();
    const betaJobNo = `J-RKB-${world.runId}`;
    const betaJob = (await adminClient().from("jobs").insert({ organization_id: world.tenants.beta.id, job_no: betaJobNo, customer: "Beta Risk Co" }).select("id").single()).data!.id as string;
    const [a, b] = await Promise.all([start(as.admin, { p_job: alphaJob.id, p_machines: [alphaMachine] }), start(as.betaAdmin, { p_job: betaJob, p_machines: [betaMachine] })]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.data.runs).toEqual([expect.objectContaining({ machine_id: alphaMachine, machine: name, already: false })]);
    expect(b.data.runs).toEqual([expect.objectContaining({ machine_id: betaMachine, machine: name, already: false })]);
    // Each user selects: only their own company's run.
    const seen = async (client: SupabaseClient) => ({
      table: ((await client.from("machine_runs").select("job_id, machine_id").in("machine_id", [alphaMachine, betaMachine])).data ?? []).map((r) => [r.job_id, r.machine_id]),
      live: ((await client.rpc("machines_in_use")).data ?? []).filter((r: { machine_id: string }) => [alphaMachine, betaMachine].includes(r.machine_id)).map((r: { job_id: string; machine_id: string }) => [r.job_id, r.machine_id]),
    });
    expect(await seen(as.admin)).toEqual({ table: [[alphaJob.id, alphaMachine]], live: [[alphaJob.id, alphaMachine]] });
    expect(await seen(as.betaAdmin)).toEqual({ table: [[betaJob, betaMachine]], live: [[betaJob, betaMachine]] });
    expect(await seen(as.workshop)).toEqual({ table: [[alphaJob.id, alphaMachine]], live: [[alphaJob.id, alphaMachine]] });
    // The other company's machine id (same name) is refused whoever asks, override or not, and leaves nothing.
    const other = await newJob();
    expect((await start(as.admin, { p_job: other.id, p_machines: [betaMachine] })).error?.code).toBe("P0002");
    expect((await start(as.admin, { p_job: other.id, p_machines: [betaMachine], p_override: true, p_reason: "Take it over" })).error?.code).toBe("P0002");
    expect((await start(as.betaAdmin, { p_job: betaJob, p_machines: [alphaMachine], p_override: true, p_reason: "Take it over" })).error?.code).toBe("P0002");
    expect(await runs(other.id)).toEqual([]);
    expect(await openOn(alphaMachine)).toEqual([expect.objectContaining({ job_id: alphaJob.id })]);
    expect(await openOn(betaMachine)).toEqual([expect.objectContaining({ job_id: betaJob })]);
    expect((await pause(as.admin, alphaJob.id)).error).toBeNull();
    expect((await pause(as.betaAdmin, betaJob)).error).toBeNull();
  });
});

describe("IN USE across the clock changes", () => {
  it("29 March and 25 October 2026 (Europe/London): back-to-back runs across each night leave one active run per machine at every sampled instant; a second open run is refused at any timestamp", async () => {
    const job = await newJob();
    const org = world.tenants.alpha.id;
    const operator = world.tenants.alpha.users.workshop.id;
    const nights = [
      { label: "spring forward", from: "2026-03-28T18:00:00Z", to: "2026-03-29T12:00:00Z", clockChange: "2026-03-29T01:00:00Z" },
      { label: "autumn back", from: "2026-10-24T18:00:00Z", to: "2026-10-25T12:00:00Z", clockChange: "2026-10-25T01:00:00Z" },
    ];
    const machines: string[] = [];
    await withDb(async (db) => {
      for (const night of nights) {
        for (const suffix of ["A", "B"]) {
          const machine = await newMachine(org, `RK DST ${night.label} ${suffix} ${world.runId}`);
          machines.push(machine);
          // 40-minute runs, each starting exactly when the previous ends; the last one is still open (IN USE now).
          await db.query(
            `insert into public.machine_runs (organization_id, job_id, machine_id, operator_id, started_at, ended_at, end_reason)
             select $1, $2, $3, $4, t, case when t + interval '40 minutes' > $6::timestamptz then null else t + interval '40 minutes' end,
                    case when t + interval '40 minutes' > $6::timestamptz then null else 'paused' end
             from generate_series($5::timestamptz, $6::timestamptz, interval '40 minutes') t`,
            [org, job.id, machine, operator, night.from, night.to]);
        }
      }
      // Every 5 minutes from before the change to after it: how many runs are active per machine at that instant.
      for (const night of nights) {
        const rows = (await db.query<{ machine_id: string; instant: Date; active: string }>(
          `select m.machine_id, s.instant, count(r.id) as active
           from unnest($1::uuid[]) as m(machine_id)
           cross join generate_series($2::timestamptz, $3::timestamptz, interval '5 minutes') as s(instant)
           left join public.machine_runs r on r.machine_id = m.machine_id and r.started_at <= s.instant and (r.ended_at is null or r.ended_at > s.instant)
           group by m.machine_id, s.instant`,
          [machines.filter((_, i) => nights[Math.floor(i / 2)] === night), night.from, night.to])).rows;
        expect(rows.length, `${night.label}: sampled instants`).toBe(2 * (18 * 12 + 1));
        expect(rows.some((r) => new Date(r.instant).getTime() === Date.parse(night.clockChange)), `${night.label}: the clock change itself is sampled`).toBe(true);
        expect(Math.max(...rows.map((r) => Number(r.active))), `${night.label}: at most one active run per machine`).toBe(1);
        expect(Math.min(...rows.map((r) => Number(r.active))), `${night.label}: the chain leaves no gap`).toBe(1);
      }
      // The unique open-run index holds whatever the timestamps: a second open run, before or after the first, in the repeated hour or in
      // the hour that never happened, is refused.
      const insertOpen = (machine: string, at: string) => db.query(
        "insert into public.machine_runs (organization_id, job_id, machine_id, operator_id, started_at) values ($1, $2, $3, $4, $5::timestamptz)",
        [org, job.id, machine, operator, at]).then(() => null, (e: { code?: string }) => e.code);
      const [spring, , autumn] = machines;
      expect(await insertOpen(autumn, "2026-10-25T00:30:00Z")).toBe("23505"); // 01:30 BST, first pass of the repeated hour
      expect(await insertOpen(autumn, "2026-10-25T01:30:00Z")).toBe("23505"); // 01:30 GMT, second pass
      expect(await insertOpen(autumn, "2026-10-26T00:00:00Z")).toBe("23505");
      expect(await insertOpen(spring, "2026-03-29T01:30:00Z")).toBe("23505"); // 01:30 London does not exist; this instant is 02:30 BST
      expect(await insertOpen(spring, "2026-03-29T00:59:59Z")).toBe("23505");
      await db.query("rollback").catch(() => null);
    });
    // The app's IN USE query: one row per machine, one open run each.
    const { data: live, error } = await as.admin.rpc("machines_in_use");
    expect(error).toBeNull();
    const mine = (live as { machine_id: string }[]).filter((r) => machines.includes(r.machine_id));
    expect(mine.map((r) => r.machine_id).sort()).toEqual([...machines].sort());
    for (const machine of machines) expect(await openOn(machine)).toHaveLength(1);
  });
});

describe("re-applying 044 after an audited override", () => {
  const file044 = readdirSync(MIGRATIONS).find((f) => f.endsWith("_machine_runs.sql"))!;
  // 044 and every later file, in order, as the run sheet re-runs them: a later file (046) replaces start_machine_run, so 044 alone would
  // put 044's body back until 046 is re-run (docs/RELEASE.md, 046).
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f >= file044).sort();
  const releases = () => files.map((f) => releaseSql(readFileSync(path.join(MIGRATIONS, f), "utf8"), f));
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

  /** Everything 044 owns that a re-run could disturb: the runs, the whole company's audit trail, the definitions, indexes, triggers, grants. */
  const state = (org: string) => withDb(async (db) => {
    const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows;
    return {
      runs: await q("select * from public.machine_runs where organization_id = $1 order by created_at, id", [org]),
      audit: await q("select id, action, entity_table, entity_id, metadata, previous_hash from security_audit.audit_log where organization_id = $1 order by created_at, id", [org]),
      bookings: await q("select * from public.machine_bookings where organization_id = $1 order by id", [org]),
      jobs: await q("select id, started_at, assigned_to, finished_at from public.jobs where organization_id = $1 order by id", [org]),
      functions: await q(`select p.oid::regprocedure::text as k, md5(pg_get_functiondef(p.oid)) as d from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                          where s.nspname = 'public' and (p.proname in ('start_machine_run','pause_machine_run','finish_job','release_machine','assign_job','machines_in_use','assignable_people','machine_run_end','machine_booking_mirror','machine_run_client_time','jobs_finish_guard','jobs_assignment_keep'))
                          order by 1`),
      acl: await q("select p.oid::regprocedure::text as k, p.proacl::text as acl from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('start_machine_run','pause_machine_run','finish_job','release_machine','assign_job','machines_in_use','assignable_people','machine_run_end','machine_booking_mirror') order by 1"),
      indexes: await q("select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'machine_runs' order by 1"),
      triggers: await q("select tgname, pg_get_triggerdef(oid) as d from pg_trigger where tgrelid = 'public.machine_runs'::regclass and not tgisinternal order by 1"),
      grants: await q("select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'machine_runs' and grantee in ('anon','authenticated') order by 1, 2"),
      policies: await q("select policyname, cmd, qual from pg_policies where schemaname = 'public' and tablename = 'machine_runs' order by 1"),
    };
  });

  it("the second run of the release text leaves the runs, the audit rows (reason, actor), the definitions and the guards unchanged; the guards still refuse", async () => {
    const org = world.tenants.alpha.id;
    const lathe = await newMachine(org, `RK Lathe ${world.runId}`);
    const a = await newJob();
    const b = await newJob();
    expect((await start(as.workshop, { p_job: a.id, p_machines: [lathe] })).error).toBeNull();
    const reason = "Customer collecting today";
    expect((await start(as.admin, { p_job: b.id, p_machines: [lathe], p_override: true, p_reason: reason })).error).toBeNull();
    const overrides = (await audit(b.id, "OVERRIDE_MACHINE_IN_USE")).rows;
    expect(overrides).toHaveLength(1);
    expect(overrides[0].metadata.reason).toBe(reason);

    const before = await state(org);
    expect(before.runs.filter((r) => r.machine_id === lathe).map((r) => r.end_reason).sort()).toEqual([null, "override"]);
    await withDb(async (db) => {
      try {
        for (const text of releases()) await db.query(text);
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    });
    const after = await state(org);
    for (const key of Object.keys(before) as (keyof typeof before)[]) expect(digest(after[key]), `${key} unchanged by the re-run`).toBe(digest(before[key]));

    // Guards intact: one open run per machine, no direct writes, override still needs admin + reason, and still works and is audited.
    await withDb(async (db) => {
      const second = await db.query("insert into public.machine_runs (organization_id, job_id, machine_id, started_at) values ($1, $2, $3, now())", [org, a.id, lathe]).then(() => null, (e: { code?: string }) => e.code);
      expect(second).toBe("23505");
    });
    expect((await as.admin.from("machine_runs").insert({ organization_id: org, job_id: a.id, machine_id: lathe, started_at: new Date().toISOString() })).error?.code).toBe("42501");
    const c = await newJob();
    expect((await start(as.office, { p_job: c.id, p_machines: [lathe], p_override: true, p_reason: "Urgent" })).error?.hint).toBe("machine_in_use");
    expect((await start(as.admin, { p_job: c.id, p_machines: [lathe], p_override: true, p_reason: "" })).error?.hint).toBe("override_reason");
    expect((await start(as.admin, { p_job: c.id, p_machines: [lathe], p_override: true, p_reason: "Second take-over after re-apply" })).error).toBeNull();
    expect((await audit(c.id, "OVERRIDE_MACHINE_IN_USE")).rows).toHaveLength(1);
    expect(await openOn(lathe)).toEqual([expect.objectContaining({ job_id: c.id })]);
    // The earlier audit rows are still there, untouched.
    expect((await audit(b.id, "OVERRIDE_MACHINE_IN_USE")).rows).toEqual(overrides);
    expect((await pause(as.admin, c.id)).error).toBeNull();
  });
});
