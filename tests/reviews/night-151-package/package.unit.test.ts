import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
// Frozen combined review bytes: accepted147ac28 + #437396b887 + #438/#439 + existing151 expiry/rollback guards. Registration is unchanged.
export const HASHES={
 'supabase/proposals/p151_xero_invite_hardening.sql':'49bcbc4f996ef36c6691cddf8856415d8c28a462605b244b28febaadbde560b7',
 'supabase/release/151_xero_invite_hardening.release.sql':'a782e0429be9de31e43d36ace19d099287a4ea4fef562a63b2bb70ff9516cb48',
 'supabase/release/151_xero_invite_hardening.rollback.sql':'7a6d0ebee0a23f280a4ae289cfddcc2d78f835269979a9aeee994ce0515cc965',
 'supabase/verify/xero_invite_hardening_151.sql':'1d431dffd3277248bb17265503124c820b452cceba862791bb24c959695abe2f',
};
it.each(Object.entries(HASHES))('reviewed 151 file bytes are pinned: %s',(file,hash)=>expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash));
it('Code approved151 follows150 exactly once in the release plan, without a numbered migration',()=>{
 const plan=JSON.parse(readFileSync('supabase/release-plan.json','utf8'));
 expect(plan.phases.filter((p:{number:number})=>p.number===151)).toHaveLength(1);
 expect(plan.phases.findIndex((p:{number:number})=>p.number===151)).toBe(plan.phases.findIndex((p:{number:number})=>p.number===150)+1);
 expect(plan.phases.find((p:{number:number})=>p.number===151)).toMatchObject({after:'150'});
 expect(plan.jnr_cutover_numbered_order.some((p:{number:number})=>p.number===151)).toBe(false);
 expect(readdirSync('supabase/migrations').some(f=>/^151_/.test(f))).toBe(false);
});
