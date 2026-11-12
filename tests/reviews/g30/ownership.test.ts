import { execFileSync,spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { Disposable } from './disposable';
import { compareSnapshots,type Snapshot } from './compare.mjs';
const db=new Disposable(),J='11111111-1111-4111-8111-111111111111',M='22222222-2222-4222-8222-222222222222';
const options={jnr:J,disposition:'WIPE',expectedJnrBefore:41};
const query=readFileSync('tests/reviews/g30/snapshot.sql','utf8');
const snapshot=()=>JSON.parse(db.ok(query)) as Snapshot;
beforeAll(async()=>{
 await db.start();console.log(`G30 evidence: ${db.evidence}`);
 db.ok(`CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${J}'),('${M}')`);
 const base=execFileSync('git',['show','68f89ca7b801a10587ff9b51d6c820462847b65a:supabase/migrations/101_ai_helper.sql'],{encoding:'utf8'});
 db.ok(base.slice(base.indexOf('CREATE TABLE IF NOT EXISTS public.ai_helper_requests'),base.indexOf('CREATE INDEX IF NOT EXISTS idx_ai_helper_requests_org')));
 db.ok(`CREATE ROLE authenticated;GRANT SELECT ON ai_helper_requests TO authenticated;ALTER TABLE ai_helper_requests ENABLE ROW LEVEL SECURITY;CREATE POLICY synthetic_jnr_read ON ai_helper_requests FOR SELECT TO authenticated USING(organization_id='${J}')`);
});
beforeEach(()=>db.ok(`DELETE FROM ai_helper_requests WHERE true;INSERT INTO ai_helper_requests(organization_id,user_id,feature,month,status,input_digest,input_bytes)
 SELECT org,gen_random_uuid(),'roundup',date_trunc('month',now())::date,'refused',repeat('a',64),0 FROM (VALUES('${J}'::uuid),('${M}'::uuid)) c(org) CROSS JOIN generate_series(1,41)`));
afterAll(()=>db.stop());
it('records all 82 identities and per-company counts with no content in the read-only manifest',()=>{
 const a=snapshot();expect(a.total).toBe(82);expect(a.counts).toEqual({[J]:41,[M]:41});expect(a.rows).toHaveLength(82);
 expect(Object.keys(a.rows[0]).sort()).toEqual(['id','organization_id','row_sha256']);
});
it('lists every one of 41 expected JNR removals and proves Marpet identities/hashes unchanged',()=>{
 const before=snapshot();db.ok(`DELETE FROM ai_helper_requests WHERE organization_id='${J}'`);const after=snapshot();
 const result=compareSnapshots(before,after,options);expect(result.ok).toBe(true);expect(result.difference_count).toBe(41);
 expect(result.differences.every(d=>d.kind==='removed'&&d.before_company===J&&d.expected)).toBe(true);
 writeFileSync(path.join(db.evidence,'synthetic-before.json'),JSON.stringify(before));writeFileSync(path.join(db.evidence,'synthetic-after.json'),JSON.stringify(after));
 writeFileSync(path.join(db.evidence,'synthetic-all-differences.json'),JSON.stringify(result,null,2));
});
it('rejects 41 to 0 for Marpet, listing all 41 wrong-company removals',()=>{
 const a=snapshot();db.ok(`DELETE FROM ai_helper_requests WHERE organization_id='${M}'`);const r=compareSnapshots(a,snapshot(),options);
 expect(r.ok).toBe(false);expect(r.differences.filter(d=>d.before_company===M&&!d.expected)).toHaveLength(41);
});
it('detects a company ownership move even when the record ID survives',()=>{
 const a=snapshot(),id=a.rows.find(r=>r.organization_id===J)!.id;db.ok(`UPDATE ai_helper_requests SET organization_id='${M}' WHERE id='${id}'`);
 const r=compareSnapshots(a,snapshot(),options);expect(r.ok).toBe(false);expect(r.differences).toContainEqual(expect.objectContaining({kind:'owner_changed',id,before_company:J,after_company:M,expected:false}));
});
it('rejects replaced records even when both company counts are unchanged',()=>{
 const a=snapshot(),id=a.rows.find(r=>r.organization_id===M)!.id;db.ok(`UPDATE ai_helper_requests SET id=gen_random_uuid() WHERE id='${id}'`);
 const r=compareSnapshots(a,snapshot(),{jnr:J,disposition:'KEEP'});expect(r.company_counts.every(c=>c.ok)).toBe(true);expect(r.ok).toBe(false);expect(r.differences.map(d=>d.kind).sort()).toEqual(['added','removed']);
});
it('detects changed row content with the same ID, owner and counts',()=>{
 const a=snapshot(),id=a.rows.find(r=>r.organization_id===M)!.id;db.ok(`UPDATE ai_helper_requests SET input_bytes=1 WHERE id='${id}'`);
 const r=compareSnapshots(a,snapshot(),{jnr:J,disposition:'KEEP'});expect(r.ok).toBe(false);expect(r.differences).toEqual([expect.objectContaining({kind:'row_changed',id,expected:false})]);
});
it('rejects mismatched counts, duplicate IDs and wrong expected baseline',()=>{
 const a=snapshot();expect(()=>compareSnapshots({...a,total:0},a,options)).toThrow(/Count/);
 expect(()=>compareSnapshots({...a,rows:[...a.rows,a.rows[0]]},a,options)).toThrow(/duplicate/);
 expect(compareSnapshots(a,a,{jnr:J,disposition:'KEEP',expectedJnrBefore:40}).baseline_count_ok).toBe(false);
});
it('refuses a tenant-filtered capture rather than silently accepting an incomplete manifest',()=>{
 const r=db.sql(`SET ROLE authenticated;${query}`);expect(r.code).not.toBe(0);expect(r.error).toContain('row-level security');
});
it('CLI returns failure and all differences, with no database connection',()=>{
 const a=snapshot();db.ok(`DELETE FROM ai_helper_requests WHERE organization_id='${M}'`);
 const before=path.join(db.evidence,'cli-before.json'),after=path.join(db.evidence,'cli-after.json');writeFileSync(before,JSON.stringify(a));writeFileSync(after,JSON.stringify(snapshot()));
 const r=spawnSync(process.execPath,['tests/reviews/g30/compare.mjs',before,after,'--jnr',J,'--disposition','WIPE','--expected-jnr-before','41'],{encoding:'utf8'});
 expect(r.status).toBe(1);expect(JSON.parse(r.stdout).difference_count).toBe(41);
});
