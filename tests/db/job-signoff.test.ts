/**
 * Operator sign-off (M4, migration 045). sign_off_job snapshots and hashes the worksheet on the server, for the job's current
 * revision (worksheet_version); records can't be written through the API and are never changed or removed; signing changes
 * nothing on the job (so the release and the version stay as they were); the SQL and TypeScript canonical hashes agree.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordSha256, verifySignOff, type JobSignOff } from "@/lib/job-signoff";
import { canonicalJson, sha256Hex } from "@/lib/snapshot-hash";

import { CANONICAL_FIXTURES } from "../support/canonical-fixtures";
import { type SyntheticWorld, adminClient, allowInspectors, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let counter = 0;
const PATH = "M10 10L60 40L120 20L200 80";

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

async function finishedJob(extra: Record<string, unknown> = {}, org = world.tenants.alpha.id) {
  const { data, error } = await adminClient().from("jobs")
    .insert({ organization_id: org, job_no: `J-SO-${world.runId}-${++counter}`, customer: "Sign Co", stage: "inspection", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", quantity_required: 10, ...extra })
    .select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const job = async (id: string) => (await adminClient().from("jobs").select("stage, inspected_at, inspected_by, worksheet_version, signed_off_by, signed_off_at").eq("id", id).single()).data!;
const signoffs = async (id: string) => ((await adminClient().from("job_signoffs").select("*").eq("job_id", id).order("created_at")).data ?? []) as JobSignOff[];
/** The job's current revision as the server sees it: worksheet_version and the snapshot hash job_signoff_revision gives. */
const revision = async (id: string) => (await withDb((db) => db.query<{ v: number; sha: string }>(
  "select j.worksheet_version as v, encode(extensions.digest(convert_to(public.canonical_jsonb(public.job_signoff_snapshot(j)), 'UTF8'), 'sha256'), 'hex') as sha from public.jobs j where j.id = $1", [id]))).rows[0];
const sign = async (client: SupabaseClient, id: string, extra: Record<string, unknown> = {}) => {
  const current = await revision(id);
  return client.rpc("sign_off_job", { p_job_id: id, p_expected_version: current.v, p_expected_snapshot_sha256: current.sha, p_initials: "ab", p_signer_name: "Alex Brown", p_signed_on: "2026-10-12", p_signature_kind: "drawn", p_signature_data: PATH, ...extra });
};

describe("who can sign off", () => {
  it("admin, office and workshop each sign a finished job (primary, then an inspector co-signature); each record keeps the snapshot, its hash and the signer", async () => {
    for (const role of ["admin", "office", "workshop"]) {
      const solo = await finishedJob();
      expect((await sign(as[role], solo)).error, role).toBeNull();
    }
    const id = await finishedJob({ drawing_no: "DWG-1", job_time_taken_hr: 2.5, checklist: { parts_clean: true, sizes_checked: false } });
    const steps: [string, Record<string, unknown>][] = [
      ["admin", { p_initials: "ad" }],
      ["office", { p_initials: "of", p_signature_kind: "typed", p_signature_data: "  Office Alpha ", p_kind: "inspector" }]];
    for (const [role, extra] of steps) {
      const done = await sign(as[role], id, extra);
      expect(done.error, role).toBeNull();
      expect(done.data).toMatchObject({ worksheet_version: 0, kind: extra.p_kind ?? "primary", snapshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), record_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
    const rows = await signoffs(id);
    expect(rows.map((r) => [r.initials, r.signature_kind, r.signed_by, r.kind])).toEqual([
      ["AD", "drawn", world.tenants.alpha.users.admin.id, "primary"], ["OF", "typed", world.tenants.alpha.users.office.id, "inspector"]]);
    expect(rows[1].signature_data).toBe("Office Alpha");
    expect(rows[0].snapshot).toMatchObject({ job_no: expect.stringContaining("J-SO-"), worksheet_version: "0", drawing_no: "DWG-1", job_time_taken_hr: "2.5", quantity_required: "10", checklist: { parts_clean: true, sizes_checked: false }, heat_cast_no: null });
    expect(rows[0].snapshot).not.toHaveProperty("signed_off_at");
    // Same worksheet, same snapshot hash; the record hash differs per signer.
    expect(new Set(rows.map((r) => r.snapshot_sha256)).size).toBe(1);
    expect(new Set(rows.map((r) => r.record_sha256)).size).toBe(2);
  });

  it("a viewer is refused but can read the history; nobody can write records directly", async () => {
    const id = await finishedJob();
    expect((await sign(as.viewer, id)).error).toMatchObject({ code: "42501" });
    expect((await sign(as.admin, id)).error).toBeNull();
    const seen = await as.viewer.from("job_signoffs").select("id, initials").eq("job_id", id);
    expect(seen.data).toHaveLength(1);
    const forged = await as.admin.from("job_signoffs").insert({ organization_id: world.tenants.alpha.id, job_id: id, worksheet_version: 0, snapshot: {}, snapshot_sha256: "0".repeat(64), record_sha256: "0".repeat(64), initials: "X", signer_name: "X", signed_on: "2026-10-01", signature_kind: "typed", signature_data: "X", signed_by: world.tenants.alpha.users.admin.id });
    expect(forged.error).toMatchObject({ code: "42501" });
    for (const role of ["admin", "office", "workshop"]) {
      await as[role].from("job_signoffs").update({ initials: "ZZ" }).eq("job_id", id);
      await as[role].from("job_signoffs").delete().eq("job_id", id);
    }
    expect((await signoffs(id)).map((r) => r.initials)).toEqual(["AB"]);
  });

  it("another company can neither sign the job nor see its sign-offs", async () => {
    const id = await finishedJob();
    expect((await sign(as.admin, id)).error).toBeNull();
    expect((await as.betaAdmin.rpc("sign_off_job", { p_job_id: id, p_expected_version: 0, p_expected_snapshot_sha256: (await revision(id)).sha, p_initials: "BA", p_signer_name: "Beta", p_signed_on: "2026-10-12", p_signature_kind: "typed", p_signature_data: "Beta" })).error).toMatchObject({ code: "P0002" });
    expect((await as.betaAdmin.from("job_signoffs").select("id").eq("job_id", id)).data).toEqual([]);
    expect(await signoffs(id)).toHaveLength(1);
  });
});

describe("what is signed", () => {
  it("refuses a stale revision, an unfinished job and bad input", async () => {
    const id = await finishedJob();
    const stale = await sign(as.workshop, id, { p_expected_version: 5 });
    // The same SQLSTATE record_job_inspection and the rework functions use for a stale version, with the message the app shows as it is.
    expect({ code: stale.error?.code, hint: stale.error?.hint, message: stale.error?.message }).toMatchObject({ code: "22023", hint: "stale_revision", message: expect.stringMatching(/^The worksheet changed since you opened it: reload and check before signing \(J-SO-.* is now revision 0\)\.$/) });
    const open = await finishedJob({ finished_at: null, stage: "in_progress" });
    expect((await sign(as.workshop, open)).error).toMatchObject({ code: "22023", message: expect.stringContaining("not finished") });
    for (const bad of [{ p_initials: "A1" }, { p_initials: "ABCDE" }, { p_signer_name: "me@example.test" }, { p_signer_name: " " }, { p_signed_on: "2099-01-01" },
      { p_signature_kind: "stamp" }, { p_signature_data: "M1 1<script>" }, { p_signature_data: "M1 1" }, { p_signature_kind: "typed", p_signature_data: "  " }]) {
      expect((await sign(as.workshop, id, bad)).error, JSON.stringify(bad)).toMatchObject({ code: "22023" });
    }
    // The signature is stored inline (no Storage object): its format and size are validated by the function. A data: URL, markup, or a
    // path one character over the limit is refused; a path at the limit is accepted (signed below on its own job).
    const longPath = (n: number) => `M0 0L${"1 ".repeat(Math.ceil(n / 2))}`.slice(0, n);
    for (const bad of [{ p_signature_data: "data:image/png;base64,iVBORw0KGgo=" }, { p_signature_data: "<svg><path d='M0 0L1 1'/></svg>" }, { p_signature_data: longPath(100001) },
      { p_signature_kind: "typed", p_signature_data: "x".repeat(201) }, { p_expected_snapshot_sha256: null }, { p_expected_snapshot_sha256: "abc" }]) {
      expect((await sign(as.workshop, id, bad)).error, JSON.stringify(bad).slice(0, 80)).toMatchObject({ code: "22023" });
    }
    const limit = await finishedJob();
    expect((await sign(as.workshop, limit, { p_signature_data: longPath(100000) })).error).toBeNull();
    expect((await signoffs(limit))[0].signature_data).toHaveLength(100000);
    expect(await signoffs(id)).toEqual([]);
  });

  it("an edit makes a new revision: the old sign-off stays on the old one and signing again signs the new one", async () => {
    const id = await finishedJob({ drawing_no: "DWG-A" });
    expect((await sign(as.workshop, id)).error).toBeNull();
    const edit = await as.office.from("jobs").update({ drawing_no: "DWG-B" }).eq("id", id).select("worksheet_version").single();
    expect(edit.data?.worksheet_version).toBe(1);
    expect((await sign(as.workshop, id, { p_expected_version: 0 })).error).toMatchObject({ code: "22023", message: expect.stringContaining("changed since you opened it") });
    expect((await sign(as.workshop, id)).error).toBeNull();
    const [first, second] = await signoffs(id);
    expect([first.worksheet_version, first.snapshot.drawing_no, second.worksheet_version, second.snapshot.drawing_no]).toEqual([0, "DWG-A", 1, "DWG-B"]);
    expect(first.snapshot_sha256).not.toBe(second.snapshot_sha256);
  });

  it("the date may be today in the UK (Europe/London, whatever the session or server time zone), never later", async () => {
    const id = await finishedJob();
    // sign_off_job runs with TimeZone=UTC; the check must still be against the UK calendar day. Computed here the same explicit way,
    // in a session whose own TimeZone is deliberately elsewhere.
    const dates = await withDb(async (db) => {
      await db.query("set timezone to 'Pacific/Kiritimati'"); // session-wide: `set local` is ignored outside a transaction, which left the session on UTC
      return (await db.query<{ london: string; tomorrow: string; session: string }>(
        "select to_char((now() at time zone 'Europe/London')::date, 'YYYY-MM-DD') as london, to_char((now() at time zone 'Europe/London')::date + 1, 'YYYY-MM-DD') as tomorrow, to_char(current_date, 'YYYY-MM-DD') as session")).rows[0];
    });
    expect((await sign(as.workshop, id, { p_signed_on: dates.tomorrow })).error).toMatchObject({ code: "22023", message: expect.stringContaining("future") });
    expect((await sign(as.workshop, id, { p_signed_on: dates.london })).error).toBeNull();
    expect((await signoffs(id)).map((r) => r.signed_on)).toEqual([dates.london]);
    // Near midnight the UK day and the UTC day differ (BST); the London day is the one that counts, so this is a real check then.
    expect(dates.session >= dates.london).toBe(true);
  });

  it("never before the job started: refused the day before (UK day), accepted on the start day; a job with no start uses the day it was created", async () => {
    // Started 2026-10-01 08:00 UTC = 09:00 BST: the start day is 1 October.
    const id = await finishedJob();
    const before = await sign(as.workshop, id, { p_signed_on: "2026-09-30" });
    expect({ code: before.error?.code, message: before.error?.message }).toEqual({ code: "22023", message: expect.stringMatching(/^The sign-off date can't be before the job started \(J-SO-.*, 1 October 2026\)\.$/) });
    expect(await signoffs(id)).toEqual([]);
    expect((await sign(as.workshop, id, { p_signed_on: "2026-10-01" })).error).toBeNull();
    expect((await signoffs(id)).map((r) => r.signed_on)).toEqual(["2026-10-01"]);
    // 23:30 UTC on 30 September is already 1 October in the UK (BST): the UK day counts, not the UTC day.
    const late = await finishedJob({ started_at: "2026-09-30T23:30:00Z" });
    expect((await sign(as.workshop, late, { p_signed_on: "2026-09-30" })).error).toMatchObject({ code: "22023", message: expect.stringContaining("before the job started") });
    expect((await sign(as.workshop, late, { p_signed_on: "2026-10-01" })).error).toBeNull();
    // No start: the day the job was created in the UK (today for a new row), so an earlier date is refused and today is accepted.
    const unstarted = await finishedJob({ started_at: null });
    const created = (await withDb((db) => db.query<{ d: string }>("select to_char((created_at at time zone 'Europe/London')::date, 'YYYY-MM-DD') as d from public.jobs where id = $1", [unstarted]))).rows[0].d;
    expect((await sign(as.workshop, unstarted, { p_signed_on: "2026-10-01" })).error).toMatchObject({ code: "22023", message: expect.stringContaining("before the job started") });
    expect((await sign(as.workshop, unstarted, { p_signed_on: created })).error).toBeNull();
  });

  it("signing changes nothing on the job: an inspected job stays released, the version and the legacy columns stay", async () => {
    const id = await finishedJob();
    const passed = await recordInspection(as.admin, { p_job: id, p_result: "pass", p_notes: "Bore 25.01 mm", p_attachment_path: null, p_attachment_name: null, p_concession_reason: null, p_expected_version: 0 });
    expect(passed.error).toBeNull();
    const before = await job(id);
    expect(before).toMatchObject({ stage: "complete", worksheet_version: 0 });
    expect((await sign(as.workshop, id)).error).toBeNull();
    expect(await job(id)).toEqual(before);
  });

  it("a job that ran on a machine (044): refused while it runs, signed once finish_job has ended the run; the run, the booking mirror and the job row stay as finish_job left them", async () => {
    const service = adminClient();
    const machine = (await service.from("machines").insert({ organization_id: world.tenants.alpha.id, name: `SO Mill ${world.runId}` }).select("id").single()).data!.id as string;
    const { data: created, error: createError } = await as.office.rpc("create_job", { p_customer: "Sign Co", p_description: "Signed after a machine run", p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null });
    expect(createError).toBeNull();
    const id = (created as { job_id: string }).job_id;
    expect((await as.workshop.rpc("start_machine_run", { p_job: id, p_machines: [machine], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null })).error).toBeNull();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    // Not finished: refused, and sign_off_job holds nothing a machine function waits on (only the job row, released at once).
    expect((await sign(as.workshop, id, { p_signed_on: today })).error).toMatchObject({ code: "22023", message: expect.stringContaining("not finished yet") });
    expect((await as.workshop.rpc("finish_job", { p_job: id, p_client_op_id: null, p_finished_at: null })).error).toBeNull();
    const runsBefore = (await service.from("machine_runs").select("id, ended_at, end_reason").eq("job_id", id)).data!;
    expect(runsBefore).toEqual([expect.objectContaining({ end_reason: "finished" })]);
    const rowBefore = (await service.from("jobs").select("*").eq("id", id).single()).data!;
    const done = await sign(as.workshop, id, { p_signed_on: today });
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ worksheet_version: rowBefore.worksheet_version });
    expect((await service.from("jobs").select("*").eq("id", id).single()).data).toEqual(rowBefore);
    expect((await service.from("machine_runs").select("id, ended_at, end_reason").eq("job_id", id)).data).toEqual(runsBefore);
  });
});

describe("one primary signature per revision, with an optional inspector co-signature (Rhys)", () => {
  it("a second primary on the same revision is refused (23505 already_signed), by anyone, the first signer included", async () => {
    const id = await finishedJob();
    expect((await sign(as.workshop, id)).error).toBeNull();
    for (const role of ["workshop", "office", "admin"]) {
      const again = await sign(as[role], id, { p_kind: role === "admin" ? "primary" : null });
      expect({ code: again.error?.code, hint: again.error?.hint, message: again.error?.message }, role)
        .toEqual({ code: "23505", hint: "already_signed", message: expect.stringMatching(/^Revision 0 of J-SO-.* is already signed off\. Edit the worksheet to make a new revision, or add a co-signature\.$/) });
    }
    expect((await signoffs(id)).map((r) => [r.kind, r.signed_by])).toEqual([["primary", world.tenants.alpha.users.workshop.id]]);
  });

  it("a co-signature before the primary is refused (22023 needs_primary)", async () => {
    const id = await finishedJob();
    const early = await sign(as.office, id, { p_kind: "inspector" });
    expect({ code: early.error?.code, hint: early.error?.hint, message: early.error?.message })
      .toEqual({ code: "22023", hint: "needs_primary", message: expect.stringMatching(/^Revision 0 of J-SO-.* has no sign-off yet: the operator signs first, then the inspector co-signs\.$/) });
    expect(await signoffs(id)).toEqual([]);
  });

  it("the primary signer can't co-sign their own revision (22023 same_signer); an unknown role is refused", async () => {
    const id = await finishedJob();
    expect((await sign(as.workshop, id)).error).toBeNull();
    const self = await sign(as.workshop, id, { p_kind: "inspector", p_initials: "zz", p_signer_name: "Another Name" });
    expect({ code: self.error?.code, hint: self.error?.hint, message: self.error?.message })
      .toEqual({ code: "22023", hint: "same_signer", message: expect.stringMatching(/^You signed revision 0 of J-SO-.* yourself: a co-signature is from someone else\.$/) });
    for (const kind of ["supervisor", "Primary", "", "inspector "]) {
      expect((await sign(as.office, id, { p_kind: kind })).error, kind).toMatchObject({ code: "22023" });
    }
    expect(await signoffs(id)).toHaveLength(1);
  });

  it("one co-signature per role per revision; a viewer can't co-sign", async () => {
    const id = await finishedJob();
    expect((await sign(as.workshop, id)).error).toBeNull();
    expect((await sign(as.viewer, id, { p_kind: "inspector" })).error).toMatchObject({ code: "42501" });
    expect((await sign(as.office, id, { p_kind: "inspector" })).error).toBeNull();
    for (const role of ["office", "admin"]) {
      const again = await sign(as[role], id, { p_kind: "inspector" });
      expect({ code: again.error?.code, hint: again.error?.hint, message: again.error?.message }, role)
        .toEqual({ code: "23505", hint: "already_signed", message: expect.stringMatching(/^Revision 0 of J-SO-.* already has an inspector co-signature\.$/) });
    }
    expect((await signoffs(id)).map((r) => [r.kind, r.signed_by])).toEqual([["primary", world.tenants.alpha.users.workshop.id], ["inspector", world.tenants.alpha.users.office.id]]);
    // The unique rule holds below the function too (definer code or the database owner can't add a second primary).
    const [primary] = await signoffs(id);
    await expect(withDb((db) => db.query(
      "insert into public.job_signoffs (organization_id, job_id, worksheet_version, snapshot, snapshot_sha256, record_sha256, initials, signer_name, signed_on, signature_kind, signature_data, signed_by, kind) select organization_id, job_id, worksheet_version, snapshot, snapshot_sha256, record_sha256, 'ZZ', signer_name, signed_on, signature_kind, signature_data, signed_by, kind from public.job_signoffs where id = $1",
      [primary.id]))).rejects.toThrow(/job_signoffs_one_per_kind/);
  });

  it("the inspector co-signature is from an admin or a member an admin made an inspector (42501 not_inspector otherwise)", async () => {
    const id = await finishedJob();
    expect((await sign(as.office, id)).error).toBeNull();
    const member = () => adminClient().from("organization_members").update({ can_inspect: false }).eq("organization_id", world.tenants.alpha.id).eq("user_id", world.tenants.alpha.users.workshop.id);
    expect((await member()).error).toBeNull();
    try {
      const refused = await sign(as.workshop, id, { p_kind: "inspector" });
      expect({ code: refused.error?.code, hint: refused.error?.hint }).toEqual({ code: "42501", hint: "not_inspector" });
    } finally {
      await allowInspectors(world);
    }
    expect((await sign(as.admin, id, { p_kind: "inspector" })).error).toBeNull();
    expect((await signoffs(id)).map((r) => r.kind)).toEqual(["primary", "inspector"]);
  });

  it("a new revision takes a new primary and its own co-signature; the old revision's records stay as they were and stay append-only", async () => {
    const id = await finishedJob({ drawing_no: "DWG-A" });
    expect((await sign(as.workshop, id)).error).toBeNull();
    expect((await sign(as.office, id, { p_kind: "inspector" })).error).toBeNull();
    const before = await signoffs(id);
    expect((await as.office.from("jobs").update({ drawing_no: "DWG-B" }).eq("id", id).select("worksheet_version").single()).data?.worksheet_version).toBe(1);
    expect((await sign(as.office, id, { p_kind: "inspector" })).error).toMatchObject({ code: "22023", hint: "needs_primary" });
    expect((await sign(as.office, id)).error).toBeNull();
    expect((await sign(as.workshop, id, { p_kind: "inspector" })).error).toBeNull();
    const rows = await signoffs(id);
    expect(rows.map((r) => [r.worksheet_version, r.kind, r.signed_by])).toEqual([
      [0, "primary", world.tenants.alpha.users.workshop.id], [0, "inspector", world.tenants.alpha.users.office.id],
      [1, "primary", world.tenants.alpha.users.office.id], [1, "inspector", world.tenants.alpha.users.workshop.id]]);
    expect(rows.slice(0, 2)).toEqual(before);
    for (const row of rows) {
      expect(await verifySignOff(row)).toBe(true);
      expect(await verifySignOff({ ...row, kind: row.kind === "primary" ? "inspector" : "primary" })).toBe(false);
    }
    await expect(withDb((db) => db.query("update public.job_signoffs set kind = 'primary' where id = $1", [rows[1].id]))).rejects.toThrow(/never changed or removed/);
    await expect(withDb((db) => db.query("delete from public.job_signoffs where id = $1", [rows[3].id]))).rejects.toThrow(/never changed or removed/);
    expect((await adminClient().from("job_signoffs").update({ kind: "inspector" }).eq("id", rows[2].id)).error).toMatchObject({ code: "42501" });
    expect(await signoffs(id)).toEqual(rows);
  });
});

describe("records are permanent and audited", () => {
  it("no update or delete, not even by the service role or the database owner", async () => {
    const id = await finishedJob();
    expect((await sign(as.admin, id)).error).toBeNull();
    const [row] = await signoffs(id);
    expect((await adminClient().from("job_signoffs").update({ initials: "ZZ" }).eq("id", row.id)).error).toMatchObject({ code: "42501" });
    expect((await adminClient().from("job_signoffs").delete().eq("id", row.id)).error).toMatchObject({ code: "42501" });
    for (const sql of ["update public.job_signoffs set signer_name = 'Forged' where id = $1", "delete from public.job_signoffs where id = $1"]) {
      await expect(withDb((db) => db.query(sql, [row.id]))).rejects.toThrow(/never changed or removed/);
    }
    await expect(withDb((db) => db.query("truncate public.job_signoffs"))).rejects.toThrow(/never changed or removed/);
    // A job with a sign-off can't be deleted (jobs are archived, never deleted).
    expect((await adminClient().from("jobs").delete().eq("id", id)).error).not.toBeNull();
    expect(await signoffs(id)).toEqual([row]);
  });

  it("carries the support read-only and admin MFA statement triggers like every company table (036, 037)", async () => {
    const triggers = await withDb(async (db) => (await db.query<{ tgname: string }>("select tgname from pg_trigger where tgrelid = 'public.job_signoffs'::regclass and not tgisinternal order by 1")).rows.map((r) => r.tgname));
    // 083 adds zz_inspection_pass_authorised: only someone on the authorised inspectors list adds the inspector co-signature.
    expect(triggers).toEqual(["admin_mfa", "audit_job_signoffs_changes", "job_signoffs_immutable", "job_signoffs_no_truncate", "support_read_only", "zz_inspection_pass_authorised", "zz_same_org_job_id"]);
  });

  it("writes JOB_SIGN_OFF with the job number, revision and snapshot hash, and the row change", async () => {
    const id = await finishedJob();
    const done = await sign(as.office, id);
    expect(done.error).toBeNull();
    const audit = await withDb(async (db) => (await db.query("select action, actor_user_id, metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'JOB_SIGN_OFF'", [id])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: world.tenants.alpha.users.office.id, metadata: { source: "write_audit", signoff_id: done.data.id, worksheet_version: 0, snapshot_sha256: done.data.snapshot_sha256, job_no: expect.stringContaining("J-SO-") } });
    const rowChange = await withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where entity_table = 'job_signoffs' and entity_id = $1", [done.data.id])).rows[0].n);
    expect(rowChange).toBe(1);
  });
});

describe("the SQL and TypeScript canonical hashes are identical", () => {
  it.each(Object.entries(CANONICAL_FIXTURES))("%s", async (_name, value) => {
    const sql = await withDb(async (db) => (await db.query<{ text: string; sha: string }>(
      "select public.canonical_jsonb($1::jsonb) as text, encode(extensions.digest(convert_to(public.canonical_jsonb($1::jsonb), 'UTF8'), 'sha256'), 'hex') as sha", [JSON.stringify(value)])).rows[0]);
    expect(sql.text).toBe(canonicalJson(value));
    expect(sql.sha).toBe(await sha256Hex(canonicalJson(value)));
  });

  it("the helper is not exposed: neither anon nor authenticated (nor the public) can execute it; sign_off_job (definer) still works", async () => {
    const r = (await withDb((db) => db.query<{ anon: boolean; authenticated: boolean }>(
      "select has_function_privilege('anon', 'public.canonical_jsonb(jsonb)', 'execute') as anon, has_function_privilege('authenticated', 'public.canonical_jsonb(jsonb)', 'execute') as authenticated"))).rows[0];
    expect(r).toEqual({ anon: false, authenticated: false });
    expect((await as.workshop.rpc("canonical_jsonb", { p_value: { a: "b" } })).error).toMatchObject({ code: "42501" });
  });

  it("SQL refuses numbers as TypeScript does", async () => {
    await expect(withDb((db) => db.query("select public.canonical_jsonb('{\"a\": 1}'::jsonb)"))).rejects.toThrow(/numbers as text/);
    expect(() => canonicalJson({ a: 1 })).toThrow();
  });

  it("a stored sign-off verifies in TypeScript: the snapshot hash and the record hash, with awkward text in the worksheet", async () => {
    const id = await finishedJob({ description: "Bush \"Ø25\" \\ back\tslash\nline 2 \u0001 😀 café", improvement_comments: "", material_ordered: true, checklist: { parts_marked: true, odd: 3 } });
    const done = await sign(as.workshop, id, { p_signer_name: "Zoë O'Brien", p_initials: "zo", p_signature_kind: "typed", p_signature_data: "Zoë O'Brien" });
    expect(done.error).toBeNull();
    const [row] = await signoffs(id);
    expect(row.snapshot).toMatchObject({ material_ordered: true, improvement_comments: "", checklist: { parts_marked: true, odd: "3" } });
    expect(await sha256Hex(canonicalJson(row.snapshot))).toBe(row.snapshot_sha256);
    expect(await recordSha256(row)).toBe(row.record_sha256);
    expect(await verifySignOff(row)).toBe(true);
    expect(await verifySignOff({ ...row, snapshot: { ...row.snapshot, description: "edited" } })).toBe(false);
    expect(await verifySignOff({ ...row, signature_data: "Someone Else" })).toBe(false);
  });
});

describe("bound to one frozen revision: version and snapshot hash, checked under the job row lock", () => {
  it("job_signoff_revision gives the current revision and the hash sign_off_job stores; a right version with a wrong hash is refused (stale_revision)", async () => {
    const id = await finishedJob({ drawing_no: "DWG-R" });
    const seen = await as.workshop.rpc("job_signoff_revision", { p_job_id: id });
    expect(seen.error).toBeNull();
    expect(seen.data).toEqual({ job_id: id, worksheet_version: 0, snapshot_sha256: (await revision(id)).sha });
    const wrong = await sign(as.workshop, id, { p_expected_snapshot_sha256: "0".repeat(64) });
    expect({ code: wrong.error?.code, hint: wrong.error?.hint }).toEqual({ code: "22023", hint: "stale_revision" });
    const done = await sign(as.workshop, id, { p_expected_snapshot_sha256: seen.data.snapshot_sha256.toUpperCase() });
    expect(done.error).toBeNull();
    expect(done.data.snapshot_sha256).toBe(seen.data.snapshot_sha256);
  });

  it("race: a worksheet edit committed between load and sign is refused as stale; the signer waited on the row lock and nothing was stored", async () => {
    const id = await finishedJob({ drawing_no: "DWG-1" });
    const loaded = await revision(id);
    await withDb(async (editor) => {
      await editor.query("begin");
      await editor.query("update public.jobs set drawing_no = 'DWG-2' where id = $1", [id]);
      // The signer sends what it loaded while the edit holds the row: it must wait for the lock, not sign the old revision.
      let settled = false;
      const pending = as.workshop.rpc("sign_off_job", { p_job_id: id, p_expected_version: loaded.v, p_expected_snapshot_sha256: loaded.sha, p_initials: "ab", p_signer_name: "Alex Brown", p_signed_on: "2026-10-12", p_signature_kind: "drawn", p_signature_data: PATH })
        .then((r) => { settled = true; return r; });
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waiting = (await withDb((db) => db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%sign_off_job%'"))).rows[0].n > 0;
      }
      expect(waiting, "sign_off_job waits on the job row lock").toBe(true);
      expect(settled).toBe(false);
      await editor.query("commit");
      const result = await pending;
      expect({ code: result.error?.code, hint: result.error?.hint }).toEqual({ code: "22023", hint: "stale_revision" });
    });
    expect(await signoffs(id)).toEqual([]);
    const now = await revision(id);
    expect(now.v).toBe(1);
    expect((await sign(as.workshop, id)).error).toBeNull();
    expect((await signoffs(id)).map((r) => [r.worksheet_version, r.snapshot_sha256])).toEqual([[1, now.sha]]);
  });

  it("race the other way: a sign-off holding the row first is stored on the old revision; the edit then makes a new revision (edited since)", async () => {
    const id = await finishedJob({ drawing_no: "DWG-1" });
    const loaded = await revision(id);
    await withDb(async (signer) => {
      const token = (await as.workshop.auth.getSession()).data.session!.access_token;
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub: string; session_id: string; aal?: string };
      await signer.query("begin");
      await signer.query("set local role authenticated");
      await signer.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.sub, role: "authenticated", aud: "authenticated", session_id: claims.session_id, aal: claims.aal ?? "aal1" })]);
      await signer.query("select public.sign_off_job($1, $2, $3, 'AB', 'Alex Brown', '2026-10-12', 'drawn', $4)", [id, loaded.v, loaded.sha, PATH]);
      const edit = as.office.from("jobs").update({ drawing_no: "DWG-2" }).eq("id", id).select("worksheet_version").single();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await signer.query("commit");
      expect((await edit).data?.worksheet_version).toBe(1);
    });
    const rows = await signoffs(id);
    expect(rows.map((r) => [r.worksheet_version, r.snapshot_sha256, r.snapshot.drawing_no])).toEqual([[0, loaded.sha, "DWG-1"]]);
  });

  it("primary and co-signature sign the same snapshot: the co-signature carries the primary's hash, and a snapshot changed under the same version is refused", async () => {
    const id = await finishedJob({ drawing_no: "DWG-C" });
    expect((await sign(as.workshop, id)).error).toBeNull();
    const [primary] = await signoffs(id);
    expect((await sign(as.office, id, { p_kind: "inspector", p_expected_snapshot_sha256: "f".repeat(64) })).error).toMatchObject({ code: "22023", hint: "stale_revision" });
    // A worksheet change that did not raise the version (only the database owner can do this, with triggers off): the co-signature for
    // "revision 0" would no longer be over what the primary signed, so it is refused although the version still matches.
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query("update public.jobs set drawing_no = 'DWG-C2' where id = $1", [id]);
      await db.query("commit");
    });
    expect((await revision(id)).v).toBe(0);
    const cosign = await sign(as.office, id, { p_kind: "inspector", p_expected_snapshot_sha256: primary.snapshot_sha256 });
    expect({ code: cosign.error?.code, hint: cosign.error?.hint }).toEqual({ code: "22023", hint: "stale_revision" });
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query("update public.jobs set drawing_no = 'DWG-C' where id = $1", [id]);
      await db.query("commit");
    });
    const ok = await sign(as.office, id, { p_kind: "inspector", p_expected_snapshot_sha256: primary.snapshot_sha256 });
    expect(ok.error).toBeNull();
    expect(new Set((await signoffs(id)).map((r) => `${r.worksheet_version}:${r.snapshot_sha256}`))).toEqual(new Set([`0:${primary.snapshot_sha256}`]));
  });
});

describe("offline upload: the client key makes a retry return the first record", () => {
  it("a lost answer and a retry (same key, same content) return the original record and add nothing; the audit row is written once", async () => {
    const id = await finishedJob();
    const key = randomUUID();
    const first = await sign(as.workshop, id, { p_client_op_id: key });
    expect(first.error).toBeNull();
    expect(first.data.replayed).toBe(false);
    const again = await sign(as.workshop, id, { p_client_op_id: key, p_initials: " AB " });
    expect(again.error).toBeNull();
    expect(again.data).toEqual({ ...first.data, replayed: true });
    expect(await signoffs(id)).toHaveLength(1);
    const audits = await withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where entity_id = $1 and action = 'JOB_SIGN_OFF'", [id])).rows[0].n);
    expect(audits).toBe(1);
  });

  it("the retry still returns the original after the worksheet changed (the upload's answer was lost, then someone edited)", async () => {
    const id = await finishedJob({ drawing_no: "DWG-A" });
    const key = randomUUID();
    const loaded = await revision(id);
    expect((await sign(as.workshop, id, { p_client_op_id: key })).error).toBeNull();
    expect((await as.office.from("jobs").update({ drawing_no: "DWG-B" }).eq("id", id)).error).toBeNull();
    const again = await sign(as.workshop, id, { p_client_op_id: key, p_expected_version: loaded.v, p_expected_snapshot_sha256: loaded.sha });
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ worksheet_version: 0, snapshot_sha256: loaded.sha, replayed: true });
    expect(await signoffs(id)).toHaveLength(1);
  });

  it("two retries racing with one key make one record and both get it", async () => {
    const id = await finishedJob();
    const key = randomUUID();
    const [a, b] = await Promise.all([sign(as.workshop, id, { p_client_op_id: key }), sign(as.workshop, id, { p_client_op_id: key })]);
    expect([a.error, b.error]).toEqual([null, null]);
    expect(a.data.id).toBe(b.data.id);
    expect([a.data.replayed, b.data.replayed].sort()).toEqual([false, true]);
    expect(await signoffs(id)).toHaveLength(1);
  });

  it("a reused key with changed content, on another job, by another signer or for another role is refused (client_op_reused); nothing is added", async () => {
    const id = await finishedJob();
    const other = await finishedJob();
    const key = randomUUID();
    expect((await sign(as.workshop, id, { p_client_op_id: key })).error).toBeNull();
    for (const [client, target, extra] of [
      [as.workshop, id, { p_initials: "zz" }], [as.workshop, id, { p_signature_data: "M1 1L2 2" }], [as.workshop, id, { p_signed_on: "2026-10-11" }],
      [as.workshop, other, {}], [as.office, id, {}], [as.office, id, { p_kind: "inspector" }],
    ] as [SupabaseClient, string, Record<string, unknown>][]) {
      const reused = await sign(client, target, { p_client_op_id: key, ...extra });
      expect({ code: reused.error?.code, hint: reused.error?.hint }, JSON.stringify(extra)).toEqual({ code: "22023", hint: "client_op_reused" });
    }
    expect(await signoffs(id)).toHaveLength(1);
    expect(await signoffs(other)).toEqual([]);
  });

  it("a queued inspector co-signature is checked again on upload: before the primary (needs_primary), by the primary signer (same_signer), against a revision that changed (stale_revision, never re-bound)", async () => {
    const id = await finishedJob({ drawing_no: "DWG-A" });
    const captured = await revision(id);
    const upload = (client: SupabaseClient, extra: Record<string, unknown> = {}) => client.rpc("sign_off_job", {
      p_job_id: id, p_expected_version: captured.v, p_expected_snapshot_sha256: captured.sha, p_initials: "IN", p_signer_name: "Ina Spector", p_signed_on: "2026-10-12",
      p_signature_kind: "typed", p_signature_data: "Ina Spector", p_kind: "inspector", p_client_op_id: randomUUID(), ...extra });
    expect((await upload(as.office)).error).toMatchObject({ code: "22023", hint: "needs_primary" });
    expect((await sign(as.workshop, id)).error).toBeNull();
    expect((await upload(as.workshop)).error).toMatchObject({ code: "22023", hint: "same_signer" });
    expect((await as.office.from("jobs").update({ drawing_no: "DWG-B" }).eq("id", id)).error).toBeNull();
    expect((await upload(as.office)).error).toMatchObject({ code: "22023", hint: "stale_revision" });
    expect((await signoffs(id)).map((r) => [r.worksheet_version, r.kind])).toEqual([[0, "primary"]]);
  });
});

describe("company isolation and who may execute", () => {
  it("another company: no reads of signatures, history or print rows; no revision; no direct insert; its own key never returns this company's record", async () => {
    const id = await finishedJob();
    const key = randomUUID();
    expect((await sign(as.workshop, id, { p_client_op_id: key })).error).toBeNull();
    const jobNo = (await adminClient().from("jobs").select("job_no").eq("id", id).single()).data!.job_no as string;
    // Reads: by job (history), across the table, and the print path (jobs by number, then their sign-offs).
    expect((await as.betaAdmin.from("job_signoffs").select("id").eq("job_id", id)).data).toEqual([]);
    expect(((await as.betaAdmin.from("job_signoffs").select("organization_id")).data ?? []).every((r) => r.organization_id === world.tenants.beta.id)).toBe(true);
    expect((await as.betaAdmin.from("jobs").select("id").eq("job_no", jobNo)).data).toEqual([]);
    expect((await as.betaAdmin.rpc("job_signoff_revision", { p_job_id: id })).error).toMatchObject({ code: "P0002" });
    // Inserts: through the API, for either company.
    const row = (await signoffs(id))[0];
    for (const org of [world.tenants.alpha.id, world.tenants.beta.id]) {
      const forged = await as.betaAdmin.from("job_signoffs").insert({ ...row, id: randomUUID(), organization_id: org, kind: "inspector", client_op_id: randomUUID() });
      expect(forged.error, org).toMatchObject({ code: "42501" });
    }
    // The same key in another company is that company's key: against alpha's job it is not found, against its own job a new record.
    const betaJob = await finishedJob({}, world.tenants.beta.id);
    expect((await sign(as.betaAdmin, id, { p_client_op_id: key })).error).toMatchObject({ code: "P0002" });
    const own = await sign(as.betaAdmin, betaJob, { p_client_op_id: key });
    expect(own.error).toBeNull();
    expect(own.data.replayed).toBe(false);
    expect(own.data.id).not.toBe(row.id);
    expect(await signoffs(id)).toEqual([row]);
  });

  it("a viewer can read but not sign, co-sign, insert or ask for nothing else", async () => {
    const id = await finishedJob();
    expect((await sign(as.viewer, id)).error).toMatchObject({ code: "42501" });
    expect((await sign(as.admin, id)).error).toBeNull();
    expect((await sign(as.viewer, id, { p_kind: "inspector", p_client_op_id: randomUUID() })).error).toMatchObject({ code: "42501" });
    const row = (await signoffs(id))[0];
    expect((await as.viewer.from("job_signoffs").insert({ ...row, id: randomUUID(), kind: "inspector" })).error).toMatchObject({ code: "42501" });
    expect((await as.viewer.rpc("job_signoff_revision", { p_job_id: id })).error).toBeNull();
    expect((await as.viewer.from("job_signoffs").select("id").eq("job_id", id)).data).toHaveLength(1);
  });

  it("EXECUTE: sign_off_job and job_signoff_revision for authenticated only (not anon, not PUBLIC); the helpers for no API role; anon and the service role are refused", async () => {
    const grants = (await withDb((db) => db.query<{ fn: string; anon: boolean; authenticated: boolean; public_: boolean }>(
      `select p.oid::regprocedure::text as fn, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              coalesce(exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), p.proacl is null) as public_
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('sign_off_job', 'job_signoff_revision', 'job_signoff_snapshot', 'canonical_jsonb') order by 1`))).rows;
    expect(grants).toEqual([
      { fn: "canonical_jsonb(jsonb)", anon: false, authenticated: false, public_: false },
      { fn: "job_signoff_revision(uuid)", anon: false, authenticated: true, public_: false },
      { fn: "job_signoff_snapshot(jobs)", anon: false, authenticated: false, public_: false },
      { fn: "sign_off_job(uuid,integer,text,text,text,date,text,text,text,uuid)", anon: false, authenticated: true, public_: false },
    ]);
    const id = await finishedJob();
    const current = await revision(id);
    const args = { p_job_id: id, p_expected_version: current.v, p_expected_snapshot_sha256: current.sha, p_initials: "AN", p_signer_name: "Anon", p_signed_on: "2026-10-12", p_signature_kind: "typed", p_signature_data: "Anon" };
    const { apiUrl, anonKey } = isolatedBackend();
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await anon.rpc("sign_off_job", args)).error).toMatchObject({ code: "42501" });
    expect((await anon.rpc("job_signoff_revision", { p_job_id: id })).error).toMatchObject({ code: "42501" });
    expect((await anon.from("job_signoffs").select("id")).error ?? { code: "none" }).toMatchObject({ code: "42501" });
    expect((await adminClient().rpc("sign_off_job", args)).error).toMatchObject({ code: "42501" });
    expect((await as.workshop.rpc("job_signoff_snapshot", { p_job: {} })).error).not.toBeNull();
    expect(await signoffs(id)).toEqual([]);
  });

  it("signature images are inline in the immutable row, never in Storage: no bucket or storage policy for signatures exists", async () => {
    const storage = (await withDb((db) => db.query<{ n: number }>(
      "select (select count(*) from storage.buckets where id ilike '%sign%' or name ilike '%sign%')::int + (select count(*) from pg_policies where schemaname = 'storage' and (policyname ilike '%sign%' or coalesce(qual, '') ilike '%signoff%' or coalesce(with_check, '') ilike '%signoff%'))::int as n"))).rows[0].n;
    expect(storage).toBe(0);
    const column = (await withDb((db) => db.query("select data_type from information_schema.columns where table_schema = 'public' and table_name = 'job_signoffs' and column_name = 'signature_data'"))).rows[0];
    expect(column).toEqual({ data_type: "text" });
  });
});

describe("supabase/verify/job_signoff.sql (the read-only post-deploy check)", () => {
  it("rows 1 to 14 are true and row 15 counts the sign-offs, in a read-only transaction", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/job_signoff.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin transaction read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("commit");
      }
    });
    expect(rows.map((r) => r.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(rows.filter((r) => r.expected === "true" && r.value !== "true").map((r) => `${r.n} ${r.check_name}`)).toEqual([]);
    expect(Number(rows[14].value)).toBeGreaterThan(0);
  });
});
