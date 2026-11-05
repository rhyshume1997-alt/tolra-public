import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
// Frozen fixed bytes from own PR423 and this verifier change; original review at PR421 head 656a793; no generated registration/digest update.
export const HASHES={
 'supabase/proposals/p151_xero_invite_hardening.sql':'ea6e9b980bc0aec9d56738168d909ecf5475d1c3af823ce25595f83da2d12adf',
 'supabase/release/151_xero_invite_hardening.release.sql':'2d8091fe31e5f056fecff163a22070cd07e52cc61f90ce1528d4c8ed14451b3e',
 'supabase/release/151_xero_invite_hardening.rollback.sql':'cffe620ad870a6fcfa4b35d1057afd2ac404c2afc939042578fdef67c67b8529',
 'supabase/verify/xero_invite_hardening_151.sql':'1d431dffd3277248bb17265503124c820b452cceba862791bb24c959695abe2f',
};
it.each(Object.entries(HASHES))('reviewed 151 file bytes are pinned: %s',(file,hash)=>expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash));
it('151 is absent from every automatic release-plan section and numbered migrations',()=>{
 const plan=JSON.parse(readFileSync('supabase/release-plan.json','utf8'));
 expect([...plan.jnr_cutover_numbered_order,...plan.phases].some(p=>p.number===151)).toBe(false);
 expect(readdirSync('supabase/migrations').some(f=>/^151_/.test(f))).toBe(false);
});
