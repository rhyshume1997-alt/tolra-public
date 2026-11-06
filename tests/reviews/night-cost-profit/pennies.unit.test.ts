import {expect,it} from 'vitest';
import {fromStored,toRpcValue} from '@/lib/costing/app-rates';
import {priceThisPart} from '@/lib/costing/price-part';
import {linePence,toPence} from '@/lib/money';
import {pyRound} from '@/lib/costing/engine';
import {CONFIGURED,ENTRY} from '@/tests/unit/costing-fixtures';
it('143 rates round trip every whole penny through the app without drifting',()=>{
 for(let p=0;p<=10000;p++){
  const input={materials:[{id:CONFIGURED.materials[0].id,name:'Synthetic',updatedAt:null,pricePence:p,priceUnit:'kg' as const,scrapPct:0}],machines:[{id:CONFIGURED.machines[0].id,name:'Synthetic',updatedAt:null,hourlyRatePence:p,labourRatePence:null}],defaults:{updatedAt:null,labourRatePence:p,programmingRatePence:p,overheadPct:100,defaultMarginPct:0}};
  const out=toRpcValue(fromStored(input).rates);expect([out.materials[0].price_pence,out.machines[0].hourly_rate_pence,out.defaults.labour_rate_pence,out.defaults.programming_rate_pence]).toEqual([p,p,p,p]);
 }
});
it.each([1,3,7,99,1000000])('copied unit price times quantity %s matches integer-pence quote preview',quantity=>{const r=priceThisPart(CONFIGURED,{...ENTRY,quantity});expect(r.status).toBe('ok');if(r.status!=='ok')throw Error('No price');expect(toPence(r.figures.extendedPrice)).toBe(linePence(quantity,r.figures.unitPrice));});
it('the engine half-even exception stays deliberate while document money uses penny halves up',()=>{expect(pyRound(0.125,2)).toBe(0.12);expect(toPence(0.125)).toBe(13);expect(toPence(0.135)).toBe(14);});
