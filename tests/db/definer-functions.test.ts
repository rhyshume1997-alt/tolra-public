/**
 * Every SECURITY DEFINER function an authenticated user can call, listed from pg_proc (pre-go-live hardening, item 5).
 * They run with their owner's rights and so skip row-level security: each must tie its work to the CALLER's company. A
 * new function without an entry here fails the first test, so it can't be added without deciding how it is checked.
 *
 * Signed in as an admin of company alpha, every function that takes a target is pointed at company beta's records and must
 * refuse; the ones that take no target must answer only about alpha. Afterwards a fingerprint of every beta row, in every
 * table that has an organization_id, is unchanged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let alpha: SupabaseClient;
let betaAdmin: SupabaseClient;
const beta: Record<string, string> = {};
const MARKER = "BETA-ONLY-MARKER";

/** Trigger functions can't be called directly (they return trigger); the rest are checked below. */
const TRIGGER_FUNCTIONS = ["public.enforce_same_org_parent()", "public.organization_settings_guard_nav()", "security_audit.log_row_change()", "security_audit.set_audit_hash()"];
/** Functions that take no target at all: they only ever describe the caller's own company or session. */
const CALLER_ONLY = [
  "public.check_request_session()", "public.current_user_organization_id()", "public.current_user_role()", "public.current_user_secondary_role()",
  "public.company_people()", "public.has_org_role(allowed_roles text[])", "public.mfa_ok()", "public.my_organizations()", "public.org_members()", "public.section_allowed(p_section text)",
  "public.session_is_active()", "public.user_organization_id()",
  // 036: each describes the caller's own session or company only. The platform functions are below, as targeted attempts.
  "public.is_platform_admin()", "public.my_session()", "public.org_entry_history(p_limit integer)", "public.session_read_only()",
  // 044: the caller's company's machines in use and assignable people only.
  "public.machines_in_use()", "public.assignable_people()", "public.machine_time(p_from timestamp with time zone, p_to timestamp with time zone)",
  // 046: the caller's company's bench runs (latest per unfinished job) only.
  "public.bench_runs_state()",
  // 049: the caller's company's machines with a current paused run only.
  "public.paused_machines()",
  // 059: the caller's company's sent-out delivery notes on no live invoice only.
  "public.uninvoiced_delivery_notes()",
  // 065: the caller's company's admins' two-step status (admins only), and the caller's own set-up flag.
  "public.admin_mfa_overview()", "public.my_mfa_enrolment_required()",
  // 066: the companies the caller administers (active, non-support admin memberships) only.
  "public.my_admin_companies()",
  // 075: the IP the caller's own request comes from, and whether it is one of the caller's company's networks (admins only).
  "public.my_request_network()",
  // 084: the caller's own company's integration (admins only): connection without secrets, what is unmapped, the send log's counts.
  "public.integration_overview(p_provider text)",
  // 099: the caller's company's Complete jobs still to despatch or invoice only (admin and office).
  "public.jobs_awaiting_despatch_or_invoice()",
  // 096: the caller's own company's AI helper switches, cap and spend (office and admin; never the key).
  "public.ai_helper_status()",
];

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  alpha = await signedInClient(world.tenants.alpha.users.admin);
  betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  const betaOffice = await signedInClient(world.tenants.beta.users.office);
  const service = adminClient();
  const org = world.tenants.beta.id;

  beta.customer = (await service.from("customers").insert({ organization_id: org, name: `${MARKER} Customer` }).select("id").single()).data!.id;
  beta.adminId = world.tenants.beta.users.admin.id;
  beta.job = (await service.from("jobs").insert({ organization_id: org, job_no: `J-${MARKER}`, customer: `${MARKER} Customer`, finished_at: "2026-10-02T08:00:00Z" }).select("id").single()).data!.id;
  beta.machine = (await service.from("machines").insert({ organization_id: org, name: `${MARKER} Machine` }).select("id").single()).data!.id;
  beta.order = (await service.from("sales_orders").insert({ organization_id: org, so_number: `PO-${MARKER}`, customer: `${MARKER} Customer`, total_value: 100, status: "open" }).select("id").single()).data!.id;
  beta.machine = (await service.from("machines").insert({ organization_id: org, name: `${MARKER} Mill` }).select("id").single()).data!.id;
  // 058: a sent beta quote with one line, for accept_quote to be pointed at.
  beta.quote = (await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-${MARKER}`, customer: `${MARKER} Customer`, status: "draft", total_value: 120, vat_enabled: true }).select("id").single()).data!.id;
  if ((await service.from("quote_line_items").insert({ organization_id: org, quote_id: beta.quote, position: 0, description: "Bush", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false })).error) throw new Error("beta quote line");
  if ((await service.from("quotes").update({ status: "sent" }).eq("id", beta.quote)).error) throw new Error("beta quote sent");
  beta.booking = (await service.from("machine_bookings").insert({ organization_id: org, machine_id: beta.machine, job_no: `J-${MARKER}`, start_at: "2026-12-07T08:00:00Z", estimated_hours: 2 }).select("id").single()).data!.id;
  beta.rfq = (await service.from("rfqs").insert({ organization_id: org, customer: `${MARKER} Customer` }).select("id").single()).data!.id;
  // 067: a beta customer-PO quote file, for job_file_quote_reference_ok to be asked about from alpha.
  beta.attachmentPath = `${org}/QUO-${MARKER}/po.pdf`;
  beta.attachment = (await service.from("quote_attachments").insert({ organization_id: org, quote_ref: `QUO-${MARKER}`, file_path: beta.attachmentPath, file_name: "po.pdf", kind: "customer_po" }).select("id").single()).data!.id;
  // 059: a beta delivery note that has gone out and is on no invoice (the service role's change drafts nothing).
  beta.note = (await service.from("delivery_notes").insert({ organization_id: org, dn_number: `DLN-${MARKER}`, customer: `${MARKER} Customer`, status: "despatched" }).select("id").single()).data!.id;

  // A beta invoice that is issued and part paid, so payments can be recorded and reversed on it.
  const created = await betaAdmin.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: `${MARKER} Customer`, subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id",
    p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
  });
  if (created.error) throw new Error(created.error.message);
  beta.invoice = created.data as string;
  const issued = await betaAdmin.rpc("issue_invoice", { p_invoice: beta.invoice });
  if (issued.error) throw new Error(issued.error.message);
  const paid = await betaAdmin.rpc("record_invoice_payment", { p_invoice: beta.invoice, p_amount: 50, p_paid_on: "2026-10-10", p_method: "BACS", p_reference: null, p_request_id: randomUUID() });
  if (paid.error) throw new Error(paid.error.message);
  beta.credit = (await betaAdmin.rpc("create_credit_note", { p_invoice: beta.invoice, p_reason: null, p_credit_date: "2026-10-10", p_lines: [{ invoice_line_id: (await service.from("invoice_line_items").select("id").eq("invoice_id", beta.invoice).single()).data!.id, quantity: 1 }] })).data as string;
  if ((await betaAdmin.rpc("issue_credit_note", { p_credit: beta.credit })).error) throw new Error("beta credit note");
  beta.payment = (await service.from("invoice_payments").select("id").eq("invoice_id", beta.invoice).single()).data!.id;
  // 073: a second beta invoice, issued with nothing against it, so voiding it would work if it were the caller's own.
  const voidable = await betaAdmin.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: `${MARKER} Customer`, subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id",
    p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
  });
  if (voidable.error) throw new Error(voidable.error.message);
  beta.voidable = voidable.data as string;
  if ((await betaAdmin.rpc("issue_invoice", { p_invoice: beta.voidable })).error) throw new Error("beta voidable invoice");
  // Waiting to be confirmed, so that confirming it would work if it were the caller's own.
  await withDb((db) => db.query("update public.invoices set payment_unverified = true where id = $1", [beta.invoice]));

  const email = await betaOffice.rpc("reserve_job_email", { p_job: beta.job, p_recipient: "buyer@example.test", p_subject: "S", p_body: "B", p_key: randomUUID(), p_mode: "sending" });
  if (email.error) throw new Error(email.error.message);
  beta.history = email.data.history_id;
  const mail = await betaAdmin.rpc("reserve_mail_send", { p_kind: "send", p_key: randomBytes(32).toString("hex"), p_recipients: ["buyer@example.test"], p_subject: "S", p_body: "B", p_rfq: null });
  if (mail.error) throw new Error(mail.error.message);
  beta.send = mail.data.send_id;

  // A failed inspection on beta's finished job, so that its rework can be started, costed, scrapped and finished if it were the caller's own.
  const failed = await betaAdmin.rpc("fail_job_inspection", { p_job: beta.job, p_notes: "Bore oversize", p_reason: "Bore oversize", p_quantity: null, p_instructions: "Re-bore", p_attachment_path: null, p_attachment_name: null });
  if (failed.error) throw new Error(failed.error.message);
  beta.rework = failed.data.rework_id;

  // 084: a failed Xero send and a contact problem of beta's, for retry and resolve to be pointed at (written as the server would).
  beta.integrationSend = (await service.from("integration_sends").insert({ organization_id: org, provider: "xero", doc_type: "invoice", doc_id: beta.invoice, action: "create", status: "failed", last_error: "x" }).select("id").single()).data!.id;
  if ((await service.from("integration_contacts").insert({ organization_id: org, provider: "xero", customer_name: `${MARKER} Customer`, state: "problem", problem: "Two contacts" })).error) throw new Error("beta integration contact");

  // 096: an AI helper suggestion of beta's, waiting for a decision, for settle and decide to be pointed at (written as its functions would).
  beta.aiRequest = (await service.from("ai_helper_requests").insert({ organization_id: org, user_id: beta.adminId, feature: "rfq", month: `${new Date().toISOString().slice(0, 7)}-01`, status: "suggested", input_digest: "a".repeat(64), input_bytes: 10, output: { kind: "rfq", lines: [] } }).select("id").single()).data!.id;

  // A photo reserved on beta's job by beta's admin (040), for finalise and remove to be pointed at.
  beta.photo = randomUUID();
  const reserved = await betaAdmin.rpc("reserve_job_photo", { p_id: beta.photo, p_job: beta.job, p_note: `${MARKER} photo`, p_captured_at: null, p_byte_size: 100 });
  if (reserved.error) throw new Error(reserved.error.message);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** A fingerprint of everything company beta owns, from every table with an organization_id. */
async function betaFingerprint() {
  return withDb(async (db) => {
    const tables = (await db.query<{ schema: string; table: string }>(`
      select c.table_schema as schema, c.table_name as table from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.column_name = 'organization_id' and c.table_schema in ('public', 'security_audit') order by 1, 2`)).rows;
    const out: Record<string, string> = {};
    for (const { schema, table } of tables) {
      // Not row order, not volatile counters: what is stored, as text.
      const { rows } = await db.query(`select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from ${schema}.${table} t where organization_id = $1`, [world.tenants.beta.id]);
      out[`${schema}.${table}`] = `${rows[0].n}:${rows[0].h}`;
    }
    return out;
  });
}

type Attempt = [name: string, call: () => PromiseLike<{ error: { code?: string; message: string } | null; data?: unknown }>, how: "refused" | "nothing of beta's"];

describe("every definer function is accounted for", () => {
  it("the list in pg_proc equals the list this test covers", async () => {
    const found = await withDb(async (db) => (await db.query<{ sig: string }>(`
      select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'security_audit') and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      order by 1`)).rows.map((r) => r.sig));
    const targeted = attempts().map(([name]) => name);
    const covered = [...TRIGGER_FUNCTIONS, ...CALLER_ONLY, ...targeted].sort();
    expect(found.map((sig) => sig.replace(/\(.*$/, "")).sort()).toEqual([...new Set(covered.map((sig) => sig.replace(/\(.*$/, "")))].sort());
  });
});

function attempts(): Attempt[] {
  const day = new Date().toISOString();
  return [
    ["public.complete_job_email(p_history uuid, p_outcome text)", () => alpha.rpc("complete_job_email", { p_history: beta.history, p_outcome: "failed" }), "refused"],
    ["public.complete_mail_send(p_id uuid, p_outcome text)", () => alpha.rpc("complete_mail_send", { p_id: beta.send, p_outcome: "failed" }), "refused"],
    ["public.resolve_job_email(p_history uuid, p_as text)", () => alpha.rpc("resolve_job_email", { p_history: beta.history, p_as: "failed" }), "refused"],
    ["public.resolve_mail_send(p_id uuid, p_as text)", () => alpha.rpc("resolve_mail_send", { p_id: beta.send, p_as: "failed" }), "refused"],
    ["public.reserve_job_email(p_job uuid, p_recipient text, p_subject text, p_body text, p_key text, p_mode text)", () => alpha.rpc("reserve_job_email", { p_job: beta.job, p_recipient: "x@example.test", p_subject: "S", p_body: "B", p_key: randomUUID(), p_mode: "sending" }), "refused"],
    ["public.record_invoice_payment(p_invoice uuid, p_amount numeric, p_paid_on date, p_method text, p_reference text, p_request_id uuid)", () => alpha.rpc("record_invoice_payment", { p_invoice: beta.invoice, p_amount: 10, p_paid_on: "2026-10-10", p_method: "BACS", p_reference: null, p_request_id: randomUUID() }), "refused"],
    // 099: the draft editor's balances, pointed at beta's invoice.
    ["public.draft_invoice_balances(p_invoice uuid)", () => alpha.rpc("draft_invoice_balances", { p_invoice: beta.invoice }), "refused"],
    ["public.draft_invoice_order_lines(p_invoice uuid)", () => alpha.rpc("draft_invoice_order_lines", { p_invoice: beta.invoice }), "refused"],
    ["public.confirm_invoice_payments(p_invoice uuid, p_note text)", () => alpha.rpc("confirm_invoice_payments", { p_invoice: beta.invoice, p_note: "cross-company attempt" }), "refused"],
    ["public.reverse_invoice_payment(p_payment uuid, p_reason text)", () => alpha.rpc("reverse_invoice_payment", { p_payment: beta.payment, p_reason: "cross-company attempt" }), "refused"],
    ["public.record_job_inspection(p_job uuid, p_result text, p_notes text, p_attachment_path text, p_attachment_name text, p_concession_reason text, p_expected_version integer)", () => alpha.rpc("record_job_inspection", { p_job: beta.job, p_result: "pass", p_notes: "Cross-company attempt", p_attachment_path: null, p_attachment_name: null, p_concession_reason: null, p_expected_version: 0 }), "refused"],
    // 045: operator sign-off, pointed at beta's job.
    ["public.sign_off_job(p_job_id uuid, p_expected_version integer, p_expected_snapshot_sha256 text, p_initials text, p_signer_name text, p_signed_on date, p_signature_kind text, p_signature_data text, p_kind text DEFAULT 'primary'::text, p_client_op_id uuid DEFAULT NULL::uuid)", () => alpha.rpc("sign_off_job", { p_job_id: beta.job, p_expected_version: 0, p_expected_snapshot_sha256: "0".repeat(64), p_initials: "XC", p_signer_name: "Cross company", p_signed_on: "2026-10-10", p_signature_kind: "typed", p_signature_data: "Cross company", p_client_op_id: randomUUID() }), "refused"],
    ["public.job_signoff_revision(p_job_id uuid)", () => alpha.rpc("job_signoff_revision", { p_job_id: beta.job }), "refused"],
    ["public.set_member_inspector(p_user uuid, p_value boolean)", () => alpha.rpc("set_member_inspector", { p_user: beta.adminId, p_value: true }), "refused"],
    // 083: adding beta's person to (or removing them from) the authorised inspectors list is refused (not in this company).
    ["public.set_authorised_inspector(p_user uuid, p_authorised boolean, p_scope text, p_reason text)", () => alpha.rpc("set_authorised_inspector", { p_user: beta.adminId, p_authorised: false, p_scope: null, p_reason: "Cross-company attempt" }), "refused"],
    // 083: beta's job's drawing revision (or its requirement) is out of reach: not found in this company.
    ["public.set_job_drawing_revision(p_job uuid, p_required boolean, p_revision text, p_reason text)", () => alpha.rpc("set_job_drawing_revision", { p_job: beta.job, p_required: true, p_revision: "Z", p_reason: "Cross-company attempt" }), "refused"],
    // 037: failing an inspection and working the rework, pointed at beta's job and rework.
    ["public.fail_job_inspection(p_job uuid, p_notes text, p_reason text, p_quantity integer, p_instructions text, p_attachment_path text, p_attachment_name text, p_lines jsonb, p_batch text)", () => alpha.rpc("fail_job_inspection", { p_job: beta.job, p_notes: "Cross-company attempt", p_reason: "Cross-company attempt", p_quantity: null, p_instructions: "x", p_attachment_path: null, p_attachment_name: null, p_lines: null, p_batch: "B-1" }), "refused"],
    ["public.start_job_rework(p_rework uuid)", () => alpha.rpc("start_job_rework", { p_rework: beta.rework }), "refused"],
    ["public.record_rework_cost(p_rework uuid, p_hours numeric, p_material text, p_material_cost numeric, p_note text)", () => alpha.rpc("record_rework_cost", { p_rework: beta.rework, p_hours: 1, p_material: "Bar", p_material_cost: 5, p_note: null }), "refused"],
    ["public.scrap_job_quantity(p_rework uuid, p_quantity integer, p_reason text)", () => alpha.rpc("scrap_job_quantity", { p_rework: beta.rework, p_quantity: 1, p_reason: "Cross-company attempt" }), "refused"],
    ["public.finish_job_rework(p_rework uuid, p_note text, p_remade integer)", () => alpha.rpc("finish_job_rework", { p_rework: beta.rework, p_note: null, p_remade: 0 }), "refused"],
    // 042: a new job pointed at beta's job as its related job (and beta's job number sequence is never touched).
    ["public.create_job(p_customer text, p_description text, p_internal boolean, p_related uuid, p_required date, p_machines jsonb, p_clash_override boolean, p_clashes jsonb, p_override_reason text)", () => alpha.rpc("create_job", { p_customer: "Cross-company attempt", p_description: "x", p_internal: true, p_related: beta.job, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null }), "refused"],
    ["public.save_machine_booking(p_id uuid, p_machine uuid, p_job uuid, p_job_no text, p_description text, p_start timestamp with time zone, p_hours numeric, p_hours_done numeric, p_status text, p_notes text, p_day_plan jsonb, p_clear_day_plan boolean, p_clash_override boolean, p_override_reason text)", () => alpha.rpc("save_machine_booking", { p_id: beta.booking, p_machine: beta.machine, p_job: null, p_job_no: "J-X", p_description: null, p_start: "2026-12-07T08:00:00Z", p_hours: 1, p_hours_done: 0, p_status: "booked", p_notes: null, p_day_plan: null, p_clear_day_plan: false, p_clash_override: false, p_override_reason: null }), "refused"],
    ["public.delete_machine_booking(p_id uuid)", () => alpha.rpc("delete_machine_booking", { p_id: beta.booking }), "refused"],
    // 043: an order line's machines, the carry and a job's machines, each pointed at beta's order or job.
    ["public.set_sales_order_line_machines(p_order uuid, p_line uuid, p_machines jsonb)", () => alpha.rpc("set_sales_order_line_machines", { p_order: beta.order, p_line: randomUUID(), p_machines: [] }), "refused"],
    ["public.carry_so_machines(p_order uuid, p_job uuid)", () => alpha.rpc("carry_so_machines", { p_order: beta.order, p_job: beta.job }), "refused"],
    ["public.set_job_machines(p_job uuid, p_machines jsonb, p_clash_override boolean, p_clashes jsonb, p_override_reason text)", () => alpha.rpc("set_job_machines", { p_job: beta.job, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null }), "refused"],
    // 044: beta's job, machine and people are out of reach.
    // 049: one signature (the acknowledgements and the explicit bench flag default to NULL).
    ["public.start_machine_run(p_job uuid, p_machines uuid[], p_client_op_id uuid, p_started_at timestamp with time zone, p_override boolean, p_reason text, p_paused_ack jsonb DEFAULT NULL::jsonb, p_bench boolean DEFAULT NULL::boolean)", () => alpha.rpc("start_machine_run", { p_job: beta.job, p_machines: [beta.machine], p_client_op_id: randomUUID(), p_started_at: null, p_override: false, p_reason: null }), "refused"],
    // 049: a booking confirmation pointed at beta's machine, job and a random run.
    ["public.acknowledge_paused_machine(p_machine uuid, p_paused_run uuid, p_job uuid, p_client_op_id uuid)", () => alpha.rpc("acknowledge_paused_machine", { p_machine: beta.machine, p_paused_run: randomUUID(), p_job: beta.job, p_client_op_id: randomUUID() }), "refused"],
    ["public.pause_machine_run(p_job uuid, p_machines uuid[], p_client_op_id uuid, p_ended_at timestamp with time zone)", () => alpha.rpc("pause_machine_run", { p_job: beta.job, p_machines: null, p_client_op_id: randomUUID(), p_ended_at: null }), "refused"],
    ["public.finish_job(p_job uuid, p_client_op_id uuid, p_finished_at timestamp with time zone)", () => alpha.rpc("finish_job", { p_job: beta.job, p_client_op_id: randomUUID(), p_finished_at: null }), "refused"],
    // 081: inspecting, reopening or releasing beta's job early is refused (beta's job, its inspections and history stay as they are).
    ["public.inspect_job(p_job uuid, p_result text, p_criteria text, p_measured text, p_expected_version integer, p_attachment_path text DEFAULT NULL::text, p_attachment_name text DEFAULT NULL::text, p_concession_reason text DEFAULT NULL::text, p_override_reason text DEFAULT NULL::text, p_disposition text DEFAULT NULL::text, p_failure jsonb DEFAULT NULL::jsonb, p_client_op_id uuid DEFAULT NULL::uuid)", () => alpha.rpc("inspect_job", { p_job: beta.job, p_result: "pass", p_criteria: "Cross-company attempt", p_measured: "Cross-company attempt", p_expected_version: 0, p_client_op_id: randomUUID() }), "refused"],
    ["public.reopen_job(p_job uuid, p_reason text)", () => alpha.rpc("reopen_job", { p_job: beta.job, p_reason: "Cross-company attempt" }), "refused"],
    ["public.release_job_early(p_job uuid, p_reason text)", () => alpha.rpc("release_job_early", { p_job: beta.job, p_reason: "Cross-company attempt" }), "refused"],
    ["public.release_machine(p_machine uuid, p_reason text)", () => alpha.rpc("release_machine", { p_machine: beta.machine, p_reason: "cross-company attempt" }), "refused"],
    ["public.assign_job(p_job uuid, p_user uuid)", () => alpha.rpc("assign_job", { p_job: beta.job, p_user: beta.adminId }), "refused"],
    // 058: accepting beta's quote and changing beta's order's customer PO are refused; the automatic-job setting is the caller's company's only.
    ["public.accept_quote(p_quote uuid, p_customer_po text, p_delivery_date date, p_lines uuid[])", () => alpha.rpc("accept_quote", { p_quote: beta.quote, p_customer_po: "PO-X", p_delivery_date: null }), "refused"],
    // 068: revising beta's sent quote is refused (and beta's quote stays as it is).
    ["public.revise_quote(p_quote uuid)", () => alpha.rpc("revise_quote", { p_quote: beta.quote }), "refused"],
    ["public.set_sales_order_customer_po(p_order uuid, p_customer_po text)", () => alpha.rpc("set_sales_order_customer_po", { p_order: beta.order, p_customer_po: "PO-X" }), "refused"],
    ["public.set_auto_convert_sales_orders(p_on boolean)", () => alpha.rpc("set_auto_convert_sales_orders", { p_on: true }), "nothing of beta's"],
    // 050: a clock action is the caller's own (no target); a correction pointed at beta's person is refused; settings are the caller's company's.
    ["public.record_attendance_event(p_client_op_id uuid, p_action text, p_at timestamp with time zone, p_device text DEFAULT NULL::text)", () => alpha.rpc("record_attendance_event", { p_client_op_id: randomUUID(), p_action: "in", p_at: null }), "nothing of beta's"],
    // 090: a clock action sent with the company it was made in; pointed at beta (where alpha's admin is not working) it is refused.
    ["public.record_attendance_event_in_company(p_client_op_id uuid, p_action text, p_at timestamp with time zone, p_device text, p_expected_org uuid)", () => alpha.rpc("record_attendance_event_in_company", { p_client_op_id: randomUUID(), p_action: "in", p_at: null, p_device: null, p_expected_org: world.tenants.beta.id }), "refused"],
    ["public.correct_attendance_event(p_client_op_id uuid, p_user uuid, p_supersedes uuid, p_action text, p_at timestamp with time zone, p_reason text)", () => alpha.rpc("correct_attendance_event", { p_client_op_id: randomUUID(), p_user: beta.adminId, p_supersedes: null, p_action: "in", p_at: day, p_reason: "Cross-company attempt" }), "refused"],
    ["public.save_time_settings(p_settings jsonb)", () => alpha.rpc("save_time_settings", { p_settings: { sunday_overtime: true } }), "nothing of beta's"],
    // 051: job time on beta's job, for beta's person, or on a random session is refused.
    ["public.record_labour_event(p_client_op_id uuid, p_job uuid, p_action text, p_at timestamp with time zone)", () => alpha.rpc("record_labour_event", { p_client_op_id: randomUUID(), p_job: beta.job, p_action: "start", p_at: null }), "refused"],
    ["public.add_labour_session(p_client_op_id uuid, p_user uuid, p_job uuid, p_started_at timestamp with time zone, p_ended_at timestamp with time zone, p_reason text)", () => alpha.rpc("add_labour_session", { p_client_op_id: randomUUID(), p_user: null, p_job: beta.job, p_started_at: "2026-10-10T08:00:00Z", p_ended_at: "2026-10-10T09:00:00Z", p_reason: "Cross-company attempt" }), "refused"],
    ["public.correct_labour_session(p_session uuid, p_started_at timestamp with time zone, p_ended_at timestamp with time zone, p_reason text)", () => alpha.rpc("correct_labour_session", { p_session: randomUUID(), p_started_at: "2026-10-10T08:00:00Z", p_ended_at: null, p_reason: "Cross-company attempt" }), "refused"],
    ["public.void_labour_session(p_session uuid, p_reason text)", () => alpha.rpc("void_labour_session", { p_session: randomUUID(), p_reason: "Cross-company attempt" }), "refused"],
    // 052: approving beta's person is refused; the week's status pointed at beta's person answers nothing of theirs.
    ["public.approve_time_week(p_user uuid, p_week date, p_revision text, p_totals jsonb, p_note text DEFAULT NULL::text)", () => alpha.rpc("approve_time_week", { p_user: beta.adminId, p_week: "2026-10-12", p_revision: "0".repeat(32), p_totals: {} }), "refused"],
    ["public.time_week_status(p_week date, p_user uuid DEFAULT NULL::uuid)", () => alpha.rpc("time_week_status", { p_week: "2026-10-12", p_user: beta.adminId }), "nothing of beta's"],
    // 072: a customer sign-off pointed at beta's job is refused (not found, whatever alpha's setting); the setting is the caller's company's only.
    ["public.sign_off_job_customer(p_job_id uuid, p_signer_name text, p_signer_position text, p_signer_company text, p_statement text, p_comment text, p_signature_kind text, p_signature_data text, p_device_signed_at timestamp with time zone, p_client_op_id uuid, p_shown_version integer, p_shown_snapshot_sha256 text)", () => alpha.rpc("sign_off_job_customer", { p_job_id: beta.job, p_signer_name: "Cross company", p_signer_position: null, p_signer_company: null, p_statement: "Cross company", p_comment: null, p_signature_kind: "typed", p_signature_data: "Cross company", p_device_signed_at: day, p_client_op_id: randomUUID() }), "refused"],
    ["public.set_customer_signoff_enabled(p_on boolean)", () => alpha.rpc("set_customer_signoff_enabled", { p_on: true }), "nothing of beta's"],
    // 074: ticking a day of beta's person is refused (not in this company).
    ["public.set_time_day_flags(p_client_op_id uuid, p_user uuid, p_day date, p_overtime boolean, p_saturday boolean, p_sunday boolean, p_bank_holiday boolean)", () => alpha.rpc("set_time_day_flags", { p_client_op_id: randomUUID(), p_user: beta.adminId, p_day: "2026-10-12", p_overtime: true, p_saturday: false, p_sunday: false, p_bank_holiday: false }), "refused"],
    // 075: the site network switch and networks are the caller's company's only; beta's person can't be flagged; a network id or a
    // refused-action row not in the caller's company is not found; a report is the caller's own action only.
    ["public.set_site_network_check(p_client_op_id uuid, p_mode text)", () => alpha.rpc("set_site_network_check", { p_client_op_id: randomUUID(), p_mode: "off" }), "nothing of beta's"],
    ["public.add_site_network(p_client_op_id uuid, p_network text, p_label text DEFAULT NULL::text)", () => alpha.rpc("add_site_network", { p_client_op_id: randomUUID(), p_network: "192.0.2.0/24", p_label: "Cross-company attempt" }), "nothing of beta's"],
    ["public.remove_site_network(p_client_op_id uuid, p_id uuid)", () => alpha.rpc("remove_site_network", { p_client_op_id: randomUUID(), p_id: randomUUID() }), "refused"],
    ["public.set_member_on_site_only(p_client_op_id uuid, p_user uuid, p_on_site_only boolean)", () => alpha.rpc("set_member_on_site_only", { p_client_op_id: randomUUID(), p_user: beta.adminId, p_on_site_only: true }), "refused"],
    ["public.report_time_sync_rejection(p_client_op_id uuid, p_kind text, p_action text, p_at timestamp with time zone, p_code text, p_reason text DEFAULT NULL::text, p_job text DEFAULT NULL::text, p_device text DEFAULT NULL::text)", () => alpha.rpc("report_time_sync_rejection", { p_client_op_id: randomUUID(), p_kind: "clock", p_action: "in", p_at: "2026-01-05T08:00:00Z", p_code: "time_too_old", p_reason: "Cross-company attempt" }), "nothing of beta's"],
    ["public.resolve_time_sync_rejection(p_id uuid, p_note text DEFAULT NULL::text)", () => alpha.rpc("resolve_time_sync_rejection", { p_id: randomUUID(), p_note: "Cross-company attempt" }), "refused"],
    // 078: deleting kept clock-in addresses is the caller's company's only (there is no target to point at beta).
    ["public.purge_site_network_ips(p_all boolean DEFAULT false)", () => alpha.rpc("purge_site_network_ips", { p_all: true }), "nothing of beta's"],
    // 084: beta's send and beta's contact problem are not found in alpha; alpha (not connected) has nothing to disconnect; a Connect start
    // and a mapping are written for alpha only.
    ["public.integration_retry_send(p_send uuid)", () => alpha.rpc("integration_retry_send", { p_send: beta.integrationSend }), "refused"],
    ["public.integration_resolve_contact(p_provider text, p_customer text, p_external_contact_id text)", () => alpha.rpc("integration_resolve_contact", { p_provider: "xero", p_customer: `${MARKER} Customer`, p_external_contact_id: "c-1" }), "refused"],
    ["public.integration_disconnect(p_provider text)", () => alpha.rpc("integration_disconnect", { p_provider: "xero" }), "refused"],
    ["public.integration_oauth_begin(p_provider text, p_state_hash text, p_verifier_enc text)", () => alpha.rpc("integration_oauth_begin", { p_provider: "xero", p_state_hash: randomBytes(32).toString("hex"), p_verifier_enc: `v1.${randomBytes(12).toString("base64url")}.${randomBytes(16).toString("base64url")}.${randomBytes(48).toString("base64url")}` }), "nothing of beta's"],
    ["public.integration_set_mapping(p_provider text, p_kind text, p_tolra_key text, p_external_code text, p_external_name text)", () => alpha.rpc("integration_set_mapping", { p_provider: "xero", p_kind: "sales_account", p_tolra_key: null, p_external_code: "200", p_external_name: "Sales" }), "nothing of beta's"],
    // 076: the import writes into the caller's session company only (the payload can't name a company); a dry run here.
    ["public.import_company_data(p_payload jsonb, p_dry_run boolean, p_client_op_id uuid)", () => alpha.rpc("import_company_data", { p_payload: { customers: [{ name: "Cross-company attempt" }] }, p_dry_run: true, p_client_op_id: randomUUID() }), "nothing of beta's"],
    // 076: a large import is the caller's company's own: staging stores alpha's part; another import id is not found.
    ["public.import_stage_part(p_import_id uuid, p_part integer, p_payload jsonb)", () => alpha.rpc("import_stage_part", { p_import_id: randomUUID(), p_part: 1, p_payload: { customers: [{ name: "Cross-company attempt" }] } }), "nothing of beta's"],
    ["public.import_validate(p_import_id uuid, p_part_weight integer, p_client_op_id uuid)", () => alpha.rpc("import_validate", { p_import_id: randomUUID(), p_part_weight: 750, p_client_op_id: randomUUID() }), "refused"],
    ["public.import_commit_part(p_import_id uuid, p_client_op_id uuid)", () => alpha.rpc("import_commit_part", { p_import_id: randomUUID(), p_client_op_id: randomUUID() }), "refused"],
    ["public.import_undo(p_import_id uuid, p_client_op_id uuid)", () => alpha.rpc("import_undo", { p_import_id: randomUUID(), p_client_op_id: randomUUID() }), "refused"],
    ["public.job_rework_summary(p_job uuid)", () => alpha.rpc("job_rework_summary", { p_job: beta.job }), "refused"],
    ["public.job_release_state(p_job uuid)", () => alpha.rpc("job_release_state", { p_job: beta.job }), "refused"],
    ["public.job_line_release(p_job uuid)", () => alpha.rpc("job_line_release", { p_job: beta.job }), "refused"],
    ["public.open_replacement_rework(p_rework uuid, p_instructions text)", () => alpha.rpc("open_replacement_rework", { p_rework: beta.rework, p_instructions: "Cross-company attempt" }), "refused"],
    // 040: a photo reserved on beta's job, and beta's own reservation, pointed at from alpha.
    ["public.reserve_job_photo(p_id uuid, p_job uuid, p_note text, p_captured_at timestamp with time zone, p_byte_size integer)", () => alpha.rpc("reserve_job_photo", { p_id: randomUUID(), p_job: beta.job, p_note: "Cross-company attempt", p_captured_at: null, p_byte_size: 100 }), "refused"],
    ["public.finalise_job_photo(p_id uuid)", () => alpha.rpc("finalise_job_photo", { p_id: beta.photo }), "refused"],
    ["public.remove_job_photo(p_id uuid)", () => alpha.rpc("remove_job_photo", { p_id: beta.photo }), "refused"],
    // 059: the manual invoice-from-delivery-notes path (now SECURITY DEFINER), pointed at beta's sent-out note.
    ["public.create_invoice_from_delivery_notes(p_notes uuid[], p_invoice_date date, p_due_date date, p_terms text)", () => alpha.rpc("create_invoice_from_delivery_notes", { p_notes: [beta.note], p_invoice_date: "2026-10-10", p_due_date: "2026-11-09", p_terms: "30 days" }), "refused"],
    // 067: beta's sent-out note put on beta's (issued) invoice, from alpha.
    ["public.link_delivery_note_to_invoice(p_note uuid, p_invoice uuid)", () => alpha.rpc("link_delivery_note_to_invoice", { p_note: beta.note, p_invoice: beta.invoice }), "refused"],
    // 073: beta's issued invoice (nothing against it) voided from alpha.
    ["public.void_invoice(p_invoice_id uuid, p_reason text)", () => alpha.rpc("void_invoice", { p_invoice_id: beta.voidable, p_reason: "Cross-company attempt" }), "refused"],
    // 067 review: the quote-file reference check answers false for another company's file, even with that company named.
    ["public.job_file_quote_reference_ok(p_org uuid, p_kind text, p_path text, p_source uuid)", () => alpha.rpc("job_file_quote_reference_ok", { p_org: world.tenants.beta.id, p_kind: "customer_po", p_path: beta.attachmentPath, p_source: beta.attachment }), "nothing of beta's"],
    ["public.ensure_sales_order_lines(p_order uuid)", () => alpha.rpc("ensure_sales_order_lines", { p_order: beta.order }), "refused"],
    ["public.despatch_lines(p_order uuid, p_job uuid)", () => alpha.rpc("despatch_lines", { p_order: beta.order, p_job: null }), "refused"],
    ["public.despatch_release(p_order uuid, p_job uuid)", () => alpha.rpc("despatch_release", { p_order: beta.order, p_job: null }), "refused"],
    ["public.create_delivery_note(p_order uuid, p_job uuid, p_ship_date date, p_tax_date date, p_ship_via text, p_notes text, p_lines jsonb)", () => alpha.rpc("create_delivery_note", { p_order: beta.order, p_job: null, p_ship_date: "2026-10-10", p_tax_date: "2026-10-10", p_ship_via: null, p_notes: null, p_lines: [{ line_id: randomUUID(), quantity: 1 }] }), "refused"],
    ["public.allocate_credit_note(p_credit uuid, p_amount numeric, p_request_id uuid)", () => alpha.rpc("allocate_credit_note", { p_credit: beta.credit, p_amount: 10, p_request_id: randomUUID() }), "refused"],
    ["public.refund_customer_credit(p_invoice uuid, p_amount numeric, p_paid_on date, p_method text, p_reference text, p_reason text, p_request_id uuid)", () => alpha.rpc("refund_customer_credit", { p_invoice: beta.invoice, p_amount: 5, p_paid_on: "2026-10-10", p_method: "BACS", p_reference: null, p_reason: null, p_request_id: randomUUID() }), "refused"],
    ["public.apply_customer_credit(p_from uuid, p_to uuid, p_amount numeric, p_request_id uuid)", () => alpha.rpc("apply_customer_credit", { p_from: beta.invoice, p_to: randomUUID(), p_amount: 5, p_request_id: randomUUID() }), "refused"],
    ["public.set_archive_state(p_table text, p_id uuid, p_state text)", () => alpha.rpc("set_archive_state", { p_table: "jobs", p_id: beta.job, p_state: "archived" }), "refused"],
    ["public.set_member_access(p_user uuid, p_role text, p_active boolean, p_secondary_role text, p_clear_secondary boolean, p_hidden_sections text[])", () => alpha.rpc("set_member_access", { p_user: world.tenants.beta.users.office.id, p_role: "viewer", p_active: false }), "refused"],
    // 066: granting or removing access in a company the caller does not administer is refused; one login's access is answered for
    // the caller's own admin companies only.
    ["public.admin_set_company_access(p_org uuid, p_user uuid, p_role text, p_secondary_role text, p_clear_secondary boolean, p_active boolean)", () => alpha.rpc("admin_set_company_access", { p_org: world.tenants.beta.id, p_user: world.tenants.beta.users.office.id, p_role: "viewer", p_active: false }), "refused"],
    ["public.admin_company_access(p_user uuid)", () => alpha.rpc("admin_company_access", { p_user: world.tenants.beta.users.admin.id }), "nothing of beta's"],
    // 093: asked about beta's person, the protected-login question answers TRUE (not one of the caller's people: the same answer as a
    // platform owner), so nothing about beta's login is learned.
    ["public.admin_login_is_protected(p_user uuid)", () => alpha.rpc("admin_login_is_protected", { p_user: world.tenants.beta.users.office.id }), "nothing of beta's"],
    ["public.switch_organization(p_org uuid)", () => alpha.rpc("switch_organization", { p_org: world.tenants.beta.id }), "refused"],
    // 036: the platform functions are for the platform owner; a company admin pointing them at another company is refused.
    ["public.platform_list_organizations()", () => alpha.rpc("platform_list_organizations"), "refused"],
    ["public.platform_enter_organization(p_org uuid, p_reason text, p_hours numeric)", () => alpha.rpc("platform_enter_organization", { p_org: world.tenants.beta.id, p_reason: "Cross-company attempt", p_hours: 2 }), "refused"],
    ["public.platform_elevate_support(p_org uuid, p_reason text, p_minutes integer)", () => alpha.rpc("platform_elevate_support", { p_org: world.tenants.beta.id, p_reason: "Cross-company attempt", p_minutes: 30 }), "refused"],
    ["public.platform_exit_organization()", () => alpha.rpc("platform_exit_organization"), "refused"],
    // 039: a company admin creating a company through the platform function is refused (and nothing is created; the slug is synthetic).
    ["public.platform_create_organization(p_name text, p_slug text, p_admin_email text)", () => alpha.rpc("platform_create_organization", { p_name: `${MARKER} Company`, p_slug: `t-${world.runId}-definer`, p_admin_email: "x@example.test" }), "refused"],
    // Record the caller's own work and ignore a foreign target: nothing of beta's is touched or returned.
    ["public.reserve_mail_send(p_kind text, p_key text, p_recipients text[], p_subject text, p_body text, p_rfq uuid)", () => alpha.rpc("reserve_mail_send", { p_kind: "send", p_key: randomBytes(32).toString("hex"), p_recipients: ["x@example.test"], p_subject: "S", p_body: "B", p_rfq: beta.rfq }), "nothing of beta's"],
    // 040: an admin marks stale photo reservations abandoned in their own company only (beta's fingerprint below is unchanged).
    ["public.abandon_stale_job_photos(p_hours integer)", () => alpha.rpc("abandon_stale_job_photos", { p_hours: 24 }), "nothing of beta's"],
    ["public.next_doc_number(p_prefix text)", () => alpha.rpc("next_doc_number", { p_prefix: "INV" }), "nothing of beta's"],
    ["public.record_activity(p_table text, p_id uuid, p_limit integer)", () => alpha.rpc("record_activity", { p_table: "jobs", p_id: beta.job, p_limit: 50 }), "nothing of beta's"],
    ["public.org_activity(p_from timestamp with time zone, p_to timestamp with time zone, p_actor uuid, p_table text, p_before timestamp with time zone, p_before_id uuid, p_limit integer)", () => alpha.rpc("org_activity", { p_from: null, p_to: null, p_actor: world.tenants.beta.users.admin.id, p_table: null, p_before: null, p_before_id: null, p_limit: 50 }), "nothing of beta's"],
    ["public.record_inbound_email(p_graph_message_id text, p_internet_message_id text, p_from_address text, p_from_name text, p_subject text, p_received_at timestamp with time zone, p_body_preview text, p_body_text text)", () => alpha.rpc("record_inbound_email", { p_graph_message_id: `AAA-${randomUUID()}`, p_internet_message_id: null, p_from_address: "a@example.test", p_from_name: null, p_subject: `Re: ${MARKER}`, p_received_at: day, p_body_preview: "", p_body_text: "" }), "nothing of beta's"],
    ["public.save_mail_poll_state(p_next_link text, p_checkpoint timestamp with time zone)", () => alpha.rpc("save_mail_poll_state", { p_next_link: null, p_checkpoint: day }), "nothing of beta's"],
    // 096: the AI helper. Settings and key change the caller's own company only; reserve answers from the caller's company (alpha's
    // features are off, so it refuses); settle and decide pointed at beta's suggestion refuse.
    ["public.ai_helper_save_settings(p_roundup boolean, p_rfq boolean, p_cap_pence integer)", () => alpha.rpc("ai_helper_save_settings", { p_roundup: false, p_rfq: false, p_cap_pence: 0 }), "nothing of beta's"],
    ["public.ai_helper_set_key(p_key_enc text, p_last4 text)", () => alpha.rpc("ai_helper_set_key", { p_key_enc: null, p_last4: null }), "nothing of beta's"],
    ["public.ai_helper_reserve(p_feature text, p_estimate_pence integer, p_input_digest text, p_input_bytes integer)", () => alpha.rpc("ai_helper_reserve", { p_feature: "rfq", p_estimate_pence: 1, p_input_digest: "b".repeat(64), p_input_bytes: 1 }), "nothing of beta's"],
    ["public.ai_helper_settle(p_request uuid, p_status text, p_failure text, p_cost_pence integer, p_model text, p_output jsonb)", () => alpha.rpc("ai_helper_settle", { p_request: beta.aiRequest, p_status: "failed", p_failure: "invalid", p_cost_pence: 0, p_model: null, p_output: null }), "refused"],
    ["public.ai_helper_decide(p_request uuid, p_decision text, p_quote uuid)", () => alpha.rpc("ai_helper_decide", { p_request: beta.aiRequest, p_decision: "rejected", p_quote: null }), "refused"],
    ["public.write_audit(p_action text, p_entity_table text, p_entity_id text, p_old jsonb, p_new jsonb, p_metadata jsonb, p_ip text, p_user_agent text)", () => alpha.rpc("write_audit", { p_action: "UPDATE", p_entity_table: "jobs", p_entity_id: beta.job, p_old: null, p_new: null, p_metadata: {}, p_ip: null, p_user_agent: null }), "nothing of beta's"],
  ];
}

describe("pointed at the other company's records, each function refuses or touches only the caller's own company", () => {
  it("every attempt, then a fingerprint of everything beta owns", async () => {
    const before = await betaFingerprint();
    for (const [name, call, how] of attempts()) {
      const { error, data } = await call();
      if (how === "refused") {
        expect({ name, refused: error !== null }).toEqual({ name, refused: true });
      }
      // Whatever came back must not carry beta's data.
      expect({ name, leaked: JSON.stringify(data ?? null).includes(MARKER) || JSON.stringify(data ?? null).includes(world.tenants.beta.id) }).toEqual({ name, leaked: false });
    }
    // The ones that take no target describe the caller only.
    expect((await alpha.rpc("current_user_organization_id")).data).toBe(world.tenants.alpha.id);
    expect(JSON.stringify((await alpha.rpc("my_organizations")).data)).not.toContain(world.tenants.beta.id);
    expect(JSON.stringify((await alpha.rpc("org_members")).data)).not.toContain(world.tenants.beta.users.admin.id);
    const people = JSON.stringify((await alpha.rpc("company_people")).data);
    expect(people).toContain(world.tenants.alpha.users.admin.id);
    for (const user of Object.values(world.tenants.beta.users)) expect(people).not.toContain(user.id);
    // 036: the session answers describe alpha only, and being a company admin is not being a platform owner.
    expect((await alpha.rpc("is_platform_admin")).data).toBe(false);
    expect((await alpha.rpc("session_read_only")).data).toBe(false);
    const session = JSON.stringify((await alpha.rpc("my_session")).data);
    expect(session).toContain(world.tenants.alpha.id);
    expect(session).not.toContain(world.tenants.beta.id);
    expect(JSON.stringify((await alpha.rpc("org_entry_history")).data)).not.toContain(world.tenants.beta.id);
    // 065: alpha's admins only.
    const mfa = JSON.stringify((await alpha.rpc("admin_mfa_overview")).data);
    expect(mfa).toContain(world.tenants.alpha.users.admin.id);
    expect(mfa).not.toContain(world.tenants.beta.users.admin.id);
    expect((await alpha.rpc("my_mfa_enrolment_required")).data).toBe(false);
    // 066: alpha only.
    const companies = JSON.stringify((await alpha.rpc("my_admin_companies")).data);
    expect(companies).toContain(world.tenants.alpha.id);
    expect(companies).not.toContain(world.tenants.beta.id);
    // 067 review: no answer about beta's quote files.
    expect((await alpha.rpc("job_file_quote_reference_ok", { p_org: world.tenants.beta.id, p_kind: "customer_po", p_path: beta.attachmentPath, p_source: beta.attachment })).data).toBe(false);
    // 093: beta's person reads as protected from alpha (fail closed; no answer that tells beta's logins apart).
    expect((await alpha.rpc("admin_login_is_protected", { p_user: world.tenants.beta.users.office.id })).data).toBe(true);
    expect(await betaFingerprint()).toEqual(before);
  });

  it("with no other company's data touched, the work that went through is the caller's company's", async () => {
    const { data } = await adminClient().from("email_history").select("organization_id, related_to_type, related_to_id").eq("to_email", "x@example.test");
    expect((data ?? []).every((row) => row.organization_id === world.tenants.alpha.id)).toBe(true);
    // The foreign RFQ id was not linked.
    expect((data ?? []).filter((row) => row.related_to_id === beta.rfq)).toEqual([]);
    const inbound = await adminClient().from("inbound_emails").select("organization_id").ilike("subject", `%${MARKER}%`);
    expect((inbound.data ?? []).every((row) => row.organization_id === world.tenants.alpha.id)).toBe(true);
  });

  it("anonymous callers get none of them", async () => {
    const { apiUrl, anonKey } = (await import("../support/isolation")).isolatedBackend();
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const [name] of attempts()) {
      const fn = name.replace(/^public\./, "").replace(/\(.*$/, "");
      const { error } = await anon.rpc(fn, {});
      expect({ fn, refused: error !== null }).toEqual({ fn, refused: true });
    }
  });
});
