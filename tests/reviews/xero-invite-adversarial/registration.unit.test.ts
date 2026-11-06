/** PM boundary: 151 remains a proposal, never a numbered or automatically ordered production migration. */
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {expect,it} from 'vitest';
const root=path.resolve(process.env.XERO_INVITE_SOURCE_ROOT??'.');
it('Code approved151 is registered once immediately after150, with matching release files and no numbered migration',()=>{
 const plan=JSON.parse(readFileSync(path.join(root,'supabase/release-plan.json'),'utf8')) as {phases:Array<{number:number}>};
 expect(plan.phases.filter(p=>p.number===151)).toHaveLength(1);
 expect(plan.phases.findIndex(p=>p.number===151)).toBe(plan.phases.findIndex(p=>p.number===150)+1);
 expect(plan.phases.find(p=>p.number===151)).toMatchObject({after:'150'});
 expect(readdirSync(path.join(root,'supabase/migrations')).some(f=>f.startsWith('151_'))).toBe(false);
 for(const file of ['supabase/proposals/p151_xero_invite_hardening.sql','supabase/release/151_xero_invite_hardening.release.sql','supabase/verify/xero_invite_hardening_151.sql','supabase/release/151_xero_invite_hardening.rollback.sql']){expect(existsSync(path.join(root,file))).toBe(true);expect(readFileSync(path.join(root,file),'utf8').trim().length).toBeGreaterThan(0);}
});
