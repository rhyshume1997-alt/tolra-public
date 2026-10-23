/**
 * Migration 059: a delivery note marked sent out makes a DRAFT invoice by itself (Rhys, 15 Oct 2026). Drafts are never issued
 * automatically; internal jobs are never invoiced; a failure to draft never blocks the despatch; every sent-out note on no live invoice
 * is listed by uninvoiced_delivery_notes() with the reason.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals } from "@/lib/money";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let n = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const LINES = [
  { description: "Flange 80mm", quantity: 12, unit_price: 150, vat_pct: 20, vat_exempt: false },
  { description: "Spacer", quantity: 4, unit_price: 2.5, vat_pct: 0, vat_exempt: false },
  { description: "Bush 25mm", quantity: 7, unit_price: 14.29, vat_pct: 20, vat_exempt: false },
];
const TOTALS = documentTotals(LINES.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, vatPct: l.vat_pct })), 0, { vatEnabled: true });

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** An accepted quote with LINES and an open order for it, made with the service role (as despatch-invoicing.test.ts does). */
async function order(customer = `Auto Co ${world.runId}`, org = world.tenants.alpha.id) {
  n += 1;
  const service = adminClient();
  const quote = (await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-AUTO-${world.runId}-${n}`, customer, status: "draft", total_value: 0 }).select("id").single()).data!;
  expect((await service.from("quote_line_items").insert(LINES.map((l, position) => ({ ...l, position, quote_id: quote.id, organization_id: org })))).error).toBeNull();
  expect((await service.from("quotes").update({ total_value: TOTALS.total, vat_enabled: true }).eq("id", quote.id)).error).toBeNull();
  expect((await service.from("quotes").update({ status: "accepted" }).eq("id", quote.id)).error).toBeNull();
  const so = await service.from("sales_orders").insert({
    organization_id: org, so_number: `PO-AUTO-${world.runId}-${n}`, customer_po: `PO-AUTO-${world.runId}-${n}`, customer, quote_id: quote.id, total_value: TOTALS.subtotal, vat_enabled: true, status: "open",
  }).select("id").single();
  if (so.error) throw new Error(so.error.message);
  return so.data.id as string;
}

type Line = { line_id: string; line_position: number };
/** A note from the order (office), picks = [line index, quantity][]; still awaiting. */
async function note(orderId: string, picks: [number, number][], client: SupabaseClient = as.office) {
  const { data: all, error } = await client.rpc("despatch_lines", { p_order: orderId, p_job: null });
  if (error) throw new Error(error.message);
  const made = await client.rpc("create_delivery_note", {
    p_order: orderId, p_job: null, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: "Own van", p_notes: null,
    p_lines: picks.map(([index, quantity]) => ({ line_id: (all as Line[])[index].line_id, quantity })),
  });
  if (made.error) throw new Error(made.error.message);
  return made.data.id as string;
}
const ALL: [number, number][] = [[0, 12], [1, 4], [2, 7]];

const sendOut = (id: string, client: SupabaseClient, status = "despatched") => client.from("delivery_notes").update({ status }).eq("id", id).select("id");
const noteRow = async (id: string) => (await adminClient().from("delivery_notes").select("status, invoice_id").eq("id", id).single()).data!;
const invoiceOf = async (id: string) => {
  const { invoice_id } = await noteRow(id);
  if (!invoice_id) return null;
  return (await adminClient().from("invoices").select("id, status, invoice_ref, subtotal, vat, total, customer, due_date, invoice_date, terms, created_by").eq("id", invoice_id).single()).data!;
};
const events = async (id: string) => (await adminClient().from("invoice_queue_events").select("cause, outcome, invoice_id, error_code, error_message").eq("delivery_note_id", id).order("created_at")).data!;
const invoicesFor = async (customer: string) => (await adminClient().from("invoices").select("id, status, invoice_ref, subtotal, vat, total").eq("customer", customer)).data!;
type Backlog = { delivery_note_id: string; dn_number: string; reason: string; detail: string; invoiceable: boolean; voided_invoice_ref: string | null; failed_at: string | null };
async function backlog(client: SupabaseClient = as.office) {
  const { data, error } = await client.rpc("uninvoiced_delivery_notes");
  if (error) throw new Error(error.message);
  return data as Backlog[];
}
const listed = async (id: string, client: SupabaseClient = as.office) => (await backlog(client)).find((row) => row.delivery_note_id === id);
const invoiceFrom = (client: SupabaseClient, ids: string[]) => client.rpc("create_invoice_from_delivery_notes", { p_notes: ids, p_invoice_date: TODAY, p_due_date: "2099-02-01", p_terms: "30 days" });

describe("marking a note sent out", () => {
  it("makes exactly one draft at the order's prices, by the workshop too; never issued; sending or updating again adds nothing", async () => {
    const customer = `Once Co ${world.runId}`;
    const id = await note(await order(customer), ALL);
    expect(await invoiceOf(id)).toBeNull();
    expect((await sendOut(id, as.workshop)).data).toHaveLength(1);

    const invoice = await invoiceOf(id);
    expect(invoice).toMatchObject({ status: "draft", invoice_ref: null, customer, subtotal: TOTALS.subtotal, vat: TOTALS.vat, total: TOTALS.total, created_by: world.tenants.alpha.users.workshop.id });
    expect(invoice!.due_date >= invoice!.invoice_date).toBe(true);
    expect(invoice!.terms).toBeTruthy();
    const lines = (await adminClient().from("invoice_line_items").select("description, quantity, unit_price").eq("invoice_id", invoice!.id).order("position")).data;
    expect(lines).toEqual(LINES.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price })));
    expect(await events(id)).toEqual([{ cause: "sent_out", outcome: "drafted", invoice_id: invoice!.id, error_code: null, error_message: null }]);

    // Delivered, signed, e-mailed, sent again: nothing more.
    expect((await sendOut(id, as.office, "delivered")).data).toHaveLength(1);
    expect((await as.workshop.from("delivery_notes").update({ status: "signed", signed_by_name: "A. Driver", signed_at: new Date().toISOString() }).eq("id", id).select("id")).data).toHaveLength(1);
    expect((await as.office.from("delivery_notes").update({ emailed_at: new Date().toISOString() }).eq("id", id).select("id")).data).toHaveLength(1);
    expect(await invoicesFor(customer)).toHaveLength(1);
    expect(await events(id)).toHaveLength(1);
    // Not in the backlog (it is on a live draft); the manual path refuses it as already invoiced.
    expect(await listed(id)).toBeUndefined();
    expect((await invoiceFrom(as.office, [id])).error).toMatchObject({ code: "22023", message: expect.stringContaining("already on a draft invoice") });
    expect((await invoiceOf(id))).toMatchObject({ status: "draft", invoice_ref: null });
  });

  it("two people marking it sent out at once make one draft", async () => {
    const customer = `Race Co ${world.runId}`;
    const id = await note(await order(customer), ALL);
    const results = await Promise.all([sendOut(id, as.workshop), sendOut(id, as.office)]);
    for (const r of results) expect(r.error).toBeNull();
    expect(await invoicesFor(customer)).toHaveLength(1);
    expect((await events(id)).map((e) => e.outcome)).toEqual(["drafted"]);
  });

  it("a part despatch (two notes from one order) makes two drafts that add up to the order", async () => {
    const customer = `Part Co ${world.runId}`;
    const orderId = await order(customer);
    const first = await note(orderId, [[0, 5], [2, 7]]);
    const second = await note(orderId, [[0, 7], [1, 4]]);
    expect((await sendOut(first, as.workshop)).error).toBeNull();
    expect((await sendOut(second, as.office)).error).toBeNull();
    const drafts = await invoicesFor(customer);
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.status === "draft" && d.invoice_ref === null)).toBe(true);
    const pence = (v: number) => Math.round(Number(v) * 100);
    expect(drafts.reduce((s, d) => s + pence(d.subtotal), 0)).toBe(pence(TOTALS.subtotal));
    expect(drafts.reduce((s, d) => s + pence(d.vat), 0)).toBe(pence(TOTALS.vat));
    expect(drafts.reduce((s, d) => s + pence(d.total), 0)).toBe(pence(TOTALS.total));
    expect((await invoiceOf(first))!.id).not.toBe((await invoiceOf(second))!.id);
  });

  it("a change made by the service role (an import, maintenance) drafts nothing: the note is listed as not drafted", async () => {
    const id = await note(await order(), [[1, 1]]);
    expect((await adminClient().from("delivery_notes").update({ status: "despatched" }).eq("id", id)).error).toBeNull();
    expect(await invoiceOf(id)).toBeNull();
    expect(await listed(id)).toMatchObject({ reason: "not-drafted", invoiceable: true });
  });
});

describe("notes that are not drafted are listed, never dropped", () => {
  it("a hand-made note (no order): no invoice, listed manual-items, not offered to the picker", async () => {
    const id = (await as.office.rpc("create_with_lines", {
      p_parent: "delivery_notes", p_header: { customer: `Hand Co ${world.runId}`, status: "awaiting", dn_number: `DLN-HAND-${world.runId}` },
      p_child: "delivery_note_items", p_fk: "delivery_note_id", p_lines: [{ position: 0, description: "Bracket", quantity: 2 }],
    })).data as string;
    expect((await sendOut(id, as.workshop)).data).toHaveLength(1);
    expect(await noteRow(id)).toEqual({ status: "despatched", invoice_id: null });
    expect(await events(id)).toEqual([]);
    expect(await listed(id)).toMatchObject({ reason: "manual-items", invoiceable: false });
  });

  it("a note with a hand-typed invoice reference counts as invoiced elsewhere: not drafted, not listed", async () => {
    const id = (await as.office.rpc("create_with_lines", {
      p_parent: "delivery_notes", p_header: { customer: `Typed Co ${world.runId}`, status: "awaiting", dn_number: `DLN-TYPED-${world.runId}`, invoice_ref: "INV-0042" },
      p_child: "delivery_note_items", p_fk: "delivery_note_id", p_lines: [{ position: 0, description: "Bracket", quantity: 1 }],
    })).data as string;
    expect((await sendOut(id, as.office)).data).toHaveLength(1);
    expect(await listed(id)).toBeUndefined();
  });

  it("an internal job's note is never invoiced and is listed as excluded", async () => {
    // 042 refuses to send out (or make) a note for an internal job; a note recorded before that rule (legacy data) is written here directly.
    const org = world.tenants.alpha.id;
    const id = await withDb(async (db) => {
      const job = (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, is_internal, description) values ($1, $2, true, 'Tooling') returning id", [org, `J-INT-${world.runId}`])).rows[0].id;
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      const row = (await db.query<{ id: string }>("insert into public.delivery_notes (organization_id, dn_number, customer, job_id, status) values ($1, $2, 'Us', $3, 'despatched') returning id", [org, `DLN-INT-${world.runId}`, job])).rows[0].id;
      await db.query("commit");
      return row;
    });
    expect(await listed(id)).toMatchObject({ reason: "internal-job", invoiceable: false });
    expect((await invoiceFrom(as.office, [id])).error).not.toBeNull();
    expect(await invoiceOf(id)).toBeNull();
  });

  it("a note whose customer is not its order's customer: no draft, listed customer-mismatch; invoiced by hand from the picker", async () => {
    const id = await note(await order(`Order Name ${world.runId}`), [[1, 2]]);
    expect((await as.office.from("delivery_notes").update({ customer: `Somebody Else ${world.runId}` }).eq("id", id).select("id")).data).toHaveLength(1);
    expect((await sendOut(id, as.workshop)).error).toBeNull();
    expect(await invoiceOf(id)).toBeNull();
    expect(await listed(id)).toMatchObject({ reason: "customer-mismatch", invoiceable: true });
    expect((await invoiceFrom(as.office, [id])).error).toBeNull();
    expect(await listed(id)).toBeUndefined();
  });

  it("the same customer spelt with different case and spaces can be invoiced together", async () => {
    const a = await note(await order(`Case Co ${world.runId}`), [[1, 1]]);
    const b = await note(await order(`CASE   co ${world.runId}`), [[1, 1]]);
    for (const id of [a, b]) expect((await adminClient().from("delivery_notes").update({ status: "despatched" }).eq("id", id)).error).toBeNull();
    const made = await invoiceFrom(as.office, [a, b]);
    expect(made.error).toBeNull();
    expect((await noteRow(a)).invoice_id).toBe(made.data.invoice_id);
    expect((await noteRow(b)).invoice_id).toBe(made.data.invoice_id);
  });
});

describe("a failure to draft", () => {
  it("never blocks the despatch: the note goes out, the error is recorded and listed, and the note can be invoiced by hand", async () => {
    const customer = `Fail Co ${world.runId}`;
    const id = await note(await order(customer), ALL);
    // Force an error inside the draft: a probe trigger that refuses this customer's invoice (removed straight after).
    await withDb((db) => db.query(`
      create or replace function public.zz_probe_059_refuse() returns trigger language plpgsql as $$
      begin if new.customer = '${customer}' then raise exception 'probe: refused for the test' using errcode = 'P0001'; end if; return new; end $$;
      create trigger zz_probe_059_refuse before insert on public.invoices for each row execute function public.zz_probe_059_refuse();`));
    try {
      const sent = await sendOut(id, as.workshop);
      expect(sent.error).toBeNull();
      expect(sent.data).toHaveLength(1);
    } finally {
      await withDb((db) => db.query("drop trigger if exists zz_probe_059_refuse on public.invoices; drop function if exists public.zz_probe_059_refuse();"));
    }
    expect(await noteRow(id)).toEqual({ status: "despatched", invoice_id: null });
    expect(await invoicesFor(customer)).toEqual([]);
    expect(await events(id)).toEqual([{ cause: "sent_out", outcome: "failed", invoice_id: null, error_code: "P0001", error_message: "probe: refused for the test" }]);
    const row = await listed(id);
    expect(row).toMatchObject({ reason: "queued-failed", invoiceable: true });
    expect(row!.detail).toContain("probe: refused for the test");
    expect(row!.failed_at).toBeTruthy();
    expect((await invoiceFrom(as.office, [id])).error).toBeNull();
    expect(await listed(id)).toBeUndefined();
  });
});

describe("a void invoice", () => {
  it("frees its notes (034) and drafts nothing: voided in the app, the note is listed with the void invoice and the picker invoices it again, once", async () => {
    const customer = `Void Co ${world.runId}`;
    const id = await note(await order(customer), ALL);
    expect((await sendOut(id, as.office)).error).toBeNull();
    const first = (await invoiceOf(id))!.id;
    expect((await as.admin.rpc("issue_invoice", { p_invoice: first })).error).toBeNull();
    const ref = (await invoiceOf(id))!.invoice_ref;
    // 073: voided the app's way (void_invoice, with a reason); a direct status update to void is refused.
    expect((await as.office.from("invoices").update({ status: "void" }).eq("id", first).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.office.rpc("void_invoice", { p_invoice_id: first, p_reason: "Raised in error" })).error).toBeNull();
    // No new draft: the note still points at the void invoice, and the only attempt is the one from sending it out.
    expect(await noteRow(id)).toMatchObject({ invoice_id: first });
    expect((await invoicesFor(customer)).map((i) => i.status)).toEqual(["void"]);
    expect((await events(id)).map((e) => [e.cause, e.outcome])).toEqual([["sent_out", "drafted"]]);
    // It doesn't fall through: listed, with the void invoice's number, and the picker can take it.
    expect(await listed(id)).toMatchObject({ reason: "not-drafted", invoiceable: true, voided_invoice_ref: ref });
    // Voiding the void invoice again adds nothing (refused as already void; writing the same status changes nothing).
    expect((await as.office.rpc("void_invoice", { p_invoice_id: first, p_reason: "Again" })).error).toMatchObject({ code: "22023" });
    expect((await as.office.from("invoices").update({ status: "void" }).eq("id", first).select("id")).error).toBeNull();
    expect(await invoicesFor(customer)).toHaveLength(1);
    // A person invoices it again, once.
    const again = await invoiceFrom(as.office, [id]);
    expect(again.error).toBeNull();
    expect(await invoiceOf(id)).toMatchObject({ id: again.data.invoice_id, status: "draft", invoice_ref: null, total: TOTALS.total });
    expect((await invoiceFrom(as.office, [id])).error).toMatchObject({ code: "22023" });
    expect(await listed(id)).toBeUndefined();
    expect((await invoicesFor(customer)).map((i) => i.status).sort()).toEqual(["draft", "void"]);
    expect(await events(id)).toHaveLength(1);
  });

  it("voided outside the app: the note is listed with the void invoice and the picker can invoice it again, once", async () => {
    const id = await note(await order(`Void Two ${world.runId}`), [[1, 2]]);
    expect((await sendOut(id, as.office)).error).toBeNull();
    const first = (await invoiceOf(id))!.id;
    expect((await as.admin.rpc("issue_invoice", { p_invoice: first })).error).toBeNull();
    const ref = (await invoiceOf(id))!.invoice_ref;
    await withDb((db) => db.query("update public.invoices set status = 'void' where id = $1", [first]));
    expect(await listed(id)).toMatchObject({ reason: "not-drafted", invoiceable: true, voided_invoice_ref: ref });
    expect((await invoiceFrom(as.office, [id])).error).toBeNull();
    expect((await invoiceFrom(as.office, [id])).error).toMatchObject({ code: "22023" });
    expect(await listed(id)).toBeUndefined();
  });
});

describe("who sees what", () => {
  it("the backlog and the attempts are admin and office of the caller's company only", async () => {
    const id = await note(await order(), [[1, 1]]);
    expect((await sendOut(id, as.workshop)).error).toBeNull();
    // Workshop can send it out (the draft is made by the database) but can't read the backlog, the attempts or the invoice.
    for (const role of ["workshop", "viewer"]) {
      expect((await as[role].rpc("uninvoiced_delivery_notes")).error, role).toMatchObject({ code: "42501" });
      expect((await as[role].from("invoice_queue_events").select("id")).data ?? [], role).toEqual([]);
    }
    expect((await as.workshop.from("invoices").select("id").eq("id", (await noteRow(id)).invoice_id!)).data ?? []).toEqual([]);
    expect((await as.admin.from("invoice_queue_events").select("id").eq("delivery_note_id", id)).data).toHaveLength(1);
    // Another company sees none of it and can't invoice it.
    const betaRows = await backlog(as.betaAdmin);
    const alphaNotes = new Set((await adminClient().from("delivery_notes").select("id").eq("organization_id", world.tenants.alpha.id)).data!.map((r) => r.id));
    expect(betaRows.filter((r) => alphaNotes.has(r.delivery_note_id))).toEqual([]);
    expect((await as.betaAdmin.from("invoice_queue_events").select("id").eq("delivery_note_id", id)).data ?? []).toEqual([]);
    const failed = await note(await order(), [[1, 1]]);
    expect((await adminClient().from("delivery_notes").update({ status: "despatched" }).eq("id", failed)).error).toBeNull();
    expect((await invoiceFrom(as.betaAdmin, [failed])).error).toMatchObject({ code: "P0002" });
    expect(await invoiceOf(failed)).toBeNull();
    // Nobody calls the internal functions.
    for (const client of [as.admin, as.workshop]) {
      expect((await client.rpc("invoice_from_delivery_notes_draft", { p_org: world.tenants.alpha.id, p_notes: [failed], p_invoice_date: TODAY, p_due_date: TODAY, p_terms: "x" })).error).not.toBeNull();
      expect((await client.rpc("delivery_note_try_draft", { p_note: failed, p_org: world.tenants.alpha.id, p_cause: "sent_out" })).error).not.toBeNull();
    }
    expect(await invoiceOf(failed)).toBeNull();
    // Nothing is written to the attempts by hand.
    expect((await as.admin.from("invoice_queue_events").insert({ organization_id: world.tenants.alpha.id, delivery_note_id: failed, cause: "sent_out", outcome: "drafted" })).error).not.toBeNull();
  });

  it("drafts are never issued automatically: every invoice this file made is a draft unless a person issued it", async () => {
    const org = world.tenants.alpha.id;
    const rows = (await adminClient().from("invoices").select("status, invoice_ref").eq("organization_id", org)).data!;
    expect(rows.length).toBeGreaterThan(5);
    // Issued here only by the two void tests (both then voided).
    expect(rows.filter((r) => r.status !== "draft").map((r) => r.status).sort()).toEqual(["void", "void"]);
    expect(rows.filter((r) => r.status === "draft").every((r) => r.invoice_ref === null)).toBe(true);
  });
});
