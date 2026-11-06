import {createHash} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {Disposable} from './disposable';
const db=new Disposable();
const original=execFileSync('git',['show','e42d927:supabase/migrations/143_costing_rates.sql'],{encoding:'utf8'});
const workspace=mkdtempSync('/tmp/tolra-b5-cli-');
const cli=process.env.B5_SUPABASE_CLI;
beforeAll(async()=>{
 if(cli)expect(createHash('sha256').update(readFileSync(cli)).digest('hex')).toBe('568db201105cf8c261226fc16ab412ecc3b7bd03f25ea657852127a638b1601c');
 if(!cli)throw Error('Set B5_SUPABASE_CLI to checksum-verified public CLI2.40.7; never skip this check');
 mkdirSync(path.join(workspace,'supabase','migrations'),{recursive:true});
 writeFileSync(path.join(workspace,'supabase','config.toml'),'project_id = "b5-disposable-financial"\n');
 await db.start();db.enableCliTls();console.log(`Disposable proof: ${db.evidence}`);
 db.ok(readFileSync('tests/reviews/b5-financial/bootstrap.sql','utf8'));
 const files=execFileSync('git',['ls-tree','--name-only','e42d927:supabase/migrations'],{encoding:'utf8'}).trim().split('\n').filter(f=>/^\d{3}.*sql$/.test(f)&&Number(f.slice(0,3))<143).sort();
 for(const f of files)db.ok(execFileSync('git',['show',`e42d927:supabase/migrations/${f}`],{encoding:'utf8',maxBuffer:8*1024*1024}));
});
afterAll(()=>db.stop());
it('original143 reproduces exact CLI prepared-statement error; whole migration writes nothing',()=>{
 writeFileSync(path.join(workspace,'supabase','migrations','143_costing_rates.sql'),original);
 const r=db.cli(cli!,workspace);writeFileSync(`${db.evidence}/original-cli.log`,r.log);
 expect(r.code).not.toBe(0);expect(r.log).toContain('cannot insert multiple commands into a prepared statement');expect(r.log).toContain('At statement: 9');
 expect(db.ok("SELECT to_regclass('public.costing_defaults') IS NULL")).toBe('t');
});
it('quoted name lets the exact CLI execute statements separately, same body/grants, all verifier rows true',()=>{
 writeFileSync(path.join(workspace,'supabase','migrations','143_costing_rates.sql'),readFileSync('supabase/migrations/143_costing_rates.sql'));
 const r=db.cli(cli!,workspace);writeFileSync(`${db.evidence}/fixed-cli.log`,r.log);expect(r.code,r.log).toBe(0);
 const rows=db.ok(readFileSync('supabase/verify/costing_rates_143.sql','utf8')).split('\n');expect(rows.length).toBeGreaterThan(5);expect(rows.every(r=>r.endsWith('|t'))).toBe(true);
 expect(db.ok("SELECT md5(regexp_replace(prosrc,'\\s','','g')) FROM pg_proc WHERE oid=to_regprocedure('public.save_costing_settings_atomic(uuid,jsonb,jsonb)')")).toBe('2c779bca11212d8bf660c4526719c919');
});
it('existing company isolation, roles, whole-pence constraints and audit SQL proof all hold',()=>{
 const proof=readFileSync('tests/scripts/costing-rates-143.proof.sql','utf8').split('\n').filter(l=>!l.startsWith('\\')).join('\n');
 db.ok(proof);
});

const A='33333333-3333-4333-8333-333333333333',B='44444444-4444-4444-8444-444444444444',U='55555555-5555-4555-8555-555555555555',V='66666666-6666-4666-8666-666666666666',Q='77777777-7777-4777-8777-777777777777';
const auth=(sql:string,user=U)=>`BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claims','{"sub":"${user}","role":"authenticated","aal":"aal2"}',true);${sql};COMMIT;`;
const json=(sql:string,user=U)=>JSON.parse(db.ok(auth(sql,user)).split('\n').filter(l=>l.startsWith('{')||l.startsWith('[')||l==='null').at(-1)!);
const literal=(value:unknown)=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
import {loadCompanyRates,EMPTY_SNAPSHOT,toRpcValue} from '@/lib/costing/app-rates';
import {priceThisPart,appliedLine} from '@/lib/costing/price-part';
import {CONFIGURED,ENTRY} from '../../unit/costing-fixtures';
import type {SupabaseClient} from '@supabase/supabase-js';
function ratesClient(user=U){return {from:(table:string)=>{
 expect(['costing_materials','costing_machines','costing_defaults']).toContain(table);
 const q={select:()=>q,order:async()=>({data:json(`SELECT coalesce(json_agg(x),'[]') FROM (SELECT * FROM public.${table} ORDER BY name) x`,user),error:null}),maybeSingle:async()=>({data:json(`SELECT coalesce((SELECT row_to_json(x) FROM (SELECT * FROM public.${table}) x),'null')`,user),error:null})};return q;
 }} as unknown as SupabaseClient;}
it('Settings to panel uses the real company RLS rates; changing rates does not rewrite a saved quote line',async()=>{
 db.ok(`INSERT INTO organizations(id,name,slug) VALUES('${A}','Synthetic costing A','b5-cost-a'),('${B}','Synthetic costing B','b5-cost-b');
 INSERT INTO auth.users(id,email) VALUES('${U}','admin-a@example.test'),('${V}','admin-b@example.test');
 INSERT INTO user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES('${U}','admin-a@example.test','Synthetic A','admin','${A}',true,false),('${V}','admin-b@example.test','Synthetic B','admin','${B}',true,false);
 INSERT INTO organization_members(user_id,organization_id,role,active) VALUES('${U}','${A}','admin',true),('${V}','${B}','admin',true);`);
 const value=toRpcValue(CONFIGURED);
 db.ok(auth(`SELECT public.save_costing_settings_atomic('${A}',${literal(EMPTY_SNAPSHOT)},${literal(value)})`));
 const loaded=await loadCompanyRates(ratesClient());expect(loaded.status).toBe('ok');if(loaded.status!=='ok')throw Error('Rates must load');
 const pricing=priceThisPart(loaded.rates,ENTRY);expect(pricing.status).toBe('ok');if(pricing.status!=='ok')throw Error('Part must price');
 const line=appliedLine('Synthetic bush',pricing.figures);expect(line.unit).toBe(60.72);
 db.ok(auth(`INSERT INTO quotes(id,organization_id,quote_ref,customer,status) VALUES('${Q}','${A}','SYN-Q-1','Synthetic customer','draft');
 INSERT INTO quote_line_items(organization_id,quote_id,position,description,quantity,unit_price,source) VALUES('${A}','${Q}',1,'Synthetic bush',${line.qty},${line.unit},'costing_calculator')`));
 const before=json(`SELECT row_to_json(x) FROM (SELECT quantity,unit_price,source FROM quote_line_items WHERE quote_id='${Q}') x`);
 const changed=structuredClone(CONFIGURED);changed.defaults.labourPerHour=50;changed.machines[0].hourlyRate=80;
 db.ok(auth(`SELECT public.save_costing_settings_atomic('${A}',${literal(value)},${literal(toRpcValue(changed))})`));
 const reloaded=await loadCompanyRates(ratesClient());if(reloaded.status!=='ok')throw Error('Changed rates must load');
 const next=priceThisPart(reloaded.rates,ENTRY);expect(next.status==='ok'&&next.figures.unitPrice).not.toBe(line.unit);
 expect(json(`SELECT row_to_json(x) FROM (SELECT quantity,unit_price,source FROM quote_line_items WHERE quote_id='${Q}') x`)).toEqual(before);
 expect((await loadCompanyRates(ratesClient(V))).status).toBe('ok');
 const b=await loadCompanyRates(ratesClient(V));if(b.status!=='ok')throw Error('Blank partial rates load for editing');expect(priceThisPart(b.rates,ENTRY).status).toBe('not_set_up');
 expect(db.sql(auth(`SELECT public.save_costing_settings_atomic('${A}',${literal(toRpcValue(changed))},${literal(value)})`,V)).code).not.toBe(0);
});
it('financial export source rows are company-scoped under RLS; foreign and workshop rows cannot be read',()=>{
 const IA='88888888-8888-4888-8888-888888888888',IB='99999999-9999-4999-8999-999999999999';
 db.ok(`INSERT INTO invoices(id,organization_id,customer,status,invoice_date) VALUES('${IA}','${A}','Synthetic A','draft','2026-11-05'),('${IB}','${B}','Synthetic B','draft','2026-11-05')`);
 expect(json('SELECT coalesce(json_agg(id ORDER BY id),\'[]\') FROM invoices')).toEqual([IA]);
 expect(json('SELECT coalesce(json_agg(id ORDER BY id),\'[]\') FROM invoices',V)).toEqual([IB]);
 expect(json(`SELECT coalesce(json_agg(id),'[]') FROM invoices WHERE id='${IB}'`)).toEqual([]);
 expect(db.sql(auth(`UPDATE invoices SET customer='Wrong company' WHERE id='${IB}'`)).code).toBe(0);
 expect(db.ok(`SELECT customer FROM invoices WHERE id='${IB}'`)).toBe('Synthetic B');
 db.ok(`UPDATE organization_members SET role='workshop' WHERE user_id='${U}'`);
 expect(json('SELECT coalesce(json_agg(id),\'[]\') FROM invoices')).toEqual([]);
 db.ok(`UPDATE organization_members SET role='admin' WHERE user_id='${U}'`);
});
import {serverBehaviour} from '@/lib/integrations/xero-setup-state';
import type {IntegrationOverview} from '@/lib/integrations/overview';
it('candidate accounting state uses actual DB hold/mapping/company rows and refuses reconnect/error states',()=>{
 const files=execFileSync('git',['ls-tree','--name-only','e42d927:supabase/migrations'],{encoding:'utf8'}).trim().split('\n').filter(f=>/^\d{3}.*sql$/.test(f)&&Number(f.slice(0,3))>143).sort();
 for(const f of files)db.ok(execFileSync('git',['show',`e42d927:supabase/migrations/${f}`],{encoding:'utf8',maxBuffer:8*1024*1024}));
 // Rehearsal-only release prerequisites. Never amend an approved production manifest.
 for(const f of ['145_company_setup','146_tolra_provided_ai','147_job_delivery_note','149_xero_launch_hold'])db.ok(readFileSync(`supabase/release/${f}.release.sql`,'utf8'));
 db.ok(`INSERT INTO integration_connections(organization_id,provider,status,tenant_id,tenant_name) VALUES('${A}','xero','connected','synthetic-xero-A','Synthetic A'),('${B}','xero','connected','synthetic-xero-B','Synthetic B'),('${A}','sage','connected','synthetic-sage-A','Synthetic Sage A'),('${B}','sage','connected','synthetic-sage-B','Synthetic Sage B');
 INSERT INTO integration_mappings(organization_id,provider,kind,tolra_key,external_code) VALUES('${A}','xero','sales_account','','200'),('${A}','xero','credit_account','','260');`);
 const current=()=>{
  const overview=json("SELECT integration_overview('xero')") as IntegrationOverview;
  const hold=json('SELECT integration_xero_launch_status()');
  return serverBehaviour({configured:true,overview,launchHold:{available:true,on:hold.enabled,set:()=>undefined}});
 };
 expect(current().kind).toBe('held');
 db.ok(auth('SELECT integration_xero_set_transfers(true)'));expect(current().kind).toBe('sends');
 db.ok(`UPDATE integration_connections SET status='needs_reconnect' WHERE organization_id='${A}' AND provider='xero'`);expect(current().kind).toBe('needs_reconnect');
 expect(serverBehaviour({configured:true,overview:null,loadError:true}).kind).toBe('unknown');
 expect(json("SELECT integration_overview('sage')").tenant_name).toBe('Synthetic Sage A');
 expect(json("SELECT integration_overview('sage')",V).tenant_name).toBe('Synthetic Sage B');
 expect(db.sql(auth("SELECT * FROM integration_secrets")).code).not.toBe(0);
});
it('whole-set rate saves serialize concurrent editors and reject a foreign rate without partial writes',async()=>{
 const O='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',FM='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 db.ok(`INSERT INTO auth.users(id,email) VALUES('${O}','office-a@example.test');
 INSERT INTO user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES('${O}','office-a@example.test','Synthetic office','office','${A}',true,false);
 INSERT INTO organization_members(user_id,organization_id,role,active) VALUES('${O}','${A}','office',true);`);
 const loaded=await loadCompanyRates(ratesClient());if(loaded.status!=='ok')throw Error('Rates must load');
 const first=structuredClone(loaded.rates),second=structuredClone(loaded.rates);
 first.materials[0].price=5;first.machines[0].hourlyRate=90;first.defaults.labourPerHour=60;
 second.materials[0].price=6;second.machines[0].hourlyRate=100;second.defaults.labourPerHour=70;
 const expected=literal(toRpcValue(loaded.rates));
 const results=await Promise.all([db.parallelSql(auth(`SELECT save_costing_settings_atomic('${A}',${expected},${literal(toRpcValue(first))})`)),db.parallelSql(auth(`SELECT save_costing_settings_atomic('${A}',${expected},${literal(toRpcValue(second))})`,O))]);
 expect(results.filter(r=>r.code===0)).toHaveLength(1);expect(results.find(r=>r.code!==0)?.error).toContain('Settings changed; reload');
 const final=await loadCompanyRates(ratesClient());if(final.status!=='ok')throw Error('Rates must load');
 expect(toRpcValue(final.rates)).toEqual(toRpcValue(final.rates.materials[0].price===5?first:second));
 db.ok(`INSERT INTO costing_machines(id,organization_id,name,hourly_rate_pence) VALUES('${FM}','${B}','Synthetic foreign mill',1)`);
 const invalid=toRpcValue(final.rates);invalid.machines=[{...invalid.machines[0],id:FM}];
 const refused=db.sql(auth(`SELECT save_costing_settings_atomic('${A}',${literal(toRpcValue(final.rates))},${literal(invalid)})`));
 expect(refused.code).not.toBe(0);expect(refused.error).toContain('Invalid rate ID');
 const after=await loadCompanyRates(ratesClient());if(after.status!=='ok')throw Error('Rates must remain readable');expect(toRpcValue(after.rates)).toEqual(toRpcValue(final.rates));
});
