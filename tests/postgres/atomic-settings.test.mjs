import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const tables = ['chase_steps', 'costing_materials', 'costing_machines', 'costing_defaults'];
const orgs = [randomUUID(), randomUUID()];
const people = Object.fromEntries(['admin', 'office', 'workshop', 'viewer', 'support', 'beta'].map(role => [role, randomUUID()]));
let owner;
async function connect() {
  const value = process.env.TOLRA_ATOMIC_TEST_URL;
  if (!value) throw new Error('Run node scripts/test-atomic-proposals.mjs; no database was selected.');
  const u = new URL(value);
  if (u.hostname !== '127.0.0.1' || !/^\/tolra_atomic_[a-f0-9]{16}$/.test(u.pathname) || u.pathname.slice(1) !== process.env.TOLRA_ATOMIC_TEST_DB) throw new Error('Not the new throwaway test database.');
  const c = new pg.Client({ connectionString: value }); await c.connect(); return c;
}
async function transaction(person, fn, flags = {}) {
  const c = await connect();
  try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated');
    await c.query(`SELECT set_config('test.user',$1,true),set_config('test.aal',$2,true),set_config('test.support',$3,true),set_config('test.read_only',$4,true)`, [people[person], flags.aal ?? 'aal2', String(person === 'support'), String(flags.readOnly ?? false)]);
    const out = await fn(c); await c.query('COMMIT'); return out;
  } catch(e) { await c.query('ROLLBACK'); throw e; } finally { await c.end(); }
}
async function snapshot(org) {
  const result = {};
  for (const table of tables) result[table] = (await owner.query(`SELECT * FROM public.${table} WHERE organization_id=$1 ORDER BY ${table === 'costing_defaults' ? 'organization_id' : 'id'}`, [org])).rows;
  return result;
}
async function expected(org) {
  const rows = await snapshot(org);
  return { chase: rows.chase_steps.map(r => ({ id: r.id, days: r.offset_days, tone: r.tone })), costing: {
    materials: rows.costing_materials.map(({organization_id, ...r}) => ({...r,scrap_pct:Number(r.scrap_pct)})), machines: rows.costing_machines.map(({organization_id, ...r}) => r),
    defaults: rows.costing_defaults[0] ? (({organization_id, ...r}) => ({...r,overhead_pct:Number(r.overhead_pct),default_margin_pct:Number(r.default_margin_pct)}))(rows.costing_defaults[0]) : null,
  } };
}
const chase = (c, org, before, value) => c.query('SELECT public.save_chase_steps_atomic($1,$2::jsonb,$3::jsonb)', [org, JSON.stringify(before), JSON.stringify(value)]);
const costing = (c, org, before, value) => c.query('SELECT public.save_costing_settings_atomic($1,$2::jsonb,$3::jsonb)', [org, JSON.stringify(before), JSON.stringify(value)]);
const clone = x => structuredClone(x);
async function unchangedAfter(action, code) {
  const before = await Promise.all(orgs.map(snapshot));
  await assert.rejects(action, { code });
  assert.deepEqual(await Promise.all(orgs.map(snapshot)), before);
}

test('atomic proposal contracts on a new throwaway PostgreSQL', {timeout: 60_000}, async t => {
  owner = await connect();
  try {
    assert.equal((await owner.query('SELECT current_database() AS name')).rows[0].name, process.env.TOLRA_ATOMIC_TEST_DB);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema IN ('public','auth')")).rows[0].n, 0, 'refuse a database that already contains tables');
    await owner.query(read('tests/postgres/atomic-settings-fixture.sql'));
    await owner.query(read('supabase/proposals/builder2_chase_settings_atomic.sql'));
    await owner.query(read('supabase/proposals/builder2_costing_settings_atomic.sql'));
    for (const [role,id] of Object.entries(people)) await owner.query('INSERT INTO public.test_members VALUES ($1,$2,$3)', [id, role === 'beta' ? orgs[1] : orgs[0], ['support','beta'].includes(role) ? 'office' : role]);
    for (const org of orgs) {
      await owner.query("INSERT INTO public.chase_steps(organization_id,offset_days,tone) VALUES ($1,7,'friendly'),($1,14,'firm')",[org]);
      await owner.query("INSERT INTO public.costing_materials(organization_id,name,price_pence,price_unit,scrap_pct) VALUES ($1,'Steel',100,'kg',5)",[org]);
      await owner.query("INSERT INTO public.costing_machines(organization_id,name,hourly_rate_pence,labour_rate_pence) VALUES ($1,'Mill',6000,0)",[org]);
      await owner.query('INSERT INTO public.costing_defaults VALUES ($1,2500,7500,150,20)',[org]);
    }
    for (const who of ['admin','office','beta']) await t.test(`${who} can save only its own company`, async () => {
      const org=who==='beta'?orgs[1]:orgs[0], before=await expected(org), other=orgs.find(o=>o!==org), untouched=await snapshot(other);
      await transaction(who,c=>chase(c,org,before.chase,[{days:7,tone:'firm'}]));
      const value=clone(before.costing);value.machines[0].hourly_rate_pence+=1;
      await transaction(who,c=>costing(c,org,before.costing,value));
      assert.equal((await expected(org)).costing.machines[0].labour_rate_pence,0);
      assert.deepEqual(await snapshot(other),untouched);
    });
    for (const who of ['workshop','viewer','support']) await t.test(`${who} cannot call either save`, async () => {
      const before=await expected(orgs[0]);
      await unchangedAfter(()=>transaction(who,c=>chase(c,orgs[0],before.chase,[])),'42501');
      await unchangedAfter(()=>transaction(who,c=>costing(c,orgs[0],before.costing,before.costing)),'42501');
    });
    await t.test('read-only and insufficient second step cannot save',async()=>{
      const b=await expected(orgs[0]);
      for(const flags of [{readOnly:true},{aal:'aal1'}]) {
        await unchangedAfter(()=>transaction('admin',c=>chase(c,orgs[0],b.chase,[]),flags),'42501');
        await unchangedAfter(()=>transaction('admin',c=>costing(c,orgs[0],b.costing,b.costing),flags),'42501');
      }
    });
    await t.test('explicit wrong company and reused foreign IDs cannot cross companies',async()=>{
      const a=await expected(orgs[0]),b=await expected(orgs[1]);
      await unchangedAfter(()=>transaction('office',c=>chase(c,orgs[1],b.chase,[])),'42501');
      await unchangedAfter(()=>transaction('office',c=>costing(c,orgs[1],b.costing,b.costing)),'42501');
      await unchangedAfter(()=>transaction('office',c=>chase(c,orgs[0],b.chase,[])),'40001');
      for(const key of ['materials','machines']) {
        const value=clone(a.costing);value[key][0].id=b.costing[key][0].id;
        await unchangedAfter(()=>transaction('office',c=>costing(c,orgs[0],a.costing,value)),'42501');
      }
    });
    await t.test('a duplicate ID and fractional pennies fail without deleting anything',async()=>{
      const a=await expected(orgs[0]);const duplicate=clone(a.costing);duplicate.materials.push(clone(duplicate.materials[0]));
      await unchangedAfter(()=>transaction('office',c=>costing(c,orgs[0],a.costing,duplicate)),'22023');
      for(const [key,field] of [['materials','price_pence'],['machines','hourly_rate_pence'],['machines','labour_rate_pence']]) {
        const value=clone(a.costing);value[key][0][field]=1.5;
        await unchangedAfter(()=>transaction('office',c=>costing(c,orgs[0],a.costing,value)),'22P02');
      }
    });
    await t.test('late errors roll back deletes, updates and inserts',async()=>{
      await owner.query(`CREATE FUNCTION public.test_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced late error' USING ERRCODE='23514'; END $$;
        CREATE TRIGGER test_fail_chase BEFORE INSERT ON public.chase_steps FOR EACH ROW EXECUTE FUNCTION public.test_late_failure();
        CREATE TRIGGER test_fail_defaults BEFORE UPDATE ON public.costing_defaults FOR EACH ROW EXECUTE FUNCTION public.test_late_failure();`);
      try {
        const a=await expected(orgs[0]);
        await unchangedAfter(()=>transaction('office',c=>chase(c,orgs[0],a.chase,[{days:99,tone:'final'}])),'23514');
        const value=clone(a.costing);value.materials=[];value.machines[0].hourly_rate_pence+=200;
        await unchangedAfter(()=>transaction('office',c=>costing(c,orgs[0],a.costing,value)),'23514');
      } finally {await owner.query('DROP TRIGGER test_fail_chase ON public.chase_steps; DROP TRIGGER test_fail_defaults ON public.costing_defaults; DROP FUNCTION public.test_late_failure()');}
    });
    for(const kind of ['chase','costing']) await t.test(`${kind}: simultaneous same-snapshot saves have exactly one winner`,async()=>{
      const a=await expected(orgs[0]);let release,locked;const lockReady=new Promise(r=>locked=r),releaseReady=new Promise(r=>release=r);
      const write=(c,n)=>kind==='chase'?chase(c,orgs[0],a.chase,[{days:n,tone:'final'}]):costing(c,orgs[0],a.costing,{...clone(a.costing),defaults:{...a.costing.defaults,labour_rate_pence:n}});
      const first=transaction('office',async c=>{await write(c,31);locked();await releaseReady;});
      first.catch(error=>locked(Promise.reject(error)));
      await lockReady;
      let secondPid;const second=transaction('admin',async c=>{secondPid=(await c.query('select pg_backend_pid() as pid')).rows[0].pid;return write(c,32);});
      // Attach rejection handler immediately, before releasing the first writer.
      const rejected=assert.rejects(second,{code:'40001'});
      try {
        const deadline=Date.now()+5000;let waiting=false;
        while(Date.now()<deadline){if(secondPid)waiting=(await owner.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS v",[secondPid])).rows[0].v;if(waiting)break;await delay(10);}
        assert.equal(waiting,true,'the second connection must wait on the real advisory lock');
        // Another company must not wait behind this company lock.
        const b=await expected(orgs[1]);await transaction('beta',async c=>{await c.query("SET LOCAL statement_timeout='2s'");return kind==='chase'?chase(c,orgs[1],b.chase,[{days:33,tone:'final'}]):costing(c,orgs[1],b.costing,b.costing);});
      } finally {release();await first;await rejected;}
      const saved=await expected(orgs[0]);assert.equal(kind==='chase'?saved.chase[0].days:saved.costing.defaults.labour_rate_pence,31);
    });
    await t.test('rollback removes only the RPCs, keeps both companies settings, and can be repeated',async()=>{
      const before=await Promise.all(orgs.map(snapshot));
      await owner.query(read('supabase/proposals/builder2_atomic_settings.rollback.sql'));
      await owner.query(read('supabase/proposals/builder2_atomic_settings.rollback.sql'));
      assert.deepEqual(await Promise.all(orgs.map(snapshot)),before);
      for(const signature of ['public.save_chase_steps_atomic(uuid,jsonb,jsonb)','public.save_costing_settings_atomic(uuid,jsonb,jsonb)']) assert.equal((await owner.query('select to_regprocedure($1) as f',[signature])).rows[0].f,null);
      await owner.query(read('supabase/proposals/builder2_chase_settings_atomic.sql'));
      await owner.query(read('supabase/proposals/builder2_costing_settings_atomic.sql'));
      assert.deepEqual(await Promise.all(orgs.map(snapshot)),before);
    });
  } finally {await owner.end();}
});
