/**
 * Customer sign-off (migration 072). sign_off_job_customer records a customer's signature on a job, captured by a member of the job's
 * company (admin, office, workshop; never a viewer), only while the company's setting is on. The row is a job_signoffs row of kind
 * 'customer': immutable like every sign-off, readable by the company only, bound to the revision current at upload (and keeping the one
 * the phone showed). A client key makes the offline upload happen once; one customer sign-off per revision.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUSTOMER_SIGNOFF_STATEMENT, customerInitials, recordSha256, verifySignOff, type JobSignOff } from "@/lib/job-signoff";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let counter = 0;
const PATH = "M10 10L60 40L120 20L200 80";
/** The phone's time: an hour ago (072 accepts 30 days before to 1 day after the upload), with milliseconds. */
const AT = new Date(Math.floor((Date.now() - 3_600_000) / 1000) * 1000 + 123).toISOString();
const londonDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const shift = (ms: number) => new Date(Date.now() + ms).toISOString();
const DAY = 86_400_000;

const alpha = () => world.tenants.alpha.id;
const setting = (org: string, on: boolean) => withDb((db) => db.query(
  "insert into public.organization_settings (organization_id, customer_signoff_enabled) values ($1, $2) on conflict (organization_id) do update set customer_signoff_enabled = excluded.customer_signoff_enabled", [org, on]));

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  await setting(alpha(), true);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

async function job(extra: Record<string, unknown> = {}, org = alpha()) {
  const { data, error } = await adminClient().from("jobs")
    .insert({ organization_id: org, job_no: `J-CS-${world.runId}-${++counter}`, customer: "Site Co", stage: "in_progress", started_at: "2026-10-01T08:00:00Z", quantity_required: 1, ...extra })
    .select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const rows = async (id: string) => ((await adminClient().from("job_signoffs").select("*").eq("job_id", id).order("created_at")).data ?? []) as JobSignOff[];
const revision = async (id: string) => (await withDb((db) => db.query<{ v: number; sha: string }>(
  "select j.worksheet_version as v, encode(extensions.digest(convert_to(public.canonical_jsonb(public.job_signoff_snapshot(j)), 'UTF8'), 'sha256'), 'hex') as sha from public.jobs j where j.id = $1", [id]))).rows[0];
const capture = (client: SupabaseClient, id: string, extra: Record<string, unknown> = {}) => client.rpc("sign_off_job_customer", {
  p_job_id: id, p_signer_name: "Jane Smith", p_signer_position: "Site Manager", p_signer_company: null, p_statement: CUSTOMER_SIGNOFF_STATEMENT, p_comment: null,
  p_signature_kind: "drawn", p_signature_data: PATH, p_device_signed_at: AT, p_client_op_id: randomUUID(), p_shown_version: null, p_shown_snapshot_sha256: null, ...extra,
});

describe("who can capture it", () => {
  it("workshop (the fitter) captures it on a job of their company; the row keeps the customer, the statement, both times and the fitter; the hash verifies", async () => {
    const id = await job();
    const shown = await revision(id);
    const done = await capture(as.workshop, id, { p_signer_company: " Acme Ltd ", p_comment: "Tidy job.\nThanks", p_shown_version: shown.v, p_shown_snapshot_sha256: shown.sha });
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ worksheet_version: 0, kind: "customer", replayed: false, record_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const [row] = await rows(id);
    expect(row).toMatchObject({
      kind: "customer", signed_by: world.tenants.alpha.users.workshop.id, signer_name: "Jane Smith", signer_position: "Site Manager", signer_company: "Acme Ltd",
      statement: CUSTOMER_SIGNOFF_STATEMENT, customer_comment: "Tidy job.\nThanks", initials: "JS", signed_on: londonDate(AT), signature_kind: "drawn", signature_data: PATH,
      worksheet_version: 0, shown_worksheet_version: 0, shown_snapshot_sha256: shown.sha, snapshot_sha256: shown.sha,
    });
    expect(new Date(row.device_signed_at!).toISOString()).toBe(AT);
    expect(await verifySignOff(row)).toBe(true);
    expect(await recordSha256(row)).toBe(done.data.record_sha256);
    // Capturing changes nothing on the job.
    expect((await adminClient().from("jobs").select("worksheet_version").eq("id", id).single()).data?.worksheet_version).toBe(0);
  });

  it("admin and office capture too; a viewer is refused but reads it; nobody writes, changes or removes rows directly", async () => {
    for (const role of ["admin", "office"]) expect((await capture(as[role], await job())).error, role).toBeNull();
    const id = await job();
    expect((await capture(as.viewer, id)).error).toMatchObject({ code: "42501" });
    expect((await capture(as.workshop, id)).error).toBeNull();
    expect((await as.viewer.from("job_signoffs").select("id, kind").eq("job_id", id)).data).toEqual([expect.objectContaining({ kind: "customer" })]);
    const [row] = await rows(id);
    const forged = await as.admin.from("job_signoffs").insert({ ...row, id: randomUUID(), client_op_id: randomUUID(), worksheet_version: 9 });
    expect(forged.error).toMatchObject({ code: "42501" });
    for (const role of ["admin", "office", "workshop"]) {
      await as[role].from("job_signoffs").update({ signer_name: "Forged" }).eq("id", row.id);
      await as[role].from("job_signoffs").delete().eq("id", row.id);
    }
    expect((await adminClient().from("job_signoffs").update({ signer_name: "Forged" }).eq("id", row.id)).error).toMatchObject({ code: "42501" });
    for (const sql of ["update public.job_signoffs set customer_comment = 'Forged' where id = $1", "delete from public.job_signoffs where id = $1"]) {
      await expect(withDb((db) => db.query(sql, [row.id]))).rejects.toThrow(/never changed or removed/);
    }
    expect(await rows(id)).toEqual([row]);
  });

  it("another company can neither capture on the job nor see it, even with its own setting on", async () => {
    const id = await job();
    expect((await capture(as.workshop, id)).error).toBeNull();
    await setting(world.tenants.beta.id, true);
    expect((await capture(as.betaAdmin, id)).error).toMatchObject({ code: "P0002" });
    expect((await as.betaAdmin.from("job_signoffs").select("id").eq("job_id", id)).data).toEqual([]);
    expect(await rows(id)).toHaveLength(1);
    await setting(world.tenants.beta.id, false);
  });
});

describe("the company setting", () => {
  it("is off by default: a capture is refused (customer_signoff_off) and nothing is recorded", async () => {
    const solo = await job({}, world.tenants.beta.id);
    expect((await adminClient().from("organization_settings").select("customer_signoff_enabled").eq("organization_id", world.tenants.beta.id).maybeSingle()).data?.customer_signoff_enabled ?? false).toBe(false);
    expect((await capture(as.betaAdmin, solo)).error).toMatchObject({ code: "42501", hint: "customer_signoff_off" });
    expect(await rows(solo)).toEqual([]);
  });

  it("only an admin changes it: through set_customer_signoff_enabled (audited); office, workshop and viewer refused, directly too", async () => {
    for (const role of ["office", "workshop", "viewer"]) {
      expect((await as[role].rpc("set_customer_signoff_enabled", { p_on: false })).error, role).toMatchObject({ code: "42501" });
    }
    const direct = await as.office.from("organization_settings").upsert({ organization_id: alpha(), customer_signoff_enabled: false }, { onConflict: "organization_id" });
    expect(direct.error).not.toBeNull();
    const read = async () => (await adminClient().from("organization_settings").select("customer_signoff_enabled").eq("organization_id", alpha()).maybeSingle()).data?.customer_signoff_enabled;
    expect(await read()).toBe(true);
    expect((await as.admin.rpc("set_customer_signoff_enabled", { p_on: false })).data).toBe(false);
    expect(await read()).toBe(false);
    expect((await capture(as.workshop, await job())).error).toMatchObject({ hint: "customer_signoff_off" });
    expect((await as.admin.rpc("set_customer_signoff_enabled", { p_on: true })).data).toBe(true);
    const events = await withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where organization_id = $1 and entity_table = 'organization_settings' and metadata ? 'customer_signoff_enabled' order by created_at", [alpha()])).rows);
    expect(events.map((e) => e.metadata.customer_signoff_enabled)).toEqual([false, true]);
  });
});

describe("what is recorded", () => {
  it("needs neither a finished job nor the operator's sign-off; refuses bad input (22023) and records nothing", async () => {
    const id = await job({ finished_at: null });
    for (const bad of [{ p_signer_name: " " }, { p_signer_name: "me@example.test" }, { p_signer_position: "x".repeat(121) }, { p_signer_company: "x".repeat(201) },
      { p_statement: " " }, { p_comment: "x".repeat(1001) }, { p_comment: "bell\u0007" }, { p_signature_kind: "stamp" }, { p_signature_data: "M1 1<script>" },
      { p_signature_data: "data:image/png;base64,AAAA" }, { p_signature_kind: "typed", p_signature_data: " " }, { p_device_signed_at: null }, { p_client_op_id: null },
      { p_shown_version: -1 }, { p_shown_snapshot_sha256: "abc" }]) {
      expect((await capture(as.workshop, id, bad)).error, JSON.stringify(bad).slice(0, 60)).toMatchObject({ code: "22023" });
    }
    expect(await rows(id)).toEqual([]);
    expect((await capture(as.workshop, id, { p_signature_kind: "typed", p_signature_data: "  Jane Smith " })).error).toBeNull();
    expect((await rows(id))[0]).toMatchObject({ signature_data: "Jane Smith", signer_position: "Site Manager", signer_company: null, customer_comment: null });
  });

  it("one customer sign-off per revision (already_signed); the worksheet edited meanwhile still records it, bound to the new revision and keeping the one shown", async () => {
    const id = await job({ drawing_no: "DWG-A" });
    const shown = await revision(id);
    expect((await capture(as.workshop, id)).error).toBeNull();
    expect((await capture(as.office, id, { p_signer_name: "Bob Jones" })).error).toMatchObject({ code: "23505", hint: "already_signed" });
    expect((await as.office.from("jobs").update({ drawing_no: "DWG-B" }).eq("id", id)).error).toBeNull();
    const late = await capture(as.workshop, id, { p_signer_name: "Bob Jones", p_shown_version: shown.v, p_shown_snapshot_sha256: shown.sha });
    expect(late.error).toBeNull();
    const [, second] = await rows(id);
    expect(second).toMatchObject({ worksheet_version: 1, shown_worksheet_version: 0, shown_snapshot_sha256: shown.sha, snapshot: expect.objectContaining({ drawing_no: "DWG-B" }) });
    expect(second.snapshot_sha256).not.toBe(shown.sha);
    expect(await verifySignOff(second)).toBe(true);
  });

  it("the phone's time is recorded as given inside its window; the date is never later than today in the UK", async () => {
    const id = await job();
    const ahead = shift(12 * 3_600_000);
    expect((await capture(as.workshop, id, { p_device_signed_at: ahead })).error).toBeNull();
    const today = await withDb(async (db) => (await db.query<{ d: string }>("select to_char((now() at time zone 'Europe/London')::date, 'YYYY-MM-DD') as d")).rows[0].d);
    expect((await rows(id))[0]).toMatchObject({ signed_on: today });
    expect(new Date((await rows(id))[0].device_signed_at!).toISOString()).toBe(ahead);
    const old = await job();
    const early = shift(-29 * DAY);
    expect((await capture(as.workshop, old, { p_device_signed_at: early })).error).toBeNull();
    expect((await rows(old))[0]).toMatchObject({ signed_on: londonDate(early) });
  });

  it("refuses a phone time that is not finite or outside 30 days before to 1 day after the upload (device_time_out_of_range), recording nothing", async () => {
    const id = await job();
    for (const bad of ["infinity", "-infinity", "0100-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "1970-01-01T00:00:00Z", shift(-31 * DAY), shift(2 * DAY)]) {
      expect((await capture(as.workshop, id, { p_device_signed_at: bad })).error, bad).toMatchObject({ code: "22023", hint: "device_time_out_of_range" });
    }
    expect(await rows(id)).toEqual([]);
  });

  it("a replay is answered before the window: a recorded upload retried after its phone time left the window still gets its first answer", async () => {
    const id = await job();
    const key = randomUUID();
    const edge = shift(-30 * DAY + 2000);
    const first = await capture(as.workshop, id, { p_client_op_id: key, p_device_signed_at: edge });
    expect(first.error).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await capture(as.workshop, await job(), { p_device_signed_at: edge })).error).toMatchObject({ hint: "device_time_out_of_range" });
    const again = await capture(as.workshop, id, { p_client_op_id: key, p_device_signed_at: edge });
    expect(again.error).toBeNull();
    expect(again.data).toEqual({ ...first.data, replayed: true });
  });

  it("takes the initials from the printed name exactly as the app does", async () => {
    for (const name of ["Jane Smith", "jean-luc picard", "Zoë O'Brien", "Łukasz Nowak", "李", "a b c d e"]) {
      const id = await job();
      expect((await capture(as.workshop, id, { p_signer_name: name })).error, name).toBeNull();
      expect((await rows(id))[0].initials, name).toBe(customerInitials(name));
    }
  });

  it("is apart from the operator's sign-off: sign_off_job refuses the kind, and a customer row neither blocks nor counts as the primary", async () => {
    const id = await job({ finished_at: "2026-10-02T08:00:00Z" });
    expect((await capture(as.workshop, id)).error).toBeNull();
    const current = await revision(id);
    const sign = (extra: Record<string, unknown>) => as.workshop.rpc("sign_off_job", { p_job_id: id, p_expected_version: current.v, p_expected_snapshot_sha256: current.sha, p_initials: "WS", p_signer_name: "Fitter", p_signed_on: "2026-10-12", p_signature_kind: "typed", p_signature_data: "Fitter", ...extra });
    expect((await sign({ p_kind: "customer" })).error).toMatchObject({ code: "22023" });
    expect((await sign({ p_kind: "inspector" })).error).toMatchObject({ hint: "needs_primary" });
    expect((await sign({})).error).toBeNull();
    expect((await rows(id)).map((r) => r.kind).sort()).toEqual(["customer", "primary"]);
  });

  it("the table refuses a customer row without its statement and an internal row with customer fields", async () => {
    const id = await job();
    expect((await capture(as.workshop, id)).error).toBeNull();
    const [row] = await rows(id);
    const insert = (patch: Record<string, unknown>) => withDb((db) => db.query(
      `insert into public.job_signoffs (organization_id, job_id, worksheet_version, snapshot, snapshot_sha256, record_sha256, initials, signer_name, signed_on, signature_kind, signature_data, signed_by, kind, statement, device_signed_at)
       values ($1, $2, 5, '{}', $3, $3, 'JS', 'Jane', '2026-10-17', 'typed', 'Jane', $4, $5, $6, $7)`,
      [alpha(), id, row.snapshot_sha256, row.signed_by, patch.kind, patch.statement ?? null, patch.device_signed_at ?? null]));
    await expect(insert({ kind: "customer", device_signed_at: AT })).rejects.toThrow(/job_signoffs_customer_shape/);
    await expect(insert({ kind: "primary", statement: "x" })).rejects.toThrow(/job_signoffs_customer_shape/);
    // The phone's time: finite, and within 30 days before to 1 day after created_at (also for the owner and the service role).
    for (const time of ["infinity", "-infinity"]) await expect(insert({ kind: "customer", statement: "x", device_signed_at: time })).rejects.toThrow(/job_signoffs_customer_shape|job_signoffs_device_time_window/);
    for (const time of [shift(-31 * DAY), shift(2 * DAY), "0100-01-01T00:00:00Z"]) await expect(insert({ kind: "customer", statement: "x", device_signed_at: time })).rejects.toThrow(/job_signoffs_device_time_window/);
  });

  it("writes JOB_CUSTOMER_SIGN_OFF with the job number and revisions, and the row change", async () => {
    const id = await job();
    const done = await capture(as.workshop, id, { p_shown_version: 0, p_shown_snapshot_sha256: (await revision(id)).sha });
    const audit = await withDb(async (db) => (await db.query("select actor_user_id, metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'JOB_CUSTOMER_SIGN_OFF'", [id])).rows);
    expect(audit).toEqual([expect.objectContaining({ actor_user_id: world.tenants.alpha.users.workshop.id, metadata: expect.objectContaining({ signoff_id: done.data.id, worksheet_version: 0, shown_worksheet_version: 0, kind: "customer" }) })]);
    expect(await withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where entity_table = 'job_signoffs' and entity_id = $1", [done.data.id])).rows[0].n)).toBe(1);
  });
});

describe("offline upload: once, whatever the order", () => {
  it("a replay (same key, same content) returns the first record and adds nothing, even after an edit and the setting turned off", async () => {
    const id = await job();
    const key = randomUUID();
    const first = await capture(as.workshop, id, { p_client_op_id: key });
    expect(first.error).toBeNull();
    expect((await as.office.from("jobs").update({ drawing_no: "DWG-Z" }).eq("id", id)).error).toBeNull();
    await setting(alpha(), false);
    const again = await capture(as.workshop, id, { p_client_op_id: key, p_signer_name: "  Jane Smith " });
    await setting(alpha(), true);
    expect(again.error).toBeNull();
    expect(again.data).toEqual({ ...first.data, replayed: true });
    expect(await rows(id)).toHaveLength(1);
    expect(await withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where entity_id = $1 and action = 'JOB_CUSTOMER_SIGN_OFF'", [id])).rows[0].n)).toBe(1);
  });

  it("the key reused for other content, another job or another capturer is refused (client_op_reused), never reported as replayed", async () => {
    const id = await job();
    const key = randomUUID();
    expect((await capture(as.workshop, id, { p_client_op_id: key })).error).toBeNull();
    for (const [client, extra] of [[as.workshop, { p_comment: "changed" }], [as.workshop, { p_device_signed_at: shift(-60_000) }], [as.office, {}]] as const) {
      expect((await capture(client, id, { p_client_op_id: key, ...extra })).error).toMatchObject({ code: "22023", hint: "client_op_reused" });
    }
    expect((await capture(as.workshop, await job(), { p_client_op_id: key })).error).toMatchObject({ hint: "client_op_reused" });
    expect(await rows(id)).toHaveLength(1);
  });

  it("two phones' captures for one revision uploaded in either order: the first is recorded, the second refused already_signed", async () => {
    for (const order of [["workshop", "office"], ["office", "workshop"]]) {
      const id = await job();
      const results = [];
      for (const role of order) results.push(await capture(as[role], id, { p_signer_name: `Customer of ${role}` }));
      expect(results[0].error).toBeNull();
      expect(results[1].error).toMatchObject({ code: "23505", hint: "already_signed" });
      expect((await rows(id)).map((r) => r.signer_name)).toEqual([`Customer of ${order[0]}`]);
    }
  });

  it("two uploads of one key racing make one record and both get it", async () => {
    const id = await job();
    const key = randomUUID();
    const [a, b] = await Promise.all([capture(as.workshop, id, { p_client_op_id: key }), capture(as.workshop, id, { p_client_op_id: key })]);
    expect([a.error, b.error]).toEqual([null, null]);
    expect([a.data.replayed, b.data.replayed].sort()).toEqual([false, true]);
    expect(a.data.id).toBe(b.data.id);
    expect(await rows(id)).toHaveLength(1);
  });
});

describe("the anonymous key", () => {
  it("can neither capture nor read", async () => {
    const id = await job();
    expect((await capture(as.workshop, id)).error).toBeNull();
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await capture(anon, id)).error).not.toBeNull();
    expect((await anon.from("job_signoffs").select("id").eq("job_id", id)).data ?? []).toEqual([]);
  });
});
