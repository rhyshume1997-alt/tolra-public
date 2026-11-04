/**
 * Cutover day: set the delivery-note counter from John's last pad number (supabase/cutover/set_dln_next_number.sql), so the next note is
 * DLN-(last + 1). A one-time operations script, NOT a migration. It refuses (nothing changed) on a bad number, an unknown company, a counter
 * that would go back or stay level, an existing DLN at or above the target, or a second run. The verify file reads it back; the undo file
 * works only before any number is taken. After the step both routes (from a sales order, and release 147's no-order route) number on from
 * it, two sessions never get the same number, and another company's counter is untouched.
 * Runs as the database owner (as on the day, in the SQL editor), through the database connection; the verified fixture installs 145-147.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { isolatedBackend } from "../support/isolation";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
type Vars = Record<string, string>;
/** psql's :'name' as a quoted literal (what psql -v name=... does), and its backslash meta-commands dropped (ON_ERROR_STOP is psql's). */
function withPsqlVars(sql: string, vars: Vars): string {
  return sql.split("\n").filter((line) => !line.startsWith("\\")).join("\n")
    .replace(/:'([a-z_]+)'/g, (_, name: string) => {
      if (!(name in vars)) throw new Error(`psql variable ${name} not given`);
      return `'${vars[name].replaceAll("'", "''")}'`;
    });
}
const SET = "supabase/cutover/set_dln_next_number.sql";
const VERIFY = "supabase/cutover/verify_dln_next_number.sql";
const UNDO = "supabase/cutover/undo_dln_next_number.sql";

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
});

type Actor = { id: string; session: string; email: string };
async function company(db: Client, label: string) {
  const id = randomUUID(), slug = `t-dln-${label}-${id.slice(0, 8)}`;
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `Synthetic ${label}`, slug]);
  const user = randomUUID(), session = randomUUID(), email = `${user}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [user, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic','office',$3,true,false)", [user, email, id]);
  await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,'office',true)", [user, id]);
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, user]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, user, id]);
  return { id, slug, office: { id: user, session, email } as Actor };
}
async function asOffice<T>(db: Client, who: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: who.id, session_id: who.session, role: "authenticated", aal: "aal2", email: who.email }), who.id]);
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("COMMIT");
    return rows;
  } catch (e) { await db.query("ROLLBACK"); throw e; }
}
const nextNumber = async (db: Client, who: Actor) => (await asOffice<{ n: string }>(db, who, "SELECT public.next_doc_number('DLN') AS n"))[0].n;
const counter = async (db: Client, org: string) => (await db.query("SELECT last FROM public.doc_counters WHERE organization_id=$1 AND prefix='DLN'", [org])).rows[0]?.last ?? null;
const markers = async (db: Client, org: string) => Number((await db.query("SELECT count(*) AS n FROM security_audit.audit_log WHERE organization_id=$1 AND entity_table='doc_counters' AND action IN ('DLN_COUNTER_SET','DLN_COUNTER_UNDONE')", [org])).rows[0].n);
const runSet = (db: Client, slug: string, last: string) => db.query(withPsqlVars(read(SET), { company_slug: slug, last_pad_number: last }));
const verify = async (db: Client, slug: string, last: string) => {
  const res = await db.query(withPsqlVars(read(VERIFY), { company_slug: slug, last_pad_number: last }));
  const rows = (Array.isArray(res) ? res.at(-1)! : res).rows as Array<{ check: string; value: string; result: string }>;
  return rows;
};
/** A refusal must leave everything as it was: the counter, the markers, the notes. */
async function refused(db: Client, org: string, slug: string, last: string, message: RegExp) {
  const before = [await counter(db, org), await markers(db, org)];
  await expect(runSet(db, slug, last)).rejects.toThrow(message);
  await db.query("ROLLBACK").catch(() => undefined);
  expect([await counter(db, org), await markers(db, org)]).toEqual(before);
}

describe("day-of DLN counter step", () => {
  it("fresh company starts at DLN-0001; set to 4521, the next note is DLN-4522; verify passes; a second run is refused", async () => {
    await withDb(async db => {
      const fresh = await company(db, "fresh");
      expect(await nextNumber(db, fresh.office)).toBe("DLN-0001");
      const c = await company(db, "set");
      const other = await company(db, "other");
      expect(await nextNumber(db, other.office)).toBe("DLN-0001");
      await runSet(db, c.slug, "4521");
      expect(await counter(db, c.id)).toBe(4521);
      const rows = await verify(db, c.slug, "4521");
      expect(rows.filter(r => r.result === "FAIL")).toEqual([]);
      expect(rows.find(r => r.check === "next DLN number")?.value).toBe("DLN-4522");
      await refused(db, c.id, c.slug, "4521", /already been run/);
      await refused(db, c.id, c.slug, "4600", /already been run/);
      expect(await nextNumber(db, c.office)).toBe("DLN-4522");
      // Another company's counter is untouched.
      expect(await counter(db, other.id)).toBe(1);
      expect(await nextNumber(db, other.office)).toBe("DLN-0002");
      // The verify file says FAIL for a different number read back.
      expect((await verify(db, c.slug, "4520")).some(r => r.result === "FAIL")).toBe(true);
    });
  });

  it("refuses bad input, an unknown company, a lower or equal number and an existing higher DLN, changing nothing", async () => {
    await withDb(async db => {
      const c = await company(db, "refuse");
      for (const bad of ["0", "-5", "4521.5", "45 21", "abc", "", "1e3", "04521", "1000000000"]) await refused(db, c.id, c.slug, bad, /not a positive whole number/);
      await expect(runSet(db, "t-dln-no-such-company", "4521")).rejects.toThrow(/no company/);
      await db.query("ROLLBACK");
      // The counter is at 3 (three numbers taken): 2 is backwards, 3 is level.
      for (let i = 0; i < 3; i++) await nextNumber(db, c.office);
      await refused(db, c.id, c.slug, "2", /backwards or stay the same/);
      await refused(db, c.id, c.slug, "3", /backwards or stay the same/);
      // A note already numbered at or above the target (an imported DLN-5000): 4999 would make the next DLN-5000, refused.
      await db.query("INSERT INTO public.delivery_notes(organization_id,dn_number,customer,status) VALUES($1,'DLN-5000','Synthetic','awaiting')", [c.id]);
      await refused(db, c.id, c.slug, "4999", /already has DLN-5000/);
      await refused(db, c.id, c.slug, "4521", /already has DLN-5000/);
      // Above it is fine, and five digits are not padded: DLN-10000.
      await runSet(db, c.slug, "9999");
      expect(await nextNumber(db, c.office)).toBe("DLN-10000");
    });
  });

  it("after the step both routes number on from it, and two sessions at once never get the same number", async () => {
    const setup = await withDb(async db => {
      const c = await company(db, "routes");
      await runSet(db, c.slug, "4521");
      const customer = (await db.query("INSERT INTO public.customers(organization_id,name) VALUES($1,'Route Ltd') RETURNING id", [c.id])).rows[0].id;
      const order = (await db.query("INSERT INTO public.sales_orders(organization_id,so_number,customer,customer_id,status,total_value) VALUES($1,'SO-DLN-1','Route Ltd',$2,'open',50) RETURNING id", [c.id, customer])).rows[0].id;
      const line = (await db.query("INSERT INTO public.sales_order_lines(organization_id,sales_order_id,position,description,quantity,unit_price) VALUES($1,$2,0,'Flange',10,5) RETURNING id", [c.id, order])).rows[0].id;
      const job = (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,stage,started_at,finished_at,inspected_at) VALUES($1,'J-DLN-1','Route Ltd','complete',now(),now(),now()) RETURNING id", [c.id])).rows[0].id;
      return { ...c, customer, order, line, job };
    });
    await withDb(async db => {
      const fromOrder = await asOffice<{ r: { dn_number: string } }>(db, setup.office, "SELECT public.create_delivery_note($1,NULL,DATE '2026-11-12',DATE '2026-11-12',NULL,NULL,$2) AS r", [setup.order, JSON.stringify([{ line_id: setup.line, quantity: 4 }])]);
      expect(fromOrder[0].r.dn_number).toBe("DLN-4522");
      const noOrder = await asOffice<{ r: { dn_number: string } }>(db, setup.office, "SELECT public.create_job_delivery_note($1,$2,$3,DATE '2026-11-12',DATE '2026-11-12',NULL,NULL,$4) AS r", [setup.job, setup.customer, randomUUID(), JSON.stringify([{ description: "Bracket", quantity: 1 }])]);
      expect(noOrder[0].r.dn_number).toBe("DLN-4523");
    });
    // Two sessions allocate at the same moment: the counter row lock serialises them, so the numbers differ and none is skipped.
    const { databaseUrl } = isolatedBackend();
    const sessions = await Promise.all([0, 1, 2, 3].map(async () => { const c = new Client({ connectionString: databaseUrl }); await c.connect(); return c; }));
    try {
      const got = await Promise.all(sessions.map(c => nextNumber(c, setup.office)));
      expect(new Set(got).size).toBe(4);
      expect(got.toSorted()).toEqual(["DLN-4524", "DLN-4525", "DLN-4526", "DLN-4527"]);
    } finally { await Promise.all(sessions.map(c => c.end())); }
  });

  it("two operators running the step at once: one sets it, the other is refused", async () => {
    const c = await withDb(db => company(db, "double"));
    const { databaseUrl } = isolatedBackend();
    const a = new Client({ connectionString: databaseUrl }), b = new Client({ connectionString: databaseUrl });
    await a.connect(); await b.connect();
    try {
      const results = await Promise.allSettled([runSet(a, c.slug, "4521"), runSet(b, c.slug, "4521")]);
      expect(results.map(r => r.status).toSorted()).toEqual(["fulfilled", "rejected"]);
      expect(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/already been run/);
    } finally { await a.query("ROLLBACK").catch(() => undefined); await b.query("ROLLBACK").catch(() => undefined); await a.end(); await b.end(); }
    await withDb(async db => {
      expect(await counter(db, c.id)).toBe(4521);
      expect(await markers(db, c.id)).toBe(1);
    });
  });

  it("undo works only before any number is taken; after a number is taken it is refused", async () => {
    await withDb(async db => {
      const c = await company(db, "undo");
      await runSet(db, c.slug, "4521");
      await db.query(withPsqlVars(read(UNDO), { company_slug: c.slug }));
      expect(await counter(db, c.id)).toBe(0);
      // Undone, so the step may be run again (with a corrected number).
      await runSet(db, c.slug, "4530");
      expect(await nextNumber(db, c.office)).toBe("DLN-4531");
      await expect(db.query(withPsqlVars(read(UNDO), { company_slug: c.slug }))).rejects.toThrow(/a number has already been taken/);
      await db.query("ROLLBACK").catch(() => undefined);
      expect(await counter(db, c.id)).toBe(4531);
    });
  });
});
