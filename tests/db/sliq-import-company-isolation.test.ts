/** Real SQL on identity-verified disposable data only. Post-baseline, before 145/146. */
import {randomUUID} from 'node:crypto';
import {beforeAll,expect,it} from 'vitest';
import type {Client} from 'pg';
import {withDb} from '../support/fixtures';
import {prepareSliqCutoverBackend} from '../support/sliq-cutover-release-fixture';
beforeAll(prepareSliqCutoverBackend);
async function denied(db:Client,sql:string,args:unknown[],code:string){await db.query('SAVEPOINT refused');await expect(db.query(sql,args)).rejects.toMatchObject({code});await db.query('ROLLBACK TO SAVEPOINT refused');}
it('140/141 isolate two companies, preserve source references, and refuse API writes and cross-company WIP links',async()=>{
 await withDb(async db=>{await db.query('BEGIN');try{
  const orgs=[randomUUID(),randomUUID()],invoices:string[]=[],jobs:string[]=[],actors=[];
  for(const org of orgs){
   await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,'Synthetic cutover',$2,'active')",[org,`t-ca-${org}`]);
   const invoice=randomUUID(),job=randomUUID();invoices.push(invoice);jobs.push(job);
   await db.query("INSERT INTO public.invoices(id,organization_id,invoice_ref,customer,status,total,source_ref) VALUES($1,$2,'INV-SAME','Synthetic','draft',123.45,'SLIQ-SAME')",[invoice,org]);
   await db.query("INSERT INTO public.jobs(id,organization_id,job_no,customer,source_ref) VALUES($1,$2,'J-SAME','Synthetic','SLIQ-JOB')",[job,org]);
   await db.query("INSERT INTO public.opening_wip(organization_id,job_id,source_key,value) VALUES($1,$2,'SAME',123.45)",[org,job]);
   for(const role of ['admin','office','workshop','viewer']){
    const user=randomUUID(),session=randomUUID(),email=`${user}@example.test`;
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[user,email]);
    await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)",[user,email,role,org]);
    await db.query('INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,true)',[user,org,role]);
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)',[session,user]);await db.query('INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)',[session,user,org]);actors.push({user,session,email,role,org});
   }
  }
  for(const actor of actors){
   await db.query('SET LOCAL ROLE authenticated');await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",[JSON.stringify({sub:actor.user,session_id:actor.session,email:actor.email,role:'authenticated',aal:'aal2'}),actor.user]);
   const rows=(await db.query('SELECT organization_id,value::text FROM public.opening_wip')).rows;
   expect(rows).toEqual(['admin','office'].includes(actor.role)?[{organization_id:actor.org,value:'123.45'}]:[]);
   await denied(db,"INSERT INTO public.opening_wip(organization_id,source_key) VALUES($1,'FORBIDDEN')",[actor.org],'42501');
   if(['admin','office'].includes(actor.role))await denied(db,"UPDATE public.invoices SET source_ref='CHANGED' WHERE organization_id=$1",[actor.org],'42501');
   await db.query('RESET ROLE');
  }
  await denied(db,"INSERT INTO public.opening_wip(organization_id,job_id,source_key) VALUES($1,$2,'FOREIGN')",[orgs[0],jobs[1]],'23514');
  expect((await db.query('SELECT source_ref FROM public.invoices WHERE id=ANY($1::uuid[])',[invoices])).rows).toEqual([{source_ref:'SLIQ-SAME'},{source_ref:'SLIQ-SAME'}]);
  expect((await db.query('SELECT count(*)::int AS n FROM public.opening_wip WHERE organization_id=ANY($1::uuid[])',[orgs])).rows[0].n).toBe(2);
 }finally{await db.query('ROLLBACK');}});
},120000);
