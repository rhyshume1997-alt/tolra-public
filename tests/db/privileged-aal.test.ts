/**
 * Admin two-step sign-in in the DATABASE, for every privileged operation (migration 033, assert_privileged_aal). With the
 * company's require_admin_mfa on, an admin whose real token is aal1 (password only) is refused when calling PostgREST or an RPC
 * directly, whatever the operation: money, documents, settings, people and roles, mail. The same call with an aal2 token goes
 * through. Real Auth tokens (TOTP enrolled against the local Auth service), not claims set by hand.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, setRequireAdminMfaForTest, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { enrolTotp, passSecondStep } from "../support/totp";

let world: SyntheticWorld;
let aal2: SupabaseClient;
let aal1: SupabaseClient;
let seq = 0;
const org = () => world.tenants.alpha.id;
const key = () => randomBytes(32).toString("hex");

const line = [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }];
const header = (extra: Record<string, unknown> = {}) => ({ customer: "Aal Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, ...extra });

async function draftInvoice(client: SupabaseClient) {
  const { data, error } = await client.rpc("create_with_lines", { p_parent: "invoices", p_header: header(), p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: line });
  if (error) throw new Error(`draft invoice: ${error.message}`);
  return data as string;
}
async function issuedInvoice(client: SupabaseClient) {
  const id = await draftInvoice(client);
  const issued = await client.rpc("issue_invoice", { p_invoice: id });
  if (issued.error) throw new Error(`issue: ${issued.error.message}`);
  return id;
}

/** One set of records for one attempt (each operation uses up what it works on), made with the aal2 client. */
async function fixtures() {
  seq += 1;
  const service = adminClient();
  const paid = await issuedInvoice(aal2);
  const paidResult = await aal2.rpc("record_invoice_payment", { p_invoice: paid, p_amount: 30, p_paid_on: "2026-10-11", p_method: "BACS", p_reference: null, p_request_id: randomUUID() });
  if (paidResult.error) throw new Error(`payment: ${paidResult.error.message}`);
  const payment = (await service.from("invoice_payments").select("id").eq("invoice_id", paid).single()).data!.id as string;
  const unverified = await issuedInvoice(aal2);
  await withDb((db) => db.query("update public.invoices set payment_unverified = true where id = $1", [unverified]));
  const draft = await draftInvoice(aal2);
  const quote = (await service.from("quotes").insert({ organization_id: org(), quote_ref: `QUO-A${seq}-${world.runId.slice(0, 4)}`, customer: "Aal Co", status: "draft", total_value: 0, vat_enabled: false }).select("id").single()).data!.id as string;
  const po = (await service.from("purchase_orders").insert({ organization_id: org(), po_ref: `PO-A${seq}-${world.runId.slice(0, 4)}`, supplier: "Steel Ltd", total_value: 10, status: "draft" }).select("id").single()).data!.id as string;
  const job = (await service.from("jobs").insert({ organization_id: org(), job_no: `J-A${seq}-${world.runId.slice(0, 4)}`, customer: "Aal Co" }).select("id").single()).data!.id as string;
  const order = (await service.from("sales_orders").insert({ organization_id: org(), so_number: `SO-A${seq}-${world.runId.slice(0, 4)}`, customer: "Aal Co", status: "open", total_value: 10, order_date: "2026-10-09" }).select("id").single()).data!.id as string;
  // E-mail records made as the owner, dated before the limit windows (the real reservation functions have per-hour limits that a
  // test of this size would use up); their status and update time are what the operations look at.
  const admin = world.tenants.alpha.users.admin.id;
  const jobMail = (status: string) => withDb(async (db) => {
    const h = (await db.query("insert into public.email_history (organization_id, to_email, subject, body, related_to_type, related_to_id, drafted_by, status) values ($1, 'buyer@example.test', 'S', 'B', 'job', $2, $3, $4) returning id", [org(), job, admin, status === "sending" ? "sending" : "unknown"])).rows[0].id as string;
    await db.query("insert into security_audit.email_send_ledger (organization_id, user_id, job_id, recipient, idempotency_key, history_id, status, created_at) values ($1, $2, $3, 'buyer@example.test', $4, $5, $6, now() - interval '3 days')", [org(), admin, job, randomUUID(), h, status]);
    return h;
  });
  const mailSend = (status: string) => withDb(async (db) => {
    const h = (await db.query("insert into public.email_history (organization_id, to_email, subject, body, related_to_type, drafted_by, status) values ($1, 'buyer@example.test', 'S', 'B', 'general', $2, $3) returning id", [org(), admin, status === "sending" ? "sending" : "unknown"])).rows[0].id as string;
    return (await db.query("insert into security_audit.mail_send_ledger (organization_id, user_id, kind, idempotency_key, recipients, history_id, status, created_at) values ($1, $2, 'send', $3, array['buyer@example.test'], $4, $5, now() - interval '3 hours') returning id", [org(), admin, key(), h, status])).rows[0].id as string;
  });
  const history = await jobMail("sending");
  const unknownJob = await jobMail("unknown");
  const send = await mailSend("sending");
  const unknownSend = await mailSend("unknown");
  return { paid, payment, unverified, draft, quote, po, job, order, history, unknownJob, send, unknownSend };
}
type Fx = Awaited<ReturnType<typeof fixtures>>;
type Result = { error: { code?: string; hint?: string; message: string } | null };

const OPERATIONS: Array<[string, (c: SupabaseClient, f: Fx) => PromiseLike<Result>]> = [
  ["record_invoice_payment", (c, f) => c.rpc("record_invoice_payment", { p_invoice: f.paid, p_amount: 10, p_paid_on: "2026-10-11", p_method: "BACS", p_reference: null, p_request_id: randomUUID() })],
  ["reverse_invoice_payment", (c, f) => c.rpc("reverse_invoice_payment", { p_payment: f.payment, p_reason: "Entered in error" })],
  ["confirm_invoice_payments", (c, f) => c.rpc("confirm_invoice_payments", { p_invoice: f.unverified, p_note: "Checked against the records" })],
  ["issue_invoice", (c, f) => c.rpc("issue_invoice", { p_invoice: f.draft })],
  ["create a draft invoice (create_with_lines)", (c) => c.rpc("create_with_lines", { p_parent: "invoices", p_header: header(), p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: line })],
  ["insert an invoice row", (c) => c.from("invoices").insert({ organization_id: org(), customer: "Direct Co" })],
  ["edit a draft invoice", (c, f) => c.from("invoices").update({ customer: "Renamed Co" }).eq("id", f.draft)],
  ["delete a draft invoice", (c, f) => c.from("invoices").delete().eq("id", f.draft)],
  ["send a quote (status update)", (c, f) => c.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", f.quote)],
  ["insert a quote row", (c) => c.from("quotes").insert({ organization_id: org(), quote_ref: `QUO-D${randomUUID().slice(0, 6)}`, customer: "Direct Co" })],
  ["issue a purchase order (status update)", (c, f) => c.from("purchase_orders").update({ status: "issued" }).eq("id", f.po)],
  ["insert a purchase order row", (c) => c.from("purchase_orders").insert({ organization_id: org(), po_ref: `PO-D${randomUUID().slice(0, 6)}`, supplier: "Steel Ltd", total_value: 1, status: "draft" })],
  ["convert_sales_order", (c, f) => c.rpc("convert_sales_order", { p_order: f.order })],
  ["change organisation settings", (c) => c.from("organization_settings").update({ hidden_nav: [] }).eq("organization_id", org())],
  ["set_member_access (role and access)", (c) => c.rpc("set_member_access", { p_user: world.tenants.alpha.users.office.id, p_role: "office", p_active: true })],
  ["change a profile", (c) => c.from("user_profiles").update({ full_name: "Renamed Office" }).eq("id", world.tenants.alpha.users.office.id)],
  ["reserve_mail_send", (c) => c.rpc("reserve_mail_send", { p_kind: "send", p_key: key(), p_recipients: ["x@example.test"], p_subject: "S", p_body: "B", p_rfq: null })],
  ["complete_mail_send", (c, f) => c.rpc("complete_mail_send", { p_id: f.send, p_outcome: "accepted" })],
  ["resolve_mail_send", (c, f) => c.rpc("resolve_mail_send", { p_id: f.unknownSend, p_as: "failed" })],
  ["save_mail_poll_state", (c) => c.rpc("save_mail_poll_state", { p_next_link: null, p_checkpoint: new Date().toISOString() })],
  ["record_inbound_email", (c) => c.rpc("record_inbound_email", { p_graph_message_id: `AAA-${randomUUID()}`, p_internet_message_id: null, p_from_address: "a@example.test", p_from_name: null, p_subject: "Re: RFQ", p_received_at: new Date().toISOString(), p_body_preview: "", p_body_text: "" })],
  ["reserve_job_email", (c, f) => c.rpc("reserve_job_email", { p_job: f.job, p_recipient: "buyer@example.test", p_subject: "S", p_body: "B", p_key: randomUUID(), p_mode: "sending" })],
  ["complete_job_email", (c, f) => c.rpc("complete_job_email", { p_history: f.history, p_outcome: "accepted" })],
  ["resolve_job_email", (c, f) => c.rpc("resolve_job_email", { p_history: f.unknownJob, p_as: "failed" })],
];

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  // A new purchase order names a supplier on the Suppliers list (082): the "insert a purchase order row" operation goes through at aal2.
  expect((await adminClient().from("suppliers").insert({ organization_id: world.tenants.alpha.id, name: "Steel Ltd" })).error).toBeNull();
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
const tokenAal = (c: SupabaseClient) => c.auth.getSession().then((s) => JSON.parse(Buffer.from(s.data.session!.access_token.split(".")[1], "base64url").toString()).aal as string);

describe("the tokens are what they say", () => {
  it("one is password-only, one has passed the second step", async () => {
    expect(await tokenAal(aal1)).toBe("aal1");
    expect(await tokenAal(aal2)).toBe("aal2");
  });
});

describe("company requires the second step: every privileged operation, called directly", () => {
  it("at aal1 each one is refused with mfa_required, and nothing is changed", async () => {
    const f = await fixtures();
    await setFlag(true);
    const before = await withDb(async (db) => (await db.query("select (select count(*)::int from public.invoice_payments) as payments, (select count(*)::int from public.invoices) as invoices, (select status from public.invoices where id = $1) as draft_status, (select status from public.quotes where id = $2) as quote, (select status from public.purchase_orders where id = $3) as po, (select count(*)::int from public.jobs where converted_from_sales_order_id = $4) as converted", [f.draft, f.quote, f.po, f.order])).rows[0]);
    for (const [name, call] of OPERATIONS) {
      const { error } = await call(aal1, f);
      expect({ name, code: error?.code, hint: error?.hint }).toEqual({ name, code: "42501", hint: "mfa_required" });
    }
    const after = await withDb(async (db) => (await db.query("select (select count(*)::int from public.invoice_payments) as payments, (select count(*)::int from public.invoices) as invoices, (select status from public.invoices where id = $1) as draft_status, (select status from public.quotes where id = $2) as quote, (select status from public.purchase_orders where id = $3) as po, (select count(*)::int from public.jobs where converted_from_sales_order_id = $4) as converted", [f.draft, f.quote, f.po, f.order])).rows[0]);
    expect(after).toEqual(before);
  });

  it("at aal2 each of the same calls goes through", async () => {
    await setFlag(true);
    for (const [name, call] of OPERATIONS) {
      const f = await fixtures();
      const { error } = await call(aal2, f);
      expect({ name, error: error?.message ?? null }).toEqual({ name, error: null });
    }
  });

  it("reading is not held back (the page gate and roles cover it), and other roles are not asked", async () => {
    await setFlag(true);
    expect((await aal1.from("invoices").select("id").limit(1)).error).toBeNull();
    const office = await signedInClient(world.tenants.alpha.users.office);
    expect((await office.from("customers").insert({ organization_id: org(), name: `Office Customer ${world.runId}` })).error).toBeNull();
    expect((await office.rpc("reserve_job_email", { p_job: (await adminClient().from("jobs").select("id").eq("organization_id", org()).limit(1).single()).data!.id, p_recipient: "buyer@example.test", p_subject: "S", p_body: "B", p_key: randomUUID(), p_mode: "sending" })).error).toBeNull();
  });

  it("the service role and the owner are not held to it (the importer and the app's server routes)", async () => {
    await setFlag(true);
    expect((await adminClient().from("organization_settings").update({ hidden_nav: [] }).eq("organization_id", org())).error).toBeNull();
    await withDb((db) => db.query("update public.invoices set customer = customer where organization_id = $1", [org()]));
  });
});

describe("the company does not require it: nothing changes", () => {
  it("an admin at aal1 does all of it as before", async () => {
    await setFlag(false);
    for (const [name, call] of OPERATIONS) {
      const f = await fixtures();
      const { error } = await call(aal1, f);
      expect({ name, error: error?.message ?? null }).toEqual({ name, error: null });
    }
  });

  it("another company's setting does not affect this one's admins", async () => {
    await setFlag(false);
    await setRequireAdminMfaForTest(world.tenants.beta.id, true);
    expect((await aal1.from("organization_settings").update({ hidden_nav: [] }).eq("organization_id", org())).error).toBeNull();
    await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = $1", [world.tenants.beta.id]));
  });
});
