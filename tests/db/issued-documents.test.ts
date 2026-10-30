/**
 * Issued documents (audit B4a: D8, D9, A8). An issued invoice keeps its amounts, customer and lines; payment and
 * status still change. Quotes and invoices remember the issuer and customer details as they were when issued.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals } from "@/lib/money";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let admin: SupabaseClient;
let seq = 0;
const customer = "Snapshot Customer Ltd";

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  admin = await signedInClient(world.tenants.alpha.users.admin);
  const { error } = await adminClient().from("customers").insert({ organization_id: world.tenants.alpha.id, name: customer, address: "1 Old Road\nOldtown\nOL1 1AA" });
  if (error) throw new Error(error.message);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** "sent" = a finished (issued) invoice: since 033 an API user can only create drafts, so it is drafted, then issued. */
async function createInvoice(status: "sent" | "draft", extraHeader: Record<string, unknown> = {}) {
  seq += 1;
  const lines = [{ quantity: 2, unitPrice: 150, vatPct: 20 }, { quantity: 1, unitPrice: 40, vatPct: 0 }];
  const totals = documentTotals(lines, 0, { vatEnabled: true, standardRate: 20 });
  const { data, error } = await admin.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer, subtotal: totals.subtotal, carriage: 0, vat: totals.vat, total: totals.total, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2026-11-08", ...extraHeader },
    p_child: "invoice_line_items",
    p_fk: "invoice_id",
    p_lines: lines.map((l, position) => ({ position, description: `Line ${position}`, quantity: l.quantity, unit_price: l.unitPrice, vat_pct: l.vatPct, vat_exempt: false })),
  });
  if (error) throw new Error(error.message);
  if (status === "sent") {
    const issued = await admin.rpc("issue_invoice", { p_invoice: data as string });
    if (issued.error) throw new Error(issued.error.message);
  }
  return data as string;
}

const row = async (id: string) => (await adminClient().from("invoices").select("*").eq("id", id).single()).data as Record<string, unknown>;

describe("snapshot at issue", () => {
  it("records issuer and customer details from the server, ignoring any the caller sends", async () => {
    const id = await createInvoice("sent", { issuer_snapshot: { documentName: "Forged Ltd" }, customer_snapshot: { name: "Forged" } });
    const invoice = await row(id);
    expect(invoice.status).toBe("issued");
    expect(invoice.issuer_snapshot).toMatchObject({ documentName: world.tenants.alpha.name, vatNumber: "GB 000 0000 00", vatRegistered: true, defaultVatRate: 20, addressLines: ["Unit 1, Test Estate", "Testtown", "TE1 1ST"] });
    expect(invoice.customer_snapshot).toEqual({ name: customer, address: "1 Old Road\nOldtown\nOL1 1AA", found: true });
  });

  it("later changes to the company or the customer don't touch an issued document's snapshot", async () => {
    const id = await createInvoice("sent");
    const before = await row(id);
    const service = adminClient();
    const { data: settings } = await service.from("organization_settings").select("company_profile").eq("organization_id", world.tenants.alpha.id).single();
    await service.from("organization_settings").update({ company_profile: { ...(settings!.company_profile as object), addressLines: ["New HQ"], vatRegistered: false, defaultVatRate: 17.5 } }).eq("organization_id", world.tenants.alpha.id);
    await service.from("customers").update({ address: "99 New Street" }).eq("name", customer);
    try {
      const after = await row(id);
      expect(after.issuer_snapshot).toEqual(before.issuer_snapshot);
      expect(after.customer_snapshot).toEqual(before.customer_snapshot);
      expect([after.subtotal, after.vat, after.total]).toEqual([before.subtotal, before.vat, before.total]);
    } finally {
      await service.from("organization_settings").update({ company_profile: settings!.company_profile }).eq("organization_id", world.tenants.alpha.id);
      await service.from("customers").update({ address: "1 Old Road\nOldtown\nOL1 1AA" }).eq("name", customer);
    }
  });
});

describe("issued invoice lock", () => {
  const refused: [string, (id: string, client: SupabaseClient) => PromiseLike<{ error: unknown; data?: unknown }>][] = [
    ["change the total", (id, c) => c.from("invoices").update({ total: 1 }).eq("id", id)],
    ["change the customer", (id, c) => c.from("invoices").update({ customer: "Someone else" }).eq("id", id)],
    ["change the due date", (id, c) => c.from("invoices").update({ due_date: "2027-01-01" }).eq("id", id)],
    ["rewrite the snapshot", (id, c) => c.from("invoices").update({ issuer_snapshot: { documentName: "X" } }).eq("id", id)],
    ["go back to draft", (id, c) => c.from("invoices").update({ status: "draft" }).eq("id", id)],
    ["delete it", (id, c) => c.from("invoices").delete().eq("id", id)],
    ["add a line", (id, c) => c.from("invoice_line_items").insert({ organization_id: world.tenants.alpha.id, invoice_id: id, position: 9, description: "Extra", quantity: 1, unit_price: 1 })],
    ["change a line", (id, c) => c.from("invoice_line_items").update({ unit_price: 1 }).eq("invoice_id", id)],
    ["delete a line", (id, c) => c.from("invoice_line_items").delete().eq("invoice_id", id)],
    // S5 (tests/scripts/invoice-immutability-proof.sql proves the same, and more, in plain SQL).
    ["change the number", (id, c) => c.from("invoices").update({ invoice_ref: "INV-S5-OWN" }).eq("id", id)],
    ["change the net, the VAT and the carriage", (id, c) => c.from("invoices").update({ subtotal: 1, vat: 0, carriage: 50 }).eq("id", id)],
    ["switch VAT off", (id, c) => c.from("invoices").update({ vat_enabled: false }).eq("id", id)],
    ["change the invoice date", (id, c) => c.from("invoices").update({ invoice_date: "2020-01-01" }).eq("id", id)],
    ["move it to another company", (id, c) => c.from("invoices").update({ organization_id: world.tenants.beta.id }).eq("id", id)],
    ["mark it paid by editing", (id, c) => c.from("invoices").update({ status: "paid", amount_paid: 340, paid_at: new Date().toISOString() }).eq("id", id)],
    ["mark it part paid by editing", (id, c) => c.from("invoices").update({ status: "partial" }).eq("id", id)],
    ["void it by editing", (id, c) => c.from("invoices").update({ status: "void" }).eq("id", id)],
    ["change a line's quantity and VAT", (id, c) => c.from("invoice_line_items").update({ quantity: 9, vat_pct: 0 }).eq("invoice_id", id)],
    ["move its lines onto a draft", async (id, c) => c.from("invoice_line_items").update({ invoice_id: await createInvoice("draft") }).eq("invoice_id", id)],
  ];

  for (const [name, attempt] of refused) {
    it(`an admin can't ${name}`, async () => {
      const id = await createInvoice("sent");
      const before = await row(id);
      const linesBefore = (await adminClient().from("invoice_line_items").select("*").eq("invoice_id", id).order("position")).data;
      const { error } = await attempt(id, admin);
      expect(error).not.toBeNull();
      expect(await row(id)).toEqual(before);
      expect((await adminClient().from("invoice_line_items").select("*").eq("invoice_id", id).order("position")).data).toEqual(linesBefore);
    });
  }

  it("the service role is held to the same lock", async () => {
    const id = await createInvoice("sent");
    expect((await adminClient().from("invoices").update({ total: 1 }).eq("id", id)).error).not.toBeNull();
  });

  it("recording a payment still works through the lock (status, amount paid, paid date)", async () => {
    const id = await createInvoice("sent");
    const total = Number((await row(id)).total);
    const { error } = await admin.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: total, p_paid_on: "2026-10-01", p_method: "BACS", p_reference: null });
    expect(error).toBeNull();
    expect(await row(id)).toMatchObject({ status: "paid", amount_paid: total });
  });

  it("a draft invoice stays editable, lines included", async () => {
    const id = await createInvoice("draft");
    expect((await row(id)).status).toBe("draft");
    expect((await admin.from("invoice_line_items").update({ description: "Corrected" }).eq("invoice_id", id).eq("position", 0)).error).toBeNull();
    expect((await admin.from("invoices").update({ customer_po: "PO-1" }).eq("id", id)).error).toBeNull();
    expect((await admin.from("invoices").delete().eq("id", id)).error).toBeNull();
  });

  it("imports and maintenance as the database owner are not restricted", async () => {
    await withDb(async (db) => {
      const inv = await db.query<{ id: string }>(
        "insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status) values ($1, 'INV-IMPORT', 'Legacy', 10, 2, 12, 'paid') returning id", [world.tenants.alpha.id]);
      await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price) values ($1, $2, 0, 'Legacy line', 1, 10)", [world.tenants.alpha.id, inv.rows[0].id]);
    });
    const { count } = await adminClient().from("invoice_line_items").select("id", { count: "exact", head: true }).eq("description", "Legacy line");
    expect(count).toBe(1);
  });
});

/**
 * S5: a void invoice stays exactly as it was voided, for the browser and the service role; its number is never reused; the lock
 * triggers can't be skipped (no WHEN clause, enabled, session_replication_role refused to both API roles); the audit chain verifies.
 */
describe("issued and void invoices stay fixed (S5)", () => {
  const lines = async (id: string) => (await adminClient().from("invoice_line_items").select("*").eq("invoice_id", id).order("position")).data;
  const numberOf = (ref: unknown) => Number(String(ref).match(/(\d+)$/)?.[1] ?? Number.NaN);

  it("a void invoice keeps its number, amounts and lines, can't be un-voided, edited or deleted by the browser; the next number is new", async () => {
    const id = await createInvoice("sent");
    expect((await admin.rpc("void_invoice", { p_invoice_id: id, p_reason: "Raised in error" })).error).toBeNull();
    const before = await row(id);
    const linesBefore = await lines(id);
    expect(before.status).toBe("void");
    for (const attempt of [
      admin.from("invoices").update({ status: "issued" }).eq("id", id),
      admin.from("invoices").update({ status: "draft" }).eq("id", id),
      admin.from("invoices").update({ total: 1 }).eq("id", id),
      admin.from("invoices").update({ customer: "Someone else" }).eq("id", id),
      admin.from("invoices").update({ invoice_ref: "INV-S5-VOID" }).eq("id", id),
      admin.from("invoices").delete().eq("id", id),
      admin.from("invoice_line_items").insert({ organization_id: world.tenants.alpha.id, invoice_id: id, position: 9, description: "Extra", quantity: 1, unit_price: 1 }),
      admin.from("invoice_line_items").update({ unit_price: 1 }).eq("invoice_id", id),
      admin.from("invoice_line_items").delete().eq("invoice_id", id),
    ]) expect((await attempt).error).not.toBeNull();
    expect(await row(id)).toEqual(before);
    expect(await lines(id)).toEqual(linesBefore);
    const next = await row(await createInvoice("sent"));
    expect(next.invoice_ref).not.toBe(before.invoice_ref);
    expect(numberOf(next.invoice_ref)).toBeGreaterThan(numberOf(before.invoice_ref));
  });

  it("the service role can't change an issued or void invoice's amounts, lines or company, take it back to draft, or delete it", async () => {
    const service = adminClient();
    const issued = await createInvoice("sent");
    const voided = await createInvoice("sent");
    expect((await admin.rpc("void_invoice", { p_invoice_id: voided, p_reason: "Raised in error" })).error).toBeNull();
    for (const id of [issued, voided]) {
      const before = await row(id);
      const linesBefore = await lines(id);
      for (const attempt of [
        service.from("invoices").update({ subtotal: 1, vat: 0, total: 1 }).eq("id", id),
        service.from("invoices").update({ organization_id: world.tenants.beta.id }).eq("id", id),
        service.from("invoices").update({ status: "draft" }).eq("id", id),
        service.from("invoices").delete().eq("id", id),
        service.from("invoice_line_items").insert({ organization_id: world.tenants.alpha.id, invoice_id: id, position: 9, description: "Extra", quantity: 1, unit_price: 1 }),
        service.from("invoice_line_items").update({ unit_price: 1 }).eq("invoice_id", id),
        service.from("invoice_line_items").delete().eq("invoice_id", id),
      ]) expect((await attempt).error).not.toBeNull();
      expect(await row(id)).toEqual(before);
      expect(await lines(id)).toEqual(linesBefore);
    }
  });

  it("the lock triggers have no WHEN clause and are enabled; neither API role can set session_replication_role", async () => {
    await withDb(async (db) => {
      const { rows } = await db.query<{ tgname: string; tgenabled: string; has_when: boolean }>(
        `select t.tgname, t.tgenabled, t.tgqual is not null as has_when from pg_trigger t
         where not t.tgisinternal and t.tgrelid in ('public.invoices'::regclass, 'public.invoice_line_items'::regclass)
           and t.tgname in ('invoice_issue_lock', 'invoices_void_guard', 'zz_invoice_via_issue', 'zz_invoice_receipts', 'invoice_lines_issue_lock')
         order by 1`);
      expect(rows).toEqual(["invoice_issue_lock", "invoice_lines_issue_lock", "invoices_void_guard", "zz_invoice_receipts", "zz_invoice_via_issue"]
        .map((tgname) => ({ tgname, tgenabled: "O", has_when: false })));
      for (const role of ["authenticated", "service_role"]) {
        await db.query("begin");
        try {
          await db.query(`set local role ${role}`);
          await expect(db.query("set local session_replication_role = replica")).rejects.toMatchObject({ code: "42501" });
        } finally {
          await db.query("rollback");
        }
      }
    });
  });

  it("after the issues, payments and voids above, the company's audit chain still verifies (links and hashes)", async () => {
    const result = await withDb(async (db) => {
      await db.query("begin");
      try {
        // set_audit_hash hashes created_at::text; the stack runs in UTC.
        await db.query("set local timezone to 'UTC'");
        return (await db.query<{ total: number; broken_links: number; bad_hashes: number }>(`
          with r as (
            select a.*, lag(a.hash) over (order by a.created_at) as expected_previous
            from security_audit.audit_log a where a.organization_id = $1)
          select count(*)::int as total,
                 count(*) filter (where previous_hash is distinct from expected_previous)::int as broken_links,
                 count(*) filter (where hash is distinct from encode(extensions.digest(
                   coalesce(previous_hash, '') || coalesce(organization_id::text, '') || coalesce(actor_user_id::text, '') || action || entity_table ||
                   coalesce(entity_id, '') || coalesce(old_data::text, '') || coalesce(new_data::text, '') || coalesce(metadata::text, '') || created_at::text,
                   'sha256'), 'hex'))::int as bad_hashes
          from r`, [world.tenants.alpha.id])).rows[0];
      } finally {
        await db.query("rollback");
      }
    });
    expect(result.total).toBeGreaterThan(0);
    expect(result).toMatchObject({ broken_links: 0, bad_hashes: 0 });
  });
});
