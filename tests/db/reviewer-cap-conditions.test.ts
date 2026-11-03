import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {verifyBackendIdentity,withDb} from '../support/fixtures';
it('SQL caps target one company and authenticated callers cannot read or raise either company cap',async()=>{
 await verifyBackendIdentity();await withDb(async db=>{await db.query('BEGIN');try{
  const A=randomUUID(),B=randomUUID(),owner=randomUUID();
  for(const org of [A,B])await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,'Synthetic cap',$2,'active')",[org,`t-cap-${org}`]);
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)",[owner,`${owner}@example.test`]);
  await db.query('INSERT INTO security_audit.platform_admins(user_id) VALUES($1)',[owner]);
  await db.query('SELECT public.ai_helper_tolra_set_cap($1,1500,$2)',[A,owner]);
  const rows=async()=>(await db.query('SELECT * FROM public.ai_helper_tolra_caps() WHERE organization_id IN ($1,$2) ORDER BY organization_id',[A,B])).rows;
  const before=await rows();expect(before.find(r=>r.organization_id===A).monthly_cap_pence).toBe(1500);expect(before.find(r=>r.organization_id===B).monthly_cap_pence).toBe(1000);
  await db.query('SET LOCAL ROLE authenticated');
  for(const org of [A,B]){
   await db.query('SAVEPOINT forbidden');
   await expect(db.query('SELECT public.ai_helper_tolra_set_cap($1,99999,$2)',[org,owner])).rejects.toMatchObject({code:'42501'});
   await db.query('ROLLBACK TO SAVEPOINT forbidden');
  }
  await db.query('SAVEPOINT forbidden_read');await expect(db.query('SELECT * FROM public.ai_helper_tolra_caps()')).rejects.toMatchObject({code:'42501'});await db.query('ROLLBACK TO SAVEPOINT forbidden_read');
  await db.query('RESET ROLE');expect(await rows()).toEqual(before);
 }finally{await db.query('ROLLBACK');}});
},120000);
