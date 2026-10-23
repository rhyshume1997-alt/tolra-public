/**
 * Live machine use and operator assignment (migration 044), through the real API path: Supabase Auth + PostgREST with signed-in synthetic
 * users, so the database's own rules are under test.
 *
 *   * start_machine_run: admin, office and workshop start a job on one or more machines; a run opens per machine with the operator, the
 *     job's start (and who) is stamped once, a machine not in the plan joins it with 0 h, the booking goes running; viewer and anon can't;
 *     another company's job or machine, a retired machine, a duplicate or a bad list is refused and leaves nothing;
 *   * ONE OPEN RUN PER MACHINE: a second job is refused (hint machine_in_use, naming the holder) and two starts racing from two
 *     connections leave exactly one open run; an admin's override ends the displaced run (end_reason override), links the new run to it
 *     and is audited; the override flag means nothing to office or workshop;
 *   * pause frees the machine and keeps the job started; the board's plain Finish update ends every open run (trigger) and completes the
 *     booking; a replayed Finish is a no-op; a finished job can't be started on a machine;
 *   * release_machine: admin only, audited; a run open for 12 hours shows as stale;
 *   * idempotent replay by client_op_id (Start and Pause); client times clamped to now or refused when older than 30 days;
 *   * assign_job: admin and office assign active admin/office/workshop members only; workshop staff take a job themselves or hand their
 *     own back; the plain jobs update can't assign; machines_in_use and assignable_people name people by display name only;
 *   * history stays valid: a Start replayed with a time before a completed run, or an admin's take-over earlier than the displaced run's
 *     start, uses the server time with the device time kept and audited (time conflict); the table refuses an end before a start and
 *     overlapping runs (exclusion constraint); machine time is the union per machine;
 *   * a machine-less Start and a Pause that ended nothing replay their first answer (machine_run_ops) after a later Start, ending nothing;
 *   * the read-only verify script is clean.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let mill: string;
let lathe: string;
let saw: string;
let retired: string;
let betaMachine: string;
let betaJob: string;
let n = 0;

type StartArgs = { p_job: string; p_machines: string[] | null; p_client_op_id?: string | null; p_started_at?: string | null; p_override?: boolean; p_reason?: string | null };
const start = (client: SupabaseClient, args: StartArgs) => client.rpc("start_machine_run", { p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null, ...args });
const release = (client: SupabaseClient, machine: string, reason: string | null = "Forgotten run") => client.rpc("release_machine", { p_machine: machine, p_reason: reason });
const pause = (client: SupabaseClient, job: string, machines: string[] | null = null, over: { p_client_op_id?: string | null; p_ended_at?: string | null } = {}) =>
  client.rpc("pause_machine_run", { p_job: job, p_machines: machines, p_client_op_id: null, p_ended_at: null, ...over });
const assign = (client: SupabaseClient, job: string, user: string | null) => client.rpc("assign_job", { p_job: job, p_user: user });
const finish = (client: SupabaseClient, job: string, at: string | null = null, op: string | null = null) => client.rpc("finish_job", { p_job: job, p_client_op_id: op, p_finished_at: at });
const runs = async (job: string) => (await adminClient().from("machine_runs").select("id, machine_id, operator_id, booking_id, started_at, ended_at, end_reason, ended_by, override_of, client_op_id").eq("job_id", job).order("started_at").order("created_at")).data!;
const openOn = async (machine: string) => (await adminClient().from("machine_runs").select("id, job_id").eq("machine_id", machine).is("ended_at", null)).data!;
const jobRow = async (job: string) => (await adminClient().from("jobs").select("started_at, started_by, finished_at, assigned_to, assigned_by, assigned_at").eq("id", job).single()).data!;
const audit = (job: string, action: string) => withDb((db) => db.query("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2 order by created_at", [job, action]));

/** A job of the alpha company made on the board by the admin, with the mill planned and booked (a future, unique day) when asked. */
async function newJob(options: { bookMill?: boolean } = {}) {
  n += 1;
  const day = String(1 + (n % 27)).padStart(2, "0");
  const month = n > 27 ? "04" : "03";
  const machines = options.bookMill ? [{ machine_id: mill, hours: 2, start_at: `2027-${month}-${day}T08:00:00Z` }] : [];
  const { data, error } = await as.admin.rpc("create_job", { p_customer: "Run Co", p_description: `Run job ${n}`, p_internal: false, p_related: null, p_required: null, p_machines: machines, p_clash_override: false, p_clashes: [], p_override_reason: null });
  if (error) throw new Error(error.message);
  return { id: data.job_id as string, no: data.job_no as string };
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  const service = adminClient();
  const machine = async (org: string, name: string, active = true) => (await service.from("machines").insert({ organization_id: org, name, active }).select("id").single()).data!.id as string;
  mill = await machine(world.tenants.alpha.id, `MR Mill ${world.runId}`);
  lathe = await machine(world.tenants.alpha.id, `MR Lathe ${world.runId}`);
  saw = await machine(world.tenants.alpha.id, `MR Saw ${world.runId}`);
  retired = await machine(world.tenants.alpha.id, `MR Old grinder ${world.runId}`, false);
  betaMachine = await machine(world.tenants.beta.id, `MR Beta Mill ${world.runId}`);
  betaJob = (await service.from("jobs").insert({ organization_id: world.tenants.beta.id, job_no: `J-MRB-${world.runId}`, customer: "Beta customer" }).select("id").single()).data!.id;
  // The workshop person has a display name, so the holder of a machine is named on the board and in a refusal.
  await service.from("user_profiles").update({ full_name: "Dave Operator" }).eq("id", world.tenants.alpha.users.workshop.id);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("starting a job on a machine", () => {
  it.each(["workshop", "office", "admin"])("%s starts a job on two machines: runs open, the job's start is stamped once, the unplanned machine joins the plan, the booking runs, the company reads it, nobody writes directly", async (role) => {
    const job = await newJob({ bookMill: true });
    const before = await jobRow(job.id);
    expect(before.started_at).toBeNull();
    const { data, error } = await start(as[role], { p_job: job.id, p_machines: [mill, lathe] });
    expect(error).toBeNull();
    expect(data).toMatchObject({ job_id: job.id, job_no: job.no, replayed: false, overrides: [] });
    expect(data.runs.map((r: { machine_id: string; already: boolean }) => [r.machine_id, r.already])).toEqual([[mill, false], [lathe, false]]);
    const rows = await runs(job.id);
    expect(rows.map((r) => [r.machine_id, r.operator_id, r.ended_at, Boolean(r.booking_id)])).toEqual([[mill, world.tenants.alpha.users[role as "admin"].id, null, true], [lathe, world.tenants.alpha.users[role as "admin"].id, null, false]]);
    const after = await jobRow(job.id);
    expect(after.started_at).toBe(rows[0].started_at);
    expect(after.started_by).toBe(world.tenants.alpha.users[role as "admin"].id); // 035's trigger, from the session
    const plan = (await adminClient().from("job_machines").select("machine_id, estimated_hours, booking_id").eq("job_id", job.id).order("position")).data!;
    expect(plan.map((p) => [p.machine_id, Number(p.estimated_hours), Boolean(p.booking_id)])).toEqual([[mill, 2, true], [lathe, 0, false]]);
    expect((await adminClient().from("machine_bookings").select("status").eq("id", plan[0].booking_id!).single()).data).toEqual({ status: "running" });
    // Starting again on the mill: the run stands (no second run), the start time is not replaced.
    const again = await start(as[role], { p_job: job.id, p_machines: [mill] });
    expect(again.error).toBeNull();
    expect(again.data.runs).toEqual([expect.objectContaining({ machine_id: mill, already: true })]);
    expect(await runs(job.id)).toHaveLength(2);
    expect((await jobRow(job.id)).started_at).toBe(after.started_at);
    // Everyone in the company sees who is on what, by display name; the viewer reads the table too; no write grant for anyone.
    for (const reader of ["viewer", "workshop", "office"]) {
      const { data: live, error: liveError } = await as[reader].rpc("machines_in_use");
      expect(liveError).toBeNull();
      const mine = live.filter((r: { job_id: string }) => r.job_id === job.id);
      expect(mine.map((r: { machine_id: string; job_no: string; stale: boolean }) => [r.machine_id, r.job_no, r.stale]).sort()).toEqual([[lathe, job.no, false], [mill, job.no, false]].sort());
      expect(mine[0].operator_name === null || typeof mine[0].operator_name === "string").toBe(true);
      expect(JSON.stringify(mine)).not.toContain("@");
    }
    expect((await as.viewer.from("machine_runs").select("id").eq("job_id", job.id)).data).toHaveLength(2);
    expect((await as.betaAdmin.from("machine_runs").select("id").eq("job_id", job.id)).data).toEqual([]);
    expect((await as.admin.from("machine_runs").insert({ organization_id: world.tenants.alpha.id, job_id: job.id, machine_id: saw, started_at: new Date().toISOString() })).error?.code).toBe("42501");
    expect((await as.admin.from("machine_runs").update({ ended_at: new Date().toISOString(), end_reason: "paused" }).eq("job_id", job.id).select("id")).data ?? []).toEqual([]);
    expect((await as.admin.from("machine_runs").delete().eq("job_id", job.id).select("id")).data ?? []).toEqual([]);
    const events = await audit(job.id, "START_MACHINE_RUN");
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0].metadata).toMatchObject({ job_no: job.no, job_start_stamped: true, machines_added_to_plan: [{ machine_id: lathe, hours: 0, booking_id: null }] });
    expect((await pause(as[role], job.id)).error).toBeNull();
  });

  it("Start without a machine stamps the job and opens its bench run (046), no machine run; a refusal (viewer, anon, another company, a retired machine, a bad list) leaves nothing behind", async () => {
    const plain = await newJob();
    const { data, error } = await start(as.workshop, { p_job: plain.id, p_machines: [] });
    expect(error).toBeNull();
    expect(data.runs).toEqual([]);
    expect((await jobRow(plain.id)).started_at).not.toBeNull();
    expect((await runs(plain.id)).map((r) => [r.machine_id, r.ended_at])).toEqual([[null, null]]);
    expect((await pause(as.workshop, plain.id)).error).toBeNull();

    const job = await newJob();
    expect((await start(as.viewer, { p_job: job.id, p_machines: [mill] })).error?.code).toBe("42501");
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    expect((await start(anon, { p_job: job.id, p_machines: [mill] })).error).not.toBeNull();
    expect((await start(as.betaAdmin, { p_job: job.id, p_machines: [betaMachine] })).error?.code).toBe("P0002");
    expect((await start(as.admin, { p_job: betaJob, p_machines: [mill] })).error?.code).toBe("P0002");
    expect((await start(as.admin, { p_job: job.id, p_machines: [mill, betaMachine] })).error?.code).toBe("P0002");
    expect((await start(as.admin, { p_job: job.id, p_machines: [mill, retired] })).error?.code).toBe("P0002");
    expect((await start(as.admin, { p_job: job.id, p_machines: [mill, mill] })).error?.code).toBe("22023");
    expect((await start(as.admin, { p_job: job.id, p_machines: Array.from({ length: 11 }, () => randomUUID()) })).error?.code).toBe("22023");
    expect(await runs(job.id)).toEqual([]);
    expect(await openOn(mill)).toEqual([]);
    expect((await jobRow(job.id)).started_at).toBeNull();
    expect((await adminClient().from("job_machines").select("id").eq("job_id", job.id)).data).toEqual([]);
    expect((await adminClient().from("machine_runs").select("id").eq("job_id", betaJob)).data).toEqual([]);
  });
});

describe("one open run per machine", () => {
  it("a second job is refused and told who holds the machine; two starts racing from two connections leave exactly one open run", async () => {
    const a = await newJob();
    const b = await newJob();
    const c = await newJob();
    expect((await start(as.workshop, { p_job: a.id, p_machines: [saw] })).error).toBeNull();
    const refused = await start(as.office, { p_job: b.id, p_machines: [saw] });
    expect(refused.error?.code).toBe("42501");
    expect(refused.error?.hint).toBe("machine_in_use");
    expect(refused.error?.message).toContain(a.no);
    expect(refused.error?.message).toContain("Dave Operator");
    expect(refused.error?.message).not.toContain("@");
    expect(await runs(b.id)).toEqual([]);
    expect((await jobRow(b.id)).started_at).toBeNull();
    expect((await pause(as.workshop, a.id)).error).toBeNull();
    // The race, three times: office and admin (no override) start different jobs on the free saw at the same moment.
    for (let round = 0; round < 3; round += 1) {
      const [first, second] = await Promise.all([start(as.office, { p_job: b.id, p_machines: [saw] }), start(as.admin, { p_job: c.id, p_machines: [saw] })]);
      const outcomes = [first, second].map((r) => (r.error ? r.error.hint : "ok")).sort();
      expect(outcomes).toEqual(["machine_in_use", "ok"]);
      expect(await openOn(saw)).toHaveLength(1);
      const holder = (await openOn(saw))[0].job_id;
      expect((await pause(as.admin, holder)).error).toBeNull();
      expect(await openOn(saw)).toEqual([]);
    }
  });

  it("an admin's override needs a reason, ends the displaced run (end_reason override), links the new run to it and is audited with the reason, actor and time; the flag means nothing to office or workshop", async () => {
    const a = await newJob({ bookMill: true });
    const b = await newJob();
    const started = await start(as.workshop, { p_job: a.id, p_machines: [mill] });
    expect(started.error).toBeNull();
    const [aRun] = await runs(a.id);
    const bookingBefore = (await adminClient().from("machine_bookings").select("status, hours_done").eq("id", aRun.booking_id!).single()).data!;
    expect(bookingBefore.status).toBe("running");
    for (const role of ["office", "workshop"]) {
      const r = await start(as[role], { p_job: b.id, p_machines: [mill], p_override: true, p_reason: "Urgent" });
      expect(r.error?.code).toBe("42501");
      expect(r.error?.hint).toBe("machine_in_use");
    }
    expect((await start(as.admin, { p_job: b.id, p_machines: [mill] })).error?.hint).toBe("machine_in_use");
    // The admin must say why: a blank reason is refused before anything changes.
    for (const reason of [null, "", "   ", "ok"]) {
      const r = await start(as.admin, { p_job: b.id, p_machines: [mill], p_override: true, p_reason: reason });
      expect(r.error?.code).toBe("22023");
      expect(r.error?.hint).toBe("override_reason");
    }
    expect((await start(as.admin, { p_job: b.id, p_machines: [mill], p_override: true, p_reason: "x".repeat(501) })).error?.code).toBe("22023");
    expect(await openOn(mill)).toEqual([{ id: aRun.id, job_id: a.id }]);
    expect(await runs(b.id)).toEqual([]);
    const { data, error } = await start(as.admin, { p_job: b.id, p_machines: [mill], p_override: true, p_reason: "  Customer waiting on B  " });
    expect(error).toBeNull();
    expect(data.overrides).toEqual([expect.objectContaining({ run_id: aRun.id, job_no: a.no, end_reason: "override" })]);
    const [aAfter] = await runs(a.id);
    expect(aAfter).toMatchObject({ end_reason: "override", ended_by: world.tenants.alpha.users.admin.id });
    expect(aAfter.ended_at).not.toBeNull();
    const [bRun] = await runs(b.id);
    expect(bRun).toMatchObject({ machine_id: mill, override_of: aRun.id, ended_at: null });
    expect(bRun.started_at).toBe(aAfter.ended_at); // the union of machine time stays exact: no overlap
    expect(await openOn(mill)).toEqual([{ id: bRun.id, job_id: b.id }]);
    // A's booking is booked again, with the run's time counted as done; A itself stays started.
    expect((await adminClient().from("machine_bookings").select("status").eq("id", aRun.booking_id!).single()).data).toEqual({ status: "booked" });
    expect((await jobRow(a.id)).started_at).not.toBeNull();
    const events = await audit(b.id, "OVERRIDE_MACHINE_IN_USE");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].metadata.displaced).toEqual([expect.objectContaining({ job_no: a.no, run_id: aRun.id })]);
    // The shape of 042's OVERRIDE_MACHINE_CLASH: reason, the conflicts the function found, their job numbers, the actor and the time.
    expect(events.rows[0].metadata).toMatchObject({ reason: "Customer waiting on B", actor_user_id: world.tenants.alpha.users.admin.id, clashing_job_nos: [a.no] });
    expect(events.rows[0].metadata.conflicts).toEqual([expect.objectContaining({ run_id: aRun.id, job_no: a.no })]);
    expect(typeof events.rows[0].metadata.at).toBe("string");
    expect((await pause(as.admin, b.id)).error).toBeNull();
  });
});

describe("pause, finish and release", () => {
  it("pause frees the machine and keeps the job started; finish_job ends every open run and completes the booking; a plain finish is refused while a machine is held; a finished job can't start", async () => {
    const job = await newJob({ bookMill: true });
    expect((await start(as.workshop, { p_job: job.id, p_machines: [mill, lathe] })).error).toBeNull();
    const startedAt = (await jobRow(job.id)).started_at;
    const paused = await pause(as.workshop, job.id, [mill]);
    expect(paused.error).toBeNull();
    expect(paused.data.ended).toEqual([expect.objectContaining({ machine_id: mill, end_reason: "paused" })]);
    expect(await openOn(mill)).toEqual([]);
    expect(await openOn(lathe)).toHaveLength(1);
    expect((await jobRow(job.id)).started_at).toBe(startedAt);
    const millRun = (await runs(job.id)).find((r) => r.machine_id === mill)!;
    expect(millRun).toMatchObject({ machine_id: mill, end_reason: "paused", ended_by: world.tenants.alpha.users.workshop.id });
    expect((await adminClient().from("machine_bookings").select("status, hours_done").eq("id", millRun.booking_id!).single()).data).toMatchObject({ status: "booked" });
    // Pausing everything, then starting again on the mill: a second run on the mill for the same job.
    expect((await pause(as.workshop, job.id)).data.ended).toHaveLength(1);
    expect(await openOn(lathe)).toEqual([]);
    expect((await pause(as.workshop, job.id)).data.ended).toEqual([]);
    expect((await start(as.workshop, { p_job: job.id, p_machines: [mill] })).error).toBeNull();
    expect((await runs(job.id)).filter((r) => r.machine_id === mill)).toHaveLength(2);
    expect((await adminClient().from("machine_bookings").select("status").eq("id", millRun.booking_id!).single()).data).toEqual({ status: "running" });
    // The plain jobs update (the board before 044, the API role's own grant) can't finish a job that holds a machine: the runs would be
    // left open outside the lock order. finish_job does it: fills the empty finish time, ends the runs, completes the booking.
    const finishedAt = new Date().toISOString();
    const plain = await as.workshop.from("jobs").update({ finished_at: finishedAt, stage: "inspection" }).eq("id", job.id).is("finished_at", null).select("id");
    expect(plain.error?.code).toBe("42501");
    expect(plain.error?.hint).toBe("finish_via_rpc");
    expect((await jobRow(job.id)).finished_at).toBeNull();
    expect(await openOn(mill)).toHaveLength(1);
    expect((await finish(as.viewer, job.id, finishedAt)).error?.code).toBe("42501");
    const { data: finished, error: finishError } = await finish(as.workshop, job.id, finishedAt, randomUUID());
    expect(finishError).toBeNull();
    expect(finished).toMatchObject({ job_id: job.id, changed: true });
    expect(finished.ended).toEqual([expect.objectContaining({ machine_id: mill, end_reason: "finished" })]);
    expect(await openOn(mill)).toEqual([]);
    const all = await runs(job.id);
    expect(all.every((r) => r.ended_at !== null)).toBe(true);
    const last = all.find((r) => r.machine_id === mill && r.end_reason === "finished")!;
    expect(new Date(last.ended_at!).toISOString()).toBe(new Date(finishedAt).toISOString());
    expect((await adminClient().from("machine_bookings").select("status").eq("id", millRun.booking_id!).single()).data).toEqual({ status: "complete" });
    expect((await audit(job.id, "FINISH_ENDS_MACHINE_RUNS")).rows[0].metadata.ended).toHaveLength(1);
    // Replayed Finish: the recorded time is kept and returned; nothing changes. A plain finish still works for a job holding no machine.
    const replay = await finish(as.workshop, job.id, new Date().toISOString(), randomUUID());
    expect(replay.data).toMatchObject({ changed: false, ended: [] });
    expect(new Date(replay.data.finished_at).toISOString()).toBe(finishedAt);
    expect(new Date((await jobRow(job.id)).finished_at).toISOString()).toBe(finishedAt);
    expect((await jobRow(job.id)).finished_at).not.toBeNull();
    const free = await newJob();
    expect((await as.workshop.from("jobs").update({ finished_at: finishedAt, stage: "inspection" }).eq("id", free.id).is("finished_at", null).select("id")).data).toHaveLength(1);
    // A job never started: finish_job records the start too (the board's rule), and who, from the session.
    const fresh = await newJob();
    expect((await finish(as.office, fresh.id)).data.changed).toBe(true);
    expect(await jobRow(fresh.id)).toMatchObject({ started_by: world.tenants.alpha.users.office.id });
    expect((await jobRow(fresh.id)).started_at).toBe((await jobRow(fresh.id)).finished_at);
    const closed = await start(as.workshop, { p_job: job.id, p_machines: [mill] });
    expect(closed.error?.code).toBe("42501");
    expect(closed.error?.hint).toBe("job_finished");
    expect(await openOn(mill)).toEqual([]);
  });

  it("only an admin releases a machine, with a reason; a run open for 12 hours is marked stale", async () => {
    // A machine of its own: the run is back-dated 13 hours below, which the exclusion constraint allows only over no earlier run.
    const grinder = (await adminClient().from("machines").insert({ organization_id: world.tenants.alpha.id, name: `MR Stale grinder ${world.runId}`, active: true }).select("id").single()).data!.id as string;
    const job = await newJob();
    expect((await start(as.workshop, { p_job: job.id, p_machines: [grinder] })).error).toBeNull();
    expect((await release(as.office, grinder)).error?.code).toBe("42501");
    expect((await release(as.workshop, grinder)).error?.code).toBe("42501");
    expect((await release(as.betaAdmin, grinder)).error?.code).toBe("P0002");
    for (const reason of [" ", "no", "x".repeat(501)]) {
      const bad = await release(as.admin, grinder, reason);
      expect(bad.error?.code).toBe("22023");
      expect(bad.error?.hint).toBe("override_reason");
    }
    expect(await openOn(grinder)).toHaveLength(1);
    const [run] = await runs(job.id);
    await withDb((db) => db.query("update public.machine_runs set started_at = now() - interval '13 hours' where id = $1", [run.id]));
    const live = (await as.viewer.rpc("machines_in_use")).data.filter((r: { job_id: string }) => r.job_id === job.id);
    expect(live).toEqual([expect.objectContaining({ machine_id: grinder, stale: true })]);
    const { data, error } = await release(as.admin, grinder, "Dave went home");
    expect(error).toBeNull();
    expect(data.released).toMatchObject({ run_id: run.id, job_no: job.no, end_reason: "admin_released" });
    expect(await openOn(grinder)).toEqual([]);
    expect((await runs(job.id))[0]).toMatchObject({ end_reason: "admin_released", ended_by: world.tenants.alpha.users.admin.id });
    expect((await release(as.admin, grinder)).data.released).toBeNull();
    const events = await audit(job.id, "RELEASE_MACHINE");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].metadata).toMatchObject({ reason: "Dave went home", actor_user_id: world.tenants.alpha.users.admin.id, machine_id: grinder, clashing_job_nos: [job.no] });
    expect((await jobRow(job.id)).started_at).not.toBeNull();
  });
});

describe("offline replay", () => {
  it("the same client_op_id makes one run and answers replayed; a Pause replays the same way; client times are clamped to now or refused when too old", async () => {
    // A machine of its own: a Start replayed with yesterday's time is honoured only before anything else ran on the machine.
    const bench = (await adminClient().from("machines").insert({ organization_id: world.tenants.alpha.id, name: `MR Bench ${world.runId}`, active: true }).select("id").single()).data!.id as string;
    const job = await newJob();
    const op = randomUUID();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const first = await start(as.workshop, { p_job: job.id, p_machines: [bench], p_client_op_id: op, p_started_at: yesterday });
    expect(first.error).toBeNull();
    expect(first.data.replayed).toBe(false);
    expect(new Date(first.data.runs[0].started_at).toISOString()).toBe(yesterday);
    expect(new Date((await jobRow(job.id)).started_at).toISOString()).toBe(yesterday);
    // Replayed (the answer was lost): the first result, no second run.
    const again = await start(as.workshop, { p_job: job.id, p_machines: [bench], p_client_op_id: op, p_started_at: yesterday });
    expect(again.error).toBeNull();
    expect(again.data).toEqual({ ...first.data, replayed: true }); // the first answer, from machine_run_ops
    // 049 (R3.1): the key is bound to the person and the request: another person, or another time, is refused and makes nothing.
    for (const [who, at] of [["admin", yesterday], ["workshop", null]] as const) {
      const refused = await start(as[who], { p_job: job.id, p_machines: [bench], p_client_op_id: op, p_started_at: at });
      expect([refused.error?.code, refused.error?.hint]).toEqual(["22023", "client_op_reused"]);
    }
    expect(await runs(job.id)).toHaveLength(1);
    expect((await runs(job.id))[0].client_op_id).toBe(op);
    // The replay answers the same after the machine moved on (paused, then held by another job).
    const pauseOp = randomUUID();
    const paused = await pause(as.workshop, job.id, null, { p_client_op_id: pauseOp });
    expect(paused.data).toMatchObject({ replayed: false });
    expect(paused.data.ended).toHaveLength(1);
    const pausedAgain = await pause(as.workshop, job.id, null, { p_client_op_id: pauseOp });
    expect(pausedAgain.data).toEqual({ ...paused.data, replayed: true });
    const other = await newJob();
    expect((await start(as.office, { p_job: other.id, p_machines: [bench] })).error).toBeNull();
    const late = await start(as.workshop, { p_job: job.id, p_machines: [bench], p_client_op_id: op, p_started_at: yesterday });
    expect(late.error).toBeNull();
    expect(late.data).toEqual({ ...first.data, replayed: true });
    // The same key sent for ANOTHER job is refused, never answered as replayed (the outbox would otherwise mark a Start applied that never was).
    const reused = await start(as.workshop, { p_job: other.id, p_machines: [saw], p_client_op_id: op });
    expect(reused.error?.code).toBe("22023");
    expect(reused.error?.hint).toBe("client_op_reused");
    expect(await openOn(saw)).toEqual([]);
    const pauseReused = await pause(as.office, other.id, null, { p_client_op_id: pauseOp });
    expect(pauseReused.error?.code).toBe("22023");
    expect(pauseReused.error?.hint).toBe("client_op_reused");
    expect(await openOn(bench)).toHaveLength(1); // other's run still open
    expect(await openOn(bench)).toEqual([{ id: expect.any(String), job_id: other.id }]);
    // A fresh key against the held machine is the real refusal (the app surfaces it; nothing is dropped silently).
    const clash = await start(as.workshop, { p_job: job.id, p_machines: [bench], p_client_op_id: randomUUID() });
    expect(clash.error?.hint).toBe("machine_in_use");
    expect((await pause(as.office, other.id)).error).toBeNull();
    // Client times: in the future is clamped to now; older than 30 days is refused.
    const future = await start(as.workshop, { p_job: job.id, p_machines: [bench], p_client_op_id: randomUUID(), p_started_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.error).toBeNull();
    expect(new Date(future.data.runs[0].started_at).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    const old = await pause(as.workshop, job.id, null, { p_ended_at: new Date(Date.now() - 31 * 86_400_000).toISOString() });
    expect(old.error?.code).toBe("22023");
    expect(old.error?.hint).toBe("time_too_old");
    expect(await openOn(bench)).toHaveLength(1);
    const tooOld = await start(as.workshop, { p_job: other.id, p_machines: [saw], p_client_op_id: randomUUID(), p_started_at: new Date(Date.now() - 31 * 86_400_000).toISOString() });
    expect(tooOld.error?.hint).toBe("time_too_old");
    expect(await openOn(saw)).toEqual([]);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });
});

describe("booking mirror on a booking from before 042", () => {
  it("a booking with text longer than 042 allows still goes running, booked and complete with the runs (cut to the limit for the mirror)", async () => {
    const job = await newJob();
    const service = adminClient();
    const long = (n: number, c: string) => c.repeat(n);
    const { data: booking, error } = await service.from("machine_bookings").insert({
      organization_id: world.tenants.alpha.id, machine_id: saw, job_id: job.id, job_no: long(120, "J"), description: long(600, "d"), notes: long(2500, "n"),
      start_at: "2027-06-01T08:00:00Z", estimated_hours: 2, hours_done: 0, status: "booked",
    }).select("id").single();
    expect(error).toBeNull();
    expect((await service.from("job_machines").insert({ organization_id: world.tenants.alpha.id, job_id: job.id, machine_id: saw, estimated_hours: 2, booking_id: booking!.id })).error).toBeNull();
    const started = await start(as.workshop, { p_job: job.id, p_machines: [saw] });
    expect(started.error).toBeNull();
    expect(started.data.runs[0].booking).toMatchObject({ booking_id: booking!.id, mirrored: true, status: "running" });
    expect((await service.from("machine_bookings").select("status, description").eq("id", booking!.id).single()).data).toMatchObject({ status: "running", description: long(500, "d") });
    const paused = await pause(as.workshop, job.id);
    expect(paused.error).toBeNull();
    expect(paused.data.ended[0].booking).toMatchObject({ mirrored: true, status: "booked" });
    expect((await service.from("machine_bookings").select("status, job_no").eq("id", booking!.id).single()).data).toEqual({ status: "booked", job_no: long(100, "J") });
    expect((await start(as.workshop, { p_job: job.id, p_machines: [saw] })).error).toBeNull();
    expect((await finish(as.workshop, job.id)).data.ended[0].booking).toMatchObject({ mirrored: true, status: "complete" });
    expect((await service.from("machine_bookings").select("status").eq("id", booking!.id).single()).data).toEqual({ status: "complete" });
    expect(await openOn(saw)).toEqual([]);
  });

  it("a booking whose start is outside 2000..2100 is left alone and the result says so; the run still starts and ends", async () => {
    const job = await newJob();
    const service = adminClient();
    const { data: booking } = await service.from("machine_bookings").insert({
      organization_id: world.tenants.alpha.id, machine_id: saw, job_id: job.id, job_no: job.no, description: "Old", start_at: "1999-06-01T08:00:00Z", estimated_hours: 1, status: "booked",
    }).select("id").single();
    const started = await start(as.workshop, { p_job: job.id, p_machines: [saw] });
    expect(started.error).toBeNull();
    expect(started.data.runs[0].booking).toMatchObject({ booking_id: booking!.id, mirrored: false, why: "start_out_of_range" });
    expect((await service.from("machine_bookings").select("status").eq("id", booking!.id).single()).data).toEqual({ status: "booked" });
    // The machine wasn't in the plan: it joins it linked to the job's booking on it, with the booking's hours (the plan follows the booking).
    expect((await service.from("job_machines").select("machine_id, estimated_hours, booking_id").eq("job_id", job.id)).data).toEqual([{ machine_id: saw, estimated_hours: 1, booking_id: booking!.id }]);
    expect((await pause(as.workshop, job.id)).data.ended[0].booking).toMatchObject({ mirrored: false });
    expect(await openOn(saw)).toEqual([]);
  });
});

describe("assignment", () => {
  it("admin and office assign an active admin/office/workshop member; viewer and another company's person are refused; the plain jobs update can't assign; audited", async () => {
    const job = await newJob();
    const dave = world.tenants.alpha.users.workshop.id;
    const { data, error } = await assign(as.office, job.id, dave);
    expect(error).toBeNull();
    expect(data).toMatchObject({ job_id: job.id, assigned_to: dave, assigned_name: "Dave Operator", changed: true });
    expect(await jobRow(job.id)).toMatchObject({ assigned_to: dave, assigned_by: world.tenants.alpha.users.office.id });
    expect((await jobRow(job.id)).assigned_at).not.toBeNull();
    expect((await assign(as.office, job.id, dave)).data.changed).toBe(false);
    const viewerRefused = await assign(as.admin, job.id, world.tenants.alpha.users.viewer.id);
    expect(viewerRefused.error?.code).toBe("P0002");
    expect(viewerRefused.error?.hint).toBe("assignee_not_allowed");
    expect((await assign(as.admin, job.id, world.tenants.beta.users.workshop.id)).error?.code).toBe("P0002");
    expect((await assign(as.admin, job.id, randomUUID())).error?.code).toBe("P0002");
    expect((await assign(as.viewer, job.id, dave)).error?.code).toBe("42501");
    expect((await assign(as.betaAdmin, job.id, world.tenants.beta.users.workshop.id)).error?.code).toBe("P0002");
    expect((await assign(as.admin, betaJob, dave)).error?.code).toBe("P0002");
    expect((await jobRow(job.id)).assigned_to).toBe(dave);
    // The board's generic update (the API role's own UPDATE grant) keeps the assignment as it is, silently.
    const direct = await as.admin.from("jobs").update({ assigned_to: world.tenants.alpha.users.office.id, assigned_at: new Date().toISOString() }).eq("id", job.id).select("id, assigned_to");
    expect(direct.error).toBeNull();
    expect(direct.data).toEqual([{ id: job.id, assigned_to: dave }]);
    expect(await jobRow(job.id)).toMatchObject({ assigned_to: dave, assigned_by: world.tenants.alpha.users.office.id });
    const cleared = await assign(as.admin, job.id, null);
    expect(cleared.error).toBeNull();
    expect(await jobRow(job.id)).toMatchObject({ assigned_to: null, assigned_at: null, assigned_by: null });
    expect((await assign(as.admin, job.id, world.tenants.alpha.users.office.id)).error).toBeNull();
    const events = await audit(job.id, "ASSIGN_JOB");
    expect(events.rows.map((r) => [r.metadata.to, r.metadata.self])).toEqual([[dave, false], [null, false], [world.tenants.alpha.users.office.id, false]]);
    // Who can be assigned: display names only, no viewer, no other company.
    const { data: people } = await as.workshop.rpc("assignable_people");
    const ids = people.map((p: { user_id: string }) => p.user_id);
    expect(ids).toEqual(expect.arrayContaining([world.tenants.alpha.users.admin.id, world.tenants.alpha.users.office.id, dave]));
    expect(ids).not.toContain(world.tenants.alpha.users.viewer.id);
    expect(ids).not.toContain(world.tenants.beta.users.workshop.id);
    expect(people.find((p: { user_id: string }) => p.user_id === dave).display_name).toBe("Dave Operator");
    expect(JSON.stringify(people)).not.toContain("@");
  });

  it("workshop staff take a job themselves or hand their own back, and can't assign anyone else", async () => {
    const job = await newJob();
    const dave = world.tenants.alpha.users.workshop.id;
    const other = await assign(as.workshop, job.id, world.tenants.alpha.users.office.id);
    expect(other.error?.code).toBe("42501");
    expect(other.error?.hint).toBe("assign_self_only");
    const taken = await assign(as.workshop, job.id, dave);
    expect(taken.error).toBeNull();
    expect(taken.data).toMatchObject({ assigned_to: dave, changed: true });
    expect((await audit(job.id, "ASSIGN_JOB")).rows[0].metadata.self).toBe(true);
    expect((await assign(as.workshop, job.id, null)).error).toBeNull();
    expect((await jobRow(job.id)).assigned_to).toBeNull();
    // Someone else's job can't be handed back by the workshop.
    expect((await assign(as.office, job.id, world.tenants.alpha.users.office.id)).error).toBeNull();
    expect((await assign(as.workshop, job.id, null)).error?.hint).toBe("assign_self_only");
    expect((await jobRow(job.id)).assigned_to).toBe(world.tenants.alpha.users.office.id);
    // Taking it over from the office is allowed (assignment is informational).
    expect((await assign(as.workshop, job.id, dave)).error).toBeNull();
  });
});

describe("hardening", () => {
  const newMachine = async (name: string) => (await adminClient().from("machines").insert({ organization_id: world.tenants.alpha.id, name: `${name} ${world.runId}`, active: true }).select("id").single()).data!.id as string;

  it("a Start replayed after an admin's override displaced its run: answered as replayed, nothing reopened, the override stands", async () => {
    const press = await newMachine("MR Press");
    const a = await newJob();
    const b = await newJob();
    const op = randomUUID();
    const first = await start(as.workshop, { p_job: a.id, p_machines: [press], p_client_op_id: op });
    expect(first.error).toBeNull();
    expect((await start(as.admin, { p_job: b.id, p_machines: [press], p_override: true, p_reason: "Urgent order B" })).error).toBeNull();
    const [bRun] = await runs(b.id);
    for (let i = 0; i < 2; i += 1) {
      const replay = await start(as.workshop, { p_job: a.id, p_machines: [press], p_client_op_id: op });
      expect(replay.error).toBeNull();
      expect(replay.data).toEqual({ ...first.data, replayed: true }); // the first answer, unchanged by what happened since
    }
    expect((await runs(a.id)).map((r) => [r.end_reason, r.client_op_id])).toEqual([["override", op]]);
    expect(await openOn(press)).toEqual([{ id: bRun.id, job_id: b.id }]);
    expect((await pause(as.admin, b.id)).error).toBeNull();
  });

  it("a run across the clock change (BST to GMT, 25 October 2026): started 00:30 and ended 02:30 London time is stored as the exact instants and counts 3 hours", async () => {
    const lathe2 = await newMachine("MR DST lathe");
    const job = await newJob();
    const r = await withDb(async (db) => {
      const inserted = (await db.query<{ id: string }>(
        "insert into public.machine_runs (organization_id, job_id, machine_id, operator_id, started_at) values ($1, $2, $3, $4, timestamp '2026-10-25 00:30' at time zone 'Europe/London') returning id",
        [world.tenants.alpha.id, job.id, lathe2, world.tenants.alpha.users.workshop.id])).rows[0];
      const ended = (await db.query("select public.machine_run_end($1, timestamp '2026-10-25 02:30' at time zone 'Europe/London', 'paused', null) as r", [inserted.id])).rows[0].r;
      const row = (await db.query("select started_at, ended_at, to_char(started_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') as s_local, to_char(ended_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') as e_local, extract(epoch from ended_at - started_at) as secs from public.machine_runs where id = $1", [inserted.id])).rows[0];
      return { ended, row };
    });
    expect(new Date(r.row.started_at).toISOString()).toBe("2026-10-24T23:30:00.000Z"); // 00:30 BST (UTC+1)
    expect(new Date(r.row.ended_at).toISOString()).toBe("2026-10-25T02:30:00.000Z"); // 02:30 GMT, after 01:00..01:59 ran twice
    expect([r.row.s_local, r.row.e_local]).toEqual(["2026-10-25 00:30", "2026-10-25 02:30"]);
    expect(Number(r.row.secs)).toBe(3 * 3600);
    expect(Number(r.ended.hours)).toBe(3);
    expect(new Date(r.row.ended_at).getTime() - new Date(r.row.started_at).getTime()).toBe(3 * 3_600_000);
  });

  it("a machine retired while a run is open on it: the run still pauses and finishes; new starts on it are refused", async () => {
    const drill = await newMachine("MR Drill");
    const job = await newJob();
    expect((await start(as.workshop, { p_job: job.id, p_machines: [drill] })).error).toBeNull();
    expect((await adminClient().from("machines").update({ active: false }).eq("id", drill)).error).toBeNull();
    expect((await as.viewer.rpc("machines_in_use")).data.filter((x: { machine_id: string }) => x.machine_id === drill)).toHaveLength(1);
    const paused = await pause(as.workshop, job.id, [drill]);
    expect(paused.error).toBeNull();
    expect(paused.data.ended).toEqual([expect.objectContaining({ machine_id: drill, end_reason: "paused" })]);
    expect(await openOn(drill)).toEqual([]);
    expect((await start(as.workshop, { p_job: job.id, p_machines: [drill] })).error?.code).toBe("P0002");
    const other = await newJob();
    expect((await start(as.admin, { p_job: other.id, p_machines: [drill], p_override: true, p_reason: "Try the old drill" })).error?.code).toBe("P0002");
    expect(await openOn(drill)).toEqual([]);
    // Retired with the run open, then finished: finish_job ends it.
    const drill2 = await newMachine("MR Drill 2");
    expect((await start(as.workshop, { p_job: other.id, p_machines: [drill2] })).error).toBeNull();
    expect((await adminClient().from("machines").update({ active: false }).eq("id", drill2)).error).toBeNull();
    const finished = await finish(as.workshop, other.id, null, randomUUID());
    expect(finished.error).toBeNull();
    expect(finished.data.ended).toEqual([expect.objectContaining({ machine_id: drill2, end_reason: "finished" })]);
    expect(await openOn(drill2)).toEqual([]);
  });

  it("no money in any M3 answer the workshop or viewer gets (machines_in_use, assignable_people, start, pause, finish, assign)", async () => {
    const MONEY = /(^|_)(price|prices|value|values|cost|costs|amount|total|totals|vat|net|gross|margin|rate)(_|$)/i;
    const keysOf = (x: unknown): string[] => (Array.isArray(x) ? x.flatMap(keysOf) : x && typeof x === "object" ? Object.entries(x).flatMap(([k, v]) => [k, ...keysOf(v)]) : []);
    const job = await newJob({ bookMill: true });
    await adminClient().from("job_values").upsert({ job_id: job.id, organization_id: world.tenants.alpha.id, value: 999 });
    const answers: [string, { data: unknown; error: unknown }][] = [];
    answers.push(["start", await start(as.workshop, { p_job: job.id, p_machines: [mill] })]);
    for (const role of ["workshop", "viewer"]) {
      answers.push([`${role} machines_in_use`, await as[role].rpc("machines_in_use")]);
      answers.push([`${role} assignable_people`, await as[role].rpc("assignable_people")]);
      answers.push([`${role} machine_runs`, await as[role].from("machine_runs").select("*").eq("job_id", job.id)]);
      answers.push([`${role} jobs`, await as[role].from("jobs").select("*").eq("id", job.id)]);
    }
    answers.push(["assign", await assign(as.workshop, job.id, world.tenants.alpha.users.workshop.id)]);
    answers.push(["pause", await pause(as.workshop, job.id)]);
    answers.push(["finish", await finish(as.workshop, job.id, null, randomUUID())]);
    for (const [name, r] of answers) expect(keysOf(r.error ? null : r.data).filter((k) => MONEY.test(k)), name).toEqual([]);
    expect(answers.filter(([name]) => !name.startsWith("viewer")).every(([, r]) => r.error === null)).toBe(true);
    expect((await as.workshop.from("job_values").select("value").eq("job_id", job.id)).data ?? []).toEqual([]);
    expect((await as.viewer.from("job_values").select("value").eq("job_id", job.id)).data ?? []).toEqual([]);
  });
});

describe("history stays valid when device times arrive late (exclusion constraint + time conflicts)", () => {
  const newMachine = async (name: string) => (await adminClient().from("machines").insert({ organization_id: world.tenants.alpha.id, name: `${name} ${world.runId}`, active: true }).select("id").single()).data!.id as string;
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
  const timeline = async (machine: string) => (await adminClient().from("machine_runs").select("id, job_id, started_at, ended_at, end_reason, device_started_at, device_ended_at").eq("machine_id", machine).order("started_at")).data!;
  /** Pairs of runs on the machine whose [started_at, ended_at) intervals overlap (an open run reaches to infinity). */
  const overlaps = (machine: string) => withDb(async (db) => (await db.query(
    "select a.id, b.id from public.machine_runs a join public.machine_runs b on a.machine_id = b.machine_id and a.id < b.id and tstzrange(a.started_at, a.ended_at, '[)') && tstzrange(b.started_at, b.ended_at, '[)') where a.machine_id = $1", [machine])).rows);

  it("a Start replayed with a time before a completed run on the machine: the device time is kept aside, the run starts at the server's time, the answer and the audit say so; valid device times are kept exactly", async () => {
    const m = await newMachine("MR Hist mill");
    const [a, b, c] = [await newJob(), await newJob(), await newJob()];
    const [tA, tAend, tB, tBend, tC] = [ago(3), ago(2), ago(1.5), ago(1), ago(2.5)];
    // Valid device times on the machine's timeline are honoured to the millisecond.
    expect((await start(as.workshop, { p_job: a.id, p_machines: [m], p_client_op_id: randomUUID(), p_started_at: tA })).data.time_conflicts).toEqual([]);
    expect((await pause(as.workshop, a.id, null, { p_client_op_id: randomUUID(), p_ended_at: tAend })).data.time_conflicts).toEqual([]);
    expect((await start(as.workshop, { p_job: b.id, p_machines: [m], p_client_op_id: randomUUID(), p_started_at: tB })).error).toBeNull();
    expect((await pause(as.workshop, b.id, null, { p_client_op_id: randomUUID(), p_ended_at: tBend })).error).toBeNull();
    expect((await timeline(m)).map((r) => [r.job_id, iso(r.started_at), iso(r.ended_at), r.device_started_at, r.device_ended_at])).toEqual([[a.id, tA, tAend, null, null], [b.id, tB, tBend, null, null]]);
    // C was started offline 2.5 h ago (inside A's run, before B's): honouring it would overlap both. Server time, recorded.
    const replayed = await start(as.workshop, { p_job: c.id, p_machines: [m], p_client_op_id: randomUUID(), p_started_at: tC });
    expect(replayed.error).toBeNull();
    expect(replayed.data.time_conflicts).toEqual([expect.objectContaining({ machine_id: m, what: "start", why: "before_last_run_end", device_at: expect.any(String), used_at: expect.any(String) })]);
    expect(iso(replayed.data.time_conflicts[0].device_at)).toBe(tC);
    expect(iso(replayed.data.time_conflicts[0].run_until)).toBe(tBend);
    const cRun = (await timeline(m)).find((r) => r.job_id === c.id)!;
    expect(iso(cRun.device_started_at)).toBe(tC);
    expect(new Date(cRun.started_at).getTime()).toBeGreaterThanOrEqual(new Date(tBend).getTime());
    expect(iso(cRun.started_at)).toBe(iso(replayed.data.time_conflicts[0].used_at));
    const conflict = (await audit(c.id, "MACHINE_RUN_TIME_CONFLICT")).rows;
    expect(conflict).toHaveLength(1);
    expect(conflict[0].metadata).toMatchObject({ operation: "start", actor_user_id: world.tenants.alpha.users.workshop.id, time_conflicts: [expect.objectContaining({ machine_id: m, why: "before_last_run_end" })] });
    expect((await audit(c.id, "START_MACHINE_RUN")).rows[0].metadata.time_conflicts).toHaveLength(1);
    // A Pause with a device time before C's run started (ended_at < started_at): never written as such, never made zero-length silently.
    const early = await pause(as.workshop, c.id, null, { p_client_op_id: randomUUID(), p_ended_at: ago(2.8) });
    expect(early.error).toBeNull();
    expect(early.data.time_conflicts).toEqual([expect.objectContaining({ run_id: cRun.id, what: "end", why: "before_run_start" })]);
    const cEnded = (await timeline(m)).find((r) => r.job_id === c.id)!;
    expect(new Date(cEnded.ended_at!).getTime()).toBeGreaterThanOrEqual(new Date(cEnded.started_at).getTime());
    expect(iso(cEnded.device_ended_at)).toBe(iso(early.data.time_conflicts[0].device_at));
    expect((await audit(c.id, "MACHINE_RUN_TIME_CONFLICT")).rows.map((r) => r.metadata.operation)).toEqual(["start", "pause"]);
    expect(await overlaps(m)).toEqual([]);
    // The table itself refuses what the functions avoid: an end before the start (check), a closed run overlapping history (exclusion),
    // and stretching a run over its neighbour; whoever writes (here the owner, past every grant).
    const [aRun] = await timeline(m);
    const codes = await withDb(async (db) => {
      const attempt = (text: string, params: unknown[]) => db.query(text, params).then(() => "ok", (e: { code?: string }) => e.code);
      return [
        await attempt("update public.machine_runs set ended_at = started_at - interval '1 minute' where id = $1", [aRun.id]),
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at, ended_at, end_reason) values ($1, $2, $3, $4, $5, 'paused')", [world.tenants.alpha.id, c.id, m, ago(2.9), ago(2.7)]),
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at, ended_at, end_reason) values ($1, $2, $3, $4, $5, 'paused')", [world.tenants.alpha.id, c.id, m, ago(0.5), ago(0.6)]),
        await attempt("update public.machine_runs set ended_at = $2 where id = $1", [aRun.id, ago(1.2)]),
        await attempt("update public.machine_runs set started_at = $2 where id = $1", [aRun.id, ago(4)]),
      ];
    });
    expect(codes).toEqual(["23514", "23P01", "23514", "23P01", "ok"]);
    await withDb((db) => db.query("update public.machine_runs set started_at = $2 where id = $1", [aRun.id, tA]));
    expect(await overlaps(m)).toEqual([]);
  });

  it("an admin's take-over with a time before the displaced run started: the displaced run is not rewritten; both meet at the server's time, recorded; a valid earlier take-over time is kept", async () => {
    const m = await newMachine("MR Hist lathe");
    const [a, b] = [await newJob(), await newJob()];
    expect((await start(as.workshop, { p_job: a.id, p_machines: [m] })).error).toBeNull();
    const [aRun] = await timeline(m);
    const device = ago(1);
    const took = await start(as.admin, { p_job: b.id, p_machines: [m], p_client_op_id: randomUUID(), p_started_at: device, p_override: true, p_reason: "Offline take-over" });
    expect(took.error).toBeNull();
    expect(took.data.time_conflicts).toEqual([expect.objectContaining({ machine_id: m, why: "before_displaced_run_start", run_id: aRun.id })]);
    const [aAfter, bRun] = await timeline(m);
    expect(aAfter).toMatchObject({ id: aRun.id, end_reason: "override", started_at: aRun.started_at, device_ended_at: null });
    expect(new Date(aAfter.ended_at!).getTime()).toBeGreaterThan(new Date(aAfter.started_at).getTime());
    expect(bRun).toMatchObject({ job_id: b.id, started_at: aAfter.ended_at, ended_at: null });
    expect(iso(bRun.device_started_at)).toBe(device);
    const events = await audit(b.id, "OVERRIDE_MACHINE_IN_USE");
    expect(events.rows[0].metadata.time_conflicts).toEqual([expect.objectContaining({ why: "before_displaced_run_start" })]);
    expect((await audit(b.id, "MACHINE_RUN_TIME_CONFLICT")).rows).toHaveLength(1);
    expect(await overlaps(m)).toEqual([]);
    expect((await pause(as.admin, b.id)).error).toBeNull();
    // A take-over whose device time is after the holder's start is honoured exactly: the holder ends there, the new run starts there.
    const m2 = await newMachine("MR Hist saw");
    const [c, d] = [await newJob(), await newJob()];
    expect((await start(as.workshop, { p_job: c.id, p_machines: [m2], p_started_at: ago(2) })).error).toBeNull();
    const at = ago(1);
    const valid = await start(as.admin, { p_job: d.id, p_machines: [m2], p_started_at: at, p_override: true, p_reason: "Rush order D" });
    expect(valid.data.time_conflicts).toEqual([]);
    expect((await timeline(m2)).map((r) => [r.job_id, iso(r.ended_at), r.device_started_at, r.device_ended_at])).toEqual([[c.id, at, null, null], [d.id, null, null, null]]);
    expect((await pause(as.admin, d.id)).error).toBeNull();
  });

  it("machine time is the union of a machine's runs: overlapping intervals count once; per machine in a window; the company's own machines only", async () => {
    const union = await withDb(async (db) => (await db.query(`select
        public.tstz_union_hours(array[tstzrange('2026-03-02 08:00Z', '2026-03-02 10:00Z'), tstzrange('2026-03-02 09:00Z', '2026-03-02 11:00Z'),
          tstzrange('2026-03-02 12:00Z', '2026-03-02 13:00Z'), tstzrange('2026-03-02 12:30Z', '2026-03-02 12:45Z'), 'empty'::tstzrange, null]) as u,
        (select round(sum(extract(epoch from upper(r) - lower(r))) / 3600.0, 2) from unnest(array[tstzrange('2026-03-02 08:00Z', '2026-03-02 10:00Z'), tstzrange('2026-03-02 09:00Z', '2026-03-02 11:00Z'),
          tstzrange('2026-03-02 12:00Z', '2026-03-02 13:00Z'), tstzrange('2026-03-02 12:30Z', '2026-03-02 12:45Z')]) r) as s,
        public.tstz_union_hours(array[]::tstzrange[]) as none`)).rows[0]);
    expect([Number(union.u), Number(union.s), Number(union.none)]).toEqual([4, 5.25, 0]); // the plain sum would say 5.25
    // Two machines, one job on both at once, and two jobs one after the other on the first: hours per machine, clipped to the window.
    const [m1, m2] = [await newMachine("MR Union mill"), await newMachine("MR Union lathe")];
    const [a, b] = [await newJob(), await newJob()];
    expect((await start(as.workshop, { p_job: a.id, p_machines: [m1, m2], p_started_at: ago(5) })).error).toBeNull();
    expect((await pause(as.workshop, a.id, null, { p_ended_at: ago(3) })).error).toBeNull();
    expect((await start(as.workshop, { p_job: b.id, p_machines: [m1], p_started_at: ago(3) })).error).toBeNull();
    expect((await pause(as.workshop, b.id, null, { p_ended_at: ago(2) })).error).toBeNull();
    const { data, error } = await as.viewer.rpc("machine_time", { p_from: ago(4), p_to: ago(1) });
    expect(error).toBeNull();
    const mine = (data as { machine_id: string; hours: number; runs: number }[]).filter((r) => r.machine_id === m1 || r.machine_id === m2);
    expect(mine.map((r) => [r.machine_id, Number(r.hours), r.runs]).sort()).toEqual([[m1, 2, 2], [m2, 1, 1]].sort());
    expect(((await as.betaAdmin.rpc("machine_time", { p_from: ago(4), p_to: ago(1) })).data as { machine_id: string }[]).filter((r) => r.machine_id === m1)).toEqual([]);
    expect((await as.viewer.rpc("machine_time", { p_from: ago(1), p_to: ago(4) })).error?.code).toBe("22023");
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    expect((await anon.rpc("machine_time", { p_from: ago(4), p_to: ago(1) })).error).not.toBeNull();
    expect((await as.admin.rpc("tstz_union_hours", { p_ranges: [] })).error).not.toBeNull();
  });
});

describe("replay of a client operation that no run records (machine_run_ops)", () => {
  const newMachine = async (name: string) => (await adminClient().from("machines").insert({ organization_id: world.tenants.alpha.id, name: `${name} ${world.runId}`, active: true }).select("id").single()).data!.id as string;
  const counts = async (job: string) => ({
    runs: await runs(job),
    starts: (await audit(job, "START_MACHINE_RUN")).rows.length,
    pauses: (await audit(job, "PAUSE_MACHINE_RUN")).rows.length,
  });

  it("a machine-less Start replayed after a later Start on a machine: the first answer, no run made or ended", async () => {
    const m = await newMachine("MR Ops mill");
    const job = await newJob();
    const op = randomUUID();
    const first = await start(as.workshop, { p_job: job.id, p_machines: [], p_client_op_id: op });
    expect(first.error).toBeNull();
    expect(first.data.runs).toEqual([]);
    expect((await start(as.workshop, { p_job: job.id, p_machines: [m], p_client_op_id: randomUUID() })).error).toBeNull();
    const before = await counts(job.id);
    // The bench run the machine-less Start opened (046) ended when the work moved to the machine; only the machine run is open.
    expect(before.runs.filter((r) => r.ended_at === null).map((r) => r.machine_id)).toEqual([m]);
    expect(before.runs.filter((r) => r.machine_id === null).map((r) => r.end_reason)).toEqual(["to_machine"]);
    const replay = await start(as.workshop, { p_job: job.id, p_machines: [], p_client_op_id: op });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({ ...first.data, replayed: true });
    // 049 (R3.1): the same key naming a machine (a client fault), or sent by another person, is refused: nothing is made.
    for (const [who, machines] of [["workshop", [m]], ["admin", []], ["admin", [m]]] as const) {
      const refused = await start(as[who], { p_job: job.id, p_machines: [...machines], p_client_op_id: op });
      expect(refused.error?.hint).toBe("client_op_reused");
    }
    expect(await counts(job.id)).toEqual(before);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });

  it("a Pause that ended nothing, replayed after a later Start: the first answer (nothing ended), the later run stays open", async () => {
    const m = await newMachine("MR Ops lathe");
    const job = await newJob();
    const op = randomUUID();
    const first = await pause(as.workshop, job.id, null, { p_client_op_id: op });
    expect(first.error).toBeNull();
    expect(first.data).toEqual({ job_id: job.id, ended: [], time_conflicts: [], replayed: false });
    expect((await start(as.workshop, { p_job: job.id, p_machines: [m], p_client_op_id: randomUUID() })).error).toBeNull();
    const before = await counts(job.id);
    expect(before.runs.filter((r) => r.ended_at === null)).toHaveLength(1);
    for (let i = 0; i < 2; i += 1) {
      const replay = await pause(as.workshop, job.id, null, { p_client_op_id: op });
      expect(replay.error).toBeNull();
      expect(replay.data).toEqual({ ...first.data, replayed: true });
    }
    expect(await counts(job.id)).toEqual(before);
    expect(await openOn(m)).toEqual([{ id: expect.any(String), job_id: job.id }]);
    // A key is one operation: a Start's key sent as a Pause (or the other way round), or for another job, is refused.
    const startKey = randomUUID();
    expect((await start(as.workshop, { p_job: job.id, p_machines: [], p_client_op_id: startKey })).error).toBeNull();
    expect((await pause(as.workshop, job.id, null, { p_client_op_id: startKey })).error?.hint).toBe("client_op_reused");
    expect((await start(as.workshop, { p_job: job.id, p_machines: [], p_client_op_id: op })).error?.hint).toBe("client_op_reused");
    const other = await newJob();
    expect((await pause(as.workshop, other.id, null, { p_client_op_id: op })).error?.hint).toBe("client_op_reused");
    expect(await openOn(m)).toHaveLength(1);
    // The stored answers are the functions' alone: no API role reads or writes them.
    for (const role of ["admin", "workshop", "viewer"]) {
      expect((await as[role].from("machine_run_ops").select("client_op_id").eq("client_op_id", op)).error).not.toBeNull();
      expect((await as[role].from("machine_run_ops").insert({ organization_id: world.tenants.alpha.id, client_op_id: randomUUID(), kind: "pause", job_id: job.id, result: {} })).error).not.toBeNull();
    }
    const stored = await withDb(async (db) => (await db.query("select kind, job_id, result from public.machine_run_ops where client_op_id = $1", [op])).rows);
    expect(stored).toEqual([{ kind: "pause", job_id: job.id, result: first.data }]);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });
});

describe("verify script", () => {
  it("is clean on the test stack", async () => {
    const text = readFileSync(path.join(__dirname, "../../supabase/verify/machine_runs.sql"), "utf8");
    const rows = await withDb((db) => db.query<{ n: number; check_name: string; value: string; expected: string }>(text));
    const facts = rows.rows.filter((r) => r.expected === "true");
    expect(facts.length).toBeGreaterThanOrEqual(9);
    expect(facts.filter((r) => r.value !== "true")).toEqual([]);
  });
});
