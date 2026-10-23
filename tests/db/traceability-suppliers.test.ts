/**
 * ISO 9001 PR B (migration 082): traceability before an inspection pass (8.5.2), suppliers and customers that records use are never
 * deleted or renamed (7.5.3), and a simple supplier status approved / conditional / blocked (8.4). Decided Tue 20 Oct: only an admin
 * changes a status; a new purchase order names a supplier on the list; a blocked supplier is refused when a draft is issued.
 * SQL only (as PostgREST runs it: role authenticated with the JWT claims), so it also runs against plain PostgreSQL with stand-ins.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, become, q, refusal } from "./time-support";

let world: SyntheticWorld;
let seq = 0;
const alpha = () => world.tenants.alpha;
const org = () => alpha().id;
const admin = (): Who => ({ id: alpha().users.admin.id });
const office = (): Who => ({ id: alpha().users.office.id });
const workshop = (): Who => ({ id: alpha().users.workshop.id });
const tag = (what: string) => `${what} ${world.runId} ${(seq += 1)}`;
const backendPid = async (db: Client) => Number((await db.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p);
/** True once the session `pid` is waiting for a row lock (polled for up to 5 s). */
async function waitsOnLock(pid: number) {
  for (let i = 0; i < 100; i += 1) {
    const wait = (await withDb((c) => c.query<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [pid]))).rows[0]?.w;
    if (wait === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
const one = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withDb(async (db) => (await db.query<R>(text, params)).rows[0]);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** A supplier added in the app: by the office when approved (the default), by an admin with another status (only an admin sets it). */
async function supplier(status: "approved" | "conditional" | "blocked" = "approved") {
  const name = tag("Supplier");
  const id = status === "approved"
    ? (await q<{ id: string }>(office(), "insert into public.suppliers (organization_id, name) values ($1, $2) returning id", [org(), name]))[0].id
    : (await q<{ id: string }>(admin(), "insert into public.suppliers (organization_id, name, supplier_status) values ($1, $2, $3) returning id", [org(), name, status]))[0].id;
  return { id, name };
}
const count = async (table: string, id: string) => Number((await one<{ n: number }>(`select count(*)::int as n from public.${table} where id = $1`, [id])).n);
const nameOf = async (table: string, id: string) => (await one<{ v: string }>(`select name as v from public.${table} where id = $1`, [id])).v;

const insertPo = (who: Who, supplierName: string) =>
  q<{ id: string }>(who, "insert into public.purchase_orders (organization_id, po_ref, supplier, total_value, status) values ($1, $2, $3, 10, 'draft') returning id",
    [org(), `PO-TS-${world.runId}-${(seq += 1)}`, supplierName]).then((rows) => rows[0].id);

/** A finished job awaiting inspection (made directly in the database, as the inspection tests do). */
async function finishedJob(customer: string, extra: Record<string, unknown> = {}) {
  const cols = ["organization_id", "job_no", "customer", "stage", "started_at", "finished_at", "quantity_required", ...Object.keys(extra)];
  const values = [org(), `J-TS-${world.runId}-${(seq += 1)}`, customer, "inspection", "2026-10-01T08:00:00Z", "2026-10-02T08:00:00Z", 5, ...Object.values(extra)];
  return (await one<{ id: string }>(`insert into public.jobs (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, values)).id;
}
const version = async (job: string) => Number((await one<{ v: number }>("select worksheet_version as v from public.jobs where id = $1", [job])).v);
/**
 * An inspection as the app records it after 081: a pass or a concession through inspect_job (with its acceptance criteria), a fail
 * through record_job_inspection (sent the old way, still recorded). Resolves with the refusal, or null.
 */
const inspect = async (who: Who, job: string, result = "pass") => result === "fail"
  ? refusal(who, "select public.record_job_inspection($1, 'fail', 'Bore 25.04 mm', null, null, null, $2)", [job, await version(job)])
  : refusal(who, "select public.inspect_job($1, $2, 'Drawing rev A: bore 25.00 +0.02/-0', 'Bore 25.01 mm', $3, null, null, $4)",
    [job, result, await version(job), result === "concession" ? "Accepted by the customer" : null]);

describe("8.5.2: material cert and heat/cast before a pass, only on traceable jobs", () => {
  it("a new job takes its customer's default (off unless the customer is traceable); by name or the sales order's customer", async () => {
    const traceable = tag("Aero Co");
    const plain = tag("Plain Co");
    const customerId = (await q<{ id: string }>(office(), "insert into public.customers (organization_id, name, traceable_default) values ($1, $2, true) returning id", [org(), traceable]))[0].id;
    await q(office(), "insert into public.customers (organization_id, name) values ($1, $2)", [org(), plain]);
    expect((await one<{ v: boolean }>("select traceable_default as v from public.customers where name = $1", [plain])).v).toBe(false);
    const a = (await q<{ id: string; traceable: boolean }>(office(), "insert into public.jobs (organization_id, job_no, customer) values ($1, $2, $3) returning id, traceable", [org(), `J-TS-${world.runId}-a`, `  ${traceable.toUpperCase()} `]))[0];
    const b = (await q<{ id: string; traceable: boolean }>(office(), "insert into public.jobs (organization_id, job_no, customer) values ($1, $2, $3) returning id, traceable", [org(), `J-TS-${world.runId}-b`, plain]))[0];
    expect(a.traceable).toBe(true);
    expect(b.traceable).toBe(false);
    // A sales order whose customer is the traceable one (by id), under another spelling of the name: the job made from it is traceable.
    const so = (await one<{ id: string }>("insert into public.sales_orders (organization_id, so_number, customer, customer_id, status, total_value) values ($1, $2, 'Aero (trading name)', $3, 'confirmed', 0) returning id",
      [org(), `SO-TS-${world.runId}`, customerId])).id;
    const made = (await q<{ r: { job_id: string } }>(office(), "select public.convert_sales_order($1) as r", [so]))[0].r;
    expect((await one<{ v: boolean }>("select traceable as v from public.jobs where id = $1", [made.job_id])).v).toBe(true);
  });

  it("a pass on a traceable job is refused until the job has its cert no. and heat/cast no.; a fail, a concession and untraceable jobs are not", async () => {
    const job = await finishedJob(tag("Trace Co"), { traceable: true });
    const refused = await inspect(admin(), job);
    expect(refused).toMatchObject({ code: "22023", hint: "traceability_missing" });
    expect(refused?.message).toMatch(/is traceable: enter its material cert no\. and heat\/cast no\. on the worksheet before it can pass/);
    expect(Number((await one<{ n: number }>("select count(*)::int as n from public.job_inspections where job_id = $1", [job])).n)).toBe(0);
    // Only the cert no.: still refused, naming what is missing.
    await q(office(), "update public.jobs set material_cert_no = 'MC-123' where id = $1", [job]);
    expect((await inspect(admin(), job))?.message).toMatch(/enter its heat\/cast no\. on the worksheet/);
    await q(office(), "update public.jobs set heat_cast_no = ' HC-77 ' where id = $1", [job]);
    expect(await inspect(admin(), job)).toBeNull();
    expect((await one<{ r: string }>("select result as r from public.job_inspections where job_id = $1", [job])).r).toBe("pass");

    // Not traceable: passes without them, as before.
    expect(await inspect(admin(), await finishedJob(tag("Plain Co")))).toBeNull();
    // Traceable, nothing entered: an admin's concession and a fail still go through.
    expect(await inspect(admin(), await finishedJob(tag("Trace Co"), { traceable: true }), "concession")).toBeNull();
    expect(await inspect(admin(), await finishedJob(tag("Trace Co"), { traceable: true }), "fail")).toBeNull();
  });

  it("an offline replay of a pass already committed is answered as it was, even if the job has since become traceable (081's replay inserts nothing)", async () => {
    const job = await finishedJob(tag("Replay Co"));
    const key = randomUUID();
    const send = async () => (await q<{ r: { replayed?: boolean; result: string } }>(admin(),
      "select public.inspect_job($1, 'pass', 'Drawing rev A: bore 25.00 +0.02/-0', 'Bore 25.01 mm', $2, null, null, null, null, null, null, $3) as r", [job, await version(job), key]))[0].r;
    expect((await send()).result).toBe("pass");
    // Made traceable after the pass, with no cert no. or heat/cast no.: a new pass would be refused, but the replay is the same record.
    await one("update public.jobs set traceable = true where id = $1", [job]);
    expect(await send()).toMatchObject({ result: "pass", replayed: true });
    expect(Number((await one<{ n: number }>("select count(*)::int as n from public.job_inspections where job_id = $1", [job])).n)).toBe(1);
  });

  it("only admin and office change a job's flag; the change is in the job's activity trail with who and when", async () => {
    const job = await finishedJob(tag("Flag Co"));
    expect(await refusal(workshop(), "update public.jobs set traceable = true where id = $1", [job])).toMatchObject({ code: "42501" });
    await q(office(), "update public.jobs set traceable = true where id = $1", [job]);
    const row = await one<{ actor_user_id: string; created_at: string }>(
      "select actor_user_id, created_at from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'UPDATE' and new_data ->> 'traceable' = 'true' and old_data ->> 'traceable' = 'false'", [job]);
    expect(row.actor_user_id).toBe(office().id);
    // The flag is not a worksheet field: the revision stays (an operator's sign-off still matches).
    expect(await version(job)).toBe(0);
  });
});

describe("7.5.3: records are kept", () => {
  it("a supplier on a purchase order, a job's material or a stock item can't be deleted; one nothing uses can", async () => {
    const used = await supplier();
    await insertPo(office(), ` ${used.name.toLowerCase()}`);
    const refused = await refusal(office(), "delete from public.suppliers where id = $1", [used.id]);
    expect(refused).toMatchObject({ code: "22023", hint: "supplier_in_use" });
    expect(refused?.message).toMatch(/is on 1 purchase order and can't be deleted: those records keep it\. To stop new orders, an admin can set it to Blocked\./);
    const onJob = await supplier();
    await finishedJob(tag("Material Co"), { material_supplier: onJob.name });
    expect(await refusal(admin(), "delete from public.suppliers where id = $1", [onJob.id])).toMatchObject({ hint: "supplier_in_use" });
    const onStock = await supplier();
    await one("insert into public.stock (organization_id, sku, material, preferred_supplier) values ($1, $2, 'EN8', $3) returning id", [org(), `SKU-${world.runId}`, onStock.name]);
    expect((await refusal(admin(), "delete from public.suppliers where id = $1", [onStock.id]))?.message).toMatch(/is on 1 stock item/);
    for (const s of [used, onJob, onStock]) expect((await one<{ n: number }>("select count(*)::int as n from public.suppliers where id = $1", [s.id])).n).toBe(1);

    const unused = await supplier();
    expect(await refusal(office(), "delete from public.suppliers where id = $1", [unused.id])).toBeNull();
    expect((await one<{ n: number }>("select count(*)::int as n from public.suppliers where id = $1", [unused.id])).n).toBe(0);
  });

  it("a customer on any document can't be deleted (by name or by link); one with none can", async () => {
    const onQuote = tag("Quote Co");
    const c1 = (await q<{ id: string }>(office(), "insert into public.customers (organization_id, name) values ($1, $2) returning id", [org(), onQuote]))[0].id;
    await one("insert into public.quotes (organization_id, quote_ref, customer, status, total_value) values ($1, $2, $3, 'draft', 0)", [org(), `QTS-${world.runId}`, onQuote.toUpperCase()]);
    const refused = await refusal(office(), "delete from public.customers where id = $1", [c1]);
    expect(refused).toMatchObject({ code: "22023", hint: "customer_in_use" });
    expect(refused?.message).toMatch(/is on 1 document \(quotes, RFQs, orders, jobs, delivery notes, invoices or credit notes\) and can't be deleted/);
    // Linked by id only (the delivery note's own customer text differs).
    const c2 = (await q<{ id: string }>(office(), "insert into public.customers (organization_id, name) values ($1, $2) returning id", [org(), tag("Linked Co")]))[0].id;
    await one("insert into public.delivery_notes (organization_id, dn_number, customer, customer_id) values ($1, $2, 'Someone else', $3)", [org(), `DN-TS-${world.runId}`, c2]);
    expect(await refusal(admin(), "delete from public.customers where id = $1", [c2])).toMatchObject({ hint: "customer_in_use" });
    for (const id of [c1, c2]) expect((await one<{ n: number }>("select count(*)::int as n from public.customers where id = $1", [id])).n).toBe(1);
    const c3 = (await q<{ id: string }>(office(), "insert into public.customers (organization_id, name) values ($1, $2) returning id", [org(), tag("Nothing Co")]))[0].id;
    expect(await refusal(office(), "delete from public.customers where id = $1", [c3])).toBeNull();
  });

  it("only another company's documents never count", async () => {
    const name = tag("Shared Name Ltd");
    await one("insert into public.quotes (organization_id, quote_ref, customer, status, total_value) values ($1, $2, $3, 'draft', 0)", [world.tenants.beta.id, `QTSB-${world.runId}`, name]);
    const id = (await q<{ id: string }>(office(), "insert into public.customers (organization_id, name) values ($1, $2) returning id", [org(), name]))[0].id;
    expect(await refusal(office(), "delete from public.customers where id = $1", [id])).toBeNull();
  });

  it("a supplier that records use can't be renamed (records name it); a change of case or spaces can, and so can an unused one", async () => {
    const used = await supplier();
    await insertPo(office(), used.name);
    const refused = await refusal(office(), "update public.suppliers set name = $2 where id = $1", [used.id, `${used.name} (new)`]);
    expect(refused).toMatchObject({ code: "22023", hint: "supplier_in_use" });
    expect(refused?.message).toMatch(/is on 1 purchase order and can't be renamed: those records keep its name\. Add the new name as another supplier instead\./);
    expect(await refusal(admin(), "update public.suppliers set name = $2 where id = $1", [used.id, "Another Ltd"])).toMatchObject({ hint: "supplier_in_use" });
    expect(await nameOf("suppliers", used.id)).toBe(used.name);
    // Case and surrounding spaces: the records still match, so it saves.
    expect(await refusal(office(), "update public.suppliers set name = $2 where id = $1", [used.id, ` ${used.name.toUpperCase()} `])).toBeNull();
    // Other fields of a used supplier still save (the name is sent unchanged, as the app's form sends it).
    expect(await refusal(office(), "update public.suppliers set name = name, notes = 'Ring first' where id = $1", [used.id])).toBeNull();
    const unused = await supplier();
    expect(await refusal(office(), "update public.suppliers set name = $2 where id = $1", [unused.id, `${unused.name} renamed`])).toBeNull();
  });

  it("a customer on any document can't be renamed; a change of case or spaces can, and so can one with none", async () => {
    const name = tag("Rename Co");
    const id = (await q<{ id: string }>(office(), "insert into public.customers (organization_id, name) values ($1, $2) returning id", [org(), name]))[0].id;
    await one("insert into public.invoices (organization_id, customer) values ($1, $2)", [org(), name]);
    const refused = await refusal(office(), "update public.customers set name = $2 where id = $1", [id, `${name} Group`]);
    expect(refused).toMatchObject({ code: "22023", hint: "customer_in_use" });
    expect(refused?.message).toMatch(/is on 1 document \(quotes, RFQs, orders, jobs, delivery notes, invoices or credit notes\) and can't be renamed: those records keep its name\./);
    expect(await nameOf("customers", id)).toBe(name);
    expect(await refusal(office(), "update public.customers set name = $2 where id = $1", [id, name.toLowerCase()])).toBeNull();
    const free = (await q<{ id: string }>(office(), "insert into public.customers (organization_id, name) values ($1, $2) returning id", [org(), tag("Free Co")]))[0].id;
    expect(await refusal(office(), "update public.customers set name = $2 where id = $1", [free, tag("Free Co renamed")])).toBeNull();
  });
});

describe("8.4: supplier status, a simple flag", () => {
  it("new suppliers are approved; only an admin sets or changes the status; each change is in the activity trail", async () => {
    const s = await supplier();
    expect((await one<{ v: string }>("select supplier_status as v from public.suppliers where id = $1", [s.id])).v).toBe("approved");
    const refused = await refusal(office(), "update public.suppliers set supplier_status = 'blocked' where id = $1", [s.id]);
    expect(refused).toMatchObject({ code: "42501", hint: "supplier_status_admin_only" });
    expect(refused?.message).toBe("Only an admin can change a supplier's status.");
    expect(await refusal(office(), "insert into public.suppliers (organization_id, name, supplier_status) values ($1, $2, 'conditional')", [org(), tag("Office Pick")]))
      .toMatchObject({ code: "42501", hint: "supplier_status_admin_only" });
    // The office's ordinary edit (the status sent back unchanged, as the form does) still saves.
    expect(await refusal(office(), "update public.suppliers set supplier_status = 'approved', phone = '0100' where id = $1", [s.id])).toBeNull();
    expect(await refusal(admin(), "update public.suppliers set supplier_status = 'watch' where id = $1", [s.id])).toMatchObject({ code: "23514" });
    await q(admin(), "update public.suppliers set supplier_status = 'conditional' where id = $1", [s.id]);
    const audit = await one<{ actor_user_id: string; was: string; now: string }>(
      "select actor_user_id, old_data ->> 'supplier_status' as was, new_data ->> 'supplier_status' as now from security_audit.audit_log where entity_table = 'suppliers' and entity_id = $1 and action = 'UPDATE' and new_data ->> 'supplier_status' = 'conditional' order by created_at desc limit 1", [s.id]);
    expect(audit).toEqual({ actor_user_id: admin().id, was: "approved", now: "conditional" });
  });

  it("a new purchase order names a supplier on the list; an existing order keeps the name it has", async () => {
    const insert = (supplierName: string | null) => refusal(office(), "insert into public.purchase_orders (organization_id, po_ref, supplier, total_value, status) values ($1, $2, $3, 10, 'draft')",
      [org(), `PO-L-${world.runId}-${(seq += 1)}`, supplierName]);
    const free = await insert(tag("Typed In Ltd"));
    expect(free).toMatchObject({ code: "22023", hint: "supplier_not_listed" });
    expect(free?.message).toMatch(/^Choose the supplier from the Suppliers list: .* isn't on it\. Add it on the Suppliers page first\.$/);
    expect(await insert(null)).toMatchObject({ hint: "supplier_not_listed" });
    expect(await insert("  ")).toMatchObject({ hint: "supplier_not_listed" });
    // On the list, under another case and spacing: accepted.
    const listed = await supplier();
    expect(await insert(` ${listed.name.toUpperCase()} `)).toBeNull();
    // A draft re-pointed to a name not on the list: refused; to a listed one: fine.
    const draft = await insertPo(office(), listed.name);
    expect(await refusal(office(), "update public.purchase_orders set supplier = $2 where id = $1", [draft, tag("Typed In Ltd")])).toMatchObject({ hint: "supplier_not_listed" });
    expect(await refusal(office(), "update public.purchase_orders set supplier = $2 where id = $1", [draft, (await supplier()).name])).toBeNull();
    // An order from before (a free-text supplier, written by the importer's rights): edited and issued as it is.
    const legacy = (await one<{ id: string }>("insert into public.purchase_orders (organization_id, po_ref, supplier, total_value, status) values ($1, $2, 'Old Free Text Ltd', 10, 'draft') returning id",
      [org(), `PO-OLD-${world.runId}`])).id;
    expect(await refusal(office(), "update public.purchase_orders set notes = 'Chased' where id = $1", [legacy])).toBeNull();
    expect(await refusal(office(), "update public.purchase_orders set status = 'issued' where id = $1", [legacy])).toBeNull();
  });

  it("a blocked supplier: a draft can be made and edited, issuing it is refused, cancelling is not; an issued order's progress still saves", async () => {
    const blocked = await supplier("blocked");
    // Created and edited as a draft: not raised yet, so not refused.
    const draft = await insertPo(office(), ` ${blocked.name.toUpperCase()}`);
    expect(await refusal(office(), "update public.purchase_orders set notes = 'Waiting on approval' where id = $1", [draft])).toBeNull();
    const refused = await refusal(office(), "update public.purchase_orders set status = 'issued' where id = $1", [draft]);
    expect(refused).toMatchObject({ code: "22023", hint: "supplier_blocked" });
    expect(refused?.message).toMatch(/is a blocked supplier, so this purchase order can't be issued\. An admin can change its status on the Suppliers page\./);
    expect(await refusal(admin(), "update public.purchase_orders set status = 'issued' where id = $1", [draft])).toMatchObject({ hint: "supplier_blocked" });
    expect((await one<{ s: string }>("select status as s from public.purchase_orders where id = $1", [draft])).s).toBe("draft");
    // A draft re-pointed to the blocked supplier is still only a draft; issuing it is refused.
    const other = await insertPo(office(), (await supplier()).name);
    expect(await refusal(office(), "update public.purchase_orders set supplier = $2 where id = $1", [other, blocked.name])).toBeNull();
    expect(await refusal(office(), "update public.purchase_orders set status = 'issued' where id = $1", [other])).toMatchObject({ hint: "supplier_blocked" });
    expect(await refusal(office(), "update public.purchase_orders set status = 'cancelled' where id = $1", [other])).toBeNull();
    // Unblocked by an admin: the draft issues.
    await q(admin(), "update public.suppliers set supplier_status = 'approved' where id = $1", [blocked.id]);
    expect(await refusal(office(), "update public.purchase_orders set status = 'issued' where id = $1", [draft])).toBeNull();

    // An order issued before the supplier was blocked: received, notes and the delivery date still save.
    const later = await supplier();
    const issued = await insertPo(office(), later.name);
    await q(office(), "update public.purchase_orders set status = 'issued' where id = $1", [issued]);
    await q(admin(), "update public.suppliers set supplier_status = 'blocked' where id = $1", [later.id]);
    expect(await refusal(office(), "update public.purchase_orders set status = 'received', notes = 'Arrived', expected_delivery = '2026-11-01' where id = $1", [issued])).toBeNull();
  });

  it("a conditional supplier is a warning only (the app shows it at issue): the order is placed and issued", async () => {
    const cond = await supplier("conditional");
    const po = await insertPo(office(), cond.name);
    expect(await refusal(office(), "update public.purchase_orders set status = 'issued' where id = $1", [po])).toBeNull();
  });

  /** Runs `first` in an open transaction in session A, starts `second` in session B, checks B waits for A's row lock, commits A. */
  async function race(first: [Who, string, unknown[]], second: [Who, string, unknown[]]) {
    return withDb((a: Client) => withDb(async (b: Client) => {
      await a.query("begin");
      await become(a, first[0]);
      await a.query(first[1], first[2]);
      const pid = await backendPid(b);
      await b.query("begin");
      await become(b, second[0]);
      const result = b.query(second[1], second[2]).then(() => null, (err: { hint?: string }) => err.hint ?? "error");
      const waited = await waitsOnLock(pid);
      await a.query("commit");
      const hint = await result;
      await b.query("rollback");
      return { waited, hint };
    }));
  }
  const newPo = (name: string): [Who, string, unknown[]] => [office(), "insert into public.purchase_orders (organization_id, po_ref, supplier, total_value, status) values ($1, $2, $3, 10, 'draft')",
    [org(), `PO-R-${world.runId}-${(seq += 1)}`, name]];

  it("a delete waits for an order being placed with that supplier, then is refused (race)", async () => {
    const s = await supplier();
    expect(await race(newPo(s.name), [admin(), "delete from public.suppliers where id = $1", [s.id]])).toEqual({ waited: true, hint: "supplier_in_use" });
    expect(await count("suppliers", s.id)).toBe(1);
  });

  it("a rename waits for an order being placed with that supplier, then is refused (race)", async () => {
    const s = await supplier();
    expect(await race(newPo(s.name), [admin(), "update public.suppliers set name = $2 where id = $1", [s.id, `${s.name} renamed`]])).toEqual({ waited: true, hint: "supplier_in_use" });
    expect(await nameOf("suppliers", s.id)).toBe(s.name);
  });

  it("an order waits for the supplier's delete, then is refused: it is no longer on the list (race)", async () => {
    const s = await supplier();
    expect(await race([admin(), "delete from public.suppliers where id = $1", [s.id]], newPo(s.name))).toEqual({ waited: true, hint: "supplier_not_listed" });
  });

  it("issuing a draft waits for the supplier's block being saved, then is refused (race)", async () => {
    const s = await supplier();
    const draft = await insertPo(office(), s.name);
    expect(await race([admin(), "update public.suppliers set supplier_status = 'blocked' where id = $1", [s.id]],
      [office(), "update public.purchase_orders set status = 'issued' where id = $1", [draft]])).toEqual({ waited: true, hint: "supplier_blocked" });
  });
});
