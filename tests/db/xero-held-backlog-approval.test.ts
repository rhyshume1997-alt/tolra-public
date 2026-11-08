/** Real PostgreSQL regression. Run after Opus installs 149 on a disposable backend; never alters a migration. */
import {randomBytes,randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {beforeAll,expect,it} from 'vitest';
import {verifyBackendIdentity,withDb} from '../support/fixtures';
const encrypted=()=>`v1.${randomBytes(12).toString('base64url')}.${randomBytes(16).toString('base64url')}.${randomBytes(48).toString('base64url')}`;
beforeAll(async()=>{await verifyBackendIdentity();});
async function fixture(db:Client){
 const org=randomUUID(),admin=randomUUID(),session=randomUUID(),email=`${admin}@example.test`;
 await db.query("insert into organizations(id,name,slug,status) values($1,'Synthetic backlog',$2,'active')",[org,`t-backlog-${org}`]);
 await db.query('insert into auth.users(id,email) values($1,$2)',[admin,email]);
 await db.query("insert into user_profiles(id,email,full_name,role,organization_id,active,must_change_password) values($1,$2,'Synthetic','admin',$3,true,false)",[admin,email,org]);
 await db.query("insert into organization_members(user_id,organization_id,role,active) values($1,$2,'admin',true)",[admin,org]);
 await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,admin]);
 await db.query('insert into security_audit.session_company(session_id,user_id,organization_id) values($1,$2,$3)',[session,admin,org]);
 const user=async(sql:string,args:unknown[]=[])=>{
  await db.query('set local role authenticated');
  await db.query("select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)",[JSON.stringify({sub:admin,session_id:session,role:'authenticated',aal:'aal2',email,amr:[{method:'totp',timestamp:Math.floor(Date.now()/1000)}]}),admin]);
  const result=await db.query(sql,args);await db.query('reset role');return result;
 };
 const service=async(sql:string,args:unknown[]=[])=>{await db.query('set local role service_role');const result=await db.query(sql,args);await db.query('reset role');return result;};
 const state=randomBytes(32).toString('hex');
 await user("select integration_oauth_begin('xero',$1,$2)",[state,encrypted()]);
 await service("select integration_oauth_consume($1,$2,'xero',$3)",[org,admin,state]);
 await service("select integration_store_connection($1,$2,'xero',$3,'Synthetic Xero',$4,$5,$6,now()+interval '30 minutes',1)",[org,admin,`tenant-${org}`,randomUUID(),encrypted(),encrypted()]);
 for(const sql of ["select integration_set_mapping('xero','sales_account',null,'200','Sales')","select integration_set_mapping('xero','credit_account',null,'200','Sales')","select integration_set_mapping('xero','tax_rate','20','OUTPUT2','VAT 20')"])await user(sql);
 expect((await user('select integration_xero_launch_status() as s')).rows[0].s).toMatchObject({enabled:false,connected:true,mapped:true});
 return {org,user,service};
}
async function inTransaction(fn:(db:Client)=>Promise<void>){await withDb(async db=>{await db.query('begin');try{await fn(db);}finally{await db.query('rollback');}});}
async function heldDocument(db:Client,org:string){return (await db.query("insert into integration_sends(organization_id,provider,doc_type,doc_id,doc_ref,action) values($1,'xero','invoice',$2,$3,'create') returning id",[org,randomUUID(),`SYN-${randomUUID()}`])).rows[0].id as string;}
async function activateWithoutBacklogApproval(db:Client,user:Awaited<ReturnType<typeof fixture>>['user']){
 await db.query('savepoint activation');
 try{await user('select integration_xero_set_transfers(true)');return true;}
 catch(e){
  await db.query('rollback to savepoint activation');
  const error=e as {code?:string;message:string};
  expect(error.code,'refusal must be the backlog decision, not a broken fixture or auth failure').toBe('55000');
  expect(error.message).toMatch(/backlog|held|approval|review/i);
  return false;
 }
}
it('first activation cannot release a held queued document without an admin approving the backlog',()=>inTransaction(async db=>{
 const co=await fixture(db),id=await heldDocument(db,co.org);
 if(await activateWithoutBacklogApproval(db,co.user)){
  const claim=(await co.service("select integration_claim_next($1,'xero',120) as r",[co.org])).rows[0].r;
  expect(claim.send?.id,'turning On is not approval of an existing held document').not.toBe(id);
 }
 const row=(await db.query('select status,attempts from integration_sends where id=$1',[id])).rows[0];expect(['pending','needs_check']).toContain(row.status);expect(row.attempts).toBe(0);
}));
it('switching OFF then ON cannot automatically release documents queued during the hold',()=>inTransaction(async db=>{
 const co=await fixture(db);
 await co.user('select integration_xero_set_transfers(true)');
 await co.user('select integration_xero_set_transfers(false)');
 const id=await heldDocument(db,co.org);
 if(await activateWithoutBacklogApproval(db,co.user)){
  const claim=(await co.service("select integration_claim_next($1,'xero',120) as r",[co.org])).rows[0].r;
  expect(claim.send?.id,'re-enabling is not approval of documents created while OFF').not.toBe(id);
 }
 expect((await db.query('select attempts from integration_sends where id=$1',[id])).rows[0].attempts).toBe(0);
}));
