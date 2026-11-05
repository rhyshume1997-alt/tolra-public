import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll,afterAll,expect,it } from 'vitest';
import { Disposable } from './disposable';
const db=new Disposable(),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',U='33333333-3333-4333-8333-333333333333',V='44444444-4444-4444-8444-444444444444',O='55555555-5555-4555-8555-555555555555';
const source=(p:string)=>execFileSync('git',['show',`9d7725e7e1b59e68a314c4148513b9b7d7aa4e92:${p}`],{encoding:'utf8',maxBuffer:8*1024*1024});
const auth=(sql:string,user=U)=>`BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated","aal":"aal2"}',true);${sql};COMMIT;`;
const svc=(sql:string)=>`BEGIN;SET LOCAL ROLE service_role;${sql};COMMIT;`;
const setCap=(org:string,n:number)=>db.ok(svc(`SELECT ai_helper_tolra_set_cap('${org}',${n},'${O}')`));
const request=(user=U)=>auth("SELECT ai_helper_reserve('roundup',100,repeat('a',64),12)::text",user);
const answer=(s:string)=>JSON.parse(s.split('\n').find(s=>s.startsWith('{"ok"'))!);
const total=(org:string)=>Number(db.ok(`SELECT coalesce(sum(spent_pence+reserved_pence),0) FROM ai_helper_usage WHERE organization_id='${org}' AND month=date_trunc('month',now() AT TIME ZONE 'Europe/London')::date`));
beforeAll(async()=>{
 await db.start();console.log(`G31 evidence: ${db.evidence}`);db.ok(readFileSync('tests/reviews/g31/bootstrap.sql','utf8'));
 const files=execFileSync('git',['ls-tree','--name-only','9d7725e:supabase/migrations'],{encoding:'utf8'}).trim().split('\n').filter(s=>/^\d{3}_.*\.sql$/.test(s)).sort();
 for(const f of files)db.ok(source('supabase/migrations/'+f));
 for(const f of ['145_company_setup','146_tolra_provided_ai','147_job_delivery_note'])db.ok(source(`supabase/release/${f}.release.sql`));
 db.ok(`INSERT INTO organizations(id,name,slug) VALUES('${A}','Synthetic A','t-g31-a'),('${B}','Synthetic B','t-g31-b');
 INSERT INTO auth.users(id,email) VALUES('${U}','a@example.test'),('${V}','b@example.test'),('${O}','owner@example.test');
 INSERT INTO user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES('${U}','a@example.test','Synthetic A','admin','${A}',true,false),('${V}','b@example.test','Synthetic B','admin','${B}',true,false),('${O}','owner@example.test','Synthetic owner','admin','${A}',true,false);
 INSERT INTO organization_members(user_id,organization_id,role,active) VALUES('${U}','${A}','admin',true),('${V}','${B}','admin',true);
 INSERT INTO security_audit.platform_admins(user_id) VALUES('${O}');`);
});
afterAll(()=>db.stop());
it('G31-01 new companies are off with a 1000p provided monthly default',()=>{
 const r=db.ok(auth('SELECT ai_helper_status()::text'));const status=JSON.parse(r.split('\n').find(s=>s.startsWith('{')&&!s.includes('"sub"'))!);
 expect(status.tolra_cap_pence).toBe(1000);expect(status.tolra_enabled).toBe(false);expect(status.tolra_available).toBe(false);
 expect(db.sql(request()).error).toContain('ai_helper_off');expect(total(A)).toBe(0);expect(total(B)).toBe(0);
});
it('G31-02 the exact release-146 setter exists, accepts the platform admin service path and stays off',()=>{
 expect(db.ok("SELECT to_regprocedure('public.ai_helper_tolra_set_cap(uuid,integer,uuid)') IS NOT NULL")).toBe('t');
 setCap(A,500);setCap(B,1000);
 expect(db.ok(`SELECT monthly_cap_pence,enabled FROM ai_helper_tolra_companies WHERE organization_id='${A}'`)).toBe('500|f');
 expect(db.ok(`SELECT monthly_cap_pence,enabled FROM ai_helper_tolra_companies WHERE organization_id='${B}'`)).toBe('1000|f');
});
it('G31-03 company admin/office/anon cannot call the privileged setter; a non-owner service claim refuses',()=>{
 for(const role of ['admin','office']){
  db.ok(`UPDATE organization_members SET role='${role}' WHERE user_id='${U}'`);
  const r=db.sql(auth(`SELECT ai_helper_tolra_set_cap('${B}',900,'${O}')`));expect(r.code).not.toBe(0);expect(r.error).toContain('permission denied');
 }
 db.ok(`UPDATE organization_members SET role='admin' WHERE user_id='${U}'`);
 expect(db.sql(`SET ROLE anon;SELECT ai_helper_tolra_set_cap('${A}',900,'${O}')`).code).not.toBe(0);
 expect(db.sql(svc(`SELECT ai_helper_tolra_set_cap('${A}',900,'${U}')`)).error).toContain('Owner required');
 expect(db.ok(`SELECT monthly_cap_pence FROM ai_helper_tolra_companies WHERE organization_id='${B}'`)).toBe('1000');
});
it('G31-04 concurrent A requests stop at A’s 500p setting without spending or changing B’s 1000p',async()=>{
 // Explicit synthetic approval; no real key/provider/network call.
 db.ok(`UPDATE ai_helper_tolra_control SET enabled=true,api_key_enc='v1.synthetic.synthetic.synthetic';UPDATE ai_helper_tolra_companies SET enabled=true WHERE organization_id IN ('${A}','${B}');INSERT INTO ai_helper_settings(organization_id,roundup_enabled) VALUES('${A}',true),('${B}',true)`);
 const a=await Promise.all(Array.from({length:15},()=>db.parallelSql(request())));expect(a.every(r=>r.code===0)).toBe(true);
 expect(a.map(r=>answer(r.output)).filter(r=>r.ok)).toHaveLength(5);expect(total(A)).toBe(500);expect(total(B)).toBe(0);
 const b=await Promise.all(Array.from({length:15},()=>db.parallelSql(request(V))));expect(b.every(r=>r.code===0)).toBe(true);
 expect(b.map(r=>answer(r.output)).filter(r=>r.ok)).toHaveLength(10);expect(total(B)).toBe(1000);expect(total(A)).toBe(500);
 expect(answer(db.ok(request(V)))).toMatchObject({ok:false,reason:'cap'});
});
it('G31-05 raising A to 1000p leaves B unchanged; reducing below reserved/spent refuses',()=>{
 setCap(A,1000);expect(answer(db.ok(request())).ok).toBe(true);expect(total(A)).toBe(600);expect(total(B)).toBe(1000);
 expect(db.sql(svc(`SELECT ai_helper_tolra_set_cap('${A}',599,'${O}')`)).error).toContain('cap_below_usage');
 for(const n of [-1,100001])expect(db.sql(svc(`SELECT ai_helper_tolra_set_cap('${A}',${n},'${O}')`)).code).not.toBe(0);
});
