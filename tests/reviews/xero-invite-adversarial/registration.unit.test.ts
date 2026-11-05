/** Registration checks run only when an actual source tree containing 151 is selected, not against main as a stand-in. */
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {expect,it} from 'vitest';
const root=path.resolve(process.env.XERO_INVITE_SOURCE_ROOT??'.');
it('151 is registered after 150 with real release, verification and rollback files and a preflight marker',()=>{
 const plan=JSON.parse(readFileSync(path.join(root,'supabase/release-plan.json'),'utf8')) as {phases:Array<{number:number;after:string;release:string;verify:string;rollback:string;marker:string}>};
 const phase=plan.phases.find(p=>p.number===151);expect(phase,'151 has no release-plan entry; publishing SQL alone is not registration').toBeDefined();if(!phase)throw Error('No 151 source selected');
 expect(phase.after).toBe('150');expect(plan.phases.findIndex(p=>p.number===151)).toBeGreaterThan(plan.phases.findIndex(p=>p.number===150));
 for(const file of [phase.release,phase.verify,phase.rollback]){expect(file).toMatch(/^supabase\/(release|verify)\//);expect(existsSync(path.join(root,file))).toBe(true);expect(readFileSync(path.join(root,file),'utf8').trim().length).toBeGreaterThan(0);}
 expect(phase.marker.length).toBeGreaterThan(0);expect(readFileSync(path.join(root,'supabase/verify/release_preflight.sql'),'utf8')).toContain(phase.marker);
});
