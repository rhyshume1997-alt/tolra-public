/**
 * Delivery note roles across the DLN cutover step (PM ruling, 12 Nov 2026: admin and office must be able to create delivery notes;
 * workshop unchanged; viewer not broadened). Release 147 holds every company that existed at its install (dln_numbering_pending) until
 * supabase/cutover/set_dln_next_number.sql runs: until then every create path refuses with 55000 dln_numbering_not_set. After the step,
 * admin and office each make a note on each path (create_job_delivery_note, create_delivery_note, create_with_lines('delivery_notes'),
 * a direct insert with no number) and each gets the next DLN number; workshop keeps exactly today's database outcome on the same paths;
 * a viewer is refused on every path (42501) and burns no number; a typed number is still refused (42501 dn_number_from_counter);
 * another company can neither see this company's notes nor create one in it, and its refusals burn no number here.
 * Inputs: the local disposable database only (isolation guard), through the database connection, as the 147 and DLN counter tests do.
 * Outputs: assertions only; it creates synthetic companies (slug prefix t-). Must not be weakened or changed to fit a schema change.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
/** psql's :'name' as a quoted literal and its backslash meta-commands dropped (as dln-day-of-counter.test.ts does). */
function withPsqlVars(sql: string, vars: Record<string, string>): string {
  return sql.split("\n").filter((line) => !line.startsWith("\\")).join("\n")
    .replace(/:'([a-z0-9_]+)'/g, (_, name: string) => {
      if (!(name in vars)) throw new Error(`psql variable ${name} not given`);
      return `'${vars[name].replaceAll("'", "''")}'`;
    });
}
const runSet = (db: Client, slug: string, last: string) =>
  db.query(withPsqlVars(read("supabase/cutover/set_dln_next_number.sql"), { company_slug: slug, last_pad_number: last, confirm_start_at_dln_0001: "" }));

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
});

type Role = "admin" | "office" | "workshop" | "viewer";
type Actor = { id: string; session: string; email: string };
type Company = { id: string; slug: string; actors: Record<Role, Actor>; customer: string; order: string; line: string; job: string };
type Outcome = { number?: string; code?: string; hint?: string };

async function company(db: Client, label: string, held: boolean): Promise<Company> {
  const id = randomUUID(), slug = `t-dnrole-${label}-${id.slice(0, 8)}`;
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `Synthetic ${label}`, slug]);
  // As at the 147 install: the company is held until its counter step.
  if (held) await db.query("INSERT INTO public.dln_numbering_pending(organization_id) VALUES($1)", [id]);
  const actors = {} as Record<Role, Actor>;
  for (const role of ["admin", "office", "workshop", "viewer"] as const) {
    const user = randomUUID(), session = randomUUID(), email = `${user}@example.test`;
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [user, email]);
    await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)", [user, email, role, id]);
    await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,true)", [user, id, role]);
    await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, user]);
    await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, user, id]);
    actors[role] = { id: user, session, email };
  }
  const customer = (await db.query("INSERT INTO public.customers(organization_id,name) VALUES($1,$2) RETURNING id", [id, `${label} Ltd`])).rows[0].id as string;
  const order = (await db.query("INSERT INTO public.sales_orders(organization_id,so_number,customer,customer_id,status,total_value) VALUES($1,$2,$3,$4,'open',500) RETURNING id", [id, `SO-DNR-${id.slice(0, 8)}`, `${label} Ltd`, customer])).rows[0].id as string;
  const line = (await db.query("INSERT INTO public.sales_order_lines(organization_id,sales_order_id,position,description,quantity,unit_price) VALUES($1,$2,0,'Flange',100,5) RETURNING id", [id, order])).rows[0].id as string;
  const job = (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,stage,started_at,finished_at,inspected_at) VALUES($1,$2,$3,'complete',now(),now(),now()) RETURNING id", [id, `J-DNR-${id.slice(0, 8)}`, `${label} Ltd`])).rows[0].id as string;
  return { id, slug, actors, customer, order, line, job };
}

/** One browser call as `who` (authenticated, second step done), committed on success, rolled back on refusal. */
async function as(db: Client, who: Actor, sql: string, params: unknown[]): Promise<Outcome> {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: who.id, session_id: who.session, role: "authenticated", aal: "aal2", email: who.email }), who.id]);
    let row = (await db.query(sql, params)).rows[0] as { n?: string; id?: string };
    if (row?.id) row = (await db.query("SELECT dn_number AS n FROM public.delivery_notes WHERE id=$1", [row.id])).rows[0];
    await db.query("COMMIT");
    return { number: row?.n };
  } catch (e) {
    await db.query("ROLLBACK");
    const err = e as { code?: string; hint?: string };
    return { code: err.code, hint: err.hint };
  }
}

/** The four create paths, each targeting company `c` (its job, order, line, customer). */
const paths = {
  create_job_delivery_note: (db: Client, who: Actor, c: Company) => as(db, who, "SELECT (public.create_job_delivery_note($1,$2,$3,DATE '2026-11-12',DATE '2026-11-12',NULL,NULL,$4))->>'dn_number' AS n", [c.job, c.customer, randomUUID(), JSON.stringify([{ description: "Bracket", quantity: 1 }])]),
  create_delivery_note: (db: Client, who: Actor, c: Company) => as(db, who, "SELECT (public.create_delivery_note($1,NULL,DATE '2026-11-12',DATE '2026-11-12',NULL,NULL,$2))->>'dn_number' AS n", [c.order, JSON.stringify([{ line_id: c.line, quantity: 1 }])]),
  create_with_lines: (db: Client, who: Actor, c: Company) => as(db, who, "SELECT public.create_with_lines('delivery_notes',$1::jsonb,'delivery_note_items','delivery_note_id','[]'::jsonb) AS id", [JSON.stringify({ organization_id: c.id, customer: "Synthetic", status: "awaiting" })]),
  direct_insert: (db: Client, who: Actor, c: Company) => as(db, who, "INSERT INTO public.delivery_notes(organization_id,customer,status) VALUES($1,'Synthetic','awaiting') RETURNING dn_number AS n", [c.id]),
};
const typedNumber = (db: Client, who: Actor, c: Company) => as(db, who, "INSERT INTO public.delivery_notes(organization_id,dn_number,customer,status) VALUES($1,$2,'Synthetic','awaiting') RETURNING dn_number AS n", [c.id, `DN-${c.id.slice(0, 8)}`]);
const counter = async (db: Client, org: string) => (await db.query("SELECT last FROM public.doc_counters WHERE organization_id=$1 AND prefix='DLN'", [org])).rows[0]?.last ?? null;
const notes = async (db: Client, org: string) => Number((await db.query("SELECT count(*) AS n FROM public.delivery_notes WHERE organization_id=$1", [org])).rows[0].n);

describe("delivery note roles across the DLN cutover step", () => {
  it("before the step every role is refused on every path: 55000 for admin, office and workshop; the viewer as today", async () => {
    await withDb(async db => {
      const c = await company(db, "held", true);
      for (const role of ["admin", "office", "workshop"] as const) {
        for (const [name, make] of Object.entries(paths)) {
          expect({ role, name, ...(await make(db, c.actors[role], c)) }).toEqual({ role, name, code: "55000", hint: "dln_numbering_not_set" });
        }
        expect(await typedNumber(db, c.actors[role], c)).toEqual({ code: "55000", hint: "dln_numbering_not_set" });
      }
      // The viewer: the two functions refuse on role first (42501); the insert paths meet the hold (55000). Never a note.
      const viewer: Record<string, string | undefined> = {};
      for (const [name, make] of Object.entries(paths)) viewer[name] = (await make(db, c.actors.viewer, c)).code;
      expect(viewer).toEqual({ create_job_delivery_note: "42501", create_delivery_note: "42501", create_with_lines: "55000", direct_insert: "55000" });
      expect(await notes(db, c.id)).toBe(0);
      expect(await counter(db, c.id)).toBeNull();
    });
  });

  it("after the step admin and office each make a note on every path with the next DLN number; workshop as today; viewer and typed numbers refused", async () => {
    await withDb(async db => {
      const c = await company(db, "cut", true);
      await runSet(db, c.slug, "4521");
      expect((await db.query("SELECT 1 FROM public.dln_numbering_pending WHERE organization_id=$1", [c.id])).rowCount).toBe(0);
      let next = 4522;
      for (const role of ["admin", "office"] as const) {
        for (const [name, make] of Object.entries(paths)) {
          expect({ role, name, ...(await make(db, c.actors[role], c)) }).toEqual({ role, name, number: `DLN-${next++}` });
        }
        // A typed number is still refused, and burns none.
        expect(await typedNumber(db, c.actors[role], c)).toEqual({ code: "42501", hint: "dn_number_from_counter" });
      }
      // Workshop: exactly today's database outcome (the same paths succeed), not widened or narrowed here.
      for (const [name, make] of Object.entries(paths)) {
        expect({ name, ...(await make(db, c.actors.workshop, c)) }).toEqual({ name, number: `DLN-${next++}` });
      }
      expect(await typedNumber(db, c.actors.workshop, c)).toEqual({ code: "42501", hint: "dn_number_from_counter" });
      // Viewer: refused on every path and with a typed number; no note, no number taken.
      for (const make of [...Object.values(paths), typedNumber]) expect((await make(db, c.actors.viewer, c)).code).toBe("42501");
      expect(await counter(db, c.id)).toBe(next - 1);
      expect(await notes(db, c.id)).toBe(12);
    });
  });

  it("another company can neither see this company's notes nor make one in it, and its refusals take no number here", async () => {
    await withDb(async db => {
      const c = await company(db, "home", true);
      const other = await company(db, "other", false);
      await runSet(db, c.slug, "4521");
      expect((await paths.direct_insert(db, c.actors.office, c)).number).toBe("DLN-4522");
      const before = [await counter(db, c.id), await notes(db, c.id)];
      for (const role of ["admin", "office", "workshop", "viewer"] as const) {
        const who = other.actors[role];
        expect((await as(db, who, "SELECT count(*)::text AS n FROM public.delivery_notes WHERE organization_id=$1", [c.id])).number).toBe("0");
        for (const [name, make] of Object.entries(paths)) {
          const got = await make(db, who, c);
          if (name === "create_with_lines" && role !== "viewer") {
            // create_with_lines drops a client organization_id and files the note in the caller's own company: never in this one.
            const where = (await db.query("SELECT organization_id FROM public.delivery_notes WHERE dn_number=$1 AND organization_id IN ($2,$3)", [got.number, c.id, other.id])).rows;
            expect({ role, where }).toEqual({ role, where: [{ organization_id: other.id }] });
            continue;
          }
          expect({ role, name, refused: Boolean(got.code) }).toEqual({ role, name, refused: true });
        }
        expect((await typedNumber(db, who, c)).code).toBe("42501");
      }
      expect([await counter(db, c.id), await notes(db, c.id)]).toEqual(before);
      expect((await db.query("SELECT count(*)::int AS n FROM public.delivery_notes WHERE organization_id=$1 AND dn_number NOT LIKE 'DLN-%'", [c.id])).rows[0].n).toBe(0);
    });
  });
});
