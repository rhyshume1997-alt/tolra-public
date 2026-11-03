import { describe, expect, it, vi } from 'vitest';
import { saveAtomicCosting } from '@/lib/costing/atomic-settings';
import { mapCostingRates } from '@/components/costing/connected-costing';
import { operationLabourRate } from '@/components/costing/price-this-part';
import type { CostingRates } from '@/lib/costing/rates-store';

const saved: CostingRates = { enabled:true, materials:[{id:'material',name:'Steel',pricePence:123,priceUnit:'kg',scrapPct:5,updatedAt:null}], machines:[{id:'mill',name:'Mill',hourlyRatePence:6000,labourRatePence:1234,updatedAt:null}],defaults:{labourRatePence:2500,programmingRatePence:7500,overheadPct:150,defaultMarginPct:20,updatedAt:null}};
describe('reviewer atomic costing requirements',()=>{
 for(const field of ['company labour','programming','material','machine','machine labour']) {
  it(`rejects fractional pennies in ${field} before any database call`,async()=>{
   const draft=mapCostingRates(saved),db={rpc:vi.fn(),from:vi.fn()};
   if(field==='company labour')draft.labourPerHour=1.005;
   if(field==='programming')draft.programmingPerHour=1.005;
   if(field==='material')draft.materials[0].price=1.005;
   if(field==='machine')draft.machines[0].hourlyRate=1.005;
   if(field==='machine labour')draft.machines[0].labourPerHour=1.005;
   await expect(saveAtomicCosting(db as never,'company-a',saved,draft)).rejects.toThrow(/pounds and pence/);
   expect(db.rpc).not.toHaveBeenCalled();expect(db.from).not.toHaveBeenCalled();
  });
 }
 for(const rate of [null,0,1234])it(`keeps machine labour ${rate} through display, save and pricing`,async()=>{
  const stored={...saved,machines:[{...saved.machines[0],labourRatePence:rate}]},draft=mapCostingRates(stored),db={rpc:vi.fn().mockResolvedValue({error:null}),from:vi.fn()};
  await saveAtomicCosting(db as never,'company-a',stored,draft);
  expect(db.rpc).toHaveBeenCalledTimes(1);expect(db.from).not.toHaveBeenCalled();
  expect(db.rpc.mock.calls[0][1].p_value.machines[0].labour_rate_pence).toBe(rate);
  expect(operationLabourRate(draft.machines[0],draft.labourPerHour)).toBe(rate===null?25:rate/100);
 });
 it('sends deletions and additions in the same request and never falls back after failure',async()=>{
  const draft=mapCostingRates(saved);draft.materials=[];draft.machines.push({id:'new',name:'Lathe',hourlyRate:80,labourPerHour:0});
  const before = structuredClone(saved);
  const draftBefore = structuredClone(draft);
  const db={rpc:vi.fn().mockResolvedValue({error:{code:'42501'}}),from:vi.fn()};
  await expect(saveAtomicCosting(db as never,'company-a',saved,draft)).rejects.toThrow(/Could not save/);
  expect(saved).toEqual(before);expect(draft).toEqual(draftBefore);
  expect(db.rpc).toHaveBeenCalledTimes(1);expect(db.from).not.toHaveBeenCalled();
  const args=db.rpc.mock.calls[0][1];expect(args.p_expected.materials).toHaveLength(1);expect(args.p_value.materials).toEqual([]);expect(args.p_value.machines).toHaveLength(2);
 });
});
