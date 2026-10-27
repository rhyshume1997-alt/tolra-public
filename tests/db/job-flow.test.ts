/**
 * The job flow and its release (migration 081): In progress -> Finished -> Complete, reopen with a reason, the inspection's evidence
 * and independence (ISO 9001 8.6 release, 8.7 nonconformance), the release gate on delivery notes and invoices, one draft invoice per
 * job made at Finish, the immutable history, offline replay, and the races where two sessions could interleave.
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
const who = (role: "admin" | "office" | "workshop" | "viewer"): Who => ({ id: alpha().users[role].id });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const one = async <R>(sql: string, params: unknown[] = []) => withDb(async (db) => (await db.query(sql, params)).rows[0] as R);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  // The office and the workshop may record inspections (034's can_inspect); the workshop is also the one who finishes.
  await withDb((db) => db.query("update public.organization_members set can_inspect = true where organization_id = $1 and user_id = any($2::uuid[])",
    [alpha().id, [alpha().users.office.id, alpha().users.workshop.id]]));
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** A confirmed sales order of £120 (one line, made when first needed) converted to its job by the office. */
async function orderJob(total = 120) {
  seq += 1;
  const so = await one<{ id: string }>(
    "insert into public.sales_orders (organization_id, so_number, customer, status, total_value, vat_enabled, vat_pct, vat_exempt) values ($1, $2, 'Flow Co', 'confirmed', $3, true, 20, false) returning id",
    [alpha().id, `SO-F-${world.runId}-${seq}`, total]);
  const made = (await q<{ r: { job_id: string; job_no: string } }>(who("office"), "select public.convert_sales_order($1) as r", [so.id]))[0].r;
  return { orderId: so.id, jobId: made.job_id, jobNo: made.job_no };
}

const finish = (by: Who, jobId: string) => q<{ r: { changed: boolean } }>(by, "select public.finish_job($1, $2, now()) as r", [jobId, randomUUID()]).then((r) => r[0].r);
/** The job's row with its flow status (081's public.flow_status, which PostgREST serves as the computed field flow_status). */
const job = (jobId: string) => one<Record<string, any>>("select j.*, public.flow_status(j) as flow_status from public.jobs j where j.id = $1", [jobId]); // eslint-disable-line @typescript-eslint/no-explicit-any
const events = (jobId: string) =>
  withDb(async (db) => (await db.query<{ kind: string; actor_user_id: string | null; reason: string | null; inspection_id: string | null; detail: Record<string, unknown> }>(
    "select kind, actor_user_id, reason, inspection_id, detail from public.job_flow_events where job_id = $1 order by seq", [jobId])).rows);
const inspections = (jobId: string) =>
  withDb(async (db) => (await db.query("select * from public.job_inspections where job_id = $1 order by inspected_at, id", [jobId])).rows);
const invoices = (jobId: string) =>
  withDb(async (db) => (await db.query("select id, status, invoice_ref, subtotal, vat, total from public.invoices where job_id = $1 order by created_at, id", [jobId])).rows);

type Inspect = { result?: "pass" | "fail" | "concession"; criteria?: string | null; measured?: string | null; override?: string | null; disposition?: string | null;
  failure?: Record<string, unknown> | null; key?: string | null; concession?: string | null; version?: number | null };
const INSPECT_SQL = `select public.inspect_job(p_job => $1, p_result => $2, p_criteria => $3, p_measured => $4, p_expected_version => $5,
  p_override_reason => $6, p_disposition => $7, p_failure => $8::jsonb, p_client_op_id => $9::uuid, p_concession_reason => $10) as r`;
async function inspectArgs(jobId: string, o: Inspect) {
  const version = o.version === undefined ? (await job(jobId)).worksheet_version : o.version;
  return [jobId, o.result ?? "pass", o.criteria === undefined ? "Drawing ACL-7 rev C: bore 25.00 +0.02/-0" : o.criteria,
    o.measured === undefined ? "Bore 25.01 mm, 25.01 mm (bore gauge 0001)" : o.measured, version, o.override ?? null, o.disposition ?? null,
    o.failure ? JSON.stringify(o.failure) : null, o.key ?? null, o.concession ?? null];
}
const inspect = async (by: Who, jobId: string, o: Inspect = {}) => (await q<{ r: Record<string, any> }>(by, INSPECT_SQL, await inspectArgs(jobId, o)))[0].r; // eslint-disable-line @typescript-eslint/no-explicit-any
const inspectRefusal = async (by: Who, jobId: string, o: Inspect = {}) => refusal(by, INSPECT_SQL, await inspectArgs(jobId, o));
const reopen = (by: Who, jobId: string, reason: string | null = "Finished by mistake, still machining") =>
  q<{ r: Record<string, unknown> }>(by, "select public.reopen_job($1, $2) as r", [jobId, reason]).then((r) => r[0].r);
/** The order's first line (the lines are made when first needed, 034). */
async function line(orderId: string) {
  await q(who("office"), "select public.ensure_sales_order_lines($1)", [orderId]);
  return one<{ id: string }>("select id from public.sales_order_lines where sales_order_id = $1 order by position limit 1", [orderId]);
}
/** 099: Finish drafts only what has been despatched (nothing, before a job is released), so a job's draft is made by hand: £120 + VAT. */
async function handDraft(jobId: string) {
  const id = (await q<{ r: string }>(who("office"), "select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb) as r", [
    JSON.stringify({ customer: "Flow Co", job_id: jobId, status: "draft", subtotal: 120, vat: 24, total: 144, carriage: 0, vat_enabled: true, invoice_date: "2026-10-01", due_date: "2026-10-31" }),
    JSON.stringify([{ description: "Flow work", quantity: 1, unit_price: 120, vat_pct: 20, vat_exempt: false }]),
  ]))[0].r;
  return { id };
}
const DN_SQL = "select public.create_delivery_note($1, $2, current_date, current_date, null, null, $3::jsonb) as r";
async function deliveryNote(by: Who, j: { orderId: string; jobId: string }) {
  const l = await line(j.orderId);
  return (await q<{ r: { id: string; dn_number: string } }>(by, DN_SQL, [j.orderId, j.jobId, JSON.stringify([{ line_id: l.id, quantity: 1 }])]))[0].r;
}

describe("the flow: In progress -> Finished -> Complete (081)", () => {
  it("maps every job from its own row, with no Done: finished is Finished, inspected Complete, rework In progress put back", async () => {
    const j = await orderJob();
    expect((await job(j.jobId)).flow_status).toBe("in_progress");
    await finish(who("workshop"), j.jobId);
    expect(await job(j.jobId)).toMatchObject({ flow_status: "finished", finished_by: who("workshop").id, stage: "inspection" });
    await inspect(who("office"), j.jobId);
    expect(await job(j.jobId)).toMatchObject({ flow_status: "complete", stage: "complete" });
    // Worked out from the row: there is nothing stored to write, and the signed-in roles read it.
    expect(await q(who("viewer"), "select public.flow_status(j) as v from public.jobs j where j.id = $1", [j.jobId])).toEqual([{ v: "complete" }]);
    const values = await one<{ v: string[] }>("select array_agg(distinct public.flow_status(j) order by public.flow_status(j)) as v from public.jobs j where j.organization_id = $1", [alpha().id]);
    expect(values.v.every((v) => ["in_progress", "finished", "complete"].includes(v))).toBe(true);
  });

  it("a Finish is kept: editing the job can't clear or move it (reopen_required); the history records who finished", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    for (const role of ["workshop", "office", "admin"] as const) {
      expect(await refusal(who(role), "update public.jobs set finished_at = null where id = $1", [j.jobId]), role).toMatchObject({ code: "42501", hint: "reopen_required" });
      expect(await refusal(who(role), "update public.jobs set finished_at = now() - interval '1 day' where id = $1", [j.jobId]), role).toMatchObject({ code: "42501", hint: "reopen_required" });
    }
    expect((await job(j.jobId)).finished_at).not.toBeNull();
    expect((await events(j.jobId)).map((e) => [e.kind, e.actor_user_id])).toEqual([["finish", who("workshop").id]]);
  });
});

describe("reopen: who, when and why (081)", () => {
  it("the operator undoes their own Finish while it awaits inspection, with a reason; machine time is kept", async () => {
    const j = await orderJob();
    const machine = await one<{ id: string }>("insert into public.machines (organization_id, name) values ($1, $2) returning id", [alpha().id, `Flow mill ${seq}`]);
    await withDb((db) => db.query("insert into public.machine_bookings (organization_id, machine_id, job_id, job_no, description, start_at, estimated_hours, status) values ($1, $2, $3, $4, 'Mill', now(), 2, 'booked')",
      [alpha().id, machine.id, j.jobId, j.jobNo]));
    await finish(who("workshop"), j.jobId);
    expect(await refusal(who("workshop"), "select public.reopen_job($1, $2)", [j.jobId, "oops"])).toMatchObject({ code: "22023", hint: "reason_required" });
    expect(await refusal(who("workshop"), "select public.reopen_job($1, null)", [j.jobId])).toMatchObject({ code: "22023", hint: "reason_required" });
    expect(await refusal(who("viewer"), "select public.reopen_job($1, $2)", [j.jobId, "Finished by mistake, still machining"])).toMatchObject({ code: "42501" });
    const done = await reopen(who("workshop"), j.jobId);
    expect(done).toMatchObject({ reopened: true, was_complete: false });
    expect(await job(j.jobId)).toMatchObject({ flow_status: "in_progress", finished_at: null, finished_by: null, stage: "machining" });
    // Machine time stays as the Finish recorded it.
    expect((await one<{ status: string }>("select status from public.machine_bookings where job_id = $1", [j.jobId])).status).toBe("complete");
    const flow = await events(j.jobId);
    expect(flow.map((e) => e.kind)).toEqual(["finish", "reopen"]);
    expect(flow[1]).toMatchObject({ actor_user_id: who("workshop").id, reason: "Finished by mistake, still machining", detail: { previous_finished_by: who("workshop").id, was: "finished" } });
    // 035's REOPEN is still written, and the reason is in the audit log (the history row is audited).
    const audit = await one<{ n: string }>("select count(*) as n from security_audit.audit_log where entity_table = 'job_flow_events' and new_data ->> 'job_id' = $1 and new_data ->> 'reason' = $2",
      [j.jobId, "Finished by mistake, still machining"]);
    expect(Number(audit.n)).toBe(1);
    // Nothing to reopen now.
    expect(await refusal(who("workshop"), "select public.reopen_job($1, $2)", [j.jobId, "Finished by mistake, still machining"])).toMatchObject({ code: "22023", hint: "not_finished" });
  });

  it("only the office or an admin reopens someone else's Finish or a Complete job; that voids the pass, and the history keeps it", async () => {
    const j = await orderJob();
    await finish(who("office"), j.jobId);
    expect(await refusal(who("workshop"), "select public.reopen_job($1, $2)", [j.jobId, "Not right, needs another pass"])).toMatchObject({ code: "42501", hint: "reopen_not_allowed" });
    await reopen(who("admin"), j.jobId, "Office finished it by mistake");
    await finish(who("workshop"), j.jobId);
    const passed = await inspect(who("office"), j.jobId);
    expect(await refusal(who("workshop"), "select public.reopen_job($1, $2)", [j.jobId, "Spotted a burr after the pass"])).toMatchObject({ code: "42501", hint: "reopen_not_allowed" });
    const back = await reopen(who("office"), j.jobId, "Customer changed the finish spec");
    expect(back).toMatchObject({ was_complete: true, voided_inspection_id: passed.inspection_id });
    expect(await job(j.jobId)).toMatchObject({ flow_status: "in_progress", inspected_at: null, inspected_by: null, stage: "machining" });
    expect((await events(j.jobId)).map((e) => e.kind)).toEqual(["finish", "reopen", "finish", "complete", "reopen", "pass_voided"]);
    expect((await events(j.jobId))[5]).toMatchObject({ inspection_id: passed.inspection_id, detail: { cause: "reopened" } });
    // The pass itself stays on record, unchanged.
    expect((await inspections(j.jobId)).map((i) => i.result)).toEqual(["pass"]);
  });

  it("is refused once a delivery note has gone out or the invoice has been issued", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    await inspect(who("office"), j.jobId);
    const dn = await deliveryNote(who("workshop"), j);
    await q(who("office"), "update public.delivery_notes set status = 'despatched' where id = $1", [dn.id]);
    expect(await refusal(who("admin"), "select public.reopen_job($1, $2)", [j.jobId, "Customer changed the finish spec"])).toMatchObject({ code: "22023", hint: "already_despatched" });
    const k = await orderJob();
    await finish(who("workshop"), k.jobId);
    await inspect(who("office"), k.jobId);
    const draft = await handDraft(k.jobId);
    await q(who("office"), "select public.issue_invoice($1)", [draft.id]);
    expect(await refusal(who("admin"), "select public.reopen_job($1, $2)", [k.jobId, "Customer changed the finish spec"])).toMatchObject({ code: "22023", hint: "invoice_issued" });
  });
});

describe("inspection evidence and independence (081)", () => {
  it("a pass needs the acceptance criteria and the measured result; the older call without criteria is refused", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    expect(await inspectRefusal(who("office"), j.jobId, { criteria: " " })).toMatchObject({ code: "22023", hint: "criteria_required" });
    expect(await inspectRefusal(who("office"), j.jobId, { measured: null })).toMatchObject({ code: "22023", hint: "criteria_required" });
    const version = (await job(j.jobId)).worksheet_version;
    expect(await refusal(who("office"), "select public.record_job_inspection($1, 'pass', 'Bore 25.01', null, null, null, $2)", [j.jobId, version]))
      .toMatchObject({ code: "22023", hint: "criteria_required" });
    expect(await inspections(j.jobId)).toHaveLength(0);
    const done = await inspect(who("office"), j.jobId);
    expect(done).toMatchObject({ result: "pass", independent: true, not_independent_reason: null });
    expect((await inspections(j.jobId))[0]).toMatchObject({ acceptance_criteria: "Drawing ACL-7 rev C: bore 25.00 +0.02/-0", measured_notes: "Bore 25.01 mm, 25.01 mm (bore gauge 0001)",
      independent: true, override_reason: null, inspector_id: who("office").id, inspector_name: "Office alpha", finisher_ids: [who("workshop").id] });
  });

  it("the person who finished it can't record the pass; an admin can, with a reason of 10+ characters, recorded as not independent", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    expect(await inspectRefusal(who("workshop"), j.jobId)).toMatchObject({ code: "42501", hint: "not_independent" });
    expect(await inspectRefusal(who("workshop"), j.jobId, { override: "Only inspector on site today" })).toMatchObject({ code: "42501", hint: "not_independent" });
    const k = await orderJob();
    await finish(who("admin"), k.jobId);
    expect(await inspectRefusal(who("admin"), k.jobId)).toMatchObject({ code: "42501", hint: "not_independent" });
    expect(await inspectRefusal(who("admin"), k.jobId, { override: "too short" })).toMatchObject({ code: "22023", hint: "override_reason" });
    const done = await inspect(who("admin"), k.jobId, { override: "Sole inspector on the night shift; checked against the drawing" });
    expect(done).toMatchObject({ result: "pass", independent: false, not_independent_reason: "Sole inspector on the night shift; checked against the drawing" });
    const [record] = await inspections(k.jobId);
    expect(record).toMatchObject({ inspector_id: who("admin").id, inspector_name: "Admin alpha", independent: false, override_reason: "Sole inspector on the night shift; checked against the drawing" });
    expect(await job(k.jobId)).toMatchObject({ flow_status: "complete", inspected_by: "Admin alpha" });
    expect((await events(k.jobId)).find((e) => e.kind === "complete")).toMatchObject({ reason: "Sole inspector on the night shift; checked against the drawing", detail: { independent: false } });
    // A concession by the admin who finished it needs the same reason.
    const c = await orderJob();
    await finish(who("admin"), c.jobId);
    expect(await inspectRefusal(who("admin"), c.jobId, { result: "concession", concession: "Customer accepted by e-mail" })).toMatchObject({ code: "42501", hint: "not_independent" });
  });

  it("every inspection record is immutable, for the service role and the owner too", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    const done = await inspect(who("office"), j.jobId);
    for (const sql of ["update public.job_inspections set acceptance_criteria = 'changed' where id = $1", "update public.job_inspections set independent = false, override_reason = 'made up afterwards' where id = $1",
      "delete from public.job_inspections where id = $1"]) {
      await expect(withDb((db) => db.query(sql, [done.inspection_id]))).rejects.toMatchObject({ code: "42501" });
    }
    const flow = await events(j.jobId);
    expect(flow.length).toBeGreaterThan(0);
    await expect(withDb((db) => db.query("update public.job_flow_events set reason = 'x' where job_id = $1", [j.jobId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withDb((db) => db.query("delete from public.job_flow_events where job_id = $1", [j.jobId]))).rejects.toMatchObject({ code: "42501" });
    for (const role of ["admin", "office", "workshop"] as const) {
      expect(await refusal(who(role), "insert into public.job_flow_events (organization_id, job_id, kind) values ($1, $2, 'complete')", [alpha().id, j.jobId]), role).toMatchObject({ code: "42501" });
    }
    // Readable by everyone in the company; nothing of another company.
    expect(await q(who("viewer"), "select kind from public.job_flow_events where job_id = $1", [j.jobId])).toHaveLength(flow.length);
    expect(await q({ id: world.tenants.beta.users.admin.id }, "select kind from public.job_flow_events where job_id = $1", [j.jobId])).toHaveLength(0);
  });
});

describe("a failed inspection (8.7): disposition, put back, a new inspection (081)", () => {
  it("rework: put back to In progress with the disposition and who authorised it; the rework's finisher can't pass it; a new inspection completes it", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    expect(await inspectRefusal(who("office"), j.jobId, { result: "fail", failure: { reason: "Bore oversize 25.06" } })).toMatchObject({ code: "22023", hint: "disposition_required" });
    expect(await inspectRefusal(who("office"), j.jobId, { result: "fail", disposition: "rework", failure: {} })).toMatchObject({ code: "22023", hint: "disposition_required" });
    const failed = await inspect(who("office"), j.jobId, { result: "fail", disposition: "rework", measured: "Bore 25.06 mm", failure: { reason: "Bore oversize 25.06", instructions: "Sleeve and re-bore" } });
    expect(failed).toMatchObject({ result: "fail", disposition: "rework" });
    expect(await job(j.jobId)).toMatchObject({ flow_status: "in_progress", stage: "rework" });
    expect((await inspections(j.jobId))[0]).toMatchObject({ result: "fail", disposition: "rework", disposition_by: who("office").id, acceptance_criteria: "Drawing ACL-7 rev C: bore 25.00 +0.02/-0" });
    expect((await events(j.jobId)).at(-1)).toMatchObject({ kind: "put_back", inspection_id: failed.inspection_id, detail: { disposition: "rework" } });
    // The job's draft invoice stays unissued.
    const draft = await handDraft(j.jobId);
    expect(await refusal(who("office"), "select public.issue_invoice($1)", [draft.id])).toMatchObject({ code: "22023", hint: "job_not_complete" });
    expect(await inspectRefusal(who("office"), j.jobId)).toMatchObject({ code: "22023" }); // in rework
    const rework = await one<{ id: string }>("select id from public.job_rework where job_id = $1 and status = 'open'", [j.jobId]);
    await q(who("workshop"), "select public.start_job_rework($1)", [rework.id]);
    await q(who("workshop"), "select public.finish_job_rework($1, null, 0)", [rework.id]);
    expect(await job(j.jobId)).toMatchObject({ flow_status: "finished", stage: "inspection" });
    expect((await events(j.jobId)).at(-1)).toMatchObject({ kind: "finish", actor_user_id: who("workshop").id, detail: { after_rework: true } });
    // The workshop finished the rework, so it can't pass it either.
    expect(await inspectRefusal(who("workshop"), j.jobId)).toMatchObject({ code: "42501", hint: "not_independent" });
    const passed = await inspect(who("office"), j.jobId, { measured: "Bore 25.01 mm after sleeving" });
    expect(passed).toMatchObject({ result: "pass", independent: true });
    expect(await job(j.jobId)).toMatchObject({ flow_status: "complete" });
    expect((await inspections(j.jobId)).map((i) => i.result)).toEqual(["fail", "pass"]);
  });

  it("scrap scraps the failed quantity at once; concession is for an admin only, and releases it", async () => {
    const j = await orderJob();
    await withDb((db) => db.query("update public.jobs set quantity_required = 1 where id = $1", [j.jobId]));
    await finish(who("workshop"), j.jobId);
    const scrapped = await inspect(who("office"), j.jobId, { result: "fail", disposition: "scrap", failure: { reason: "Cracked on the flange" } });
    expect(await one("select quantity_affected, quantity_scrapped from public.job_rework where id = $1", [scrapped.rework_id])).toMatchObject({ quantity_affected: 1, quantity_scrapped: 1 });
    expect(await job(j.jobId)).toMatchObject({ flow_status: "in_progress", stage: "rework" });

    const c = await orderJob();
    await finish(who("workshop"), c.jobId);
    expect(await inspectRefusal(who("office"), c.jobId, { result: "fail", disposition: "concession", failure: { reason: "Bore 25.03" }, concession: "Customer accepted 25.03" }))
      .toMatchObject({ code: "42501", hint: "concession_admin_only" });
    const conceded = await inspect(who("admin"), c.jobId, { result: "fail", disposition: "concession", measured: "Bore 25.03 mm", failure: { reason: "Bore 25.03, 0.01 over" }, concession: "Customer accepted 25.03 by e-mail 19/10" });
    expect(conceded).toMatchObject({ result: "fail", disposition: "concession", release_decision: "released" });
    // Both records are written in one transaction (the same time): the fail carries the disposition and who authorised it.
    expect((await inspections(c.jobId)).map((i) => [i.result, i.disposition, i.disposition_by]).sort()).toEqual([["concession", null, null], ["fail", "concession", who("admin").id]]);
    expect(await job(c.jobId)).toMatchObject({ flow_status: "complete" });
  });
});

describe("release (8.6): delivery notes and invoices only for a Complete job, or an admin's early release (081)", () => {
  it("a delivery note is neither made nor sent out until the job is Complete; a hand-made note naming the job too", async () => {
    const j = await orderJob();
    const l = await line(j.orderId);
    expect(await refusal(who("workshop"), DN_SQL, [j.orderId, j.jobId, JSON.stringify([{ line_id: l.id, quantity: 1 }])])).toMatchObject({ code: "22023" });
    await finish(who("workshop"), j.jobId);
    expect(await refusal(who("workshop"), DN_SQL, [j.orderId, j.jobId, JSON.stringify([{ line_id: l.id, quantity: 1 }])])).toMatchObject({ code: "22023" });
    expect(await refusal(who("office"), "insert into public.delivery_notes (organization_id, dn_number, customer, job_ref) values ($1, $2, 'Flow Co', $3)", [alpha().id, `DN-H-${world.runId}-${seq}`, j.jobNo]))
      .toMatchObject({ code: "22023", hint: "job_not_released" });
    await inspect(who("office"), j.jobId);
    const dn = await deliveryNote(who("workshop"), j);
    expect(dn.dn_number).toMatch(/^DLN-/);
  });

  it("an admin's early release, with a reason, lets it go before inspection; a failure or a reopen voids it", async () => {
    const j = await orderJob();
    expect(await refusal(who("admin"), "select public.release_job_early($1, $2)", [j.jobId, "Customer collecting today"])).toMatchObject({ code: "22023", hint: "not_finished" });
    await finish(who("workshop"), j.jobId);
    expect(await refusal(who("office"), "select public.release_job_early($1, $2)", [j.jobId, "Customer collecting today"])).toMatchObject({ code: "42501", hint: "early_release_admin_only" });
    expect(await events(j.jobId)).not.toContainEqual(expect.objectContaining({ kind: "early_release" }));
    expect(await refusal(who("admin"), "select public.release_job_early($1, $2)", [j.jobId, "today"])).toMatchObject({ code: "22023", hint: "reason_required" });
    const early = (await q<{ r: Record<string, unknown> }>(who("admin"), "select public.release_job_early($1, $2) as r", [j.jobId, "Customer collecting today, inspection on return"]))[0].r;
    expect(early).toMatchObject({ released_early: true, already: false });
    expect(await job(j.jobId)).toMatchObject({ flow_status: "finished" });
    const dn = await deliveryNote(who("workshop"), j);
    // A failure voids it: the note can't go out now.
    await inspect(who("office"), j.jobId, { result: "fail", disposition: "rework", failure: { reason: "Thread no-go enters", instructions: "Re-tap" } });
    expect(await refusal(who("office"), "update public.delivery_notes set status = 'despatched' where id = $1", [dn.id])).toMatchObject({ code: "22023" });
    // Released early again (the rest of a part failure would go; here the whole job is held, so nothing can).
    await q(who("admin"), "select public.release_job_early($1, $2)", [j.jobId, "Second release: customer chasing"]);
    expect(await refusal(who("office"), "update public.delivery_notes set status = 'despatched' where id = $1", [dn.id])).toMatchObject({ code: "22023" });
    const k = await orderJob();
    await finish(who("workshop"), k.jobId);
    await q(who("admin"), "select public.release_job_early($1, $2)", [k.jobId, "Customer collecting today, inspection on return"]);
    await reopen(who("office"), k.jobId, "Wrong material: back to the bench");
    await finish(who("workshop"), k.jobId);
    expect(await refusal(who("workshop"), DN_SQL, [k.orderId, k.jobId, JSON.stringify([{ line_id: (await line(k.orderId)).id, quantity: 1 }])])).toMatchObject({ code: "22023" });
  });

  it("a part failure no longer releases the rest by itself; an admin's early release lets only the unaffected part go", async () => {
    seq += 1;
    const so = await one<{ id: string }>(
      "insert into public.sales_orders (organization_id, so_number, customer, status, total_value, vat_enabled, vat_pct, vat_exempt) values ($1, $2, 'Flow Co', 'confirmed', 200, true, 20, false) returning id",
      [alpha().id, `SO-F-${world.runId}-${seq}`]);
    const l = await one<{ id: string }>("insert into public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, 0, 'Bush 25mm', 4, 50, 20, false) returning id",
      [alpha().id, so.id]);
    const made = (await q<{ r: { job_id: string } }>(who("office"), "select public.convert_sales_order($1) as r", [so.id]))[0].r;
    await withDb((db) => db.query("update public.jobs set quantity_required = 4 where id = $1", [made.job_id]));
    await finish(who("workshop"), made.job_id);
    await inspect(who("office"), made.job_id, { result: "fail", disposition: "rework", failure: { reason: "One bush oversize", instructions: "Re-ream", quantity: 1 } });
    const lines = (n: number) => JSON.stringify([{ line_id: l.id, quantity: n }]);
    // Before 081 the three that passed could go; now nothing goes until it is Complete.
    expect(await refusal(who("workshop"), DN_SQL, [so.id, made.job_id, lines(3)])).toMatchObject({ code: "22023" });
    await q(who("admin"), "select public.release_job_early($1, $2)", [made.job_id, "Customer needs the three good bushes today"]);
    expect(await refusal(who("workshop"), DN_SQL, [so.id, made.job_id, lines(4)])).toMatchObject({ code: "22023" });
    const dn = (await q<{ r: { id: string } }>(who("workshop"), DN_SQL, [so.id, made.job_id, lines(3)]))[0].r;
    await q(who("office"), "update public.delivery_notes set status = 'despatched' where id = $1", [dn.id]);
    expect((await one<{ status: string }>("select status from public.delivery_notes where id = $1", [dn.id])).status).toBe("despatched");
  });

  it("one draft invoice per job, issued only once Complete; Finish drafts only what was despatched (099); notes sent out go on the job's draft", async () => {
    const j = await orderJob(250);
    await finish(who("workshop"), j.jobId);
    // 099: nothing has been despatched (a job is released only once Complete), so Finish makes no draft.
    expect(await invoices(j.jobId)).toHaveLength(0);
    const hand = await handDraft(j.jobId);
    expect(await refusal(who("office"), "select public.issue_invoice($1)", [hand.id])).toMatchObject({ code: "22023", hint: "job_not_complete" });
    // A second draft for the job is refused from any path.
    expect(await refusal(who("office"), "select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', '[]'::jsonb)",
      [JSON.stringify({ customer: "Flow Co", job_id: j.jobId, status: "draft", subtotal: 0, vat: 0, total: 0 })])).toMatchObject({ code: "22023", hint: "job_has_draft" });
    await withDb((db) => db.query("delete from public.invoices where id = $1", [hand.id]));
    // Reopened and finished again: still none.
    await reopen(who("workshop"), j.jobId);
    await finish(who("workshop"), j.jobId);
    expect(await invoices(j.jobId)).toHaveLength(0);
    await inspect(who("office"), j.jobId);
    const dn = await deliveryNote(who("workshop"), j);
    await q(who("office"), "update public.delivery_notes set status = 'despatched' where id = $1", [dn.id]);
    const drafts = await invoices(j.jobId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "draft", invoice_ref: null, subtotal: "250.00" });
    expect(Number(drafts[0].total)).toBe(Number(drafts[0].subtotal) + Number(drafts[0].vat));
    expect((await one<{ invoice_id: string }>("select invoice_id from public.delivery_notes where id = $1", [dn.id])).invoice_id).toBe(drafts[0].id);
    const ref = (await q<{ r: string }>(who("office"), "select public.issue_invoice($1) as r", [drafts[0].id]))[0].r;
    expect(ref).toMatch(/^INV-/);
  });
});

describe("offline replay of an inspection (081)", () => {
  it("a replay of the key answers the first record; a queued pass by the finisher is refused unless an admin's reason is in it; a key reused is refused", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    const key = randomUUID();
    // Queued on the finisher's device: refused on replay (offline it was only "Sync pending", never a release).
    expect(await inspectRefusal(who("workshop"), j.jobId, { key })).toMatchObject({ code: "42501", hint: "not_independent" });
    expect(await job(j.jobId)).toMatchObject({ flow_status: "finished" });
    const first = await inspect(who("office"), j.jobId, { key });
    const again = await inspect(who("office"), j.jobId, { key });
    expect(again).toMatchObject({ inspection_id: first.inspection_id, replayed: true });
    expect(await inspections(j.jobId)).toHaveLength(1);
    const k = await orderJob();
    await finish(who("workshop"), k.jobId);
    expect(await inspectRefusal(who("office"), k.jobId, { key })).toMatchObject({ code: "22023", hint: "client_op_reused" });
    // An admin who finished it, the reason in the queued payload: recorded, not independent.
    const a = await orderJob();
    await finish(who("admin"), a.jobId);
    const own = await inspect(who("admin"), a.jobId, { key: randomUUID(), override: "Sole inspector on site; checked to the drawing" });
    expect(own).toMatchObject({ independent: false });
  });

  it("a committed pass or fail is answered on replay even after the inspector lost the right to inspect, with nothing inserted; a new key goes through the checks", async () => {
    const byKey = (key: string) => one<{ n: number }>("select count(*)::int as n from public.job_inspections where client_op_id = $1", [key]).then((r) => r.n);
    const p = await orderJob();
    await finish(who("workshop"), p.jobId);
    const f = await orderJob();
    await finish(who("workshop"), f.jobId);
    const passKey = randomUUID();
    const failKey = randomUUID();
    const passed = await inspect(who("office"), p.jobId, { key: passKey });
    const failed = await inspect(who("office"), f.jobId, { key: failKey, result: "fail", disposition: "rework", failure: { reason: "Thread no-go enters", instructions: "Re-tap" } });
    const before = { p: (await inspections(p.jobId)).length, f: (await inspections(f.jobId)).length };
    const setInspect = (on: boolean) => withDb((db) => db.query("update public.organization_members set can_inspect = $3 where organization_id = $1 and user_id = $2", [alpha().id, who("office").id, on]));
    await setInspect(false);
    try {
      expect(await inspect(who("office"), p.jobId, { key: passKey })).toMatchObject({ inspection_id: passed.inspection_id, result: "pass", replayed: true });
      expect(await inspect(who("office"), f.jobId, { key: failKey, result: "fail", disposition: "rework", failure: { reason: "Thread no-go enters", instructions: "Re-tap" } }))
        .toMatchObject({ inspection_id: failed.inspection_id, result: "fail", replayed: true });
      expect([await byKey(passKey), await byKey(failKey)]).toEqual([1, 1]);
      expect({ p: (await inspections(p.jobId)).length, f: (await inspections(f.jobId)).length }).toEqual(before);
      expect(await job(p.jobId)).toMatchObject({ flow_status: "complete" });
      expect(await job(f.jobId)).toMatchObject({ flow_status: "in_progress", stage: "rework" });
      // A new key (a new attempt) goes through the checks: refused, nothing written.
      const fresh = randomUUID();
      expect(await inspectRefusal(who("office"), f.jobId, { key: fresh, result: "fail", disposition: "rework", failure: { reason: "Again", instructions: "Re-tap" } }))
        .toMatchObject({ code: "42501" });
      expect(await byKey(fresh)).toBe(0);
      // The key with another result, or another job, is still refused as reused.
      expect(await inspectRefusal(who("office"), p.jobId, { key: failKey })).toMatchObject({ code: "22023", hint: "client_op_reused" });
    } finally {
      await setInspect(true);
    }
    // Someone else replaying the key is refused (it is the inspector's own), and inserts nothing.
    expect(await inspectRefusal(who("admin"), p.jobId, { key: passKey })).toMatchObject({ code: "22023", hint: "client_op_reused" });
    expect(await byKey(passKey)).toBe(1);
  });

  it("the office is refused a concession and an early release (admin only on the server), with nothing recorded", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    await inspect(who("office"), j.jobId, { result: "fail", disposition: "rework", failure: { reason: "Bore 25.03", instructions: "Hone to size" } });
    const before = (await inspections(j.jobId)).length;
    expect(await inspectRefusal(who("office"), j.jobId, { result: "concession", concession: "Customer accepted 25.03" })).toMatchObject({ code: "42501" });
    expect(await inspectRefusal(who("office"), j.jobId, { result: "fail", disposition: "concession", failure: { reason: "Bore 25.03" }, concession: "Customer accepted 25.03" }))
      .toMatchObject({ code: "42501", hint: "concession_admin_only" });
    expect(await refusal(who("office"), "select public.release_job_early($1, $2)", [j.jobId, "Customer collecting today"])).toMatchObject({ code: "42501", hint: "early_release_admin_only" });
    expect((await inspections(j.jobId)).length).toBe(before);
    expect(await events(j.jobId)).not.toContainEqual(expect.objectContaining({ kind: "early_release" }));
    expect(await job(j.jobId)).toMatchObject({ flow_status: "in_progress", stage: "rework" });
  });
});

// ---- Races: two sessions, the second seen waiting on the job's row lock before the first commits -----------------------------------
type Outcome = { ok: true; rows: unknown[] } | { ok: false; code?: string; hint?: string; message: string };
const settle = (p: Promise<{ rows: unknown[] }>): Promise<Outcome> =>
  p.then((r) => ({ ok: true as const, rows: r.rows }), (e: { code?: string; hint?: string; message: string }) => ({ ok: false as const, code: e.code, hint: e.hint, message: e.message }));

async function waitsOnLock(watch: Client, pid: number) {
  for (let i = 0; i < 500; i += 1) {
    const r = await watch.query<{ t: string | null }>("select wait_event_type as t from pg_stat_activity where pid = $1", [pid]);
    if (r.rows[0]?.t === "Lock") return true;
    await sleep(10);
  }
  return false;
}

/** Runs `first` as `a` in an open transaction, then `second` as `b`, which must wait for the first's lock; commits the first, then the second. */
async function race(a: Who, first: [string, unknown[]], b: Who, second: [string, unknown[]]) {
  return withDb((watch) => withDb((one_) => withDb(async (two) => {
    await one_.query("begin");
    await become(one_, a);
    const firstOut = await settle(one_.query(first[0], first[1]));
    await two.query("begin");
    await become(two, b);
    const pid = (await two.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;
    const pending = settle(two.query(second[0], second[1]));
    const waited = await waitsOnLock(watch, pid);
    await one_.query(firstOut.ok ? "commit" : "rollback");
    const secondOut = await pending;
    await two.query(secondOut.ok ? "commit" : "rollback");
    return { firstOut, secondOut, waited };
  })));
}

describe("races (081)", () => {
  it("reopen vs pass: the operator's reopen waits for the pass, then is refused (Complete); the office's reopen after a pass voids it", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    const r1 = await race(who("office"), [INSPECT_SQL, await inspectArgs(j.jobId, {})], who("workshop"), ["select public.reopen_job($1, $2)", [j.jobId, "Finished by mistake, still machining"]]);
    expect(r1.waited).toBe(true);
    expect(r1.firstOut.ok).toBe(true);
    expect(r1.secondOut).toMatchObject({ ok: false, code: "42501", hint: "reopen_not_allowed" });
    expect(await job(j.jobId)).toMatchObject({ flow_status: "complete" });

    const k = await orderJob();
    await finish(who("workshop"), k.jobId);
    const r2 = await race(who("workshop"), ["select public.reopen_job($1, $2)", [k.jobId, "Finished by mistake, still machining"]], who("office"), [INSPECT_SQL, await inspectArgs(k.jobId, {})]);
    expect(r2.waited).toBe(true);
    expect(r2.firstOut.ok).toBe(true);
    // The pass waited for the reopen, then found the job not finished.
    expect(r2.secondOut).toMatchObject({ ok: false, code: "22023" });
    expect(await job(k.jobId)).toMatchObject({ flow_status: "in_progress" });
    expect(await inspections(k.jobId)).toHaveLength(0);
  });

  it("two passes at once: one record, the second is refused; two replays of one key: one record, the second answers it", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    const r = await race(who("office"), [INSPECT_SQL, await inspectArgs(j.jobId, {})], who("admin"), [INSPECT_SQL, await inspectArgs(j.jobId, {})]);
    expect(r.waited).toBe(true);
    expect(r.firstOut.ok).toBe(true);
    expect(r.secondOut).toMatchObject({ ok: false, code: "22023" });
    expect(await inspections(j.jobId)).toHaveLength(1);

    const k = await orderJob();
    await finish(who("workshop"), k.jobId);
    const key = randomUUID();
    const args = await inspectArgs(k.jobId, { key });
    const s = await race(who("office"), [INSPECT_SQL, args], who("office"), [INSPECT_SQL, args]);
    expect(s.waited).toBe(true);
    expect(s.secondOut).toMatchObject({ ok: true });
    expect(((s.secondOut as { rows: Array<{ r: Record<string, unknown> }> }).rows[0].r)).toMatchObject({ replayed: true });
    expect(await inspections(k.jobId)).toHaveLength(1);
  });

  it("issue vs reopen: an issue waiting on a reopen is refused; a delivery note sent out while a failure is recorded is refused", async () => {
    const j = await orderJob();
    await finish(who("workshop"), j.jobId);
    await inspect(who("office"), j.jobId);
    const draft = await handDraft(j.jobId);
    const r = await race(who("office"), ["select public.reopen_job($1, $2)", [j.jobId, "Customer changed the finish spec"]], who("office"), ["select public.issue_invoice($1)", [draft.id]]);
    expect(r.waited).toBe(true);
    expect(r.firstOut.ok).toBe(true);
    expect(r.secondOut).toMatchObject({ ok: false, code: "22023", hint: "job_not_complete" });
    expect((await invoices(j.jobId))[0]).toMatchObject({ status: "draft", invoice_ref: null });

    const k = await orderJob();
    await finish(who("workshop"), k.jobId);
    await inspect(who("office"), k.jobId);
    const dn = await deliveryNote(who("workshop"), k);
    const f = await race(who("admin"), [INSPECT_SQL, await inspectArgs(k.jobId, { result: "fail", disposition: "rework", failure: { reason: "Found a crack", instructions: "Replace" } })],
      who("office"), ["update public.delivery_notes set status = 'despatched' where id = $1", [dn.id]]);
    expect(f.waited).toBe(true);
    expect(f.firstOut.ok).toBe(true);
    expect(f.secondOut).toMatchObject({ ok: false, code: "22023" });
    expect((await one<{ status: string }>("select status from public.delivery_notes where id = $1", [dn.id])).status).toBe("awaiting");
  });
});
