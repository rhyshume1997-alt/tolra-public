import { describe, it, expect } from 'vitest';
import { mapCostingRates } from '../../components/costing/connected-costing';
import type { CostingRates as SavedRates } from '../../lib/costing/rates-store';
describe('costing store conversion for in app cards',()=>{
 const rates:SavedRates={enabled:true,materials:[{id:'a',name:'Steel',pricePence:525,priceUnit:'kg',scrapPct:5,updatedAt:null}],machines:[{id:'m',name:'Mill',hourlyRatePence:8500,labourRatePence:null,updatedAt:null}],defaults:{labourRatePence:3000,programmingRatePence:7500,overheadPct:150,defaultMarginPct:20,updatedAt:null}};
 it('converts pence to pounds for display',()=>expect(mapCostingRates(rates).materials[0].price).toBe(5.25));
 it('converts the machine rate correctly',()=>expect(mapCostingRates(rates).machines[0].hourlyRate).toBe(85));
 it('converts overhead multiplier to extra percentage',()=>expect(mapCostingRates(rates).overheadPct).toBe(50));
 it('preserves margin percentage',()=>expect(mapCostingRates(rates).marginPct).toBe(20));
 it('uses stored labour and programming rate',()=>expect(mapCostingRates(rates).programmingPerHour).toBe(75));
 it('does not assume rates exist when arrays are empty',()=>expect(mapCostingRates({...rates,materials:[],machines:[]}).materials).toEqual([]));
});