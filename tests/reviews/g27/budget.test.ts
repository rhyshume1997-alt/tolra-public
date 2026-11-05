import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Disposable } from './disposable';
const db=new Disposable();
const J='11111111-1111-4111-8111-111111111111',M='22222222-2222-4222-8222-222222222222',U='33333333-3333-4333-8333-333333333333',V='55555555-5555-4555-8555-555555555555';
const read=(p:string)=>readFileSync(p,'utf8');
function fn(p:string,name:string) { return fnText(read(p),name); }
function fnText(text:string,name:string) {
  const starts=[`CREATE OR REPLACE FUNCTION public.${name}(`,`CREATE FUNCTION public.${name}(`];
  const start=Math.max(...starts.map(s=>text.indexOf(s))), end=text.indexOf('$$;',start)+3;
  if(start<0 || end<start) throw new Error(`Missing exact source function ${name}`);
  return text.slice(start,end);
}
const request=(feature:string,user=U)=>`BEGIN;SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated","aal":"aal1"}',true); SELECT ${feature==='assistant'?'public.ai_helper_reserve_assistant(50':`public.ai_helper_reserve('${feature}',50`},repeat('a',64),12)::text;COMMIT;`;
function answer(text:string) { return JSON.parse(text.split('\n').find(x=>x.startsWith('{"ok"'))!); }
const asUser=(sql:string)=>`BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claims','{"sub":"${U}","role":"authenticated","aal":"aal1"}',true);${sql};COMMIT;`;
const total=(org=J)=>Number(db.ok(`SELECT coalesce(sum(spent_pence+reserved_pence),0) FROM ai_helper_usage WHERE organization_id='${org}'`));
beforeAll(async()=>{
 await db.start();
 db.ok(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA security_audit;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT (auth.jwt()->>'sub')::uuid$$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,banned_until timestamptz);
 CREATE TABLE organizations(id uuid PRIMARY KEY,status text,require_admin_mfa boolean DEFAULT false);
 CREATE TABLE user_profiles(id uuid,active boolean,must_change_password boolean,email text);
 CREATE TABLE organization_members(user_id uuid,organization_id uuid,role text,secondary_role text,support boolean,expires_at timestamptz,hidden_sections text[],support_grant uuid,active boolean);
 CREATE TABLE security_audit.platform_admins(user_id uuid);
 CREATE TABLE security_audit.session_company(user_id uuid,session_id uuid,organization_id uuid,elevated_until timestamptz,grant_id uuid);
 CREATE TABLE security_audit.audit_log(organization_id uuid,actor_user_id uuid,actor_email text,action text,entity_table text,entity_id text,metadata jsonb);
 INSERT INTO organizations(id,status) VALUES('${J}','active'),('${M}','active');
 INSERT INTO user_profiles VALUES('${U}',true,false,'jnr@example.test'),('${V}',true,false,'marpet@example.test');
 INSERT INTO organization_members VALUES('${U}','${J}','admin',null,false,null,'{}',null,true),('${V}','${M}','admin',null,false,null,'{}',null,true);
 GRANT USAGE ON SCHEMA auth,public TO authenticated,service_role;`);
 db.ok(fn('supabase/migrations/121_rls_helper_speed.sql','_session_membership'));
 for(const name of ['current_user_organization_id','has_org_role','session_read_only','support_readonly_guard']) db.ok(fn('supabase/migrations/036_two_level_access.sql',name));
 db.ok(fn('supabase/migrations/019_issued_document_history.sql','is_api_role'));
 for(const name of ['mfa_ok','assert_privileged_aal','require_admin_mfa_guard']) db.ok(fn('supabase/migrations/033_prelaunch_hardening.sql',name));
 const base=read('supabase/migrations/101_ai_helper.sql');
 db.ok(base.slice(base.indexOf('CREATE TABLE IF NOT EXISTS public.ai_helper_settings'),base.indexOf('-- 3. The internal helpers')));
 for(const name of ['_ai_helper_audit','_ai_helper_caller']) db.ok(fn('supabase/migrations/101_ai_helper.sql',name));
 // Real table defaults and function bodies; no budget arithmetic is replaced by a test double.
 db.ok("ALTER TABLE ai_helper_settings ALTER COLUMN monthly_cap_pence SET DEFAULT 500");
 const assistant=read('supabase/migrations/134_ai_assistant.sql');
 db.ok(assistant.slice(assistant.indexOf('ALTER TABLE public.ai_helper_settings'),assistant.indexOf('-- 3. Admin:')));
 for(const name of ['ai_helper_reserve','ai_helper_settle']) db.ok(fn('supabase/migrations/133_ai_helper_pre_enable.sql',name));
 for(const name of ['ai_helper_reserve_assistant','ai_helper_set_assistant']) db.ok(fn('supabase/migrations/134_ai_assistant.sql',name));
 db.ok('REVOKE ALL ON FUNCTION ai_helper_settle(uuid,text,text,integer,text,jsonb) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION ai_helper_settle(uuid,text,text,integer,text,jsonb) TO service_role;');
 db.ok(fn('supabase/migrations/122_ai_helper_cap_default.sql','ai_helper_status'));
 db.ok(`CREATE TABLE company_setup_progress(id uuid); CREATE FUNCTION accounting_cloud_connections_ready() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;`);
 const provided=execFileSync('git',['show','31f965e7f0cbb2d9caf336b0a2067411bec8fb45:supabase/release/146_tolra_provided_ai.release.sql'],{encoding:'utf8'});
 db.ok(provided);
 db.ok(`INSERT INTO ai_helper_settings(organization_id) VALUES('${J}'),('${M}'); INSERT INTO ai_helper_secrets(organization_id,api_key_enc) VALUES('${J}','v1.synthetic.synthetic.synthetic'),('${M}','v1.other.other.other');`);
 console.log(`G27 evidence: ${db.evidence}`);
});
afterAll(()=>db.stop());
it('starts every feature disabled even with a synthetic own-key secret and a £5 default',()=>{
 expect(db.ok(`SELECT roundup_enabled OR rfq_enabled OR assistant_enabled FROM ai_helper_settings WHERE organization_id='${J}'`)).toBe('f');
 expect(db.ok(`SELECT monthly_cap_pence FROM ai_helper_settings WHERE organization_id='${J}'`)).toBe('500');
 for(const feature of ['roundup','rfq','assistant']) expect(db.sql(request(feature)).code).not.toBe(0);
 expect(total()).toBe(0);
 expect(db.ok('SELECT enabled FROM ai_helper_tolra_control')).toBe('f');
 expect(db.ok('SELECT count(*) FROM ai_helper_tolra_companies WHERE enabled')).toBe('0');
});
it('only an admin can approve the assistant switch',()=>{
 db.ok(`UPDATE organization_members SET role='office' WHERE user_id='${U}'`);
 expect(db.sql(asUser('SELECT ai_helper_set_assistant(true)')).code).not.toBe(0);
 db.ok(`UPDATE organization_members SET role='admin' WHERE user_id='${U}'`);
 expect(db.sql(asUser('SELECT ai_helper_set_assistant(true)')).code).toBe(0);
});
it('holds a shared £5 ledger under 30 concurrent mixed-feature requests, then concurrent settlements',async()=>{
 db.ok(`UPDATE ai_helper_settings SET roundup_enabled=true,rfq_enabled=true,assistant_enabled=true`);
 const results=await Promise.all(Array.from({length:30},(_,i)=>db.parallelSql(request(['roundup','rfq','assistant'][i%3]))));
 expect(results.every(r=>r.code===0)).toBe(true);
 const accepted=results.map(r=>answer(r.output)).filter(r=>r.ok);
 expect(accepted).toHaveLength(10); expect(total()).toBe(500); expect(total(M)).toBe(0);
 const settled=await Promise.all(accepted.map(r=>db.parallelSql(`BEGIN;SET LOCAL ROLE service_role;SELECT ai_helper_settle('${r.request_id}','failed','unavailable',50,null,null);COMMIT;`)));
 expect(settled.every(r=>r.code===0)).toBe(true); expect(total()).toBe(500);
 expect(db.ok(`SELECT reserved_pence,spent_pence FROM ai_helper_usage WHERE organization_id='${J}'`)).toBe('0|500');
 expect(answer(db.ok(request('assistant'))).reason).toBe('cap');
});
it('gives a second company its own £5 ledger without opening the first company budget',async()=>{
 const results=await Promise.all(Array.from({length:12},()=>db.parallelSql(request('roundup',V))));
 expect(results.every(r=>r.code===0)).toBe(true);
 expect(results.map(r=>answer(r.output)).filter(r=>r.ok)).toHaveLength(10);
 expect(total(M)).toBe(500);expect(total()).toBe(500);
});
it('never exposes a key in reservation replies, request records or audit metadata',()=>{
 expect(db.ok("SELECT count(*) FROM ai_helper_requests WHERE to_jsonb(ai_helper_requests)::text LIKE '%v1.synthetic%'")).toBe('0');
 expect(db.ok("SELECT count(*) FROM security_audit.audit_log WHERE metadata::text LIKE '%v1.synthetic%'")).toBe('0');
 expect(db.sql(asUser('SELECT * FROM ai_helper_secrets')).code).not.toBe(0);
 expect(db.ok(request('roundup'))).not.toContain('v1.synthetic');
});

it('provided-mode DEFAULT must also hold the requested £5 cap under concurrency (known finding, must not be weakened)',async()=>{
 db.ok(`TRUNCATE ai_helper_requests,ai_helper_usage; INSERT INTO ai_helper_tolra_companies(organization_id,enabled) VALUES('${J}',true); UPDATE ai_helper_tolra_control SET enabled=true,api_key_enc='v1.synthetic.synthetic.synthetic'`);
 const results=await Promise.all(Array.from({length:30},()=>db.parallelSql(request('roundup'))));
 expect(results.every(r=>r.code===0)).toBe(true);
 const measured={accepted:results.map(r=>answer(r.output)).filter(r=>r.ok).length, reservedAndSpent:total()};
 expect(measured).toEqual({accepted:10,reservedAndSpent:500});
});
it('provided mode with an explicitly configured 500p cap holds £5 under concurrency',async()=>{
 db.ok(`TRUNCATE ai_helper_requests,ai_helper_usage; UPDATE ai_helper_tolra_companies SET monthly_cap_pence=500 WHERE organization_id='${J}'`);
 const results=await Promise.all(Array.from({length:30},(_,i)=>db.parallelSql(request(['roundup','rfq','assistant'][i%3]))));
 expect(results.every(r=>r.code===0)).toBe(true);
 const accepted=results.map(r=>answer(r.output)).filter(r=>r.ok);
 expect(accepted).toHaveLength(10);expect(total()).toBe(500);
 const replies=await Promise.all(accepted.map(r=>db.parallelSql(`BEGIN;SET LOCAL ROLE service_role;SELECT ai_helper_settle('${r.request_id}','failed','unavailable',50,null,null);COMMIT;`)));
 expect(replies.every(r=>r.code===0)).toBe(true);expect(total()).toBe(500);
 expect(db.sql(`BEGIN;SET LOCAL ROLE service_role;SELECT ai_helper_settle('${accepted[0].request_id}','failed','unavailable',50,null,null);COMMIT;`).code).not.toBe(0);
 expect(total()).toBe(500);
});
it('stale provided reservations are charged once during concurrent sweeps, never released as fresh budget',async()=>{
 db.ok('TRUNCATE ai_helper_requests,ai_helper_usage');
 const initial=await Promise.all(Array.from({length:10},()=>db.parallelSql(request('assistant'))));
 expect(initial.every(r=>r.code===0 && answer(r.output).ok)).toBe(true);
 db.ok("UPDATE ai_helper_requests SET created_at=now()-interval '11 minutes'");
 const later=await Promise.all(Array.from({length:15},()=>db.parallelSql(request('assistant'))));
 expect(later.every(r=>r.code===0 && !answer(r.output).ok)).toBe(true);
 expect(db.ok(`SELECT reserved_pence,spent_pence FROM ai_helper_usage WHERE organization_id='${J}'`)).toBe('0|500');
 expect(db.ok("SELECT count(*) FROM ai_helper_requests WHERE status='expired'")).toBe('10');
});
