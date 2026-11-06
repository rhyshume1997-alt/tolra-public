/**
 * sm-e (3): characterises what the data-import bypass (the transaction-local setting quoteflow.data_import = the company id, set by
 * 076/079/085's import run) skips, and whether imported invoices land in the aged-debtors figures correctly. Nothing is changed.
 * Every case is one transaction that is always rolled back; the import itself is not run (it needs the Auth API for its caller), the
 * rows are written the way 076/085 write them: status sent / partial / paid, amount_paid from the file's payments, payment_unverified
 * when "marked paid" came with no payments.
 *   - skipped by the flag: the DLN hold and the typed-number refusal (147), the Xero send queue (084).
 *   - NOT skipped by the flag: the job cost record (148) is taken for an imported invoice linked to a job.
 *   - the TS aged-debtors rule (lib/dashboard-analytics owedByAge, lib/dashboard-tile-figures moneyTilesFromRows) agrees with the SQL
 *     dashboard_money_owed (132) on imported-shaped rows, including the edges (30/31/60/61 days, due today, no due date, unconfirmed payment).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";

import { owedByAge } from "@/lib/dashboard-analytics";
import { moneyTilesFromRows } from "@/lib/dashboard-tile-figures";

import { asUser, inTransaction, newActor, newOrg, prepareFixture } from "../support/sm-e-db";

beforeAll(prepareFixture);

const TODAY = "2026-10-20";
const flag = (db: Client, org: string) => db.query("SELECT set_config('quoteflow.data_import', $1, true)", [org]);
const unflag = (db: Client) => db.query("SELECT set_config('quoteflow.data_import', '', true)");
let seq = 0;
async function invoice(db: Client, org: string, o: { status: string; total: number; paid?: number; due?: string | null; unverified?: boolean; job?: string }) {
  const net = Math.round((o.total / 1.2) * 100) / 100, vat = Math.round((o.total - net) * 100) / 100;
  return (await db.query(
    "INSERT INTO public.invoices(organization_id,customer,invoice_ref,status,subtotal,vat,total,amount_paid,due_date,payment_unverified,job_id,invoice_date) VALUES($1,'Imported Ltd',$2,$3,$4,$5,$6,$7,$8,$9,$10,DATE '2026-06-01') RETURNING id",
    [org, `INV-SME-${++seq}`, o.status, net, vat, o.total, o.paid ?? 0, o.due ?? null, o.unverified ?? false, o.job ?? null])).rows[0].id as string;
}

describe("sm-e data import bypass and aged debtors", () => {
  it("the flag skips the DLN hold and the typed-number refusal, and does not move the counter; the allocator then steps over the imported numbers", async () => {
    await inTransaction(async db => {
      const o = await newOrg(db, "dlnimp");
      const office = await newActor(db, o.id, "office");
      await db.query("INSERT INTO public.dln_numbering_pending(organization_id) VALUES($1)", [o.id]);
      const typed = (n: string) => asUser(db, office, "INSERT INTO public.delivery_notes(organization_id,dn_number,customer,status) VALUES($1,$2,'Imported Ltd','delivered')", [o.id, n]);
      expect((await typed("DLN-0001")).error).toMatchObject({ code: "55000", hint: "dln_numbering_not_set" });
      await flag(db, o.id);
      expect((await typed("DLN-0001")).error).toBeUndefined();
      expect((await typed("DLN-0002")).error).toBeUndefined();
      await unflag(db);
      // The imported notes did not touch the counter or the hold.
      expect((await db.query("SELECT last FROM public.doc_counters WHERE organization_id=$1 AND prefix='DLN'", [o.id])).rowCount).toBe(0);
      expect((await db.query("SELECT 1 FROM public.dln_numbering_pending WHERE organization_id=$1", [o.id])).rowCount).toBe(1);
      // A later number from the allocator (078) skips numbers already on a note (it does not look at the hold).
      expect((await asUser<{ n: string }>(db, office, "SELECT public.next_doc_number('DLN') AS n")).rows![0].n).toBe("DLN-0003");
    });
  });

  it("Xero queue (084/144): only a draft-to-issued UPDATE queues; the flag skips that; an import that INSERTS an issued invoice is never queued, flag or not", async () => {
    await inTransaction(async db => {
      const o = await newOrg(db, "xeroimp");
      await db.query("INSERT INTO public.integration_connections(organization_id,provider,status,tenant_id) VALUES($1,'xero','connected','tenant-sme')", [o.id]);
      const queued = async () => (await db.query("SELECT doc_id, action FROM public.integration_sends WHERE organization_id=$1", [o.id])).rows;
      // 1. Inserted already issued (what 076/085 do): the trigger is AFTER UPDATE OF status, so nothing is queued even WITHOUT the flag.
      await invoice(db, o.id, { status: "sent", total: 120, due: "2026-09-01" });
      expect(await queued()).toEqual([]);
      // 2. A draft issued by an update with the flag set: skipped.
      const withFlag = await invoice(db, o.id, { status: "draft", total: 120 });
      await flag(db, o.id);
      await db.query("UPDATE public.invoices SET status='sent' WHERE id=$1", [withFlag]);
      await unflag(db);
      expect(await queued()).toEqual([]);
      // 3. The same update without the flag: queued for Xero.
      const live = await invoice(db, o.id, { status: "draft", total: 120 });
      await db.query("UPDATE public.invoices SET status='sent' WHERE id=$1", [live]);
      expect(await queued()).toEqual([{ doc_id: live, action: "create" }]);
    });
  });

  it("the flag does NOT skip the job cost record: an imported invoice linked to a job takes it, as 'invoiced'", async () => {
    await inTransaction(async db => {
      const o = await newOrg(db, "costimp");
      await db.query("INSERT INTO public.costing_defaults(organization_id,labour_rate_pence,programming_rate_pence,overhead_pct,default_margin_pct) VALUES($1,2000,3000,150,20)", [o.id]);
      await db.query("INSERT INTO public.costing_machines(organization_id,name,hourly_rate_pence) VALUES($1,'Haas',4500)", [o.id]);
      await db.query("INSERT INTO public.costing_materials(organization_id,name,price_pence,price_unit,scrap_pct) VALUES($1,'Alu',450,'kg',5)", [o.id]);
      const job = (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,stage,started_at) VALUES($1,'J-SME-IMP','Imported Ltd','machining',now()) RETURNING id", [o.id])).rows[0].id;
      await flag(db, o.id);
      await invoice(db, o.id, { status: "sent", total: 120, due: "2026-09-01", job });
      await unflag(db);
      await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect((await db.query("SELECT taken_on FROM public.job_cost_snapshots WHERE job_id=$1", [job])).rows).toEqual([{ taken_on: "invoiced" }]);
    });
  });

  it("imported invoices land in the aged-debtors figures the same way in the SQL (132) and the TS, edges included; unconfirmed payments are in neither", async () => {
    await inTransaction(async db => {
      const o = await newOrg(db, "aged");
      const admin = await newActor(db, o.id, "admin");
      await flag(db, o.id);
      const day = (back: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
      await invoice(db, o.id, { status: "sent", total: 120, due: day(80) });               // 60+ : 12000
      await invoice(db, o.id, { status: "partial", total: 120, paid: 50, due: day(19) });   // 1-30 : 7000 (part paid)
      await invoice(db, o.id, { status: "sent", total: 60, due: null });                    // no due date: not due
      await invoice(db, o.id, { status: "sent", total: 24, due: TODAY });                   // due today: not due
      await invoice(db, o.id, { status: "sent", total: 10, due: day(30) });                 // edge 30 -> 1-30
      await invoice(db, o.id, { status: "sent", total: 20, due: day(31) });                 // edge 31 -> 31-60
      await invoice(db, o.id, { status: "sent", total: 30, due: day(60) });                 // edge 60 -> 31-60
      await invoice(db, o.id, { status: "sent", total: 40, due: day(61) });                 // edge 61 -> 60+
      await invoice(db, o.id, { status: "sent", total: 999, due: day(200), unverified: true }); // marked paid, no payments: to confirm
      await invoice(db, o.id, { status: "paid", total: 500, paid: 500, due: day(100) });    // settled
      await invoice(db, o.id, { status: "void", total: 700, due: day(100) });               // void
      await invoice(db, o.id, { status: "written_off", total: 800, due: day(100) });        // written off
      await unflag(db);
      const sql = (await asUser<{ j: Record<string, number> }>(db, admin, "SELECT public.dashboard_money_owed($1::date) AS j", [TODAY])).rows![0].j;
      expect(sql).toMatchObject({ to_confirm: 1, invoices: 8, not_due: 8400, late_1_30: 8000, late_31_60: 5000, late_60_plus: 16000, owed_pence: 37400 });
      const rows = (await db.query("SELECT status,total::float8 AS total,amount_paid::float8 AS amount_paid,credited_amount::float8 AS credited_amount,refunded_amount::float8 AS refunded_amount,to_char(due_date,'YYYY-MM-DD') AS due_date,payment_unverified FROM public.invoices WHERE organization_id=$1", [o.id])).rows;
      const ts = Object.fromEntries(owedByAge(rows.filter(r => r.status !== "paid" && !r.payment_unverified), TODAY).map(b => [b.key, Math.round(b.value * 100)]));
      expect(ts).toEqual({ not_due: sql.not_due, late_1_30: sql.late_1_30, late_31_60: sql.late_31_60, late_60_plus: sql.late_60_plus });
      const tiles = moneyTilesFromRows(rows.filter(r => r.status !== "paid"), TODAY);
      expect(tiles).toMatchObject({ failed: false, toConfirm: 1, unpaidInvoices: 8 });
      expect(Math.round((tiles.moneyOwed ?? 0) * 100)).toBe(sql.owed_pence);
    });
  });
});
