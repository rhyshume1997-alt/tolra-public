/**
 * Admin two-step sign-in in the DATABASE for the workflow's privileged operations (migration 034 section 6, on top of 033's
 * assert_privileged_aal). With the company's require_admin_mfa on, an admin whose real token is aal1 is refused, calling the RPC or
 * the REST API directly, for every operation that moves money or releases goods: credit notes (create, issue, allocate), refunds
 * and applying customer credit, despatch (create, mark sent, sign) and invoicing from delivery notes, inspections and concessions,
 * drawing revisions and the inspector flag. The same call at aal2 goes through. Real Auth tokens (TOTP enrolled against the local
 * Auth service), not claims set by hand.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, setRequireAdminMfaForTest, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { enrolTotp, passSecondStep } from "../support/totp";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
let aal2: SupabaseClient;
let aal1: SupabaseClient;
let seq = 0;
const org = () => world.tenants.alpha.id;
const TODAY = new Date().toISOString().slice(0, 10);

const ok = <T>(result: { data: T; error: { message: string } | null }, what: string) => {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
};

/** An issued invoice for 12 x £10 = £120, no VAT, made at aal2. */
async function issuedInvoice(customer: string) {
  const id = ok(await aal2.rpc("create_with_lines", {
    p_parent: "invoices", p_header: { customer, subtotal: 120, carriage: 0, vat: 0, total: 120, vat_enabled: false, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: [{ position: 0, description: "Widget", quantity: 12, unit_price: 10, vat_pct: 0, vat_exempt: false }],
  }), "draft invoice") as string;
  ok(await aal2.rpc("issue_invoice", { p_invoice: id }), "issue");
  return id;
}
const lineOf = async (invoice: string) => (await adminClient().from("invoice_line_items").select("id").eq("invoice_id", invoice).single()).data!.id as string;
const draftCredit = async (invoice: string, quantity: number) =>
  ok(await aal2.rpc("create_credit_note", { p_invoice: invoice, p_reason: "Returned", p_credit_date: TODAY, p_lines: [{ invoice_line_id: await lineOf(invoice), quantity }] }), "credit note") as string;
async function issuedCredit(invoice: string, quantity: number) {
  const id = await draftCredit(invoice, quantity);
  ok(await aal2.rpc("issue_credit_note", { p_credit: id }), "issue credit note");
  return id;
}
/** An issued credit note with nothing applied yet: issuing applies the credit at once, so one is made the way an import would, with the service role. */
async function unappliedCredit(invoice: string, quantity: number) {
  const id = await draftCredit(invoice, quantity);
  const { error } = await adminClient().from("credit_notes").update({ status: "issued", credit_ref: `CN-AAL-${world.runId.slice(0, 6)}-${seq}`, issued_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
  return id;
}
/** £120 invoice, £60 paid, £80 credited: £20 of customer credit on it, and a second open invoice for the same customer. */
async function customerCredit() {
  const customer = `Aal Credit ${world.runId} ${seq}`;
  const from = await issuedInvoice(customer);
  ok(await aal2.rpc("record_invoice_payment", { p_invoice: from, p_amount: 60, p_paid_on: TODAY, p_method: "BACS", p_reference: null, p_request_id: randomUUID() }), "payment");
  await issuedCredit(from, 8); // issuing applies all of it: £60 owed settled, £20 left as customer credit
  return { from, to: await issuedInvoice(customer) };
}
/** A sales order (no job) with one line of 10, made with the service role. */
async function order() {
  const { data, error } = await adminClient().from("sales_orders")
    .insert({ organization_id: org(), so_number: `SO-AAL-${world.runId}-${seq}`, customer_po: `PO-AAL-${world.runId}-${seq}`, customer: "Aal Despatch Co", total_value: 100, vat_enabled: false, status: "open" })
    .select("id").single();
  if (error) throw new Error(error.message);
  const lines = ok(await aal2.rpc("despatch_lines", { p_order: data.id, p_job: null }), "lines") as { line_id: string }[];
  return { order: data.id as string, line: lines[0].line_id };
}
const despatch = (client: SupabaseClient, o: { order: string; line: string }, quantity = 1) =>
  client.rpc("create_delivery_note", { p_order: o.order, p_job: null, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: "Own van", p_notes: null, p_lines: [{ line_id: o.line, quantity }] });
async function note(status: "awaiting" | "despatched") {
  const made = ok(await despatch(aal2, await order()), "delivery note") as { id: string };
  if (status === "despatched") expect((await adminClient().from("delivery_notes").update({ status }).eq("id", made.id)).error).toBeNull();
  return made.id;
}
async function finishedJob() {
  const { data, error } = await adminClient().from("jobs")
    .insert({ organization_id: org(), job_no: `J-AAL-${world.runId}-${seq}-${randomUUID().slice(0, 4)}`, customer: "Aal Job Co", stage: "inspection", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", quantity_required: 10 })
    .select("id, worksheet_version").single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, version: data.worksheet_version as number };
}
async function drawing() {
  const job = await finishedJob();
  const { data, error } = await adminClient().from("job_files")
    .insert({ organization_id: org(), job_id: job.id, kind: "drawing", ref: "bracket", file_name: "bracket.png", storage_bucket: "job-drawings", storage_path: `${org()}/${job.id}/1-bracket.png` })
    .select("id").single();
  if (error) throw new Error(error.message);
  return { job: job.id, file: data.id as string };
}
/** A rework on a finished job of 10 (4 failed), made at aal2; started when asked. */
async function rework(started: boolean) {
  const job = await finishedJob();
  const failed = ok(await aal2.rpc("fail_job_inspection", { p_job: job.id, p_notes: "Bore 25.08", p_reason: "Bore oversize", p_quantity: 4, p_instructions: "Re-bore", p_attachment_path: null, p_attachment_name: null }), "fail") as { rework_id: string };
  if (started) ok(await aal2.rpc("start_job_rework", { p_rework: failed.rework_id }), "start");
  return failed.rework_id;
}
/** A rework closed by a concession with 2 scrapped parts never remade (made at aal2), so a replacement rework can be opened for them. */
async function owing() {
  const job = await finishedJob();
  const failed = ok(await aal2.rpc("fail_job_inspection", { p_job: job.id, p_notes: "Bore 25.08", p_reason: "Bore oversize", p_quantity: 4, p_instructions: "Re-bore", p_attachment_path: null, p_attachment_name: null }), "fail") as { rework_id: string };
  ok(await aal2.rpc("scrap_job_quantity", { p_rework: failed.rework_id, p_quantity: 2, p_reason: "Cracked" }), "scrap");
  ok(await inspect(aal2, job, "concession"), "concession");
  return failed.rework_id;
}
const inspect = (client: SupabaseClient, job: { id: string; version: number }, result: "pass" | "fail" | "concession") =>
  recordInspection(client, { p_job: job.id, p_result: result, p_notes: "Bore 25.01 mm", p_attachment_path: null, p_attachment_name: null, p_concession_reason: result === "concession" ? "Accepted by the customer" : null, p_expected_version: job.version });

type Result = { error: { code?: string; hint?: string; message: string } | null };
type Operation = [name: string, setup: () => Promise<Record<string, unknown>>, call: (c: SupabaseClient, f: Record<string, any>) => PromiseLike<Result>]; // eslint-disable-line @typescript-eslint/no-explicit-any

const OPERATIONS: Operation[] = [
  ["create_credit_note", async () => ({ invoice: await issuedInvoice(`Aal CN ${seq}`) }),
    async (c, f) => c.rpc("create_credit_note", { p_invoice: f.invoice, p_reason: "Returned", p_credit_date: TODAY, p_lines: [{ invoice_line_id: await lineOf(f.invoice), quantity: 1 }] })],
  ["issue_credit_note", async () => ({ credit: await draftCredit(await issuedInvoice(`Aal CN ${seq}`), 1) }), (c, f) => c.rpc("issue_credit_note", { p_credit: f.credit })],
  ["allocate_credit_note", async () => ({ credit: await unappliedCredit(await issuedInvoice(`Aal CN ${seq}`), 2) }),
    (c, f) => c.rpc("allocate_credit_note", { p_credit: f.credit, p_amount: 10, p_request_id: randomUUID() })],
  ["refund_customer_credit", customerCredit,
    (c, f) => c.rpc("refund_customer_credit", { p_invoice: f.from, p_amount: 10, p_paid_on: TODAY, p_method: "BACS", p_reference: "REF-1", p_reason: "Customer asked", p_request_id: randomUUID() })],
  ["apply_customer_credit", customerCredit, (c, f) => c.rpc("apply_customer_credit", { p_from: f.from, p_to: f.to, p_amount: 10, p_request_id: randomUUID() })],
  ["create_delivery_note", async () => order(), (c, f) => despatch(c, f as { order: string; line: string })],
  ["mark a delivery note sent out", async () => ({ note: await note("awaiting") }), (c, f) => c.from("delivery_notes").update({ status: "despatched" }).eq("id", f.note)],
  ["sign a delivery note", async () => ({ note: await note("despatched") }),
    (c, f) => c.from("delivery_notes").update({ status: "signed", signed_by_name: "A. Driver", signed_at: new Date().toISOString() }).eq("id", f.note)],
  ["delete a delivery note", async () => ({ note: await note("awaiting") }), (c, f) => c.from("delivery_notes").delete().eq("id", f.note)],
  ["create_invoice_from_delivery_notes", async () => ({ note: await note("despatched") }),
    (c, f) => c.rpc("create_invoice_from_delivery_notes", { p_notes: [f.note], p_invoice_date: TODAY, p_due_date: "2099-02-01", p_terms: "30 days" })],
  ["record_job_inspection (pass, releases the job)", finishedJob, (c, f) => inspect(c, f as { id: string; version: number }, "pass")],
  ["record_job_inspection (fail)", finishedJob, (c, f) => inspect(c, f as { id: string; version: number }, "fail")],
  ["record_job_inspection (concession)", finishedJob, (c, f) => inspect(c, f as { id: string; version: number }, "concession")],
  ["bump_drawing_revision (approve a revision)", drawing,
    (c, f) => c.rpc("bump_drawing_revision", { p_file: f.file, p_revision: "B", p_file_name: "bracket-B.png", p_storage_path: `${org()}/${f.job}/2-bracket-B.png` })],
  ["label a drawing revision (job_files update)", drawing, (c, f) => c.from("job_files").update({ revision: "A" }).eq("id", f.file)],
  ["sign_off_job", async () => {
    const f = await finishedJob();
    const sha = (await withDb((db) => db.query<{ sha: string }>("select encode(extensions.digest(convert_to(public.canonical_jsonb(public.job_signoff_snapshot(j)), 'UTF8'), 'sha256'), 'hex') as sha from public.jobs j where j.id = $1", [f.id]))).rows[0].sha;
    return { ...f, sha };
  }, (c, f) => c.rpc("sign_off_job", { p_job_id: f.id, p_expected_version: f.version, p_expected_snapshot_sha256: (f as { sha: string }).sha, p_initials: "AB", p_signer_name: "Alex Brown", p_signed_on: TODAY, p_signature_kind: "typed", p_signature_data: "Alex Brown" })],
  ["set_member_inspector", async () => ({}), (c) => c.rpc("set_member_inspector", { p_user: world.tenants.alpha.users.office.id, p_value: true })],
  // 037: failing an inspection and working the rework.
  ["fail_job_inspection (opens a rework)", finishedJob,
    (c, f) => c.rpc("fail_job_inspection", { p_job: f.id, p_notes: "Bore 25.08", p_reason: "Bore oversize", p_quantity: 4, p_instructions: "Re-bore", p_attachment_path: null, p_attachment_name: null })],
  ["start_job_rework", async () => ({ rework: await rework(false) }), (c, f) => c.rpc("start_job_rework", { p_rework: f.rework })],
  ["record_rework_cost", async () => ({ rework: await rework(true) }), (c, f) => c.rpc("record_rework_cost", { p_rework: f.rework, p_hours: 1, p_material: "Bar", p_material_cost: 5, p_note: null })],
  ["scrap_job_quantity", async () => ({ rework: await rework(true) }), (c, f) => c.rpc("scrap_job_quantity", { p_rework: f.rework, p_quantity: 1, p_reason: "Cracked" })],
  ["finish_job_rework", async () => ({ rework: await rework(true) }), (c, f) => c.rpc("finish_job_rework", { p_rework: f.rework, p_note: null, p_remade: 0 })],
  ["open_replacement_rework", async () => ({ rework: await owing() }), (c, f) => c.rpc("open_replacement_rework", { p_rework: f.rework, p_instructions: "Make 2 off" })],
];

/** What the operations change, for company alpha: counts and states, so a refused call can be shown to have changed nothing. */
const snapshot = () => withDb(async (db) => (await db.query(`select
  (select count(*)::int from public.credit_notes where organization_id = $1) as credit_notes,
  (select count(*)::int from public.credit_notes where organization_id = $1 and status <> 'draft') as issued_credits,
  (select count(*)::int from public.invoice_credit_allocations where organization_id = $1) as allocations,
  (select count(*)::int from public.customer_credit_ledger where organization_id = $1) as ledger,
  (select count(*)::int from public.invoices where organization_id = $1) as invoices,
  (select string_agg(status, ',' order by id) from public.delivery_notes where organization_id = $1) as notes,
  (select count(*)::int from public.job_inspections where organization_id = $1) as inspections,
  (select count(*)::int from public.jobs where organization_id = $1 and inspected_at is not null) as released,
  (select string_agg(coalesce(revision, '-'), ',' order by id) from public.job_files where organization_id = $1) as revisions,
  (select string_agg(can_inspect::text, ',' order by user_id) from public.organization_members where organization_id = $1) as inspectors,
  (select string_agg(status || ':' || quantity_scrapped || ':' || quantity_remade || ':' || quantity_carried, ',' order by id) from public.job_rework where organization_id = $1) as reworks,
  (select count(*)::int from public.job_rework_entries where organization_id = $1) as rework_entries`, [org()])).rows[0]);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  const admin = world.tenants.alpha.users.admin;
  const first = await signedInClient(admin);
  const factor = await enrolTotp(first);
  aal2 = await signedInClient(admin);
  await passSecondStep(aal2, factor.factorId, factor.secret);
  await aal2.auth.refreshSession();
  // A password-only session made after the second step (the auth service ends older ones when a second step passes).
  aal1 = await signedInClient(admin);
});

afterAll(async () => {
  if (world) {
    await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = any($1)", [[world.tenants.alpha.id, world.tenants.beta.id]]));
    await destroySyntheticWorld(world.runId);
  }
});

const setFlag = (value: boolean) => setRequireAdminMfaForTest(org(), value);

describe("company requires the second step: the workflow's privileged operations, called directly", () => {
  it("at aal1 each one is refused with mfa_required (the database's code and message), and nothing is changed", async () => {
    for (const [name, setup, call] of OPERATIONS) {
      seq += 1;
      await setFlag(false);
      const f = await setup();
      await setFlag(true);
      const before = await snapshot();
      const { error } = await call(aal1, f);
      expect({ name, code: error?.code, hint: error?.hint, message: error?.message }).toEqual({
        name, code: "42501", hint: "mfa_required", message: "Confirm your authenticator code first (second step of sign-in).",
      });
      expect({ name, after: await snapshot() }).toEqual({ name, after: before });
    }
  });

  it("at aal2 each of the same calls goes through", async () => {
    for (const [name, setup, call] of OPERATIONS) {
      seq += 1;
      await setFlag(true);
      const f = await setup();
      const { error } = await call(aal2, f);
      expect({ name, error: error?.message ?? null }).toEqual({ name, error: null });
    }
  });

  it("other roles are not asked: the office despatches and the workshop inspects at aal1", async () => {
    await setFlag(true);
    seq += 1;
    await withDb((db) => db.query("update public.organization_members set can_inspect = true where organization_id = $1 and user_id = $2", [org(), world.tenants.alpha.users.workshop.id]));
    const office = await signedInClient(world.tenants.alpha.users.office);
    const workshop = await signedInClient(world.tenants.alpha.users.workshop);
    expect((await despatch(office, await order())).error).toBeNull();
    expect((await inspect(workshop, await finishedJob(), "pass")).error).toBeNull();
  });
});

describe("the company does not require it: nothing changes", () => {
  it("an admin at aal1 does all of it as before", async () => {
    await setFlag(false);
    for (const [name, setup, call] of OPERATIONS) {
      seq += 1;
      const f = await setup();
      const { error } = await call(aal1, f);
      expect({ name, error: error?.message ?? null }).toEqual({ name, error: null });
    }
  });
});

describe("every privileged function of the workflow starts with the check", () => {
  it("in its definition in the database", async () => {
    const missing = await withDb(async (db) => (await db.query<{ f: string }>(`
      select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1) and position('assert_privileged_aal' in pg_get_functiondef(p.oid)) = 0`,
      [["issue_invoice", "convert_sales_order", "record_invoice_payment", "reverse_invoice_payment", "confirm_invoice_payments", "record_job_inspection",
        "set_member_inspector", "bump_drawing_revision", "create_delivery_note", "create_invoice_from_delivery_notes", "create_credit_note",
        "issue_credit_note", "allocate_credit_note", "refund_customer_credit", "apply_customer_credit",
        // 037
        "fail_job_inspection", "start_job_rework", "record_rework_cost", "scrap_job_quantity", "finish_job_rework", "open_replacement_rework",
        // 045
        "sign_off_job"]])).rows.map((r) => r.f));
    expect(missing).toEqual([]);
  });
});
