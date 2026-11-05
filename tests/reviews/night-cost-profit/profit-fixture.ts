// Synthetic SQL helpers extracted unchanged from tests/db/job-profitability-148.test.ts.
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {expect} from 'vitest';
type Actor = { id: string; session: string; org: string; email: string; role: string };
type Db = Pick<Client, "query">;
type Figures = { state: string; reasons: string[]; labour_pence: number | null; machine_pence: number | null; overhead_pence: number | null; supplier_pence: number | null; labour_us: number | null; machine_us: number | null };
type Inputs = { configured: boolean; open: boolean; config: { enabled: boolean; revision: number }; live?: Figures | null; snapshot?: (Figures & { taken_on: string; rates_read_at: string }) | null; invoices?: unknown[] };

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


export {company,inputs,workedJob,save143};
