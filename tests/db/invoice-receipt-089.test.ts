/**
 * An invoice's receipts change only through the payment and credit steps, on a draft as on an issued invoice (migration 089). Proves in
 * SQL (as PostgREST runs it: role authenticated with the JWT claims; the service role and the owner for the exemptions), so it also runs
 * against plain PostgreSQL with stand-ins:
 *   - the exploit (security review, Thu 22 Oct): office or admin PATCHes a DRAFT's amount_paid / paid_at / credited_amount /
 *     refunded_amount / payment_unverified, or moves it to paid / partial / credited, then issues it: each write is refused (42501, hint
 *     invoice_receipts_direct) and the draft issues with nothing paid; a new invoice can't start with a credit, a refund or the flag;
 *   - a draft that already carries amounts (written before 089) is not issued (22023, hint invoice_receipts_mismatch) until corrected;
 *   - on an issued invoice 076's refusals are unchanged, and the unverified flag can't be set by hand either;
 *   - Record payment, Reverse payment, Confirm payments and Apply credit (credit note) still work, end to end;
 *   - the database owner and the service role are exempt (maintenance, the importer, the server's own jobs).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
type Role = "admin" | "office" | "workshop";
const alpha = () => world.tenants.alpha;
const TODAY = "(now() at time zone 'Europe/London')::date";

/** One statement as a signed-in member of alpha (authenticated, aal2: admins' two-step sign-in done), in its own transaction. */
async function asRole<R extends Record<string, unknown> = Record<string, unknown>>(role: Role, text: string, params: unknown[] = []): Promise<R[]> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: alpha().users[role].id, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: "aal2" })]);
      const rows = (await db.query<R>(text, params)).rows;
      await db.query("commit");
      return rows;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}
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

type Invoice = { status: string; invoice_ref: string | null; amount_paid: string; paid_at: Date | null; credited_amount: string;
  refunded_amount: string; payment_unverified: boolean; payments: string };
const read = async (id: string) => (await owner<Invoice>(`select status, invoice_ref, amount_paid, paid_at, credited_amount, refunded_amount,
  payment_unverified, (select count(*) from public.invoice_payments p where p.invoice_id = i.id)::text as payments
  from public.invoices i where id = $1`, [id]))[0];

/** A draft as the app makes it (create_with_lines): 1 x £100 + 20% VAT = £120. */
async function newDraft(role: Role = "office") {
  const [row] = await asRole<{ id: string }>(role, `select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb) as id`, [
    JSON.stringify({ customer: "Receipt Guard Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" }),
    JSON.stringify([{ position: 0, description: "Machined flange", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }]),
  ]);
  return row.id;
}
const issue = async (id: string, role: Role = "office") => (await asRole<{ r: string }>(role, "select public.issue_invoice($1) as r", [id]))[0].r;
const pay = (id: string, amount: number, role: Role = "office") =>
  asRole<{ r: { payment_id: string; status: string; amount_paid: string } }>(role, `select public.record_invoice_payment($1, $2, ${TODAY}, 'BACS', 'r', gen_random_uuid()) as r`, [id, amount]);

const RECEIPT_WRITES: Array<[string, string, unknown]> = [
  ["amount_paid", "update public.invoices set amount_paid = $2 where id = $1", 120],
  ["paid_at", "update public.invoices set paid_at = $2 where id = $1", "2026-10-01T12:00:00Z"],
  ["credited_amount", "update public.invoices set credited_amount = $2 where id = $1", 120],
  ["refunded_amount", "update public.invoices set refunded_amount = $2 where id = $1", 7],
  ["payment_unverified", "update public.invoices set payment_unverified = $2 where id = $1", true],
  ["amount_paid + paid_at", "update public.invoices set amount_paid = 120, paid_at = $2 where id = $1", "2026-10-01T12:00:00Z"],
];
const DIRECT = { code: "42501", hint: "invoice_receipts_direct", message: "This draft: what is paid or credited changes only when a payment is recorded (Record payment) or a credit applied (Apply credit), not by editing it." };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("089: an invoice's receipts change only through the payment and credit steps", () => {
  for (const role of ["admin", "office"] as const) {
    it.each(RECEIPT_WRITES)(`refuses ${role} a direct write of %s on a DRAFT; the row is unchanged`, async (_column, sql, value) => {
      const id = await newDraft();
      const before = await read(id);
      expect(await refusal(role, sql, [id, value])).toEqual(DIRECT);
      expect(await read(id)).toEqual(before);
    });
  }

  it("workshop can't reach invoices at all (RLS): nothing changes", async () => {
    const id = await newDraft();
    expect(await asRole("workshop", "update public.invoices set amount_paid = 120 where id = $1 returning id", [id])).toEqual([]);
    expect((await read(id)).amount_paid).toBe("0.00");
  });

  it("THE EXPLOIT: office PATCHes a draft's amount_paid and paid_at, then issues it: the PATCH is refused and the invoice issues with nothing paid", async () => {
    const id = await newDraft();
    expect(await refusal("office", "update public.invoices set amount_paid = 120, paid_at = now() where id = $1", [id])).toEqual(DIRECT);
    const ref = await issue(id);
    expect(ref).toMatch(/^INV-\d+$/);
    expect(await read(id)).toMatchObject({ status: "issued", invoice_ref: ref, amount_paid: "0.00", paid_at: null, credited_amount: "0.00", payments: "0" });
  });

  it("refuses moving a draft straight to paid, part paid or credited (even with a number of the user's choosing)", async () => {
    const id = await newDraft();
    for (const status of ["paid", "partial", "credited"]) {
      expect(await refusal("office", "update public.invoices set status = $2, invoice_ref = $3 where id = $1", [id, status, `INV-9${world.runId}`]), status).toEqual(DIRECT);
    }
    expect((await read(id)).status).toBe("draft");
  });

  it("refuses a new invoice that starts with a credit, a refund or the unverified flag (033 still refuses amount paid and the paid date)", async () => {
    for (const extra of [{ credited_amount: 120 }, { refunded_amount: 5 }, { payment_unverified: true }]) {
      const refused = await refusal("office", `select public.create_with_lines('invoices', $1::jsonb, 'invoice_line_items', 'invoice_id', $2::jsonb)`, [
        JSON.stringify({ customer: "Receipt Guard Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, status: "draft", ...extra }),
        JSON.stringify([{ position: 0, description: "Flange", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }]),
      ]);
      expect(refused, JSON.stringify(extra)).toMatchObject({ code: "42501", hint: "invoice_receipts_direct" });
    }
    const paid = await refusal("office", "insert into public.invoices (organization_id, customer, status, amount_paid) values ($1, 'X', 'draft', 10)", [alpha().id]);
    expect(paid).toMatchObject({ code: "42501", message: "A new invoices must be saved as a draft and then issued (not set: amount_paid)." });
  });

  it("a draft that already carries amounts (written before 089) is not issued until corrected; it stays a draft with no number", async () => {
    const id = await newDraft();
    await owner("update public.invoices set amount_paid = 120, paid_at = now() where id = $1", [id]);
    expect(await refusal("office", "select public.issue_invoice($1)", [id])).toEqual({
      code: "22023", hint: "invoice_receipts_mismatch",
      message: "This draft shows £120.00 paid and £0.00 credited, but its recorded payments and credits come to £0.00 and £0.00: it was not issued. Ask for the invoice to be checked.",
    });
    await owner("update public.invoices set credited_amount = 50, amount_paid = 0, paid_at = null where id = $1", [id]);
    expect((await refusal("admin", "select public.issue_invoice($1)", [id]))?.hint).toBe("invoice_receipts_mismatch");
    expect(await read(id)).toMatchObject({ status: "draft", invoice_ref: null });
    await owner("update public.invoices set credited_amount = 0 where id = $1", [id]);
    expect(await issue(id)).toMatch(/^INV-\d+$/);
  });

  it("on an ISSUED invoice 076's refusals are unchanged, and the unverified flag can't be set by hand", async () => {
    const id = await newDraft();
    const ref = await issue(id);
    for (const role of ["admin", "office"] as const) {
      expect(await refusal(role, "update public.invoices set amount_paid = 120 where id = $1", [id])).toEqual({
        code: "42501", hint: undefined, message: `Invoice ${ref}: payments are recorded with Record payment and credits applied with Apply credit, not by editing the amounts.`,
      });
      expect(await refusal(role, "update public.invoices set payment_unverified = true where id = $1", [id])).toEqual({ ...DIRECT, message: DIRECT.message.replace("This draft", ref) });
    }
    expect(await read(id)).toMatchObject({ amount_paid: "0.00", payment_unverified: false });
  });

  it("the same values written again and other fields still save on a draft", async () => {
    const id = await newDraft();
    await asRole("office", "update public.invoices set amount_paid = 0, paid_at = null, credited_amount = 0, payment_unverified = false, invoice_note = 'Collect from goods in' where id = $1", [id]);
    expect((await owner<{ n: string }>("select invoice_note as n from public.invoices where id = $1", [id]))[0].n).toBe("Collect from goods in");
  });

  it("Record payment, Reverse payment and Confirm payments still work", async () => {
    const id = await newDraft();
    await issue(id);
    const [part] = await pay(id, 50);
    expect(part.r).toMatchObject({ status: "partial" });
    const [full] = await pay(id, 70, "admin");
    expect(full.r).toMatchObject({ status: "paid" });
    expect(await read(id)).toMatchObject({ status: "paid", amount_paid: "120.00", payments: "2" });
    expect((await read(id)).paid_at).not.toBeNull();
    const [rev] = await asRole<{ r: { status: string } }>("admin", "select public.reverse_invoice_payment($1, 'Bounced') as r", [full.r.payment_id]);
    expect(rev.r.status).toBe("partial");
    expect(await read(id)).toMatchObject({ status: "partial", amount_paid: "50.00", paid_at: null, payments: "3" });
    // The flag is set by the import / the server (service role); an admin confirms it with the step.
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("update public.invoices set payment_unverified = true where id = $1", [id]);
      await db.query("commit");
    });
    await asRole("admin", "select public.confirm_invoice_payments($1, 'Checked against the bank') as r", [id]);
    expect((await read(id)).payment_unverified).toBe(false);
  });

  it("a credit note (issued and applied by allocate_credit_note), customer credit moved to another invoice and refunded still work", async () => {
    const credit = async (id: string) => {
      const [line] = await owner<{ id: string }>("select id from public.invoice_line_items where invoice_id = $1", [id]);
      const [cn] = await asRole<{ r: string }>("admin", `select public.create_credit_note($1, 'Returned', ${TODAY}, $2::jsonb) as r`, [id, JSON.stringify([{ invoice_line_id: line.id, quantity: 1 }])]);
      await asRole("admin", "select public.issue_credit_note($1)", [cn.r]); // applies all of it (allocate_credit_note) in the same step
    };
    const a = await newDraft();
    await issue(a);
    await credit(a);
    expect(await read(a)).toMatchObject({ status: "credited", credited_amount: "120.00", amount_paid: "0.00" });
    // Paid in full, then credited in full: £120 customer credit on it; £50 moved to B, £20 refunded.
    const paidThenCredited = await newDraft();
    await issue(paidThenCredited);
    await pay(paidThenCredited, 120);
    await credit(paidThenCredited);
    const b = await newDraft();
    await issue(b);
    await asRole("office", "select public.apply_customer_credit($1, $2, 50, gen_random_uuid())", [paidThenCredited, b]);
    await asRole("admin", `select public.refund_customer_credit($1, 20, ${TODAY}, 'BACS', 'r', 'Asked for it back', gen_random_uuid())`, [paidThenCredited]);
    expect(await read(paidThenCredited)).toMatchObject({ status: "paid", amount_paid: "120.00", credited_amount: "120.00", refunded_amount: "70.00" });
    expect(await read(b)).toMatchObject({ status: "issued", credited_amount: "50.00", amount_paid: "0.00" });
  });

  it("the database owner and the service role are exempt (maintenance, the importer, the server's own jobs)", async () => {
    const id = await newDraft();
    await owner("update public.invoices set amount_paid = 1 where id = $1", [id]);
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("update public.invoices set amount_paid = 2, credited_amount = 3 where id = $1", [id]);
      await db.query("commit");
    });
    expect(await read(id)).toMatchObject({ amount_paid: "2.00", credited_amount: "3.00" });
  });
});
