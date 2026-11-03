import {createHash} from 'node:crypto';
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {checkReleasePlan} from '../../scripts/check-release-plan.mjs';
const root=path.resolve(__dirname,'../..'),copies:string[]=[];
const read=(file:string)=>readFileSync(path.join(root,file),'utf8');
afterEach(()=>{for(const copy of copies.splice(0))rmSync(copy,{recursive:true,force:true});});
function copy(){const dir=mkdtempSync(path.join(tmpdir(),'chase-147-'));copies.push(dir);cpSync(path.join(root,'supabase'),path.join(dir,'supabase'),{recursive:true});return dir;}
it('pins the unchanged atomic function body and every reviewed package checksum',()=>{
 expect(checkReleasePlan(root)).toEqual([]);
 const hashes=JSON.parse(read('supabase/release/147_chase_settings_atomic.checksums.json'));
 for(const [file,hash] of Object.entries(hashes.sha256))expect(createHash('sha256').update(read(file)).digest('hex')).toBe(hash);
 const body=read('supabase/proposals/builder2_chase_settings_atomic.sql').split('AS $$')[1].split('$$;')[0];
 expect(createHash('md5').update(body.replace(/\s/g,'')).digest('hex')).toBe('63145f3026fdc7db5dc1ba0a5928177a');
});
it.each(['post-144 marker 147 chase_settings_atomic','supabase/proposals/builder2_chase_settings_atomic.sql'])('fails if %s disappears from preflight',missing=>{
 const dir=copy(),file=path.join(dir,'supabase/verify/release_preflight.sql');writeFileSync(file,readFileSync(file,'utf8').replaceAll(missing,'removed'));
 const problems=checkReleasePlan(dir);
 expect(problems).toContain(missing.startsWith('post-')?`Release marker missing: ${missing}`:`Proposal missing from release preflight: ${missing}`);
});
it('refuses a changed release artifact even if the canonical function is still present',()=>{
 const dir=copy(),file=path.join(dir,'supabase/release/147_chase_settings_atomic.release.sql');writeFileSync(file,readFileSync(file,'utf8')+'\n-- changed reviewed input\n');
 expect(checkReleasePlan(dir)).toContain('Release checksum mismatch: supabase/release/147_chase_settings_atomic.release.sql');
});
it('requires the entire frozen 138 verification before a one-time CREATE and verifies before COMMIT',()=>{
 const release=read('supabase/release/147_chase_settings_atomic.release.sql'),verify=read('supabase/verify/chase_steps_138.sql').trim().slice(0,-1);
 expect(release).toContain(verify);expect(release).toContain('expected all 12 frozen 138 verification checks');
 expect(release.indexOf('FOR v_check IN')).toBeLessThan(release.indexOf('CREATE FUNCTION public.save_chase_steps_atomic'));
 expect(release).toContain('already exist; stop, never overwrite');expect(release).not.toContain('CREATE OR REPLACE');
 expect(release.indexOf('147 self-check failed')).toBeLessThan(release.lastIndexOf('COMMIT;'));
});
it('rollback removes only the matching RPC and never changes saved rows or grants a partial-save fallback',()=>{
 const rollback=read('supabase/release/147_chase_settings_atomic.rollback.sql').replace(/^--.*$/gm,'');
 expect(rollback).toContain('function absent or differs; stop and review');
 expect(rollback.match(/^DROP FUNCTION .+$/gm)).toEqual(['DROP FUNCTION public.save_chase_steps_atomic(uuid,jsonb,jsonb);']);
 expect(rollback).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE|CASCADE|ALTER TABLE)\b/);
});
it('keeps costing atomic settings out because costing 143 is not in this candidate',()=>{
 const plan=JSON.parse(read('supabase/release-plan.json'));
 expect(plan.phases.map((p:{number:number})=>p.number)).toEqual([145,146,147]);
 expect(plan.other_proposals.find((p:{source:string})=>p.source.endsWith('builder2_costing_settings_atomic.sql')).disposition).toContain('143, absent');
 expect(read('supabase/release/147_chase_settings_atomic.release.sql')).not.toContain('save_costing_settings_atomic');
});
