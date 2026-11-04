/**
 * Migrations 140 (source_ref on five document tables) and 141 (opening_wip): two-company isolation, in PostgreSQL itself.
 * This is tests/scripts/opening-wip-141.proof.sql (the hand-run proof, 22 checks) as a database test that runs in CI with the
 * rest of `npm run test:db`. 140 and 141 are numbered migrations, so the local stack builds them in before any test runs.
 *
 * Every test builds two synthetic companies (slug t-..., the isolation guard's prefix) inside one transaction that is always rolled
 * back, so nothing is left behind. Signed-in calls are made as PostgREST makes them: role authenticated (or anon) with
 * request.jwt.claims (sub, email, session_id, aal). The writer of imported rows is the database owner, as the importer connects.
 *
 *  - 141 reads: own admin and office read their company's WIP rows; the other company's admin, a workshop person, a viewer, an
 *    outsider (signed in, no company) and anon read none of them; a support session reads read-only.
 *  - 141 writes: no signed-in person (any role, any company, support, anon) can insert, change or delete a row; each refusal
 *    leaves the rows and the audit log exactly as they were. Only the owner writes (and the link / key / source rules hold for it).
 *  - 140: source_ref on invoices, quotes, purchase orders, jobs and sales orders is visible only inside its own company; nobody
 *    signed in can set it on a new row or change it on an existing row (42501, hint source_ref_import_only) and a refused write
 *    changes nothing; the owner and the service role can still write it.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

type Actor = { key: string; id: string; email: string; session: string; org: string | null; role: string };
type Seed = {
  orgA: string;
  orgB: string;
  people: Record<string, Actor>;
  jobA: string;
  jobB: string;
  docs: Record<string, { A: string; B: string }>;
};

const DOC_TABLES = ["invoices", "quotes", "purchase_orders", "jobs", "sales_orders"] as const;
const OWNER_WIP_SUM = "215.40"; // 125.40 + 80.00 + 10.00 (the blank value stays NULL)

/** fn inside one transaction that is always rolled back. */
async function rolledBack<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}

/** Creates a login, its profile, its membership (unless an outsider) and its session. */
async function addPerson(db: Client, key: string, role: string, org: string | null, opts: { support?: "readonly" | "elevated" } = {}): Promise<Actor> {
  const id = randomUUID();
  const session = randomUUID();
  const email = `${key}-${id}@example.test`;
  const grant = opts.support ? randomUUID() : null;
  await db.query("insert into auth.users(id, email) values ($1, $2)", [id, email]);
  if (org) {
    await db.query(
      "insert into public.user_profiles(id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, $3, $4, $5, true, false)",
      [id, email, key, role, org],
    );
    await db.query(
      `insert into public.organization_members(user_id, organization_id, role, active, support, expires_at, support_grant)
       values ($1, $2, $3, true, $4, case when $4 then now() + interval '1 hour' end, $5)`,
      [id, org, role, Boolean(opts.support), grant],
    );
  }
  if (opts.support) await db.query("insert into security_audit.platform_admins(user_id) values ($1)", [id]);
  await db.query("insert into auth.sessions(id, user_id) values ($1, $2)", [session, id]);
  if (org) {
    await db.query("insert into security_audit.session_company(session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [session, id, org, grant]);
    if (opts.support === "elevated") await db.query("update security_audit.session_company set elevated_until = now() + interval '30 minutes' where session_id = $1", [session]);
  }
  return { key, id, email, session, org, role };
}

/** Two companies, their people, one job each, three WIP rows in A and one in B, and one document per table per company with a source_ref. */
async function seed(db: Client): Promise<Seed> {
  const orgA = randomUUID();
  const orgB = randomUUID();
  for (const [org, label] of [[orgA, "a"], [orgB, "b"]] as const) {
    await db.query("insert into public.organizations(id, name, slug, status) values ($1, $2, $3, 'active')", [org, `Synthetic 141 ${label}`, `t-141-${label}-${org}`]);
  }
  // A signed-in purchase order insert must name a listed supplier (another guard answers first otherwise).
  for (const org of [orgA, orgB]) await db.query("insert into public.suppliers(organization_id, name) values ($1, 'Listed Supplier')", [org]);
  const people: Record<string, Actor> = {};
  for (const [key, role, org] of [
    ["adminA", "admin", orgA], ["officeA", "office", orgA], ["workshopA", "workshop", orgA], ["viewerA", "viewer", orgA],
    ["adminB", "admin", orgB], ["officeB", "office", orgB],
  ] as const) people[key] = await addPerson(db, key, role, org);
  people.supportA = await addPerson(db, "supportA", "admin", orgA, { support: "readonly" });
  people.supportElevatedA = await addPerson(db, "supportElevatedA", "admin", orgA, { support: "elevated" });
  people.outsider = await addPerson(db, "outsider", "none", null);

  const jobA = randomUUID();
  const jobB = randomUUID();
  await db.query("insert into public.jobs(id, organization_id, job_no, customer, description, source_ref) values ($1, $2, 'J-1501', 'Customer A', 'Job A', 'SLIQ-J-A')", [jobA, orgA]);
  await db.query("insert into public.jobs(id, organization_id, job_no, customer, description, source_ref) values ($1, $2, 'J-1501', 'Customer B', 'Job B', 'SLIQ-J-B')", [jobB, orgB]);
  await db.query(
    `insert into public.opening_wip(organization_id, job_id, source_job_ref, description, quantity, value, as_of, source_key) values
       ($1, $3, 'J-1501', 'Material issued', 2.5, 125.40, '2026-10-30', 'k1'),
       ($1, $3, 'J-1501', 'Labour to date', null, null, '2026-10-30', 'k2'),
       ($1, null, 'J-1450', 'WIP on a job not in the file', null, 80.00, '2026-10-30', 'k3'),
       ($2, $4, 'J-1501', 'B material', null, 10.00, '2026-10-30', 'k1')`,
    [orgA, orgB, jobA, jobB],
  );

  const docs: Seed["docs"] = { jobs: { A: jobA, B: jobB } };
  for (const [org, side] of [[orgA, "A"], [orgB, "B"]] as const) {
    const ins = async (table: string, sql: string) => {
      const id = (await db.query<{ id: string }>(sql, [org, `SLIQ-${table}-${side}`])).rows[0].id;
      (docs[table] ??= {} as { A: string; B: string })[side] = id;
    };
    await ins("invoices", "insert into public.invoices(organization_id, customer, source_ref) values ($1, 'Customer', $2) returning id");
    await ins("quotes", "insert into public.quotes(organization_id, quote_ref, customer, source_ref) values ($1, 'Q-' || substr(md5(random()::text), 1, 8), 'Customer', $2) returning id");
    await ins("purchase_orders", "insert into public.purchase_orders(organization_id, status, source_ref) values ($1, 'draft', $2) returning id");
    await ins("sales_orders", "insert into public.sales_orders(organization_id, so_number, source_ref) values ($1, 'SO-' || substr(md5(random()::text), 1, 8), $2) returning id");
  }
  return { orgA, orgB, people, jobA, jobB, docs };
}

type Outcome = { code: string | null; hint: string | null; rowCount: number | null; rows: Record<string, unknown>[] };

/** Runs one statement as `who` (a seeded person, or "anon") inside a savepoint, and always puts the owner role back. */
async function as(db: Client, who: Actor | "anon", sql: string, params: unknown[] = []): Promise<Outcome> {
  await db.query("savepoint attempt");
  try {
    if (who === "anon") {
      await db.query("select set_config('request.jwt.claims', '', true)");
      await db.query("set local role anon");
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
        JSON.stringify({ sub: who.id, email: who.email, role: "authenticated", aud: "authenticated", aal: "aal2", session_id: who.session }),
        who.id,
      ]);
    }
    try {
      const res = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint attempt");
      return { code: null, hint: null, rowCount: res.rowCount, rows: res.rows };
    } catch (error) {
      const e = error as { code?: string; hint?: string };
      await db.query("rollback to savepoint attempt");
      await db.query("reset role");
      return { code: e.code ?? "unknown", hint: e.hint ?? null, rowCount: null, rows: [] };
    }
  } finally {
    await db.query("select set_config('request.jwt.claims', '', true)");
  }
}

const wipState = async (db: Client) =>
  (await db.query<{ n: string; total: string; blanks: string }>(
    "select count(*)::text as n, coalesce(sum(value), 0)::text as total, count(*) filter (where value is null)::text as blanks from public.opening_wip")).rows[0];
const wipAudit = async (db: Client) =>
  (await db.query<{ n: string }>("select count(*)::text as n from security_audit.audit_log where entity_table = 'opening_wip'")).rows[0].n;
const sourceRefs = async (db: Client, table: string) =>
  (await db.query<{ id: string; source_ref: string | null }>(`select id, source_ref from public.${table} order by id`)).rows;

beforeAll(async () => {
  await verifyBackendIdentity();
});

describe("141 opening_wip: reads stay inside the company and inside admin and office", () => {
  it("own admin and office read their company's rows; the other company, workshop, viewer, outsider and anon read none of them", async () => {
    await rolledBack(async (db) => {
      const s = await seed(db);
      const count = (who: Actor | "anon", where = "") => as(db, who, `select count(*)::int as n from public.opening_wip ${where}`);
      expect((await count(s.people.adminA)).rows[0]).toEqual({ n: 3 });
      expect((await count(s.people.officeA)).rows[0]).toEqual({ n: 3 });
      expect((await count(s.people.adminA, `where organization_id = '${s.orgB}'`)).rows[0]).toEqual({ n: 0 });
      expect((await as(db, s.people.officeA, "select sum(value)::text as total, count(*) filter (where value is null)::int as blanks from public.opening_wip")).rows[0])
        .toEqual({ total: "205.40", blanks: 1 });
      // The other company's admin and office see only their own single row, never A's.
      const adminB = await as(db, s.people.adminB, "select organization_id, description from public.opening_wip");
      expect(adminB.rows).toEqual([{ organization_id: s.orgB, description: "B material" }]);
      expect((await count(s.people.officeB)).rows[0]).toEqual({ n: 1 });
      expect((await count(s.people.adminB, `where organization_id = '${s.orgA}'`)).rows[0]).toEqual({ n: 0 });
      // Job prices rule (009): a workshop person and a viewer read nothing, and neither does a login with no company.
      expect((await count(s.people.workshopA)).rows[0]).toEqual({ n: 0 });
      expect((await count(s.people.viewerA)).rows[0]).toEqual({ n: 0 });
      expect((await count(s.people.outsider)).rows[0]).toEqual({ n: 0 });
      // anon has no grant at all.
      expect((await count("anon")).code).toBe("42501");
    });
  });

  it("a support session reads its company's rows (read-only) and nothing of another company", async () => {
    await rolledBack(async (db) => {
      const s = await seed(db);
      for (const key of ["supportA", "supportElevatedA"]) {
        const all = await as(db, s.people[key], "select organization_id from public.opening_wip");
        expect(all.code, key).toBeNull();
        expect(all.rows.map((r) => r.organization_id), key).toEqual([s.orgA, s.orgA, s.orgA]);
        const other = await as(db, s.people[key], "select 1 from public.opening_wip where organization_id = $1", [s.orgB]);
        expect(other.rows, key).toEqual([]);
      }
    });
  });
});

describe("141 opening_wip: only the importer writes", () => {
  it("nobody signed in can insert, change or delete a row, and every refusal leaves the rows and the audit log as they were", async () => {
    await rolledBack(async (db) => {
      const s = await seed(db);
      const before = { wip: await wipState(db), audit: await wipAudit(db) };
      expect(before.wip).toEqual({ n: "4", total: OWNER_WIP_SUM, blanks: "1" });
      const insert = "insert into public.opening_wip(organization_id, source_key, value) values ($1, 'refused', 1) returning id";
      const update = "update public.opening_wip set value = 1, description = 'changed' where organization_id = $1";
      const remove = "delete from public.opening_wip where organization_id = $1";
      const attempts: Array<[Actor | "anon", string]> = [
        [s.people.adminA, s.orgA], [s.people.officeA, s.orgA], [s.people.workshopA, s.orgA], [s.people.viewerA, s.orgA],
        [s.people.supportA, s.orgA], [s.people.supportElevatedA, s.orgA], [s.people.outsider, s.orgA],
        [s.people.adminB, s.orgA], [s.people.adminB, s.orgB], [s.people.officeB, s.orgB],
        ["anon", s.orgA],
      ];
      for (const [who, org] of attempts) {
        const name = `${who === "anon" ? "anon" : who.key} -> ${org === s.orgA ? "A" : "B"}`;
        expect((await as(db, who, insert, [org])).code, `insert ${name}`).toBe("42501");
        expect((await as(db, who, update, [org])).code, `update ${name}`).toBe("42501");
        expect((await as(db, who, remove, [org])).code, `delete ${name}`).toBe("42501");
      }
      expect(await wipState(db)).toEqual(before.wip);
      expect(await wipAudit(db)).toBe(before.audit);
      expect((await db.query("select count(*)::int as n from public.opening_wip where description = 'changed' or source_key = 'refused'")).rows[0]).toEqual({ n: 0 });
    });
  });

  it("the importer (owner) writes; a link to another company's job, a repeated key in one company and a source other than sliq are refused", async () => {
    await rolledBack(async (db) => {
      const s = await seed(db);
      const owner = async (sql: string, params: unknown[]) => {
        await db.query("savepoint owner_try");
        try {
          await db.query(sql, params);
          await db.query("release savepoint owner_try");
          return "ok";
        } catch (error) {
          await db.query("rollback to savepoint owner_try");
          return (error as { code?: string }).code ?? "unknown";
        }
      };
      expect(await owner("insert into public.opening_wip(organization_id, job_id, source_key, value) values ($1, $2, 'new1', 5)", [s.orgA, s.jobA])).toBe("ok");
      expect(await owner("insert into public.opening_wip(organization_id, job_id, source_key) values ($1, $2, 'x4')", [s.orgA, s.jobB])).toBe("23514");
      expect(await owner("insert into public.opening_wip(organization_id, source_key) values ($1, 'k1')", [s.orgA])).toBe("23505");
      expect(await owner("insert into public.opening_wip(organization_id, source_key) values ($1, 'k9')", [randomUUID()])).toBe("23503"); // unknown company
      expect(await owner("insert into public.opening_wip(organization_id, source_key, source) values ($1, 'x5', 'other')", [s.orgA])).toBe("23514");
      // The same key in the other company is a different row, not a repeat.
      expect(await owner("insert into public.opening_wip(organization_id, source_key) values ($1, 'k3')", [s.orgB])).toBe("ok");
      // Every owner insert is in the row audit log.
      expect((await db.query<{ n: string }>("select count(*)::text as n from security_audit.audit_log where entity_table = 'opening_wip' and action = 'INSERT' and organization_id in ($1, $2)", [s.orgA, s.orgB])).rows[0].n)
        .toBe("6"); // 4 seeded + new1 + k3 in B
    });
  });

  it("deleting a job keeps its WIP rows, unlinked, with the SliQ job number, and invoices are untouched", async () => {
    await rolledBack(async (db) => {
      const s = await seed(db);
      const invoices = async () => (await db.query<{ v: string }>("select coalesce(sum(total), 0)::text || '/' || count(*) as v from public.invoices")).rows[0].v;
      const before = await invoices();
      await db.query("delete from public.jobs where id = $1", [s.jobA]);
      const kept = await db.query<{ n: string }>("select count(*) filter (where job_id is null and source_job_ref = 'J-1501')::text as n from public.opening_wip where organization_id = $1", [s.orgA]);
      expect(kept.rows[0].n).toBe("2");
      expect(await invoices()).toBe(before);
    });
  });
});

describe("140 source_ref: visible only inside its company, set only by the importer", () => {
  it("each company reads only its own source_ref values on all five tables; the other company, outsider and anon read none", async () => {
    await rolledBack(async (db) => {
      const s = await seed(db);
      for (const table of DOC_TABLES) {
        const a = s.docs[table].A;
        const b = s.docs[table].B;
        const seenA = await as(db, s.people.adminA, `select id, source_ref from public.${table} where source_ref is not null`);
        expect(seenA.code, table).toBeNull();
        expect(seenA.rows.map((r) => r.id), table).toContain(a);
        expect(seenA.rows.map((r) => r.id), table).not.toContain(b);
        expect(seenA.rows.map((r) => r.source_ref), table).not.toContain(`SLIQ-${table}-B`);
        const seenB = await as(db, s.people.adminB, `select id, source_ref from public.${table} where source_ref is not null`);
        expect(seenB.rows.map((r) => r.id), table).toContain(b);
        expect(seenB.rows.map((r) => r.id), table).not.toContain(a);
        const asked = await as(db, s.people.adminA, `select source_ref from public.${table} where id = $1`, [b]);
        expect(asked.rows, `${table}: A asks for B's row by id`).toEqual([]);
        expect((await as(db, s.people.outsider, `select source_ref from public.${table} where id = any($1)`, [[a, b]])).rows, table).toEqual([]);
        expect((await as(db, "anon", `select source_ref from public.${table}`)).code, table).toBe("42501");
      }
    });
  });

  it("nobody signed in can set source_ref on a new row or change it on an existing one, and a refused write changes nothing", async () => {
    await rolledBack(async (db) => {
      const s = await seed(db);
      const before = Object.fromEntries(await Promise.all(DOC_TABLES.map(async (t) => [t, await sourceRefs(db, t)])));
      const newRow: Record<(typeof DOC_TABLES)[number], string> = {
        invoices: "insert into public.invoices(organization_id, customer, source_ref) values ($1, 'Customer', 'FORGED')",
        quotes: "insert into public.quotes(organization_id, quote_ref, customer, source_ref) values ($1, 'Q-forged', 'Customer', 'FORGED')",
        purchase_orders: "insert into public.purchase_orders(organization_id, status, supplier, source_ref) values ($1, 'draft', 'Listed Supplier', 'FORGED')",
        jobs: "insert into public.jobs(organization_id, job_no, source_ref) values ($1, 'J-forged', 'FORGED')",
        sales_orders: "insert into public.sales_orders(organization_id, so_number, source_ref) values ($1, 'SO-forged', 'FORGED')",
      };
      for (const table of DOC_TABLES) {
        const own = s.docs[table].A;
        const other = s.docs[table].B;
        for (const who of [s.people.adminA, s.people.officeA]) {
          const ins = await as(db, who, newRow[table], [s.orgA]);
          expect(ins.code, `${who.key} inserts ${table} with a source_ref`).toBe("42501");
          const set = await as(db, who, `update public.${table} set source_ref = 'FORGED' where id = $1`, [own]);
          expect(set.code, `${who.key} changes ${table}.source_ref`).toBe("42501");
          expect(set.hint, `${who.key} ${table} hint`).toBe("source_ref_import_only");
          expect((await as(db, who, `update public.${table} set source_ref = null where id = $1`, [own])).code, `${who.key} clears ${table}.source_ref`).toBe("42501");
        }
        // The other company's admin reaches no row of A (policy filters it out) and is refused when it names source_ref on its own.
        const cross = await as(db, s.people.adminB, `update public.${table} set source_ref = 'FORGED' where id = $1`, [own]);
        expect(cross.code === "42501" || cross.rowCount === 0, `adminB -> A's ${table}`).toBe(true);
        expect((await as(db, s.people.adminB, `update public.${table} set source_ref = 'FORGED' where id = $1`, [other])).code, `adminB own ${table}`).toBe("42501");
        expect((await as(db, "anon", `update public.${table} set source_ref = 'FORGED'`)).code, `anon ${table}`).toBe("42501");
        expect((await as(db, "anon", newRow[table], [s.orgA])).code, `anon inserts ${table}`).toBe("42501");
      }
      for (const table of DOC_TABLES) expect(await sourceRefs(db, table), `${table} unchanged`).toEqual(before[table]);
      for (const table of DOC_TABLES) expect((await db.query(`select 1 from public.${table} where source_ref = 'FORGED'`)).rowCount, table).toBe(0);
    });
  });

  it("the importer (owner) and the service role can still write source_ref; the shape check refuses blanks and padding", async () => {
    await rolledBack(async (db) => {
      const s = await seed(db);
      const state = async (table: string, id: string) => (await db.query<{ source_ref: string | null }>(`select source_ref from public.${table} where id = $1`, [id])).rows[0].source_ref;
      for (const table of DOC_TABLES) {
        await db.query(`update public.${table} set source_ref = 'OWNER-SET' where id = $1`, [s.docs[table].A]);
        expect(await state(table, s.docs[table].A), table).toBe("OWNER-SET");
        await db.query("set local role service_role");
        await db.query(`update public.${table} set source_ref = 'SERVICE-SET' where id = $1`, [s.docs[table].A]);
        await db.query("reset role");
        expect(await state(table, s.docs[table].A), table).toBe("SERVICE-SET");
        for (const bad of ["", " padded ", "x".repeat(101)]) {
          await db.query("savepoint shape");
          await expect(db.query(`update public.${table} set source_ref = $2 where id = $1`, [s.docs[table].A, bad]), `${table} ${JSON.stringify(bad.slice(0, 12))}`).rejects.toMatchObject({ code: "23514" });
          await db.query("rollback to savepoint shape");
        }
        expect(await state(table, s.docs[table].A), table).toBe("SERVICE-SET");
      }
    });
  });
});
