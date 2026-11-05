import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {Disposable} from './disposable';
const db=new Disposable(),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',U='33333333-3333-4333-8333-333333333333',V='44444444-4444-4444-8444-444444444444',S='55555555-5555-4555-8555-555555555555';
const auth=(sql:string,user=U)=>`BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated","aal":"aal2"}',true);${sql};COMMIT;`;
const service=(sql:string)=>`BEGIN;SET LOCAL ROLE service_role;${sql};COMMIT;`;
beforeAll(async()=>{
 await db.start();console.log(`Xero launch evidence: ${db.evidence}`);
 db.ok(readFileSync('tests/reviews/xero-launch/bootstrap.sql','utf8'));
 const files=execFileSync('git',['ls-tree','--name-only','68f89ca:supabase/migrations'],{encoding:'utf8'}).trim().split('\n').filter(f=>/^\d{3}.*sql$/.test(f)).sort();
 for(const f of files)db.ok(execFileSync('git',['show',`68f89ca:supabase/migrations/${f}`],{encoding:'utf8',maxBuffer:8*1024*1024}));
 db.ok(`INSERT INTO organizations(id,name,slug) VALUES('${A}','Synthetic A','xero-hold-a'),('${B}','Synthetic B','xero-hold-b');
 INSERT INTO auth.users(id,email) VALUES('${U}','admin-a@example.test'),('${V}','admin-b@example.test');
 INSERT INTO user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES('${U}','admin-a@example.test','Synthetic A','admin','${A}',true,false),('${V}','admin-b@example.test','Synthetic B','admin','${B}',true,false);
 INSERT INTO organization_members(user_id,organization_id,role,active) VALUES('${U}','${A}','admin',true),('${V}','${B}','admin',true);
 INSERT INTO integration_connections(organization_id,provider,status,tenant_id,tenant_name) VALUES('${A}','xero','connected','synthetic-tenant-A','Synthetic A'),('${B}','xero','connected','synthetic-tenant-B','Synthetic B');
 INSERT INTO integration_sends(id,organization_id,provider,doc_type,doc_id,action,status) VALUES('${S}','${A}','xero','invoice',gen_random_uuid(),'create','failed');`);
 const catalogue=readFileSync('supabase/verify/catalogue.sql','utf8');
 const before=JSON.parse(db.ok(`SELECT coalesce(json_agg(c),'[]'::json) FROM (${catalogue.trim().replace(/;$/, '')}) c`));
 db.ok(readFileSync('supabase/release/149_xero_launch_hold.release.sql','utf8'));
 const after=JSON.parse(db.ok(`SELECT coalesce(json_agg(c),'[]'::json) FROM (${catalogue.trim().replace(/;$/, '')}) c`));
 writeFileSync(`${db.evidence}/catalogue-delta.json`,JSON.stringify({before,after},null,2));
});
afterAll(()=>db.stop());
it('existing connected companies default OFF; six verification checks pass',()=>{
 expect(db.ok('SELECT count(*) FROM integration_connections WHERE transfers_enabled')).toBe('0');
 const checks=db.ok(readFileSync('supabase/verify/xero_launch_hold_149.sql','utf8')).split('\n');expect(checks).toHaveLength(6);expect(checks.every(r=>r.endsWith('|t'))).toBe(true);
 expect(db.ok(service(`SELECT integration_claim_next('${A}','xero')`))).toContain('launch_hold');
});
it('held queue insert creates nothing and old failed send cannot retry',()=>{
 expect(db.ok(`INSERT INTO integration_sends(organization_id,provider,doc_type,doc_id,action) VALUES('${A}','xero','invoice',gen_random_uuid(),'create'); SELECT count(*) FROM integration_sends;`)).toContain('1');
 expect(db.sql(auth(`SELECT integration_retry_send('${S}')`)).error).toContain('xero_launch_hold');
 expect(db.ok(`SELECT status FROM integration_sends WHERE id='${S}'`)).toBe('failed');
});
it('only current-company admin can enable; office, workshop and anon refuse',()=>{
 for(const role of ['office','workshop']){
  db.ok(`UPDATE organization_members SET role='${role}' WHERE user_id='${U}'`);
  expect(db.sql(auth('SELECT integration_xero_set_transfers(true)')).code).not.toBe(0);
 }
 db.ok(`UPDATE organization_members SET role='admin' WHERE user_id='${U}'`);
 expect(db.sql('SET ROLE anon;SELECT integration_xero_set_transfers(true)').code).not.toBe(0);
 db.ok(auth('SELECT integration_xero_set_transfers(true)',V));
 expect(db.ok(`SELECT transfers_enabled FROM integration_connections WHERE organization_id='${B}'`)).toBe('t');
 expect(db.ok(`SELECT transfers_enabled FROM integration_connections WHERE organization_id='${A}'`)).toBe('f');
});
it('admin release enables normal queue and retry, disabling blocks them again',()=>{
 db.ok(auth('SELECT integration_xero_set_transfers(true)'));
 db.ok(auth(`SELECT integration_retry_send('${S}')`));expect(db.ok(`SELECT status FROM integration_sends WHERE id='${S}'`)).toBe('pending');
 db.ok(`INSERT INTO integration_sends(organization_id,provider,doc_type,doc_id,action) VALUES('${A}','xero','invoice',gen_random_uuid(),'create')`);
 expect(db.ok('SELECT count(*) FROM integration_sends')).toBe('2');
 db.ok(auth('SELECT integration_xero_set_transfers(false)'));
 expect(db.ok(service(`SELECT integration_claim_next('${A}','xero')`))).toContain('launch_hold');
});
it('reconnection resets enable and rollback restores original functions on this disposable only',()=>{
 db.ok(auth('SELECT integration_xero_set_transfers(true)'));
 db.ok(`UPDATE integration_connections SET connected_at=now()+interval '1 second' WHERE organization_id='${A}'`);
 expect(db.ok(`SELECT transfers_enabled FROM integration_connections WHERE organization_id='${A}'`)).toBe('f');
 db.ok(auth('SELECT integration_xero_set_transfers(true)'));
 db.ok(`UPDATE integration_connections SET status='disconnected' WHERE organization_id='${A}'`);
 expect(db.ok(`SELECT transfers_enabled FROM integration_connections WHERE organization_id='${A}'`)).toBe('f');
 db.ok(readFileSync('supabase/release/149_xero_launch_hold.rollback.sql','utf8'));
 expect(db.ok("SELECT count(*) FROM information_schema.columns WHERE table_name='integration_connections' AND column_name='transfers_enabled'")).toBe('0');
});
