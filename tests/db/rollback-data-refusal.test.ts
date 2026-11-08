/**
 * Rollbacks that would delete a feature's own data. 141 (opening WIP rows), 143 (costing rates), 145 (setup ticks), 147 (the delivery note
 * numbering hold) and 148 (job cost records, declarations, machine links, the switch) used to drop their tables without a word. Like 146,
 * 149 and 151 they now REFUSE while the feature holds rows, unless the runner first says in the same session that deleting them is
 * accepted (SET tolra.xNNN_accept_... = 'yes'). Pure SQL through the database connection (no Supabase Auth API). Each case is one
 * transaction that is always rolled back, so nothing is left behind. For each release this proves:
 *   1. populated: the rollback is REFUSED, with its own message, and nothing changed (table, rows, marker);
 *   2. empty: the rollback still works (marker reads "not applied"), and the release then applies again (verify rows true);
 *   3. populated + the accepted switch: the rollback runs (the documented, deliberate way through).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

type Case = {
  n: number;
  file: string;
  marker: string;
  verify: string;
  tables: string[];
  switch: string;
  refusal: RegExp;
  seed: (db: Client, org: string) => Promise<void>;
};
const cases: Case[] = [
  {
    n: 141, file: "141_opening_wip", marker: "141 opening wip", verify: "supabase/verify/opening_wip_141.sql", tables: ["opening_wip"],
    switch: "tolra.x141_accept_deleting_wip", refusal: /141 rollback refused: opening WIP rows exist/,
    seed: async (db, org) => void (await db.query("INSERT INTO public.opening_wip(organization_id, source_key, description, value) VALUES ($1, $2, 'WIP line', 12.50)", [org, `k-${randomUUID()}`])),
  },
  {
    n: 143, file: "143_costing_rates", marker: "143 costing rates", verify: "supabase/verify/costing_rates_143.sql", tables: ["costing_materials", "costing_machines", "costing_defaults"],
    switch: "tolra.x143_accept_deleting_rates", refusal: /143 rollback refused: costing rates exist/,
    seed: async (db, org) => void (await db.query("INSERT INTO public.costing_materials(organization_id, name, price_pence, price_unit, scrap_pct) VALUES ($1, $2, 450, 'kg', 5)", [org, `Alu ${randomUUID()}`])),
  },
  {
    n: 145, file: "145_company_setup", marker: "post-144 marker 145 company_setup", verify: "supabase/verify/company_setup_145.sql", tables: ["company_setup_progress"],
    switch: "tolra.x145_accept_deleting_setup_ticks", refusal: /145 rollback refused: setup ticks exist/,
    seed: async (db, org) => void (await db.query("INSERT INTO public.company_setup_progress(organization_id, step, completed) VALUES ($1, 'company', true)", [org])),
  },
  {
    n: 147, file: "147_job_delivery_note", marker: "post-144 marker 147 job_delivery_note", verify: "supabase/verify/job_delivery_note_147.sql", tables: ["dln_numbering_pending"],
    switch: "tolra.x147_accept_releasing_hold", refusal: /147 rollback refused: a company is still held/,
    seed: async (db, org) => void (await db.query("INSERT INTO public.dln_numbering_pending(organization_id) VALUES ($1) ON CONFLICT DO NOTHING", [org])),
  },
  {
    n: 148, file: "148_job_profitability_actuals", marker: "post-144 marker 148 job_profitability_actuals", verify: "supabase/verify/job_profitability_actuals_148.sql",
    tables: ["job_cost_snapshots", "job_cost_declarations", "job_costing_machine_links", "job_costing_settings"],
    switch: "tolra.x148_accept_deleting_job_costs", refusal: /148 rollback refused: job costing data exists/,
    seed: async (db, org) => void (await db.query("INSERT INTO public.job_costing_settings(organization_id) VALUES ($1)", [org])),
  },
];

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
});

async function inTransaction<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async db => {
    await db.query("BEGIN");
    try {
      return await fn(db);
    } finally {
      await db.query("ROLLBACK");
    }
  });
}
async function newOrg(db: Client) {
  const id = randomUUID();
  await db.query("INSERT INTO public.organizations(id, name, slug, status) VALUES ($1, $2, $3, 'active')", [id, "Synthetic rollback", `t-rb-${id}`]);
  return id;
}
/** Removes every row the feature holds (the fixture may hold some), so a case starts empty. */
async function empty(db: Client, c: Case) {
  for (const t of c.tables) await db.query(`DELETE FROM public.${t}`);
}
const count = async (db: Client, c: Case) => Number((await db.query(c.tables.map(t => `SELECT count(*) AS n FROM public.${t}`).join(" UNION ALL "))).rows.reduce((s, r) => s + Number(r.n), 0));
const marker = async (db: Client, c: Case) => (await db.query(read("supabase/verify/release_preflight.sql"))).rows.find(r => String(r.check).includes(c.marker))?.value;
async function attempt(db: Client, sql: string): Promise<string | null> {
  await db.query("SAVEPOINT attempt");
  try {
    await db.query(sql);
    return null;
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT attempt");
    return (e as Error).message;
  }
}

describe.each(cases)("rollback of $n", c => {
  const rollback = () => unwrapped(read(`supabase/release/${c.file}.rollback.sql`));
  const release = () => unwrapped(read(`supabase/release/${c.file}.release.sql`));

  it("is REFUSED while the feature holds data, and nothing changes", async () => {
    await inTransaction(async db => {
      await empty(db, c);
      await c.seed(db, await newOrg(db));
      const before = await count(db, c);
      expect(before).toBeGreaterThan(0);
      expect(await marker(db, c)).toBe("applied");
      expect(await attempt(db, rollback())).toMatch(c.refusal);
      expect(await count(db, c)).toBe(before);
      expect(await marker(db, c)).toBe("applied");
      for (const t of c.tables) expect((await db.query("SELECT to_regclass($1) AS t", [`public.${t}`])).rows[0].t).not.toBeNull();
    });
  });

  it("still works on an empty install, and the release then applies again", async () => {
    await inTransaction(async db => {
      await empty(db, c);
      await db.query(rollback());
      expect(await marker(db, c)).toBe("not applied");
      for (const t of c.tables) expect((await db.query("SELECT to_regclass($1) AS t", [`public.${t}`])).rows[0].t).toBeNull();
      await db.query(release());
      expect(await marker(db, c)).toBe("applied");
      const checks = (await db.query(read(c.verify))).rows;
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.filter(r => (r.ok ?? r.passed) !== true)).toEqual([]);
    });
  });

  it(`runs over data only when told in the same session (SET ${c.switch} = 'yes')`, async () => {
    await inTransaction(async db => {
      await empty(db, c);
      await c.seed(db, await newOrg(db));
      await db.query("SELECT set_config($1, 'yes', true)", [c.switch]);
      await db.query(rollback());
      expect(await marker(db, c)).toBe("not applied");
    });
  });
});
