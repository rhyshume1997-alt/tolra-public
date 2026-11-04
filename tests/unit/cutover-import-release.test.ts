import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {checkCutoverImports} from '../../scripts/check-cutover-imports.mjs';
const root=path.resolve(__dirname,'../..'),copies:string[]=[];
afterEach(()=>copies.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function copy(){const dir=mkdtempSync(path.join(tmpdir(),'ca-imports-'));copies.push(dir);cpSync(path.join(root,'supabase'),path.join(dir,'supabase'),{recursive:true});return dir;}
it('pins both packages and the required JNR cutover order',()=>{expect(checkCutoverImports(root)).toEqual([]);});
it.each(['140 import source ref','141 opening wip'])('fails when %s is missing from preflight',marker=>{
 const dir=copy(),p=path.join(dir,'supabase/verify/release_preflight.sql');writeFileSync(p,readFileSync(p,'utf8').replaceAll(marker,'removed'));
 expect(checkCutoverImports(dir)).toContain(`Missing preflight marker: ${marker}`);
});
it('refuses altered verification or an unexpected cutover order',()=>{
 const dir=copy(),p=path.join(dir,'supabase/cutover-import-plan.json'),plan=JSON.parse(readFileSync(p,'utf8'));plan.requiredCutoverOrder=[138,144,140,141,145,146];writeFileSync(p,JSON.stringify(plan));
 expect(checkCutoverImports(dir)).toContain('Required cutover order differs');
 const file='supabase/verify/opening_wip_141.sql';writeFileSync(path.join(dir,file),'SELECT true;');expect(checkCutoverImports(dir)).toContain(`Checksum differs: ${file}`);
});
it('141 rollback refuses nonempty WIP before its DROP',()=>{
 const s=readFileSync(path.join(root,'supabase/release/141_opening_wip.rollback.sql'),'utf8');
 expect(s.indexOf('IF EXISTS(SELECT 1 FROM public.opening_wip)')).toBeLessThan(s.indexOf('DROP TABLE'));
 expect(s).toContain('141 rollback refused: opening WIP exists');
});
it('keeps every old post-baseline proof and prepares SliQ first without excluding files',async()=>{
 const {post144ProofFiles}=await import('../support/db-release-sequencer');
 expect(post144ProofFiles).toEqual(['sliq-import-company-isolation.test.ts','company-setup-isolation.test.ts','tolra-provided-ai.test.ts','tolra-ai-cap-concurrency.test.ts']);
});
