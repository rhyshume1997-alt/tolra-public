/**
 * The Activity log's record numbers and a converted job's description (migration 080). Rhys, production: after QUO-0009 was accepted
 * (sales order SO-0002, job J-0010) the log read "Job QUO-0009" and "Sales order QUO-0009", the quote's Accept line had no number,
 * and the job was described "Converted from SO-0002". Each record is now named by its own number (the order's and the job's rows by
 * SO-... and J-..., the Accept line by the quote's number through lib/activity.ts recordLabel) and the job by the quote's work.
 * SQL only (as PostgREST runs it: role authenticated with the JWT claims), so it also runs against plain PostgreSQL with stand-ins.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ActivityEntry, recordLabel } from "@/lib/activity";
import { documentTotals } from "@/lib/money";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { q } from "./time-support";

let world: SyntheticWorld;
let seq = 0;
const alpha = () => world.tenants.alpha;
const admin = () => ({ id: alpha().users.admin.id });
const office = () => ({ id: alpha().users.office.id });

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  await withDb((db) => db.query(
    "insert into public.organization_settings (organization_id, auto_convert_sales_orders) values ($1, true) on conflict (organization_id) do update set auto_convert_sales_orders = true",
    [alpha().id]));
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

type Line = { description: string; quantity: number; unit_price: number };

/** A sent quote (stored total = its lines) made directly in the database; returns its id, number and line ids in order. */
async function sentQuote(lines: Line[]) {
  seq += 1;
  const ref = `QL-${world.runId}-${seq}`;
  const total = documentTotals(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, vatPct: 20, vatExempt: false })), 0, { vatEnabled: true }).total;
  return withDb(async (db) => {
    const id = (await db.query("insert into public.quotes (organization_id, quote_ref, customer, status, total_value, vat_enabled) values ($1, $2, $3, 'draft', $4, true) returning id",
      [alpha().id, ref, `Labels Co ${seq}`, total])).rows[0].id as string;
    const lineIds: string[] = [];
    for (const [position, l] of lines.entries()) {
      lineIds.push((await db.query("insert into public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct, vat_exempt) values ($1, $2, $3, $4, $5, $6, 20, false) returning id",
        [alpha().id, id, position, l.description, l.quantity, l.unit_price])).rows[0].id as string);
    }
    await db.query("update public.quotes set status = 'sent' where id = $1", [id]);
    return { id, ref, lineIds };
  });
}

const activity = async () =>
  (await q<ActivityEntry & Record<string, unknown>>(admin(), "select * from public.org_activity(null, null, null, null, null, null, 500)"));

describe("Activity log record numbers (080)", () => {
  it("quote accepted -> sales order -> job: each line names its own record's number; the job is described by the quote's work", async () => {
    const quote = await sentQuote([
      { description: "Flange 80mm", quantity: 2, unit_price: 10 },
      { description: " Spacer ", quantity: 1, unit_price: 5 },
      { description: "Flange 80mm", quantity: 1, unit_price: 10 },
      { description: "Bush 25mm (not ordered)", quantity: 3, unit_price: 4 },
    ]);
    // The first three lines ordered; the fourth declined.
    const accepted = (await q<{ r: Record<string, unknown> }>(office(), "select public.accept_quote($1, null, null, $2::uuid[]) as r",
      [quote.id, quote.lineIds.slice(0, 3)]))[0].r;
    expect(accepted.so_created).toBe(true);
    expect(accepted.job_created).toBe(true);
    const soId = accepted.so_id as string;
    const soNumber = accepted.so_number as string;
    const jobId = accepted.job_id as string;
    const jobNo = accepted.job_no as string;
    expect(soNumber).not.toBe(quote.ref);
    expect(jobNo).not.toBe(quote.ref);

    const rows = await activity();
    const forJob = rows.filter((r) => r.record_table === "jobs" && r.record_id === jobId);
    const forOrder = rows.filter((r) => r.record_table === "sales_orders" && r.record_id === soId);
    const forQuote = rows.filter((r) => r.record_table === "quotes" && r.record_id === quote.id);
    expect(forJob.some((r) => r.entity_table === "jobs" && r.action === "INSERT")).toBe(true);
    expect(forOrder.some((r) => r.entity_table === "sales_orders" && r.action === "INSERT")).toBe(true);
    expect(forQuote.some((r) => r.action === "ACCEPT")).toBe(true);
    // Before 080 the job's and the order's rows read the quote's number.
    expect(forJob.map((r) => recordLabel(r))).toEqual(forJob.map(() => jobNo));
    expect(forOrder.map((r) => recordLabel(r))).toEqual(forOrder.map(() => soNumber));
    // The Accept line (a named event: its details are in metadata only) and every other quote line: the quote's number.
    expect(forQuote.map((r) => [r.action, recordLabel(r)])).toEqual(forQuote.map((r) => [r.action, quote.ref]));

    // The job: the distinct ordered line descriptions in line order, not "Converted from SO-...".
    const job = await withDb(async (db) => (await db.query("select description from public.jobs where id = $1", [jobId])).rows[0]);
    expect(job.description).toBe("Flange 80mm; Spacer");
  });

  it("an order without a quote is still converted to a job described 'Converted from SO-...'", async () => {
    const soNumber = `SO-L-${world.runId}`;
    const soId = await withDb(async (db) => (await db.query(
      "insert into public.sales_orders (organization_id, so_number, customer, status, total_value) values ($1, $2, 'No Quote Co', 'confirmed', 0) returning id",
      [alpha().id, soNumber])).rows[0].id as string);
    const made = (await q<{ r: { job_id: string; job_no: string } }>(office(), "select public.convert_sales_order($1) as r", [soId]))[0].r;
    const job = await withDb(async (db) => (await db.query("select description, specification from public.jobs where id = $1", [made.job_id])).rows[0]);
    expect(job.description).toBe(`Converted from ${soNumber}`);
    // No customer PO: the job sheet still names the sales order (134 changes only orders with a PO).
    expect(job.specification).toBe(`Sales order ${soNumber}.`);
    const rows = (await activity()).filter((r) => r.record_table === "jobs" && r.record_id === made.job_id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => recordLabel(r))).toEqual(rows.map(() => made.job_no));
  });

  it("labels each kind of document by its own number, never another document's, and is not callable from the API", async () => {
    const label = (table: string, row: Record<string, unknown>) =>
      withDb(async (db) => (await db.query("select security_audit.activity_label($1, $2::jsonb) as v", [table, JSON.stringify(row)])).rows[0].v as string | null);
    expect(await label("jobs", { quote_ref: "QUO-0009", job_no: "J-0010", description: "Flange" })).toBe("J-0010");
    expect(await label("sales_orders", { quote_ref: "QUO-0009", so_number: "SO-0002", customer_po: "PO-1" })).toBe("SO-0002");
    expect(await label("invoices", { quote_ref: "QUO-0009", invoice_ref: "INV-0007" })).toBe("INV-0007");
    expect(await label("delivery_notes", { invoice_ref: "INV-0007", dn_number: "DN-0003" })).toBe("DN-0003");
    expect(await label("credit_notes", { credit_ref: "CRD-0001" })).toBe("CRD-0001");
    expect(await label("purchase_orders", { po_ref: "PO-0004", po_number: "4471" })).toBe("PO-0004");
    expect(await label("quotes", { quote_ref: "QUO-0009" })).toBe("QUO-0009");
    // Without its own number: its description, never another document's number.
    expect(await label("jobs", { quote_ref: "QUO-0009", description: "Internal tooling" })).toBe("Internal tooling");
    // Any other table: exactly the one-argument label (013).
    expect(await label("customers", { name: "Acme" })).toBe("Acme");
    const same = await withDb(async (db) => (await db.query(
      "select security_audit.activity_label('machines', $1::jsonb) is not distinct from security_audit.activity_label($1::jsonb) as v", [JSON.stringify({ quote_ref: "Q", name: "Lathe" })])).rows[0].v);
    expect(same).toBe(true);
    const callable = await withDb(async (db) => (await db.query(
      "select has_function_privilege('authenticated', 'security_audit.activity_label(text,jsonb)'::regprocedure, 'EXECUTE') or has_function_privilege('anon', 'security_audit.activity_label(text,jsonb)'::regprocedure, 'EXECUTE') as v")).rows[0].v);
    expect(callable).toBe(false);
  });
});
