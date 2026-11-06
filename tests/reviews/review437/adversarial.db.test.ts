/** Independent SQL review of published #4376d147b9. No provider HTTP; no helper implementation copied or replaced. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {actor,call,cipher,connect,consume,db,exchange,invite,start,stop,store,storeArgs,storeQuery,type Actor,type Invite} from './fixture';
let a:Actor,i:Invite;const observations:unknown[]=[];
beforeAll(start);afterAll(async()=>{mkdirSync('tests/reviews/review437/evidence',{recursive:true});writeFileSync('tests/reviews/review437/evidence/observations.json',JSON.stringify(observations,null,2)+'\n');await stop();});
beforeEach(async()=>{a=await actor();i=await invite(a);});
const connected=async()=>(await db.query('select status,tenant_id,tenant_name from integration_connections where organization_id=$1',[a.org])).rows;
const signatures=[
 ['public.integration_invite_store_connection(text,uuid,uuid,text,text,text,text,text,text,timestamptz,integer)','search_path=pg_catalog, public, security_audit'],
 ['public.integration_xero_picker_claim(text,text,integer,integer)','search_path=pg_catalog, public'],
] as const;
it.each(signatures)('%s is an owned service-only definer with its exact path',async(sig,search)=>{
 const r=(await db.query(`select p.prosecdef,p.proconfig,r.rolname,has_function_privilege('service_role',p.oid,'execute') as service,
 has_function_privilege('authenticated',p.oid,'execute') as authenticated,has_function_privilege('anon',p.oid,'execute') as anon,
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0) as public
 from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=to_regprocedure($1)`,[sig])).rows[0];
 expect(r).toMatchObject({prosecdef:true,proconfig:[search],rolname:'xero_test',service:true,authenticated:false,anon:false,public:false});
});
it('valid consumed state stores once, keeps transfers OFF and leaves every held document unchanged',async()=>{
 await exchange(i);await consume(i);await db.query("insert into integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) values($1,'xero','invoice',gen_random_uuid(),'SYN-REVIEW437-HELD','create')",[a.org]);
 const queue=async()=>(await db.query('select to_jsonb(s) as row from integration_sends s where organization_id=$1',[a.org])).rows;const before=await queue();
 expect((await store(a,i)).ok).not.toBe(false);expect(await connected()).toHaveLength(1);
 expect((await db.query('select integration_xero_transfer_enabled($1) as on',[a.org])).rows[0].on).toBe(false);expect(await queue()).toEqual(before);
 expect((await store(a,i)).ok).toBe(false);expect(await connected()).toHaveLength(1);expect(await queue()).toEqual(before);
});
it('a state cannot be rebound to a different company or creating admin',async()=>{
 await exchange(i);await consume(i);const b=await actor();expect((await store(b,i)).ok).toBe(false);expect(await connected()).toEqual([]);
 const args=storeArgs(a,i);args[2]=b.id;expect((await call('service',storeQuery,args)).rows[0].r.ok).toBe(false);expect(await connected()).toEqual([]);
});
it('two real final-write transactions cannot complete one state twice',async()=>{
 await exchange(i);await consume(i);const results=await Promise.all([store(a,i),store(a,i)]);expect(results.filter(r=>r.ok!==false)).toHaveLength(1);expect(await connected()).toHaveLength(1);
});
it('INV-03 observation: current6d147b9 stores a differing trading name; policy approval is not inferred',async()=>{
 await exchange(i);await consume(i);const args=storeArgs(a,i);args[5]='Different Synthetic Trading Name';expect((await call('service',storeQuery,args)).rows[0].r.ok).not.toBe(false);
 expect((await connected())[0]).toMatchObject({tenant_id:args[4],tenant_name:args[5]});
});
it('an invite expired before final storage refuses and records a correlation',async()=>{
 await exchange(i);await consume(i);await db.query("update integration_connect_invites set created_at=now()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' where id=$1",[i.id]);
 const r=await store(a,i);expect(r.ok).toBe(false);expect(r.correlation_id).toMatch(/^[0-9a-f-]{36}$/);expect(await connected()).toEqual([]);
});
async function wait(queryPrefix:string){await expect.poll(async()=>Number((await db.query("select count(*) as n from pg_stat_activity where wait_event_type='Lock' and query like $1",[queryPrefix+'%'])).rows[0].n),{timeout:5000}).toBe(1);}
it('expiry while the final store waits on the invite lock is rechecked using wall time',async()=>{
 await exchange(i);await consume(i);const lock=await connect();await lock.query("update integration_connect_invites set expires_at=clock_timestamp()+interval '1 second' where id=$1",[i.id]);
 const pending=store(a,i);try{await wait('select integration_invite_store_connection');await db.query('select pg_sleep(1.1)');await lock.query('commit');expect((await pending).ok).toBe(false);expect(await connected()).toEqual([]);
 }finally{await lock.query('rollback').catch(()=>{});await lock.end();await Promise.allSettled([pending]);}
});
async function connectionLock(){await db.query("insert into integration_connections(organization_id,provider,status,tenant_id,tenant_name) values($1,'xero','disconnected',gen_random_uuid()::text,'Prior synthetic connection')",[a.org]);const lock=await connect();await lock.query('select id from integration_connections where organization_id=$1 for update',[a.org]);return lock;}
it('expiry while the ordinary store waits on a connection lock must roll back the final connection',async()=>{
 await exchange(i);await consume(i);const lock=await connectionLock();await db.query("update integration_connect_invites set expires_at=clock_timestamp()+interval '3 seconds' where id=$1",[i.id]);const pending=store(a,i);
 try{await wait('select integration_invite_store_connection');await db.query('select pg_sleep(3.1)');await lock.query('commit');const result=await pending;const rows=await connected();
  observations.push({test:'expiry-during-inner-store-lock',result,connections:rows,sqlstate:'00000'});
  expect(rows[0]?.status,'a connection must not be committed after invite expiry during a later store lock wait').toBe('disconnected');expect(result.ok).toBe(false);
 }finally{await lock.query('rollback').catch(()=>{});await lock.end();await Promise.allSettled([pending]);}
});
it('creator demotion during the ordinary store lock wait must prevent connection storage',async()=>{
 await exchange(i);await consume(i);const lock=await connectionLock();const pending=store(a,i);
 try{await wait('select integration_invite_store_connection');await db.query("update organization_members set role='office' where organization_id=$1 and user_id=$2",[a.org,a.id]);await lock.query('commit');const result=await pending;const rows=await connected();
  observations.push({test:'demotion-during-inner-store-lock',result,connections:rows,sqlstate:'00000'});expect(rows[0]?.status).toBe('disconnected');
 }finally{await lock.query('rollback').catch(()=>{});await lock.end();await Promise.allSettled([pending]);}
});
it('preexisting151 gap: OTP exchange must refuse an invite expiring while it waits for its row lock',async()=>{
 await call('service','select integration_invite_code_issue($1,$2)',[i.ref,'a'.repeat(64)]);const lock=await connect();await lock.query("update integration_connect_invites set expires_at=clock_timestamp()+interval '1 second' where id=$1",[i.id]);
 const pending=call('service','select integration_invite_code_verify($1,$2,$3,$4) as r',[i.ref,'a'.repeat(64),i.state,cipher()]);
 try{await wait('select integration_invite_code_verify');await db.query('select pg_sleep(1.1)');await lock.query('commit');const r=(await pending).rows[0].r;observations.push({test:'exchange-expiry-lock',result:r,sqlstate:'00000'});expect(r.ok).toBe(false);
 }finally{await lock.query('rollback').catch(()=>{});await lock.end();await Promise.allSettled([pending]);}
});
it('preexisting151 gap: callback consumption must refuse state expiry while it waits for a state lock',async()=>{
 await exchange(i);const lock=await connect();await lock.query("update integration_oauth_states set expires_at=clock_timestamp()+interval '1 second' where state_hash=$1",[i.state]);const pending=consume(i);
 try{await wait("select integration_oauth_consume_invite");await db.query('select pg_sleep(1.1)');await lock.query('commit');const r=await pending;observations.push({test:'consume-expiry-lock',result:r,sqlstate:'00000'});expect(r?.organization_id??null).toBeNull();
 }finally{await lock.query('rollback').catch(()=>{});await lock.end();await Promise.allSettled([pending]);}
});
it.each(signatures)('151 verifier must reject a temp-first path on new helper %s',async sig=>{
 await db.query('begin');try{await db.query(`alter function ${sig} set search_path=pg_temp,public`);const rows=(await db.query(readFileSync('supabase/verify/xero_invite_hardening_151.sql','utf8'))).rows;expect(rows.some(r=>r.ok!==true)).toBe(true);}finally{await db.query('rollback');}
});
it.each(signatures)('the eleven-function preflight marker must reject a temp-first path on %s',async sig=>{
 await db.query('begin');try{await db.query(`alter function ${sig} set search_path=pg_temp,public`);const row=(await db.query(readFileSync('supabase/verify/release_preflight.sql','utf8'))).rows.find(r=>r.check==='post-144 marker 151 xero_invite_hardening');expect(row.value).toBe('not applied');}finally{await db.query('rollback');}
});
