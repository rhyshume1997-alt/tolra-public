import {expect,it} from 'vitest';
import {priceThisPart} from '@/lib/costing/price-part';
import {CONFIGURED,ENTRY} from './costing-fixtures';
it.each([
 ['quantity above engine limit',{quantity:1000001}],['non-finite material',{amountPerPart:Infinity}],['non-finite cycle',{cycleHours:Infinity}],
 ['negative setup',{setupHours:-1}],['non-finite setup',{setupHours:NaN}],['negative programming',{programmingHours:-1}],
 ['non-finite programming',{programmingHours:Infinity}],['overflowing finite cycle',{cycleHours:Number.MAX_VALUE}],
] as const)('panel refuses %s with a usable message rather than throwing',(_name,change)=>{
 const r=priceThisPart(CONFIGURED,{...ENTRY,...change});expect(r.status).toBe('need_input');
});
it.each(['material','machine'] as const)('refuses stale explicit %s ID rather than pricing the first different row',kind=>{
 const r=priceThisPart(CONFIGURED,{...ENTRY,[kind==='material'?'materialId':'machineId']:'deleted-synthetic-id'});expect(r.status).toBe('need_input');
});
it('invalid rate input stays unconfigured, never crashes or substitutes a rate',()=>{
 const rates=structuredClone(CONFIGURED);rates.machines[0].hourlyRate=-1;expect(priceThisPart(rates,ENTRY).status).toBe('not_set_up');
});
