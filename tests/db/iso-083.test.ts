/**
 * ISO 9001 PR C (migration 083): 7.2 authorised inspectors. Only someone on the list records a pass or co-signs as the inspector,
 * checked on the server for every write, offline replays included, and ordered against a removal in flight. Every change to the
 * list is in its history and the audit log with who, when and why; the history is never changed or removed; company isolation.
 * SQL only (as PostgREST runs it: role authenticated with the JWT claims), so it also runs against plain PostgreSQL with stand-ins.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, become, q, refusal } from "./time-support";

let world: SyntheticWorld;
let seq = 0;
const alpha = () => world.tenants.alpha;
const beta = () => world.tenants.beta;
const user = (role: "admin" | "office" | "workshop" | "viewer", t = alpha()): Who => ({ id: t.users[role].id });
const REASON = "Trained on bore gauges and CMM, signed off by the JNR controller";

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** Sets a member's inspector flag directly, as the database owner (a fixture write: the history notes no reason). */
const flag = (who: Who, on: boolean, org = alpha().id) =>
  withDb((db) => db.query("update public.organization_members set can_inspect = $3 where organization_id = $1 and user_id = $2", [org, who.id, on]));

/** A finished job (stage inspection) made directly in the database, as the owner. */
async function job(org = alpha().id) {
  seq += 1;
  return withDb(async (db) => (await db.query<{ id: string }>(
    `insert into public.jobs (organization_id, job_no, customer, stage, started_at, finished_at, quantity_required)
     values ($1, $2, 'ISO Co', 'inspection', '2026-10-01T08:00:00Z', '2026-10-02T08:00:00Z', 5) returning id`,
    [org, `J-ISO-${world.runId}-${seq}`])).rows[0].id);
}
const row = async (id: string) => (await withDb((db) => db.query("select * from public.jobs where id = $1", [id]))).rows[0];
/** 081's inspect_job (the inspection screen's one call, online and offline): criteria and the measured result; a failure goes to rework. */
const INSPECT = `select public.inspect_job(p_job => $1, p_result => $2, p_criteria => 'Drawing ACL-7 rev C: bore 25.00 +0.02/-0',
  p_measured => 'Bore 25.01 mm (bore gauge 0001)', p_expected_version => $3, p_disposition => $4, p_failure => $5::jsonb, p_client_op_id => $6::uuid) as r`;
const inspectArgs = async (id: string, result: string, key: string | null) => [id, result, (await row(id)).worksheet_version,
  result === "fail" ? "rework" : null, result === "fail" ? JSON.stringify({ reason: "Bore oversize 25.06", instructions: "Sleeve and re-bore" }) : null, key];
const pass = async (who: Who, id: string, result = "pass", key: string | null = null) =>
  q<{ r: Record<string, unknown> }>(who, INSPECT, await inspectArgs(id, result, key)).then((rows) => rows[0].r);
const passRefusal = async (who: Who, id: string, key: string | null = null) => refusal(who, INSPECT, await inspectArgs(id, "pass", key));
const history = async (who: Who, org = alpha().id) => (await withDb((db) => db.query(
  "select change, scope, reason, changed_by from public.inspector_authorisations where organization_id = $1 and user_id = $2 order by changed_at, id", [org, who.id]))).rows;
const audit = async (action: string, entity: string) => (await withDb((db) => db.query(
  "select actor_user_id, metadata from security_audit.audit_log where action = $1 and entity_id = $2 order by created_at", [action, entity]))).rows;
const setInspector = (as: Who, target: Who, on: boolean, reason: string | null = REASON, scope: string | null = null) =>
  q(as, "select public.set_authorised_inspector($1, $2, $3, $4) as r", [target.id, on, scope, reason]);

describe("7.2 authorised inspectors", () => {
  it("only someone on the list records a pass: an admin is no longer one just for being an admin; the owner is exempt", async () => {
    await flag(user("admin"), false);
    await flag(user("workshop"), true);
    const id = await job();
    const refused = await passRefusal(user("admin"), id);
    expect(refused).toMatchObject({ code: "42501", hint: "not_authorised_inspector" });
    expect(refused!.message).toMatch(/authorised inspector/);
    expect(await passRefusal(user("office"), id)).toMatchObject({ code: "42501" }); // not on the list: refused before the trigger too
    expect((await pass(user("workshop"), id)).result).toBe("pass");
    // Through the inspection screen's call (inspect_job, 081) an admin off the list records nothing at all (081's interim check
    // "an admin, or someone ticked" is replaced); someone on the list records a failure as before.
    const failing = await job();
    expect(await refusal(user("admin"), INSPECT, await inspectArgs(failing, "fail", null))).toMatchObject({ code: "42501", hint: "not_authorised_inspector" });
    expect((await pass(user("workshop"), failing, "fail")).result).toBe("fail");
    // The database owner (fixtures, the SQL editor) is exempt, as for the other release locks.
    const legacy = await job();
    await withDb((db) => db.query("insert into public.job_inspections (organization_id, job_id, result, release_decision, measured_notes, inspector_id, inspector_name, worksheet_version) values ($1, $2, 'pass', 'released', 'ok', null, 'Legacy', 0)", [alpha().id, legacy]));
    await flag(user("admin"), true);
  });

  it("an admin adds and removes inspectors with a reason; each change is in the history and the audit log; nobody else may", async () => {
    await flag(user("office"), false);
    for (const role of ["office", "workshop", "viewer"] as const) {
      expect(await refusal(user(role), "select public.set_authorised_inspector($1, true, null, $2)", [user("office").id, REASON]), role).toMatchObject({ code: "42501" });
    }
    expect(await refusal(user("admin"), "select public.set_authorised_inspector($1, true, null, 'short')", [user("office").id])).toMatchObject({ code: "22023", hint: "reason_required" });
    expect(await refusal(user("admin"), "select public.set_authorised_inspector($1, null, null, $2)", [user("office").id, REASON])).toMatchObject({ code: "22023" });
    expect(await refusal(user("admin"), "select public.set_authorised_inspector($1, true, null, $2)", [user("viewer").id, REASON])).toMatchObject({ code: "22023", hint: "not_eligible" });
    expect(await refusal(user("admin"), "select public.set_authorised_inspector($1, true, null, $2)", [user("admin", beta()).id, REASON])).toMatchObject({ code: "P0002" });
    expect(await refusal(user("admin", beta()), "select public.set_authorised_inspector($1, true, null, $2)", [user("office").id, REASON])).toMatchObject({ code: "P0002" });

    await setInspector(user("admin"), user("office"), true, REASON, "Dimensional and visual");
    expect(await refusal(user("admin"), "select public.set_authorised_inspector($1, true, null, $2)", [user("office").id, REASON])).toMatchObject({ code: "22023", hint: "no_change" });
    const id = await job();
    expect((await pass(user("office"), id)).result).toBe("pass");
    await setInspector(user("admin"), user("office"), false, "Left the quality team, Oct 2026");
    expect(await passRefusal(user("office"), await job())).toMatchObject({ code: "42501" });

    const rows = await history(user("office"));
    expect(rows.slice(-2)).toEqual([
      { change: "added", scope: "Dimensional and visual", reason: REASON, changed_by: user("admin").id },
      { change: "removed", scope: null, reason: "Left the quality team, Oct 2026", changed_by: user("admin").id },
    ]);
    const events = (await audit("SET_INSPECTOR", user("office").id)).slice(-2);
    expect(events.map((e) => [e.actor_user_id, e.metadata.can_inspect, e.metadata.reason])).toEqual([
      [user("admin").id, true, REASON], [user("admin").id, false, "Left the quality team, Oct 2026"]]);
    // Any other path (034's tick, the owner) is in the history too, marked as having no reason.
    await flag(user("office"), true);
    expect((await history(user("office"))).at(-1)).toMatchObject({ change: "added", reason: "No reason recorded (changed outside Admin > Inspectors)", changed_by: null });
    await flag(user("office"), false);
  });

  it("the history is a record: never changed or removed (the owner included); read by admin and office of the company only", async () => {
    for (const sql of ["update public.inspector_authorisations set reason = 'Rewritten reason here' where organization_id = $1",
      "delete from public.inspector_authorisations where organization_id = $1"]) {
      await expect(withDb((db) => db.query(sql, [alpha().id]))).rejects.toMatchObject({ code: "42501" });
    }
    expect((await q(user("admin"), "select count(*)::int as n from public.inspector_authorisations"))[0].n).toBeGreaterThan(0);
    expect((await q(user("office"), "select count(*)::int as n from public.inspector_authorisations"))[0].n).toBeGreaterThan(0);
    for (const role of ["workshop", "viewer"] as const) expect((await q(user(role), "select count(*)::int as n from public.inspector_authorisations"))[0].n, role).toBe(0);
    expect((await q(user("admin", beta()), "select count(*)::int as n from public.inspector_authorisations where organization_id = $1", [alpha().id]))[0].n).toBe(0);
    expect(await refusal(user("admin"), "insert into public.inspector_authorisations (organization_id, user_id, change, reason) values ($1, $2, 'added', $3)", [alpha().id, user("viewer").id, REASON])).toMatchObject({ code: "42501" });
  });

  it("an inspector's co-signature: only someone on the list; an offline replay is checked when it reaches the server", async () => {
    await flag(user("workshop"), true);
    await flag(user("admin"), false);
    const id = await job();
    const sign = async (who: Who, kind: string, key: string | null = null) => {
      const rev = (await q<{ r: { worksheet_version: number; snapshot_sha256: string } }>(who, "select public.job_signoff_revision($1) as r", [id]))[0].r;
      return refusal(who, "select public.sign_off_job($1, $2, $3, 'AB', 'Alex Brown', (now() at time zone 'Europe/London')::date, 'typed', 'Alex Brown', $4, $5)",
        [id, rev.worksheet_version, rev.snapshot_sha256, kind, key]);
    };
    expect(await sign(user("office"), "primary")).toBeNull();
    // An admin passes sign_off_job's own check (admins), and is refused by 083's.
    expect(await sign(user("admin"), "inspector")).toMatchObject({ code: "42501", hint: "not_authorised_inspector" });
    const key = randomUUID();
    expect(await sign(user("workshop"), "inspector", key)).toBeNull();
    // Taken off the list afterwards: the replay of that same signature (same key, same content) returns the first answer...
    await setInspector(user("admin", alpha()), user("workshop"), false, "Moved to the stores, no longer inspecting");
    expect(await sign(user("workshop"), "inspector", key)).toBeNull();
    // ...but a signature queued offline and uploaded only now is refused: it is checked when it reaches the server.
    const other = await job();
    const rev = (await q<{ r: { worksheet_version: number; snapshot_sha256: string } }>(user("office"), "select public.job_signoff_revision($1) as r", [other]))[0].r;
    expect(await refusal(user("office"), "select public.sign_off_job($1, $2, $3, 'AB', 'Alex Brown', (now() at time zone 'Europe/London')::date, 'typed', 'Alex Brown', 'primary', null)", [other, rev.worksheet_version, rev.snapshot_sha256])).toBeNull();
    expect(await refusal(user("workshop"), "select public.sign_off_job($1, $2, $3, 'AB', 'Alex Brown', (now() at time zone 'Europe/London')::date, 'typed', 'Alex Brown', 'inspector', $4)", [other, rev.worksheet_version, rev.snapshot_sha256, randomUUID()]))
      .toMatchObject({ code: "42501" });
    await flag(user("admin"), true);
    await flag(user("workshop"), true);
  });

  it("offline: a committed pass replayed after the person was removed returns the original (no duplicate); a new key is refused", async () => {
    await flag(user("workshop"), true);
    const done = await job();
    const key = randomUUID();
    expect((await pass(user("workshop"), done, "pass", key)).result).toBe("pass");
    expect((await pass(user("workshop"), done, "pass", key)).replayed).toBe(true); // the device retries: the first record answers
    const first = await withDb((db) => db.query("select id, inspected_at from public.job_inspections where job_id = $1", [done]));
    // The person is taken off the list. Their device retries the pass it already sent (its answer was lost): the committed pass is
    // answered as it was, with the same record, and nothing is added (081 answers a committed replay before any check).
    await setInspector(user("admin"), user("workshop"), false, "No longer inspecting after the audit");
    const replay = await pass(user("workshop"), done, "pass", key);
    expect(replay).toMatchObject({ result: "pass", replayed: true, inspection_id: first.rows[0].id });
    expect((await withDb((db) => db.query("select count(*)::int as n from public.job_inspections where job_id = $1", [done]))).rows[0].n).toBe(1);
    // A pass queued on the tablet under a new key and uploaded only now is a new attempt: refused, nothing kept.
    const queued = await job();
    expect(await passRefusal(user("workshop"), queued, randomUUID())).toMatchObject({ code: "42501", hint: "not_authorised_inspector" });
    expect((await withDb((db) => db.query("select count(*)::int as n from public.job_inspections where job_id = $1", [queued]))).rows[0].n).toBe(0);
    // A new key on the job already passed is a new attempt too.
    expect(await passRefusal(user("workshop"), done, randomUUID())).toMatchObject({ code: "42501" });
    expect((await withDb((db) => db.query("select count(*)::int as n from public.job_inspections where job_id = $1", [done]))).rows[0].n).toBe(1);
    await flag(user("workshop"), true);
  });
});

describe("7.2 race: removing an inspector while their pass is in flight", () => {
  const pid = async (db: Client) => (await db.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;
  const waitingOnLock = async (p: number) => {
    for (let i = 0; i < 50; i += 1) {
      const r = await withDb((db) => db.query<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [p]));
      if (r.rows[0]?.w === "Lock") return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return false;
  };

  it("the pass first: the removal waits for it; the pass stands (they were authorised when it was made); their next pass is refused", async () => {
    await flag(user("workshop"), true);
    const id = await job();
    const version = (await row(id)).worksheet_version;
    await withDb(async (a) => withDb(async (b) => {
      await a.query("begin");
      await become(a, user("workshop"));
      await a.query(INSPECT, [id, "pass", version, null, null, null]);
      await b.query("begin");
      await become(b, user("admin"));
      const bPid = await pid(b); // asked before b's next query: a client runs one query at a time
      const removal = b.query("select public.set_authorised_inspector($1, false, null, $2)", [user("workshop").id, "Removed during the race test run"]);
      expect(await waitingOnLock(bPid)).toBe(true);
      await a.query("commit");
      await removal;
      await b.query("commit");
    }));
    expect((await row(id)).stage).toBe("complete");
    expect(await passRefusal(user("workshop"), await job())).toMatchObject({ code: "42501" });
  });

  it("the removal first: the pass waits for it and is then refused; nothing of it is kept", async () => {
    await flag(user("workshop"), true);
    const id = await job();
    const version = (await row(id)).worksheet_version;
    let outcome: { code?: string; hint?: string } | null = null;
    await withDb(async (a) => withDb(async (b) => {
      await b.query("begin");
      await become(b, user("admin"));
      await b.query("select public.set_authorised_inspector($1, false, null, $2)", [user("workshop").id, "Removed during the race test run"]);
      await a.query("begin");
      await become(a, user("workshop"));
      const aPid = await pid(a);
      const attempt = a.query(INSPECT, [id, "pass", version, null, null, null])
        .then(() => null, (err: { code?: string; hint?: string }) => ({ code: err.code, hint: err.hint }));
      expect(await waitingOnLock(aPid)).toBe(true);
      await b.query("commit");
      outcome = await attempt;
      await a.query("rollback");
    }));
    expect(outcome).toMatchObject({ code: "42501", hint: "not_authorised_inspector" });
    expect((await row(id)).stage).toBe("inspection");
    expect((await withDb((db) => db.query("select count(*)::int as n from public.job_inspections where job_id = $1", [id]))).rows[0].n).toBe(0);
    await flag(user("workshop"), true);
  });
});

describe("8.2 / 8.5.1 the drawing revision, only where the job needs it", () => {
  const set = (who: Who, id: string, required: boolean | null, revision: string | null, reason: string | null = null) =>
    q<{ r: Record<string, unknown> }>(who, "select public.set_job_drawing_revision($1, $2, $3, $4) as r", [id, required, revision, reason]).then((rows) => rows[0].r);
  const setRefusal = (who: Who, id: string, required: boolean | null, revision: string | null, reason: string | null = null) =>
    refusal(who, "select public.set_job_drawing_revision($1, $2, $3, $4)", [id, required, revision, reason]);

  it("off by default: nothing changes; on: Complete is refused until the job has its drawing revision", async () => {
    await flag(user("workshop"), true);
    const plain = await job();
    expect((await row(plain)).drawing_revision_required).toBe(false);
    expect((await pass(user("workshop"), plain)).result).toBe("pass");
    const needs = await job();
    expect(await set(user("office"), needs, true, null)).toMatchObject({ drawing_revision_required: true, drawing_revision: null, changed: true });
    const refused = await passRefusal(user("workshop"), needs);
    expect(refused).toMatchObject({ code: "22023", hint: "drawing_revision_required" });
    expect(refused!.message).toMatch(/drawing revision/);
    expect((await row(needs)).inspected_at).toBeNull();
    expect((await withDb((db) => db.query("select count(*)::int as n from public.job_inspections where job_id = $1", [needs]))).rows[0].n).toBe(0);
    // An admin's concession completes the job too, so it is refused the same way.
    const concession = INSPECT.replace("p_disposition => $4", "p_disposition => $4, p_concession_reason => 'Customer accepted it by e-mail'");
    expect(await refusal(user("admin"), concession, [needs, "concession", (await row(needs)).worksheet_version, null, null, null]))
      .toMatchObject({ code: "22023", hint: "drawing_revision_required" });
    expect(await set(user("workshop"), needs, null, " C ")).toMatchObject({ drawing_revision: "C", changed: true });
    expect((await pass(user("workshop"), needs)).result).toBe("pass");
    expect((await row(needs)).inspected_at).not.toBeNull();
  });

  it("set only through set_job_drawing_revision: who may, reasons, the worksheet version, a Complete job, the audit log", async () => {
    const id = await job();
    for (const column of ["drawing_revision = 'B'", "drawing_revision_required = true"]) {
      expect(await refusal(user("office"), `update public.jobs set ${column} where id = $1`, [id]), column).toMatchObject({ code: "42501", hint: "drawing_revision_via_rpc" });
    }
    expect(await setRefusal(user("viewer"), id, true, null)).toMatchObject({ code: "42501" });
    expect(await setRefusal(user("workshop"), id, true, null)).toMatchObject({ code: "42501" }); // the requirement: admin and office
    expect(await setRefusal(user("office", beta()), id, true, null)).toMatchObject({ code: "P0002" });
    expect(await setRefusal(user("office"), id, null, "ABCDEFGHIJKLMNOPQRSTU")).toMatchObject({ code: "22023" });
    const v0 = (await row(id)).worksheet_version;
    await set(user("workshop"), id, null, "B"); // the first revision needs no reason
    expect((await row(id)).worksheet_version).toBe(v0 + 1);
    expect(await setRefusal(user("office"), id, null, "C", "typo")).toMatchObject({ code: "22023", hint: "reason_required" });
    // Nothing asked for, or a blank revision: no change (a revision is replaced, never cleared).
    expect(await set(user("office"), id, null, null)).toMatchObject({ changed: false, drawing_revision: "B" });
    expect(await set(user("office"), id, null, "  ")).toMatchObject({ changed: false, drawing_revision: "B" });
    expect((await set(user("office"), id, null, "B"))).toMatchObject({ changed: false });
    await set(user("office"), id, true, "C", "Customer issued revision C on 14 Oct");
    expect(await setRefusal(user("office"), id, false, null, "short")).toMatchObject({ code: "22023", hint: "reason_required" });
    expect((await audit("SET_DRAWING_REVISION", id)).map((e) => [e.metadata.drawing_revision, e.metadata.was, e.metadata.drawing_revision_required, e.metadata.reason]))
      .toEqual([["B", null, false, null], ["C", "B", true, "Customer issued revision C on 14 Oct"]]);
    await flag(user("workshop"), true);
    await pass(user("workshop"), id);
    expect(await setRefusal(user("office"), id, null, "D", "Customer issued revision D today")).toMatchObject({ code: "22023", hint: "job_complete" });
  });
});

describe("083's grants", () => {
  it("the history table: RLS on, SELECT only for signed-in users, nothing for anon; the trigger functions aren't callable from the API", async () => {
    const r = (await withDb((db) => db.query<{ rls: boolean; anon: boolean; write: boolean; sel: boolean }>(`
      select c.relrowsecurity as rls,
             has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as anon,
             has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') as write,
             has_table_privilege('authenticated', c.oid, 'SELECT') as sel
      from pg_class c where c.oid = 'public.inspector_authorisations'::regclass`))).rows;
    expect(r).toEqual([{ rls: true, anon: false, write: false, sel: true }]);
    const internal = (await withDb((db) => db.query<{ n: number }>(`
      select count(*)::int as n from pg_proc p
      where p.oid in ('public.inspection_pass_authorised()'::regprocedure, 'public.organization_members_inspector_history()'::regprocedure,
                      'public.iso_083_record_immutable()'::regprocedure)
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`))).rows[0].n;
    expect(internal).toBe(0);
  });
});
