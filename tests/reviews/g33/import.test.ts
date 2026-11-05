import { randomUUID } from 'node:crypto';
import { payload, report } from './payload';
import { preprocess } from './preprocess.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Disposable } from './disposable';
const db = new Disposable();
let holdsBefore='',marpetBefore='';
const J='11111111-1111-4111-8111-111111111111',M='22222222-2222-4222-8222-222222222222',U='33333333-3333-4333-8333-333333333333',S='44444444-4444-4444-8444-444444444444';
const SHA='9d7725e7e1b59e68a314c4148513b9b7d7aa4e92';
const source=(p:string)=>execFileSync('git',['show',`${SHA}:${p}`],{encoding:'utf8',maxBuffer:8*1024*1024});
beforeAll(async()=>{
 await db.start();console.log(`G33 evidence: ${db.evidence}`);
 db.ok(readFileSync('tests/reviews/g33/bootstrap.sql','utf8'));
 const files=execFileSync('git',['ls-tree','--name-only',`${SHA}:supabase/migrations`],{encoding:'utf8'}).trim().split('\n').filter(p=>/^\d{3}_.+\.sql$/.test(p)).sort();
 for(const file of files){console.log(`Apply ${file}`);db.ok(source(`supabase/migrations/${file}`));}
 db.ok(`INSERT INTO organizations(id,name,slug,status) VALUES('${J}','Synthetic G33 JNR','t-g33-jnr','active'),('${M}','Synthetic G33 Marpet','t-g33-marpet','active');
 INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('${U}','g33@example.test',now());
 INSERT INTO user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES('${U}','g33@example.test','Synthetic Admin','admin','${J}',true,false);
 INSERT INTO organization_members(user_id,organization_id,role,active) VALUES('${U}','${J}','admin',true);
 INSERT INTO auth.sessions(id,user_id) VALUES('${S}','${U}');
 INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES('${S}','${U}','${J}');
 INSERT INTO organization_settings(organization_id,company_profile) VALUES('${J}','{"vatRegistered":true}') ON CONFLICT(organization_id) DO UPDATE SET company_profile=excluded.company_profile;`);
 for(const file of ['145_company_setup','146_tolra_provided_ai','147_job_delivery_note'])db.ok(source(`supabase/release/${file}.release.sql`));
 const library=process.env.G33_SAFEUPDATE_SO;if(!library)throw new Error('G33 requires the genuine safeupdate library; no skip or fallback');db.installSafeupdate(library);
 holdsBefore=db.ok('SELECT jsonb_agg(h ORDER BY organization_id)::text FROM dln_numbering_pending h');
 marpetBefore=snapshot(M);
});
afterAll(()=>db.stop());
it('installs the complete 138 → 140 → 141 → 144 → 145 → 146 → 147 chain',()=>{
 const rows=db.ok(source('supabase/verify/job_delivery_note_147.sql'));
 expect(rows.split('\n').length).toBeGreaterThanOrEqual(10);expect(rows.split('\n').every(r=>r.endsWith('|t'))).toBe(true);
});

const q=(sql:string)=>{const r=db.sql(`LOAD 'safeupdate';BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claims','{"sub":"${U}","role":"authenticated","aal":"aal2","session_id":"${S}","email":"g33@example.test"}',true);${sql};COMMIT;`);return r;};
const result=(sql:string)=>{const r=q(sql);if(r.code!==0)throw new Error(r.error);return JSON.parse(r.output.split('\n').find(line=>line.startsWith('{')&&!line.includes('"sub"'))!);};
const run=(p:unknown,dry=false)=>result(`SELECT public.import_company_data($payload$${JSON.stringify(p)}$payload$::jsonb,${dry},'${randomUUID()}')::text`);
const tables=['suppliers','stock','quotes','quote_line_items','sales_orders','jobs','job_values','purchase_orders','customers','invoices','invoice_line_items','invoice_payments','credit_notes','credit_note_lines','invoice_credit_allocations','delivery_notes','delivery_note_items','doc_counters','import_record_keys','dln_numbering_pending'];
const snapshot=(org?:string)=>db.ok(`SELECT jsonb_build_array(${tables.map(t=>`(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM public.${t} t ${org?`WHERE organization_id='${org}'`:''})`).join(',')})::text`);
it('G33-SU1: LOAD is mandatory and real safeupdate refuses unqualified UPDATE/DELETE, including in functions',()=>{
 for(const sql of ['UPDATE probe SET n=1','DELETE FROM probe','DO $$ BEGIN UPDATE probe SET n=1; END $$']){
  const r=db.sql(`LOAD 'safeupdate';CREATE TEMP TABLE probe(n int);${sql};`);expect(r.code).not.toBe(0);expect(r.error).toMatch(/requires a WHERE clause/);
 }
 expect(db.ok("LOAD 'safeupdate';CREATE TEMP TABLE allowed_probe(n int);UPDATE allowed_probe SET n=1 WHERE true")).toContain('UPDATE 0');
 expect(db.ok("LOAD 'safeupdate';SELECT current_setting('safeupdate.enabled')")).toBe('LOAD\non');
});
it('G33-SU2: preprocessed small import dry run, commit, counts, exact reconciliation, repeat without duplicates under 147',async()=>{
 const {p,counts}=await payload('SMALL');expect(counts).toMatchObject({records:2,out:2,totalsRows:1,groupRows:1});
 const before=snapshot();expect(run(p,true)).toMatchObject({ok:true,dry_run:true,committed:false});expect(snapshot()).toBe(before);
 const r=run(p);expect(r.errors).toEqual([]);expect(r.committed).toBe(true);
 expect(r.counts).toMatchObject({suppliers:{created:1},stock:{created:1},quotes:{created:1},sales_orders:{created:1},jobs:{created:1},purchase_orders:{created:1},customers:{created:1},invoices:{created:2},payments:{created:1},credit_notes:{created:1},delivery_notes:{created:1}});
 expect(db.ok(`SELECT count(*),sum(total),sum(amount_paid) FROM invoices WHERE organization_id='${J}' AND invoice_ref LIKE 'G33-SMALL-%'`)).toBe('2|144.06|60.00');
 expect(db.ok(`SELECT count(*),sum(p.amount) FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.organization_id='${J}' AND i.invoice_ref LIKE 'G33-SMALL-%'`)).toBe('1|60.00');
 expect(db.ok(`SELECT count(*),sum(c.total) FROM credit_notes c WHERE organization_id='${J}' AND credit_ref='CRD-SMALL'`)).toBe('1|12.00');
 expect(db.ok(`SELECT sum(i.total-i.amount_paid-coalesce((SELECT sum(a.amount) FROM invoice_credit_allocations a WHERE a.invoice_id=i.id),0)) FROM invoices i WHERE organization_id='${J}' AND invoice_ref LIKE 'G33-SMALL-%'`)).toBe('72.06');
 expect(db.ok(`SELECT count(*) FROM delivery_notes WHERE organization_id='${J}' AND dn_number='DLN-SMALL'`)).toBe('1');
 const committed=snapshot();expect(run(p).counts.invoices).toMatchObject({created:0,matched_existing:2});expect(snapshot()).toBe(committed);
});
it('G33-SU3: one bad database row rejects the whole file; bad preprocessor rows never reach import',async()=>{
 const before=snapshot();expect(()=>preprocess(report('DATE',true),{kind:'invoices'})).toThrow(/date/i);
 const {p}=await payload('BAD');p.invoices![1].invoice_date='2026-02-31';const r=run(p);expect(r.ok).toBe(false);expect(r.committed).toBe(false);expect(r.error_count).toBeGreaterThan(0);expect(snapshot()).toBe(before);
});
async function staged(tag:string) {
 const {p}=await payload(tag), id=randomUUID();
 const {invoices,payments,credit_notes,delivery_notes,...first}=p;
 for(const [i,part] of [first,{invoices,payments,credit_notes,delivery_notes}].entries())expect(result(`SELECT import_stage_part('${id}',${i+1},$p$${JSON.stringify(part)}$p$::jsonb)::text`).status).toBe('staging');
 expect(result(`SELECT import_validate('${id}',10,'${randomUUID()}')::text`).ok).toBe(true);
 for(let n=0;n<30;n++){const r=result(`SELECT import_commit_part('${id}','${randomUUID()}')::text`);expect(r.ok).toBe(true);if(r.parts_committed===r.parts)return id;}
 throw new Error('Staged commit never completed');
}
async function undo(id:string){for(let n=0;n<30;n++){const r=result(`SELECT import_undo('${id}','${randomUUID()}')::text`);if(r.status==='undone')return;}throw new Error('Undo never completed');}
it('G33-SU4: staged large-path import validates, commits and undoes with safeupdate and all 147 guards installed',async()=>{
 const before=snapshot(), id=await staged('LARGE');expect(db.ok(`SELECT count(*) FROM delivery_notes WHERE dn_number='DLN-LARGE'`)).toBe('1');await undo(id);expect(snapshot()).toBe(before);
});
it('G33-SU5: small and staged imports include credit/delivery notes, then undo; small records remain',async()=>{
 const {p}=await payload('PR2SMALL');expect(run(p).committed).toBe(true);
 const before=snapshot(),id=await staged('PR2LARGE');await undo(id);expect(snapshot()).toBe(before);
 expect(db.ok("SELECT count(*) FROM credit_notes WHERE credit_ref='CRD-PR2SMALL'")).toBe('1');
 expect(db.ok("SELECT count(*) FROM delivery_notes WHERE dn_number='DLN-PR2SMALL'")).toBe('1');
});
it('G33-HOLD: paused company import refuses without business writes',async()=>{
 const {p}=await payload('HELD');db.ok(`UPDATE organizations SET status='paused' WHERE id='${J}'`);const before=snapshot();
 try{const r=q(`SELECT import_company_data($p$${JSON.stringify(p)}$p$::jsonb,false,'${randomUUID()}')`);expect(r.code).not.toBe(0);expect(r.error).toContain('Sign in to a company first');expect(r.error).toContain('not_allowed');expect(snapshot()).toBe(before);}
 finally{db.ok(`UPDATE organizations SET status='active' WHERE id='${J}'`);}
});
it('G33-147: numbering hold blocks new manual notes; historical imports preserve that hold for both companies',()=>{
 expect(db.ok('SELECT count(*) FROM dln_numbering_pending')).toBe('2');
 expect(db.ok('SELECT jsonb_agg(h ORDER BY organization_id)::text FROM dln_numbering_pending h')).toBe(holdsBefore);expect(snapshot(M)).toBe(marpetBefore);
 const before=snapshot(),r=q(`INSERT INTO delivery_notes(organization_id,customer,dn_number) VALUES('${J}','G33 Synthetic Metal Ltd',NULL)`);
 expect(r.code).not.toBe(0);expect(r.error).toContain('dln_numbering_not_set');expect(snapshot()).toBe(before);
 expect(db.ok(`SELECT count(*) FROM invoices WHERE organization_id='${M}'`)).toBe('0');
});
