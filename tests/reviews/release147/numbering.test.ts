import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeAll,afterAll,expect,it } from 'vitest';
import { Disposable } from './disposable';
const db=new Disposable(),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',U='33333333-3333-4333-8333-333333333333',C='44444444-4444-4444-8444-444444444444',J='55555555-5555-4555-8555-555555555555',K='66666666-6666-4666-8666-666666666666';
const source=(p:string,sha='9d7725e7e1b59e68a314c4148513b9b7d7aa4e92')=>execFileSync('git',['show',`${sha}:${p}`],{encoding:'utf8',maxBuffer:8*1024*1024});
const auth=(sql:string)=>`BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claims','{"sub":"${U}","role":"authenticated","aal":"aal2"}',true);${sql};COMMIT;`;
const q=(s:string)=>db.sql(auth(s));
const json=(s:string)=>{const r=q(s);if(r.code!==0)throw new Error(r.error);return JSON.parse(r.output.split('\n').find(x=>x.startsWith('{')&&!x.includes('"sub"'))!);};
const hold=()=>db.ok('SELECT jsonb_agg(h ORDER BY organization_id)::text FROM dln_numbering_pending h');
const last=()=>Number(db.ok(`SELECT coalesce((SELECT last FROM doc_counters WHERE organization_id='${A}' AND prefix='DLN'),0)`));
const call=(request:string,qty=1,job=J)=>`SELECT create_job_delivery_note('${job}','${C}','${request}',CURRENT_DATE,CURRENT_DATE,'Synthetic van',NULL,'[{"description":"Synthetic bracket","quantity":${qty}}]'::jsonb)::text`;
beforeAll(async()=>{
 await db.start();console.log(`147 evidence: ${db.evidence}`);db.ok(readFileSync('tests/reviews/release147/bootstrap.sql','utf8'));
 const files=execFileSync('git',['ls-tree','--name-only','9d7725e:supabase/migrations'],{encoding:'utf8'}).trim().split('\n').filter(s=>/^\d{3}_.*\.sql$/.test(s)).sort();for(const f of files)db.ok(source('supabase/migrations/'+f));
 db.ok(`INSERT INTO organizations(id,name,slug) VALUES('${A}','Synthetic A','t-r147-a'),('${B}','Synthetic B','t-r147-b');INSERT INTO auth.users(id,email) VALUES('${U}','r147@example.test');
 INSERT INTO user_profiles(id,email,role,organization_id,active,must_change_password) VALUES('${U}','r147@example.test','admin','${A}',true,false);INSERT INTO organization_members(user_id,organization_id,role,active) VALUES('${U}','${A}','admin',true);
 INSERT INTO customers(id,organization_id,name) VALUES('${C}','${A}','Synthetic Goods');INSERT INTO jobs(id,organization_id,job_no,customer,description,stage,finished_at,inspected_at) VALUES('${J}','${A}','J-SYN-A','Synthetic Goods','Synthetic bracket','complete',now(),now()),('${K}','${B}','J-SYN-B','Other Goods','Synthetic bracket','complete',now(),now());
 INSERT INTO stock(organization_id,sku,material) VALUES('${A}','SYN-A','Synthetic steel'),('${B}','SYN-B','Synthetic steel');`);
 for(const f of ['145_company_setup','146_tolra_provided_ai','147_job_delivery_note'])db.ok(source(`supabase/release/${f}.release.sql`));
});
afterAll(()=>db.stop());
it('147-01 current verifier executes 16 true rows; original public verifier had 11 SELECT rows',()=>{
 const rows=db.ok(source('supabase/verify/job_delivery_note_147.sql')).split('\n');expect(rows).toHaveLength(16);expect(rows.every(r=>r.endsWith('|t'))).toBe(true);
 const original=source('supabase/verify/job_delivery_note_147.sql','9e1a82c');expect((original.match(/^UNION ALL SELECT /gm)||[]).length+1).toBe(11);
});
it('147-02 both blank and typed manual numbers refuse while held, without burning a number',()=>{
 const before=hold(),counter=last();for(const number of ['NULL',"'DLN-9999'"]){const r=q(`INSERT INTO delivery_notes(organization_id,customer,dn_number) VALUES('${A}','Synthetic Goods',${number})`);expect(r.code).not.toBe(0);expect(r.error).toContain('dln_numbering_not_set');}expect(hold()).toBe(before);expect(last()).toBe(counter);
});
it('147-03 fixture wipe preserves the real hold table, both rows/timestamps and other-company stock',()=>{
 const before=hold(),other=db.ok(`SELECT jsonb_agg(s)::text FROM stock s WHERE organization_id='${B}'`);
 db.ok(`BEGIN;DELETE FROM stock WHERE organization_id='${A}';DO $$BEGIN IF (SELECT count(*) FROM dln_numbering_pending)<>2 THEN RAISE EXCEPTION 'KEEP hold violation';END IF;END$$;COMMIT;`);
 expect(hold()).toBe(before);expect(db.ok(`SELECT jsonb_agg(s)::text FROM stock s WHERE organization_id='${B}'`)).toBe(other);
 const wrong=db.sql(`BEGIN;DELETE FROM dln_numbering_pending WHERE organization_id='${A}';DO $$BEGIN IF (SELECT count(*) FROM dln_numbering_pending)<>2 THEN RAISE EXCEPTION 'KEEP hold violation';END IF;END$$;COMMIT;`);expect(wrong.code).not.toBe(0);expect(hold()).toBe(before);
});
it('147-04 real counter step releases only A; next_doc_number supplies the next DLN',()=>{
 db.ok('\\set company_slug t-r147-a\n\\set last_pad_number 100\n'+source('supabase/cutover/set_dln_next_number.sql'));
 expect(db.ok(`SELECT count(*) FROM dln_numbering_pending WHERE organization_id='${A}'`)).toBe('0');expect(db.ok(`SELECT count(*) FROM dln_numbering_pending WHERE organization_id='${B}'`)).toBe('1');
 expect(q("SELECT next_doc_number('DLN')").output).toContain('DLN-0101');expect(last()).toBe(101);
 const r=q(`INSERT INTO delivery_notes(organization_id,customer,dn_number) VALUES('${A}','Synthetic Goods','DLN-9999')`);expect(r.error).toContain('dn_number_from_counter');expect(last()).toBe(101);
});
it('147-05 request_id replays exactly once, keeps its number and rejects a changed retry',()=>{
 const id=randomUUID(),counter=last(),first=json(call(id)),again=json(call(id));expect(first.replayed).toBe(false);expect(again).toMatchObject({id:first.id,dn_number:first.dn_number,replayed:true});expect(last()).toBe(counter+1);
 expect(q(call(id,2)).error).toContain('request_mismatch');expect(last()).toBe(counter+1);expect(db.ok(`SELECT count(*) FROM delivery_notes WHERE request_id='${id}'`)).toBe('1');
});
it('147-06 concurrent double submit shares one note and burns one number',async()=>{
 const id=randomUUID(),counter=last(),r=await Promise.all([db.parallelSql(auth(call(id))),db.parallelSql(auth(call(id)))]);expect(r.every(x=>x.code===0)).toBe(true);
 const values=r.map(x=>JSON.parse(x.output.split('\n').find(s=>s.startsWith('{')&&!s.includes('"sub"'))!));expect(new Set(values.map(x=>x.id)).size).toBe(1);expect(last()).toBe(counter+1);expect(db.ok(`SELECT count(*) FROM delivery_notes WHERE request_id='${id}'`)).toBe('1');
});
it('147-07 another company’s job cannot consume its counter or lose its hold',()=>{
 const before=hold(),counter=last(),r=q(call(randomUUID(),1,K));expect(r.code).not.toBe(0);expect(hold()).toBe(before);expect(last()).toBe(counter);expect(db.ok(`SELECT count(*) FROM delivery_notes WHERE organization_id='${B}'`)).toBe('0');
});
