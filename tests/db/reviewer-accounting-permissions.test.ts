// Requires separately reviewed setup schema. Never installs SQL; no skips.
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { verifyBackendIdentity,withDb } from '../support/fixtures';
it('two companies enforce accounting admin, staff and support permissions in PostgreSQL',async()=>{
 await verifyBackendIdentity();
 await withDb(async db=>{
  await db.query('BEGIN');
  try {
   const orgs=[randomUUID(),randomUUID()];
   for(const org of orgs)await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,'Synthetic setup',$2,'active')",[org,`t-setup-${org}`]);
   const actors=[];
   for(const [role,index,support] of [['admin',0,false],['admin',1,false],['office',0,false],['workshop',0,false],['viewer',0,false],['admin',0,true]] as const){
    const id=randomUUID(),session=randomUUID(),grant=support?randomUUID():null,org=orgs[index],email=`${id}@example.test`;
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id,email]);
    await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)",[id,email,role,org]);
    await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active,support,expires_at,support_grant) VALUES($1,$2,$3,true,$4,CASE WHEN $4 THEN now()+interval '1 hour' END,$5)",[id,org,role,support,grant]);
    if(support)await db.query('INSERT INTO security_audit.platform_admins(user_id) VALUES($1)',[id]);
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)',[session,id]);
    await db.query('INSERT INTO security_audit.session_company(session_id,user_id,organization_id,grant_id) VALUES($1,$2,$3,$4)',[session,id,org,grant]);
    actors.push({id,session,org,email,role,support});
   }
   for(const org of orgs)for(const provider of ['sage','quickbooks'])await db.query("INSERT INTO public.integration_connections(organization_id,provider,status,tenant_id) VALUES($1,$2,'connected',$3)",[org,provider,`${provider}-${org}`]);
   for(const actor of actors){
    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",[JSON.stringify({sub:actor.id,session_id:actor.session,role:'authenticated',aal:'aal2',email:actor.email}),actor.id]);
    const rows=(await db.query("SELECT organization_id FROM public.integration_connections WHERE provider IN ('sage','quickbooks') ORDER BY provider")).rows;
    expect(rows.map(r=>r.organization_id)).toEqual(actor.role==='admin'?[actor.org,actor.org]:[]);
    await db.query('SAVEPOINT secret_read');await expect(db.query('SELECT * FROM public.integration_secrets')).rejects.toMatchObject({code:'42501'});await db.query('ROLLBACK TO SAVEPOINT secret_read');
    for(const provider of ['sage','quickbooks']){
     await db.query('SAVEPOINT oauth');
     const params=[provider,randomUUID().replaceAll('-','').repeat(2),'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc'];
     if(actor.role==='admin'&&!actor.support)expect((await db.query('SELECT public.integration_oauth_start($1,$2,$3)',params)).rowCount).toBe(1);
     else {await expect(db.query('SELECT public.integration_oauth_start($1,$2,$3)',params)).rejects.toMatchObject({code:'42501'});await db.query('ROLLBACK TO SAVEPOINT oauth');}
    }
    await db.query('RESET ROLE');
   }
  } finally {await db.query('ROLLBACK');}
 });
},120000);
