/**
 * Who may inspect, what a job requires before a pass, stale results, and the name on the record (migration 034, audit).
 * An admin on the inspectors list (083: the fixture puts the admin on it) may; office and workshop only when an admin has made them an inspector (off by default); a job can require its
 * certificates attached and its checklist ticked; a pass must name the worksheet version it was made against; and the name
 * stored is a display name, never an e-mail address, wherever workshop and viewers can read it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let n = 0;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const alpha = () => world.tenants.alpha;
async function finishedJob(extra: Record<string, unknown> = {}) {
  n += 1;
  const { data, error } = await adminClient().from("jobs")
    .insert({ organization_id: alpha().id, job_no: `J-CTL-${world.runId}-${n}`, customer: "Control Co", stage: "inspection", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", quantity_required: 10, ...extra })
    .select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const version = async (id: string) => (await adminClient().from("jobs").select("worksheet_version").eq("id", id).single()).data!.worksheet_version as number;
const inspect = async (client: SupabaseClient, id: string, result = "pass", extra: Record<string, unknown> = {}) =>
  recordInspection(client, { p_job: id, p_result: result, p_notes: "Bore 25.01 mm", p_attachment_path: null, p_attachment_name: null, p_concession_reason: result === "concession" ? "Accepted by the customer" : null, p_expected_version: await version(id), ...extra });
/** A failure opens a rework (037): the workshop starts and finishes it before the job can pass again. */
async function reworkDone(id: string) {
  const live = (await adminClient().from("job_rework").select("id").eq("job_id", id).in("status", ["open", "in_progress"]).single()).data!.id as string;
  expect((await as.admin.rpc("start_job_rework", { p_rework: live })).error).toBeNull();
  expect((await as.admin.rpc("finish_job_rework", { p_rework: live, p_note: null, p_remade: 0 })).error).toBeNull();
}
const setFlag = async (role: "office" | "workshop", value: boolean) =>
  adminClient().from("organization_members").update({ can_inspect: value }).eq("organization_id", alpha().id).eq("user_id", alpha().users[role].id);

describe("who may record an inspection", () => {
  it("is off by default: office and workshop may not until an admin says so, viewers never; the admin is on the list (083)", async () => {
    const flags = (await adminClient().from("organization_members").select("user_id, can_inspect").eq("organization_id", alpha().id)).data!;
    // 083: an admin records a pass only when on the authorised inspectors list; the fixture puts the admin on it, as 083's backfill does.
    expect(flags.every((row) => row.can_inspect === (row.user_id === alpha().users.admin.id))).toBe(true);
    const id = await finishedJob();
    for (const role of ["office", "workshop", "viewer"]) expect((await inspect(as[role], id)).error, role).toMatchObject({ code: "42501" });
    expect((await inspect(as.admin, id)).error).toBeNull();
  });

  it("only an admin sets it, per person, audited; nobody writes the column directly; another company's people are out of reach", async () => {
    const id = await finishedJob();
    for (const role of ["office", "workshop", "viewer"]) {
      expect((await as[role].rpc("set_member_inspector", { p_user: alpha().users.workshop.id, p_value: true })).error, `${role} set`).toMatchObject({ code: "42501" });
      const direct = await as[role].from("organization_members").update({ can_inspect: true }).eq("user_id", alpha().users[role as "office"].id).select("user_id");
      expect(direct.error !== null || (direct.data ?? []).length === 0, `${role} direct`).toBe(true);
    }
    const directAdmin = await as.admin.from("organization_members").update({ can_inspect: true }).eq("user_id", alpha().users.workshop.id).select("user_id");
    expect(directAdmin.error !== null || (directAdmin.data ?? []).length === 0).toBe(true);
    expect((await as.admin.rpc("set_member_inspector", { p_user: world.tenants.beta.users.admin.id, p_value: true })).error).toMatchObject({ code: "P0002" });
    expect((await as.admin.rpc("set_member_inspector", { p_user: alpha().users.workshop.id, p_value: null })).error).toMatchObject({ code: "22023" });
    expect((await as.betaAdmin.rpc("set_member_inspector", { p_user: alpha().users.workshop.id, p_value: true })).error).toMatchObject({ code: "P0002" });

    expect((await as.admin.rpc("set_member_inspector", { p_user: alpha().users.workshop.id, p_value: true })).error).toBeNull();
    const audit = await withDb((db) => db.query("select metadata from security_audit.audit_log where action = 'SET_INSPECTOR' and entity_id = $1", [alpha().users.workshop.id]));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ can_inspect: true, was: false });
    expect((await inspect(as.workshop, id)).error).toBeNull();
    // Office is still not one, and taking it away stops the workshop again.
    const other = await finishedJob();
    expect((await inspect(as.office, other)).error).toMatchObject({ code: "42501" });
    expect((await as.admin.rpc("set_member_inspector", { p_user: alpha().users.workshop.id, p_value: false })).error).toBeNull();
    expect((await inspect(as.workshop, other)).error).toMatchObject({ code: "42501" });
    expect((await as.workshop.from("organization_members").select("can_inspect").eq("user_id", alpha().users.workshop.id)).data).toEqual([{ can_inspect: false }]);
  });
});

describe("what a job requires before a pass", () => {
  it("needs its certificates attached when it says so; an admin's concession is the way past", async () => {
    await setFlag("workshop", true);
    const id = await finishedJob({ certs_required: true });
    const refused = await inspect(as.workshop, id);
    expect(refused.error).toMatchObject({ code: "22023" });
    expect(refused.error!.message).toMatch(/certificates attached/);
    expect((await inspect(as.workshop, id, "fail")).error).toBeNull(); // a failure is always recorded
    await reworkDone(id);
    const path = `${alpha().id}/${id}/certs/1-cert.png`;
    expect((await as.workshop.from("job_files").insert({ organization_id: alpha().id, job_id: id, kind: "cert", ref: "Heat 9", file_name: "cert.png", storage_bucket: "job-drawings", storage_path: path })).error).toBeNull();
    expect((await inspect(as.workshop, id)).error).toBeNull();
    const second = await finishedJob({ certs_required: true });
    expect((await inspect(as.admin, second, "concession")).error).toBeNull();
  });

  it("needs every checklist item ticked when it says so", async () => {
    await setFlag("workshop", true);
    const id = await finishedJob({ checklist_required: true, checklist: { sizes_checked: true, threads_check: true } });
    const refused = await inspect(as.workshop, id);
    expect(refused.error).toMatchObject({ code: "22023" });
    expect(refused.error!.message).toMatch(/checklist/);
    const all = { sizes_checked: true, threads_check: true, parts_deburred: true, parts_marked: true, parts_clean: true, parts_counted: true };
    expect((await adminClient().from("jobs").update({ checklist: all }).eq("id", id)).error).toBeNull();
    expect((await inspect(as.workshop, id)).error).toBeNull();
  });

  it("only admin and office change what a job requires; both are off by default", async () => {
    const id = await finishedJob();
    expect((await adminClient().from("jobs").select("certs_required, checklist_required").eq("id", id).single()).data).toEqual({ certs_required: false, checklist_required: false });
    expect((await as.workshop.from("jobs").update({ certs_required: true }).eq("id", id).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.office.from("jobs").update({ certs_required: true, checklist_required: true }).eq("id", id).select("id")).data).toHaveLength(1);
    await setFlag("workshop", true);
    expect((await as.workshop.from("jobs").update({ certs_required: false }).eq("id", id).select("id")).error).toMatchObject({ code: "42501" });
    // Switching a requirement doesn't count as a change to the worksheet.
    expect(await version(id)).toBe(0);
  });

  it("the checklist keys the database asks for are the ones the worksheet has", async () => {
    const { CHECKLIST_ITEMS } = await import("@/lib/job-worksheet");
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/034_workflow_day_one.sql", "utf8");
    const listed = /unnest\(ARRAY\[([^\]]+)\]\) AS k/.exec(sql)![1].split(",").map((item) => item.trim().replace(/'/g, ""));
    expect(listed).toEqual(CHECKLIST_ITEMS.map((item) => item.key));
  });
});

describe("a stale result is refused", () => {
  it("a pass made against an older version of the job is refused; a missing version too; a failure is always recorded", async () => {
    await setFlag("workshop", true);
    const id = await finishedJob();
    const opened = await version(id);
    expect((await adminClient().from("jobs").update({ quantity_required: 11 }).eq("id", id)).error).toBeNull();
    expect(await version(id)).toBe(opened + 1);
    for (const result of ["pass", "concession"]) {
      const stale = await inspect(as.admin, id, result, { p_expected_version: opened });
      expect(stale.error, result).toMatchObject({ code: "22023" });
      expect(stale.error!.message).toMatch(/changed after you opened it/);
    }
    expect((await inspect(as.workshop, id, "pass", { p_expected_version: null })).error).toMatchObject({ code: "22023" });
    expect((await inspect(as.workshop, id, "fail", { p_expected_version: opened })).error).toBeNull();
    await reworkDone(id);
    expect((await inspect(as.workshop, id)).error).toBeNull();
    expect((await adminClient().from("job_inspections").select("worksheet_version, result").eq("job_id", id).order("inspected_at")).data).toEqual([{ worksheet_version: opened + 1, result: "fail" }, { worksheet_version: opened + 1, result: "pass" }]);
  });
});

describe("the name on the record is never an e-mail address", () => {
  const emails = () => [alpha().users.workshop.email, alpha().users.admin.email, alpha().users.office.email, alpha().users.viewer.email];
  const leaks = (value: unknown) => JSON.stringify(value).includes("@");

  it("an inspector with no name, or a name that is an address, is recorded as 'Inspector'; workshop and viewers read no address anywhere", async () => {
    await setFlag("workshop", true);
    await setFlag("office", true);
    const service = adminClient();
    const original = (await service.from("user_profiles").select("id, full_name").in("id", [alpha().users.workshop.id, alpha().users.office.id])).data!;
    try {
      expect((await service.from("user_profiles").update({ full_name: null }).eq("id", alpha().users.workshop.id)).error).toBeNull();
      expect((await service.from("user_profiles").update({ full_name: alpha().users.office.email }).eq("id", alpha().users.office.id)).error).toBeNull();
      const first = await finishedJob();
      const second = await finishedJob();
      expect((await inspect(as.workshop, first)).error).toBeNull();
      expect((await inspect(as.office, second)).error).toBeNull();
      // A name with only blanks and control characters is no name either.
      await service.from("user_profiles").update({ full_name: " \t " }).eq("id", alpha().users.workshop.id);
      const third = await finishedJob();
      const result = await inspect(as.workshop, third);
      expect(result.error).toBeNull();
      expect(leaks(result.data)).toBe(false);

      for (const id of [first, second, third]) {
        expect((await service.from("jobs").select("inspected_by").eq("id", id).single()).data!.inspected_by).toBe("Inspector");
        expect((await service.from("job_inspections").select("inspector_name").eq("job_id", id).single()).data!.inspector_name).toBe("Inspector");
      }
      for (const role of ["workshop", "viewer"]) {
        const jobs = await as[role].from("jobs").select("*").in("id", [first, second, third]);
        const inspections = await as[role].from("job_inspections").select("*").in("job_id", [first, second, third]);
        expect(jobs.data, role).toHaveLength(3);
        expect(inspections.data, role).toHaveLength(3);
        expect(leaks(jobs.data), `${role} jobs`).toBe(false);
        expect(leaks(inspections.data), `${role} inspections`).toBe(false);
        for (const email of emails()) {
          expect(JSON.stringify(jobs.data)).not.toContain(email);
          expect(JSON.stringify(inspections.data)).not.toContain(email);
        }
        const activity = await as[role].rpc("record_activity", { p_table: "jobs", p_id: first, p_limit: 50 });
        expect(leaks(activity.data), `${role} activity`).toBe(false);
      }
    } finally {
      for (const row of original) await service.from("user_profiles").update({ full_name: row.full_name }).eq("id", row.id);
    }
  });

  it("a real name is kept, and the columns refuse an address from anywhere", async () => {
    await setFlag("workshop", true);
    const id = await finishedJob();
    expect((await inspect(as.workshop, id)).error).toBeNull();
    expect((await adminClient().from("job_inspections").select("inspector_name").eq("job_id", id).single()).data!.inspector_name).toBe("Workshop alpha");
    expect((await adminClient().from("jobs").update({ inspected_by: "someone@example.test" }).eq("id", id)).error).toMatchObject({ code: "23514" });
    // Since 081 an inspection is a record (job_inspections_immutable): no UPDATE reaches the rule, the service role's included, and the
    // stored name stays. The rule itself is proved on the one write a record still takes, a new row: refused by the no-@ check (23514).
    const record = (await adminClient().from("job_inspections").select("id").eq("job_id", id).single()).data!;
    expect((await adminClient().from("job_inspections").update({ inspector_name: "someone@example.test" }).eq("id", record.id)).error).toMatchObject({ code: "42501", hint: "record_immutable" });
    expect((await adminClient().from("job_inspections").select("inspector_name").eq("id", record.id).single()).data!.inspector_name).toBe("Workshop alpha");
    const address = await adminClient().from("job_inspections").insert({ organization_id: alpha().id, job_id: id, result: "pass", release_decision: "released", measured_notes: "ok",
      inspector_id: null, inspector_name: "someone@example.test", inspected_at: new Date().toISOString(), worksheet_version: await version(id) });
    expect(address.error).toMatchObject({ code: "23514", message: expect.stringContaining("job_inspections_inspector_name") });
  });
});
