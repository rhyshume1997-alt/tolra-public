/** Required real PostgreSQL proof. No runIf/skip/fake extension. Started by scripts/c07/run-safeupdate.sh. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb, type SyntheticWorld } from "../support/fixtures";
import { q } from "./time-support";

let world: SyntheticWorld;
beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

const tables = ["customers", "invoices", "invoice_line_items", "invoice_payments", "credit_notes", "credit_note_lines", "invoice_credit_allocations", "delivery_notes", "delivery_note_items", "import_record_keys", "doc_counters"];
const snapshot = (org: string) => withDb(async (db) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await db.query(`select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text), '[]') as rows from public.${t} r where organization_id = $1`, [org])).rows[0].rows]))));

type Result = { ok: boolean; committed?: boolean; error_count?: number; errors?: unknown[] };
it("requires active safeupdate in every fresh direct RPC session, including PL/pgSQL, with a qualified control", async () => {
  await withDb(async (db) => {
    expect((await db.query("select current_setting('safeupdate.enabled', true) as v")).rows[0].v).toBe("on");
    await db.query("create temporary table c07_active (n int)");
    await expect(db.query("update c07_active set n = 1")).rejects.toThrow("UPDATE requires a WHERE clause");
    await expect(db.query("delete from c07_active")).rejects.toThrow("DELETE requires a WHERE clause");
    await expect(db.query("do $$ begin update c07_active set n = 1; end $$")).rejects.toThrow("UPDATE requires a WHERE clause");
    await db.query("update c07_active set n = 1 where true");
  });
});

it("credit/delivery RPC path: dry run and invalid data preserve full rows; injected mid-write failure rolls back; retry is idempotent", async () => {
  const org = world.tenants.alpha.id;
  const admin = world.tenants.alpha.users.admin;
  const t = randomUUID().slice(0, 8);
  const invoice = `INV-C07-${t}`;
  const payload = { file_name: "c07-synthetic.csv", customers: [{ name: `C07 ${t}` }],
    invoices: [{ invoice_ref: invoice, customer: `C07 ${t}`, invoice_date: "2026-08-01", total: 50, vat: 0 }],
    credit_notes: [{ credit_ref: `CRD-C07-${t}`, invoice_ref: invoice, credit_date: "2026-08-02", total: 10, vat: 0 }],
    delivery_notes: [{ dn_number: `DLN-C07-${t}`, customer: `C07 ${t}`, invoice_ref: invoice, delivery_date: "2026-08-01", lines: [{ description: "part", quantity: 1 }] }] };
  const call = async (p: unknown, dry: boolean, op = randomUUID()) => (await q<{ r: Result }>(admin, "select public.import_company_data($1::jsonb, $2, $3) as r", [JSON.stringify(p), dry, op]))[0].r;
  const before = await snapshot(org), other = await snapshot(world.tenants.beta.id);
  expect(await call(payload, true)).toMatchObject({ ok: true, committed: false });
  expect(await snapshot(org)).toEqual(before);
  expect((await call({ ...payload, credit_notes: [{ ...payload.credit_notes[0], total: 500 }] }, false)).ok).toBe(false);
  expect(await snapshot(org)).toEqual(before);
  // Database-owned trigger fails during the actual delivery write, after preceding kinds were processed.
  const fn = `c07_fail_${t}`;
  await withDb(async (db) => {
    await db.query(`create function public.${fn}() returns trigger language plpgsql as $$ begin if NEW.dn_number = 'DLN-C07-${t}' then raise exception 'C07 injected delivery failure'; end if; return NEW; end $$`);
    await db.query(`create trigger ${fn} before insert on public.delivery_notes for each row execute function public.${fn}()`);
  });
  try {
    const op = randomUUID();
    // A driver exception or explicit refused JSON is acceptable; silent success is not.
    let failed = false;
    try { const r = await call(payload, false, op); failed = !r.ok; } catch (e) { expect(String(e)).toContain("C07 injected delivery failure"); failed = true; }
    expect(failed).toBe(true);
    expect(await snapshot(org)).toEqual(before);
  } finally {
    await withDb(async (db) => { await db.query(`drop trigger ${fn} on public.delivery_notes`); await db.query(`drop function public.${fn}()`); });
  }
  const retryOp = randomUUID();
  expect(await call(payload, false, retryOp)).toMatchObject({ ok: true, committed: true });
  const committed = await snapshot(org);
  expect(committed.credit_notes).toHaveLength(1);
  expect(committed.delivery_notes).toHaveLength(1);
  expect(await call(payload, false, retryOp)).toMatchObject({ ok: true });
  expect(await snapshot(org)).toEqual(committed);
  expect(await call(payload, false)).toMatchObject({ ok: true });
  expect(await snapshot(org)).toEqual(committed);
  expect(await snapshot(world.tenants.beta.id)).toEqual(other);
});
