/**
 * sm-e (2): characterises release 148's job cost record (job_cost_snapshots) as the SQL behaves TODAY. Nothing is changed. Every case is one
 * transaction that is always rolled back; the snapshot trigger is deferred, so each case flushes it with SET CONSTRAINTS ALL IMMEDIATE (as
 * COMMIT would).
 *   A. A job finished while 143 has no rates gets no record, and no later rates change creates one; the job then shows neither a record nor live figures.
 *   B. Reopening a job leaves its old record (and old rates) in place; finishing it again does not take a new one; the open job then shows the stale record.
 *   C. The record is taken whether or not the company's costing switch is on; with the switch off the page is given no figures.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";

import { asUser, inTransaction, newActor, newOrg, prepareFixture, type Actor } from "../support/sm-e-db";

beforeAll(prepareFixture);

const IMMEDIATE = (db: Client) => db.query("SET CONSTRAINTS ALL IMMEDIATE");
async function company(db: Client, label: string) {
  const o = await newOrg(db, label);
  return { ...o, admin: await newActor(db, o.id, "admin") };
}
async function rates(db: Client, org: string, labour: number) {
  await db.query("INSERT INTO public.costing_defaults(organization_id,labour_rate_pence,programming_rate_pence,overhead_pct,default_margin_pct) VALUES($1,$2,3000,150,20) ON CONFLICT (organization_id) DO UPDATE SET labour_rate_pence=EXCLUDED.labour_rate_pence", [org, labour]);
  await db.query("INSERT INTO public.costing_machines(organization_id,name,hourly_rate_pence) VALUES($1,'Haas VF2',4500) ON CONFLICT DO NOTHING", [org]);
  await db.query("INSERT INTO public.costing_materials(organization_id,name,price_pence,price_unit,scrap_pct) SELECT $1,'Alu',450,'kg',5 WHERE NOT EXISTS (SELECT 1 FROM public.costing_materials WHERE organization_id=$1)", [org]);
}
const newJob = async (db: Client, org: string) => (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,description,stage,started_at) VALUES($1,$2,'Acme','Brackets','machining',now()-interval '2 days') RETURNING id", [org, `J-SME-${Math.random().toString(36).slice(2, 8)}`])).rows[0].id as string;
const finish = async (db: Client, job: string) => { await db.query("UPDATE public.jobs SET finished_at=now(), stage='complete' WHERE id=$1", [job]); await IMMEDIATE(db); };
const snaps = async (db: Client, job: string) => (await db.query("SELECT id, taken_on, state, rates #>> '{defaults,labour_rate_pence}' AS labour FROM public.job_cost_snapshots WHERE job_id=$1", [job])).rows;
const inputs = async (db: Client, who: Actor, job: string) => {
  const r = await asUser<{ j: Record<string, any> }>(db, who, "SELECT public.job_profitability_actual_inputs($1) AS j", [job]); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(r.error).toBeUndefined();
  return r.rows![0].j;
};
const enable = async (db: Client, who: Actor, org: string, on: boolean, revision: number) => { const r = await asUser(db, who, "SELECT public.set_job_costing_enabled($1,$2,$3)", [org, revision, on]); expect(r.error).toBeUndefined(); };

describe("sm-e job cost record (release 148)", () => {
  it("A. REAL (SQL design gap): finished with no rates configured = no record, and setting rates later does not create one", async () => {
    await inTransaction(async db => {
      const c = await company(db, "norates");
      const job = await newJob(db, c.id);
      await finish(db, job);
      expect(await snaps(db, job)).toEqual([]);
      // Rates (143) are configured afterwards and costing is switched on.
      await rates(db, c.id, 2000);
      await enable(db, c.admin, c.id, true, 0);
      await IMMEDIATE(db);
      expect(await snaps(db, job)).toEqual([]);
      // Nothing can make it from the app side: refresh needs an existing record.
      expect((await asUser(db, c.admin, "SELECT public.refresh_job_cost_snapshot($1)", [job])).error).toMatchObject({ code: "P0002", message: "No cost record for this job" });
      // And the job page gets neither a record nor live figures (it is finished, so not "open").
      const i = await inputs(db, c.admin, job);
      expect(i).toMatchObject({ configured: true, open: false, config: { enabled: true } });
      expect(i.snapshot).toBeNull();
      expect(i.live).toBeNull();
      // The only ways back in: reopen then finish again, which takes the record at TODAY's rates.
      expect((await asUser(db, c.admin, "SELECT public.reopen_job($1,'Reopened to take the cost record')", [job])).error).toBeUndefined();
      await finish(db, job);
      const after = await snaps(db, job);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ taken_on: "finished", labour: "2000" });
    });
  });

  it("B. REAL (SQL design): reopen leaves the old record; finishing again does not re-take it; the open job shows the stale one", async () => {
    await inTransaction(async db => {
      const c = await company(db, "reopen");
      await rates(db, c.id, 2000);
      await enable(db, c.admin, c.id, true, 0);
      const job = await newJob(db, c.id);
      await finish(db, job);
      const first = await snaps(db, job);
      expect(first).toHaveLength(1);
      expect(first[0].labour).toBe("2000");
      // Rates change, then the job is reopened.
      await rates(db, c.id, 3000);
      expect((await asUser(db, c.admin, "SELECT public.reopen_job($1,'Customer changed the drawing')", [job])).error).toBeUndefined();
      await IMMEDIATE(db);
      expect((await db.query("SELECT finished_at FROM public.jobs WHERE id=$1", [job])).rows[0].finished_at).toBeNull();
      expect(await snaps(db, job)).toEqual(first);
      // The job is open again, but the page treats it as closed: it shows the old record, no live figures.
      const open = await inputs(db, c.admin, job);
      expect(open.open).toBe(false);
      expect(open.live).toBeNull();
      expect(open.snapshot).toMatchObject({ id: first[0].id, taken_on: "finished" });
      // Finish again: still the one record, still at the old rate (take_snapshot returns early when one exists).
      await finish(db, job);
      expect(await snaps(db, job)).toEqual(first);
      // The only way to bring it up to date is refresh, which re-works it at the RECORD's own rates, never today's.
      expect((await asUser(db, c.admin, "SELECT public.refresh_job_cost_snapshot($1)", [job])).error).toBeUndefined();
      expect((await snaps(db, job))[0].labour).toBe("2000");
    });
  });

  it("C. TEST ONLY (as written): the record is taken even when costing is switched off, but the page gets no figures", async () => {
    await inTransaction(async db => {
      const c = await company(db, "off");
      await rates(db, c.id, 2000);
      // Never switched on: no settings row at all.
      expect((await db.query("SELECT 1 FROM public.job_costing_settings WHERE organization_id=$1", [c.id])).rowCount).toBe(0);
      const job = await newJob(db, c.id);
      await finish(db, job);
      expect(await snaps(db, job)).toHaveLength(1);
      const i = await inputs(db, c.admin, job);
      expect(i).toMatchObject({ configured: true, config: { enabled: false } });
      expect(i.snapshot).toBeUndefined();
      // Switched on later, the record that was taken while it was off is now shown.
      await enable(db, c.admin, c.id, true, 0);
      expect((await inputs(db, c.admin, job)).snapshot).toMatchObject({ taken_on: "finished" });
    });
  });
});
