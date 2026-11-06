/**
 * Post-144 release 148 (optional actual job costing on 143's rates). Pure SQL through the database connection, as 147's proof does.
 *   - the ONLY rate source is 143 (costing_defaults / costing_machines, edited only by save_costing_settings_atomic): labour at the company
 *     rate, a machine's own labour rate for operator time on it, machine time at its hourly rate, overhead_pct on machine + labour;
 *   - a job's cost is recorded (rates used + pence) at commit of the finish or first issued invoice; editing 143's rates afterwards changes no
 *     record, a refresh re-works it at the record's own rates, and the record's rates cannot be altered;
 *   - incomplete inputs are incomplete (reasons, no figures, never a zero); not configured in 143 means off with 143's message;
 *   - company isolation and the role matrix; rollback leaves 143 intact and the release applies again.
 * The verified fixture installs 145 to 150 first.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { beforeAll, expect, it } from "vitest";

import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const MARKER = "post-144 marker 148 job_profitability_actuals";
type Actor = { id: string; session: string; org: string; email: string; role: string };
type Db = Pick<Client, "query">;
type Figures = { state: string; reasons: string[]; labour_pence: number | null; machine_pence: number | null; overhead_pence: number | null; supplier_pence: number | null; labour_us: number | null; machine_us: number | null };
type Inputs = { configured: boolean; open: boolean; config: { enabled: boolean; revision: number }; live?: Figures | null; snapshot?: (Figures & { taken_on: string; rates_read_at: string }) | null; invoices?: unknown[] };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
});

async function org(db: Db, label: string) {
  const id = randomUUID();
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `Synthetic ${label}`, `t-p148-${label}-${id}`]);
  return id;
}
async function actor(db: Db, orgId: string, role: string): Promise<Actor> {
  const id = randomUUID(), session = randomUUID(), email = `${id}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)", [id, email, role, orgId]);
  await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,true)", [id, orgId, role]);
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, id, orgId]);
  return { id, session, org: orgId, email, role };
}
async function as<T = Record<string, unknown>>(db: Db, who: Actor, sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: { code?: string; message: string } }> {
  await db.query("SAVEPOINT p148_call");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: who.id, session_id: who.session, role: "authenticated", aal: "aal2", email: who.email }), who.id]);
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT p148_call");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT p148_call");
    await db.query("RESET ROLE");
    const err = e as { code?: string; message: string };
    return { error: { code: err.code, message: err.message } };
  }
}
const ok = <T>(r: { rows?: T[]; error?: { message: string } }) => { expect(r.error).toBeUndefined(); return r.rows!; };
async function committed<T>(db: Db, fn: () => Promise<T>) { await db.query("BEGIN"); try { const v = await fn(); await db.query("COMMIT"); return v; } catch (e) { await db.query("ROLLBACK"); throw e; } }

/** The company's 143 rate set exactly as 143's save compares it (p_expected). */
async function current143(db: Db, orgId: string) {
  return (await db.query(`SELECT jsonb_build_object(
    'materials', coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'price_pence',price_pence,'price_unit',price_unit,'scrap_pct',scrap_pct) ORDER BY id) FROM public.costing_materials WHERE organization_id=$1),'[]'::jsonb),
    'machines', coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'hourly_rate_pence',hourly_rate_pence,'labour_rate_pence',labour_rate_pence) ORDER BY id) FROM public.costing_machines WHERE organization_id=$1),'[]'::jsonb),
    'defaults', (SELECT jsonb_build_object('labour_rate_pence',labour_rate_pence,'programming_rate_pence',programming_rate_pence,'overhead_pct',overhead_pct,'default_margin_pct',default_margin_pct) FROM public.costing_defaults WHERE organization_id=$1)) AS j`, [orgId])).rows[0].j;
}
type RateSet = { labour: number; overhead: number; machines: Array<{ id: string; name: string; hourly: number; labour: number | null }> };
/** Rates are only ever written through 143's own save function, as the company's admin. */
async function save143(db: Db, admin: Actor, r: RateSet) {
  const expected = await current143(db, admin.org);
  const materials = expected.materials.length ? expected.materials : [{ id: randomUUID(), name: "Aluminium 6082", price_pence: 450, price_unit: "kg", scrap_pct: 5 }];
  const value = { materials, machines: r.machines.map(m => ({ id: m.id, name: m.name, hourly_rate_pence: m.hourly, labour_rate_pence: m.labour })),
    defaults: { labour_rate_pence: r.labour, programming_rate_pence: 3000, overhead_pct: r.overhead, default_margin_pct: 20 } };
  return as(db, admin, "SELECT public.save_costing_settings_atomic($1,$2,$3)", [admin.org, JSON.stringify(expected), JSON.stringify(value)]);
}
async function machine(db: Db, orgId: string, name: string) {
  return (await db.query("INSERT INTO public.machines(organization_id,name) VALUES($1,$2) RETURNING id", [orgId, name])).rows[0].id as string;
}
async function job(db: Db, orgId: string) {
  return (await db.query("INSERT INTO public.jobs(organization_id,job_no,customer,description,stage,started_at) VALUES($1,$2,'Acme P148','Brackets','machining',now()-interval '2 days') RETURNING id",
    [orgId, `J-P148-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
}
async function labour(db: Db, orgId: string, user: string, jobId: string, from: string, to: string | null) {
  await db.query("INSERT INTO public.operator_sessions(organization_id,user_id,job_id,started_at,ended_at,source,end_source) VALUES($1,$2,$3,$4,$5,'manual',$6)",
    [orgId, user, jobId, from, to, to ? "sheet" : null]);
}
async function run(db: Db, orgId: string, jobId: string, machineId: string, operator: string | null, from: string, to: string | null) {
  await db.query("INSERT INTO public.machine_runs(organization_id,job_id,machine_id,operator_id,started_at,ended_at,end_reason) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [orgId, jobId, machineId, operator, from, to, to ? "finished" : null]);
}
const D = (t: string, day = 4) => `2026-10-${String(day).padStart(2, "0")}T${t}:00Z`;
let nextDay = 10; // each worked job on its own day, so no two jobs overlap in time
const inputs = async (db: Db, who: Actor, jobId: string) => ok(await as<{ j: Inputs }>(db, who, "SELECT public.job_profitability_actual_inputs($1) AS j", [jobId]))[0].j;
const enable = (db: Db, admin: Actor, on: boolean, revision: number) => as(db, admin, "SELECT public.set_job_costing_enabled($1,$2,$3)", [admin.org, revision, on]);
const link = (db: Db, admin: Actor, links: Array<[string, string]>) =>
  as(db, admin, "SELECT public.save_job_costing_machine_links($1,$2)", [admin.org, JSON.stringify(links.map(([machine_id, costing_machine_id]) => ({ machine_id, costing_machine_id })))]);
const declare = (db: Db, who: Actor, jobId: string, noLabour = false, noMachines = false) => as(db, who, "SELECT public.save_job_cost_declarations($1,$2,$3)", [jobId, noLabour, noMachines]);

/** A company with 143 rates (labour 2000p/h, overhead 150%), one shop-floor machine linked to a 143 machine (4500p/h, own labour 2600p/h). */
async function company(db: Db, label: string) {
  const id = await org(db, label);
  const admin = await actor(db, id, "admin"), office = await actor(db, id, "office"), workshop = await actor(db, id, "workshop"), viewer = await actor(db, id, "viewer");
  const mill = await machine(db, id, "Mill 1"), haas = randomUUID();
  ok(await save143(db, admin, { labour: 2000, overhead: 150, machines: [{ id: haas, name: "Haas VF2", hourly: 4500, labour: 2600 }] }));
  ok(await link(db, admin, [[mill, haas]]));
  ok(await enable(db, admin, true, 0));
  return { id, admin, office, workshop, viewer, mill, haas };
}
/** 1.5 h labour 08:00-09:30, of which 08:30-09:00 on the mill (operator = the worker), plus a 0.5 h run. */
async function workedJob(db: Db, c: Awaited<ReturnType<typeof company>>) {
  const j = await job(db, c.id), day = nextDay++;
  await labour(db, c.id, c.workshop.id, j, D("08:00", day), D("09:30", day));
  await run(db, c.id, j, c.mill, c.workshop.id, D("08:30", day), D("09:00", day));
  ok(await declare(db, c.office, j));
  return j;
}

it("148 is installed: preflight marker applied, every 148 verify row true and 143's verify still true", async () => {
  await withDb(async db => {
    const preflight = (await db.query(read("supabase/verify/release_preflight.sql"))).rows;
    expect(preflight.find(r => r.check === MARKER)?.value).toBe("applied");
    const checks = (await db.query(read("supabase/verify/job_profitability_actuals_148.sql"))).rows;
    expect(checks).toHaveLength(12);
    expect(checks.filter(r => r.ok !== true)).toEqual([]);
    const c143 = (await db.query(read("supabase/verify/costing_rates_143.sql"))).rows;
    expect(c143.filter(r => r.ok !== true)).toEqual([]);
  });
});

it("reuses 143's rates only: labour (machine override), machine hourly, overhead_pct; an edit through 143's save moves an OPEN job's live figure", async () => {
  await withDb(async db => {
    await db.query("BEGIN");
    try {
      const c = await company(db, "reuse");
      const j = await workedJob(db, c);
      const first = await inputs(db, c.office, j);
      expect(first).toMatchObject({ configured: true, open: true, config: { enabled: true, revision: 1 }, snapshot: null });
      // 1 h at 2000 + 0.5 h at the machine's own 2600 = 3300; machine 0.5 h x 4500 = 2250; overhead (3300+2250) x 50% = 2775.
      expect(first.live).toMatchObject({ state: "complete", reasons: [], labour_pence: 3300, machine_pence: 2250, overhead_pence: 2775, supplier_pence: 0, labour_us: 5_400_000_000, machine_us: 1_800_000_000 });
      // Change the rates through 143's one editor: today's rates move the open job.
      ok(await save143(db, c.admin, { labour: 3000, overhead: 100, machines: [{ id: c.haas, name: "Haas VF2", hourly: 6000, labour: null }] }));
      expect((await inputs(db, c.office, j)).live).toMatchObject({ state: "complete", labour_pence: 4500, machine_pence: 3000, overhead_pence: 0 });
      // One rounding rule, half to even on the exact value: 20 minutes at 1001p/h is 333.666.. -> 334; 30 min at 1001 is 500.5 -> 500 (even).
      ok(await save143(db, c.admin, { labour: 1001, overhead: 100, machines: [{ id: c.haas, name: "Haas VF2", hourly: 1001, labour: null }] }));
      const k = await job(db, c.id);
      await labour(db, c.id, c.workshop.id, k, D("10:00"), D("10:30"));
      await run(db, c.id, k, c.mill, null, D("11:00"), D("11:20"));
      ok(await declare(db, c.office, k));
      expect((await inputs(db, c.office, k)).live).toMatchObject({ state: "complete", labour_pence: 500, machine_pence: 334, overhead_pence: 0 });
      // No second rate store or editor exists to bypass 143.
      for (const fn of ["save_job_costing_rates", "save_job_cost_estimate"]) expect((await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname=$1", [fn])).rows[0].n).toBe(0);
      expect((await as(db, c.admin, "INSERT INTO public.job_costing_machine_links(organization_id,machine_id,costing_machine_id) VALUES($1,$2,$3)", [c.id, c.mill, c.haas])).error?.code).toBe("42501");
    } finally { await db.query("ROLLBACK"); }
  });
});

it("snapshot at commit of the finish: later 143 rate edits never change it; refresh uses its own rates; its rates cannot be altered", async () => {
  await withDb(async db => {
    const { c, j, inv } = await committed(db, async () => {
      const c = await company(db, "snap");
      const j = await workedJob(db, c);
      const inv = await workedJob(db, c);
      return { c, j, inv };
    });
    // Finish one job and issue the other's first invoice, each in its own committed transaction (the record is taken at commit).
    await committed(db, () => db.query("UPDATE public.jobs SET finished_at=now(), stage='complete' WHERE id=$1", [j]));
    await committed(db, () => db.query("INSERT INTO public.invoices(organization_id,job_id,invoice_ref,customer,total,amount_paid,credited_amount,refunded_amount,status,subtotal) VALUES($1,$2,$3,'Acme P148',240,0,0,0,'sent',200)",
      [c.id, inv, `INV-P148-${randomUUID().slice(0, 8)}`]));
    const rows = (await db.query("SELECT job_id, taken_on, state, labour_pence, machine_pence, overhead_pence, supplier_pence, rates FROM public.job_cost_snapshots WHERE organization_id=$1", [c.id])).rows;
    const snap = rows.find(r => r.job_id === j)!;
    expect(snap).toMatchObject({ taken_on: "finished", state: "complete", labour_pence: "3300", machine_pence: "2250", overhead_pence: "2775", supplier_pence: "0" });
    expect(snap.rates.defaults).toMatchObject({ labour_rate_pence: 2000, overhead_pct: 150 });
    await db.query("BEGIN");
    try {
      // Edit the company's rates through 143 afterwards.
      ok(await save143(db, c.admin, { labour: 9000, overhead: 300, machines: [{ id: c.haas, name: "Haas VF2", hourly: 9999, labour: 9999 }] }));
      const after = await inputs(db, c.office, j);
      expect(after.open).toBe(false);
      expect(after.live ?? null).toBeNull();
      expect(after.snapshot).toMatchObject({ taken_on: "finished", state: "complete", labour_pence: 3300, machine_pence: 2250, overhead_pence: 2775 });
      // A correction of recorded time is re-worked at the RECORD's rates, never today's: +30 min labour at 2000 = 4300.
      await labour(db, c.id, c.workshop.id, j, D("12:00"), D("12:30"));
      ok(await as(db, c.office, "SELECT public.refresh_job_cost_snapshot($1)", [j]));
      expect((await inputs(db, c.office, j)).snapshot).toMatchObject({ state: "complete", labour_pence: 4300, machine_pence: 2250, overhead_pence: 3275 });
      // The record's rates are frozen even for the table owner; API roles cannot write records at all.
      await db.query("SAVEPOINT s2");
      await expect(db.query("UPDATE public.job_cost_snapshots SET rates = rates || '{\"x\":1}'::jsonb WHERE job_id=$1", [j])).rejects.toThrow(/keeps the rates it was taken at/);
      await db.query("ROLLBACK TO SAVEPOINT s2");
      expect((await as(db, c.admin, "UPDATE public.job_cost_snapshots SET labour_pence=1 WHERE job_id=$1", [j])).error?.code).toBe("42501");
      expect((await as(db, c.admin, "DELETE FROM public.job_cost_snapshots WHERE job_id=$1", [j])).error?.code).toBe("42501");
      // A finish rolled back takes no record; a second close keeps the first record.
      const k = await workedJob(db, c);
      await db.query("SAVEPOINT s3");
      await db.query("UPDATE public.jobs SET finished_at=now(), stage='complete' WHERE id=$1", [k]);
      await db.query("ROLLBACK TO SAVEPOINT s3");
      expect((await db.query("SELECT count(*)::int AS n FROM public.job_cost_snapshots WHERE job_id=$1", [k])).rows[0].n).toBe(0);
    } finally { await db.query("ROLLBACK"); }
    // The job whose first invoice was issued (not finished) was recorded on the invoice, at the rates of that moment.
    expect(rows.find(r => r.job_id === inv)).toMatchObject({ taken_on: "invoiced", state: "complete", labour_pence: "3300", machine_pence: "2250", overhead_pence: "2775" });
  });
});

it("incomplete stays incomplete (reasons, no figures, no zero); not configured in 143 is OFF with 143's message", async () => {
  await withDb(async db => {
    await db.query("BEGIN");
    try {
      const c = await company(db, "gaps");
      // No declaration, open timer, unlinked machine, overlapping time on another job, unreadable supplier order.
      const j = await job(db, c.id), other = await job(db, c.id), lathe = await machine(db, c.id, "Lathe 2"), second = await actor(db, c.id, "workshop");
      await labour(db, c.id, second.id, j, D("08:00"), null);
      await run(db, c.id, j, lathe, null, D("08:00"), D("09:00"));
      const live = (await inputs(db, c.office, j)).live!;
      expect(live).toMatchObject({ state: "incomplete", labour_pence: null, machine_pence: null, overhead_pence: null, supplier_pence: null });
      expect(live.reasons).toEqual(expect.arrayContaining(["Confirm whether this job needs labour and machine hours", "A labour or machine timer on this job is still running", 'Machine "Lathe 2" has no costing rate linked']));
      const k = await workedJob(db, c), kDay = nextDay - 1;
      await labour(db, c.id, c.workshop.id, other, D("09:00", kDay), D("10:00", kDay));
      await db.query("INSERT INTO public.purchase_orders(organization_id,po_number,supplier,status,job_id,total_value) VALUES($1,$2,'Steel Co','sent',$3,NULL)", [c.id, `PO-P148-${randomUUID().slice(0, 8)}`, k]);
      const kl = (await inputs(db, c.office, k)).live!;
      expect(kl).toMatchObject({ state: "incomplete", labour_pence: null, supplier_pence: null });
      expect(kl.reasons).toEqual(expect.arrayContaining(["Overlapping time on another job needs correction before costing", "Supplier allocations are missing or unreadable"]));
      // A readable supplier order counts its linked part once (lib/purchase-order-link's rule): 100.00 total, 12.34 linked -> 1234p.
      const s = await workedJob(db, c);
      await db.query("INSERT INTO public.purchase_orders(organization_id,po_number,supplier,status,job_id,total_value,linked_net) VALUES($1,$2,'Steel Co','sent',$3,100,12.34),($1,$4,'Steel Co','cancelled',$3,500,NULL)",
        [c.id, `PO-P148-${randomUUID().slice(0, 8)}`, s, `PO-P148-${randomUUID().slice(0, 8)}`]);
      expect((await inputs(db, c.office, s)).live).toMatchObject({ state: "complete", supplier_pence: 1234 });
      // Declared "no machines" but a run exists: a conflict, not a zero.
      const m = await workedJob(db, c);
      ok(await declare(db, c.office, m, false, true));
      expect((await inputs(db, c.office, m)).live!.reasons).toContain("Recorded machines conflict with the no-machine declaration");
      // Nothing recorded and nothing declared: incomplete. Declared: a real zero.
      const n = await job(db, c.id);
      ok(await declare(db, c.office, n, false, false));
      expect((await inputs(db, c.office, n)).live!.reasons).toEqual(["No completed labour hours recorded", "No completed machine hours recorded"]);
      ok(await declare(db, c.office, n, true, true));
      expect((await inputs(db, c.office, n)).live).toMatchObject({ state: "complete", labour_pence: 0, machine_pence: 0, overhead_pence: 0, supplier_pence: 0 });
      // The 143 machine a link points at is deleted in Settings: the job goes incomplete, never priced at zero.
      ok(await save143(db, c.admin, { labour: 2000, overhead: 150, machines: [{ id: randomUUID(), name: "Other", hourly: 100, labour: null }] }));
      expect((await inputs(db, c.office, await workedJob(db, c))).live!.reasons).toContain('Machine "Mill 1" has no costing rate linked');

      // A company with no 143 rates: cannot be switched on (143's message); reads say not configured and carry no figures.
      const bare = await org(db, "bare"), bareAdmin = await actor(db, bare, "admin"), bareOffice = await actor(db, bare, "office");
      const bj = await job(db, bare);
      const refused = await enable(db, bareAdmin, true, 0);
      expect(refused.error).toMatchObject({ code: "22023", message: "Costing is not set up: enter your rates in Settings > Costing rates" });
      const bi = await inputs(db, bareOffice, bj);
      expect(bi).toMatchObject({ configured: false, config: { enabled: false } });
      expect(bi.live).toBeUndefined();
      expect(bi.snapshot).toBeUndefined();
      // Switched off: no figures either; a finished job of a company not configured gets no record.
      ok(await enable(db, c.admin, false, 1));
      const off = await inputs(db, c.office, k);
      expect(off).toMatchObject({ config: { enabled: false } });
      expect(off.live).toBeUndefined();
      await db.query("UPDATE public.jobs SET finished_at=now(), stage='complete' WHERE id=$1", [bj]);
      await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect((await db.query("SELECT count(*)::int AS n FROM public.job_cost_snapshots WHERE job_id=$1", [bj])).rows[0].n).toBe(0);
      // A stale revision is refused (two admins).
      expect((await enable(db, c.admin, true, 1)).error?.code).toBe("40001");
    } finally { await db.query("ROLLBACK"); }
  });
});

it("company isolation and roles: other companies, workshop and viewer see nothing; only an admin switches or links; internals are not callable", async () => {
  await withDb(async db => {
    await db.query("BEGIN");
    try {
      const a = await company(db, "iso-a"), b = await company(db, "iso-b");
      const ja = await workedJob(db, a);
      await db.query("UPDATE public.jobs SET finished_at=now(), stage='complete' WHERE id=$1", [ja]);
      await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect((await as(db, b.admin, "SELECT public.job_profitability_actual_inputs($1)", [ja])).error?.code).toBe("42501");
      expect((await as(db, b.admin, "SELECT public.refresh_job_cost_snapshot($1)", [ja])).error?.code).toBe("P0002");
      expect((await as(db, b.office, "SELECT public.save_job_cost_declarations($1,true,true)", [ja])).error?.code).toBe("42501");
      for (const t of ["job_cost_snapshots", "job_costing_settings", "job_costing_machine_links", "job_cost_declarations"]) {
        const seen = ok(await as<{ organization_id: string }>(db, b.admin, `SELECT organization_id FROM public.${t}`));
        expect(seen.every(r => r.organization_id === b.id)).toBe(true);
        expect(ok(await as(db, a.workshop, `SELECT 1 FROM public.${t}`))).toEqual([]);
        expect(ok(await as(db, a.viewer, `SELECT 1 FROM public.${t}`))).toEqual([]);
      }
      expect(ok(await as(db, a.office, "SELECT 1 FROM public.job_cost_snapshots WHERE job_id=$1", [ja]))).toHaveLength(1);
      // B cannot link A's machine or A's 143 machine; A cannot use B's 143 machine.
      expect((await link(db, b.admin, [[a.mill, b.haas]])).error?.code).toBe("22023");
      expect((await link(db, a.admin, [[a.mill, b.haas]])).error?.code).toBe("22023");
      expect((await as(db, b.admin, "SELECT public.set_job_costing_enabled($1,1,false)", [a.id])).error?.code).toBe("42501");
      // Roles: workshop and viewer read nothing; office reads and declares but neither switches nor links.
      for (const who of [a.workshop, a.viewer]) expect((await as(db, who, "SELECT public.job_profitability_actual_inputs($1)", [ja])).error?.code).toBe("42501");
      expect((await enable(db, a.office, false, 1)).error?.code).toBe("42501");
      expect((await link(db, a.office, [])).error?.code).toBe("42501");
      for (const sql of ["SELECT public.job_cost_rates($1)", "SELECT public.job_cost_figures($1,$1,'{}'::jsonb)", "SELECT public.job_cost_take_snapshot($1,$1,'finished')", "SELECT public.job_costing_access($1::uuid IS NULL)", "SELECT public.job_cost_round(1,1), $1::uuid"])
        expect((await as(db, a.admin, sql, [a.id])).error?.code).toBe("42501");
    } finally { await db.query("ROLLBACK"); }
  });
});

it("rollback drops only 148 (143's rates and save function untouched), the release applies again, verify true, a second install refuses", async () => {
  await withDb(async db => {
    const before143 = (await db.query(read("supabase/verify/costing_rates_143.sql"))).rows;
    await db.query(read("supabase/release/148_job_profitability_actuals.rollback.sql"));
    try {
      expect((await db.query("SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('job_costing_settings','job_costing_machine_links','job_cost_declarations','job_cost_snapshots')")).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='zz_job_cost_snapshot'")).rows[0].n).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'job_cost%' OR proname IN ('job_profitability_actual_inputs','set_job_costing_enabled','save_job_costing_machine_links','save_job_cost_declarations','refresh_job_cost_snapshot')")).rows[0].n).toBe(0);
      expect((await db.query(read("supabase/verify/release_preflight.sql"))).rows.find(r => r.check === MARKER)?.value).toBe("not applied");
      const after143 = (await db.query(read("supabase/verify/costing_rates_143.sql"))).rows;
      expect(after143).toEqual(before143);
      expect(after143.filter(r => r.ok !== true)).toEqual([]);
      // Jobs still finish with 148 gone.
      await db.query("BEGIN");
      const o = await org(db, "rb"), j = await job(db, o);
      await db.query("UPDATE public.jobs SET finished_at=now(), stage='complete' WHERE id=$1", [j]);
      await db.query("ROLLBACK");
    } finally {
      await db.query(read("supabase/release/148_job_profitability_actuals.release.sql"));
    }
    expect((await db.query(read("supabase/verify/job_profitability_actuals_148.sql"))).rows.filter(r => r.ok !== true)).toEqual([]);
    expect((await db.query(read("supabase/verify/release_preflight.sql"))).rows.find(r => r.check === MARKER)?.value).toBe("applied");
    await expect(db.query(read("supabase/release/148_job_profitability_actuals.release.sql"))).rejects.toThrow(/already exists/);
    await db.query("ROLLBACK").catch(() => undefined);
  });
});
