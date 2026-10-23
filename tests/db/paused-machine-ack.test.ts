/**
 * Migration 049 (plan: docs/packets/job-board-ux-plan.md, R3.1, R3.2, R2.6, R3.7, R3.6 D1a), through the real API path (Supabase Auth +
 * PostgREST, signed-in synthetic users):
 *
 *   * the warning rule: a machine's current paused run (its latest run, paused, on another unfinished job with nothing open), and when
 *     the warning stops (finished, resumed elsewhere, another run on the machine since, same job, bench runs never count);
 *   * a Start's acknowledgements: matched, superseded and missing, with the exact START_OVER_PAUSED_JOB fields; an ack for a machine that
 *     is no longer paused writes nothing; never a refusal because a machine is paused;
 *   * forged references, each refused with the same 22023 paused_ack_invalid and nothing written;
 *   * a used key with a changed payload (Start and booking) refused with client_op_reused; another company's identical key gets its own
 *     answer; an identical replay answers the stored result with no second event; a pre-049 row (no hash) replays for its own person;
 *   * the explicit bench Start (p_bench), the authorisation matrix, the compatibility of the previous build's 6-argument calls (D1a), and
 *     the read-only verify script.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generatePassword } from "@/lib/password";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, setRequireAdminMfaForTest, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";
import { drain86bb660, executor86bb660 } from "../fixtures/offline/sync-86bb660";
import { enqueue, rejectedEntries, type RunPauseOp, type RunStartOp } from "@/lib/offline/outbox";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";
import { enrolTotp, passSecondStep } from "../support/totp";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let n = 0;

type StartOver = { p_machines?: string[]; p_client_op_id?: string | null; p_started_at?: string | null; p_paused_ack?: unknown; p_bench?: boolean; p_override?: boolean; p_reason?: string | null };
/** The new build's call: the six 046 arguments, plus p_paused_ack / p_bench only when given. */
const start = (client: SupabaseClient, job: string, over: StartOver = {}) =>
  client.rpc("start_machine_run", { p_job: job, p_machines: [], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null, ...over });
const pause = (client: SupabaseClient, job: string) => client.rpc("pause_machine_run", { p_job: job, p_machines: null, p_client_op_id: null, p_ended_at: null });
const finish = (client: SupabaseClient, job: string) => client.rpc("finish_job", { p_job: job, p_client_op_id: null, p_finished_at: null });
const ack = (client: SupabaseClient, machine: string, run: string, job: string, key: string) =>
  client.rpc("acknowledge_paused_machine", { p_machine: machine, p_paused_run: run, p_job: job, p_client_op_id: key });
const runs = async (job: string) => (await adminClient().from("machine_runs").select("id, machine_id, ended_at, end_reason").eq("job_id", job).order("started_at").order("created_at")).data!;
const audit = async (job: string, action: string) => withDb(async (db) => (await db.query<{ metadata: Record<string, unknown> }>(
  "select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2 order by created_at, id", [job, action])).rows.map((r) => r.metadata));
const paused = async (client: SupabaseClient) => {
  const { data, error } = await client.rpc("paused_machines");
  if (error) throw new Error(error.message);
  return data as { machine_id: string; paused_run_id: string; job_id: string; job_no: string; operator_name: string | null; paused_by_name: string | null; paused_at: string }[];
};
const pausedOn = async (client: SupabaseClient, machine: string) => (await paused(client)).filter((r) => r.machine_id === machine);
const machine = (name: string, org = world.tenants.alpha.id) => adminClient().from("machines").insert({ organization_id: org, name: `${name} ${world.runId} ${++n}`, active: true }).select("id, name").single().then((r) => r.data! as { id: string; name: string });
const ok = <T>(result: { data: T; error: { message: string } | null }, what: string) => {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
};

async function newJob(client: SupabaseClient = as.admin) {
  n += 1;
  const data = ok(await client.rpc("create_job", { p_customer: "Ack Co", p_description: `Ack job ${n}`, p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null }), "create_job") as { job_id: string; job_no: string };
  return { id: data.job_id, no: data.job_no };
}
/** A job started on `m` by the workshop operator and paused by `by`: m's current paused run. */
async function pausedJob(m: string, by: SupabaseClient = as.workshop) {
  const job = await newJob();
  ok(await start(as.workshop, job.id, { p_machines: [m] }), "start");
  ok(await pause(by, job.id), "pause");
  const run = (await runs(job.id)).find((r) => r.machine_id === m && r.end_reason === "paused")!;
  return { ...job, run: run.id };
}
const refusal = (r: { error: { code?: string; hint?: string | null; message: string; details?: string | null } | null }) => r.error && { code: r.error.code, hint: r.error.hint, message: r.error.message };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  as.betaWorkshop = await signedInClient(world.tenants.beta.users.workshop);
  await adminClient().from("user_profiles").update({ full_name: "Dave Operator" }).eq("id", world.tenants.alpha.users.workshop.id);
  await adminClient().from("user_profiles").update({ full_name: "Olive Office" }).eq("id", world.tenants.alpha.users.office.id);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("the warning rule (paused_machine_current, paused_machines)", () => {
  it("lists a machine whose last run was paused on another unfinished job, by display name; the warning stops when it should", async () => {
    const mill = await machine("Ack Mill");
    const a = await pausedJob(mill.id, as.office);
    expect(await pausedOn(as.workshop, mill.id)).toEqual([{ machine_id: mill.id, paused_run_id: a.run, job_id: a.id, job_no: a.no, operator_name: "Dave Operator", paused_by_name: "Olive Office", paused_at: expect.any(String) }]);
    // Read by all four roles, the caller's company only.
    for (const role of ["admin", "office", "viewer"]) expect(await pausedOn(as[role], mill.id)).toHaveLength(1);
    expect(JSON.stringify(await paused(as.betaAdmin))).not.toContain(mill.id);
    // Same job resuming: no warning, no event.
    const resumed = ok(await start(as.workshop, a.id, { p_machines: [mill.id] }), "resume") as { paused_warnings: unknown[] };
    expect(resumed.paused_warnings).toEqual([]);
    expect(await audit(a.id, "START_OVER_PAUSED_JOB")).toEqual([]);
    expect(await pausedOn(as.workshop, mill.id)).toEqual([]); // in use now
    ok(await pause(as.workshop, a.id), "pause again");
    // Finished: no longer paused.
    ok(await finish(as.workshop, a.id), "finish");
    expect(await pausedOn(as.workshop, mill.id)).toEqual([]);
  });

  it("stops when the paused job is resumed elsewhere or another run on the machine happened since; bench runs never count", async () => {
    const [mill, lathe] = [await machine("Ack Mill2"), await machine("Ack Lathe")];
    const a = await pausedJob(mill.id);
    expect(await pausedOn(as.office, mill.id)).toHaveLength(1);
    ok(await start(as.workshop, a.id, { p_machines: [lathe.id] }), "resume on the lathe");
    expect(await pausedOn(as.office, mill.id)).toEqual([]); // a has an open run elsewhere
    ok(await pause(as.workshop, a.id), "pause");
    // Both machines' last runs are now a's pauses.
    expect((await pausedOn(as.office, mill.id)).map((r) => r.job_id)).toEqual([a.id]);
    // Another job runs on the mill (confirmed) and finishes: the mill's last run is that one, so no warning about a any more.
    const b = await newJob();
    ok(await start(as.workshop, b.id, { p_machines: [mill.id], p_paused_ack: [{ machine_id: mill.id, paused_run_id: (await pausedOn(as.workshop, mill.id))[0].paused_run_id }] }), "b on the mill");
    ok(await finish(as.workshop, b.id), "finish b");
    expect(await pausedOn(as.office, mill.id)).toEqual([]);
    // A bench job paused: no machine is listed for it.
    const bench = await newJob();
    ok(await start(as.workshop, bench.id, { p_bench: true }), "bench start");
    ok(await pause(as.workshop, bench.id), "bench pause");
    expect((await paused(as.office)).some((r) => r.job_id === bench.id)).toBe(false);
  });

  it("never shows an e-mail as a name", async () => {
    const saw = await machine("Ack Saw");
    await adminClient().from("user_profiles").update({ full_name: "office@example.test" }).eq("id", world.tenants.alpha.users.office.id);
    try {
      await pausedJob(saw.id, as.office);
      expect((await pausedOn(as.workshop, saw.id))[0].paused_by_name).toBeNull();
    } finally {
      await adminClient().from("user_profiles").update({ full_name: "Olive Office" }).eq("id", world.tenants.alpha.users.office.id);
    }
  });
});

describe("a Start over a paused machine (R3.1)", () => {
  it("acknowledged: one event with every field, no warning in the answer", async () => {
    const mill = await machine("Ack MillA");
    const a = await pausedJob(mill.id, as.office);
    const b = await newJob();
    const key = randomUUID();
    const answer = ok(await start(as.office, b.id, { p_machines: [mill.id], p_client_op_id: key, p_paused_ack: [{ machine_id: mill.id, paused_run_id: a.run }] }), "start") as { paused_warnings: unknown[]; runs: unknown[] };
    expect(answer.paused_warnings).toEqual([]);
    expect(answer.runs).toHaveLength(1);
    expect(await audit(b.id, "START_OVER_PAUSED_JOB")).toEqual([expect.objectContaining({
      machine_id: mill.id, paused_run_id: a.run, paused_job_id: a.id, paused_job_no: a.no, operator_name: "Dave Operator", paused_by_name: "Olive Office",
      paused_at: expect.any(String), acknowledged: true, superseded: false, acknowledged_run_id: a.run, client_op_id: key, actor_user_id: world.tenants.alpha.users.office.id, at: expect.any(String),
    })]);
  });

  it("superseded (re-paused in between) and missing: recorded unacknowledged, the current run answered under paused_warnings; never refused", async () => {
    const mill = await machine("Ack MillB");
    const a = await pausedJob(mill.id);
    ok(await start(as.workshop, a.id, { p_machines: [mill.id] }), "resume");
    ok(await pause(as.workshop, a.id), "re-pause");
    const current = (await pausedOn(as.workshop, mill.id))[0].paused_run_id;
    expect(current).not.toBe(a.run);
    const b = await newJob();
    const answer = ok(await start(as.workshop, b.id, { p_machines: [mill.id], p_paused_ack: [{ machine_id: mill.id, paused_run_id: a.run }] }), "superseded") as { paused_warnings: { paused_run_id: string; job_no: string }[] };
    expect(answer.paused_warnings).toEqual([expect.objectContaining({ machine_id: mill.id, paused_run_id: current, job_no: a.no, operator_name: "Dave Operator" })]);
    expect(await audit(b.id, "START_OVER_PAUSED_JOB")).toEqual([expect.objectContaining({ paused_run_id: current, acknowledged: false, superseded: true, acknowledged_run_id: a.run })]);

    const lathe = await machine("Ack LatheB");
    const c = await pausedJob(lathe.id);
    const d = await newJob();
    const missing = ok(await start(as.workshop, d.id, { p_machines: [lathe.id] }), "missing") as { paused_warnings: { paused_run_id: string }[] };
    expect(missing.paused_warnings.map((w) => w.paused_run_id)).toEqual([c.run]);
    expect(await audit(d.id, "START_OVER_PAUSED_JOB")).toEqual([expect.objectContaining({ paused_run_id: c.run, acknowledged: false, superseded: false, acknowledged_run_id: null })]);
  });

  it("an ack for a machine that is no longer paused (resumed elsewhere) writes nothing", async () => {
    const [mill, lathe] = [await machine("Ack MillC"), await machine("Ack LatheC")];
    const a = await pausedJob(mill.id);
    ok(await start(as.workshop, a.id, { p_machines: [lathe.id] }), "a resumes on the lathe");
    const b = await newJob();
    const answer = ok(await start(as.workshop, b.id, { p_machines: [mill.id], p_paused_ack: [{ machine_id: mill.id, paused_run_id: a.run }] }), "start") as { paused_warnings: unknown[] };
    expect(answer.paused_warnings).toEqual([]);
    expect(await audit(b.id, "START_OVER_PAUSED_JOB")).toEqual([]);
  });

  it("an identical replay answers the stored result (with its warnings) and writes no second event", async () => {
    const mill = await machine("Ack MillD");
    await pausedJob(mill.id);
    const b = await newJob();
    const args = { p_machines: [mill.id], p_client_op_id: randomUUID(), p_started_at: new Date(Date.now() - 60_000).toISOString() };
    const first = ok(await start(as.workshop, b.id, args), "first") as Record<string, unknown>;
    const again = ok(await start(as.workshop, b.id, args), "replay");
    expect(again).toEqual({ ...first, replayed: true });
    expect(await audit(b.id, "START_OVER_PAUSED_JOB")).toHaveLength(1);
    expect(await audit(b.id, "START_MACHINE_RUN")).toHaveLength(1);
  });
});

describe("forged or malformed acknowledgements: 22023 paused_ack_invalid, nothing written", () => {
  it("each case is refused the same way and leaves no run, no start and no event", async () => {
    const [mill, lathe, saw] = [await machine("Forge Mill"), await machine("Forge Lathe"), await machine("Forge Saw")];
    const a = await pausedJob(mill.id);
    const onLathe = await pausedJob(lathe.id);
    // Runs that ended otherwise: finished, override (an admin's takeover), admin_released.
    const fin = await newJob();
    ok(await start(as.workshop, fin.id, { p_machines: [saw.id] }), "fin start");
    ok(await finish(as.workshop, fin.id), "finish");
    const finishedRun = (await runs(fin.id))[0].id;
    const victim = await newJob();
    ok(await start(as.workshop, victim.id, { p_machines: [saw.id] }), "victim");
    const taker = await newJob();
    ok(await start(as.admin, taker.id, { p_machines: [saw.id], p_override: true, p_reason: "Urgent job" }), "takeover");
    const overrideRun = (await runs(victim.id))[0].id;
    ok(await as.admin.rpc("release_machine", { p_machine: saw.id, p_reason: "Forgotten run" }), "release");
    const releasedRun = (await runs(taker.id))[0].id;
    const bench = await newJob();
    ok(await start(as.workshop, bench.id, { p_bench: true }), "bench");
    ok(await pause(as.workshop, bench.id), "bench pause");
    const benchRun = (await runs(bench.id))[0].id;
    const betaMachine = await machine("Beta Forge Mill", world.tenants.beta.id);
    const betaJob = ok(await as.betaAdmin.rpc("create_job", { p_customer: "Beta", p_description: "x", p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null }), "beta job") as { job_id: string };
    ok(await start(as.betaWorkshop, betaJob.job_id, { p_machines: [betaMachine.id] }), "beta start");
    ok(await pause(as.betaWorkshop, betaJob.job_id), "beta pause");
    const betaRun = (await runs(betaJob.job_id))[0].id;

    const target = await newJob();
    const m = mill.id;
    const cases: [string, StartOver, number][] = [
      ["a run of another company", { p_machines: [m], p_paused_ack: [{ machine_id: m, paused_run_id: betaRun }] }, 0],
      ["a run of this company on another machine", { p_machines: [m], p_paused_ack: [{ machine_id: m, paused_run_id: onLathe.run }] }, 0],
      ["a bench run", { p_machines: [m], p_paused_ack: [{ machine_id: m, paused_run_id: benchRun }] }, 0],
      ["a finished run", { p_machines: [saw.id], p_paused_ack: [{ machine_id: saw.id, paused_run_id: finishedRun }] }, 0],
      ["an override run", { p_machines: [saw.id], p_paused_ack: [{ machine_id: saw.id, paused_run_id: overrideRun }] }, 0],
      ["an admin_released run", { p_machines: [saw.id], p_paused_ack: [{ machine_id: saw.id, paused_run_id: releasedRun }] }, 0],
      ["a random UUID", { p_machines: [m], p_paused_ack: [{ machine_id: m, paused_run_id: randomUUID() }] }, 0],
      ["an ack machine not in p_machines", { p_machines: [m], p_paused_ack: [{ machine_id: m, paused_run_id: a.run }, { machine_id: lathe.id, paused_run_id: onLathe.run }] }, 1],
      ["the same machine twice", { p_machines: [m], p_paused_ack: [{ machine_id: m, paused_run_id: a.run }, { machine_id: m, paused_run_id: a.run }] }, 1],
      ["11 entries", { p_machines: [m], p_paused_ack: Array.from({ length: 11 }, () => ({ machine_id: randomUUID(), paused_run_id: randomUUID() })) }, 10],
      ["a non-UUID", { p_machines: [m], p_paused_ack: [{ machine_id: m, paused_run_id: "not-a-uuid" }] }, 0],
      ["a missing field", { p_machines: [m], p_paused_ack: [{ machine_id: m }] }, 0],
      ["an extra field", { p_machines: [m], p_paused_ack: [{ machine_id: m, paused_run_id: a.run, note: "x" }] }, 0],
      ["not an array", { p_machines: [m], p_paused_ack: { machine_id: m, paused_run_id: a.run } }, 0],
    ];
    const messages = new Set<string>();
    for (const [name, over, index] of cases) {
      const r = await start(as.workshop, target.id, { ...over, p_client_op_id: randomUUID() });
      expect({ name, code: r.error?.code, hint: r.error?.hint }).toEqual({ name, code: "22023", hint: "paused_ack_invalid" });
      expect({ name, detail: JSON.parse(r.error?.details ?? "null") }).toEqual({ name, detail: { index } });
      messages.add(r.error!.message);
    }
    expect(messages.size).toBe(1); // nothing tells a run of another company apart from a random id
    const bench2 = await start(as.workshop, target.id, { p_machines: [m], p_bench: true });
    expect(refusal(bench2)).toMatchObject({ code: "22023", hint: "bench_with_machines" });
    expect(await runs(target.id)).toEqual([]);
    expect((await adminClient().from("jobs").select("started_at").eq("id", target.id).single()).data!.started_at).toBeNull();
    expect(await audit(target.id, "START_OVER_PAUSED_JOB")).toEqual([]);
    expect(await withDb(async (db) => (await db.query("select count(*)::int as c from public.machine_run_ops where job_id = $1", [target.id])).rows[0].c)).toBe(0);
  });
});

describe("a used key with a changed payload: client_op_reused, nothing written", () => {
  it("Start: other machines, another ack run, p_bench added, another started_at, another person of the company", async () => {
    const [mill, lathe] = [await machine("Key Mill"), await machine("Key Lathe")];
    const a = await pausedJob(mill.id);
    ok(await start(as.workshop, a.id, { p_machines: [mill.id] }), "resume");
    ok(await pause(as.workshop, a.id), "re-pause");
    const job = await newJob();
    const key = randomUUID();
    const at = new Date(Date.now() - 120_000).toISOString();
    const base = { p_machines: [mill.id], p_client_op_id: key, p_started_at: at, p_paused_ack: [{ machine_id: mill.id, paused_run_id: (await pausedOn(as.workshop, mill.id))[0].paused_run_id }] };
    const first = ok(await start(as.workshop, job.id, base), "first") as Record<string, unknown>;
    const before = { runs: await runs(job.id), events: await audit(job.id, "START_OVER_PAUSED_JOB") };
    const changed: [string, SupabaseClient, StartOver][] = [
      ["other machines", as.workshop, { ...base, p_machines: [mill.id, lathe.id] }],
      ["another ack run", as.workshop, { ...base, p_paused_ack: [{ machine_id: mill.id, paused_run_id: a.run }] }],
      ["p_bench added", as.workshop, { ...base, p_machines: [], p_paused_ack: null, p_bench: true }],
      ["another started_at", as.workshop, { ...base, p_started_at: new Date(Date.now() - 60_000).toISOString() }],
      ["another person", as.office, base],
    ];
    for (const [name, client, args] of changed) {
      const r = await start(client, job.id, args);
      expect({ name, code: r.error?.code, hint: r.error?.hint }).toEqual({ name, code: "22023", hint: "client_op_reused" });
    }
    expect({ runs: await runs(job.id), events: await audit(job.id, "START_OVER_PAUSED_JOB") }).toEqual(before);
    expect(ok(await start(as.workshop, job.id, base), "identical")).toEqual({ ...first, replayed: true });
  });

  it("the same key from another company: its own fresh answer; the first company's row untouched and not revealed", async () => {
    const key = randomUUID();
    const job = await newJob();
    const first = ok(await start(as.workshop, job.id, { p_bench: true, p_client_op_id: key }), "alpha") as Record<string, unknown>;
    const stored = await withDb(async (db) => (await db.query("select * from public.machine_run_ops where client_op_id = $1", [key])).rows);
    const betaJob = ok(await as.betaAdmin.rpc("create_job", { p_customer: "Beta", p_description: "same key", p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null }), "beta job") as { job_id: string };
    const theirs = ok(await start(as.betaWorkshop, betaJob.job_id, { p_bench: true, p_client_op_id: key }), "beta") as Record<string, unknown>;
    expect(theirs.replayed).toBe(false);
    expect(theirs.job_id).toBe(betaJob.job_id);
    expect(JSON.stringify(theirs)).not.toContain(job.id);
    expect(await withDb(async (db) => (await db.query("select * from public.machine_run_ops where client_op_id = $1 and organization_id = $2", [key, world.tenants.alpha.id])).rows)).toEqual(stored);
    expect(ok(await start(as.workshop, job.id, { p_bench: true, p_client_op_id: key }), "alpha replay")).toEqual({ ...first, replayed: true });
  });

  it("a row written before 049 (no request hash) replays on job, kind and person only", async () => {
    const job = await newJob();
    const key = randomUUID();
    const first = ok(await start(as.workshop, job.id, { p_bench: true, p_client_op_id: key }), "first") as Record<string, unknown>;
    await withDb((db) => db.query("update public.machine_run_ops set request_sha256 = null where client_op_id = $1", [key]));
    // As the previous build would send it (no p_bench): the stored answer, for its own person.
    expect(ok(await start(as.workshop, job.id, { p_client_op_id: key }), "pre-049 replay")).toEqual({ ...first, replayed: true });
    expect((await start(as.office, job.id, { p_client_op_id: key })).error?.hint).toBe("client_op_reused");
  });
});

describe("the explicit bench Start (p_bench)", () => {
  it("opens a bench run on a job started some other way (046 answered started_without_bench); 046's guards hold", async () => {
    const job = await newJob();
    await adminClient().from("jobs").update({ started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", job.id);
    const old = ok(await start(as.workshop, job.id), "046 call") as { bench_skipped: string; bench_run: unknown };
    expect(old).toMatchObject({ bench_skipped: "started_without_bench", bench_run: null });
    const bench = ok(await start(as.workshop, job.id, { p_bench: true }), "bench") as { bench_run: { already: boolean } };
    expect(bench.bench_run).toMatchObject({ already: false });
    expect((ok(await start(as.workshop, job.id, { p_bench: true }), "again") as { bench_run: { already: boolean } }).bench_run.already).toBe(true);
    ok(await pause(as.workshop, job.id), "pause");
    const mill = await machine("Bench Mill");
    ok(await start(as.workshop, job.id, { p_machines: [mill.id] }), "machine");
    expect(ok(await start(as.workshop, job.id, { p_bench: true }), "on machine")).toMatchObject({ bench_run: null, bench_skipped: "on_machine" });
  });
});

describe("booking over a paused machine (R3.2, acknowledge_paused_machine)", () => {
  it("matched, then re-paused in between: not matched with the current run, a fresh key confirms; replay and changed payloads", async () => {
    const mill = await machine("Book Mill");
    const a = await pausedJob(mill.id);
    const booking = await newJob();
    const k1 = randomUUID();
    const first = ok(await ack(as.office, mill.id, a.run, booking.id, k1), "ack") as Record<string, unknown>;
    expect(first).toEqual({ ack_id: k1, matched: true, machine_id: mill.id, acknowledged_run_id: a.run, current: expect.objectContaining({ paused_run_id: a.run, job_no: a.no }), replayed: false });
    expect(await audit(booking.id, "BOOK_OVER_PAUSED_JOB")).toEqual([expect.objectContaining({ booking_job_id: booking.id, machine_id: mill.id, paused_run_id: a.run, acknowledged: true, superseded: false, acknowledged_run_id: a.run, client_op_id: k1 })]);
    expect(ok(await ack(as.office, mill.id, a.run, booking.id, k1), "replay")).toEqual({ ...first, replayed: true });
    expect(await audit(booking.id, "BOOK_OVER_PAUSED_JOB")).toHaveLength(1);
    // Re-paused in between: the old run is not the current one any more.
    ok(await start(as.workshop, a.id, { p_machines: [mill.id] }), "resume");
    ok(await pause(as.workshop, a.id), "re-pause");
    const current = (await pausedOn(as.office, mill.id))[0].paused_run_id;
    const k2 = randomUUID();
    const stale = ok(await ack(as.office, mill.id, a.run, booking.id, k2), "stale") as { matched: boolean; current: { paused_run_id: string } };
    expect(stale).toMatchObject({ matched: false, current: { paused_run_id: current } });
    // Reusing the first key with the new run is refused; a fresh key confirms.
    expect(refusal(await ack(as.office, mill.id, current, booking.id, k1))).toMatchObject({ code: "22023", hint: "client_op_reused" });
    expect(ok(await ack(as.office, mill.id, current, booking.id, randomUUID()), "fresh")).toMatchObject({ matched: true });
    // Changed payloads under k1: another machine, run, job or person.
    const other = await newJob();
    const lathe = await machine("Book Lathe");
    for (const [name, r] of [
      ["machine", await ack(as.office, lathe.id, a.run, booking.id, k1)],
      ["run", await ack(as.office, mill.id, current, booking.id, k1)],
      ["job", await ack(as.office, mill.id, a.run, other.id, k1)],
      ["person", await ack(as.admin, mill.id, a.run, booking.id, k1)],
    ] as const) expect({ name, hint: r.error?.hint }).toEqual({ name, hint: "client_op_reused" });
  });

  it("forged runs, the same job, other company: refused; the same key in another company is its own", async () => {
    const mill = await machine("Book Forge");
    const a = await pausedJob(mill.id);
    const job = await newJob();
    expect(refusal(await ack(as.office, mill.id, randomUUID(), job.id, randomUUID()))).toMatchObject({ code: "22023", hint: "paused_ack_invalid" });
    expect(refusal(await ack(as.office, mill.id, a.run, a.id, randomUUID()))).toMatchObject({ code: "22023", hint: "paused_ack_same_job" });
    const betaMachine = await machine("Book Beta", world.tenants.beta.id);
    expect(refusal(await ack(as.office, betaMachine.id, a.run, job.id, randomUUID()))).toMatchObject({ code: "P0002", message: "Machine not found" });
    const key = randomUUID();
    ok(await ack(as.office, mill.id, a.run, job.id, key), "alpha");
    const betaJob = ok(await as.betaAdmin.rpc("create_job", { p_customer: "Beta", p_description: "book", p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null }), "beta job") as { job_id: string };
    const betaPaused = await (async () => {
      ok(await start(as.betaWorkshop, betaJob.job_id, { p_machines: [betaMachine.id] }), "beta start");
      ok(await pause(as.betaWorkshop, betaJob.job_id), "beta pause");
      return (await runs(betaJob.job_id))[0].id;
    })();
    const otherBetaJob = ok(await as.betaAdmin.rpc("create_job", { p_customer: "Beta", p_description: "book 2", p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null }), "beta job 2") as { job_id: string };
    expect(ok(await ack(as.betaAdmin, betaMachine.id, betaPaused, otherBetaJob.job_id, key), "beta same key")).toMatchObject({ matched: true, replayed: false });
  });
});

describe("authorisation (R2.6)", () => {
  it("paused_machines: the four roles read; anon refused. acknowledge_paused_machine: admin, office, workshop; viewer and anon refused", async () => {
    const mill = await machine("Auth Mill");
    const a = await pausedJob(mill.id);
    for (const role of ["admin", "office", "workshop"]) {
      const job = await newJob();
      expect(ok(await ack(as[role], mill.id, a.run, job.id, randomUUID()), role)).toMatchObject({ matched: true });
    }
    expect(await pausedOn(as.viewer, mill.id)).toHaveLength(1);
    const job = await newJob();
    expect(refusal(await ack(as.viewer, mill.id, a.run, job.id, randomUUID()))).toMatchObject({ code: "42501" });
    const { apiUrl, anonKey } = isolatedBackend();
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await anon.rpc("paused_machines")).error).not.toBeNull();
    expect((await ack(anon, mill.id, a.run, job.id, randomUUID())).error).not.toBeNull();
    expect((await start(as.viewer, job.id, { p_bench: true })).error?.code).toBe("42501");
  });

  it("a session missing the second step (admin, company requires it) and a read-only support session are refused", async () => {
    const mill = await machine("Auth Mill2");
    const a = await pausedJob(mill.id);
    const job = await newJob();
    const org = world.tenants.alpha.id;
    await setRequireAdminMfaForTest(org, true);
    try {
      const aal1 = await signedInClient(world.tenants.alpha.users.admin);
      expect(refusal(await ack(aal1, mill.id, a.run, job.id, randomUUID()))).toMatchObject({ code: "42501", hint: "mfa_required" });
      expect(refusal(await start(aal1, job.id, { p_bench: true }))).toMatchObject({ code: "42501", hint: "mfa_required" });
    } finally {
      await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = $1", [org]));
    }
    // A platform owner inside the company for support: read-only until elevated (036).
    const email = `owner.ack.${world.runId}@example.test`;
    const password = generatePassword(16);
    const made = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Owner Person" } });
    expect(made.error).toBeNull();
    expect((await adminClient().rpc("add_member", { p_org: world.tenants.beta.id, p_email: email, p_role: "viewer" })).data).toBe("member");
    await withDb(async (db) => { await db.query("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner')", [made.data.user!.id]); });
    const factor = await enrolTotp(await signedInClient({ email, password }));
    const support = await signedInClient({ email, password });
    await passSecondStep(support, factor.factorId, factor.secret);
    await support.auth.refreshSession();
    expect((await support.rpc("platform_enter_organization", { p_org: org, p_reason: "Looking at a paused machine" })).error).toBeNull();
    expect(await pausedOn(support, mill.id)).toHaveLength(1);
    expect(refusal(await ack(support, mill.id, a.run, job.id, randomUUID()))).toMatchObject({ code: "42501", hint: "support_read_only" });
    expect(await audit(job.id, "BOOK_OVER_PAUSED_JOB")).toEqual([]);
    expect(await withDb(async (db) => (await db.query("select count(*)::int as c from public.paused_ack_ops where job_id = $1", [job.id])).rows[0].c)).toBe(0);
  });

  it("no API role reads or writes paused_ack_ops or calls the internal helpers", async () => {
    expect((await as.admin.from("paused_ack_ops").select("*")).error).not.toBeNull();
    expect((await as.admin.from("paused_ack_ops").insert({ client_op_id: randomUUID() })).error).not.toBeNull();
    expect((await as.admin.rpc("paused_machine_current", { p_org: world.tenants.alpha.id, p_machine: randomUUID(), p_exclude_job: null })).error).not.toBeNull();
    expect((await as.admin.rpc("machine_run_request_sha256", { p_job: randomUUID(), p_machines: [], p_started_at: null, p_override: false, p_reason: null, p_bench: false, p_paused_ack: null })).error).not.toBeNull();
  });
});

describe("compatibility: the previous build's 6-argument calls on a 049 database (R3.6 D1a)", () => {
  it("bench start, to_machine, started_without_bench, machine_in_use and a pre-049 key replay all get 046's answers", async () => {
    const old = (client: SupabaseClient, job: string, machines: string[], key: string | null = null) =>
      client.rpc("start_machine_run", { p_job: job, p_machines: machines, p_client_op_id: key, p_started_at: null, p_override: false, p_reason: null });
    const mill = await machine("Old Mill");
    const job = await newJob();
    const key = randomUUID();
    const bench = ok(await old(as.workshop, job.id, [], key), "bench") as { bench_run: { already: boolean }; job_start_stamped: boolean };
    expect(bench).toMatchObject({ bench_run: { already: false }, job_start_stamped: true });
    const moved = ok(await old(as.workshop, job.id, [mill.id]), "to machine") as { bench_ended: { end_reason?: string } | null; runs: unknown[] };
    expect(moved.runs).toHaveLength(1);
    expect((await runs(job.id)).find((r) => r.machine_id === null)?.end_reason).toBe("to_machine");
    const other = await newJob();
    expect(refusal(await old(as.office, other.id, [mill.id]))).toMatchObject({ code: "42501", hint: "machine_in_use" });
    const bulk = await newJob();
    await adminClient().from("jobs").update({ started_at: new Date().toISOString() }).eq("id", bulk.id);
    expect(ok(await old(as.workshop, bulk.id, []), "bulk")).toMatchObject({ bench_run: null, bench_skipped: "started_without_bench" });
    // A key the previous build recorded before 049 (no hash), replayed by the previous build.
    await withDb((db) => db.query("update public.machine_run_ops set request_sha256 = null where client_op_id = $1", [key]));
    expect(ok(await old(as.workshop, job.id, [], key), "replay")).toMatchObject({ replayed: true, bench_run: { already: false } });
  });
});

describe("the previous build's replay of 049 entries, against this database (R3.6 D1b)", () => {
  it("is refused (22P02) and held as rejected: no run, no key, no start time, the op kept with bench and the check", async () => {
    setOfflineBackend(memoryBackend());
    try {
      const job = await newJob();
      const scope = { userId: world.tenants.alpha.users.workshop.id, orgId: world.tenants.alpha.id };
      const start: RunStartOp = { kind: "run_start", v: 2, jobRef: job.id, jobNo: job.no, at: new Date(Date.now() - 600_000).toISOString(), clientOpId: randomUUID(), machines: [], bench: true, pausedAck: [] };
      const pauseOp: RunPauseOp = { kind: "run_pause", v: 2, jobRef: job.id, jobNo: job.no, at: new Date().toISOString(), clientOpId: randomUUID(), machines: null, afterStart: start.clientOpId };
      await enqueue(scope, start);
      await enqueue(scope, pauseOp);
      const result = await drain86bb660(scope, executor86bb660(as.workshop));
      expect(result).toMatchObject({ applied: 0, rejected: 2, remaining: 0 });
      expect((await rejectedEntries(scope)).map((h) => h.op)).toEqual([start, pauseOp]);
      expect(await runs(job.id)).toEqual([]);
      expect((await adminClient().from("jobs").select("started_at").eq("id", job.id).single()).data!.started_at).toBeNull();
      expect(await withDb(async (db) => (await db.query("select count(*)::int as c from public.machine_run_ops where job_id = $1", [job.id])).rows[0].c)).toBe(0);
    } finally {
      setOfflineBackend(null);
    }
  });
});

describe("the release verify script (supabase/verify/paused_machine_ack.sql)", () => {
  it("runs read-only and every fact it checks is true", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/paused_machine_ack.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    const facts = rows.filter((r) => r.expected === "true");
    expect(facts.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(facts.filter((r) => r.value !== "true").map((r) => r.check_name)).toEqual([]);
    // 046's verify script stays true after 049 (one signature, bench rules intact).
    const bench = await withDb(async (db) => (await db.query<{ value: string; expected: string; check_name: string }>(readFileSync(path.resolve(__dirname, "../../supabase/verify/bench_pause.sql"), "utf8"))).rows);
    expect(bench.filter((r) => r.expected === "true" && r.value !== "true").map((r) => r.check_name)).toEqual([]);
  });
});
