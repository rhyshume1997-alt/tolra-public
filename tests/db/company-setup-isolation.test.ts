import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { preparePost144Backend } from "../support/post-144-release-fixture";
// Requires the reviewed proposal on an isolated backend. The verified test fixture prepares releases 145/146 after the baseline.
import { beforeAll, afterAll, expect, it } from "vitest";
import { adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb, type SyntheticWorld } from "../support/fixtures";
let world: SyntheticWorld;
beforeAll(async () => { await verifyBackendIdentity(); await preparePost144Backend(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });
it("a new company cannot read another company's setup ticks or customers, or write its progress", async () => {
  const a = await signedInClient(world.tenants.alpha.users.admin);
  const b = await signedInClient(world.tenants.beta.users.admin);
  const beta = world.tenants.beta.id;
  expect((await b.from("company_setup_progress").upsert({ organization_id: beta, step: "company", completed: true })).error).toBeNull();
  expect((await adminClient().from("customers").insert({ organization_id: beta, name: "Private beta customer" })).error).toBeNull();
  const progress = await a.from("company_setup_progress").select("*").eq("organization_id", beta);
  expect(progress.error).toBeNull(); expect(progress.data).toEqual([]);
  const customers = await a.from("customers").select("*").eq("organization_id", beta);
  expect(customers.error).toBeNull(); expect(customers.data).toEqual([]);
  expect((await a.from("company_setup_progress").upsert({ organization_id: beta, step: "people", completed: true })).error).not.toBeNull();
});

it('two companies enforce setup admin, staff and support permissions in PostgreSQL',async()=>{
 await verifyBackendIdentity();
 await withDb(async db=>{
  await db.query('BEGIN');
  try {
   const orgs=[randomUUID(),randomUUID()];
   for(const org of orgs)await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,'Synthetic setup',$2,'active')",[org,`t-setup-${org}`]);
   const actors=[];
   for(const [role,index,support] of [['admin',0,false],['admin',1,false],['office',0,false],['workshop',0,false],['viewer',0,false],['admin',0,true],['admin',0,'elevated']] as const){
    const id=randomUUID(),session=randomUUID(),grant=support?randomUUID():null,org=orgs[index],email=`${id}@example.test`;
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id,email]);
    await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)",[id,email,role,org]);
    await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active,support,expires_at,support_grant) VALUES($1,$2,$3,true,$4,CASE WHEN $4 THEN now()+interval '1 hour' END,$5)",[id,org,role,Boolean(support),grant]);
    if(support)await db.query('INSERT INTO security_audit.platform_admins(user_id) VALUES($1)',[id]);
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)',[session,id]);
    await db.query('INSERT INTO security_audit.session_company(session_id,user_id,organization_id,grant_id) VALUES($1,$2,$3,$4)',[session,id,org,grant]);
    if(support==='elevated')await db.query("UPDATE security_audit.session_company SET elevated_until=now()+interval '30 minutes' WHERE session_id=$1",[session]);
    actors.push({id,session,org,email,role,support});
   }
   for(const org of orgs)await db.query("INSERT INTO public.company_setup_progress(organization_id,step,completed) VALUES($1,'company',true)",[org]);
   for(const actor of actors){
    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",[JSON.stringify({sub:actor.id,session_id:actor.session,role:'authenticated',aal:'aal2',email:actor.email}),actor.id]);
    const sessionInfo=(await db.query('SELECT public.my_session() AS s')).rows[0].s;
    expect(sessionInfo).toMatchObject({organization_id:actor.org,role:actor.role,support:Boolean(actor.support)});
    if(actor.support)expect(sessionInfo.read_only).toBe(actor.support!=='elevated');
    const rows=(await db.query('SELECT organization_id FROM public.company_setup_progress')).rows;
    expect(rows.map(r=>r.organization_id)).toEqual(actor.role==='admin'&&!actor.support?[actor.org]:[]);
    const foreign=orgs.find(org=>org!==actor.org)!;
    await db.query('SAVEPOINT foreign_update');
    if(actor.support===true){await expect(db.query('UPDATE public.company_setup_progress SET completed=false WHERE organization_id=$1',[foreign])).rejects.toMatchObject({code:'42501'});await db.query('ROLLBACK TO SAVEPOINT foreign_update');}
    else expect((await db.query('UPDATE public.company_setup_progress SET completed=false WHERE organization_id=$1',[foreign])).rowCount).toBe(0);
    await db.query('SAVEPOINT denied');
    if(actor.role==='admin'&&!actor.support){
     expect((await db.query("UPDATE public.company_setup_progress SET completed=false WHERE organization_id=$1",[actor.org])).rowCount).toBe(1);
     expect((await db.query("INSERT INTO public.company_setup_progress(organization_id,step,completed) VALUES($1,'people',true)",[actor.org])).rowCount).toBe(1);
    }else{
     if(actor.support!==true)expect((await db.query('UPDATE public.company_setup_progress SET completed=false WHERE organization_id=$1',[actor.org])).rowCount).toBe(0);
     await expect(db.query("INSERT INTO public.company_setup_progress(organization_id,step,completed) VALUES($1,'people',true)",[actor.org])).rejects.toMatchObject({code:'42501'});
     await db.query('ROLLBACK TO SAVEPOINT denied');
    }
    await db.query('SAVEPOINT foreign_write');
    await expect(db.query("INSERT INTO public.company_setup_progress(organization_id,step,completed) VALUES($1,'import',true)",[foreign])).rejects.toMatchObject({code:'42501'});
    await db.query('ROLLBACK TO SAVEPOINT foreign_write');
    await db.query('RESET ROLE');
   }
   const outsider=randomUUID(),outsiderEmail=`${outsider}@example.test`;
   await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[outsider,outsiderEmail]);
   await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",[JSON.stringify({sub:outsider,role:'authenticated',aal:'aal2',session_id:randomUUID()}),outsider]);
   for(const role of ['authenticated','anon']){
    await db.query('SET LOCAL ROLE '+role);
    await db.query('SAVEPOINT outsider_read');
    if(role==='anon'){await expect(db.query('SELECT * FROM public.company_setup_progress')).rejects.toMatchObject({code:'42501'});await db.query('ROLLBACK TO SAVEPOINT outsider_read');}
    else expect((await db.query('SELECT * FROM public.company_setup_progress')).rows).toEqual([]);
    await db.query('SAVEPOINT outsider_write');
    await expect(db.query("INSERT INTO public.company_setup_progress(organization_id,step) VALUES($1,'import')",[orgs[0]])).rejects.toMatchObject({code:'42501'});
    await db.query('ROLLBACK TO SAVEPOINT outsider_write');await db.query('RESET ROLE');
   }
  } finally {await db.query('ROLLBACK');}
 });
},120000);

it("release 145 refuses a second install without changing setup data or policies", async () => {
 await withDb(async db => {
  await db.query("BEGIN");
  try {
   const before = await db.query("SELECT policyname,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='company_setup_progress' ORDER BY policyname");
   const rows = await db.query("SELECT * FROM public.company_setup_progress ORDER BY organization_id,step");
   // Run the real release body inside our rolled-back outer transaction, not its COMMIT.
   const sql = readFileSync(path.resolve(__dirname,"../../supabase/release/145_company_setup.release.sql"),"utf8").replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
   await db.query("SAVEPOINT second_install");
   await expect(db.query(sql)).rejects.toMatchObject({code:"42P07"});
   await db.query("ROLLBACK TO SAVEPOINT second_install");
   expect((await db.query("SELECT policyname,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='company_setup_progress' ORDER BY policyname")).rows).toEqual(before.rows);
   expect((await db.query("SELECT * FROM public.company_setup_progress ORDER BY organization_id,step")).rows).toEqual(rows.rows);
  } finally { await db.query("ROLLBACK"); }
 });
});
