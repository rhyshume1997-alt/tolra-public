/**
 * A draft invoice is issued only by issue_invoice, never by editing its status or number (migration 091; 089 pack case 4c). Proves in SQL
 * (as PostgREST runs it: role authenticated with the JWT claims; the service role and the owner for the exemptions), so it also runs
 * against plain PostgreSQL with stand-ins:
 *   - the bypass: office or admin PATCHes a DRAFT straight to issued (or sent / written off) with an invoice_ref of their own choosing in
 *     one request, or sets a draft's invoice_ref first: refused (42501, hint invoice_issue_direct), the row unchanged; also as an upsert
 *     and for a draft that already carries a number;
 *   - the refusals that came first before 091 keep their messages: no number (027's check, 23514), void by PATCH (073), paid / part paid
 *     (089);
 *   - every legitimate path still works: issue_invoice (the next number, snapshots, the issue stamp; the setting is cleared after it),
 *     void_invoice, replace_draft_invoice, create_with_lines, Record payment, sending, a credit note, the despatch draft invoice
 *     (create_invoice_from_delivery_notes) and the data import (issued invoices INSERTed with their own numbers);
 *   - the database owner and the service role are exempt.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
type Role = "admin" | "office" | "workshop";
const alpha = () => world.tenants.alpha;
let seq = 0;
const ownRef = () => `INV-X91-${world.runId}-${(seq += 1)}`;

/** Statements as a signed-in member of alpha (authenticated, aal2), in one transaction, committed. */
async function inSession<T>(role: Role, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: alpha().users[role].id, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: "aal2" })]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}
const asRole = <R extends Record<string, unknown> = Record<string, unknown>>(role: Role, text: string, params: unknown[] = []) =>
  inSession(role, async (db) => (await db.query<R>(text, params)).rows);
const asRoleCount = (role: Role, text: string, params: unknown[] = []) => inSession(role, async (db) => (await db.query(text, params)).rowCount);
async function refusal(role: Role, text: string, params: unknown[] = []) {
  try {
    await asRole(role, text, params);
    return null;
  } catch (err) {
    const e = err as { code?: string; hint?: string; message: string };
    return { code: e.code, hint: e.hint, message: e.message };
  }
}
const owner = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withDb(async (db) => (await db.query<R>(text, params)).rows);

type Invoice = { status: string; invoice_ref: string | null; issued: boolean; snapshots: boolean };
const read = async (id: string) => (await owner<Invoice>(`select coalesce(status, 'draft') as status, invoice_ref,
  (issued_at is not null or issued_by is not null) as issued, (issuer_snapshot is not null and customer_snapshot is not null) as snapshots
  from public.invoices where id = $1`, [id]))[0];

/** A draft as the app makes it (create_with_lines): 1 x £100 + 20% VAT = £120. */
async function newDraft(role: Role = "office") {
  const [row] = await asRole<{ id: string }>(role, `select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb) as id`, [
    JSON.stringify({ customer: "Issue Guard Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, invoice_date: "2026-10-22", due_date: "2099-01-31" }),
    JSON.stringify([{ position: 0, description: "Machined flange", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }]),
  ]);
  return row.id;
}
const issue = async (id: string, role: Role = "office") => (await asRole<{ r: string }>(role, "select public.issue_invoice($1) as r", [id]))[0].r;

const REFUSED = { code: "42501", hint: "invoice_issue_direct", message: "This draft: a draft invoice is issued with Issue invoice, which gives it the next number. Its number and status are not set by editing it." };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("091: a draft invoice is issued only by issue_invoice", () => {
  for (const role of ["admin", "office"] as const) {
    it(`THE BYPASS: ${role} PATCHes a draft straight to issued with a number of their own choosing: refused, the row unchanged`, async () => {
      const id = await newDraft();
      expect(await refusal(role, "update public.invoices set status = 'issued', invoice_ref = $2 where id = $1", [id, ownRef()])).toEqual(REFUSED);
      expect(await read(id)).toEqual({ status: "draft", invoice_ref: null, issued: false, snapshots: true });
    });

    it(`${role} can't set a draft's number either (the two-step version)`, async () => {
      const id = await newDraft();
      expect(await refusal(role, "update public.invoices set invoice_ref = $2 where id = $1", [id, ownRef()])).toEqual(REFUSED);
      expect((await read(id)).invoice_ref).toBeNull();
    });
  }

  it.each(["sent", "written_off"])("refuses a draft moved to %s with its own number", async (status) => {
    const id = await newDraft();
    expect(await refusal("office", "update public.invoices set status = $2, invoice_ref = $3 where id = $1", [id, status, ownRef()])).toEqual(REFUSED);
    expect((await read(id)).status).toBe("draft");
  });

  it("refuses the same as an upsert (ON CONFLICT DO UPDATE) and with PostgREST's status filter", async () => {
    const id = await newDraft();
    expect(await refusal("office", `insert into public.invoices (id, organization_id, customer, total, status)
      select id, organization_id, customer, total, 'draft' from public.invoices where id = $1
      on conflict (id) do update set status = 'issued', invoice_ref = $2`, [id, ownRef()])).toEqual(REFUSED);
    expect(await refusal("office", "update public.invoices set status = 'issued', invoice_ref = $2 where id = $1 and status = 'draft'", [id, ownRef()])).toEqual(REFUSED);
    expect((await read(id)).status).toBe("draft");
  });

  it("a draft that already carries a number (written by the owner) can't be moved by PATCH; issue_invoice gives it the next number", async () => {
    const id = await newDraft();
    const legacy = ownRef();
    await owner("update public.invoices set invoice_ref = $2 where id = $1", [id, legacy]);
    expect(await refusal("office", "update public.invoices set status = 'issued' where id = $1", [id])).toEqual({
      ...REFUSED, message: `${legacy}: a draft invoice is issued with Issue invoice, which gives it the next number. Its number and status are not set by editing it.` });
    const ref = await issue(id);
    expect(ref).toMatch(/^INV-\d{4,}$/);
    expect(ref).not.toBe(legacy);
    expect(await read(id)).toMatchObject({ status: "issued", invoice_ref: ref });
  });

  it("the refusals that came first keep their messages: no number (027), void by PATCH (073), paid / part paid (089)", async () => {
    const id = await newDraft();
    expect(await refusal("office", "update public.invoices set status = 'issued' where id = $1", [id])).toMatchObject({ code: "23514" });
    expect(await refusal("office", "update public.invoices set status = 'void', invoice_ref = $2 where id = $1", [id, ownRef()])).toMatchObject({ code: "42501", hint: "invoice_void_direct" });
    expect(await refusal("office", "update public.invoices set status = 'paid', invoice_ref = $2 where id = $1", [id, ownRef()])).toMatchObject({ code: "42501", hint: "invoice_receipts_direct" });
    expect(await refusal("office", "update public.invoices set status = 'partial', invoice_ref = $2, amount_paid = 50, paid_at = now() where id = $1", [id, ownRef()]))
      .toMatchObject({ code: "42501", hint: "invoice_receipts_direct" });
    expect(await read(id)).toEqual({ status: "draft", invoice_ref: null, issued: false, snapshots: true });
  });

  it("a draft's issue stamp is kept by actor_keep (no change, nothing to refuse)", async () => {
    const id = await newDraft();
    expect(await asRoleCount("office", "update public.invoices set issued_at = now(), issued_by = $2 where id = $1", [id, alpha().users.office.id])).toBe(1);
    expect((await read(id)).issued).toBe(false);
  });

  it("workshop can't reach invoices at all (RLS): nothing changes", async () => {
    const id = await newDraft();
    expect(await asRoleCount("workshop", "update public.invoices set status = 'issued', invoice_ref = $2 where id = $1", [id, ownRef()])).toBe(0);
    expect((await read(id)).status).toBe("draft");
  });
});

describe("091: every legitimate path still works", () => {
  it("issue_invoice (office and admin): the next number, the snapshots and the issue stamp; the setting is cleared straight after", async () => {
    for (const role of ["office", "admin"] as const) {
      const id = await newDraft();
      const other = await newDraft();
      const outcome = await inSession(role, async (db) => {
        const ref = (await db.query<{ r: string }>("select public.issue_invoice($1) as r", [id])).rows[0].r;
        const setting = (await db.query<{ s: string | null }>("select current_setting('quoteflow.invoice_issue', true) as s")).rows[0].s;
        // Later in the same transaction, another draft is still refused.
        await db.query("savepoint s");
        let later: { code?: string; hint?: string } | null = null;
        try {
          await db.query("update public.invoices set status = 'issued', invoice_ref = $2 where id = $1", [other, ownRef()]);
        } catch (err) {
          later = err as { code?: string; hint?: string };
        }
        await db.query("rollback to savepoint s");
        return { ref, setting, later: later && { code: later.code, hint: later.hint } };
      });
      expect(outcome.ref).toMatch(/^INV-\d{4,}$/);
      expect(outcome.setting).toBe("");
      expect(outcome.later).toEqual({ code: "42501", hint: "invoice_issue_direct" });
      expect(await read(id)).toEqual({ status: "issued", invoice_ref: outcome.ref, issued: true, snapshots: true });
      expect(await issue(id, role)).toBe(outcome.ref); // again: same number, nothing changes
      expect((await read(other)).status).toBe("draft");
    }
  });

  it("void_invoice voids an issued invoice and still refuses a draft", async () => {
    const id = await newDraft();
    await issue(id);
    expect(await asRole("office", "select public.void_invoice($1, 'Raised in error')", [id])).toHaveLength(1);
    expect((await read(id)).status).toBe("void");
    const draft = await newDraft();
    expect(await refusal("office", "select public.void_invoice($1, 'x')", [draft])).toMatchObject({ code: "22023", hint: "invoice_draft" });
  });

  it("replace_draft_invoice edits a draft; create_with_lines makes one (and still can't issue one without a number)", async () => {
    const id = await newDraft();
    // The stamp travels as text: a JS Date keeps milliseconds, the column keeps microseconds, and the function compares them exactly
    // (the app passes PostgREST's string back unchanged, so it never loses the microseconds either).
    const [{ updated_at }] = await owner<{ updated_at: string }>("select updated_at::text as updated_at from public.invoices where id = $1", [id]);
    await asRole("office", "select public.replace_draft_invoice($1, $2::timestamptz, $3::jsonb, $4::jsonb)", [id, updated_at,
      JSON.stringify({ description: "Edited", subtotal: 200, carriage: 0, vat: 40, total: 240, invoice_date: "2026-10-22", due_date: "2099-01-31" }),
      JSON.stringify([{ description: "Machined flange", quantity: 2, unit_price: 100, vat_pct: 20, vat_exempt: false }])]);
    expect((await owner<{ status: string; total: string }>("select coalesce(status, 'draft') as status, total::text from public.invoices where id = $1", [id]))[0])
      .toEqual({ status: "draft", total: "240.00" });
    expect(await refusal("office", `select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb)`, [
      JSON.stringify({ customer: "Issue Guard Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "issued", invoice_date: "2026-10-22", due_date: "2099-01-31" }),
      JSON.stringify([{ position: 0, description: "Machined flange", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }]),
    ])).toMatchObject({ code: "23514" });
  });

  it("Record payment and sending (the app's one direct invoice write) work on an issued invoice", async () => {
    const id = await newDraft();
    await issue(id);
    await asRole("office", "select public.record_invoice_payment($1, 120, (now() at time zone 'Europe/London')::date, 'BACS', 'r', gen_random_uuid())", [id]);
    expect(await asRoleCount("office", "update public.invoices set sent_date = now() where id = $1", [id])).toBe(1);
    expect((await read(id)).status).toBe("paid");
  });

  it("a credit note for all of an issued invoice credits it", async () => {
    const id = await newDraft("admin");
    await issue(id, "admin");
    const [{ line }] = await owner<{ line: string }>("select id as line from public.invoice_line_items where invoice_id = $1", [id]);
    await asRole("admin", "select public.issue_credit_note(public.create_credit_note($1, 'Returned', (now() at time zone 'Europe/London')::date, $2::jsonb))",
      [id, JSON.stringify([{ invoice_line_id: line, quantity: 1 }])]);
    expect((await read(id)).status).toBe("credited");
  });

  it("the despatch draft invoice (create_invoice_from_delivery_notes) is a draft with no number, and issues with issue_invoice", async () => {
    const [so] = await owner<{ id: string }>("insert into public.sales_orders (organization_id, so_number, customer, status, vat_enabled) values ($1, $2, 'Issue Guard Co', 'open', true) returning id",
      [alpha().id, `SO-X91-${world.runId}`]);
    const [line] = await owner<{ id: string }>("insert into public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price) values ($1, $2, 0, 'Flange', 2, 50) returning id",
      [alpha().id, so.id]);
    const [dn] = await owner<{ id: string }>("insert into public.delivery_notes (organization_id, dn_number, customer, status, sales_order_id) values ($1, $2, 'Issue Guard Co', 'despatched', $3) returning id",
      [alpha().id, `DLN-X91-${world.runId}`, so.id]);
    await owner("insert into public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity, sales_order_line_id) values ($1, $2, 0, 'Flange', 2, $3)",
      [alpha().id, dn.id, line.id]);
    await asRole("office", "select public.create_invoice_from_delivery_notes(array[$1::uuid], '2026-10-22', '2099-01-31', '30 days')", [dn.id]);
    const [{ invoice_id }] = await owner<{ invoice_id: string }>("select invoice_id from public.delivery_notes where id = $1", [dn.id]);
    expect(await read(invoice_id)).toMatchObject({ status: "draft", invoice_ref: null });
    const ref = await issue(invoice_id);
    expect(await read(invoice_id)).toMatchObject({ status: "issued", invoice_ref: ref });
  });

  it("the data import INSERTs issued, paid and credited invoices with their own numbers", async () => {
    const t = world.runId;
    const [{ r }] = await asRole<{ r: { committed: boolean; error_count: number } }>("admin", "select public.import_company_data($1::jsonb, false, gen_random_uuid()) as r", [JSON.stringify({
      file_name: "issue091.xlsx", file_sha256: "a".repeat(64),
      customers: [{ name: `Import Co ${t}` }],
      invoices: [
        { invoice_ref: `INV-I91-${t}-1`, customer: `Import Co ${t}`, invoice_date: "2026-08-01", status: "sent", lines: [{ description: "Turned part", quantity: 10, unit_price: 12 }] },
        { invoice_ref: `INV-I91-${t}-2`, customer: `Import Co ${t}`, invoice_date: "2026-08-02", total: 240, vat: 40 },
      ],
      payments: [{ invoice_ref: `INV-I91-${t}-2`, paid_on: "2026-08-20", amount: 240, method: "BACS" }],
      credit_notes: [{ credit_ref: `CRD-I91-${t}`, invoice_ref: `INV-I91-${t}-1`, credit_date: "2026-08-10", reason: "Two returned",
        lines: [{ description: "Turned part", quantity: 2, unit_price: 12 }] }],
    })]);
    expect(r).toMatchObject({ committed: true, error_count: 0 });
    expect(await owner("select invoice_ref, status from public.invoices where organization_id = $1 and invoice_ref like $2 order by invoice_ref", [alpha().id, `INV-I91-${t}-%`]))
      .toEqual([{ invoice_ref: `INV-I91-${t}-1`, status: "sent" }, { invoice_ref: `INV-I91-${t}-2`, status: "paid" }]);
  });

  it("the database owner and the service role are exempt", async () => {
    const id = await newDraft();
    await owner("update public.invoices set status = 'issued', invoice_ref = $2 where id = $1", [id, ownRef()]);
    expect((await read(id)).status).toBe("issued");
    const other = await newDraft();
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("update public.invoices set status = 'issued', invoice_ref = $2 where id = $1", [other, ownRef()]);
      await db.query("commit");
    });
    expect((await read(other)).status).toBe("issued");
  });
});
