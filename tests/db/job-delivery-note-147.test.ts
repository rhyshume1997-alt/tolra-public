/**
 * Post-144 release 147 (C17): create_job_delivery_note makes a delivery note for a job that has NO sales order, linked to the job and its
 * customer by key, numbered DLN in the same transaction, for admin / office / workshop only, in the caller's own company only, with the
 * inspection release gate still in force, an audit row, and one note per request id (a double submit gets the first note back).
 * Pure SQL through the database connection (as company-setup-isolation does). The verified fixture installs 145, 146 and 147 first.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { beforeAll, expect, it } from "vitest";

import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { isolatedBackend } from "../support/isolation";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const MARKER = "post-144 marker 147 job_delivery_note";
type Actor = { id: string; session: string; org: string; email: string; role: string; aal: string };
type Db = Pick<Client, "query">;

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
});

async function org(db: Db, label: string) {
  const id = randomUUID();
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `Synthetic ${label}`, `t-c17-${label}-${id}`]);
  return id;
}
async function actor(db: Db, org: string, role: string, aal = "aal2"): Promise<Actor> {
  const id = randomUUID(), session = randomUUID(), email = `${id}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)", [id, email, role, org]);
  await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,true)", [id, org, role]);
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, id, org]);
  return { id, session, org, email, role, aal };
}
async function customer(db: Db, org: string, name: string) {
  return (await db.query("INSERT INTO public.customers(organization_id,name,email) VALUES($1,$2,$3) RETURNING id", [org, name, `goods@${randomUUID().slice(0, 8)}.example.test`])).rows[0].id as string;
}
async function job(db: Db, org: string, customerName: string, extra: { inspected?: boolean; finished?: boolean; internal?: boolean; order?: string } = {}) {
  const no = `J-C17-${randomUUID().slice(0, 8)}`;
  const id = (await db.query(
    `INSERT INTO public.jobs(organization_id,job_no,customer,description,stage,started_at,finished_at,inspected_at,is_internal,converted_from_sales_order_id)
     VALUES($1,$2,$3,'Brackets',$4,now()-interval '2 days',CASE WHEN $5 OR $8 THEN now()-interval '1 day' END,CASE WHEN $5 THEN now() END,$6,$7) RETURNING id`,
    [org, no, customerName, extra.inspected === false ? (extra.finished ? "inspection" : "machining") : "complete", extra.inspected !== false, Boolean(extra.internal), extra.order ?? null, Boolean(extra.finished)],
  )).rows[0].id as string;
  return { id, no };
}
async function as<T>(db: Db, who: Actor | "anon" | { outsider: string }, sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: { code?: string; message: string; hint?: string } }> {
  await db.query("SAVEPOINT c17_call");
  try {
    if (who === "anon") {
      await db.query("SET LOCAL ROLE anon");
    } else if ("outsider" in who) {
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: who.outsider, role: "authenticated", aal: "aal2", session_id: randomUUID() }), who.outsider]);
    } else {
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: who.id, session_id: who.session, role: "authenticated", aal: who.aal, email: who.email }), who.id]);
    }
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT c17_call");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT c17_call");
    await db.query("RESET ROLE");
    const err = e as { code?: string; message: string; hint?: string };
    return { error: { code: err.code, message: err.message, hint: err.hint } };
  }
}
const CREATE = "SELECT public.create_job_delivery_note($1,$2,$3,DATE '2026-11-04',DATE '2026-11-04','Own van',NULL,$4) AS r";
const lines = (...l: Array<[string, number]>) => JSON.stringify(l.map(([description, quantity]) => ({ description, quantity })));
const make = (db: Db, who: Actor | "anon" | { outsider: string }, jobId: string, customerId: string, request = randomUUID(), items = lines(["Bracket 40mm", 4])) =>
  as<{ r: { id: string; dn_number: string; replayed: boolean } }>(db, who, CREATE, [jobId, customerId, request, items]);
const notesFor = async (db: Db, jobId: string) => Number((await db.query("SELECT count(*) AS n FROM public.delivery_notes WHERE job_id=$1", [jobId])).rows[0].n);
const legacySnapshot = async (db: Db, id: string) => (await db.query("SELECT to_jsonb(d) - 'request_id' AS j FROM public.delivery_notes d WHERE id=$1", [id])).rows[0]?.j;

it("147 is installed: preflight marker applied and every verify row true", async () => {
  await withDb(async db => {
    const marker = (await db.query(read("supabase/verify/release_preflight.sql"))).rows.find(r => r.check === MARKER);
    expect(marker?.value).toBe("applied");
    const checks = (await db.query(read("supabase/verify/job_delivery_note_147.sql"))).rows;
    expect(checks.length).toBeGreaterThanOrEqual(10);
    expect(checks.filter(r => r.ok !== true)).toEqual([]);
  });
});

it("two companies and the role matrix: a no-order job gets a key-linked, numbered, audited note; everyone else is refused", async () => {
  await withDb(async db => {
    await db.query("BEGIN");
    try {
      const alpha = await org(db, "alpha"), beta = await org(db, "beta");
      const admin = await actor(db, alpha, "admin"), office = await actor(db, alpha, "office"), workshop = await actor(db, alpha, "workshop"), viewer = await actor(db, alpha, "viewer");
      const betaAdmin = await actor(db, beta, "admin");
      const acme = await customer(db, alpha, "Acme C17 Ltd"), other = await customer(db, alpha, "Other C17 Ltd"), betaCo = await customer(db, beta, "Beta C17 Ltd");
      const jA = await job(db, alpha, "Acme C17 Ltd"), jA2 = await job(db, alpha, " acme c17 ltd ");
      const jB = await job(db, beta, "Beta C17 Ltd");
      // A legacy note made by hand before 147: text links only. Nothing below may change it.
      const legacy = (await db.query("INSERT INTO public.delivery_notes(organization_id,dn_number,customer,job_ref,status) VALUES($1,'DLN-LEGACY-C17','Acme C17 Ltd',$2,'awaiting') RETURNING id", [alpha, jA.no])).rows[0].id as string;
      const legacyBefore = await legacySnapshot(db, legacy);

      // Office: made, linked by key to the job and the customer record, awaiting, numbered DLN-nnnn, lines without order lines.
      const request = randomUUID();
      const first = await make(db, office, jA.id, acme, request, lines(["Bracket 40mm", 4], ["Spacer", 2.5]));
      expect(first.error).toBeUndefined();
      const r1 = first.rows![0].r;
      expect(r1.replayed).toBe(false);
      expect(r1.dn_number).toMatch(/^DLN-\d{4,}$/);
      const row = (await db.query("SELECT * FROM public.delivery_notes WHERE id=$1", [r1.id])).rows[0];
      expect(row).toMatchObject({ organization_id: alpha, job_id: jA.id, customer_id: acme, job_ref: jA.no, customer: "Acme C17 Ltd", status: "awaiting", sales_order_id: null, invoice_id: null, request_id: request, created_by: office.id, ship_via: "Own van" });
      const items = (await db.query("SELECT description, trim_scale(quantity)::text AS q, sales_order_line_id FROM public.delivery_note_items WHERE delivery_note_id=$1 ORDER BY position", [r1.id])).rows;
      expect(items).toEqual([{ description: "Bracket 40mm", q: "4", sales_order_line_id: null }, { description: "Spacer", q: "2.5", sales_order_line_id: null }]);
      // Audit trail: the row change is logged with who made it (security_audit.log_row_change, as every sibling table).
      const audit = (await db.query("SELECT action, actor_user_id FROM security_audit.audit_log WHERE entity_table='delivery_notes' AND entity_id=$1", [r1.id])).rows;
      expect(audit).toContainEqual({ action: "INSERT", actor_user_id: office.id });

      // Double submit: same request id, same note back, nothing new, no number burnt.
      const again = await make(db, office, jA.id, acme, request);
      expect(again.rows![0].r).toEqual({ id: r1.id, dn_number: r1.dn_number, replayed: true });
      expect(await notesFor(db, jA.id)).toBe(1);
      const reused = await make(db, office, jA2.id, acme, request);
      expect(reused.error).toMatchObject({ code: "22023", message: "That request was already used for another delivery note." });

      // Number allocation: workshop and admin (second step) are allowed; the next numbers follow on, no gap.
      const n = Number(r1.dn_number.slice(4));
      const w = await make(db, workshop, jA2.id, acme);
      expect(w.error).toBeUndefined();
      expect(w.rows![0].r.dn_number).toBe(`DLN-${String(n + 1).padStart(4, "0")}`);
      const a = await make(db, admin, jA.id, acme);
      expect(a.error).toBeUndefined();
      expect(a.rows![0].r.dn_number).toBe(`DLN-${String(n + 2).padStart(4, "0")}`);

      // Refusals: viewer, outsider, anon, another company's admin (job and customer), wrong customer.
      const before = await notesFor(db, jA.id);
      expect((await make(db, viewer, jA.id, acme)).error).toMatchObject({ code: "42501" });
      expect((await make(db, { outsider: randomUUID() }, jA.id, acme)).error).toMatchObject({ code: "42501" });
      expect((await make(db, "anon", jA.id, acme)).error).toMatchObject({ code: "42501" });
      expect((await make(db, betaAdmin, jA.id, betaCo)).error).toMatchObject({ code: "P0002", message: "Job not found" });
      expect((await make(db, betaAdmin, jB.id, acme)).error).toMatchObject({ code: "P0002", message: "Customer not found" });
      expect((await make(db, office, jA.id, other)).error).toMatchObject({ code: "22023", hint: "customer_mismatch" });
      expect((await make(db, office, jA.id, betaCo)).error).toMatchObject({ code: "P0002", message: "Customer not found" });
      expect(await notesFor(db, jA.id)).toBe(before);
      // Beta's own job is fine for beta, and beta cannot read alpha's notes (row security).
      expect((await make(db, betaAdmin, jB.id, betaCo)).error).toBeUndefined();
      expect((await as(db, betaAdmin, "SELECT id FROM public.delivery_notes WHERE id=$1", [r1.id])).rows).toEqual([]);

      // Bad lines are refused and burn no number.
      expect((await make(db, office, jA.id, acme, randomUUID(), lines(["Bracket", 0]))).error).toMatchObject({ code: "22023" });
      expect((await make(db, office, jA.id, acme, randomUUID(), "[]")).error).toMatchObject({ code: "22023" });

      // Release gate kept: a job still being made is refused; so is a finished job awaiting inspection, until an admin releases it
      // early with a reason, which lets it go.
      const making = await job(db, alpha, "Acme C17 Ltd", { inspected: false });
      expect((await make(db, office, making.id, acme)).error).toMatchObject({ code: "22023", hint: "job_not_released" });
      const unreleased = await job(db, alpha, "Acme C17 Ltd", { inspected: false, finished: true });
      expect((await make(db, office, unreleased.id, acme)).error).toMatchObject({ code: "22023", hint: "job_not_released" });
      const early = await as(db, admin, "SELECT public.release_job_early($1,'Customer collecting today, inspection booked') AS r", [unreleased.id]);
      expect(early.error).toBeUndefined();
      expect((await make(db, office, unreleased.id, acme)).error).toBeUndefined();

      // A job made from a sales order uses the order route; an internal job has no customer to deliver to.
      const so = (await db.query("INSERT INTO public.sales_orders(organization_id,so_number,customer,customer_id,status) VALUES($1,$2,'Acme C17 Ltd',$3,'open') RETURNING id", [alpha, `SO-C17-${randomUUID().slice(0, 6)}`, acme])).rows[0].id;
      const fromOrder = await job(db, alpha, "Acme C17 Ltd", { order: so });
      expect((await make(db, office, fromOrder.id, acme)).error?.message).toMatch(/came from a sales order/);
      const internal = await job(db, alpha, "Acme C17 Ltd", { internal: true });
      expect((await make(db, office, internal.id, acme)).error).toMatchObject({ code: "22023", hint: "internal_job" });

      // The key and the links are set only by the function: a browser insert or update can't set them.
      expect((await as(db, office, "INSERT INTO public.delivery_notes(organization_id,dn_number,customer,status,request_id) VALUES($1,'DLN-HAND-C17','Acme C17 Ltd','awaiting',$2)", [alpha, randomUUID()])).error).toMatchObject({ code: "42501" });
      expect((await as(db, office, "INSERT INTO public.delivery_notes(organization_id,dn_number,customer,status,job_id) VALUES($1,'DLN-HAND-C17','Acme C17 Ltd','awaiting',$2)", [alpha, jA.id])).error).toMatchObject({ code: "42501" });
      expect((await as(db, office, "UPDATE public.delivery_notes SET request_id=$2 WHERE id=$1", [r1.id, randomUUID()])).error).toMatchObject({ code: "42501" });

      // Legacy note untouched by all of it.
      expect(await legacySnapshot(db, legacy)).toEqual(legacyBefore);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});

it("a double submit from two connections makes one note; rollback keeps every note; the release applies again", async () => {
  const setup = await withDb(async db => {
    const alpha = await org(db, "race");
    const office = await actor(db, alpha, "office");
    const acme = await customer(db, alpha, "Race C17 Ltd");
    const j = await job(db, alpha, "Race C17 Ltd");
    const legacy = (await db.query("INSERT INTO public.delivery_notes(organization_id,dn_number,customer,job_ref,status) VALUES($1,$2,'Race C17 Ltd',$3,'awaiting') RETURNING id", [alpha, `DLN-LEG-${randomUUID().slice(0, 6)}`, j.no])).rows[0].id as string;
    return { alpha, office, acme, j, legacy };
  });
  const { databaseUrl } = isolatedBackend();
  const c1 = new Client({ connectionString: databaseUrl }), c2 = new Client({ connectionString: databaseUrl });
  await c1.connect(); await c2.connect();
  const request = randomUUID();
  try {
    for (const c of [c1, c2]) {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: setup.office.id, session_id: setup.office.session, role: "authenticated", aal: "aal2", email: setup.office.email }), setup.office.id]);
    }
    const one = (await c1.query(CREATE, [setup.j.id, setup.acme, request, lines(["Race part", 1])])).rows[0].r;
    // c2 waits on the job lock c1 holds, then sees c1's committed note and returns it.
    const pending = c2.query(CREATE, [setup.j.id, setup.acme, request, lines(["Race part", 1])]);
    await new Promise(resolve => setTimeout(resolve, 300));
    await c1.query("COMMIT");
    const two = (await pending).rows[0].r;
    await c2.query("COMMIT");
    expect(one.replayed).toBe(false);
    expect(two).toEqual({ id: one.id, dn_number: one.dn_number, replayed: true });
  } finally {
    await c1.end(); await c2.end();
  }
  await withDb(async db => {
    const rows = async () => (await db.query("SELECT id, to_jsonb(d) - 'request_id' AS j FROM public.delivery_notes d WHERE organization_id=$1 ORDER BY id", [setup.alpha])).rows;
    const before = await rows();
    expect(before).toHaveLength(2);
    // Rollback: the function, guard, index and key column go; every note (147's and the legacy one) stays as it was.
    await db.query(read("supabase/release/147_job_delivery_note.rollback.sql"));
    let marker = (await db.query(read("supabase/verify/release_preflight.sql"))).rows.find(r => r.check === MARKER);
    expect(marker?.value).toBe("not applied");
    expect((await db.query("SELECT to_regprocedure('public.create_job_delivery_note(uuid,uuid,uuid,date,date,text,text,jsonb)') AS f")).rows[0].f).toBeNull();
    expect(await rows()).toEqual(before);
    // Re-release: applies cleanly again, marker and verify rows back to true, notes unchanged.
    await db.query(read("supabase/release/147_job_delivery_note.release.sql"));
    marker = (await db.query(read("supabase/verify/release_preflight.sql"))).rows.find(r => r.check === MARKER);
    expect(marker?.value).toBe("applied");
    const checks = (await db.query(read("supabase/verify/job_delivery_note_147.sql"))).rows;
    expect(checks.filter(r => r.ok !== true)).toEqual([]);
    expect(await rows()).toEqual(before);
    // A second apply of the one-time release refuses and changes nothing.
    await expect(db.query(read("supabase/release/147_job_delivery_note.release.sql"))).rejects.toThrow();
    await db.query("ROLLBACK").catch(() => undefined);
    marker = (await db.query(read("supabase/verify/release_preflight.sql"))).rows.find(r => r.check === MARKER);
    expect(marker?.value).toBe("applied");
    expect(await rows()).toEqual(before);
  });
});
