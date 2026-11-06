/** PM boundary: 151 remains a proposal, never a numbered or automatically ordered production migration. */
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {expect,it} from 'vitest';
const root=path.resolve(process.env.XERO_INVITE_SOURCE_ROOT??'.');
it('151 stays a proposal outside the production release plan and numbered migrations, with review-only verification and rollback files',()=>{
 const plan=JSON.parse(readFileSync(path.join(root,'supabase/release-plan.json'),'utf8')) as {phases:Array<{number:number}>};
 expect(plan.phases.some(p=>p.number===151)).toBe(false);
 expect(readdirSync(path.join(root,'supabase/migrations')).some(f=>f.startsWith('151_'))).toBe(false);
 for(const file of ['supabase/proposals/p151_xero_invite_hardening.sql','supabase/release/151_xero_invite_hardening.release.sql','supabase/verify/xero_invite_hardening_151.sql','supabase/release/151_xero_invite_hardening.rollback.sql']){expect(existsSync(path.join(root,file))).toBe(true);expect(readFileSync(path.join(root,file),'utf8').trim().length).toBeGreaterThan(0);}
});
