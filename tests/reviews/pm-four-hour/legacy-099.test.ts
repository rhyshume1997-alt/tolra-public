/** Genuine pre099 rows, actual099 release, then authenticated drafting. Synthetic data only. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../../support/fixtures";
import { q, refusal } from "../../db/time-support";
let world: SyntheticWorld;
type Old = { order: string; line: string; invoice: string; note: string; org: string };
let notes: Old, finish: Old, voided: Old, beta: Old;
let before: unknown;
let seq = 0;
const owner = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => withDb(async db => (await db.query<T>(sql, params)).rows);
const admin = () => ({ id: world.tenants.alpha.users.admin.id });
async function seed(org: string, full: boolean): Promise<Old> {
  seq += 1;
  const [{ id: order }] = await owner<{ id: string }>("INSERT INTO public.sales_orders(organization_id,so_number,customer,status,total_value,vat_enabled,vat_pct,vat_exempt) VALUES($1,$2,'FAKE Legacy Co','confirmed',19.90,true,20,false) RETURNING id", [org, `SO-FAKE-${world.runId}-${seq}`]);
  const [{ id: line }] = await owner<{ id: string }>("INSERT INTO public.sales_order_lines(organization_id,sales_order_id,position,description,quantity,unit_price,vat_pct,vat_exempt) VALUES($1,$2,0,'FAKE bush',10,1.99,20,false) RETURNING id", [org, order]);
  const [{ id: invoice }] = await owner<{ id: string }>("INSERT INTO public.invoices(organization_id,customer,status,subtotal,vat,total,vat_enabled,invoice_date,due_date) VALUES($1,'FAKE Legacy Co','draft',$2,$3,$4,true,current_date,current_date+30) RETURNING id", [org, full ? 19.90 : 7.96, full ? 3.98 : 1.59, full ? 23.88 : 9.55]);
  await owner("INSERT INTO public.invoice_line_items(organization_id,invoice_id,position,description,quantity,unit_price,vat_pct,vat_exempt) VALUES($1,$2,0,'FAKE bush',$3,1.99,20,false)", [org, invoice, full ? 10 : 4]);
  const [{ id: note }] = await owner<{ id: string }>("INSERT INTO public.delivery_notes(organization_id,dn_number,customer,sales_order_id,status,invoice_id) VALUES($1,$2,'FAKE Legacy Co',$3,'despatched',$4) RETURNING id", [org, `DLN-FAKE-${world.runId}-${seq}`, order, invoice]);
  await owner("INSERT INTO public.delivery_note_items(organization_id,delivery_note_id,position,description,quantity,sales_order_line_id) VALUES($1,$2,0,'FAKE bush',4,$3)", [org, note, line]);
  if (full) await owner("INSERT INTO security_audit.audit_log(organization_id,action,entity_table,entity_id,metadata) VALUES($1,'JOB_DRAFT_INVOICE','jobs',$2,$3::jsonb)", [org, randomUUID(), JSON.stringify({ outcome: "drafted", invoice_id: invoice, sales_order_id: order })]);
  return { order, line, invoice, note, org };
}
async function snapshot() {
  return { invoices: await owner("SELECT id,status,invoice_ref,subtotal,vat,total,issued_at,issuer_snapshot,updated_at FROM public.invoices ORDER BY id"), lines: await owner("SELECT id,invoice_id,description,quantity,unit_price FROM public.invoice_line_items ORDER BY id"), notes: await owner("SELECT id,invoice_id FROM public.delivery_notes ORDER BY id") };
}
async function billing(old: Old) {
  const [row] = await owner<{ ordered: string; despatched: string; invoiced: string }>("SELECT * FROM public.order_line_billing($1,NULL)", [old.line]);
  return { ordered: Number(row.ordered), despatched: Number(row.despatched), invoiced: Number(row.invoiced) };
}
beforeAll(async () => {
  expect(process.env.CI).toBe("true");
  const identity = await verifyBackendIdentity();
  expect(identity.migrations.every(m => m.slice(0, 3) < "099")).toBe(true);
  expect((await owner<{ exists: boolean }>("SELECT to_regclass('public.invoice_notes_legacy') IS NOT NULL AS exists"))[0].exists).toBe(false);
  world = await createSyntheticWorld();
  notes = await seed(world.tenants.alpha.id, false); finish = await seed(world.tenants.alpha.id, true);
  voided = await seed(world.tenants.alpha.id, false); beta = await seed(world.tenants.beta.id, false);
  await q(admin(), "SELECT public.issue_invoice($1)", [voided.invoice]);
  await q(admin(), "SELECT public.void_invoice($1,'FAKE pre099 correction')", [voided.invoice]);
  // A mismatched-company audit must not classify beta's invoice as a full alpha order.
  await owner("INSERT INTO security_audit.audit_log(organization_id,action,entity_table,entity_id,metadata) VALUES($1,'JOB_DRAFT_INVOICE','jobs',$2,$3::jsonb)", [world.tenants.alpha.id, randomUUID(), JSON.stringify({ outcome: "drafted", invoice_id: beta.invoice, sales_order_id: finish.order })]);
  before = await snapshot();
  execFileSync("psql", [process.env.TEST_DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-X", "--single-transaction", "-f", "supabase/release/099_part_despatch_invoice_quantity.release.sql"], { stdio: "pipe" });
});
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });
describe("099 upgrade with real legacy records", () => {
  it("preserves every pre099 invoice, line, issued snapshot and delivery link", async () => { expect(await snapshot()).toEqual(before); });
  it("takes both legacy snapshots and counts notes4 versus full Job Finish10 without double counting", async () => {
    expect(await owner("SELECT invoice_id FROM public.invoice_notes_legacy WHERE invoice_id=ANY($1::uuid[]) ORDER BY invoice_id", [[notes.invoice, finish.invoice, voided.invoice, beta.invoice]])).toHaveLength(4);
    expect(await owner("SELECT sales_order_id FROM public.invoice_job_finish_legacy WHERE invoice_id=$1", [finish.invoice])).toEqual([{ sales_order_id: finish.order }]);
    expect(await billing(notes)).toEqual({ ordered: 10, despatched: 4, invoiced: 4 });
    expect(await billing(finish)).toEqual({ ordered: 10, despatched: 4, invoiced: 10 });
  });
  it("does not turn a cross-company audit into a full-order legacy snapshot", async () => {
    expect(await owner("SELECT invoice_id FROM public.invoice_job_finish_legacy WHERE invoice_id=$1", [beta.invoice])).toEqual([]);
    expect(await billing(beta)).toEqual({ ordered: 10, despatched: 4, invoiced: 4 });
  });
  it("refuses to bill a live legacy note a second time", async () => {
    expect(await refusal(admin(), "SELECT public.create_invoice_from_delivery_notes($1::uuid[],current_date,current_date+30,'30 days')", [[notes.note]])).toMatchObject({ code: "22023" });
    expect(await snapshot()).toEqual(before);
  });
  it("voided legacy quantity is freed and redrafted exactly once, duplicate requests add nothing", async () => {
    expect(await billing(voided)).toEqual({ ordered: 10, despatched: 4, invoiced: 0 });
    const [{ r }] = await q<{ r: { invoice_id: string; subtotal: number; vat: number; total: number } }>(admin(), "SELECT public.create_invoice_from_delivery_notes($1::uuid[],current_date,current_date+30,'30 days') AS r", [[voided.note]]);
    expect(r).toMatchObject({ subtotal: 7.96, vat: 1.59, total: 9.55 });
    expect(r.invoice_id).not.toBe(voided.invoice);
    expect(await billing(voided)).toEqual({ ordered: 10, despatched: 4, invoiced: 4 });
    expect(await refusal(admin(), "SELECT public.create_invoice_from_delivery_notes($1::uuid[],current_date,current_date+30,'30 days')", [[voided.note]])).toMatchObject({ code: "22023" });
  });
  it("running099 again never widens either snapshot or changes historical invoice records", async () => {
    const oldInvoices = await owner("SELECT * FROM public.invoices WHERE id=ANY($1::uuid[]) ORDER BY id", [[notes.invoice, finish.invoice, voided.invoice, beta.invoice]]);
    const snapshotNotes = await owner("SELECT * FROM public.invoice_notes_legacy ORDER BY invoice_id");
    const snapshotFinish = await owner("SELECT * FROM public.invoice_job_finish_legacy ORDER BY invoice_id");
    execFileSync("psql", [process.env.TEST_DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-X", "--single-transaction", "-f", "supabase/release/099_part_despatch_invoice_quantity.release.sql"], { stdio: "pipe" });
    expect(await owner("SELECT * FROM public.invoice_notes_legacy ORDER BY invoice_id")).toEqual(snapshotNotes);
    expect(await owner("SELECT * FROM public.invoice_job_finish_legacy ORDER BY invoice_id")).toEqual(snapshotFinish);
    expect(await owner("SELECT * FROM public.invoices WHERE id=ANY($1::uuid[]) ORDER BY id", [[notes.invoice, finish.invoice, voided.invoice, beta.invoice]])).toEqual(oldInvoices);
  });
});
