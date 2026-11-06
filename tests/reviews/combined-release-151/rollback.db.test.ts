/** Synthetic loopback PostgreSQL only. Never run rollback checks against a deployed database. */
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {actor,db,exchange,invite,revoke,start,stop} from '../review437/fixture';
beforeAll(start);afterAll(stop);
const read=(f:string)=>readFileSync(f,'utf8');
const rollback=(n:number,name:string)=>read(`supabase/release/${n}_${name}.rollback.sql`);
const release=(n:number,name:string)=>read(`supabase/release/${n}_${name}.release.sql`);
const verify=async(file:string)=>{const rows=(await db.query(read(file))).rows;expect(rows.length).toBeGreaterThan(0);expect(rows.filter(r=>(r.ok??r.passed)!==true)).toEqual([]);};
it('151 rollback refuses a used invite with pending OAuth, then permits rollback after its admin cancels it',async()=>{
 const a=await actor(),i=await invite(a);await exchange(i);
 await expect(db.query(rollback(151,'xero_invite_hardening'))).rejects.toThrow(/open connect invites/);await db.query('rollback');
 expect((await db.query('select count(*)::int as n from integration_oauth_states where via_invite=$1',[i.id])).rows[0].n).toBe(1);
 expect(await revoke(a,i)).toBe(true);
 const audit=(await db.query('select to_jsonb(a) as row from security_audit.audit_log a order by id')).rows;
 await db.query(rollback(151,'xero_invite_hardening'));
 expect((await db.query('select to_jsonb(a) as row from security_audit.audit_log a order by id')).rows).toEqual(audit);
 expect((await db.query("select to_regprocedure('public.integration_xero_picker_claim(text,text,integer,integer)') as f")).rows[0].f).toBeNull();
 await db.query(release(151,'xero_invite_hardening'));await verify('supabase/verify/xero_invite_hardening_151.sql');
});
it('reverse151/150/149 retains 143 rates and existing cost snapshot rows; 149 refuses to release held documents without its explicit disposable-only override',async()=>{
 const a=await actor();await db.query("insert into integration_connections(organization_id,provider,status,tenant_id,tenant_name) values($1,'xero','connected','synthetic-rollback','Synthetic')",[a.org]);
 await db.query("insert into integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) values($1,'xero','invoice',gen_random_uuid(),'SYN-ROLLBACK','create')",[a.org]);
 const figures=async()=>{const result:Record<string,unknown>={};for(const table of ['costing_defaults','costing_machines','costing_materials','job_cost_snapshots'])result[table]=(await db.query(`select to_jsonb(x) as row from public.${table} x order by to_jsonb(x)::text`)).rows;return result;};
 const before=await figures();
 await db.query(rollback(151,'xero_invite_hardening'));await db.query(rollback(150,'ai_cap_key_off'));
 await expect(db.query(rollback(149,'xero_launch_hold'))).rejects.toThrow(/rollback refused/);await db.query('rollback');
 // This is a disposable database with no worker, network sender, provider key or production connection.
 await db.query("set tolra.x149_accept_old_sending='yes'");await db.query(rollback(149,'xero_launch_hold'));await db.query('reset tolra.x149_accept_old_sending');expect(await figures()).toEqual(before);
 for(const [n,name,file] of [[149,'xero_launch_hold','xero_launch_hold_149'],[150,'ai_cap_key_off','ai_cap_key_off_150'],[151,'xero_invite_hardening','xero_invite_hardening_151']] as const){await db.query(release(n,name));await verify(`supabase/verify/${file}.sql`);}
 expect(await figures()).toEqual(before);
 expect((await db.query('select integration_xero_transfer_enabled($1) as on',[a.org])).rows[0].on).toBe(false);
 expect((await db.query('select integration_xero_send_released(organization_id,id) as released from integration_sends where organization_id=$1',[a.org])).rows.map(r=>r.released)).toEqual([false]);
});
it('151 release cannot be applied a second time and the verifier still passes after transaction rollback',async()=>{
 await expect(db.query(release(151,'xero_invite_hardening'))).rejects.toThrow();await db.query('rollback');await verify('supabase/verify/xero_invite_hardening_151.sql');
});
