/**
 * Migration 117: a Problem on a job, raised from My jobs and cleared by the office, against the real database of the local stack.
 *
 *   - admin, office and workshop raise a problem; a workshop person only on a job assigned to them; a viewer never; a job (or a problem)
 *     of the other company is not found;
 *   - every member of the company reads its problems (the flag on the Job Board and My jobs); the other company reads none; nobody signed
 *     in can insert, change or delete a row directly (no write grant), so only the two functions write;
 *   - admin and office clear a problem with a note of at least 3 characters; workshop and viewer can't; a cleared problem is not found a
 *     second time; the row stays, with who and when;
 *   - the same request id again is the same problem (one row, one event); the same id with different content is refused;
 *   - both events are in the job's activity (record_activity), once each, with who did it; the table's own row audit is there too;
 *   - nothing about the job changes: its start, finish, stage and worksheet version are as they were (a Problem blocks nothing);
 *   - supabase/verify/job_problems_117.sql answers TRUE on every row; the rollback removes the table and both functions and the release
 *     puts them back (all inside a rolled-back transaction). A read-only support session is refused in tests/db/two-level-access.test.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
const org = () => world.tenants.alpha.id;
const service = () => adminClient();
const user = (role: "admin" | "office" | "workshop" | "viewer") => world.tenants.alpha.users[role].id;

let n = 0;
async function newJob(assignedTo: string | null = null, tenant = org()) {
  n += 1;
  const { data, error } = await service().from("jobs").insert({ organization_id: tenant, job_no: `J-PB-${world.runId}-${n}`, customer: "Problem Co", description: "Bracket", assigned_to: assignedTo }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const report = (client: SupabaseClient, job: string, extra: Record<string, unknown> = {}) =>
  client.rpc("report_job_problem", { p_job: job, p_reason: "material", p_note: "Bar is the wrong grade", p_request_id: randomUUID(), ...extra });
const resolve = (client: SupabaseClient, problem: string, note = "Replacement bar ordered") => client.rpc("resolve_job_problem", { p_problem: problem, p_note: note });
const outcome = (r: { error: { code?: string; message: string } | null }) => (r.error ? { code: r.error.code } : "ok");
const rowOf = async (id: string) => (await service().from("job_problems").select("*").eq("id", id).maybeSingle()).data as Record<string, unknown> | null;
const events = (job: string, action: string) => withDb(async (db) => (await db.query("select actor_user_id, metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2 order by created_at", [job, action])).rows);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("who raises a problem", () => {
  it("admin and office raise on any job of the company; the workshop on a job assigned to them; the server records who and when", async () => {
    const job = await newJob(user("workshop"));
    const before = Date.now();
    const made: Record<string, string> = {};
    for (const role of ["admin", "office", "workshop"] as const) {
      const r = await report(as[role], job, { p_reason: role === "admin" ? "drawing" : role === "office" ? "machine" : "quality", p_note: `  ${role} saw it  ` });
      expect(outcome(r)).toBe("ok");
      made[role] = r.data as string;
    }
    for (const role of ["admin", "office", "workshop"] as const) {
      const stored = await rowOf(made[role]);
      expect(stored).toMatchObject({ organization_id: org(), job_id: job, status: "open", note: `${role} saw it`, reported_by: user(role), resolved_at: null, resolved_by: null, resolution_note: null });
      expect(Math.abs(new Date(stored!.reported_at as string).getTime() - before)).toBeLessThan(60_000);
    }
    // Several problems may be open on one job.
    expect((await service().from("job_problems").select("id").eq("job_id", job).eq("status", "open")).data).toHaveLength(3);
  });

  it("a workshop person can't raise one on a job that isn't theirs; a viewer can't raise one anywhere", async () => {
    const someoneElses = await newJob(user("office"));
    const unassigned = await newJob(null);
    expect(outcome(await report(as.workshop, someoneElses))).toEqual({ code: "42501" });
    expect(outcome(await report(as.workshop, unassigned))).toEqual({ code: "42501" });
    const mine = await newJob(user("workshop"));
    expect(outcome(await report(as.viewer, mine))).toEqual({ code: "42501" });
    expect((await service().from("job_problems").select("id").in("job_id", [someoneElses, unassigned, mine])).data).toEqual([]);
  });

  it("the reason must be one of the six, the note at most 500 characters, and every id present", async () => {
    const job = await newJob(user("workshop"));
    for (const reason of ["", "boredom", "MATERIAL"]) expect(outcome(await report(as.workshop, job, { p_reason: reason }))).toEqual({ code: "22023" });
    expect(outcome(await report(as.workshop, job, { p_reason: null }))).toEqual({ code: "22023" });
    expect(outcome(await report(as.workshop, job, { p_note: "x".repeat(501) }))).toEqual({ code: "22023" });
    expect(outcome(await report(as.workshop, job, { p_request_id: null }))).toEqual({ code: "22023" });
    expect(outcome(await report(as.workshop, null as unknown as string))).toEqual({ code: "22023" });
    for (const reason of ["material", "drawing", "machine", "quality", "tooling", "other"]) expect(outcome(await report(as.workshop, job, { p_reason: reason, p_note: null }))).toBe("ok");
    expect((await service().from("job_problems").select("note").eq("job_id", job)).data!.every((r) => r.note === null)).toBe(true);
    expect(outcome(await report(as.workshop, job, { p_note: "x".repeat(500) }))).toBe("ok");
  });

  it("a job of the other company is not found, whichever way round", async () => {
    const alphaJob = await newJob(user("workshop"));
    const betaJob = await newJob(null, world.tenants.beta.id);
    expect(outcome(await report(as.betaAdmin, alphaJob))).toEqual({ code: "P0002" });
    expect(outcome(await report(as.admin, betaJob))).toEqual({ code: "P0002" });
    expect(outcome(await report(as.workshop, betaJob))).toEqual({ code: "P0002" });
    expect((await service().from("job_problems").select("id").in("job_id", [alphaJob, betaJob])).data).toEqual([]);
  });
});

describe("the same request is the same problem", () => {
  it("sent twice it is one row and one event; with different content under the same id it is refused", async () => {
    const job = await newJob(user("workshop"));
    const requestId = randomUUID();
    const first = await report(as.workshop, job, { p_request_id: requestId });
    const again = await report(as.workshop, job, { p_request_id: requestId });
    expect(outcome(first)).toBe("ok");
    expect(again.data).toBe(first.data);
    expect((await service().from("job_problems").select("id").eq("job_id", job)).data).toHaveLength(1);
    expect(await events(job, "REPORT_JOB_PROBLEM")).toHaveLength(1);
    // The same note with different spacing is the same report.
    expect((await report(as.workshop, job, { p_request_id: requestId, p_note: "  Bar is the wrong grade " })).data).toBe(first.data);
    for (const change of [{ p_reason: "tooling" }, { p_note: "A different note" }, { p_note: null }]) {
      expect(outcome(await report(as.workshop, job, { p_request_id: requestId, ...change }))).toEqual({ code: "22023" });
    }
    expect(outcome(await report(as.workshop, await newJob(user("workshop")), { p_request_id: requestId }))).toEqual({ code: "22023" });
    // Someone else can't take the key over, in the same company or the other.
    expect(outcome(await report(as.admin, job, { p_request_id: requestId }))).toEqual({ code: "22023" });
    // (The key belongs to the company: the other company's own report under the same text is its own problem.)
    expect(outcome(await report(as.betaAdmin, await newJob(null, world.tenants.beta.id), { p_request_id: requestId }))).toBe("ok");
    expect((await service().from("job_problems").select("id").eq("job_id", job)).data).toHaveLength(1);
  });
});

describe("who reads, and that nothing is written except through the two functions", () => {
  it("every member of the company reads its problems; the other company reads none", async () => {
    const job = await newJob(user("workshop"));
    const id = (await report(as.workshop, job)).data as string;
    for (const role of ["admin", "office", "workshop", "viewer"] as const) {
      const seen = await as[role].from("job_problems").select("id, job_id, reason, status").eq("job_id", job);
      expect(seen.error).toBeNull();
      expect(seen.data).toEqual([{ id, job_id: job, reason: "material", status: "open" }]);
    }
    const other = await as.betaAdmin.from("job_problems").select("id").eq("id", id);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
    const betaJob = await newJob(null, world.tenants.beta.id);
    const betaProblem = (await report(as.betaAdmin, betaJob)).data as string;
    expect((await as.admin.from("job_problems").select("id").eq("id", betaProblem)).data).toEqual([]);
    expect((await as.betaAdmin.from("job_problems").select("id").eq("id", betaProblem)).data).toHaveLength(1);
  });

  it("nobody signed in can insert, change or delete a row directly, whichever role or company", async () => {
    const job = await newJob(user("workshop"));
    const id = (await report(as.workshop, job)).data as string;
    const before = await rowOf(id);
    for (const [name, client] of Object.entries(as)) {
      const insert = await client.from("job_problems").insert({ organization_id: org(), job_id: job, reason: "other", request_id: randomUUID() });
      expect({ name, refused: insert.error !== null }).toEqual({ name, refused: true });
      const update = await client.from("job_problems").update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_note: "Direct write" }).eq("id", id).select("id");
      expect({ name, changed: update.error ? 0 : (update.data?.length ?? 0) }).toEqual({ name, changed: 0 });
      const remove = await client.from("job_problems").delete().eq("id", id).select("id");
      expect({ name, removed: remove.error ? 0 : (remove.data?.length ?? 0) }).toEqual({ name, removed: 0 });
    }
    expect(await rowOf(id)).toEqual(before);
  });
});

describe("who clears a problem", () => {
  it("admin and office clear one with a note, recorded with who and when; the row stays; clearing again finds nothing", async () => {
    const job = await newJob(user("workshop"));
    const a = (await report(as.workshop, job)).data as string;
    const b = (await report(as.workshop, job, { p_reason: "machine" })).data as string;
    const when = Date.now();
    expect(outcome(await resolve(as.office, a, "  Replacement bar ordered  "))).toBe("ok");
    expect(await rowOf(a)).toMatchObject({ status: "resolved", resolved_by: user("office"), resolution_note: "Replacement bar ordered", reported_by: user("workshop"), reason: "material" });
    expect(Math.abs(new Date((await rowOf(a))!.resolved_at as string).getTime() - when)).toBeLessThan(60_000);
    expect(outcome(await resolve(as.admin, b, "Machine back up"))).toBe("ok");
    expect(await rowOf(b)).toMatchObject({ status: "resolved", resolved_by: user("admin") });
    // The second clearing finds no open problem, and changes nothing.
    expect(outcome(await resolve(as.admin, a, "Cleared twice"))).toEqual({ code: "P0002" });
    expect(await rowOf(a)).toMatchObject({ resolved_by: user("office"), resolution_note: "Replacement bar ordered" });
    // It no longer counts as open.
    expect((await service().from("job_problems").select("id").eq("job_id", job).eq("status", "open")).data).toEqual([]);
  });

  it("workshop, viewer and the other company can't; a note under 3 characters is refused; an unknown problem is not found", async () => {
    const job = await newJob(user("workshop"));
    const id = (await report(as.workshop, job)).data as string;
    expect(outcome(await resolve(as.workshop, id))).toEqual({ code: "42501" });
    expect(outcome(await resolve(as.viewer, id))).toEqual({ code: "42501" });
    expect(outcome(await resolve(as.betaAdmin, id))).toEqual({ code: "P0002" });
    for (const note of ["", "  ", "ok", "x".repeat(501)]) expect(outcome(await resolve(as.office, id, note))).toEqual({ code: "22023" });
    expect(outcome(await resolve(as.office, randomUUID()))).toEqual({ code: "P0002" });
    expect(await rowOf(id)).toMatchObject({ status: "open", resolved_by: null, resolution_note: null });
  });
});

describe("the job's history", () => {
  it("both events are in the job's activity, once each, with who did them; the job itself is untouched", async () => {
    const job = await newJob(user("workshop"));
    const jobBefore = (await service().from("jobs").select("*").eq("id", job).single()).data;
    const id = (await report(as.workshop, job, { p_reason: "drawing", p_note: "Hole sizes disagree" })).data as string;
    await report(as.workshop, job, { p_request_id: (await rowOf(id))!.request_id as string, p_reason: "drawing", p_note: "Hole sizes disagree" });
    expect(outcome(await resolve(as.office, id, "Customer sent revision D"))).toBe("ok");

    const reported = await events(job, "REPORT_JOB_PROBLEM");
    const resolved = await events(job, "RESOLVE_JOB_PROBLEM");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ actor_user_id: user("workshop"), metadata: expect.objectContaining({ problem_id: id, reason: "drawing", note: "Hole sizes disagree", source: "write_audit" }) });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ actor_user_id: user("office"), metadata: expect.objectContaining({ problem_id: id, reason: "drawing", resolution_note: "Customer sent revision D" }) });

    // The job's activity (what the Worksheet dialog shows) lists them, to every role that can open the job.
    for (const role of ["admin", "office", "workshop", "viewer"] as const) {
      const activity = await as[role].rpc("record_activity", { p_table: "jobs", p_id: job });
      expect(activity.error, role).toBeNull();
      const actions = (activity.data as Array<{ action: string }>).map((e) => e.action);
      expect(actions.filter((a) => a === "REPORT_JOB_PROBLEM"), role).toHaveLength(1);
      expect(actions.filter((a) => a === "RESOLVE_JOB_PROBLEM"), role).toHaveLength(1);
    }
    expect(((await as.office.rpc("record_activity", { p_table: "jobs", p_id: job })).data as Array<{ action: string; metadata: Record<string, unknown> }>).find((e) => e.action === "REPORT_JOB_PROBLEM")!.metadata).toMatchObject({ reason: "drawing", note: "Hole sizes disagree", job_no: expect.stringContaining("J-PB-") });
    // The other company's activity for this job is empty.
    expect(((await as.betaAdmin.rpc("record_activity", { p_table: "jobs", p_id: job })).data as unknown[]) ?? []).toEqual([]);

    // The table's own row audit records the raise and the clearing too.
    const rows = await withDb(async (db) => (await db.query("select action from security_audit.audit_log where entity_table = 'job_problems' and entity_id = $1 order by created_at", [id])).rows.map((r) => r.action));
    expect(rows).toEqual(["INSERT", "UPDATE"]);

    // A Problem blocks nothing: the job row is exactly as it was.
    expect((await service().from("jobs").select("*").eq("id", job).single()).data).toEqual(jobBefore);
  });

  it("a refused report writes no event", async () => {
    const job = await newJob(user("office"));
    expect(outcome(await report(as.workshop, job))).toEqual({ code: "42501" });
    expect(outcome(await report(as.viewer, job))).toEqual({ code: "42501" });
    expect(await events(job, "REPORT_JOB_PROBLEM")).toEqual([]);
  });
});

describe("117 release files on the local stack", () => {
  it("the verify script answers TRUE on every row", async () => {
    const rows = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/job_problems_117.sql"))).rows);
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });

  it("the rollback removes the table and both functions; the release puts them back and can run again (all inside a rolled-back transaction)", async () => {
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query(unwrapped(read("supabase/release/117_job_problems.rollback.sql")));
        expect((await db.query("select to_regclass('public.job_problems') as t, to_regprocedure('public.report_job_problem(uuid,text,text,uuid)') as f, to_regprocedure('public.resolve_job_problem(uuid,text)') as g")).rows[0]).toEqual({ t: null, f: null, g: null });
        const during = (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/job_problems_117.sql"))).rows;
        expect(during.every((r) => !r.ok)).toBe(true);
        await db.query(unwrapped(read("supabase/release/117_job_problems.release.sql")));
        const again = (await db.query<{ ok: boolean }>(read("supabase/verify/job_problems_117.sql"))).rows;
        expect(again.every((r) => r.ok)).toBe(true);
        // Safe to run again.
        await db.query(unwrapped(read("supabase/release/117_job_problems.release.sql")));
      } finally {
        await db.query("rollback");
      }
    });
  });
});
