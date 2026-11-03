/** Operator-run only: tests/scripts/costing-atomic-plan.md. Never installs SQL. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb, type SyntheticWorld } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

let world: SyntheticWorld;
const material = randomUUID(), machine = randomUUID(), foreignMaterial = randomUUID(), foreignMachine = randomUUID();
let supportSession: string;
type Settings = { materials: Record<string, unknown>[]; machines: Record<string, unknown>[]; defaults: Record<string, unknown> | null };

async function snapshot(org: string): Promise<Settings> {
  return withDb(async db => {
    const materials = await db.query("select id,name,price_pence,price_unit,scrap_pct::float8 from public.costing_materials where organization_id=$1 order by id", [org]);
    const machines = await db.query("select id,name,hourly_rate_pence,labour_rate_pence from public.costing_machines where organization_id=$1 order by id", [org]);
    const defaults = await db.query("select labour_rate_pence,programming_rate_pence,overhead_pct::float8,default_margin_pct::float8 from public.costing_defaults where organization_id=$1", [org]);
    return { materials: materials.rows, machines: machines.rows, defaults: defaults.rows[0] ?? null };
  });
}
function changed(value: Settings, price = 555): Settings {
  return { materials: [{ ...value.materials[0], price_pence: price }], machines: [{ ...value.machines[0], hourly_rate_pence: price * 10 }], defaults: { ...value.defaults, labour_rate_pence: price * 2 } };
}
async function authenticate(db: Client, user: string, session?: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.headers','{}',true)",
    [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", ...(session ? { session_id: session } : {}) }), user]);
}
async function save(user: string, org: string, expected: Settings, value: Settings, session?: string) {
  return withDb(async db => {
    await db.query("begin");
    try {
      await authenticate(db, user, session);
      await db.query("select public.save_costing_settings_atomic($1,$2::jsonb,$3::jsonb)", [org, JSON.stringify(expected), JSON.stringify(value)]);
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
  });
}

beforeAll(async () => {
  if (process.env.COSTING_ATOMIC_THROWAWAY !== "yes") throw new Error("Operator must explicitly set COSTING_ATOMIC_THROWAWAY=yes on the disposable local stack");
  await verifyBackendIdentity();
  await withDb(async db => {
    const fn = await db.query("select to_regprocedure('public.save_costing_settings_atomic(uuid,jsonb,jsonb)') as fn");
    if (!fn.rows[0].fn) throw new Error("Proposal missing: follow the operator plan; this test never installs it");
  });
  world = await createSyntheticWorld();
  supportSession = randomUUID();
  // A real elevated support membership, not a stub of my_session(). The beta viewer retains their own company too.
  await withDb(async db => {
    const user = world.tenants.beta.users.viewer.id, org = world.tenants.alpha.id, grant = randomUUID();
    await db.query("insert into security_audit.platform_admins(user_id) values($1)", [user]);
    await db.query("insert into public.organization_members(user_id,organization_id,role,active,support,expires_at,support_grant) values($1,$2,'admin',true,true,now()+interval '2 hours',$3)", [user, org, grant]);
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [supportSession, user]);
    await db.query("insert into security_audit.session_company(session_id,user_id,organization_id,grant_id,elevated_until) values($1,$2,$3,$4,now()+interval '30 minutes')", [supportSession, user, org, grant]);
  });
});
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });
beforeEach(async () => {
  await withDb(async db => {
    for (const [tenant, mat, mill] of [[world.tenants.alpha, material, machine], [world.tenants.beta, foreignMaterial, foreignMachine]] as const) {
      await db.query("delete from public.costing_materials where organization_id=$1", [tenant.id]);
      await db.query("delete from public.costing_machines where organization_id=$1", [tenant.id]);
      await db.query("delete from public.costing_defaults where organization_id=$1", [tenant.id]);
      await db.query("insert into public.costing_materials(id,organization_id,name,price_pence,price_unit,scrap_pct) values($1,$2,'Steel',200,'kg',5)", [mat, tenant.id]);
      await db.query("insert into public.costing_machines(id,organization_id,name,hourly_rate_pence,labour_rate_pence) values($1,$2,'Mill',6000,null)", [mill, tenant.id]);
      await db.query("insert into public.costing_defaults(organization_id) values($1)", [tenant.id]);
    }
  });
});

describe("atomic costing proposal on an explicitly disposable database", () => {
  it.each(["admin", "office"] as const)("%s saves all three collections", async role => {
    const a = world.tenants.alpha, before = await snapshot(a.id), value = changed(before);
    await save(a.users[role].id, a.id, before, value);
    expect(await snapshot(a.id)).toEqual(value);
  });
  it.each(["workshop", "viewer"] as const)("ordinary %s staff are refused without writes", async role => {
    const a = world.tenants.alpha, before = await snapshot(a.id);
    await expect(save(a.users[role].id, a.id, before, changed(before))).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot(a.id)).toEqual(before);
  });
  it("elevated support is refused even though its session is active and has admin access", async () => {
    const a = world.tenants.alpha, user = world.tenants.beta.users.viewer.id, before = await snapshot(a.id);
    await withDb(async db => {
      await db.query("begin");
      try {
        await authenticate(db, user, supportSession);
        const session = (await db.query("select public.my_session() as s")).rows[0].s;
        expect(session).toMatchObject({ support: true, read_only: false, role: "admin", organization_id: a.id });
      } finally { await db.query("rollback"); }
    });
    await expect(save(user, a.id, before, changed(before), supportSession)).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot(a.id)).toEqual(before);
  });
  it("cannot pass another company as p_org", async () => {
    const a = world.tenants.alpha, b = world.tenants.beta, beforeA = await snapshot(a.id), beforeB = await snapshot(b.id);
    await expect(save(a.users.admin.id, b.id, beforeB, changed(beforeB))).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot(a.id)).toEqual(beforeA); expect(await snapshot(b.id)).toEqual(beforeB);
  });
  it.each(["materials", "machines"] as const)("a reused foreign %s ID cannot move or overwrite either company's data", async collection => {
    const a = world.tenants.alpha, b = world.tenants.beta, beforeA = await snapshot(a.id), beforeB = await snapshot(b.id);
    const value = changed(beforeA); value[collection][0].id = beforeB[collection][0].id;
    await expect(save(a.users.office.id, a.id, beforeA, value)).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot(a.id)).toEqual(beforeA); expect(await snapshot(b.id)).toEqual(beforeB);
  });
  it("a late defaults constraint error rolls back prior deletes, additions and machine updates", async () => {
    const a = world.tenants.alpha, before = await snapshot(a.id), value = changed(before);
    value.materials[0].id = randomUUID();
    value.defaults!.default_margin_pct = -1;
    await expect(save(a.users.admin.id, a.id, before, value)).rejects.toMatchObject({ code: "23514" });
    expect(await snapshot(a.id)).toEqual(before);
  });
  it("two simultaneous saves from one snapshot have one winner and one stale conflict, without mixed rates", async () => {
    const a = world.tenants.alpha, before = await snapshot(a.id), winner = changed(before, 333), loser = changed(before, 777);
    const first = new Client({ connectionString: isolatedBackend().databaseUrl });
    const second = new Client({ connectionString: isolatedBackend().databaseUrl });
    let pending: Promise<unknown> | undefined;
    await first.connect(); await second.connect();
    try {
      await first.query("begin"); await second.query("begin");
      await authenticate(first, a.users.admin.id); await authenticate(second, a.users.office.id);
      await first.query("select public.save_costing_settings_atomic($1,$2,$3)", [a.id, JSON.stringify(before), JSON.stringify(winner)]);
      const pid = (await second.query("select pg_backend_pid() as pid")).rows[0].pid;
      pending = second.query("select public.save_costing_settings_atomic($1,$2,$3)", [a.id, JSON.stringify(before), JSON.stringify(loser)]).then(() => ({ accepted: true }), error => error);
      // Prove overlap at the advisory lock; a sequential stale-write test cannot satisfy this assertion.
      await vi.waitFor(async () => {
        const waiting = await withDb(async db => (await db.query("select wait_event_type,lower(wait_event) as event from pg_stat_activity where pid=$1", [pid])).rows[0]);
        expect(waiting).toMatchObject({ wait_event_type: "Lock", event: "advisory" });
      }, { timeout: 5000 });
      await first.query("commit");
      expect(await pending).toMatchObject({ code: "40001" });
      await second.query("rollback");
      expect(await snapshot(a.id)).toEqual(winner);
    } finally {
      await first.query("rollback"); await second.query("rollback");
      await pending; await first.end(); await second.end();
    }
  });
});
