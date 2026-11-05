import {expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {EMPTY_SNAPSHOT,ratesProblem,saveRates} from '@/lib/costing/app-rates';
import {CONFIGURED} from './costing-fixtures';
it.each(['material','machine'] as const)('case-insensitive duplicate %s names refuse locally with a clear error and no save',async kind=>{
 const rates=structuredClone(CONFIGURED);
 if(kind==='material')rates.materials.push({...rates.materials[0],id:'99999999-1111-4111-8111-111111111111',name:' '+rates.materials[0].name.toUpperCase()+' '});
 else rates.machines.push({...rates.machines[0],id:'99999999-2222-4222-8222-222222222222',name:' '+rates.machines[0].name.toUpperCase()+' '});
 expect(ratesProblem(rates)).toBe(`Two ${kind==='material'?'materials':'machines'} have the same name.`);
 const rpc=vi.fn();const answer=await saveRates({rpc} as unknown as SupabaseClient,'synthetic-org',EMPTY_SNAPSHOT,rates);
 expect(answer).toMatchObject({ok:false,status:400,body:{kind:'invalid',message:`Two ${kind==='material'?'materials':'machines'} have the same name.`}});expect(rpc).not.toHaveBeenCalled();
});
it('same name in separate material and machine lists remains valid',()=>{
 const rates=structuredClone(CONFIGURED);rates.machines[0].name=rates.materials[0].name;expect(ratesProblem(rates)).toBeNull();
});
it.each(['scrap','overhead','margin'] as const)('%s percentage with three decimals explains two-place precision before any RPC',async slot=>{
 const rates=structuredClone(CONFIGURED);if(slot==='scrap')rates.materials[0].scrapPct=1.001;else if(slot==='overhead')rates.defaults.overheadPct=100.001;else rates.defaults.marginPct=1.001;
 expect(ratesProblem(rates)).toContain('up to 2 decimal places');
 const rpc=vi.fn();const answer=await saveRates({rpc} as unknown as SupabaseClient,'synthetic-org',EMPTY_SNAPSHOT,rates);
 expect(answer).toMatchObject({ok:false,status:400,body:{kind:'invalid',message:expect.stringContaining('up to 2 decimal places')}});expect(rpc).not.toHaveBeenCalled();
});
it.each([0,0.01,12.34,95])('valid percentage %s is accepted at permitted precision',value=>{
 const rates=structuredClone(CONFIGURED);rates.materials[0].scrapPct=value;rates.defaults.marginPct=value;rates.defaults.overheadPct=100+value;expect(ratesProblem(rates)).toBeNull();
});
it.each([NaN,Infinity,-0.01,100.01])('out-of-range scrap %s keeps range refusal and precision guidance',value=>{
 const rates=structuredClone(CONFIGURED);rates.materials[0].scrapPct=value;expect(ratesProblem(rates)).toContain('0 to 100');expect(ratesProblem(rates)).toContain('2 decimal places');
});
