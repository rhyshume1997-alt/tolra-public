/**
 * Failed inspection and rework (migration 037, issue #2), through the real API path: Supabase Auth + PostgREST with a signed-in
 * synthetic user, so the database's own rules are under test.
 *
 *   * fail -> rework -> re-inspect (pass) -> release, with the reason, the quantity, the instructions, the hours and material kept
 *     apart from the job's own hours, and every step in the audit trail with who and when;
 *   * a concession is for admins only and closes the rework;
 *   * a scrapped part quantity raises what remains to be made;
 *   * despatch holds only the batch in rework: the good quantity of a part failure goes out, the failed quantity and replacements
 *     never made don't, a pass on the held quantity lets the rest go, and a failure and a despatch at the same moment never send
 *     failed parts (the job row is locked by both);
 *   * finishing records the replacements actually made; nothing moves the job in or out of the rework stage except the rework functions;
 *   * other companies and read-only support sessions are refused.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generatePassword } from "@/lib/password";

import { type SyntheticWorld, adminClient, allowInspectors, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { enrolTotp, passSecondStep } from "../support/totp";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let counter = 0;
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  // Office and workshop record inspections only once an admin has made them inspectors (034).
  await allowInspectors(world);
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** What a call did, with the database's own code and message, so a failure in CI says why. */
const outcome = (r: { error: { code?: string; message?: string } | null }) => ({ code: r.error?.code ?? null, message: r.error?.message ?? null });
const SAVED = { code: null, message: null };

/** A finished job awaiting inspection, made by the service role (the importer's path). */
async function finishedJob(quantity: number | null = 10, org = world.tenants.alpha.id) {
  const { data, error } = await adminClient().from("jobs")
    .insert({ organization_id: org, job_no: `J-RW-${world.runId}-${++counter}`, customer: "Rework Co", stage: "inspection", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", quantity_required: quantity })
    .select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const job = async (id: string) => (await adminClient().from("jobs").select("stage, inspected_at, inspected_by, quantity_required, job_time_taken_hr").eq("id", id).single()).data!;
const reworks = async (id: string) => ((await adminClient().from("job_rework").select("*").eq("job_id", id).order("raised_at")).data ?? []) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const inspections = async (id: string) => ((await adminClient().from("job_inspections").select("result, release_decision").eq("job_id", id).order("inspected_at")).data ?? []).map((r) => r.result);
const audit = (id: string, action: string) => withDb(async (db) => (await db.query("select actor_user_id, metadata, created_at from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2 order by created_at", [id, action])).rows);

const fail = (client: SupabaseClient, id: string, extra: Record<string, unknown> = {}) =>
  client.rpc("fail_job_inspection", { p_job: id, p_notes: "Bore 25.08 mm", p_reason: "Bore oversize", p_quantity: null, p_instructions: "Re-bore and re-measure", p_attachment_path: null, p_attachment_name: null, ...extra });
const start = (client: SupabaseClient, rework: string) => client.rpc("start_job_rework", { p_rework: rework });
const cost = (client: SupabaseClient, rework: string, extra: Record<string, unknown> = {}) =>
  client.rpc("record_rework_cost", { p_rework: rework, p_hours: 1.5, p_material: null, p_material_cost: null, p_note: null, ...extra });
const scrap = (client: SupabaseClient, rework: string, quantity: number, reason: string | null = "Cracked on re-bore") => client.rpc("scrap_job_quantity", { p_rework: rework, p_quantity: quantity, p_reason: reason });
/** Finishing records the replacements made this time (p_remade; 0 when nothing was scrapped). */
const finish = (client: SupabaseClient, rework: string, remade: number | null = 0) => client.rpc("finish_job_rework", { p_rework: rework, p_note: null, p_remade: remade });
/** Records an inspection against the job's current worksheet version (034 refuses a stale one). */
const inspect = async (client: SupabaseClient, id: string, result: string, notes = "Re-measured: 25.01 mm", reason: string | null = null) => {
  const version = (await adminClient().from("jobs").select("worksheet_version").eq("id", id).maybeSingle()).data?.worksheet_version ?? 0;
  return recordInspection(client, { p_job: id, p_result: result, p_notes: notes, p_attachment_path: null, p_attachment_name: null, p_concession_reason: reason, p_expected_version: version });
};
/**
 * 081 (ISO 9001 8.6): a failed job is back In progress and nothing of it is released until it is Complete again; the part that passed
 * goes before that only on an admin's early release, with a reason (what is held in rework stays held). A later failure, a reopen or a
 * worksheet change voids the early release.
 */
const releaseEarly = async (id: string) =>
  expect(outcome(await as.admin.rpc("release_job_early", { p_job: id, p_reason: "Customer needs the good parts now" }))).toEqual(SAVED);
const summary = async (client: SupabaseClient, id: string) => {
  const r = await client.rpc("job_rework_summary", { p_job: id });
  expect(outcome(r)).toEqual(SAVED);
  return r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe("fail, rework, re-inspect, release", () => {
  it("a fail opens a rework for the workshop; the loop ends with a pass that releases the job", async () => {
    const id = await finishedJob(10);
    const failed = await fail(as.office, id, { p_quantity: 4, p_reason: "Four bores oversize", p_instructions: "Re-bore 4 off to 25.00 +0.03" });
    expect(outcome(failed)).toEqual(SAVED);
    expect(failed.data).toMatchObject({ result: "fail", release_decision: "held", quantity_affected: 4, affects_all: false });
    expect(await job(id)).toMatchObject({ stage: "rework", inspected_at: null });
    const [rework] = await reworks(id);
    expect(rework).toMatchObject({ status: "open", reason: "Four bores oversize", instructions: "Re-bore 4 off to 25.00 +0.03", quantity_affected: 4, affects_all: false, assigned_to: "workshop",
      raised_by: world.tenants.alpha.users.office.id, organization_id: world.tenants.alpha.id, inspection_id: failed.data.inspection_id });
    expect(await inspections(id)).toEqual(["fail"]);

    // Everyone in the company can read the rework; the record is the same for them.
    for (const role of ["admin", "office", "workshop", "viewer"]) expect((await as[role].from("job_rework").select("id").eq("job_id", id)).data, `${role} read`).toHaveLength(1);

    // The workshop starts it; hours and material are booked against the rework, apart from the job's own hours.
    expect(outcome(await cost(as.workshop, rework.id))).toMatchObject({ code: "22023", message: expect.stringContaining("under way") });
    expect(outcome(await start(as.workshop, rework.id))).toEqual(SAVED);
    expect(outcome(await start(as.workshop, rework.id))).toMatchObject({ code: "22023" });
    expect(outcome(await cost(as.workshop, rework.id, { p_hours: 2.5, p_material: "1 off EN8 bar 30mm x 100", p_note: "Second pass" }))).toEqual(SAVED);
    expect(outcome(await cost(as.office, rework.id, { p_hours: null, p_material: "Insert", p_material_cost: 18.4 }))).toEqual(SAVED);
    expect((await job(id)).job_time_taken_hr).toBeNull(); // the job's own hours are untouched

    // A pass is refused while the rework is under way.
    expect(outcome(await inspect(as.office, id, "pass"))).toMatchObject({ code: "22023", message: expect.stringContaining("in rework") });
    expect(await job(id)).toMatchObject({ stage: "rework", inspected_at: null });

    expect(outcome(await finish(as.workshop, rework.id))).toEqual(SAVED);
    expect(await job(id)).toMatchObject({ stage: "inspection", inspected_at: null });
    expect((await reworks(id))[0]).toMatchObject({ status: "finished", finished_by: world.tenants.alpha.users.workshop.id });

    const passed = await inspect(as.office, id, "pass", "Re-bored: 25.01, 25.02 mm");
    expect(outcome(passed)).toEqual(SAVED);
    expect(passed.data).toMatchObject({ result: "pass", release_decision: "released" });
    // 081: the workshop finished the rework, so another inspector passes it (the finisher can't record its own pass).
    expect(await job(id)).toMatchObject({ stage: "complete", inspected_by: "Office alpha" });
    expect(await inspections(id)).toEqual(["fail", "pass"]);
    expect((await reworks(id))[0]).toMatchObject({ status: "closed", closed_how: "passed", closed_by: world.tenants.alpha.users.office.id });
    // Released: it can't be failed into rework again without being inspected (a fail on a released job is allowed, as before).
    expect(outcome(await inspect(as.office, id, "pass"))).toMatchObject({ code: "22023", message: expect.stringContaining("already been released") });
  });

  it("hours and material are kept separately and summed for costing; the material cost is for office and admin only", async () => {
    const id = await finishedJob(6);
    const { rework_id } = (await fail(as.workshop, id)).data;
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await cost(as.workshop, rework_id, { p_hours: 2 }))).toEqual(SAVED);
    expect(outcome(await cost(as.workshop, rework_id, { p_hours: 1.25, p_material: "Spare bush", p_material_cost: 9 }))).toMatchObject({ code: "42501" });
    expect(outcome(await cost(as.workshop, rework_id, { p_hours: null, p_material: "Spare bush" }))).toEqual(SAVED);
    expect(outcome(await cost(as.admin, rework_id, { p_hours: 1.25, p_material: "Bar offcut", p_material_cost: 12.5 }))).toEqual(SAVED);
    expect(outcome(await cost(as.admin, rework_id, { p_hours: null, p_material: null }))).toMatchObject({ code: "22023" });
    expect(outcome(await cost(as.admin, rework_id, { p_hours: 0 }))).toMatchObject({ code: "22023" });
    expect(outcome(await cost(as.admin, rework_id, { p_hours: null, p_material: null, p_material_cost: 5 }))).toMatchObject({ code: "22023" });
    expect(outcome(await cost(as.viewer, rework_id))).toMatchObject({ code: "42501" });

    expect(await summary(as.admin, id)).toMatchObject({ cycles: 1, rework_hours: 3.25, material_items: 2, material_cost: 12.5, live_status: "in_progress" });
    expect(await summary(as.workshop, id)).toMatchObject({ rework_hours: 3.25, material_items: 2, material_cost: null });
    // The entries are readable by the whole company; the money only by office and admin.
    expect((await as.workshop.from("job_rework_entries").select("kind").eq("job_id", id)).data).toHaveLength(4);
    expect((await as.workshop.from("job_rework_entry_values").select("material_cost")).data).toEqual([]);
    expect((await as.viewer.from("job_rework_entry_values").select("material_cost")).data).toEqual([]);
    const entryIds = ((await as.office.from("job_rework_entries").select("id").eq("job_id", id)).data ?? []).map((e) => e.id);
    expect((await as.office.from("job_rework_entry_values").select("material_cost").in("entry_id", entryIds)).data).toEqual([{ material_cost: 12.5 }]);
    // The activity trail shows the hours but not the money to the workshop.
    const seen = (await as.workshop.rpc("record_activity", { p_table: "jobs", p_id: id })).data as Array<{ action: string; metadata: Record<string, unknown> }>;
    const costEvents = seen.filter((e) => e.action === "RECORD_REWORK_COST");
    expect(costEvents).toHaveLength(3);
    expect(JSON.stringify(costEvents)).not.toContain("material_cost");
    expect(JSON.stringify((await as.office.rpc("record_activity", { p_table: "jobs", p_id: id })).data)).toContain("material_cost");
    // Nobody writes the tables directly.
    for (const role of ["admin", "office", "workshop"]) {
      for (const table of ["job_rework", "job_rework_entries", "job_rework_entry_values"]) {
        const forged = await as[role].from(table).insert({ organization_id: world.tenants.alpha.id, job_id: id });
        expect({ role, table, refused: forged.error !== null }).toEqual({ role, table, refused: true });
      }
      const changed = await as[role].from("job_rework").update({ status: "closed", closed_how: "passed" }).eq("job_id", id).select("id");
      expect({ role, changed: changed.error ? 0 : (changed.data ?? []).length }).toEqual({ role, changed: 0 });
    }
  });

  it("the audit trail names FAIL_INSPECTION, START_REWORK, SCRAP and FINISH_REWORK with who and when", async () => {
    const id = await finishedJob(8);
    const { rework_id } = (await fail(as.office, id, { p_quantity: 3 })).data;
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await scrap(as.workshop, rework_id, 1))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, rework_id, 1))).toEqual(SAVED);
    const failed = await audit(id, "FAIL_INSPECTION");
    expect(failed).toHaveLength(1);
    expect(failed[0].actor_user_id).toBe(world.tenants.alpha.users.office.id);
    expect(failed[0].metadata).toMatchObject({ source: "write_audit", rework_id, quantity: 3, all_of_job: false, reason: "Bore oversize", instructions: "Re-bore and re-measure", assigned_to: "workshop" });
    expect(await audit(id, "START_REWORK")).toHaveLength(1);
    expect((await audit(id, "START_REWORK"))[0].actor_user_id).toBe(world.tenants.alpha.users.workshop.id);
    expect((await audit(id, "SCRAP"))[0].metadata).toMatchObject({ quantity: 1, reason: "Cracked on re-bore", remaining_to_make: 1 });
    expect(await audit(id, "FINISH_REWORK")).toHaveLength(1);
    // The job's history (the people who may open the job) lists them, by name.
    const history = (await as.workshop.rpc("record_activity", { p_table: "jobs", p_id: id })).data as Array<{ action: string; actor_name: string | null; created_at: string }>;
    expect(history.filter((e) => ["FAIL_INSPECTION", "START_REWORK", "SCRAP", "FINISH_REWORK"].includes(e.action)).map((e) => [e.action, e.actor_name])).toEqual(
      expect.arrayContaining([["FAIL_INSPECTION", "Office alpha"], ["START_REWORK", "Workshop alpha"], ["SCRAP", "Workshop alpha"], ["FINISH_REWORK", "Workshop alpha"]]));
    expect(JSON.stringify(history)).not.toContain("@");
  });

  it("failing all of the job, a repeat failure after rework, and the rules for what can be failed", async () => {
    const id = await finishedJob(5);
    expect(outcome(await fail(as.viewer, id))).toMatchObject({ code: "42501" });
    expect(outcome(await fail(as.admin, id, { p_reason: "  " }))).toMatchObject({ code: "22023" });
    expect(outcome(await fail(as.admin, id, { p_instructions: null }))).toMatchObject({ code: "22023" });
    expect(outcome(await fail(as.admin, id, { p_notes: "" }))).toMatchObject({ code: "22023" });
    expect(outcome(await fail(as.admin, id, { p_quantity: 0 }))).toMatchObject({ code: "22023" });
    expect(outcome(await fail(as.admin, id, { p_quantity: 6 }))).toMatchObject({ code: "22023" });
    expect(await reworks(id)).toEqual([]);
    const first = await fail(as.admin, id, { p_quantity: 5 }); // the whole quantity is "all"
    expect(outcome(first)).toEqual(SAVED);
    expect(first.data).toMatchObject({ affects_all: true, quantity_affected: 5 });
    expect(outcome(await fail(as.admin, id))).toMatchObject({ code: "22023", message: expect.stringContaining("already in rework") });
    expect(outcome(await start(as.workshop, first.data.rework_id))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, first.data.rework_id))).toEqual(SAVED);
    // Inspected again and failed again: the first rework is closed as superseded and a second one opens.
    const second = await fail(as.workshop, id, { p_reason: "Still oversize", p_instructions: "Scrap and remake the bore" });
    expect(outcome(second)).toEqual(SAVED);
    expect((await reworks(id)).map((r) => [r.status, r.closed_how])).toEqual([["closed", "superseded"], ["open", null]]);
    expect(await job(id)).toMatchObject({ stage: "rework" });
    // A job with no quantity can fail as a whole but not in part.
    const noQty = await finishedJob(null);
    expect(outcome(await fail(as.admin, noQty, { p_quantity: 2 }))).toMatchObject({ code: "22023", message: expect.stringContaining("no quantity") });
    expect(outcome(await fail(as.admin, noQty))).toEqual(SAVED);
    // An unfinished job can't be inspected at all.
    const { data: open } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-RW-OPEN-${world.runId}`, customer: "Open", stage: "machining" }).select("id").single();
    expect(outcome(await fail(as.admin, open!.id))).toMatchObject({ code: "22023", message: expect.stringContaining("not finished") });
  });

  it("a fail sent the old way (record_job_inspection) opens a rework for all of the job", async () => {
    const id = await finishedJob(7);
    const failed = await inspect(as.office, id, "fail", "Thread gauge: no-go enters");
    expect(outcome(failed)).toEqual(SAVED);
    expect(failed.data).toMatchObject({ result: "fail", release_decision: "held" });
    expect(await job(id)).toMatchObject({ stage: "rework" });
    expect((await reworks(id))[0]).toMatchObject({ status: "open", affects_all: true, quantity_affected: 7, reason: "Thread gauge: no-go enters" });
  });
});

describe("a concession is for admins only", () => {
  it("only an admin releases a failed job on a concession, with a reason; it closes the rework", async () => {
    const id = await finishedJob(10);
    const { rework_id } = (await fail(as.workshop, id)).data;
    for (const role of ["workshop", "office"]) {
      expect({ role, ...outcome(await inspect(as[role], id, "concession", "Bore 25.04", "Customer agreed")) }).toMatchObject({ role, code: "42501", message: expect.stringContaining("admin") });
    }
    expect(outcome(await inspect(as.admin, id, "concession", "Bore 25.04"))).toMatchObject({ code: "22023" });
    expect(await job(id)).toMatchObject({ stage: "rework", inspected_at: null });
    const ok = await inspect(as.admin, id, "concession", "Bore 25.04 mm, 0.04 over", "Customer agreed by e-mail 02/10");
    expect(outcome(ok)).toEqual(SAVED);
    expect(ok.data).toMatchObject({ result: "concession", release_decision: "released" });
    expect(await job(id)).toMatchObject({ stage: "complete" });
    expect((await job(id)).inspected_at).toBeTruthy();
    expect((await reworks(id))[0]).toMatchObject({ id: rework_id, status: "closed", closed_how: "concession", closed_by: world.tenants.alpha.users.admin.id });
    expect(await inspections(id)).toEqual(["fail", "concession"]);
    // The rework can't be started or scrapped once it is closed.
    expect(outcome(await start(as.workshop, rework_id))).toMatchObject({ code: "22023" });
    expect(outcome(await scrap(as.workshop, rework_id, 1))).toMatchObject({ code: "22023" });
  });

  it("nothing but the rework functions moves a job into or out of rework: Finish, edits and forged inspection columns are refused", async () => {
    const id = await finishedJob(10);
    for (const role of ["admin", "office", "workshop"]) {
      const into = await as[role].from("jobs").update({ stage: "rework" }).eq("id", id).select("id");
      expect({ role, ...outcome(into) }).toMatchObject({ role, code: "42501" });
    }
    expect(await job(id)).toMatchObject({ stage: "inspection" });
    expect((await fail(as.workshop, id)).error).toBeNull();
    for (const patch of [{ stage: "inspection" }, { stage: "machining" }, { finished_at: new Date().toISOString(), stage: "inspection" }, { stage: "complete", inspected_at: new Date().toISOString() }]) {
      for (const role of ["admin", "office", "workshop"]) {
        const out = await as[role].from("jobs").update(patch).eq("id", id).select("id");
        expect({ role, patch, code: out.error?.code ?? null }).toMatchObject({ role, patch, code: "42501" });
      }
    }
    expect(await job(id)).toMatchObject({ stage: "rework", inspected_at: null });
    // A job can't be created already in rework; the worksheet and other columns still save as before.
    const born = await as.admin.from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-RW-NEW-${world.runId}`, customer: "X", stage: "rework" });
    expect(outcome(born)).toMatchObject({ code: "42501" });
    expect(outcome(await as.workshop.from("jobs").update({ improvement_comments: "Use the finishing tool" }).eq("id", id))).toEqual(SAVED);
    expect(await job(id)).toMatchObject({ stage: "rework" });
  });
});

describe("scrap and the remaining quantity", () => {
  it("a part scrap lowers what is left to rework and raises what remains to make; finishing remakes it", async () => {
    const id = await finishedJob(10);
    const { rework_id } = (await fail(as.admin, id, { p_quantity: 4 })).data;
    expect(await summary(as.workshop, id)).toMatchObject({ quantity_required: 10, quantity_in_rework: 4, quantity_scrapped: 0, remaining_to_make: 0, live_status: "open" });

    expect(outcome(await scrap(as.workshop, rework_id, 0))).toMatchObject({ code: "22023" });
    expect(outcome(await scrap(as.workshop, rework_id, 1, "  "))).toMatchObject({ code: "22023" });
    expect(outcome(await scrap(as.workshop, rework_id, 5))).toMatchObject({ code: "22023", message: expect.stringContaining("left to scrap") });
    expect(outcome(await scrap(as.viewer, rework_id, 1))).toMatchObject({ code: "42501" });

    const scrapped = await scrap(as.workshop, rework_id, 1);
    expect(outcome(scrapped)).toEqual(SAVED);
    expect(scrapped.data).toMatchObject({ quantity_scrapped: 1, quantity_to_rework: 3, remaining_to_make: 1 });
    expect(await summary(as.workshop, id)).toMatchObject({ quantity_in_rework: 3, quantity_scrapped: 1, remaining_to_make: 1 });
    expect(outcome(await scrap(as.office, rework_id, 2, "Out of tolerance and can't be saved"))).toEqual(SAVED);
    expect(await summary(as.admin, id)).toMatchObject({ quantity_in_rework: 1, quantity_scrapped: 3, remaining_to_make: 3 });
    expect(outcome(await scrap(as.workshop, rework_id, 2))).toMatchObject({ code: "22023" }); // only 1 of the 4 is left
    const entries = (await as.workshop.from("job_rework_entries").select("kind, quantity, description").eq("rework_id", rework_id).eq("kind", "scrap").order("created_at")).data;
    expect(entries).toEqual([{ kind: "scrap", quantity: 1, description: "Cracked on re-bore" }, { kind: "scrap", quantity: 2, description: "Out of tolerance and can't be saved" }]);

    // The replacements are made as part of the rework; finishing it records how many (all three here; a partial remake is below).
    expect(outcome(await finish(as.workshop, rework_id))).toMatchObject({ code: "22023" }); // not started yet
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, rework_id, 3))).toEqual(SAVED);
    expect(await summary(as.admin, id)).toMatchObject({ quantity_in_rework: 0, quantity_scrapped: 3, remaining_to_make: 0, live_status: "finished" });
    expect((await reworks(id))[0]).toMatchObject({ quantity_scrapped: 3, quantity_remade: 3 });
    // The job's own quantity is not rewritten, and the sign-off is still needed.
    expect(await job(id)).toMatchObject({ quantity_required: 10, stage: "inspection", inspected_at: null });
  });
});

describe("despatch holds only the batch in rework (Rhys: the rest of the job can go, since 081 on an admin's early release)", () => {
  type Line = { line_id: string; ordered: number; despatched: number; remaining: number; held: number; available: number };
  /** A job made from a sales order whose one line is the job's quantity (from an accepted quote of 10 at £10), finished. */
  async function orderJob(quantity = 10) {
    const service = adminClient();
    const org = world.tenants.alpha.id;
    const n = ++counter;
    const { data: quote, error: quoteError } = await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-RW-${world.runId}-${n}`, customer: "Rework Co", status: "draft", total_value: 0 }).select("id").single();
    expect(quoteError).toBeNull();
    expect((await service.from("quote_line_items").insert({ organization_id: org, quote_id: quote!.id, position: 0, description: "Bush 25mm", quantity, unit_price: 10, vat_pct: 0, vat_exempt: false })).error).toBeNull();
    expect((await service.from("quotes").update({ total_value: quantity * 10 }).eq("id", quote!.id)).error).toBeNull();
    expect((await service.from("quotes").update({ status: "accepted" }).eq("id", quote!.id)).error).toBeNull();
    const { data: order, error } = await service.from("sales_orders").insert({ organization_id: org, so_number: `PO-RW-${world.runId}-${n}`, customer_po: `PO-RW-${world.runId}-${n}`, customer: "Rework Co", quote_id: quote!.id, total_value: quantity * 10, status: "open" }).select("id").single();
    expect(error).toBeNull();
    const converted = await as.admin.rpc("convert_sales_order", { p_order: order!.id });
    expect(outcome(converted)).toEqual(SAVED);
    const jobId = converted.data.job_id as string;
    expect((await service.from("jobs").update({ started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", quantity_required: quantity }).eq("id", jobId)).error).toBeNull();
    // despatch_lines (034): ordered, on notes, left; despatch_release (037): held and available, per line.
    const lines = async () => {
      const base = (await as.workshop.rpc("despatch_lines", { p_order: null, p_job: jobId })).data as Line[];
      const release = (await as.workshop.rpc("despatch_release", { p_order: null, p_job: jobId })).data as Array<{ line_id: string; held: number; available: number }>;
      return base.map((l) => {
        const r = release.find((x) => x.line_id === l.line_id)!;
        return { ...l, ordered: Number(l.ordered), despatched: Number(l.despatched), remaining: Number(l.remaining), held: Number(r.held), available: Number(r.available) };
      });
    };
    const [first] = await lines();
    expect(first.ordered).toBe(quantity);
    const despatch = (qty: number, client: SupabaseClient = as.workshop) => client.rpc("create_delivery_note", { p_order: null, p_job: jobId, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: null, p_notes: null, p_lines: [{ line_id: first.line_id, quantity: qty }] });
    const sendOut = (note: string, client: SupabaseClient = as.office) => client.from("delivery_notes").update({ status: "despatched" }).eq("id", note).select("id");
    return { jobId, order: order!.id as string, lineId: first.line_id, lines, despatch, sendOut };
  }
  const goneOut = async (jobId: string) => Number((await withDb((db) => db.query("select coalesce(sum(i.quantity), 0) as q from public.delivery_note_items i join public.delivery_notes d on d.id = i.delivery_note_id where d.job_id = $1 and d.status in ('despatched', 'delivered', 'signed')", [jobId]))).rows[0].q);

  it("part-fail: the good quantity is despatched, the held quantity is refused; a pass on the held quantity lets the rest go", async () => {
    const o = await orderJob(10);
    // Nothing goes out before the first inspection.
    expect(outcome(await o.despatch(1))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
    const failed = await fail(as.workshop, o.jobId, { p_quantity: 4 });
    expect(outcome(failed)).toEqual(SAVED);
    expect(failed.data).toMatchObject({ quantity_affected: 4, quantity_available: 0 });
    expect(await job(o.jobId)).toMatchObject({ stage: "rework", inspected_at: null });
    // 081: put back to In progress, so nothing goes (all of it is held) until an admin releases the good part early.
    expect((await o.lines())[0]).toMatchObject({ remaining: 10, held: 10, available: 0 });
    expect(await summary(as.workshop, o.jobId)).toMatchObject({ released: false, quantity_held: 4, quantity_available: 0 });
    expect(outcome(await o.despatch(6))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
    await releaseEarly(o.jobId);
    expect((await o.lines())[0]).toMatchObject({ remaining: 10, held: 4, available: 6 });
    expect(await summary(as.workshop, o.jobId)).toMatchObject({ released: true, quantity_held: 4, quantity_available: 6 });

    // The six that passed go out; the failed four are refused, alone or on top, with the database's reason.
    const good = await o.despatch(6);
    expect(outcome(good)).toEqual(SAVED);
    expect(outcome(await o.despatch(1))).toMatchObject({ code: "22023", message: expect.stringContaining("held in rework") });
    expect(outcome(await o.despatch(0.5))).toMatchObject({ code: "22023", message: expect.stringContaining("held in rework") });
    expect((await o.sendOut(good.data.id)).data).toHaveLength(1);
    expect(await goneOut(o.jobId)).toBe(6);
    expect((await o.lines())[0]).toMatchObject({ despatched: 6, remaining: 4, held: 4, available: 0 });

    // Reworked and re-inspected: the pass releases the held four, and the rest goes.
    const { rework_id } = failed.data;
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await o.despatch(1))).toMatchObject({ code: "22023" });
    expect(outcome(await finish(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await o.despatch(1))).toMatchObject({ code: "22023", message: expect.stringContaining("held in rework") }); // finished is not passed
    const passed = await inspect(as.office, o.jobId, "pass", "Re-bored 4 off: in tolerance");
    expect(outcome(passed)).toEqual(SAVED);
    expect(passed.data).toMatchObject({ quantity_released: 10, replacements_held: 0 });
    expect((await o.lines())[0]).toMatchObject({ remaining: 4, held: 0, available: 4 });
    const rest = await o.despatch(4);
    expect(outcome(rest)).toEqual(SAVED);
    expect((await o.sendOut(rest.data.id)).data).toHaveLength(1);
    expect(await goneOut(o.jobId)).toBe(10);
    expect(outcome(await o.despatch(1))).toMatchObject({ code: "22023", message: expect.stringContaining("More than is left") });
  });

  it("a whole failure holds the whole job; a note made before a failure can't then be sent out with the failed quantity", async () => {
    const o = await orderJob(10);
    expect(outcome(await inspect(as.office, o.jobId, "pass", "All in tolerance"))).toEqual(SAVED);
    const early = await o.despatch(10);
    expect(outcome(early)).toEqual(SAVED);
    // Failed (part) before the note went out: the note is refused at the door, and so is a note for more than the six.
    const { rework_id } = (await fail(as.workshop, o.jobId, { p_quantity: 4 })).data;
    expect(outcome(await o.sendOut(early.data.id))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
    expect((await adminClient().from("delivery_notes").select("status").eq("id", early.data.id).single()).data!.status).toBe("awaiting");
    expect(await goneOut(o.jobId)).toBe(0);
    // Remade as six: delete the early note, an admin releases the good six early (081), and they are despatched.
    expect((await as.office.from("delivery_notes").delete().eq("id", early.data.id).select("id")).data).toHaveLength(1);
    await releaseEarly(o.jobId);
    const six = await o.despatch(6);
    expect(outcome(six)).toEqual(SAVED);
    expect((await o.sendOut(six.data.id)).data).toHaveLength(1);
    // A whole failure on what is left holds everything: nothing more goes out, not even a part.
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await fail(as.workshop, o.jobId))).toEqual(SAVED);
    expect((await o.lines())[0]).toMatchObject({ held: 4, available: 0 });
    expect(outcome(await o.despatch(1))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
  });

  it("scrap then concede: the concession releases only what is there; replacements never made stay held", async () => {
    const o = await orderJob(10);
    const { rework_id } = (await fail(as.workshop, o.jobId, { p_quantity: 4 })).data;
    expect(outcome(await scrap(as.workshop, rework_id, 2))).toEqual(SAVED);
    // An admin concedes the failure while the rework is still open: the two reworkable parts are accepted as they are, the two
    // scrapped ones don't exist and are not released.
    const conceded = await inspect(as.admin, o.jobId, "concession", "2 off at 25.04 accepted", "Customer accepted 25.04 by e-mail");
    expect(outcome(conceded)).toEqual(SAVED);
    expect(conceded.data).toMatchObject({ result: "concession", quantity_released: 8, replacements_held: 2 });
    expect((await reworks(o.jobId))[0]).toMatchObject({ status: "closed", closed_how: "concession", quantity_scrapped: 2, quantity_remade: 0 });
    expect(await summary(as.office, o.jobId)).toMatchObject({ released: true, quantity_available: 8, remaining_to_make: 2 });
    expect((await o.lines())[0]).toMatchObject({ held: 2, available: 8 });
    expect(outcome(await o.despatch(9))).toMatchObject({ code: "22023", message: expect.stringContaining("held in rework or waiting for replacements") });
    const eight = await o.despatch(8);
    expect(outcome(eight)).toEqual(SAVED);
    expect((await o.sendOut(eight.data.id)).data).toHaveLength(1);
    expect(outcome(await o.despatch(1))).toMatchObject({ code: "22023", message: expect.stringContaining("waiting for replacements") });
    expect(await goneOut(o.jobId)).toBe(8);
    const event = (await audit(o.jobId, "INSPECT_JOB")).at(-1)!;
    expect(event.metadata).toMatchObject({ result: "concession", after_rework: true, quantity_released: 8, replacements_held: 2 });
  });

  it("a change to the job after a part failure withdraws the release of the rest too (034's rule), until it is inspected again", async () => {
    const o = await orderJob(10);
    const { rework_id } = (await fail(as.workshop, o.jobId, { p_quantity: 4 })).data;
    expect((await o.lines())[0]).toMatchObject({ available: 0 });
    await releaseEarly(o.jobId);
    expect((await o.lines())[0]).toMatchObject({ available: 6 });
    // The quantity on the worksheet changes (it raises the worksheet version): what was inspected is no longer the job.
    expect(outcome(await as.office.from("jobs").update({ quantity_required: 12 }).eq("id", o.jobId))).toEqual(SAVED);
    expect((await o.lines())[0]).toMatchObject({ available: 0 });
    expect(outcome(await o.despatch(1))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await inspect(as.office, o.jobId, "pass", "All 12 re-checked"))).toEqual(SAVED);
    expect((await o.lines())[0]).toMatchObject({ available: 10 });
  });

  it("a failure and a despatch at the same moment never send failed parts out (the job row is locked by both)", async () => {
    const claims = (role: "workshop" | "office") => JSON.stringify({ sub: world.tenants.alpha.users[role].id, role: "authenticated", aal: "aal1" });
    const asRole = async (db: Client, role: "workshop" | "office") => {
      await db.query("begin");
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [claims(role)]);
    };
    const waitingOnLock = (pid: number) => withDb(async (db) => {
      for (let i = 0; i < 100; i++) {
        const { rows } = await db.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
        if (rows[0]?.wait_event_type === "Lock") return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    });
    const failSql = "select public.fail_job_inspection($1, 'Bore 25.08', 'Bore oversize', 4, 'Re-bore', null, null)";
    const despatchSql = (o: { jobId: string; lineId: string }, qty: number) => [
      "select public.create_delivery_note(null, $1, current_date, current_date, null, null, $2::jsonb) as r", [o.jobId, JSON.stringify([{ line_id: o.lineId, quantity: qty }])]] as const;

    // 1. The failure holds the lock first; the despatch of all ten waits for it, then sees the failure and is refused.
    const a = await orderJob(10);
    expect(outcome(await inspect(as.office, a.jobId, "pass", "All in tolerance"))).toEqual(SAVED);
    await withDb(async (first) => withDb(async (second) => {
      await asRole(first, "workshop");
      await first.query(failSql, [a.jobId]);
      await asRole(second, "office");
      const pid = (await second.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const [text, values] = despatchSql(a, 10);
      const pending = second.query(text, [...values]).then(() => null, (err: { code?: string; message?: string }) => ({ code: err.code, message: err.message }));
      expect(await waitingOnLock(pid)).toBe(true);
      await first.query("commit");
      // 081: the failure put the job back to In progress, so nothing of it is released.
      expect(await pending).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
      await second.query("rollback");
    }));
    expect((await adminClient().from("delivery_notes").select("id").eq("job_id", a.jobId)).data).toEqual([]);
    expect((await a.lines())[0]).toMatchObject({ held: 10, available: 0 });

    // 2. The despatch holds the lock first; the failure waits, then lands. The note made just before can't be sent out with the
    //    failed parts, and no new note for them can be made.
    const b = await orderJob(10);
    expect(outcome(await inspect(as.office, b.jobId, "pass", "All in tolerance"))).toEqual(SAVED);
    let noteId = "";
    await withDb(async (first) => withDb(async (second) => {
      await asRole(first, "office");
      const [text, values] = despatchSql(b, 10);
      noteId = (await first.query(text, [...values])).rows[0].r.id;
      await asRole(second, "workshop");
      const pid = (await second.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const pending = second.query(failSql, [b.jobId]).then(() => null, (err: { code?: string }) => ({ code: err.code }));
      expect(await waitingOnLock(pid)).toBe(true);
      await first.query("commit");
      expect(await pending).toBeNull();
      await second.query("commit");
    }));
    expect(outcome(await b.sendOut(noteId))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
    expect(outcome(await b.despatch(1))).toMatchObject({ code: "22023" }); // not released (081), and ten already on a note: nothing more
    expect(await goneOut(b.jobId)).toBe(0);
  });
});

/** What has gone out (on notes sent, delivered or signed) for a job. */
const goneOutOf = async (jobId: string) => Number((await withDb((db) => db.query("select coalesce(sum(i.quantity), 0) as q from public.delivery_note_items i join public.delivery_notes d on d.id = i.delivery_note_id where d.job_id = $1 and d.status in ('despatched', 'delivered', 'signed')", [jobId]))).rows[0].q);

/** A job made from a sales order with one order line per quantity given ("Part A", "Part B", ...), finished. A job made from an order of
 *  more than one line has no quantity of its own (convert_sales_order leaves it empty): what is held is weighed per order line. */
async function multiOrderJob(quantities: number[]) {
  const service = adminClient();
  const org = world.tenants.alpha.id;
  const n = ++counter;
  const total = quantities.reduce((sum, q) => sum + q * 10, 0);
  const { data: quote, error: quoteError } = await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-RWM-${world.runId}-${n}`, customer: "Rework Co", status: "draft", total_value: 0 }).select("id").single();
  expect(quoteError).toBeNull();
  const names = quantities.map((_, i) => `Part ${String.fromCharCode(65 + i)}`);
  expect((await service.from("quote_line_items").insert(quantities.map((quantity, i) => ({ organization_id: org, quote_id: quote!.id, position: i, description: names[i], quantity, unit_price: 10, vat_pct: 0, vat_exempt: false })))).error).toBeNull();
  expect((await service.from("quotes").update({ total_value: total }).eq("id", quote!.id)).error).toBeNull();
  expect((await service.from("quotes").update({ status: "accepted" }).eq("id", quote!.id)).error).toBeNull();
  const { data: order, error } = await service.from("sales_orders").insert({ organization_id: org, so_number: `PO-RWM-${world.runId}-${n}`, customer_po: `PO-RWM-${world.runId}-${n}`, customer: "Rework Co", quote_id: quote!.id, total_value: total, status: "open" }).select("id").single();
  expect(error).toBeNull();
  const converted = await as.admin.rpc("convert_sales_order", { p_order: order!.id });
  expect(outcome(converted)).toEqual(SAVED);
  const jobId = converted.data.job_id as string;
  expect((await service.from("jobs").update({ started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z" }).eq("id", jobId)).error).toBeNull();
  const lines = async () => {
    const base = (await as.workshop.rpc("despatch_lines", { p_order: null, p_job: jobId })).data as Array<{ line_id: string; description: string; ordered: number; despatched: number; remaining: number }>;
    const release = (await as.workshop.rpc("despatch_release", { p_order: null, p_job: jobId })).data as Array<{ line_id: string; held: number; available: number; reason: string | null }>;
    return Object.fromEntries(base.map((l) => {
      const r = release.find((x) => x.line_id === l.line_id)!;
      return [l.description, { line_id: l.line_id, ordered: Number(l.ordered), despatched: Number(l.despatched), remaining: Number(l.remaining), held: Number(r.held), available: Number(r.available), reason: r.reason }];
    })) as Record<string, { line_id: string; ordered: number; despatched: number; remaining: number; held: number; available: number; reason: string | null }>;
  };
  const first = await lines();
  expect(Object.keys(first)).toEqual(names);
  const id = (name: string) => first[name].line_id;
  const despatch = (picks: Record<string, number>, client: SupabaseClient = as.workshop) => client.rpc("create_delivery_note", {
    p_order: null, p_job: jobId, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: null, p_notes: null,
    p_lines: Object.entries(picks).map(([name, quantity]) => ({ line_id: id(name), quantity })),
  });
  const sendOut = (note: string, client: SupabaseClient = as.office) => client.from("delivery_notes").update({ status: "despatched" }).eq("id", note).select("id");
  return { jobId, order: order!.id as string, id, lines, despatch, sendOut };
}

describe("a failure holds only the order line (and batch) that failed (ChatGPT audit must-fix 2)", () => {
  it("10 of A and 10 of B, all of A fails: A is held whole, all of B goes", async () => {
    const o = await multiOrderJob([10, 10]);
    expect((await job(o.jobId)).quantity_required).toBeNull();
    const failed = await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: null }], p_batch: "Heat 4471" });
    expect(outcome(failed)).toEqual(SAVED);
    expect(failed.data).toMatchObject({ affects_all: false, quantity_affected: 10, quantity_available: 0, lines: [{ line_id: o.id("Part A"), quantity: 10, batch: "Heat 4471" }] });
    expect((await reworks(o.jobId)).map((r) => [r.sales_order_line_id, r.quantity_affected, r.batch_ref])).toEqual([[o.id("Part A"), 10, "Heat 4471"]]);
    expect(outcome(await o.despatch({ "Part B": 10 }))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
    await releaseEarly(o.jobId);
    const now = await o.lines();
    expect(now["Part A"]).toMatchObject({ held: 10, available: 0, reason: "10 in rework (batch Heat 4471)" });
    expect(now["Part B"]).toMatchObject({ held: 0, available: 10, reason: null });
    // Not five of each (the old proportional share): A goes nowhere, B goes whole.
    expect(outcome(await o.despatch({ "Part A": 1 }))).toMatchObject({ code: "22023", message: expect.stringContaining("Only 0 of \"Part A\"") });
    const b = await o.despatch({ "Part B": 10 });
    expect(outcome(b)).toEqual(SAVED);
    expect((await o.sendOut(b.data.id)).data).toHaveLength(1);
    expect(await summary(as.workshop, o.jobId)).toMatchObject({ released: true, quantity_available: 10, blocked: null,
      lines: [expect.objectContaining({ description: "Part A", held: 10, available: 0, batches: "Heat 4471" }), expect.objectContaining({ description: "Part B", held: 0, available: 10 })] });
    const event = (await audit(o.jobId, "FAIL_INSPECTION"))[0];
    expect(event.metadata).toMatchObject({ all_of_job: false, batch: "Heat 4471", lines: [{ line_id: o.id("Part A"), line: "Part A", quantity: 10, batch: "Heat 4471" }] });
  });

  it("part of one line fails: only that many of that line are held", async () => {
    const o = await multiOrderJob([10, 10]);
    expect(outcome(await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: 4 }] }))).toEqual(SAVED);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 10, available: 0 }, "Part B": { held: 10, available: 0 } });
    await releaseEarly(o.jobId);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 4, available: 6 }, "Part B": { held: 0, available: 10 } });
    expect(outcome(await o.despatch({ "Part A": 7, "Part B": 10 }))).toMatchObject({ code: "22023", message: expect.stringContaining("Only 6 of \"Part A\"") });
    const note = await o.despatch({ "Part A": 6, "Part B": 10 });
    expect(outcome(note)).toEqual(SAVED);
    expect((await o.sendOut(note.data.id)).data).toHaveLength(1);
    expect(outcome(await o.despatch({ "Part A": 1 }))).toMatchObject({ code: "22023", message: expect.stringContaining("held in rework") });
  });

  it("both lines fail, each part and in its own batch: each line holds its own; the job needs both reworks done and a pass", async () => {
    const o = await multiOrderJob([10, 10]);
    const failed = await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: 3, batch: "B-12" }, { line_id: o.id("Part B"), quantity: 2, batch: "B-14" }] });
    expect(outcome(failed)).toEqual(SAVED);
    expect(failed.data.rework_ids).toHaveLength(2);
    await releaseEarly(o.jobId);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 3, available: 7, reason: "3 in rework (batch B-12)" }, "Part B": { held: 2, available: 8, reason: "2 in rework (batch B-14)" } });
    expect(outcome(await o.despatch({ "Part A": 8 }))).toMatchObject({ code: "22023", message: expect.stringContaining("(batch B-12)") });
    expect(outcome(await o.despatch({ "Part B": 9 }))).toMatchObject({ code: "22023" });
    const good = await o.despatch({ "Part A": 7, "Part B": 8 });
    expect(outcome(good)).toEqual(SAVED);
    expect((await o.sendOut(good.data.id)).data).toHaveLength(1);
    // One rework per line; finishing one leaves the job in rework until the other is done; a pass waits for both.
    const [ra, rb] = failed.data.rework_ids as string[];
    for (const r of [ra, rb]) expect(outcome(await start(as.workshop, r))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, ra))).toEqual(SAVED);
    expect(await job(o.jobId)).toMatchObject({ stage: "rework" });
    expect(outcome(await inspect(as.office, o.jobId, "pass"))).toMatchObject({ code: "22023", message: expect.stringContaining("in rework") });
    expect(outcome(await finish(as.workshop, rb))).toEqual(SAVED);
    expect(await job(o.jobId)).toMatchObject({ stage: "inspection" });
    expect(outcome(await inspect(as.office, o.jobId, "pass", "Both batches re-checked"))).toEqual(SAVED);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 0, available: 3 }, "Part B": { held: 0, available: 2 } });
    expect((await reworks(o.jobId)).map((r) => r.closed_how)).toEqual(["passed", "passed"]);
  });

  it("all of a two-line job fails (no line named): a rework per line, nothing goes until it passes", async () => {
    const o = await multiOrderJob([10, 5]);
    const failed = await fail(as.workshop, o.jobId);
    expect(outcome(failed)).toEqual(SAVED);
    expect(failed.data).toMatchObject({ affects_all: true, quantity_affected: 15 });
    expect((await reworks(o.jobId)).map((r) => [r.sales_order_line_id, r.quantity_affected, r.affects_all]).sort()).toEqual([[o.id("Part A"), 10, true], [o.id("Part B"), 5, true]].sort());
    expect(await o.lines()).toMatchObject({ "Part A": { available: 0 }, "Part B": { available: 0 } });
    expect(outcome(await o.despatch({ "Part B": 1 }))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
  });

  it("a part quantity can't be given for a job of two lines, or for a line whose quantity isn't the job's: the line has to be named", async () => {
    const o = await multiOrderJob([10, 10]);
    expect(outcome(await fail(as.workshop, o.jobId, { p_quantity: 4 }))).toMatchObject({ code: "22023", message: expect.stringContaining("choose the order line that failed") });
    expect(outcome(await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: 11 }] }))).toMatchObject({ code: "22023", message: expect.stringContaining("More failed (11)") });
    expect(outcome(await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: 1 }, { line_id: o.id("Part A"), quantity: 1 }] }))).toMatchObject({ code: "22023", message: expect.stringContaining("twice") });
    expect(outcome(await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: 2.5 }] }))).toMatchObject({ code: "22023", message: expect.stringContaining("whole number") });
    const single = await multiOrderJob([10]);
    expect((await adminClient().from("jobs").update({ quantity_required: 12 }).eq("id", single.jobId)).error).toBeNull();
    expect(outcome(await fail(as.workshop, single.jobId, { p_quantity: 4 }))).toMatchObject({ code: "22023", message: expect.stringContaining("12 on its worksheet but 10 on its sales order line") });
    expect(outcome(await fail(as.workshop, single.jobId, { p_lines: [{ line_id: single.id("Part A"), quantity: 4 }] }))).toEqual(SAVED);
    // A job not made from an order has no lines to name.
    const plain = await finishedJob(10);
    expect(outcome(await fail(as.workshop, plain, { p_lines: [{ line_id: single.id("Part A"), quantity: 1 }] }))).toMatchObject({ code: "22023", message: expect.stringContaining("wasn't made from a sales order") });
    expect(await reworks(o.jobId)).toEqual([]);
  });

  it("a note made before a failure of one line can't go out with that line; the other line's note can", async () => {
    const o = await multiOrderJob([10, 10]);
    expect(outcome(await inspect(as.office, o.jobId, "pass", "All in tolerance"))).toEqual(SAVED);
    const both = await o.despatch({ "Part A": 10, "Part B": 10 });
    expect(outcome(both)).toEqual(SAVED);
    expect(outcome(await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: null }] }))).toEqual(SAVED);
    expect(outcome(await o.sendOut(both.data.id))).toMatchObject({ code: "22023", message: expect.stringContaining("hasn't passed inspection") });
    await releaseEarly(o.jobId);
    const refused = await o.sendOut(both.data.id);
    expect(outcome(refused)).toMatchObject({ code: "22023", message: expect.stringContaining("with this much of: Part A") });
    expect((await as.office.from("delivery_notes").delete().eq("id", both.data.id).select("id")).data).toHaveLength(1);
    const b = await o.despatch({ "Part B": 10 });
    expect(outcome(b)).toEqual(SAVED);
    expect((await o.sendOut(b.data.id)).data).toHaveLength(1);
  });
});

describe("fail closed when what is held can't be weighed (ChatGPT audit must-fix 1)", () => {
  const handNote = async (jobRef: string) => (await as.office.rpc("create_with_lines", {
    p_parent: "delivery_notes", p_header: { dn_number: `DLN-RWFC-${world.runId}-${++counter}`, customer: "Rework Co", job_ref: jobRef, delivery_date: TODAY, ship_date: TODAY, tax_date: TODAY, status: "awaiting" },
    p_child: "delivery_note_items", p_fk: "delivery_note_id", p_lines: [{ position: 0, description: "Hand item", quantity: 1 }],
  })).data as string;
  const jobNo = async (id: string) => (await adminClient().from("jobs").select("job_no").eq("id", id).single()).data!.job_no as string;

  it("a two-line job (no job quantity) failed, scrapped and conceded: the scrapped line's replacements stay held on create and on send", async () => {
    const o = await multiOrderJob([10, 10]);
    // A note for all of it, made while it was passed.
    expect(outcome(await inspect(as.office, o.jobId, "pass", "All in tolerance"))).toEqual(SAVED);
    const early = await o.despatch({ "Part A": 10, "Part B": 10 });
    expect(outcome(early)).toEqual(SAVED);
    // Failed (all of it), 2 of A scrapped, then conceded with the replacements never made.
    const failed = await fail(as.workshop, o.jobId);
    expect(outcome(failed)).toEqual(SAVED);
    const ra = (await reworks(o.jobId)).find((r) => r.sales_order_line_id === o.id("Part A"))!;
    expect(outcome(await scrap(as.workshop, ra.id, 2))).toEqual(SAVED);
    const conceded = await inspect(as.admin, o.jobId, "concession", "Accepted as they are", "Customer accepted by e-mail");
    expect(outcome(conceded)).toEqual(SAVED);
    expect(conceded.data).toMatchObject({ quantity_released: 18, replacements_held: 2 });
    expect(await summary(as.office, o.jobId)).toMatchObject({ lines: [expect.objectContaining({ description: "Part A", held: 0, missing: 2, available: 8 }), expect.objectContaining({ description: "Part B", available: 10 })] });
    // Sending: the early note carries 10 of A, two of which don't exist.
    expect(outcome(await o.sendOut(early.data.id))).toMatchObject({ code: "22023", message: expect.stringContaining("with this much of: Part A") });
    expect(await goneOutOf(o.jobId)).toBe(0);
    expect((await as.office.from("delivery_notes").delete().eq("id", early.data.id).select("id")).data).toHaveLength(1);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 2, available: 8, reason: "2 replacements still to make" }, "Part B": { held: 0, available: 10 } });
    // Creating: more than 8 of A is refused, saying why; 8 of A and all of B go.
    expect(outcome(await o.despatch({ "Part A": 9 }))).toMatchObject({ code: "22023", message: expect.stringContaining("waiting for replacements") });
    const rest = await o.despatch({ "Part A": 8, "Part B": 10 });
    expect(outcome(rest)).toEqual(SAVED);
    expect((await o.sendOut(rest.data.id)).data).toHaveLength(1);
    expect(await goneOutOf(o.jobId)).toBe(18);
  });

  it("a job with no quantity, failed, scrapped and conceded: nothing goes out (create or send), with what to set; making the replacements releases it", async () => {
    const id = await finishedJob(null);
    const no = await jobNo(id);
    const { rework_id } = (await fail(as.workshop, id)).data;
    expect(outcome(await scrap(as.workshop, rework_id, 2))).toEqual(SAVED);
    expect(outcome(await inspect(as.admin, id, "concession", "Accepted", "Customer accepted"))).toEqual(SAVED);
    const state = await summary(as.office, id);
    expect(state).toMatchObject({ released: true, quantity_available: 0, remaining_to_make: 2 });
    expect(state.blocked).toMatch(/no quantity on its worksheet.*Enter the job's quantity on its worksheet/);
    // Sending a note for the job (made by hand, without an order) is refused with that reason.
    const note = await handNote(no);
    expect(outcome(await as.office.from("delivery_notes").update({ status: "despatched" }).eq("id", note).select("id"))).toMatchObject({ code: "22023", message: expect.stringContaining("no quantity on its worksheet") });
    // Recovery: the office opens a replacement rework for the two, the workshop makes them, the inspector passes them.
    const reopened = await as.office.rpc("open_replacement_rework", { p_rework: rework_id, p_instructions: "Make 2 off to drawing" });
    expect(outcome(reopened)).toEqual(SAVED);
    expect(outcome(await start(as.workshop, reopened.data.rework_id))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, reopened.data.rework_id, 2))).toEqual(SAVED);
    expect(outcome(await inspect(as.office, id, "pass", "2 replacements in tolerance"))).toEqual(SAVED);
    expect(await summary(as.office, id)).toMatchObject({ released: true, remaining_to_make: 0, blocked: null, quantity_available: null });
    expect((await as.office.from("delivery_notes").update({ status: "despatched" }).eq("id", note).select("id")).data).toHaveLength(1);
  });

  it("a hold no longer tied to an order line (the order's lines were rebuilt) holds the whole job, on create and on send", async () => {
    const o = await multiOrderJob([10, 10]);
    expect(outcome(await inspect(as.office, o.jobId, "pass", "All in tolerance"))).toEqual(SAVED);
    const early = await o.despatch({ "Part B": 10 });
    expect(outcome(early)).toEqual(SAVED);
    const { rework_id } = (await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: 4 }] })).data;
    // What ON DELETE SET NULL leaves when ensure_sales_order_lines rebuilds an order's lines.
    await withDb((db) => db.query("update public.job_rework set sales_order_line_id = null where id = $1", [rework_id]));
    await releaseEarly(o.jobId);
    expect(await o.lines()).toMatchObject({ "Part A": { available: 0 }, "Part B": { available: 0 } });
    expect(outcome(await o.despatch({ "Part B": 1 }))).toMatchObject({ code: "22023", message: expect.stringContaining("not against a line of its sales order") });
    expect(outcome(await o.sendOut(early.data.id))).toMatchObject({ code: "22023", message: expect.stringContaining("not against a line of its sales order") });
  });
});

describe("the replacements still owed after a pass or a concession are made through a replacement rework (ChatGPT audit must-fix 3)", () => {
  it("partial remake, pass: the office reopens for the two outstanding; they are made, inspected and only then released; the rest goes meanwhile", async () => {
    const o = await multiOrderJob([10, 6]);
    const { rework_id } = (await fail(as.workshop, o.jobId, { p_lines: [{ line_id: o.id("Part A"), quantity: 4, batch: "B-7" }] })).data;
    expect(outcome(await scrap(as.workshop, rework_id, 3))).toEqual(SAVED);
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, rework_id, 1))).toEqual(SAVED);
    expect(outcome(await inspect(as.office, o.jobId, "pass", "1 reworked, 1 remade: in tolerance"))).toEqual(SAVED);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 2, available: 8 }, "Part B": { available: 6 } });
    // Closed: finishing can't record them any more.
    expect(outcome(await finish(as.workshop, rework_id, 2))).toMatchObject({ code: "22023" });

    // Who may reopen, and what.
    expect(outcome(await as.workshop.rpc("open_replacement_rework", { p_rework: rework_id, p_instructions: "Make 2" }))).toMatchObject({ code: "42501" });
    expect(outcome(await as.viewer.rpc("open_replacement_rework", { p_rework: rework_id, p_instructions: "Make 2" }))).toMatchObject({ code: "42501" });
    expect(outcome(await as.office.rpc("open_replacement_rework", { p_rework: rework_id, p_instructions: "  " }))).toMatchObject({ code: "22023" });
    expect(outcome(await as.betaAdmin.rpc("open_replacement_rework", { p_rework: rework_id, p_instructions: "Make 2" }))).toMatchObject({ code: "P0002" });
    const reopened = await as.office.rpc("open_replacement_rework", { p_rework: rework_id, p_instructions: "Make 2 off Part A to rev C" });
    expect(outcome(reopened)).toEqual(SAVED);
    expect(reopened.data).toMatchObject({ follow_up_of: rework_id, quantity: 2, sales_order_line_id: o.id("Part A"), batch_ref: "B-7" });
    expect(outcome(await as.office.rpc("open_replacement_rework", { p_rework: rework_id, p_instructions: "Again" }))).toMatchObject({ code: "22023", message: expect.stringContaining("No replacements are outstanding") });
    const follow = (await reworks(o.jobId)).find((r) => r.id === reopened.data.rework_id)!;
    expect(follow).toMatchObject({ status: "open", follow_up_of: rework_id, quantity_affected: 2, quantity_scrapped: 2, quantity_remade: 0, sales_order_line_id: o.id("Part A"), affects_all: false });
    expect((await reworks(o.jobId)).find((r) => r.id === rework_id)).toMatchObject({ status: "closed", quantity_carried: 2 });
    expect(await job(o.jobId)).toMatchObject({ stage: "rework", inspected_at: null });
    expect(await summary(as.workshop, o.jobId)).toMatchObject({ remaining_to_make: 2, quantity_scrapped: 3 });
    // Still only those two held: the rest of the job goes, once an admin releases it early (081: the job is put back to In progress).
    expect(await o.lines()).toMatchObject({ "Part A": { held: 10, available: 0 }, "Part B": { held: 6, available: 0 } });
    await releaseEarly(o.jobId);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 2, available: 8 }, "Part B": { available: 6 } });
    const rest = await o.despatch({ "Part A": 8, "Part B": 6 });
    expect(outcome(rest)).toEqual(SAVED);
    expect((await o.sendOut(rest.data.id)).data).toHaveLength(1);

    // Made and inspected: a pass is refused until the replacement rework is finished; then the two are released.
    expect(outcome(await inspect(as.office, o.jobId, "pass"))).toMatchObject({ code: "22023", message: expect.stringContaining("in rework") });
    expect(outcome(await start(as.workshop, follow.id))).toEqual(SAVED);
    expect(outcome(await cost(as.workshop, follow.id, { p_hours: 1 }))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, follow.id, 2))).toEqual(SAVED);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 2, available: 0, despatched: 8 } }); // finished is not passed
    expect(outcome(await inspect(as.office, o.jobId, "pass", "2 replacements in tolerance"))).toEqual(SAVED);
    expect(await o.lines()).toMatchObject({ "Part A": { held: 0, available: 2, despatched: 8 } });
    expect(await summary(as.workshop, o.jobId)).toMatchObject({ remaining_to_make: 0 });
    const last = await o.despatch({ "Part A": 2 });
    expect(outcome(last)).toEqual(SAVED);
    expect((await o.sendOut(last.data.id)).data).toHaveLength(1);
    expect(await goneOutOf(o.jobId)).toBe(16);

    const event = await audit(o.jobId, "REOPEN_REWORK");
    expect(event).toHaveLength(1);
    expect(event[0].actor_user_id).toBe(world.tenants.alpha.users.office.id);
    expect(event[0].metadata).toMatchObject({ rework_id: follow.id, follow_up_of: rework_id, quantity: 2, line: "Part A", batch: "B-7", instructions: "Make 2 off Part A to rev C" });
    expect((await audit(o.jobId, "INSPECT_JOB")).at(-1)!.metadata).toMatchObject({ result: "pass", after_rework: true, replacements_held: 0 });
  });

  it("scrap then concede: an admin reopens, a partial remake is passed, and what is still owed can be reopened again", async () => {
    const id = await finishedJob(10);
    const { rework_id } = (await fail(as.workshop, id, { p_quantity: 4 })).data;
    expect(outcome(await scrap(as.workshop, rework_id, 3))).toEqual(SAVED);
    expect(outcome(await inspect(as.admin, id, "concession", "1 accepted as is", "Customer accepted"))).toEqual(SAVED);
    expect(await summary(as.office, id)).toMatchObject({ quantity_available: 7, remaining_to_make: 3 });
    const first = await as.admin.rpc("open_replacement_rework", { p_rework: rework_id, p_instructions: "Make 3" });
    expect(outcome(first)).toEqual(SAVED);
    expect(outcome(await start(as.workshop, first.data.rework_id))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, first.data.rework_id, 2))).toEqual(SAVED);
    expect(outcome(await inspect(as.office, id, "pass", "2 made"))).toEqual(SAVED);
    expect(await summary(as.office, id)).toMatchObject({ quantity_available: 9, remaining_to_make: 1 });
    const second = await as.office.rpc("open_replacement_rework", { p_rework: first.data.rework_id, p_instructions: "Make the last one" });
    expect(outcome(second)).toEqual(SAVED);
    expect(second.data).toMatchObject({ quantity: 1, follow_up_of: first.data.rework_id });
    expect(outcome(await as.office.rpc("open_replacement_rework", { p_rework: second.data.rework_id, p_instructions: "x" }))).toMatchObject({ code: "22023", message: expect.stringContaining("still open") });
    expect(await audit(id, "REOPEN_REWORK")).toHaveLength(2);
  });
});

describe("finishing records the replacements actually made", () => {
  it("a partial remake: the replacements still to make stay held after the pass", async () => {
    const id = await finishedJob(10);
    const { rework_id } = (await fail(as.workshop, id, { p_quantity: 4 })).data;
    expect(outcome(await scrap(as.workshop, rework_id, 3))).toEqual(SAVED);
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    // How many were remade must be said when replacements are outstanding, and can't be more than were scrapped.
    expect(outcome(await finish(as.workshop, rework_id, null))).toMatchObject({ code: "22023", message: expect.stringContaining("replacements") });
    expect(outcome(await finish(as.workshop, rework_id, 4))).toMatchObject({ code: "22023", message: expect.stringContaining("3") });
    expect(outcome(await finish(as.workshop, rework_id, -1))).toMatchObject({ code: "22023" });
    const done = await finish(as.workshop, rework_id, 2);
    expect(outcome(done)).toEqual(SAVED);
    expect(done.data).toMatchObject({ quantity_remade: 2, replacements_outstanding: 1 });
    expect((await reworks(id))[0]).toMatchObject({ status: "finished", quantity_scrapped: 3, quantity_remade: 2 });
    expect((await as.workshop.from("job_rework_entries").select("kind, quantity").eq("rework_id", rework_id).eq("kind", "remake")).data).toEqual([{ kind: "remake", quantity: 2 }]);
    expect((await audit(id, "FINISH_REWORK"))[0].metadata).toMatchObject({ quantity_scrapped: 3, quantity_remade: 2, replacements_outstanding: 1 });
    expect(await summary(as.workshop, id)).toMatchObject({ remaining_to_make: 1, live_status: "finished" });
    const passed = await inspect(as.office, id, "pass", "Re-bored 1, 2 remade: in tolerance");
    expect(outcome(passed)).toEqual(SAVED);
    expect(passed.data).toMatchObject({ quantity_released: 9, replacements_held: 1 });
    expect(await summary(as.workshop, id)).toMatchObject({ released: true, quantity_available: 9, remaining_to_make: 1 });
  });

  it("nothing scrapped: finishing needs no number, and 0 is the only number it takes", async () => {
    const id = await finishedJob(5);
    const { rework_id } = (await fail(as.workshop, id, { p_quantity: 2 })).data;
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    expect(outcome(await finish(as.workshop, rework_id, 1))).toMatchObject({ code: "22023" });
    expect(outcome(await finish(as.workshop, rework_id, null))).toEqual(SAVED);
    expect((await reworks(id))[0]).toMatchObject({ status: "finished", quantity_remade: 0 });
  });
});

describe("other companies and read-only support", () => {
  it("another company can't fail, start, cost, scrap, finish or read a job's rework", async () => {
    const id = await finishedJob(10);
    const { rework_id } = (await fail(as.admin, id, { p_quantity: 2 })).data;
    expect(outcome(await fail(as.betaAdmin, id))).toMatchObject({ code: "P0002" });
    expect(outcome(await start(as.betaAdmin, rework_id))).toMatchObject({ code: "P0002" });
    expect(outcome(await cost(as.betaAdmin, rework_id))).toMatchObject({ code: "P0002" });
    expect(outcome(await scrap(as.betaAdmin, rework_id, 1))).toMatchObject({ code: "P0002" });
    expect(outcome(await finish(as.betaAdmin, rework_id))).toMatchObject({ code: "P0002" });
    expect(outcome(await as.betaAdmin.rpc("job_rework_summary", { p_job: id }))).toMatchObject({ code: "P0002" });
    expect((await as.betaAdmin.from("job_rework").select("id").eq("job_id", id)).data).toEqual([]);
    expect((await as.betaAdmin.from("job_rework_entries").select("id").eq("job_id", id)).data).toEqual([]);
    // A job of company beta can't be failed from alpha either.
    const theirs = await finishedJob(10, world.tenants.beta.id);
    expect(outcome(await fail(as.admin, theirs))).toMatchObject({ code: "P0002" });
    expect(outcome(await as.admin.rpc("job_rework_summary", { p_job: theirs }))).toMatchObject({ code: "P0002" });
    expect(await reworks(theirs)).toEqual([]);
    expect(await job(id)).toMatchObject({ stage: "rework" });
    expect((await reworks(id))[0]).toMatchObject({ status: "open", quantity_scrapped: 0 });
  });

  it("a read-only support session can read the rework but write none of it", async () => {
    const id = await finishedJob(10);
    const { rework_id } = (await fail(as.admin, id, { p_quantity: 3 })).data;
    expect(outcome(await start(as.workshop, rework_id))).toEqual(SAVED);
    const finishedJobId = await finishedJob(10);

    // A platform owner with no membership of alpha enters it for support: read-only until elevated.
    const email = `owner.${world.runId}@example.test`;
    const password = generatePassword(16);
    const made = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Owner Person" } });
    expect(made.error).toBeNull();
    const ownerId = made.data.user!.id;
    // An ordinary viewer of company beta (that gives the person a profile); alpha is entered as support.
    expect((await adminClient().rpc("add_member", { p_org: world.tenants.beta.id, p_email: email, p_role: "viewer" })).data).toBe("member");
    await withDb(async (db) => { await db.query("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner')", [ownerId]); });
    // Every platform function needs the second step (036): the owner enrols an authenticator and signs in with it.
    const factor = await enrolTotp(await signedInClient({ email, password }));
    const support = await signedInClient({ email, password });
    await passSecondStep(support, factor.factorId, factor.secret);
    await support.auth.refreshSession();
    expect(outcome(await support.rpc("platform_enter_organization", { p_org: world.tenants.alpha.id, p_reason: "Looking at a rework query" }))).toEqual(SAVED);

    expect((await support.from("job_rework").select("id").eq("id", rework_id)).data).toHaveLength(1);
    expect(await summary(support, id)).toMatchObject({ cycles: 1, live_status: "in_progress" });
    const inspectionRows = async () => (await adminClient().from("job_inspections").select("id").eq("job_id", id).order("id")).data;
    const inspectedBefore = await inspectionRows();
    const refused = [
      await fail(support, finishedJobId),
      await cost(support, rework_id),
      await scrap(support, rework_id, 1),
      await finish(support, rework_id),
    ].map(outcome);
    expect(refused).toEqual(refused.map(() => ({ code: "42501", message: expect.stringMatching(/read-only/i) })));
    // 083 (ISO 9001 7.2): a support session is never on the authorised inspectors list, so inspect_job refuses it on that list check,
    // before anything is written, rather than at the read-only trigger further on.
    const inspected = await inspect(support, id, "concession", "Out by 0.04", "Support trying it on");
    expect({ ...outcome(inspected), hint: inspected.error?.hint ?? null }).toEqual({
      code: "42501",
      message: "Only an authorised inspector can record an inspection. An admin adds inspectors in Admin > Users > Inspectors.",
      hint: "not_authorised_inspector",
    });
    // Nothing changed.
    expect(await inspectionRows()).toEqual(inspectedBefore);
    expect(await job(id)).toMatchObject({ stage: "rework" });
    expect((await reworks(id))[0]).toMatchObject({ status: "in_progress", quantity_scrapped: 0, finished_at: null });
    expect((await adminClient().from("job_rework_entries").select("id").eq("job_id", id)).data).toEqual([]);
    expect(await reworks(finishedJobId)).toEqual([]);
  });
});

describe("the release verify script", () => {
  it("runs read-only and every fact it checks is true, with the reworks made above counted", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/rework_037.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin transaction read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    expect(rows.filter((r) => r.n <= 9).map((r) => [r.n, r.value])).toEqual(Array.from({ length: 9 }, (_, i) => [i + 1, "true"]));
    expect(rows.filter((r) => r.n > 9 && r.n !== 14).length).toBe(6);
    expect(rows.filter((r) => r.n === 14).map((r) => r.value)).toEqual(["true"]);
    expect(Number(rows.find((r) => r.n === 10)!.value)).toBeGreaterThan(5);
  });
});
