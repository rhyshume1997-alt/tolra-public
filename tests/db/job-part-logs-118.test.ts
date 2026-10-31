/**
 * Migration 118: parts done on a job, logged from My jobs, against the real database of the local stack.
 *
 *   - admin, office and workshop log parts; a workshop person only on a job assigned to them; a viewer never; a job of the other company is not found;
 *   - the total stays between 0 and the job's quantity (M): a tap that would go below 0 or above M is refused and writes nothing, exactly M is
 *     fine, and several taps at once never overshoot (a lock per job);
 *   - a correction is a negative entry and must say why (3 to 250 characters); the original entry stays; nothing is edited or deleted;
 *   - the client op id is the key: the same request again is the same entry (one row, one event, the total counted once); the same id with a
 *     different job, quantity or note is refused, and so is another person's use of it;
 *   - a finished job is refused, a job in rework is not; a job with no quantity is refused;
 *   - every member of the company reads its log and the totals (job_parts_done); the other company reads and counts none; nobody signed in can
 *     insert, change or delete a row directly (no write grant), so only log_job_parts writes;
 *   - the event is in the job's activity (record_activity), once per entry, with who did it; the table's own row audit is there too;
 *   - nothing about the job changes: its start, finish, stage and worksheet are as they were;
 *   - supabase/verify/job_part_logs_118.sql answers TRUE on every row; the rollback removes the table and both functions and the release puts them
 *     back (all inside a rolled-back transaction). A read-only support session is refused in tests/db/two-level-access.test.ts, and the
 *     other company's job in tests/db/definer-functions.test.ts.
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
async function newJob(opts: { assignedTo?: string | null; required?: number | null; tenant?: string; finished?: boolean; stage?: string } = {}) {
  n += 1;
  const { assignedTo = null, required = 10, tenant = org(), finished = false, stage } = opts;
  const row: Record<string, unknown> = { organization_id: tenant, job_no: `J-PL-${world.runId}-${n}`, customer: "Parts Co", description: "Bracket", assigned_to: assignedTo, quantity_required: required };
  if (finished) row.finished_at = new Date().toISOString();
  if (stage) row.stage = stage;
  const { data, error } = await service().from("jobs").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const log = (client: SupabaseClient, job: string, quantity = 1, extra: Record<string, unknown> = {}) =>
  client.rpc("log_job_parts", { p_job: job, p_quantity: quantity, p_note: null, p_client_op_id: randomUUID(), ...extra });
const outcome = (r: { error: { code?: string; message: string } | null }) => (r.error ? { code: r.error.code } : "ok");
const rowOf = async (id: string) => (await service().from("job_part_logs").select("*").eq("id", id).maybeSingle()).data as Record<string, unknown> | null;
const totalOf = async (job: string) => ((await service().from("job_part_logs").select("quantity").eq("job_id", job)).data ?? []).reduce((sum, r) => sum + (r.quantity as number), 0);
const events = (job: string) => withDb(async (db) => (await db.query("select actor_user_id, metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'LOG_JOB_PARTS' order by created_at", [job])).rows);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("who logs parts", () => {
  it("admin and office log on any job of the company; the workshop on a job assigned to them; the server records who and when", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 100 });
    const before = Date.now();
    const made: Record<string, string> = {};
    for (const role of ["admin", "office", "workshop"] as const) {
      const r = await log(as[role], job, role === "admin" ? 5 : role === "office" ? 3 : 1, { p_note: `  ${role} count  ` });
      expect(outcome(r)).toBe("ok");
      made[role] = r.data as string;
    }
    for (const [role, quantity] of [["admin", 5], ["office", 3], ["workshop", 1]] as const) {
      const stored = await rowOf(made[role]);
      expect(stored).toMatchObject({ organization_id: org(), job_id: job, quantity, note: `${role} count`, logged_by: user(role) });
      expect(Math.abs(new Date(stored!.logged_at as string).getTime() - before)).toBeLessThan(60_000);
    }
    expect(await totalOf(job)).toBe(9);
  });

  it("a workshop person can't log on a job that isn't theirs; a viewer can't log anywhere", async () => {
    const someoneElses = await newJob({ assignedTo: user("office") });
    const unassigned = await newJob();
    expect(outcome(await log(as.workshop, someoneElses))).toEqual({ code: "42501" });
    expect(outcome(await log(as.workshop, unassigned))).toEqual({ code: "42501" });
    const mine = await newJob({ assignedTo: user("workshop") });
    expect(outcome(await log(as.viewer, mine))).toEqual({ code: "42501" });
    expect((await service().from("job_part_logs").select("id").in("job_id", [someoneElses, unassigned, mine])).data).toEqual([]);
  });

  it("the entry must be a whole number other than 0 within 100000, the note at most 250 characters, and every id present", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 500 });
    for (const quantity of [0, 100001, -100001]) expect(outcome(await log(as.workshop, job, quantity, { p_note: "checked" }))).toEqual({ code: "22023" });
    expect(outcome(await log(as.workshop, job, null as unknown as number))).toEqual({ code: "22023" });
    expect(outcome(await log(as.workshop, job, 1, { p_note: "x".repeat(251) }))).toEqual({ code: "22023" });
    expect(outcome(await log(as.workshop, job, 1, { p_client_op_id: null }))).toEqual({ code: "22023" });
    expect(outcome(await log(as.workshop, null as unknown as string))).toEqual({ code: "22023" });
    expect(outcome(await log(as.workshop, job, 1, { p_note: "x".repeat(250) }))).toBe("ok");
    expect(await totalOf(job)).toBe(1);
  });

  it("a job of the other company is not found, whichever way round", async () => {
    const alphaJob = await newJob({ assignedTo: user("workshop") });
    const betaJob = await newJob({ tenant: world.tenants.beta.id });
    expect(outcome(await log(as.betaAdmin, alphaJob))).toEqual({ code: "P0002" });
    expect(outcome(await log(as.admin, betaJob))).toEqual({ code: "P0002" });
    expect(outcome(await log(as.workshop, betaJob))).toEqual({ code: "P0002" });
    expect((await service().from("job_part_logs").select("id").in("job_id", [alphaJob, betaJob])).data).toEqual([]);
  });
});

describe("the total stays between 0 and the quantity required", () => {
  it("exactly M is allowed; one more is refused and writes nothing; the log shows N of M", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 3 });
    for (let i = 0; i < 3; i += 1) expect(outcome(await log(as.workshop, job))).toBe("ok");
    expect(outcome(await log(as.workshop, job))).toEqual({ code: "22003" });
    expect(outcome(await log(as.admin, job, 5))).toEqual({ code: "22003" });
    expect(await totalOf(job)).toBe(3);
    expect((await service().from("job_part_logs").select("id").eq("job_id", job)).data).toHaveLength(3);
  });

  it("a negative entry puts a wrong tap right, needs a note of at least 3 characters, and can't take the total below 0", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 10 });
    const tapped = await log(as.workshop, job, 4);
    expect(outcome(tapped)).toBe("ok");
    for (const note of [null, "", "  ", "ok"]) expect(outcome(await log(as.workshop, job, -1, { p_note: note }))).toEqual({ code: "22023" });
    const fix = await log(as.workshop, job, -3, { p_note: "Counted the wrong tray" });
    expect(outcome(fix)).toBe("ok");
    expect(await rowOf(fix.data as string)).toMatchObject({ quantity: -3, note: "Counted the wrong tray", logged_by: user("workshop") });
    expect(await totalOf(job)).toBe(1);
    // The original entry is still there, unchanged.
    expect(await rowOf(tapped.data as string)).toMatchObject({ quantity: 4, note: null });
    // Below 0 is refused, and nothing is written.
    expect(outcome(await log(as.workshop, job, -2, { p_note: "Too many taken off" }))).toEqual({ code: "22003" });
    expect(outcome(await log(as.workshop, job, -1, { p_note: "Back to nothing" }))).toBe("ok");
    expect(outcome(await log(as.workshop, job, -1, { p_note: "Below nothing" }))).toEqual({ code: "22003" });
    expect(await totalOf(job)).toBe(0);
  });

  it("several taps at once never overshoot: with 4 to go, exactly 4 of 7 simultaneous +1 taps are taken", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 4 });
    const results = await Promise.all(Array.from({ length: 7 }, () => log(as.workshop, job)));
    const outcomes = results.map(outcome);
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(4);
    expect(outcomes.filter((o) => typeof o === "object" && o.code === "22003")).toHaveLength(3);
    expect(await totalOf(job)).toBe(4);
  });

  it("a job with no quantity can't be counted; a finished job is refused, a job in rework is not", async () => {
    const noQuantity = await newJob({ assignedTo: user("workshop"), required: null });
    const zero = await newJob({ assignedTo: user("workshop"), required: 0 });
    expect(outcome(await log(as.workshop, noQuantity))).toEqual({ code: "22023" });
    expect(outcome(await log(as.workshop, zero))).toEqual({ code: "22023" });
    const done = await newJob({ assignedTo: user("workshop"), finished: true });
    expect(outcome(await log(as.workshop, done))).toEqual({ code: "55000" });
    expect(outcome(await log(as.admin, done))).toEqual({ code: "55000" });
    const rework = await newJob({ assignedTo: user("workshop"), finished: true, stage: "rework" });
    expect(outcome(await log(as.workshop, rework))).toBe("ok");
    expect((await service().from("job_part_logs").select("id").in("job_id", [noQuantity, zero, done])).data).toEqual([]);
  });
});

describe("the same request is the same entry", () => {
  it("sent twice it is one row, one event and counted once; with different content under the same id it is refused", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 50 });
    const opId = randomUUID();
    const first = await log(as.workshop, job, 2, { p_client_op_id: opId });
    const again = await log(as.workshop, job, 2, { p_client_op_id: opId });
    expect(outcome(first)).toBe("ok");
    expect(again.data).toBe(first.data);
    expect((await service().from("job_part_logs").select("id").eq("job_id", job)).data).toHaveLength(1);
    expect(await events(job)).toHaveLength(1);
    expect(await totalOf(job)).toBe(2);
    // The same note with different spacing is the same entry.
    const noted = randomUUID();
    const withNote = await log(as.workshop, job, 1, { p_client_op_id: noted, p_note: "Tray 4" });
    expect((await log(as.workshop, job, 1, { p_client_op_id: noted, p_note: "  Tray 4 " })).data).toBe(withNote.data);
    for (const change of [{ p_quantity: 3 }, { p_note: "A different note" }, { p_note: null }]) {
      expect(outcome(await log(as.workshop, job, 1, { p_client_op_id: noted, ...change }))).toEqual({ code: "22023" });
    }
    expect(outcome(await log(as.workshop, await newJob({ assignedTo: user("workshop") }), 1, { p_client_op_id: noted, p_note: "Tray 4" }))).toEqual({ code: "22023" });
    // Someone else can't take the key over; the other company's own use of the same text is its own entry.
    expect(outcome(await log(as.admin, job, 1, { p_client_op_id: noted, p_note: "Tray 4" }))).toEqual({ code: "22023" });
    expect(outcome(await log(as.betaAdmin, await newJob({ tenant: world.tenants.beta.id }), 1, { p_client_op_id: noted, p_note: "Tray 4" }))).toBe("ok");
    expect(await totalOf(job)).toBe(3);
  });

  it("a replay of an entry that, sent again now, would be over the quantity still answers with the original (the total isn't counted twice)", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 2 });
    const opId = randomUUID();
    const first = await log(as.workshop, job, 2, { p_client_op_id: opId });
    expect(outcome(first)).toBe("ok");
    expect((await log(as.workshop, job, 2, { p_client_op_id: opId })).data).toBe(first.data);
    expect(await totalOf(job)).toBe(2);
  });
});

describe("who reads, and that nothing is written except through log_job_parts", () => {
  it("every member of the company reads its log and the totals; the other company reads and counts none", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 20 });
    const second = await newJob({ assignedTo: user("workshop"), required: 20 });
    await log(as.workshop, job, 4);
    await log(as.workshop, job, 3);
    await log(as.workshop, second, 1);
    for (const role of ["admin", "office", "workshop", "viewer"] as const) {
      const seen = await as[role].from("job_part_logs").select("job_id, quantity").eq("job_id", job);
      expect(seen.error).toBeNull();
      expect((seen.data ?? []).map((r) => r.quantity).sort()).toEqual([3, 4]);
      const totals = await as[role].rpc("job_parts_done", { p_jobs: [job, second] });
      expect(totals.error, role).toBeNull();
      expect([...(totals.data as Array<{ job_id: string; parts_done: number }>)].sort((a, b) => b.parts_done - a.parts_done)).toEqual([{ job_id: job, parts_done: 7 }, { job_id: second, parts_done: 1 }]);
    }
    // A job with nothing logged has no row (read as 0 of M), and the other company counts nothing of this one.
    const empty = await newJob();
    expect((await as.admin.rpc("job_parts_done", { p_jobs: [empty] })).data).toEqual([]);
    expect((await as.betaAdmin.from("job_part_logs").select("id").eq("job_id", job)).data).toEqual([]);
    expect((await as.betaAdmin.rpc("job_parts_done", { p_jobs: [job, second] })).data).toEqual([]);
    const betaJob = await newJob({ tenant: world.tenants.beta.id });
    await log(as.betaAdmin, betaJob, 2);
    expect((await as.admin.rpc("job_parts_done", { p_jobs: [betaJob] })).data).toEqual([]);
    expect((await as.betaAdmin.rpc("job_parts_done", { p_jobs: [betaJob] })).data).toEqual([{ job_id: betaJob, parts_done: 2 }]);
  });

  it("anonymous callers get neither the function nor the table", async () => {
    const { apiUrl, anonKey } = (await import("../support/isolation")).isolatedBackend();
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await anon.rpc("log_job_parts", { p_job: randomUUID(), p_quantity: 1, p_note: null, p_client_op_id: randomUUID() })).error).not.toBeNull();
    expect((await anon.rpc("job_parts_done", { p_jobs: [randomUUID()] })).error).not.toBeNull();
    expect((await anon.from("job_part_logs").select("id")).error).not.toBeNull();
  });

  it("nobody signed in can insert, change or delete a row directly, whichever role or company", async () => {
    const job = await newJob({ assignedTo: user("workshop") });
    const id = (await log(as.workshop, job, 2)).data as string;
    const before = await rowOf(id);
    for (const [name, client] of Object.entries(as)) {
      const insert = await client.from("job_part_logs").insert({ organization_id: org(), job_id: job, quantity: 5, client_op_id: randomUUID() });
      expect({ name, refused: insert.error !== null }).toEqual({ name, refused: true });
      const update = await client.from("job_part_logs").update({ quantity: 9 }).eq("id", id).select("id");
      expect({ name, changed: update.error ? 0 : (update.data?.length ?? 0) }).toEqual({ name, changed: 0 });
      const remove = await client.from("job_part_logs").delete().eq("id", id).select("id");
      expect({ name, removed: remove.error ? 0 : (remove.data?.length ?? 0) }).toEqual({ name, removed: 0 });
    }
    expect(await rowOf(id)).toEqual(before);
    expect(await totalOf(job)).toBe(2);
  });
});

describe("the job's history", () => {
  it("each entry is in the job's activity, once, with who did it; the job itself is untouched", async () => {
    const job = await newJob({ assignedTo: user("workshop"), required: 12 });
    const jobBefore = (await service().from("jobs").select("*").eq("id", job).single()).data;
    const opId = randomUUID();
    const tap = await log(as.workshop, job, 5, { p_client_op_id: opId });
    await log(as.workshop, job, 5, { p_client_op_id: opId });
    const fix = await log(as.office, job, -2, { p_note: "Two were scrap, not good" });
    expect(outcome(tap)).toBe("ok");
    expect(outcome(fix)).toBe("ok");

    const logged = await events(job);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ actor_user_id: user("workshop"), metadata: expect.objectContaining({ log_id: tap.data, quantity: 5, total_after: 5, quantity_required: 12, source: "write_audit" }) });
    expect(logged[1]).toMatchObject({ actor_user_id: user("office"), metadata: expect.objectContaining({ log_id: fix.data, quantity: -2, note: "Two were scrap, not good", total_after: 3 }) });

    // The job's activity (what the Worksheet dialog shows) lists them, to every role that can open the job.
    for (const role of ["admin", "office", "workshop", "viewer"] as const) {
      const activity = await as[role].rpc("record_activity", { p_table: "jobs", p_id: job });
      expect(activity.error, role).toBeNull();
      expect((activity.data as Array<{ action: string }>).filter((e) => e.action === "LOG_JOB_PARTS"), role).toHaveLength(2);
    }
    expect(((await as.betaAdmin.rpc("record_activity", { p_table: "jobs", p_id: job })).data as unknown[]) ?? []).toEqual([]);

    // The table's own row audit records both inserts.
    const rows = await withDb(async (db) => (await db.query("select action from security_audit.audit_log where entity_table = 'job_part_logs' and entity_id = any($1) order by created_at", [[tap.data, fix.data]])).rows.map((r) => r.action));
    expect(rows).toEqual(["INSERT", "INSERT"]);

    // Logging parts blocks and changes nothing: the job row is exactly as it was.
    expect((await service().from("jobs").select("*").eq("id", job).single()).data).toEqual(jobBefore);
  });

  it("a refused entry writes no event", async () => {
    const job = await newJob({ assignedTo: user("office"), required: 1 });
    expect(outcome(await log(as.workshop, job))).toEqual({ code: "42501" });
    expect(outcome(await log(as.viewer, job))).toEqual({ code: "42501" });
    expect(outcome(await log(as.admin, job, 2))).toEqual({ code: "22003" });
    expect(await events(job)).toEqual([]);
  });
});

describe("118 release files on the local stack", () => {
  it("the verify script answers TRUE on every row", async () => {
    const rows = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/job_part_logs_118.sql"))).rows);
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });

  it("the rollback removes the table and both functions; the release puts them back and can run again (all inside a rolled-back transaction)", async () => {
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query(unwrapped(read("supabase/release/118_job_part_logs.rollback.sql")));
        expect((await db.query("select to_regclass('public.job_part_logs') as t, to_regprocedure('public.log_job_parts(uuid,integer,text,uuid)') as f, to_regprocedure('public.job_parts_done(uuid[])') as g")).rows[0]).toEqual({ t: null, f: null, g: null });
        const during = (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/job_part_logs_118.sql"))).rows;
        expect(during.every((r) => !r.ok)).toBe(true);
        await db.query(unwrapped(read("supabase/release/118_job_part_logs.release.sql")));
        const again = (await db.query<{ ok: boolean }>(read("supabase/verify/job_part_logs_118.sql"))).rows;
        expect(again.every((r) => r.ok)).toBe(true);
        // Safe to run again.
        await db.query(unwrapped(read("supabase/release/118_job_part_logs.release.sql")));
      } finally {
        await db.query("rollback");
      }
    });
  });
});
