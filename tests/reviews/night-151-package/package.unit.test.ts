import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
// Frozen bytes reviewed at PR421 head 656a793; no generated registration/digest update.
export const HASHES={
 'supabase/proposals/p151_xero_invite_hardening.sql':'d098a91bcb3ca157f19ced6cf2ed3ff7c5a53b94895e805d2a4c94682aa0bbe8',
 'supabase/release/151_xero_invite_hardening.release.sql':'98d95110214b15645d92ea4cbe9ad3865e6bef468f1af2d95b06a08cf4d6be5e',
 'supabase/release/151_xero_invite_hardening.rollback.sql':'61b9842c71d24f93bb19f4170b98121f46472464e8206dc64e0700d238774690',
 'supabase/verify/xero_invite_hardening_151.sql':'cf06251d2199e43afa88103d365c9e4a0ffc24eef6364a90d362f8a73ef9d4a3',
};
it.each(Object.entries(HASHES))('reviewed 151 file bytes are pinned: %s',(file,hash)=>expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash));
it('151 is absent from every automatic release-plan section and numbered migrations',()=>{
 const plan=JSON.parse(readFileSync('supabase/release-plan.json','utf8'));
 expect([...plan.jnr_cutover_numbered_order,...plan.phases].some(p=>p.number===151)).toBe(false);
 expect(readdirSync('supabase/migrations').some(f=>/^151_/.test(f))).toBe(false);
});
