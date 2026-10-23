/**
 * Inspection evidence and release rules (migration 034, W5). A job reaches Done only through record_job_inspection (a pass,
 * or an admin's concession); a failed inspection holds it; any later change to the worksheet or the quantity after sign-off
 * sends it back to awaiting inspection, enforced by a trigger. Inspections are visible to the company's own people only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, allowInspectors, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let counter = 0;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  await allowInspectors(world);
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** A finished job awaiting inspection, made by the service role (the importer's path). */
async function finishedJob(org = world.tenants.alpha.id) {
  const { data, error } = await adminClient().from("jobs")
    .insert({ organization_id: org, job_no: `J-INS-${world.runId}-${++counter}`, customer: "Inspection Co", stage: "inspection", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", quantity_required: 10 })
    .select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const job = async (id: string) => (await adminClient().from("jobs").select("stage, inspected_at, inspected_by, worksheet_version, quantity_required").eq("id", id).single()).data!;
const records = async (id: string) => ((await adminClient().from("job_inspections").select("*").eq("job_id", id).order("inspected_at")).data ?? []) as Record<string, unknown>[];
/** Inspects the job as it is now (its current worksheet version) unless the test says otherwise. */
const inspect = async (client: SupabaseClient, id: string, result: string, notes: string | null = "Bore 25.01 mm", extra: Record<string, unknown> = {}) =>
  recordInspection(client, { p_job: id, p_result: result, p_notes: notes, p_attachment_path: null, p_attachment_name: null, p_concession_reason: null, p_expected_version: (await job(id)).worksheet_version, ...extra });

describe("release needs a pass or an admin's concession", () => {
  it("the browser roles can't set the inspection columns or move a job to Done by editing it", async () => {
    const id = await finishedJob();
    for (const role of ["admin", "office", "workshop"]) {
      const sign = await as[role].from("jobs").update({ inspected_at: new Date().toISOString(), inspected_by: "Me", stage: "complete" }).eq("id", id).select("id");
      expect(sign.error, `${role} sign-off`).toMatchObject({ code: "42501" });
      const done = await as[role].from("jobs").update({ stage: "complete" }).eq("id", id).select("id");
      expect(done.error, `${role} stage`).toMatchObject({ code: "42501" });
    }
    const born = await as.admin.from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-INS-NEW-${world.runId}`, customer: "X", inspected_at: new Date().toISOString(), stage: "complete" });
    expect(born.error).toMatchObject({ code: "42501" });
    expect(await job(id)).toMatchObject({ stage: "inspection", inspected_at: null });
  });

  it("a pass releases the job and keeps the evidence: who, when, notes, the worksheet version", async () => {
    const id = await finishedJob();
    const done = await inspect(as.workshop, id, "pass", "Bore 25.01, 25.02 mm; length 60.00 mm");
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ result: "pass", release_decision: "released" });
    expect(await job(id)).toMatchObject({ stage: "complete", inspected_by: "Workshop alpha" });
    expect((await job(id)).inspected_at).toBeTruthy();
    const [record] = await records(id);
    expect(record).toMatchObject({ result: "pass", release_decision: "released", measured_notes: "Bore 25.01, 25.02 mm; length 60.00 mm", inspector_id: world.tenants.alpha.users.workshop.id, organization_id: world.tenants.alpha.id, worksheet_version: 0 });
    // The audit trail names the inspection.
    const audit = await withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'INSPECT_JOB'", [id])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ result: "pass", release_decision: "released" });
    // Once released it can't be passed again.
    expect((await inspect(as.office, id, "pass")).error).toMatchObject({ code: "22023" });
  });

  it("a fail holds the job in rework; a pass is refused until the rework is finished (the rework loop is in rework.test.ts)", async () => {
    const id = await finishedJob();
    const failed = await inspect(as.office, id, "fail", "Bore 25.08 mm: oversize");
    expect({ code: failed.error?.code ?? null, message: failed.error?.message ?? null, data: failed.data }).toMatchObject({ code: null, message: null, data: { result: "fail", release_decision: "held" } });
    expect(await job(id)).toMatchObject({ stage: "rework", inspected_at: null });
    const early = await inspect(as.office, id, "pass", "Re-bored: 25.01 mm");
    expect({ code: early.error?.code, message: early.error?.message }).toMatchObject({ code: "22023", message: expect.stringContaining("in rework") });
    expect((await records(id)).map((r) => r.result)).toEqual(["fail"]);
  });

  it("a concession is for admins only, needs a reason, and releases the job", async () => {
    const id = await finishedJob();
    expect((await inspect(as.workshop, id, "concession", "Bore 25.04", { p_concession_reason: "Customer agreed" })).error).toMatchObject({ code: "42501" });
    expect((await inspect(as.office, id, "concession", "Bore 25.04", { p_concession_reason: "Customer agreed" })).error).toMatchObject({ code: "42501" });
    expect((await inspect(as.admin, id, "concession", "Bore 25.04")).error).toMatchObject({ code: "22023" });
    expect(await job(id)).toMatchObject({ stage: "inspection", inspected_at: null });
    const ok = await inspect(as.admin, id, "concession", "Bore 25.04 mm, 0.01 over", { p_concession_reason: "Customer agreed by e-mail 02/10" });
    expect(ok.data).toMatchObject({ result: "concession", release_decision: "released" });
    expect(await job(id)).toMatchObject({ stage: "complete" });
    expect((await records(id))[0]).toMatchObject({ concession_reason: "Customer agreed by e-mail 02/10" });
  });

  it("refuses an unfinished job, no measured notes, a bad result, a viewer, and an attachment from elsewhere", async () => {
    const { data } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-INS-OPEN-${world.runId}`, customer: "Open Co", stage: "machining" }).select("id").single();
    expect((await inspect(as.admin, data!.id, "pass")).error).toMatchObject({ code: "22023" });
    const id = await finishedJob();
    expect((await inspect(as.admin, id, "pass", "   ")).error).toMatchObject({ code: "22023" });
    expect((await inspect(as.admin, id, "approved")).error).toMatchObject({ code: "22023" });
    expect((await inspect(as.viewer, id, "pass")).error).toMatchObject({ code: "42501" });
    const elsewhere = `${world.tenants.beta.id}/${id}/inspection/1-photo.png`;
    expect((await inspect(as.admin, id, "pass", "ok", { p_attachment_path: elsewhere, p_attachment_name: "photo.png" })).error).toMatchObject({ code: "22023" });
    expect((await inspect(as.admin, id, "pass", "ok", { p_attachment_path: `${world.tenants.alpha.id}/${id}/other/1-photo.png` })).error).toMatchObject({ code: "22023" });
    expect(await records(id)).toEqual([]);
    expect(await job(id)).toMatchObject({ inspected_at: null });
    const mine = `${world.tenants.alpha.id}/${id}/inspection/1-photo.png`;
    expect((await inspect(as.admin, id, "pass", "ok", { p_attachment_path: mine, p_attachment_name: "photo.png" })).error).toBeNull();
    expect((await records(id))[0]).toMatchObject({ attachment_path: mine, attachment_name: "photo.png" });
  });
});

describe("a later edit withdraws the sign-off", () => {
  async function released() {
    const id = await finishedJob();
    expect((await inspect(as.admin, id, "pass")).error).toBeNull();
    expect(await job(id)).toMatchObject({ stage: "complete" });
    return id;
  }

  it("a worksheet change sends it back to awaiting inspection", async () => {
    const id = await released();
    const edit = await as.workshop.from("jobs").update({ improvement_comments: "Use a sharper insert next time" }).eq("id", id).select("stage, inspected_at, inspected_by, worksheet_version").single();
    expect(edit.error).toBeNull();
    expect(edit.data).toMatchObject({ stage: "inspection", inspected_at: null, inspected_by: null, worksheet_version: 1 });
    expect(await job(id)).toMatchObject({ stage: "inspection", inspected_at: null });
    // The evidence stays; inspecting again releases it against the new version.
    expect(await records(id)).toHaveLength(1);
    expect((await inspect(as.workshop, id, "pass", "Re-checked after the change")).error).toBeNull();
    expect((await records(id)).map((r) => r.worksheet_version)).toEqual([0, 1]);
    expect(await job(id)).toMatchObject({ stage: "complete" });
  });

  it("a quantity change does the same, also for an admin", async () => {
    const id = await released();
    expect((await as.admin.from("jobs").update({ quantity_required: 12 }).eq("id", id)).error).toBeNull();
    expect(await job(id)).toMatchObject({ stage: "inspection", inspected_at: null, quantity_required: 12 });
  });

  it("a change that isn't the worksheet or the quantity (a status move) leaves the release alone", async () => {
    const id = await released();
    expect((await as.office.from("jobs").update({ status: "at_risk" }).eq("id", id)).error).toBeNull();
    expect(await job(id)).toMatchObject({ stage: "complete" });
    expect((await job(id)).inspected_at).toBeTruthy();
  });

  it("a failed inspection withdraws an earlier release", async () => {
    const id = await released();
    expect((await inspect(as.admin, id, "fail", "Found a burr on the thread")).error).toBeNull();
    expect(await job(id)).toMatchObject({ stage: "rework", inspected_at: null });
  });

  it("the service role and the owner are exempt (imports, repairs)", async () => {
    const id = await released();
    expect((await adminClient().from("jobs").update({ improvement_comments: "Imported note" }).eq("id", id)).error).toBeNull();
    expect((await job(id)).inspected_at).toBeTruthy();
  });
});

describe("other companies", () => {
  it("can't read the inspections, record one, or release the job", async () => {
    const id = await finishedJob();
    expect((await inspect(as.admin, id, "pass")).error).toBeNull();
    expect((await as.betaAdmin.from("job_inspections").select("id").eq("job_id", id)).data).toEqual([]);
    expect((await inspect(as.betaAdmin, id, "fail", "Not mine")).error).toMatchObject({ code: "P0002" });
    const own = await finishedJob(world.tenants.beta.id);
    expect((await as.admin.from("job_inspections").select("id").eq("job_id", own)).data).toEqual([]);
    expect((await inspect(as.admin, own, "pass")).error).toMatchObject({ code: "P0002" });
    expect(await records(own)).toEqual([]);
  });

  it("everyone in the company can read an inspection, and nobody can write one directly", async () => {
    const id = await finishedJob();
    expect((await inspect(as.office, id, "pass")).error).toBeNull();
    for (const role of ["admin", "office", "workshop", "viewer"]) {
      expect((await as[role].from("job_inspections").select("id").eq("job_id", id)).data, `${role} read`).toHaveLength(1);
    }
    const forged = { organization_id: world.tenants.alpha.id, job_id: id, result: "pass", release_decision: "released", measured_notes: "forged", inspector_name: "Me", worksheet_version: 0 };
    for (const role of ["admin", "office", "workshop"]) expect((await as[role].from("job_inspections").insert(forged)).error, `${role} insert`).not.toBeNull();
    expect((await as.admin.from("job_inspections").update({ measured_notes: "changed" }).eq("job_id", id).select("id")).data ?? []).toEqual([]);
    expect((await as.admin.from("job_inspections").delete().eq("job_id", id).select("id")).data ?? []).toEqual([]);
  });
});
