import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {actor,call,connect,consume,db,exchange,invite,revoke,start,stop,store,storeArgs,storeQuery,type Actor,type Invite} from './fixture';
let a:Actor,i:Invite;
beforeAll(start);afterAll(stop);beforeEach(async()=>{a=await actor();i=await invite(a);});
const connections=async()=>(await db.query('select id from integration_connections where organization_id=$1',[a.org])).rows;
const audits=async()=>(await db.query("select actor_user_id,organization_id,metadata from security_audit.audit_log where organization_id=$1 and action='INTEGRATION_INVITE_REVOKED'",[a.org])).rows;
it('a used invite with pending OAuth remains listed for its creating company and can be cancelled',async()=>{
 expect(await exchange(i)).toMatchObject({ok:true,organization_id:a.org});
 const open=(await call(a,"select integration_invites_open('xero') as r")).rows[0].r;
 expect(open.map((v:{id:string})=>v.id)).toContain(i.id);expect(JSON.stringify(open)).not.toContain(i.ref);
 expect(await revoke(a,i)).toBe(true);expect(await consume(i)).toMatchObject({ok:false,reason:'revoked'});expect(await connections()).toEqual([]);
});
it('revocation after callback consumption but before final store prevents the connection and is audited',async()=>{
 await exchange(i);expect(await consume(i)).toMatchObject({organization_id:a.org,user_id:a.id});
 expect(await revoke(a,i)).toBe(true);expect(await store(a,i)).toMatchObject({ok:false});expect(await connections()).toEqual([]);
 expect(await audits()).toHaveLength(1);expect((await audits())[0]).toMatchObject({organization_id:a.org});
 expect(await revoke(a,i)).toBe(false);expect(await audits()).toHaveLength(1);
});
it('another company cannot cancel a pending invite, and a demoted creator cannot cancel it',async()=>{
 await exchange(i);const b=await actor();expect(await revoke(b,i)).toBe(false);
 await db.query("update organization_members set role='office' where organization_id=$1 and user_id=$2",[a.org,a.id]);
 await expect(revoke(a,i)).rejects.toMatchObject({code:'42501'});expect(await audits()).toEqual([]);
});
it('an already completed consent cannot be cancelled or replayed',async()=>{
 await exchange(i);await consume(i);expect((await store(a,i)).ok).not.toBe(false);expect(await connections()).toHaveLength(1);
 expect(await revoke(a,i)).toBe(false);expect(await audits()).toEqual([]);expect((await store(a,i)).ok).toBe(false);expect(await connections()).toHaveLength(1);
});
it('expired pending OAuth is no longer cancellable as an open invite',async()=>{
 await exchange(i);await db.query("update integration_oauth_states set expires_at=clock_timestamp()-interval '1 second' where state_hash=$1",[i.state]);
 expect(await revoke(a,i)).toBe(false);expect(await audits()).toEqual([]);
});
it('two actual concurrent cancellation transactions yield one success and one audit row',async()=>{
 await exchange(i);const lock=await connect();await lock.query('select id from integration_connect_invites where id=$1 for update',[i.id]);
 const attempts=[revoke(a,i),revoke(a,i)];try{
  await expect.poll(async()=>Number((await db.query("select count(*) as n from pg_stat_activity where wait_event_type='Lock' and query like 'select integration_invite_revoke%' ")).rows[0].n),{timeout:5000}).toBe(2);
  await lock.query('commit');expect((await Promise.all(attempts)).filter(Boolean)).toHaveLength(1);expect(await audits()).toHaveLength(1);
 }finally{await lock.query('rollback').catch(()=>{});await lock.end();await Promise.allSettled(attempts);}
});
it('completion committed while cancellation waits wins: cancellation returns false without revoking the completed invite',async()=>{
 await exchange(i);await consume(i);const final=await connect('service_role');expect((await final.query(storeQuery,storeArgs(a,i))).rows[0].r.ok).not.toBe(false);
 const attempt=revoke(a,i);try{
  await expect.poll(async()=>Number((await db.query("select count(*) as n from pg_stat_activity where wait_event_type='Lock' and query like 'select integration_invite_revoke%' ")).rows[0].n),{timeout:5000}).toBe(1);
  await final.query('commit');expect(await attempt).toBe(false);expect(await audits()).toEqual([]);expect(await connections()).toHaveLength(1);
 }finally{await final.query('rollback').catch(()=>{});await final.end();await Promise.allSettled([attempt]);}
});
