/**
 * Data import PR2 (migration 085): credit notes, delivery notes, and who sent a PO or an invoice and who signed a delivery note, on 076's
 * engine (as 079 left it). Synthetic data only.
 *
 *   * a credit note goes in issued, with its number as written, applied in full to an invoice the same file creates (allocation row,
 *     invoice credited / paid as allocate_credit_note settles it); 078's next CRD number carries on after it;
 *   * linked by the invoice's number; another customer, an invoice already in Tolra, no invoice, a void invoice, credit notes over the
 *     invoice's total, net + VAT <> total, a draft or void credit note: problems, nothing written; the same file again is matched;
 *   * delivery notes with their items, linked (each on exactly one match, for the note's customer) to customer, job, sales order (only
 *     its job's) and invoice, never another customer's; an
 *     internal job is a problem; DLN numbering carries on; no draft invoice is made;
 *   * people: a name is kept as text and linked to a user only when exactly one member of the company has it (never the other
 *     company's, never on two); a browser session can't write those fields; the import's guard lines are the only way past the credit
 *     note and delivery note guards;
 *   * large: a credit note is committed in its invoice's part; undo removes the credit notes (lines, allocation) and delivery notes
 *     (items) back to the exact before-state, and keeps what was changed or used after the import;
 *   * with pg-safeupdate loaded (Supabase's API sessions; only where this user may LOAD it, as 079's suite): the small and the large path.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

import { LOADABLE } from "./safeupdate-support";
import { type Who, become, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;
const orgA = () => world.tenants.alpha.id;
const orgB = () => world.tenants.beta.id;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

type Counts = { created: number; matched_existing: number; errors: number };
type Problem = { kind: string | null; row: number | null; field: string | null; message: string };
type Result = {
  ok: boolean; committed: boolean; counts: Record<string, Counts>; error_count: number; errors: Problem[]; warning_count: number; warnings: Problem[];
  doc_counters: Record<string, number> | null; size: { records: number; lines: number; audit_rows: number }; kinds: string[];
  import_id?: string; parts?: number | null; parts_committed?: number; status?: string; refused?: { kind: string; ref: string; reason: string }[]; refused_count?: number;
};
const IMPORT = "select public.import_company_data($1::jsonb, $2, $3) as r";
const importAs = (who: Who, payload: unknown, dry = false) =>
  q<{ r: Result }>(who, IMPORT, [JSON.stringify({ file_name: "pr2.xlsx", file_sha256: SHA, ...(payload as object) }), dry, randomUUID()]).then((rows) => rows[0].r);
const sql = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, values)).rows);
const SHA = "b".repeat(64);
const call = (who: Who, text: string, params: unknown[]) => q<{ r: Result }>(who, text, params).then((rows) => rows[0].r);
async function stageAndValidate(who: Who, parts: unknown[], weight = 20, id: string = randomUUID()) {
  for (const [i, p] of parts.entries()) await call(who, "select public.import_stage_part($1, $2, $3::jsonb) as r", [id, i + 1, JSON.stringify({ file_name: "pr2-large.xlsx", file_sha256: SHA, ...(p as object) })]);
  return { id, v: await call(who, "select public.import_validate($1, $2, $3) as r", [id, weight, randomUUID()]) };
}
async function commitAll(who: Who, id: string) {
  const out: Result[] = [];
  for (;;) {
    const r = await call(who, "select public.import_commit_part($1, $2) as r", [id, randomUUID()]);
    out.push(r);
    if (!r.ok || r.parts_committed === r.parts) return out;
  }
}
async function undoAll(who: Who, id: string) {
  const out: Result[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await call(who, "select public.import_undo($1, $2) as r", [id, randomUUID()]);
    out.push(r);
    if (r.status === "undone" || r.status === "cancelled") return out;
  }
  throw new Error("undo did not finish");
}
/** Checksums of the company's business records, incl. 085's tables (audit and import bookkeeping excluded, as 076's test does). */
const BUSINESS = ["customers", "suppliers", "quotes", "sales_orders", "jobs", "purchase_orders", "invoices", "invoice_line_items", "invoice_payments",
  "credit_notes", "credit_note_lines", "invoice_credit_allocations", "delivery_notes", "delivery_note_items", "import_record_keys"];
const checksums = (org: string) => withDb(async (db) => {
  const out: Record<string, string> = {};
  for (const t of BUSINESS) {
    out[t] = (await db.query<{ m: string }>(`select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by to_jsonb(r)::text), '')) as m from public.${t} r where organization_id = $1`, [org])).rows[0].m;
  }
  return out;
});
const messages = (r: Result) => r.errors.map((e) => `${e.kind}.${e.field}: ${e.message}`);

describe("credit notes", () => {
  it("an issued credit note goes in with its invoice: number as written, applied in full, the invoice credited; the same file again matches", async () => {
    const t = randomUUID().slice(0, 6);
    const payload = {
      customers: [{ name: `Credit Co ${t}` }],
      invoices: [
        { invoice_ref: `INV-C${t}-1`, customer: `Credit Co ${t}`, invoice_date: "2026-08-01", status: "sent", lines: [{ description: "Turned part", quantity: 10, unit_price: 12 }] },
        { invoice_ref: `INV-C${t}-2`, customer: `Credit Co ${t}`, invoice_date: "2026-08-02", status: "credited", total: 60, vat: 10 },
        { invoice_ref: `INV-C${t}-3`, customer: `Credit Co ${t}`, invoice_date: "2026-08-03", total: 240, vat: 40 },
      ],
      payments: [{ invoice_ref: `INV-C${t}-3`, paid_on: "2026-08-20", amount: 200, method: "BACS" }],
      credit_notes: [
        // Part of invoice 1, with lines (net 24, VAT 4.80).
        { credit_ref: `CRD-${t}`, invoice_ref: `INV-C${t}-1`, customer: `credit co ${t}`, credit_date: "2026-08-10", reason: "Two returned",
          lines: [{ description: "Turned part", quantity: 2, unit_price: 12 }] },
        // All of invoice 2 (header only).
        { credit_ref: `CN-C${t}`, invoice_ref: `INV-C${t}-2`, credit_date: "2026-08-11", total: 60, vat: 10 },
        // The rest of invoice 3 (200 paid): paid.
        { credit_ref: `CRD-X${t}`, invoice_ref: `INV-C${t}-3`, credit_date: "2026-08-21", total: 40, vat: 0 },
      ],
    };
    const dry = await importAs(A().admin, payload, true);
    expect(messages(dry)).toEqual([]);
    expect(dry.counts.credit_notes).toEqual({ created: 3, matched_existing: 0, errors: 0 });
    // Its lines, and one line each for the two given without (034: a credit note's figures are its lines').
    expect(dry.counts.credit_note_lines).toEqual({ created: 3 });
    expect(dry.kinds).toEqual(["customers", "invoices", "payments", "credit_notes"]);
    // Numbers that are not CRD-<digits> (or CN-<digits>) are imported as written, with a warning.
    expect(dry.warnings.filter((w) => w.kind === "credit_notes" && w.field === "credit_ref").map((w) => w.row)).toEqual(
      [/^\d+$/.test(t) ? null : 2, 3, 4].filter((n) => n !== null));
    expect(await sql("select 1 from public.credit_notes where organization_id = $1 and customer like $2", [orgA(), `%${t}%`])).toEqual([]);

    const r = await importAs(A().admin, payload);
    expect(r).toMatchObject({ ok: true, committed: true });
    const cns = await sql<Record<string, unknown>>(`select c.credit_ref, c.status, c.customer, c.subtotal::text, c.vat::text, c.total::text, c.allocated_amount::text, c.vat_enabled,
        c.credit_date::text, c.reason, (c.issued_at at time zone 'Europe/London')::date::text as issued_on, i.invoice_ref,
        (select count(*)::int from public.credit_note_lines l where l.credit_note_id = c.id) as lines,
        (select sum(a.amount)::text from public.invoice_credit_allocations a where a.credit_note_id = c.id and a.invoice_id = c.invoice_id) as allocated
      from public.credit_notes c join public.invoices i on i.id = c.invoice_id where c.organization_id = $1 and i.invoice_ref like $2 order by i.invoice_ref`, [orgA(), `INV-C${t}-%`]);
    expect(cns).toEqual([
      expect.objectContaining({ status: "issued", customer: `Credit Co ${t}`, subtotal: "24.00", vat: "4.80", total: "28.80", allocated_amount: "28.80", allocated: "28.80", lines: 1,
        credit_date: "2026-08-10", issued_on: "2026-08-10", reason: "Two returned", vat_enabled: true }),
      expect.objectContaining({ credit_ref: `CN-C${t}`, subtotal: "50.00", vat: "10.00", total: "60.00", allocated: "60.00", lines: 1 }),
      expect.objectContaining({ credit_ref: `CRD-X${t}`, total: "40.00", allocated: "40.00" }),
    ]);
    expect(await sql("select invoice_ref, status, amount_paid::text, credited_amount::text, payment_unverified from public.invoices where organization_id = $1 and invoice_ref like $2 order by invoice_ref", [orgA(), `INV-C${t}-%`]))
      .toEqual([
        { invoice_ref: `INV-C${t}-1`, status: "sent", amount_paid: "0.00", credited_amount: "28.80", payment_unverified: false },
        { invoice_ref: `INV-C${t}-2`, status: "credited", amount_paid: "0.00", credited_amount: "60.00", payment_unverified: false },
        { invoice_ref: `INV-C${t}-3`, status: "paid", amount_paid: "200.00", credited_amount: "40.00", payment_unverified: false },
      ]);
    expect(await sql("select l.description, l.quantity::text, l.unit_price::text, l.vat_pct::text, l.vat_exempt, l.vat_amount::text from public.credit_note_lines l join public.credit_notes c on c.id = l.credit_note_id where c.organization_id = $1 and c.credit_ref in ($2, $3) order by c.credit_ref",
      [orgA(), `CN-C${t}`, `CRD-X${t}`])).toEqual([
      { description: `Credit note CN-C${t} (imported without lines)`, quantity: "1.000", unit_price: "50.00", vat_pct: "20.00", vat_exempt: false, vat_amount: "10.00" },
      { description: `Credit note CRD-X${t} (imported without lines)`, quantity: "1.000", unit_price: "40.00", vat_pct: "0.00", vat_exempt: true, vat_amount: "0.00" },
    ]);
    // The keys: one per credit note.
    expect(await sql("select count(*)::int as n from public.import_record_keys where organization_id = $1 and kind = 'credit_notes' and match_key like $2", [orgA(), `%${t}%`])).toEqual([{ n: 3 }]);
    // 034's credit note rules hold (supabase/verify/workflow_034.sql checks 6, 7 and 15): figures = lines, allocated = allocations,
    // the invoice's credited amount = its allocations.
    expect(await sql<{ n: number }>(`select
        (select count(*) from public.credit_notes c where c.organization_id = $1 and (c.subtotal, c.vat, c.total) is distinct from (
          (select coalesce(sum(round(l.quantity * l.unit_price, 2)), 0) from public.credit_note_lines l where l.credit_note_id = c.id),
          (select coalesce(sum(l.vat_amount), 0) from public.credit_note_lines l where l.credit_note_id = c.id),
          (select coalesce(sum(round(l.quantity * l.unit_price, 2) + l.vat_amount), 0) from public.credit_note_lines l where l.credit_note_id = c.id)))
      + (select count(*) from public.credit_notes c where c.organization_id = $1 and c.allocated_amount <> (select coalesce(sum(a.amount), 0) from public.invoice_credit_allocations a where a.credit_note_id = c.id))
      + (select count(*) from public.invoices i where i.organization_id = $1 and i.credited_amount <> (select coalesce(sum(a.amount), 0) from public.invoice_credit_allocations a where a.invoice_id = i.id))
      as n`, [orgA()])).toEqual([{ n: "0" }]);
    // The same file again: everything matched, nothing written.
    const sums = await checksums(orgA());
    const again = await importAs(A().admin, payload);
    expect(again.counts.credit_notes).toEqual({ created: 0, matched_existing: 3, errors: 0 });
    expect(await checksums(orgA())).toEqual(sums);
  });

  it("078's next CRD number carries on after the highest CRD number imported", async () => {
    const t = randomUUID().slice(0, 6);
    const r = await importAs(B().admin, {
      invoices: [{ invoice_ref: `INV-N${t}`, customer: `Numbers ${t}`, invoice_date: "2026-08-01", total: 100, vat: 0 }],
      credit_notes: [{ credit_ref: "CRD-4166", invoice_ref: `INV-N${t}`, credit_date: "2026-08-02", total: 10 }],
    });
    expect(messages(r)).toEqual([]);
    expect(await q<{ n: string }>(B().admin, "select public.next_doc_number('CRD') as n")).toEqual([{ n: "CRD-4167" }]);
    // The other company's counter is its own.
    expect((await q<{ n: string }>(A().admin, "select public.next_doc_number('CRD') as n"))[0].n).not.toBe("CRD-4168");
  });

  it("problems, never a guess: no invoice, an invoice already in Tolra, another customer, void, over-credit, totals, status; nothing written", async () => {
    const t = randomUUID().slice(0, 6);
    expect((await importAs(A().admin, { invoices: [{ invoice_ref: `INV-P${t}-OLD`, customer: `Problem Co ${t}`, invoice_date: "2026-07-01", total: 50, vat: 0 }] })).ok).toBe(true);
    await sql("insert into public.credit_notes (organization_id, invoice_id, credit_ref, status, customer, subtotal, vat, total, allocated_amount) select organization_id, id, $2, 'issued', customer, 5, 0, 5, 0 from public.invoices where organization_id = $1 and invoice_ref = $3",
      [orgA(), `CRD-P${t}`, `INV-P${t}-OLD`]);
    const before = await checksums(orgA());
    const inv = (n: number, extra: object = {}) => ({ invoice_ref: `INV-P${t}-${n}`, customer: `Problem Co ${t}`, invoice_date: "2026-08-01", total: 120, vat: 20, ...extra });
    const cn = (n: number, extra: object) => ({ credit_ref: `CRD-P${t}-${n}`, credit_date: "2026-08-05", total: 12, vat: 2, ...extra });
    const r = await importAs(A().admin, {
      invoices: [inv(1), inv(2, { status: "void" }), inv(3), inv(4, { status: "credited" })],
      credit_notes: [
        cn(1, { invoice_ref: `INV-P${t}-NONE` }),
        cn(2, { invoice_ref: `INV-P${t}-OLD` }),
        cn(3, { invoice_ref: `INV-P${t}-1`, customer: "Somebody Else Ltd" }),
        cn(4, { invoice_ref: `INV-P${t}-2` }),
        cn(5, { invoice_ref: `INV-P${t}-3`, total: 100, vat: 0 }), cn(6, { invoice_ref: `INV-P${t}-3`, total: 30, vat: 0 }),
        cn(7, { invoice_ref: `INV-P${t}-1`, subtotal: 10, vat: 3, total: 12 }),
        cn(8, { invoice_ref: `INV-P${t}-1`, status: "draft" }), cn(9, { invoice_ref: `INV-P${t}-1`, status: "void" }),
        { credit_ref: `CRD-P${t}`, invoice_ref: `INV-P${t}-1`, credit_date: "2026-08-05", total: 12, vat: 2 },
        cn(10, { invoice_ref: undefined }), cn(11, { invoice_ref: `INV-P${t}-1`, total: 0, vat: 0 }),
        cn(12, { invoice_ref: `INV-P${t}-1`, credit_date: "05/08/2026", lines: [{ description: "x", quantity: 1, unit_price: 1.234 }] }),
        cn(13, { invoice_ref: `INV-P${t}-1`, lines: [{ description: "Part", quantity: 1, unit_price: 5 }] }),
        cn(14, { invoice_ref: `INV-P${t}-1`, total: 2, vat: 2 }), cn(15, { invoice_ref: `INV-P${t}-1`, vat_enabled: "no" }),
      ],
    });
    expect(r.ok).toBe(false);
    const m = messages(r);
    expect(m).toEqual(expect.arrayContaining([
      `credit_notes.invoice_ref: There is no invoice INV-P${t}-NONE in this file or in Tolra.`,
      `credit_notes.invoice_ref: Invoice INV-P${t}-OLD is already in Tolra: a credit note is imported only with its invoice (make it on the invoice with New credit note).`,
      `credit_notes.customer: Its invoice INV-P${t}-1 is for Problem Co ${t}, not Somebody Else Ltd.`,
      `credit_notes.invoice_ref: Invoice INV-P${t}-2 is void and can't be credited.`,
      `credit_notes.total: The credit notes for INV-P${t}-3 come to 130.00, more than the invoice's 120.00.`,
      "credit_notes.total: Net + VAT must equal the total.",
      "credit_notes.status: Status must be issued: a draft credit note is not imported, and Tolra has no void credit note (leave it out of the file).",
      `credit_notes.credit_ref: CRD-P${t} is already in Tolra for another invoice or with a different total: nothing is overwritten.`,
      "credit_notes.invoice_ref: Invoice number is required: a credit note in Tolra always credits an invoice.",
      "credit_notes.total: A credit note must credit more than 0.",
      "credit_notes.credit_date: Credit note date must be a real date written YYYY-MM-DD.",
      "credit_notes.lines[1].unit_price: Unit price must be an amount of 0 or more (pounds and pence).",
      "credit_notes.lines: The lines come to net 5.00, VAT 1.00; the credit note says net 10.00, VAT 2.00: its figures must be its lines'.",
      "credit_notes.total: A credit note with VAT needs its net amount.",
      "credit_notes.total: VAT is given, but this credit note charges no VAT (nor does its invoice).",
      "invoices.status: Marked credited, but the credit notes for it in this file come to 0.00 of 120.00 not paid.",
    ]));
    expect(m.filter((x) => x.startsWith("credit_notes.status"))).toHaveLength(2);
    expect(await checksums(orgA()), "nothing written").toEqual(before);
  });

  it("the credit note guards still hold for a browser session: no issued credit note made or deleted directly", async () => {
    const t = randomUUID().slice(0, 6);
    expect((await importAs(A().admin, {
      invoices: [{ invoice_ref: `INV-G${t}`, customer: `Guard Co ${t}`, invoice_date: "2026-08-01", total: 120, vat: 20 }],
      credit_notes: [{ credit_ref: `CRD-G${t}`, invoice_ref: `INV-G${t}`, credit_date: "2026-08-02", total: 12, vat: 2, lines: [{ description: "Part", quantity: 1, unit_price: 10 }] }],
    })).ok).toBe(true);
    const [{ id, invoice_id }] = await sql<{ id: string; invoice_id: string }>("select id, invoice_id from public.credit_notes where organization_id = $1 and credit_ref = $2", [orgA(), `CRD-G${t}`]);
    expect(await refusal(A().admin, "delete from public.credit_notes where id = $1", [id])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "delete from public.credit_note_lines where credit_note_id = $1", [id])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "insert into public.credit_notes (organization_id, invoice_id, credit_ref, status, customer, total, allocated_amount) values ($1, $2, 'CRD-HAND', 'issued', 'x', 1, 0)", [orgA(), invoice_id]))
      .toMatchObject({ code: "42501" });
    // The setting opens them only for the row's own company (a client can't set it through the API at all; in SQL, naming another
    // company does nothing).
    expect(await refusal(A().admin, "with s as (select set_config('quoteflow.data_import_undo', $1, true) as v) delete from public.credit_notes where id = $2 and exists (select 1 from s)", [orgB(), id]))
      .toMatchObject({ code: "42501" });
    expect(await sql("select count(*)::int as n from public.credit_notes where id = $1", [id])).toEqual([{ n: 1 }]);
  });
});

describe("delivery notes", () => {
  it("go in with their items, linked on exactly one match to customer, job, sales order and invoice; no draft invoice; DLN carries on", async () => {
    const t = randomUUID().slice(0, 6);
    const cust = `Despatch Co ${t}`;
    const r = await importAs(A().admin, {
      customers: [{ name: cust }],
      sales_orders: [{ so_number: `SO-D${t}`, customer: cust, total_value: 50 }, { so_number: `SO-E${t}`, customer: cust }],
      jobs: [{ job_no: `J-D${t}`, customer: cust, so_number: `SO-D${t}` }],
      invoices: [{ invoice_ref: `INV-D${t}`, customer: cust, invoice_date: "2026-08-01", total: 60, vat: 10 }],
      delivery_notes: [
        { dn_number: "DLN-7701", customer: cust, job_no: `J-D${t}`, so_number: `SO-D${t}`, invoice_ref: `INV-D${t}`, delivery_date: "2026-08-03", ship_via: "Own van",
          signed_by: "J. Receiver", signed_at: "2026-08-04", lines: [{ description: "Shaft", quantity: 4 }, { description: "Bush", quantity: 2.5 }] },
        // Its job is another one than the order's: the order is not linked (kept in the notes), the job is.
        { dn_number: `DN-${t}`, customer: cust, job_no: `J-D${t}`, so_number: `SO-E${t}`, delivery_date: "2026-08-05", status: "sent out" },
        { dn_number: `DLN-${t}-X`, customer: cust, job_no: "J-NOT-THERE", invoice_ref: "INV-NOT-THERE", delivery_date: "2026-08-06", status: "pending" },
      ],
    });
    expect(messages(r)).toEqual([]);
    expect(r.counts.delivery_notes).toEqual({ created: 3, matched_existing: 0, errors: 0 });
    expect(r.counts.delivery_note_items).toEqual({ created: 2 });
    expect(r.doc_counters?.DLN).toBeGreaterThanOrEqual(7701);
    expect(r.warnings.map((w) => `${w.kind}.${w.field}: ${w.message}`)).toEqual(expect.arrayContaining([
      `delivery_notes.so_number: Not linked to sales order SO-E${t} (not found for this customer, or its job is another one): kept as text in the notes.`,
      "delivery_notes.job_no: Not linked to job J-NOT-THERE (not found for this customer): kept as text.",
      "delivery_notes.invoice_ref: Not linked to invoice INV-NOT-THERE (not found for this customer): kept as text.",
      `delivery_notes.dn_number: DN-${t} is not DLN-<digits>: it is imported as written, and Tolra's DLN numbers carry on from their own counter.`,
    ]));
    const notes = await sql<Record<string, unknown>>(`select d.dn_number, d.status, d.customer_id is not null as customer, j.job_no, s.so_number, i.invoice_ref, d.job_ref, d.notes,
        d.signed_by_name, d.signed_by_user_id, (d.signed_at at time zone 'Europe/London')::date::text as signed_on, (d.despatched_at at time zone 'Europe/London')::date::text as despatched_on,
        (select string_agg(x.description || ' x' || trim_scale(x.quantity), ', ' order by x.position) from public.delivery_note_items x where x.delivery_note_id = d.id) as items
      from public.delivery_notes d left join public.jobs j on j.id = d.job_id left join public.sales_orders s on s.id = d.sales_order_id left join public.invoices i on i.id = d.invoice_id
      where d.organization_id = $1 and d.customer = $2 order by d.delivery_date`, [orgA(), cust]);
    expect(notes).toEqual([
      expect.objectContaining({ dn_number: "DLN-7701", status: "signed", customer: true, job_no: `J-D${t}`, so_number: `SO-D${t}`, invoice_ref: `INV-D${t}`, signed_by_name: "J. Receiver",
        signed_by_user_id: null, signed_on: "2026-08-04", items: "Shaft x4, Bush x2.5" }),
      expect.objectContaining({ dn_number: `DN-${t}`, status: "despatched", job_no: `J-D${t}`, so_number: null, notes: `Sales order: SO-E${t}` }),
      expect.objectContaining({ dn_number: `DLN-${t}-X`, status: "pending", job_no: null, invoice_ref: null, job_ref: "J-NOT-THERE", despatched_on: null }),
    ]);
    // No draft invoice was made from them (059 fires on a status change only), and nothing queued.
    expect(await sql("select count(*)::int as n from public.invoices where organization_id = $1 and customer = $2", [orgA(), cust])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from public.invoice_queue_events q join public.delivery_notes d on d.id = q.delivery_note_id where d.customer = $1", [cust])).toEqual([{ n: 0 }]);
    // A sent-out imported note is frozen for the browser like any other.
    expect(await refusal(A().admin, "delete from public.delivery_notes where organization_id = $1 and dn_number = 'DLN-7701'", [orgA()])).toMatchObject({ code: "42501" });
    expect(await refusal(A().admin, "delete from public.delivery_note_items where delivery_note_id = (select id from public.delivery_notes where organization_id = $1 and dn_number = 'DLN-7701')", [orgA()]))
      .toMatchObject({ code: "42501" });
    // Next DLN after the highest imported one.
    expect(await q<{ n: string }>(A().admin, "select public.next_doc_number('DLN') as n")).toEqual([{ n: "DLN-7702" }]);
  });

  it("a job or invoice of the same number but another customer is never linked; the note's own customer's is", async () => {
    const t = randomUUID().slice(0, 6);
    expect((await importAs(A().admin, {
      jobs: [{ job_no: `J-X${t}`, customer: `Other Co ${t}` }],
      invoices: [{ invoice_ref: `INV-X${t}`, customer: `Other Co ${t}`, invoice_date: "2026-08-01", total: 10, vat: 0 }],
    })).ok).toBe(true);
    const r = await importAs(A().admin, { delivery_notes: [
      { dn_number: `DLN-X${t}`, customer: `Mine Co ${t}`, job_no: `J-X${t}`, invoice_ref: `INV-X${t}`, delivery_date: "2026-08-02" },
      { dn_number: `DLN-Y${t}`, customer: `other co ${t}`, job_no: `J-X${t}`, invoice_ref: `INV-X${t}`, delivery_date: "2026-08-02" },
    ] });
    expect(messages(r)).toEqual([]);
    expect(r.warnings.filter((w) => w.row === 2 && w.field !== "dn_number").map((w) => w.message)).toEqual([
      `Not linked to job J-X${t} (not found for this customer): kept as text.`,
      `Not linked to invoice INV-X${t} (not found for this customer): kept as text.`,
    ]);
    expect(await sql(`select d.dn_number, j.job_no, i.invoice_ref, d.job_ref, d.invoice_ref as invoice_text from public.delivery_notes d
        left join public.jobs j on j.id = d.job_id left join public.invoices i on i.id = d.invoice_id where d.organization_id = $1 and d.dn_number in ($2, $3) order by 1`,
      [orgA(), `DLN-X${t}`, `DLN-Y${t}`])).toEqual([
      { dn_number: `DLN-X${t}`, job_no: null, invoice_ref: null, job_ref: `J-X${t}`, invoice_text: `INV-X${t}` },
      { dn_number: `DLN-Y${t}`, job_no: `J-X${t}`, invoice_ref: `INV-X${t}`, job_ref: `J-X${t}`, invoice_text: `INV-X${t}` },
    ]);
  });

  it("problems: an internal job, a signer without signed status, a number already in Tolra for another customer", async () => {
    const t = randomUUID().slice(0, 6);
    await sql("insert into public.jobs (organization_id, job_no, customer, is_internal) values ($1, $2, '', true)", [orgA(), `J-INT${t}`]);
    await sql("insert into public.delivery_notes (organization_id, dn_number, customer) values ($1, $2, 'Someone Else')", [orgA(), `DLN-OLD${t}`]);
    const r = await importAs(A().admin, { delivery_notes: [
      { dn_number: `DLN-A${t}`, customer: "C", job_no: `J-INT${t}`, delivery_date: "2026-08-01" },
      { dn_number: `DLN-B${t}`, customer: "C", delivery_date: "2026-08-01", status: "delivered", signed_by: "Pat" },
      { dn_number: `DLN-C${t}`, customer: "C", delivery_date: "2026-08-01", status: "signed" },
      { dn_number: `DLN-OLD${t}`, customer: "C", delivery_date: "2026-08-01" },
      { dn_number: `DLN-D${t}`, customer: "C", lines: [{ description: "x", quantity: 0 }] },
    ] }, true);
    expect(messages(r)).toEqual([
      `delivery_notes.job_no: Job J-INT${t} is internal: it has no customer order, so it is never despatched.`,
      "delivery_notes.status: Signed by is given, so the status must be signed.",
      "delivery_notes.status: A signed note needs who signed it (Signed by).",
      "delivery_notes.delivery_date: Delivery date is required.",
      "delivery_notes.lines[1].quantity: Quantity must be more than 0 (at most 3 decimals).",
      `delivery_notes.dn_number: DLN-OLD${t} is already in Tolra for a different customer: nothing is overwritten.`,
    ]);
  });
});

describe("people named on documents", () => {
  it("a name is kept as text and linked only to the one member of this company with it; two with it, or none: not linked", async () => {
    const t = randomUUID().slice(0, 6);
    // Alpha: the office member is "Olive Sender {t}"; the workshop and viewer members share one name. Beta's admin has Olive's name too.
    await sql("update public.user_profiles set full_name = $2 where id = $1", [A().office.id, `Olive Sender ${t}`]);
    await sql("update public.user_profiles set full_name = $2 where id = any($1)", [[A().workshop.id, A().viewer.id], `Sam Same ${t}`]);
    await sql("update public.user_profiles set full_name = $2 where id = $1", [B().admin.id, `Bea Beta ${t}`]);
    const r = await importAs(A().admin, {
      purchase_orders: [{ po_ref: `PO-S${t}`, supplier: "Steel Ltd", sent_by: `  olive   SENDER ${t} ` }, { po_ref: `PO-T${t}`, supplier: "Steel Ltd", sent_by: `Sam Same ${t}` }],
      invoices: [{ invoice_ref: `INV-S${t}`, customer: "C", invoice_date: "2026-08-01", total: 1, vat: 0, sent_by: `Bea Beta ${t}` }],
      delivery_notes: [{ dn_number: `DLN-S${t}`, customer: "C", delivery_date: "2026-08-01", signed_by: `Olive Sender ${t}` }],
    });
    expect(messages(r)).toEqual([]);
    expect(r.warnings.filter((w) => w.field === "sent_by")).toEqual([
      { kind: "purchase_orders", row: 3, field: "sent_by", message: `Sam Same ${t} is the name of 2 people in Tolra: kept as text ("not a Tolra user"), linked to none of them.` },
    ]);
    expect(await sql("select po_ref, sent_by_name, sent_by_user_id from public.purchase_orders where organization_id = $1 and po_ref like $2 order by po_ref", [orgA(), `PO-%${t}`])).toEqual([
      { po_ref: `PO-S${t}`, sent_by_name: `olive   SENDER ${t}`, sent_by_user_id: A().office.id },
      { po_ref: `PO-T${t}`, sent_by_name: `Sam Same ${t}`, sent_by_user_id: null },
    ]);
    // Beta's admin is not one of Alpha's people: kept as text only.
    expect(await sql("select sent_by_name, sent_by_user_id from public.invoices where organization_id = $1 and invoice_ref = $2", [orgA(), `INV-S${t}`])).toEqual([{ sent_by_name: `Bea Beta ${t}`, sent_by_user_id: null }]);
    expect(await sql("select signed_by_name, signed_by_user_id from public.delivery_notes where organization_id = $1 and dn_number = $2", [orgA(), `DLN-S${t}`])).toEqual([{ signed_by_name: `Olive Sender ${t}`, signed_by_user_id: A().office.id }]);
  });

  it("a browser session can't write them (only the import does)", async () => {
    const t = randomUUID().slice(0, 6);
    const inv = (await q<{ id: string }>(A().admin, "insert into public.invoices (organization_id, customer, status) values ($1, 'C', 'draft') returning id", [orgA()]))[0].id;
    expect(await refusal(A().admin, "update public.invoices set sent_by_name = 'Me' where id = $1", [inv])).toMatchObject({ code: "42501", hint: "imported_people_field" });
    expect(await refusal(A().admin, "insert into public.invoices (organization_id, customer, status, sent_by_name) values ($1, 'C', 'draft', 'Me')", [orgA()])).toMatchObject({ code: "42501", hint: "imported_people_field" });
    expect(await refusal(A().admin, "insert into public.purchase_orders (organization_id, po_ref, supplier, status, sent_by_user_id) values ($1, $2, null, 'draft', $3)", [orgA(), `PO-G${t}`, A().admin.id]))
      .toMatchObject({ code: "42501", hint: "imported_people_field" });
    const dn = (await q<{ id: string }>(A().admin, "insert into public.delivery_notes (organization_id, dn_number, customer) values ($1, $2, 'C') returning id", [orgA(), `DLN-G${t}`]))[0].id;
    expect(await refusal(A().admin, "update public.delivery_notes set signed_by_user_id = $2 where id = $1", [dn, A().admin.id])).toMatchObject({ code: "42501", hint: "imported_people_field" });
    // Everything else on the draft is as before: the people fields left alone, an update goes through.
    expect(await refusal(A().admin, "update public.invoices set description = 'Edited' where id = $1", [inv])).toBeNull();
    expect(await refusal(A().admin, "update public.delivery_notes set signed_by_name = 'Customer person' where id = $1", [dn])).toBeNull();
  });
});

describe("a large import with credit notes and delivery notes", () => {
  const file = (t: string) => {
    const cust = `Large PR2 ${t}`;
    const invoices = Array.from({ length: 12 }, (_, i) => ({ invoice_ref: `INV-L${t}-${i + 1}`, customer: cust, invoice_date: "2026-08-01", total: 120, vat: 20 }));
    const credit_notes = [2, 7, 11].map((n) => ({ credit_ref: `CRD-L${t}-${n}`, invoice_ref: `INV-L${t}-${n}`, credit_date: "2026-08-09", total: 120, vat: 20,
      lines: [{ description: "All of it", quantity: 1, unit_price: 100 }] }));
    const delivery_notes = Array.from({ length: 6 }, (_, i) => ({ dn_number: `DLN-L${t}-${i + 1}`, customer: cust, invoice_ref: `INV-L${t}-${i + 1}`, delivery_date: "2026-07-30",
      lines: [{ description: "Part", quantity: 1 }] }));
    // Staged as the app sends it: credit notes in a part of their own, after the invoices (the plan puts them back with their invoice).
    return [{ customers: [{ name: cust }], invoices: invoices.slice(0, 6) }, { invoices: invoices.slice(6) }, { credit_notes }, { delivery_notes }];
  };

  it("commits each credit note in its invoice's part; undo returns the company to exactly its state before; the same file again creates nothing", async () => {
    const t = randomUUID().slice(0, 6);
    const sums = await checksums(orgA());
    const { id, v } = await stageAndValidate(A().admin, file(t), 10);
    expect(messages(v)).toEqual([]);
    expect(v.counts).toMatchObject({ invoices: { created: 12 }, credit_notes: { created: 3 }, delivery_notes: { created: 6 } });
    expect(v.parts).toBeGreaterThanOrEqual(4);
    const plan = (await sql<{ plan: Record<string, [number, number]>[] }>("select plan from public.import_runs where import_id = $1", [id]))[0].plan;
    expect(plan.some((p) => "credit_notes" in p), "credit notes have no slice of their own: they go with their invoice").toBe(false);
    const done = await commitAll(A().admin, id);
    expect(done.every((r) => r.ok)).toBe(true);
    const created = (k: string) => done.reduce((n, r) => n + (r.counts[k]?.created ?? 0), 0);
    expect([created("invoices"), created("credit_notes"), created("delivery_notes"), created("credit_note_lines"), created("delivery_note_items")]).toEqual([12, 3, 6, 3, 6]);
    expect(await sql("select count(*)::int as n from public.invoices where organization_id = $1 and invoice_ref like $2 and status = 'credited' and credited_amount = 120", [orgA(), `INV-L${t}-%`])).toEqual([{ n: 3 }]);
    expect(await sql("select count(*)::int as n from public.delivery_notes d join public.invoices i on i.id = d.invoice_id where d.organization_id = $1 and d.dn_number like $2", [orgA(), `DLN-L${t}-%`])).toEqual([{ n: 6 }]);
    const again = await stageAndValidate(A().admin, file(t), 10);
    expect(again.v.counts).toMatchObject({ credit_notes: { created: 0, matched_existing: 3 }, delivery_notes: { created: 0, matched_existing: 6 } });
    await undoAll(A().admin, again.id);
    const undone = await undoAll(A().admin, id);
    expect(undone.at(-1)).toMatchObject({ status: "undone" });
    expect(undone.every((r) => (r.refused_count ?? 0) === 0)).toBe(true);
    expect(await checksums(orgA()), "after undo: exactly the business records of before the import").toEqual(sums);
  });

  it("undo keeps a delivery note changed after the import and a credit note whose invoice was used, and reports them", async () => {
    const t = randomUUID().slice(0, 6);
    const { id, v } = await stageAndValidate(A().admin, file(t), 10);
    expect(v.ok).toBe(true);
    expect((await commitAll(A().admin, id)).every((r) => r.ok)).toBe(true);
    // Delivery note 2 e-mailed after the import (an allowed change on a sent note): kept, and so its customer and its invoice 2 (it
    // points at them) and that invoice's credit note. Invoice 7 changed after the import: kept with its credit note (lines and allocation).
    await q(A().admin, "update public.delivery_notes set emailed_at = now() where organization_id = $1 and dn_number = $2", [orgA(), `DLN-L${t}-2`]);
    await sql("update public.invoices set description = 'changed' where organization_id = $1 and invoice_ref = $2", [orgA(), `INV-L${t}-7`]);
    const undone = await undoAll(A().admin, id);
    const refused = undone.flatMap((r) => r.refused ?? []);
    expect(refused.map((x) => `${x.kind} ${x.ref}: ${x.reason}`).sort()).toEqual([
      `customers large pr2 ${t}: still used in Tolra (delivery_notes)`,
      `delivery_notes DLN-L${t}-2: changed in Tolra after the import`,
      `invoices INV-L${t}-2: still used in Tolra (delivery_notes)`,
      `invoices INV-L${t}-7: changed in Tolra after the import`,
    ]);
    // The kept invoices keep their credit notes (with their lines and allocation); everything else of the import is gone.
    expect(await sql("select c.credit_ref, (select count(*)::int from public.credit_note_lines l where l.credit_note_id = c.id) as lines, (select count(*)::int from public.invoice_credit_allocations a where a.credit_note_id = c.id) as alloc from public.credit_notes c where c.organization_id = $1 and c.credit_ref like $2 order by 1",
      [orgA(), `CRD-L${t}-%`])).toEqual([{ credit_ref: `CRD-L${t}-2`, lines: 1, alloc: 1 }, { credit_ref: `CRD-L${t}-7`, lines: 1, alloc: 1 }]);
    expect(await sql("select dn_number from public.delivery_notes where organization_id = $1 and dn_number like $2 order by 1", [orgA(), `DLN-L${t}-%`])).toEqual([{ dn_number: `DLN-L${t}-2` }]);
    expect(await sql("select count(*)::int as n from public.invoices where organization_id = $1 and invoice_ref like $2", [orgA(), `INV-L${t}-%`])).toEqual([{ n: 2 }]);
  });
});

// Only where this database user may LOAD safeupdate (as 079's suite): skipped, not failed, elsewhere. CI's API path is 079's suite.
describe.runIf(LOADABLE)("with pg-safeupdate loaded (as in Supabase's API sessions)", () => {
  it("the small and the large path, credit notes and delivery notes included, then undo", async () => {
    const t = randomUUID().slice(0, 6);
    const safe = <T>(who: Who, text: string, params: unknown[]) => withDb(async (db) => {
      await db.query("LOAD 'safeupdate'");
      await db.query("begin");
      try {
        await become(db, who);
        const out = (await db.query<{ r: T }>(text, params)).rows[0].r;
        await db.query("commit");
        return out;
      } catch (e) {
        await db.query("rollback");
        throw e;
      }
    });
    const small = { file_name: "s.csv", file_sha256: SHA, invoices: [{ invoice_ref: `INV-SU${t}`, customer: "SU", invoice_date: "2026-08-01", total: 50, vat: 0 }],
      credit_notes: [{ credit_ref: `CRD-SU${t}`, invoice_ref: `INV-SU${t}`, credit_date: "2026-08-02", total: 50 }],
      delivery_notes: [{ dn_number: `DLN-SU${t}`, customer: "SU", invoice_ref: `INV-SU${t}`, delivery_date: "2026-08-01", lines: [{ description: "x" }] }] };
    const r = await safe<Result>(B().admin, IMPORT, [JSON.stringify(small), false, randomUUID()]);
    expect(messages(r)).toEqual([]);
    expect(r.committed).toBe(true);
    const id = randomUUID();
    await safe(B().admin, "select public.import_stage_part($1, 1, $2::jsonb) as r", [id, JSON.stringify({ ...small, invoices: [{ ...small.invoices[0], invoice_ref: `INV-SV${t}` }],
      credit_notes: [{ ...small.credit_notes[0], credit_ref: `CRD-SV${t}`, invoice_ref: `INV-SV${t}` }], delivery_notes: [{ ...small.delivery_notes[0], dn_number: `DLN-SV${t}` }] })]);
    expect((await safe<Result>(B().admin, "select public.import_validate($1, 10, $2) as r", [id, randomUUID()])).ok).toBe(true);
    for (let i = 0; i < 10; i++) {
      const c = await safe<Result>(B().admin, "select public.import_commit_part($1, $2) as r", [id, randomUUID()]);
      expect(c.ok).toBe(true);
      if (c.parts_committed === c.parts) break;
    }
    for (let i = 0; i < 10; i++) if ((await safe<Result>(B().admin, "select public.import_undo($1, $2) as r", [id, randomUUID()])).status === "undone") break;
    expect(await sql("select count(*)::int as n from public.credit_notes where organization_id = $1 and credit_ref in ($2, $3)", [orgB(), `CRD-SU${t}`, `CRD-SV${t}`])).toEqual([{ n: 1 }]);
    expect(await sql("select count(*)::int as n from public.delivery_notes where organization_id = $1 and dn_number = $2", [orgB(), `DLN-SV${t}`])).toEqual([{ n: 0 }]);
  });
});
