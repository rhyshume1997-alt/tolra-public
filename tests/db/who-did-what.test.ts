/**
 * Who did what (migration 035, PR C): milestone actors set by the database from the session, created_by / updated_by rules,
 * protected actor fields, named events written with the action, re-send and reopen, company_people, the names-only record
 * history, and the backfill that fills only what the activity trail proves.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals } from "@/lib/money";

import { type SyntheticUser, type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let seq = 0;
const alpha = () => world.tenants.alpha;
const user = (role: "admin" | "office" | "workshop" | "viewer") => alpha().users[role].id;
const svc = () => adminClient();

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(alpha().users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  as.betaOffice = await signedInClient(world.tenants.beta.users.office);
  for (const role of ["office", "workshop"] as const) await svc().from("organization_members").update({ can_inspect: true }).eq("user_id", alpha().users[role].id).eq("organization_id", alpha().id);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const now = () => new Date().toISOString();

/** Records a passing inspection as `client` (needs the job's current version; office and workshop must be named inspectors). */
async function inspect(client: SupabaseClient, id: string, notes = "Bore 25.01") {
  const version = (await row("jobs", id)).worksheet_version as number;
  return recordInspection(client, { p_job: id, p_result: "pass", p_notes: notes, p_attachment_path: null, p_attachment_name: null, p_concession_reason: null, p_expected_version: version });
}
const lineOf = async (invoice: string) => (await svc().from("invoice_line_items").select("id").eq("invoice_id", invoice).limit(1).single()).data!.id as string;
const credit_ = async (client: SupabaseClient, invoice: string, quantity = 1) =>
  client.rpc("create_credit_note", { p_invoice: invoice, p_reason: null, p_credit_date: "2026-10-10", p_lines: [{ invoice_line_id: await lineOf(invoice), quantity }] });

async function job(extra: Record<string, unknown> = {}, org = alpha().id) {
  const { data, error } = await svc().from("jobs").insert({ organization_id: org, job_no: `J-WDW-${world.runId}-${++seq}`, customer: "Who Co", stage: "machining", quantity_required: 2, ...extra }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
const row = async (table: string, id: string) => (await svc().from(table).select("*").eq("id", id).single()).data as Record<string, unknown>;

async function draftInvoice(client: SupabaseClient = as.office) {
  const created = await client.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: "Who Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id",
    p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
  });
  if (created.error) throw new Error(created.error.message);
  return created.data as string;
}
async function issuedInvoice(client: SupabaseClient = as.office) {
  const id = await draftInvoice(client);
  const issued = await client.rpc("issue_invoice", { p_invoice: id });
  if (issued.error) throw new Error(issued.error.message);
  return id;
}
const pay = (client: SupabaseClient, id: string, amount: number) =>
  client.rpc("record_invoice_payment", { p_invoice: id, p_amount: amount, p_paid_on: "2026-10-10", p_method: "BACS", p_reference: null, p_request_id: randomUUID() });

async function sentQuote(client: SupabaseClient = as.office) {
  const lines = [{ quantity: 4, unitPrice: 25, vatPct: 20 }];
  const { data, error } = await client.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: `QUO-WDW-${world.runId}-${++seq}`, customer: "Who Co", total_value: documentTotals(lines).total, vat_enabled: true, status: "draft", valid_until: "2099-12-31", description: "Scope" },
    p_child: "quote_line_items", p_fk: "quote_id",
    p_lines: lines.map((l, position) => ({ position, description: "Bush", quantity: l.quantity, unit_price: l.unitPrice, vat_pct: 20, vat_exempt: false })),
  });
  if (error) throw new Error(error.message);
  return data as string;
}

type EventRow = { action: string; entity_table: string; entity_id: string; actor_user_id: string | null; metadata: Record<string, unknown> };
const events = (table: string, id: string, action?: string) =>
  withDb(async (db) => (await db.query<EventRow>(
    "select action, entity_table, entity_id, actor_user_id, metadata from security_audit.audit_log where entity_table = $1 and entity_id = $2 and metadata ->> 'source' = 'write_audit' and ($3::text is null or action = $3) order by created_at, id",
    [table, id, action ?? null])).rows);

/** Runs SQL as a signed-in user (the same role and claims PostgREST sets), then returns to the owner. */
async function actingAs(db: Client, who: SyntheticUser) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.id, role: "authenticated", email: who.email })]);
}

describe("company_people", () => {
  it("every role of the company sees its own members' display names, with only user_id and display_name", async () => {
    for (const role of ["admin", "office", "workshop", "viewer"] as const) {
      const { data, error } = await as[role].rpc("company_people");
      expect(error, role).toBeNull();
      const rows = data as Record<string, unknown>[];
      expect(rows.map((r) => Object.keys(r).sort())).toEqual(rows.map(() => ["display_name", "user_id"]));
      expect(Object.fromEntries(rows.map((r) => [r.user_id, r.display_name]))).toEqual({
        [user("admin")]: "Admin alpha", [user("office")]: "Office alpha", [user("workshop")]: "Workshop alpha", [user("viewer")]: "Viewer alpha",
      });
    }
  });

  it("never returns another company's people, e-mail addresses or usernames, and signed-out callers get nothing", async () => {
    const text = JSON.stringify((await as.office.rpc("company_people")).data);
    for (const u of Object.values(world.tenants.beta.users)) expect(text).not.toContain(u.id);
    for (const u of Object.values(alpha().users)) expect(text).not.toContain(u.email);
    expect(text).not.toContain("@");
    expect(text).not.toContain(world.tenants.beta.name);
    const beta = JSON.stringify((await as.betaAdmin.rpc("company_people")).data);
    expect(beta).toContain(world.tenants.beta.users.admin.id);
    for (const u of Object.values(alpha().users)) expect(beta).not.toContain(u.id);
    const { createClient } = await import("@supabase/supabase-js");
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await anon.rpc("company_people")).error).not.toBeNull();
  });

  it("a name that looks like an e-mail address, or no name, comes back as no name", async () => {
    const original = (await svc().from("user_profiles").select("full_name").eq("id", user("viewer")).single()).data!.full_name;
    try {
      await svc().from("user_profiles").update({ full_name: "viewer@example.test" }).eq("id", user("viewer"));
      let names = Object.fromEntries(((await as.workshop.rpc("company_people")).data as { user_id: string; display_name: string | null }[]).map((r) => [r.user_id, r.display_name]));
      expect(names[user("viewer")]).toBeNull();
      await svc().from("user_profiles").update({ full_name: null }).eq("id", user("viewer"));
      names = Object.fromEntries(((await as.workshop.rpc("company_people")).data as { user_id: string; display_name: string | null }[]).map((r) => [r.user_id, r.display_name]));
      expect(names[user("viewer")]).toBeNull();
    } finally {
      await svc().from("user_profiles").update({ full_name: original }).eq("id", user("viewer"));
    }
  });
});

describe("created_by and updated_by", () => {
  it("created_by is overwritten on insert with the signed-in user, whatever the client sent", async () => {
    const forged = world.tenants.beta.users.admin.id;
    const { data, error } = await as.office.from("customers").insert({ organization_id: alpha().id, name: `Forger ${world.runId}`, created_by: forged, updated_by: forged }).select("id, created_by, updated_by").single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ created_by: user("office"), updated_by: user("office") });
    // ... on the document tables too, through create_with_lines and through a direct insert.
    const invoice = await draftInvoice(as.office);
    expect(await row("invoices", invoice)).toMatchObject({ created_by: user("office") });
    const direct = await as.admin.from("jobs").insert({ organization_id: alpha().id, job_no: `J-FORGE-${world.runId}`, customer: "X", created_by: user("viewer") }).select("created_by").single();
    expect(direct.data).toMatchObject({ created_by: user("admin") });
  });

  it("updated_by follows the person who made the change; created_by never moves", async () => {
    const id = await job();
    expect(await row("jobs", id)).toMatchObject({ created_by: null, updated_by: null });
    expect((await as.workshop.from("jobs").update({ description: "First change" }).eq("id", id)).error).toBeNull();
    expect(await row("jobs", id)).toMatchObject({ updated_by: user("workshop"), created_by: null });
    expect((await as.office.from("jobs").update({ description: "Second change", created_by: user("office"), updated_by: user("admin") }).eq("id", id)).error).toBeNull();
    expect(await row("jobs", id)).toMatchObject({ updated_by: user("office"), created_by: null });
  });

  it("the service role and the database owner are exempt: they keep the values they write, and stamp nothing", async () => {
    const id = await job({ created_by: user("viewer"), updated_by: user("viewer"), started_at: now() });
    expect(await row("jobs", id)).toMatchObject({ created_by: user("viewer"), updated_by: user("viewer"), started_by: null });
    await svc().from("jobs").update({ description: "Importer edit", finished_at: now() }).eq("id", id);
    expect(await row("jobs", id)).toMatchObject({ updated_by: user("viewer"), finished_by: null });
    await withDb((db) => db.query("update public.jobs set started_by = $2 where id = $1", [id, user("admin")]));
    expect(await row("jobs", id)).toMatchObject({ started_by: user("admin") });
  });
});

describe("actor fields are set by the database and protected from the client", () => {
  it("an unrelated update (or an attempt to write them) leaves every actor field as it was; the update itself still goes through", async () => {
    const id = await job();
    expect((await as.workshop.from("jobs").update({ started_at: now() }).eq("id", id)).error).toBeNull();
    expect(await row("jobs", id)).toMatchObject({ started_by: user("workshop") });
    const attempt = await as.office.from("jobs").update({ description: "Edited", started_by: user("admin"), finished_by: user("admin"), inspected_by_user: user("admin"), created_by: user("admin") }).eq("id", id);
    expect(attempt.error).toBeNull();
    expect(await row("jobs", id)).toMatchObject({ description: "Edited", started_by: user("workshop"), finished_by: null, inspected_by_user: null, created_by: null });
    // Setting the milestone again by the same route is not a way to hand it to somebody else either.
    expect((await as.office.from("jobs").update({ started_at: "2026-10-01T09:00:00Z", started_by: user("admin") }).eq("id", id)).error).toBeNull();
    expect(await row("jobs", id)).toMatchObject({ started_by: user("office") });
  });

  it("jobs: start, finish and inspection record who, and clearing a time clears the person", async () => {
    const id = await job();
    await as.workshop.from("jobs").update({ started_at: now() }).eq("id", id);
    await as.office.from("jobs").update({ finished_at: now(), stage: "inspection" }).eq("id", id);
    expect(await row("jobs", id)).toMatchObject({ started_by: user("workshop"), finished_by: user("office"), inspected_by_user: null });
    const inspected = await inspect(as.admin, id, "Bore 25.01");
    expect(inspected.error).toBeNull();
    expect(await row("jobs", id)).toMatchObject({ inspected_by_user: user("admin"), inspected_by: "Admin alpha", started_by: user("workshop"), finished_by: user("office") });
    // A later worksheet change withdraws the sign-off (034) and the person with it.
    await as.workshop.from("jobs").update({ quantity_required: 7 }).eq("id", id);
    expect(await row("jobs", id)).toMatchObject({ inspected_at: null, inspected_by_user: null, finished_by: user("office") });
  });

  it("quotes: sent_by and accepted_by; the customer's decision on a draft leaves sent_by empty", async () => {
    const id = await sentQuote();
    expect(await row("quotes", id)).toMatchObject({ created_by: user("office"), sent_by: null, accepted_by: null });
    expect((await as.office.from("quotes").update({ status: "sent", sent_at: now() }).eq("id", id)).error).toBeNull();
    expect((await as.admin.from("quotes").update({ status: "accepted", accepted_at: now() }).eq("id", id)).error).toBeNull();
    expect(await row("quotes", id)).toMatchObject({ sent_by: user("office"), accepted_by: user("admin") });
    // Not writable once issued either: the lock refuses other changes, and the actor columns stay put.
    const other = await sentQuote();
    expect((await as.admin.from("quotes").update({ status: "accepted", accepted_at: now(), sent_by: user("viewer") }).eq("id", other)).error).toBeNull();
    expect(await row("quotes", other)).toMatchObject({ sent_by: null, accepted_by: user("admin") });
  });

  it("invoices: issued_by with a time, paid_by is whoever recorded the clearing payment, emailed_by with the send", async () => {
    const id = await draftInvoice(as.office);
    expect(await row("invoices", id)).toMatchObject({ issued_by: null, issued_at: null, paid_by: null });
    expect((await as.admin.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
    const issued = await row("invoices", id);
    expect(issued).toMatchObject({ issued_by: user("admin"), paid_by: null });
    expect(issued.issued_at).toBeTruthy();
    expect((await pay(as.office, id, 50)).error).toBeNull();
    expect((await row("invoices", id)).paid_by).toBeNull();
    expect((await pay(as.admin, id, 70)).error).toBeNull();
    expect(await row("invoices", id)).toMatchObject({ status: "paid", paid_by: user("admin"), issued_by: user("admin") });
    expect((await as.office.from("invoices").update({ sent_date: now() }).eq("id", id)).error).toBeNull();
    expect(await row("invoices", id)).toMatchObject({ emailed_by: user("office"), paid_by: user("admin") });
    // The payments themselves already name their recorders.
    const recorders = (await svc().from("invoice_payments").select("created_by, amount").eq("invoice_id", id).order("created_at")).data!;
    expect(recorders.map((r) => r.created_by)).toEqual([user("office"), user("admin")]);
    // Reversing the clearing payment takes the invoice out of paid, and the person with it.
    const clearing = (await svc().from("invoice_payments").select("id").eq("invoice_id", id).eq("amount", 70).single()).data!.id;
    expect((await as.admin.rpc("reverse_invoice_payment", { p_payment: clearing, p_reason: "Cheque bounced" })).error).toBeNull();
    expect(await row("invoices", id)).toMatchObject({ status: "partial", paid_by: null });
  });

  it("sales orders, purchase orders, delivery notes and credit notes", async () => {
    const order = (await svc().from("sales_orders").insert({ organization_id: alpha().id, so_number: `SO-WDW-${world.runId}`, customer: "Who Co", total_value: 10, status: "open" }).select("id").single()).data!.id as string;
    expect((await as.office.from("sales_orders").update({ status: "confirmed" }).eq("id", order)).error).toBeNull();
    expect(await row("sales_orders", order)).toMatchObject({ confirmed_by: user("office") });
    expect((await row("sales_orders", order)).confirmed_at).toBeTruthy();

    // A new purchase order names a supplier on the Suppliers list (082).
    expect((await svc().from("suppliers").insert({ organization_id: alpha().id, name: "Steel Ltd" })).error).toBeNull();
    const po = (await as.office.from("purchase_orders").insert({ organization_id: alpha().id, po_ref: `PO-WDW-${world.runId}`, supplier: "Steel Ltd", total_value: 5, status: "draft" }).select("id").single()).data!.id as string;
    expect((await as.office.from("purchase_orders").update({ status: "issued" }).eq("id", po)).error).toBeNull();
    expect((await as.admin.from("purchase_orders").update({ status: "received", received_at: now() }).eq("id", po)).error).toBeNull();
    expect(await row("purchase_orders", po)).toMatchObject({ created_by: user("office"), received_by: user("admin") });

    const dn = (await svc().from("delivery_notes").insert({ organization_id: alpha().id, dn_number: `DLN-WDW-${world.runId}`, customer: "Who Co", status: "awaiting", delivery_date: "2026-10-10" }).select("id").single()).data!.id as string;
    expect((await as.workshop.from("delivery_notes").update({ status: "despatched" }).eq("id", dn)).error).toBeNull();
    expect(await row("delivery_notes", dn)).toMatchObject({ despatched_by: user("workshop"), signed_recorded_by: null });
    expect((await as.office.from("delivery_notes").update({ status: "signed", signed_by_name: "J. Customer", signed_at: now() }).eq("id", dn)).error).toBeNull();
    // The customer's typed name is its own field, apart from the staff member who recorded the signature.
    expect(await row("delivery_notes", dn)).toMatchObject({ signed_by_name: "J. Customer", signed_recorded_by: user("office"), despatched_by: user("workshop") });
    expect((await as.admin.from("delivery_notes").update({ emailed_at: now() }).eq("id", dn)).error).toBeNull();
    expect(await row("delivery_notes", dn)).toMatchObject({ emailed_by: user("admin"), signed_by_name: "J. Customer" });
    // The customer's name can't be turned into a staff actor, nor the staff actor typed over by the client.
    await as.workshop.from("delivery_notes").update({ notes: "x", signed_recorded_by: user("workshop"), despatched_by: user("viewer") }).eq("id", dn);
    expect(await row("delivery_notes", dn)).toMatchObject({ signed_recorded_by: user("office"), despatched_by: user("workshop") });

    const invoice = await issuedInvoice(as.office);
    const credit = await credit_(as.office, invoice);
    expect(credit.error).toBeNull();
    const creditId = credit.data as string;
    expect(await row("credit_notes", creditId)).toMatchObject({ created_by: user("office"), issued_by: null });
    expect((await as.admin.rpc("issue_credit_note", { p_credit: creditId })).error).toBeNull();
    expect(await row("credit_notes", creditId)).toMatchObject({ issued_by: user("admin"), created_by: user("office") });
  });
});

describe("named events are written with the action", () => {
  it("ISSUE for an invoice and a credit note, once each, naming the person", async () => {
    const id = await issuedInvoice(as.admin);
    const issue = await events("invoices", id, "ISSUE");
    expect(issue).toHaveLength(1);
    expect(issue[0]).toMatchObject({ actor_user_id: user("admin"), metadata: { source: "write_audit" } });
    expect((await as.admin.rpc("issue_invoice", { p_invoice: id })).error).toBeNull(); // issuing again does nothing and says nothing
    expect(await events("invoices", id, "ISSUE")).toHaveLength(1);
    const credit = (await credit_(as.office, id)).data as string;
    await as.office.rpc("issue_credit_note", { p_credit: credit });
    expect(await events("credit_notes", credit, "ISSUE")).toHaveLength(1);
  });

  it("CONFIRM when a sales order is confirmed", async () => {
    const order = (await svc().from("sales_orders").insert({ organization_id: alpha().id, so_number: `SO-CF-${world.runId}`, customer: "Who Co", total_value: 10, status: "open" }).select("id").single()).data!.id as string;
    await as.office.from("sales_orders").update({ status: "confirmed" }).eq("id", order);
    expect(await events("sales_orders", order, "CONFIRM")).toEqual([expect.objectContaining({ actor_user_id: user("office") })]);
    await as.office.from("sales_orders").update({ notes: "No change of status" }).eq("id", order);
    expect(await events("sales_orders", order, "CONFIRM")).toHaveLength(1);
  });

  it("CONFIRM_STILL_OWED when an admin confirms an imported invoice with no payments, CONFIRM_PAYMENTS when it has some", async () => {
    const none = await issuedInvoice(as.admin);
    const some = await issuedInvoice(as.admin);
    await pay(as.admin, some, 20);
    await withDb((db) => db.query("update public.invoices set payment_unverified = true where id = any($1)", [[none, some]]));
    expect((await as.admin.rpc("confirm_invoice_payments", { p_invoice: none, p_note: "Nothing received" })).error).toBeNull();
    expect((await as.admin.rpc("confirm_invoice_payments", { p_invoice: some, p_note: "Part received" })).error).toBeNull();
    expect((await events("invoices", none)).map((e) => e.action)).toContain("CONFIRM_STILL_OWED");
    expect((await events("invoices", none)).map((e) => e.action)).not.toContain("CONFIRM_PAYMENTS");
    expect((await events("invoices", some)).map((e) => e.action)).toContain("CONFIRM_PAYMENTS");
    expect((await events("invoices", some)).map((e) => e.action)).not.toContain("CONFIRM_STILL_OWED");
  });

  it("MARK_PAID is one event per invoice, each naming that invoice alone, also when several are paid in a row", async () => {
    const ids = [await issuedInvoice(as.office), await issuedInvoice(as.office), await issuedInvoice(as.office)];
    for (const id of ids) expect((await pay(as.office, id, 120)).error).toBeNull(); // what "pay in full" on a selection does
    const all = await withDb(async (db) => (await db.query<{ entity_id: string }>("select entity_id from security_audit.audit_log where action = 'MARK_PAID' and entity_id = any($1)", [ids])).rows);
    expect(all.map((r) => r.entity_id).sort()).toEqual([...ids].sort());
    expect(all.every((r) => !r.entity_id.includes(","))).toBe(true);
    for (const id of ids) {
      expect(await events("invoices", id, "MARK_PAID")).toEqual([expect.objectContaining({ actor_user_id: user("office"), metadata: expect.objectContaining({ invoice_ref: expect.any(String) }) })]);
      expect((await events("invoices", id, "RECORD_PAYMENT")).length).toBe(1);
    }
    // A part payment is not a MARK_PAID.
    const part = await issuedInvoice(as.office);
    await pay(as.office, part, 20);
    expect(await events("invoices", part, "MARK_PAID")).toHaveLength(0);
    // And the history of one invoice lists its own.
    const history = (await as.office.rpc("record_activity", { p_table: "invoices", p_id: ids[0] })).data as { action: string }[];
    expect(history.filter((h) => h.action === "MARK_PAID")).toHaveLength(1);
  });

  it("a client can't make up a payment event: refused for every role, whatever the entity id", async () => {
    const a = await issuedInvoice(as.office);
    const b = await issuedInvoice(as.office);
    for (const action of ["MARK_PAID", "RECORD_PAYMENT", "REVERSE_PAYMENT", "CONFIRM_PAYMENTS", "CONFIRM_STILL_OWED", "APPLY_CREDIT", "REFUND_CUSTOMER_CREDIT"]) {
      for (const role of ["admin", "office", "workshop", "viewer"] as const) {
        for (const id of [a, `${a},${b}`]) {
          const forged = await as[role].rpc("write_audit", { p_action: action, p_entity_table: "invoices", p_entity_id: id, p_old: null, p_new: null, p_metadata: {}, p_ip: null, p_user_agent: null });
          expect({ action, role, refused: forged.error !== null }).toEqual({ action, role, refused: true });
        }
      }
    }
    expect(await events("invoices", a, "MARK_PAID")).toHaveLength(0);
    // An ordinary event still goes through.
    expect((await as.office.rpc("write_audit", { p_action: "SEND", p_entity_table: "invoices", p_entity_id: a, p_old: null, p_new: null, p_metadata: {}, p_ip: null, p_user_agent: null })).error).toBeNull();
  });

  it("the event commits or rolls back together with the action", async () => {
    const order = (await svc().from("sales_orders").insert({ organization_id: alpha().id, so_number: `SO-AT-${world.runId}`, customer: "Who Co", total_value: 10, status: "open" }).select("id").single()).data!.id as string;
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await actingAs(db, alpha().users.office);
        await db.query("update public.sales_orders set status = 'confirmed' where id = $1", [order]);
        await db.query("reset role");
        // Inside the transaction the action and its event are both there ...
        expect((await db.query("select count(*)::int as n from security_audit.audit_log where action = 'CONFIRM' and entity_id = $1", [order])).rows[0].n).toBe(1);
        expect((await db.query("select status, confirmed_by from public.sales_orders where id = $1", [order])).rows[0]).toEqual({ status: "confirmed", confirmed_by: user("office") });
      } finally {
        await db.query("rollback");
      }
    });
    // ... and when the action is rolled back, neither remains.
    expect(await events("sales_orders", order, "CONFIRM")).toHaveLength(0);
    expect(await row("sales_orders", order)).toMatchObject({ status: "open", confirmed_by: null });
    // A statement that fails after the trigger (the status check) leaves no event either.
    const failing = await as.office.from("sales_orders").update({ status: "confirmed", total_value: -1 }).eq("id", order);
    if (failing.error) expect(await events("sales_orders", order, "CONFIRM")).toHaveLength(0);
  });
});

describe("re-send and reopen", () => {
  it("re-sending a quote makes the latest sender the sender, logs RESEND naming the earlier one, and keeps the original in the trail", async () => {
    const id = await sentQuote();
    const first = "2026-10-01T09:00:00Z";
    await as.office.from("quotes").update({ status: "sent", sent_at: first }).eq("id", id);
    expect(await row("quotes", id)).toMatchObject({ sent_by: user("office") });
    expect(await events("quotes", id, "RESEND")).toHaveLength(0); // the first send is not a re-send
    expect((await as.admin.from("quotes").update({ status: "sent", sent_at: "2026-10-05T09:00:00Z" }).eq("id", id)).error).toBeNull();
    expect(await row("quotes", id)).toMatchObject({ sent_by: user("admin"), status: "sent" });
    const resend = await events("quotes", id, "RESEND");
    expect(resend).toHaveLength(1);
    expect(resend[0]).toMatchObject({ actor_user_id: user("admin"), metadata: { previous_by: user("office") } });
    expect(String(resend[0].metadata.previous_at)).toContain("2026-10-01");
    // The row-change history still holds the first send, by the first sender.
    const trail = await withDb(async (db) => (await db.query<{ sent_by: string | null; actor_user_id: string | null }>(
      "select new_data ->> 'sent_by' as sent_by, actor_user_id from security_audit.audit_log where entity_table = 'quotes' and entity_id = $1 and action = 'UPDATE' and new_data ->> 'sent_by' is not null order by created_at, id", [id])).rows);
    expect(trail[0]).toEqual({ sent_by: user("office"), actor_user_id: user("office") });
    // The people view of the history names them both and shows the event.
    const history = (await as.workshop.rpc("record_activity", { p_table: "quotes", p_id: id })).error;
    expect(history).not.toBeNull(); // workshop can't open quotes at all (unchanged)
    const seen = (await as.office.rpc("record_activity", { p_table: "quotes", p_id: id })).data as { action: string; actor_name: string }[];
    expect(seen.find((h) => h.action === "RESEND")).toMatchObject({ actor_name: "Admin alpha" });
  });

  it("re-sending an invoice: emailed_by follows the latest sender and RESEND is logged", async () => {
    const id = await issuedInvoice(as.office);
    await as.office.from("invoices").update({ sent_date: "2026-10-01T09:00:00Z" }).eq("id", id);
    expect(await events("invoices", id, "RESEND")).toHaveLength(0);
    await as.admin.from("invoices").update({ sent_date: "2026-10-06T09:00:00Z" }).eq("id", id);
    expect(await row("invoices", id)).toMatchObject({ emailed_by: user("admin") });
    expect(await events("invoices", id, "RESEND")).toEqual([expect.objectContaining({ actor_user_id: user("admin"), metadata: expect.objectContaining({ previous_by: user("office") }) })]);
  });

  it("reopening a job clears finished_by and the inspection sign-off, returns it to machining, and logs REOPEN", async () => {
    const id = await job();
    await as.workshop.from("jobs").update({ started_at: now() }).eq("id", id);
    await as.workshop.from("jobs").update({ finished_at: now(), stage: "inspection" }).eq("id", id);
    expect((await inspect(as.office, id, "Bore 25.01")).error).toBeNull();
    expect(await row("jobs", id)).toMatchObject({ stage: "complete", finished_by: user("workshop"), inspected_by_user: user("office") });
    // 081: a Finish is kept unless the job is reopened with a reason (reopen_job); editing the job can't clear it.
    expect((await as.admin.from("jobs").update({ finished_at: null }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await as.admin.rpc("reopen_job", { p_job: id, p_reason: "Customer changed the finish spec" })).error).toBeNull();
    expect(await row("jobs", id)).toMatchObject({ finished_at: null, finished_by: null, inspected_at: null, inspected_by: null, inspected_by_user: null, stage: "machining", started_by: user("workshop") });
    const reopen = await events("jobs", id, "REOPEN");
    expect(reopen).toHaveLength(1);
    expect(reopen[0]).toMatchObject({ actor_user_id: user("admin"), metadata: { previous_finished_by: user("workshop"), sign_off_withdrawn: true } });
    // Finishing it again records whoever finishes it now; reopening an unfinished job logs nothing.
    await as.office.from("jobs").update({ finished_at: now(), stage: "inspection" }).eq("id", id);
    expect(await row("jobs", id)).toMatchObject({ finished_by: user("office") });
    await as.office.from("jobs").update({ description: "Edited" }).eq("id", id);
    expect(await events("jobs", id, "REOPEN")).toHaveLength(1);
  });
});

describe("the record history shows names only", () => {
  it("record_activity returns no e-mail address, names people by display name, and says System or nothing otherwise", async () => {
    const id = await job();
    await as.workshop.from("jobs").update({ description: "By the workshop" }).eq("id", id);
    await as.office.from("jobs").update({ description: "By the office" }).eq("id", id);
    await svc().from("jobs").update({ description: "By an import" }).eq("id", id);
    for (const role of ["admin", "office", "workshop", "viewer"] as const) {
      const { data, error } = await as[role].rpc("record_activity", { p_table: "jobs", p_id: id });
      expect(error, role).toBeNull();
      const rows = data as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(2);
      for (const r of rows) expect(r.actor_email ?? null).toBeNull();
      const text = JSON.stringify(rows);
      for (const u of [...Object.values(alpha().users), ...Object.values(world.tenants.beta.users)]) expect(text).not.toContain(u.email);
      const names = rows.map((r) => r.actor_name);
      expect(names).toContain("Workshop alpha");
      expect(names).toContain("Office alpha");
      expect(names).toContain("System");
    }
    // A person without a usable name is not replaced by their e-mail address.
    const original = (await svc().from("user_profiles").select("full_name").eq("id", user("workshop")).single()).data!.full_name;
    try {
      await svc().from("user_profiles").update({ full_name: null }).eq("id", user("workshop"));
      const rows = (await as.viewer.rpc("record_activity", { p_table: "jobs", p_id: id })).data as { actor_name: string | null }[];
      expect(rows.map((r) => r.actor_name)).not.toContain("Workshop alpha");
      expect(JSON.stringify(rows)).not.toContain(alpha().users.workshop.email);
      expect(rows.some((r) => r.actor_name === null)).toBe(true);
    } finally {
      await svc().from("user_profiles").update({ full_name: original }).eq("id", user("workshop"));
    }
  });

  it("the actor columns don't appear as changes in the history", async () => {
    const id = await job();
    await as.workshop.from("jobs").update({ started_at: now() }).eq("id", id);
    const rows = (await as.office.rpc("record_activity", { p_table: "jobs", p_id: id })).data as { changes: Record<string, unknown> | null }[];
    const keys = rows.flatMap((r) => Object.keys(r.changes ?? {}));
    expect(keys).toContain("started_at");
    expect(keys.filter((k) => /_by$|inspected_by_user/.test(k))).toEqual([]);
  });
});

describe("no e-mail address anywhere for an inspector with no name", () => {
  it("record_activity, org_activity, company_people and direct reads never carry an address, as any role", async () => {
    const original = (await svc().from("user_profiles").select("full_name").eq("id", user("workshop")).single()).data!.full_name;
    const id = await job({ stage: "inspection", started_at: now(), finished_at: now() });
    try {
      await svc().from("user_profiles").update({ full_name: null }).eq("id", user("workshop"));
      expect((await inspect(as.workshop, id, "Bore 25.01")).error).toBeNull();
      const emails = [...Object.values(alpha().users), ...Object.values(world.tenants.beta.users)].map((u) => u.email);
      const reads: Record<string, unknown> = {};
      for (const role of ["admin", "office", "workshop", "viewer"] as const) {
        reads[`${role} record_activity`] = (await as[role].rpc("record_activity", { p_table: "jobs", p_id: id })).data;
        reads[`${role} company_people`] = (await as[role].rpc("company_people")).data;
        reads[`${role} job`] = (await as[role].from("jobs").select("*").eq("id", id)).data;
        reads[`${role} inspections`] = (await as[role].from("job_inspections").select("*").eq("job_id", id)).data;
      }
      reads["admin org_activity"] = (await as.admin.rpc("org_activity", { p_from: null, p_to: null, p_actor: null, p_table: "jobs", p_before: null, p_before_id: null, p_limit: 200 })).data;
      for (const [name, data] of Object.entries(reads)) {
        const text = JSON.stringify(data);
        expect({ name, hasData: text.length > 4 }).toEqual({ name, hasData: true });
        for (const email of emails) expect({ name, leaks: text.includes(email) }).toEqual({ name, leaks: false });
      }
      const activity = reads["admin org_activity"] as { actor_email: string | null }[];
      expect(activity.every((r) => r.actor_email === null)).toBe(true);
    } finally {
      await svc().from("user_profiles").update({ full_name: original }).eq("id", user("workshop"));
    }
  });
});

describe("backfill", () => {
  const migration = readFileSync(path.resolve(__dirname, "../../supabase/migrations/035_who_did_what.sql"), "utf8");
  const section = migration.slice(migration.indexOf("-- ---- 6. Backfill"), migration.indexOf("-- Check. Expect"));

  /** An audit row the database would have written for a change made by `by` (null: nobody signed in). */
  const audit = (db: Client, table: string, id: string, org: string, by: string | null, oldData: object | null, newData: object, source = "database_trigger") =>
    db.query(
      "insert into security_audit.audit_log (organization_id, actor_user_id, action, entity_table, entity_id, old_data, new_data, metadata) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [org, by, oldData ? "UPDATE" : "INSERT", table, id, oldData ? JSON.stringify(oldData) : null, JSON.stringify(newData), JSON.stringify({ source })]);

  it("fills an actor only where exactly one signed-in member's change produced the value, and leaves every other row empty", async () => {
    const t = "2026-09-01T08:00:00+00:00";
    await withDb(async (db) => {
      await db.query("begin");
      try {
        const org = alpha().id;
        const mk = async (extra = "") => (await db.query<{ id: string }>(`insert into public.jobs (organization_id, job_no, customer, started_at ${extra ? "," + extra.split("=")[0] : ""}) values ($1, $2, 'Backfill Co', $3 ${extra ? "," + extra.split("=")[1] : ""}) returning id`, [org, `J-BF-${randomUUID().slice(0, 8)}`, t])).rows[0].id;
        const proven = await mk();       // one change, by an office member
        const twice = await mk();        // two different people each produced the same value
        const stranger = await mk();     // the one change was by someone outside the company
        const unsigned = await mk();     // the one change was made by nobody signed in
        const wrongValue = await mk();   // the change recorded a different time than the one on the row
        const nothing = await mk();      // no history at all
        const eventOnly = await mk();    // only an app-written event, not a row change
        const change = (id: string) => ({ id, started_at: t });
        await audit(db, "jobs", proven, org, user("office"), { id: proven, started_at: null }, change(proven));
        await audit(db, "jobs", twice, org, user("office"), { id: twice, started_at: null }, change(twice));
        await audit(db, "jobs", twice, org, user("admin"), { id: twice, started_at: "2026-08-01T00:00:00+00:00" }, change(twice));
        await audit(db, "jobs", stranger, org, world.tenants.beta.users.admin.id, { id: stranger, started_at: null }, change(stranger));
        await audit(db, "jobs", unsigned, org, null, { id: unsigned, started_at: null }, change(unsigned));
        await audit(db, "jobs", wrongValue, org, user("office"), { id: wrongValue, started_at: null }, { id: wrongValue, started_at: "2026-09-02T08:00:00+00:00" });
        await audit(db, "jobs", eventOnly, org, user("office"), null, change(eventOnly), "write_audit");
        // Status milestones and the clearing payment.
        const inv = async (status: string, total = 100) => (await db.query<{ id: string }>("insert into public.invoices (organization_id, customer, status, invoice_ref, total, subtotal, amount_paid) values ($1, 'Backfill Co', $2, $3, $4, $4, 0) returning id", [org, status, `INV-BF-${randomUUID().slice(0, 8)}`, total])).rows[0].id;
        const issuedOnce = await inv("issued");
        const issuedTwice = await inv("issued");
        await audit(db, "invoices", issuedOnce, org, user("admin"), { id: issuedOnce, status: "draft" }, { id: issuedOnce, status: "issued" });
        await audit(db, "invoices", issuedTwice, org, user("admin"), { id: issuedTwice, status: "draft" }, { id: issuedTwice, status: "issued" });
        await audit(db, "invoices", issuedTwice, org, user("office"), { id: issuedTwice, status: "draft" }, { id: issuedTwice, status: "issued" });
        const paidTwoPayments = await inv("paid", 100);
        await db.query("update public.invoices set amount_paid = 100 where id = $1", [paidTwoPayments]);
        await db.query("insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, source, created_by, created_at, request_id) values ($1, $2, 40, '2026-09-01', 'recorded', $3, '2026-09-01 09:00+00', $5), ($1, $2, 60, '2026-09-02', 'recorded', $4, '2026-09-02 09:00+00', $6)",
          [org, paidTwoPayments, user("office"), user("admin"), randomUUID(), randomUUID()]);
        const paidLegacy = await inv("paid", 100);
        await db.query("insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, source, created_by) values ($1, $2, 100, '2026-09-01', 'legacy', $3)", [org, paidLegacy, user("office")]);
        // A released job whose single release record names an inspector.
        const released = await mk();
        await db.query("update public.jobs set inspected_at = '2026-09-03 10:00+00', inspected_by = 'x', finished_at = '2026-09-03 09:00+00' where id = $1", [released]);
        await db.query("insert into public.job_inspections (organization_id, job_id, result, release_decision, measured_notes, inspector_id, inspector_name, inspected_at, worksheet_version) values ($1, $2, 'pass', 'released', 'ok', $3, 'Workshop alpha', '2026-09-03 10:00+00', 1)", [org, released, user("workshop")]);

        await db.query(section);

        const jobsAfter = Object.fromEntries((await db.query<{ id: string; started_by: string | null }>("select id, started_by from public.jobs where id = any($1)", [[proven, twice, stranger, unsigned, wrongValue, nothing, eventOnly]])).rows.map((r) => [r.id, r.started_by]));
        expect(jobsAfter).toEqual({ [proven]: user("office"), [twice]: null, [stranger]: null, [unsigned]: null, [wrongValue]: null, [nothing]: null, [eventOnly]: null });
        const invoices = Object.fromEntries((await db.query<{ id: string; issued_by: string | null; issued_at: Date | null; paid_by: string | null }>("select id, issued_by, issued_at, paid_by from public.invoices where id = any($1)", [[issuedOnce, issuedTwice, paidTwoPayments, paidLegacy]])).rows.map((r) => [r.id, r]));
        expect(invoices[issuedOnce]).toMatchObject({ issued_by: user("admin") });
        expect(invoices[issuedOnce].issued_at).not.toBeNull();
        expect(invoices[issuedTwice]).toMatchObject({ issued_by: null, issued_at: null });
        expect(invoices[paidTwoPayments].paid_by).toBe(user("admin"));
        expect(invoices[paidLegacy].paid_by).toBeNull();
        expect((await db.query("select inspected_by_user from public.jobs where id = $1", [released])).rows[0].inspected_by_user).toBe(user("workshop"));
        // Running it again changes nothing, and never overwrites a recorded actor.
        await db.query("update public.jobs set started_by = $2 where id = $1", [proven, user("viewer")]);
        await db.query(section);
        expect((await db.query("select started_by from public.jobs where id = $1", [proven])).rows[0].started_by).toBe(user("viewer"));
      } finally {
        await db.query("rollback");
      }
    });
  });

  it("the verify script counts what was filled and what was left blank", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/who_did_what_035.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    expect(rows.slice(0, 5).map((r) => r.value)).toEqual(["true", "true", "true", "true", "true"]);
    expect(rows[5]).toMatchObject({ n: 6, expected: "0" });
    const counts = rows.filter((r) => r.expected === "informational");
    expect(counts).toHaveLength(14);
    for (const c of counts) expect(c.value).toMatch(/^\d+ recorded \/ \d+ blank$/);
    expect(rows.filter((r) => r.n >= 21).map((r) => [r.n, r.value, r.expected])).toEqual([[21, "0", "0"], [22, "true", "true"]]);
  });
});

describe("an upgrade with e-mail addresses already stored as inspectors' names", () => {
  const migration = readFileSync(path.resolve(__dirname, "../../supabase/migrations/035_who_did_what.sql"), "utf8");
  const section = migration.slice(migration.indexOf("-- ---- 7. No e-mail address as an inspector"), migration.indexOf("-- Check. Expect"));

  it("sanitises them, adds the no-@ rules to the existing tables, and no read of the history returns an @ for any role", async () => {
    await withDb(async (db) => {
      await db.query("begin");
      try {
        const org = alpha().id;
        // The state before this release: no rule on either column (also the one 034's CREATE TABLE carries), and addresses in both.
        const rules = (await db.query<{ table: string; name: string }>(`
          select conrelid::regclass::text as table, conname as name from pg_constraint
          where contype = 'c' and conrelid in ('public.job_inspections'::regclass, 'public.jobs'::regclass)
            and (pg_get_constraintdef(oid) like '%inspector_name%' or pg_get_constraintdef(oid) like '%inspected_by%')`)).rows;
        expect(rules.map((r) => r.name)).toEqual(expect.arrayContaining(["job_inspections_inspector_name_no_email", "jobs_inspected_by_no_email"]));
        for (const r of rules) await db.query(`alter table ${r.table} drop constraint ${r.name}`);
        // Nor 081's record rule: on every real upgrade this section runs before 081 (files apply in number order), when job_inspections
        // has no job_inspections_immutable trigger. It is switched off for this replay only, inside this transaction (rolled back below),
        // and switched back on after it to show 081's rule on top.
        await db.query("alter table public.job_inspections disable trigger job_inspections_immutable");
        const adminEmail = alpha().users.admin.email;
        const job = (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer, started_at, finished_at, inspected_at, inspected_by, inspected_by_user, stage) values ($1, $2, 'Upgrade Co', now(), now(), now(), $3, $4, 'complete') returning id",
          [org, `J-UP-${randomUUID().slice(0, 8)}`, adminEmail, user("admin")])).rows[0].id;
        const stranger = (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer, inspected_at, inspected_by, stage) values ($1, $2, 'Upgrade Co', now(), 'someone.left@example.test', 'complete') returning id", [org, `J-UP-${randomUUID().slice(0, 8)}`])).rows[0].id;
        await db.query("insert into public.job_inspections (organization_id, job_id, result, release_decision, measured_notes, inspector_id, inspector_name, inspected_at, worksheet_version) values ($1, $2, 'pass', 'released', 'ok', $3, $4, now(), 1), ($1, $2, 'pass', 'released', 'ok', null, 'gone.person@example.test', now(), 1)",
          [org, job, user("admin"), adminEmail]);
        // History written by the old code: the address in a row change, in an app event's metadata, and inside longer text.
        await db.query("insert into security_audit.audit_log (organization_id, actor_user_id, action, entity_table, entity_id, old_data, new_data, metadata) values ($1, $2, 'UPDATE', 'jobs', $3, $4, $5, $6)",
          [org, user("admin"), job, JSON.stringify({ id: job, inspected_by: null, notes: "a" }), JSON.stringify({ id: job, inspected_by: adminEmail, notes: "Checked with someone.left@example.test today" }), JSON.stringify({ source: "database_trigger" })]);
        await db.query("insert into security_audit.audit_log (organization_id, actor_user_id, action, entity_table, entity_id, metadata) values ($1, $2, 'INSPECT_JOB', 'jobs', $3, $4)",
          [org, user("admin"), job, JSON.stringify({ source: "write_audit", inspector: "gone.person@example.test", by: [adminEmail] })]);

        await db.query(section);

        expect((await db.query("select count(*)::int as n from public.job_inspections where position('@' in inspector_name) > 0")).rows[0].n).toBe(0);
        expect((await db.query("select count(*)::int as n from public.jobs where position('@' in inspected_by) > 0")).rows[0].n).toBe(0);
        expect((await db.query("select inspector_name from public.job_inspections where job_id = $1 order by inspector_id nulls last", [job])).rows.map((r) => r.inspector_name)).toEqual(["Admin alpha", "Inspector"]);
        expect((await db.query("select inspected_by from public.jobs where id = any($1) order by (id = $2) desc", [[job, stranger], job])).rows.map((r) => r.inspected_by)).toEqual(["Admin alpha", "Inspector"]);
        // The rules are on the existing tables now: an address is refused with the database's own code and reason.
        await db.query("savepoint s");
        await expect(db.query("update public.job_inspections set inspector_name = 'x@example.test' where job_id = $1", [job])).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("job_inspections_inspector_name_no_email") });
        await db.query("rollback to savepoint s");
        await expect(db.query("update public.jobs set inspected_by = 'x@example.test' where id = $1", [job])).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("jobs_inspected_by_no_email") });
        await db.query("rollback to savepoint s");
        // Running it again changes nothing.
        await db.query(section);
        // With 081 on top, the record can't be changed at all: the same address is refused before the rule is reached.
        await db.query("alter table public.job_inspections enable trigger job_inspections_immutable");
        await db.query("savepoint s81");
        await expect(db.query("update public.job_inspections set inspector_name = 'x@example.test' where job_id = $1", [job])).rejects.toMatchObject({ code: "42501", hint: "record_immutable" });
        await db.query("rollback to savepoint s81");

        // Reading the history as each role: no @ anywhere; the admin's address shows as the admin's name, the others as a dash.
        for (const role of ["admin", "office", "workshop", "viewer"] as const) {
          await db.query("set role authenticated");
          await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user(role), role: "authenticated", aal: "aal1" })]);
          const rows = (await db.query("select changes, snapshot, metadata, actor_name, actor_email from public.record_activity('jobs', $1, 50)", [job])).rows;
          expect({ role, rows: rows.length > 0 }).toEqual({ role, rows: true });
          expect({ role, at: JSON.stringify(rows).includes("@") }).toEqual({ role, at: false });
          const change = rows.find((r) => r.changes?.inspected_by);
          expect({ role, to: change?.changes.inspected_by.to }).toEqual({ role, to: "Admin alpha" });
          if (role === "admin") {
            expect(JSON.stringify(rows)).toContain("Checked with — today");
            const all = (await db.query("select changes, snapshot, metadata, record_label from public.org_activity(null, null, null, 'jobs', null, null, 500)")).rows;
            expect(JSON.stringify(all).includes("@")).toBe(false);
          }
          await db.query("reset role");
        }
      } finally {
        await db.query("rollback");
      }
    });
  });
});
