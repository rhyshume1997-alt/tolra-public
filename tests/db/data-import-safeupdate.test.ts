/**
 * The data import under pg-safeupdate (migration 079). Supabase loads safeupdate into every API (PostgREST) session, on hosted projects
 * and on the CLI stack: it refuses an UPDATE or DELETE without its own WHERE clause ("UPDATE requires a WHERE clause"), also inside the
 * functions the API calls. 076's import_company_data_run had eight; 079 adds WHERE TRUE to them. The other data-import DB tests use a
 * direct database session, where safeupdate isn't loaded, so they could not see it.
 *
 *   * through the API (the PostgREST stack, safeupdate preloaded): import_company_data (dry run, then commit), import_stage_part,
 *     import_validate, import_commit_part and import_undo, as the page calls them;
 *   * in a direct session with safeupdate LOADed (where this database user may load it): safeupdate's own refusal of an unqualified
 *     UPDATE and DELETE first, so a pass means it was really in force, then the same calls.
 * At least one of the two must run: in CI both are expected, and the API one is required.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

import { LOADABLE } from "./safeupdate-support";
import { type Who, become } from "./time-support";

type R = { ok: boolean; committed?: boolean; dry_run?: boolean; error_count?: number; errors?: unknown[]; counts?: Record<string, { created?: number; matched_existing?: number }>;
  import_id?: string; large?: boolean; parts?: number | null; parts_committed?: number; status?: string };

/** Whether the API (PostgREST) of the disposable stack is configured. */
const API = (() => {
  try {
    isolatedBackend();
    return true;
  } catch {
    return false;
  }
})();

let world: SyntheticWorld;
const admin = () => world.tenants.alpha.users.admin;
const org = () => world.tenants.alpha.id;
beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

/** A file that reaches every step of the import: every kind, invoices with lines and payments (so all of the decide step runs). */
function file(tag: string) {
  const customer = `Safeupdate Customer ${tag}`;
  return {
    file_name: `safeupdate-${tag}.csv`,
    customers: [{ row: 2, name: customer, email: "accounts@safeupdate.example" }],
    suppliers: [{ row: 2, name: `Safeupdate Steel ${tag}` }],
    stock: [{ row: 2, sku: `SU-${tag}`, material: "EN8 bar 50mm", current_stock: "3", unit_price: "4.25" }],
    quotes: [{ row: 2, quote_ref: `QSU-${tag}`, customer, status: "sent", quote_date: "2026-08-01", total_value: 120 }],
    sales_orders: [{ row: 2, so_number: `SOSU-${tag}`, customer }],
    jobs: [{ row: 2, job_no: `JSU-${tag}`, customer, so_number: `SOSU-${tag}` }],
    purchase_orders: [{ row: 2, po_ref: `POSU-${tag}`, supplier: `Safeupdate Steel ${tag}`, total_value: 99 }],
    invoices: [
      { row: 2, invoice_ref: `ISU-${tag}-1`, customer, invoice_date: "2026-08-10", status: "paid", subtotal: 100, vat: 20, total: 120,
        lines: [{ description: "Part A", quantity: 2, unit_price: 50 }] },
      { row: 3, invoice_ref: `ISU-${tag}-2`, customer, invoice_date: "2026-08-11", status: "sent", total: 60, vat: 10 },
    ],
    payments: [{ row: 2, invoice_ref: `ISU-${tag}-1`, paid_on: "2026-08-20", amount: 120, method: "BACS" }],
  };
}
/** The same records split in two parts for the large import (the parts are merged and validated whole). */
function parts(tag: string) {
  const f = file(tag);
  const { invoices, payments, ...first } = f;
  return [first, { invoices, payments }];
}
const count = (table: string, column: string, like: string) =>
  withDb(async (db) => Number((await db.query<{ n: string }>(`select count(*)::text as n from public.${table} where organization_id = $1 and ${column} like $2`, [org(), like])).rows[0].n));

const run = (id: string) => withDb(async (db) => (await db.query("select status, parts_committed from public.import_runs where import_id = $1", [id])).rows[0]);

/** The calls the page makes, each answering the function's JSON result (or throwing the database's refusal). */
type Calls = {
  importData: (payload: unknown, dry: boolean) => Promise<R>;
  stage: (id: string, part: number, payload: unknown) => Promise<R>;
  validate: (id: string, weight: number) => Promise<R>;
  commit: (id: string) => Promise<R>;
  undo: (id: string) => Promise<R>;
};

/** Every call of the import, small and large, and what each leaves behind. */
function importSuite(calls: () => Calls) {
  it("small file: a dry run answers the counts and writes nothing; the commit writes every record; the same file again matches them", async () => {
    const tag = randomUUID().slice(0, 8);
    const dry = await calls().importData(file(tag), true);
    expect(dry.errors).toEqual([]);
    expect(dry).toMatchObject({ ok: true, dry_run: true, committed: false, error_count: 0 });
    expect(Object.fromEntries(["customers", "stock", "quotes", "sales_orders", "jobs", "purchase_orders", "invoices", "payments"].map((k) => [k, dry.counts?.[k]?.created])))
      .toEqual({ customers: 1, stock: 1, quotes: 1, sales_orders: 1, jobs: 1, purchase_orders: 1, invoices: 2, payments: 1 });
    expect(await count("invoices", "invoice_ref", `ISU-${tag}-%`)).toBe(0);

    const committed = await calls().importData(file(tag), false);
    expect(committed).toMatchObject({ ok: true, committed: true, error_count: 0 });
    expect(await count("invoices", "invoice_ref", `ISU-${tag}-%`)).toBe(2);
    const again = await calls().importData(file(tag), false);
    expect(again).toMatchObject({ ok: true, error_count: 0 });
    expect(again.counts?.invoices).toMatchObject({ created: 0, matched_existing: 2 });
    expect(await count("invoices", "invoice_ref", `ISU-${tag}-%`)).toBe(2);
  });

  it("small file with a problem: refused whole, every problem reported, nothing written", async () => {
    const tag = randomUUID().slice(0, 8);
    const bad = file(tag);
    bad.invoices[1] = { ...bad.invoices[1], invoice_date: "31/08/2026" };
    const r = await calls().importData(bad, false);
    expect(r.ok).toBe(false);
    expect(r.error_count).toBeGreaterThan(0);
    expect(await count("customers", "name", `Safeupdate Customer ${tag}`)).toBe(0);
  });

  it("large file: staged, validated whole, committed part by part, then undone back to nothing", async () => {
    const tag = randomUUID().slice(0, 8);
    const id = randomUUID();
    for (const [i, p] of parts(tag).entries()) expect(await calls().stage(id, i + 1, p)).toMatchObject({ status: "staging" });
    const v = await calls().validate(id, 10);
    expect(v.errors ?? []).toEqual([]);
    expect(v).toMatchObject({ ok: true, large: true, import_id: id });
    expect(v.parts, "one part per group at least: four").toBeGreaterThanOrEqual(4);
    let last: R = v;
    for (let i = 0; i < 50 && last.parts_committed !== last.parts; i++) {
      last = await calls().commit(id);
      expect(last.ok, JSON.stringify(last)).toBe(true);
    }
    expect(last).toMatchObject({ ok: true, parts_committed: v.parts, parts: v.parts });
    expect(await run(id)).toEqual({ status: "committed", parts_committed: v.parts });
    expect(await count("invoices", "invoice_ref", `ISU-${tag}-%`)).toBe(2);
    expect(await count("stock", "sku", `SU-${tag}`)).toBe(1);

    let undone: R = last;
    for (let i = 0; i < 50 && undone.status !== "undone"; i++) undone = await calls().undo(id);
    expect(undone).toMatchObject({ status: "undone" });
    expect(await run(id)).toEqual({ status: "undone", parts_committed: v.parts });
    expect(await count("invoices", "invoice_ref", `ISU-${tag}-%`)).toBe(0);
    expect(await count("stock", "sku", `SU-${tag}`)).toBe(0);
    expect(await count("customers", "name", `Safeupdate Customer ${tag}`)).toBe(0);
  });
}

it("is checked somewhere: the API, or a direct session with safeupdate loaded (CI: the API)", () => {
  expect(API || LOADABLE).toBe(true);
  if (process.env.CI) expect(API).toBe(true);
});

describe.runIf(API)("through the API (PostgREST: safeupdate preloaded by Supabase)", () => {
  let client: Awaited<ReturnType<typeof signedInClient>>;
  beforeAll(async () => { client = await signedInClient(admin()); });
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as R;
  };
  importSuite(() => ({
    importData: (payload, dry) => rpc("import_company_data", { p_payload: payload, p_dry_run: dry, p_client_op_id: randomUUID() }),
    stage: (id, part, payload) => rpc("import_stage_part", { p_import_id: id, p_part: part, p_payload: payload }),
    validate: (id, weight) => rpc("import_validate", { p_import_id: id, p_part_weight: weight, p_client_op_id: randomUUID() }),
    commit: (id) => rpc("import_commit_part", { p_import_id: id, p_client_op_id: randomUUID() }),
    undo: (id) => rpc("import_undo", { p_import_id: id, p_client_op_id: randomUUID() }),
  }));
});

describe.runIf(LOADABLE)("in a direct session with safeupdate loaded", () => {
  /** One statement as `who`, in its own session with safeupdate loaded first (as an API session has it), committed. */
  async function asSafe<T>(who: Who, fn: (db: Client) => Promise<T>): Promise<T> {
    return withDb(async (db) => {
      await db.query("LOAD 'safeupdate'");
      await db.query("begin");
      try {
        await become(db, who);
        const out = await fn(db);
        await db.query("commit");
        return out;
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    });
  }
  const one = (text: string, params: unknown[]) => asSafe(admin(), async (db) => (await db.query<{ r: R }>(text, params)).rows[0].r);

  it("safeupdate is in force in these sessions: an UPDATE or DELETE without WHERE is refused, also inside a function", async () => {
    const refused = (text: string) => withDb(async (db) => {
      await db.query("LOAD 'safeupdate'");
      await db.query("create temporary table su_probe (x int)");
      try {
        await db.query(text);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(await refused("update su_probe set x = 1")).toBe("UPDATE requires a WHERE clause");
    expect(await refused("delete from su_probe")).toBe("DELETE requires a WHERE clause");
    expect(await refused("do $$ begin update su_probe set x = case when exists (select 1 from su_probe p where p.x = 1) then 2 end; end $$"))
      .toBe("UPDATE requires a WHERE clause");
    expect(await refused("update su_probe set x = 1 where true")).toBeNull();
  });

  importSuite(() => ({
    importData: (payload, dry) => one("select public.import_company_data($1::jsonb, $2, $3) as r", [JSON.stringify(payload), dry, randomUUID()]),
    stage: (id, part, payload) => one("select public.import_stage_part($1, $2, $3::jsonb) as r", [id, part, JSON.stringify(payload)]),
    validate: (id, weight) => one("select public.import_validate($1, $2, $3) as r", [id, weight, randomUUID()]),
    commit: (id) => one("select public.import_commit_part($1, $2) as r", [id, randomUUID()]),
    undo: (id) => one("select public.import_undo($1, $2) as r", [id, randomUUID()]),
  }));
});
