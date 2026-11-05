import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as purchasing from '@/lib/purchase-order-link';
import {actualJobProfit,type ActualCostInputs,type CostTimer} from '@/lib/job-profitability-actuals';
import {jobProgress,type RemainingWork} from '@/lib/job-profitability-progress';
const source=readFileSync('tests/reviews/profitability-combined/fixtures/actuals-ccd74ea.ts.txt','utf8');
const exports:Record<string,unknown>={};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(id:string)=>{if(id==='@/lib/purchase-order-link')return purchasing;throw Error('Unexpected oracle import');}});
const before=exports.actualJobProfit as typeof actualJobProfit;
const timer = (id: string, start = '08:00', end: string | null = '09:00'): CostTimer => ({ id, organization_id: 'org', job_id: 'job', user_id: 'worker', machine_id: 'mill', operator_id: 'worker', started_at: `2026-11-04T${start}:00Z`, ended_at: end ? `2026-11-04T${end}:00Z` : null });
const fixture = (): ActualCostInputs => ({ organizationId: 'org', jobId: 'job', config: { enabled: true, revision: 1, approved_at: '2026-11-04', labour_rate_pence: 2000, overhead_basis: 'labour', overhead_rate_pence: 500 }, rates: [{ machine_id: 'mill', rate_pence: 3000, includes_labour: false, includes_overhead: false }], labour: [timer('l')], machines: [timer('m')], plans: [{ machine_id: 'mill', estimated_hours: 1 }], estimate: { supplier_pence: 1000, labour_hours: 1, overhead_hours: 1, labour_not_required: false, machines_not_required: false }, pos: [{ id: 'po', total_value: '100.00', linked_net: '10.00', status: 'sent' }], invoices: [{ id: 'invoice', status: 'sent', subtotal: '200.00' }], credits: [{ invoice_id: 'invoice', status: 'issued', subtotal: '10.00' }], quoteLines: [{ quantity: 1, unit_price: 200 }] });


const remaining=():RemainingWork=>({labourHours:'0',machineHours:{mill:'0'},overheadHours:'0',supplierPence:0,confirmed:true,reworkLabour:null,reworkMaterial:null});
it('pins the original reviewed implementation',()=>{expect(createHash('sha256').update(source).digest('hex')).toBe('adc4a431938a3f18affa1900e9362ae2d51eb9a37634118cb18500ed64467f98');});
it('reproduces revenue penny loss before fix; combined actual and projection both refuse unsafe aggregate',()=>{
 const x=fixture();x.invoices=Array.from({length:91},(_,i)=>({id:`invoice-${i}`,status:'sent',subtotal:'999999999999.99'}));x.credits=[];x.pos=[{id:'po',status:'sent',total_value:'999999999999.99',linked_net:'999999999999.99'}];
 expect(before(x)).toMatchObject({state:'complete',actualProfitPence:8999999999994409});
 expect(actualJobProfit(x)).toMatchObject({state:'incomplete',actualProfitPence:null});
 expect(jobProgress(x,remaining(),[],[])).toMatchObject({state:'incomplete',completionPence:null,projectedProfitPence:null});
});
it('reproduces microsecond half-penny loss; combined actual and projected recorded cost retain the penny',()=>{
 const x=fixture();x.config.labour_rate_pence=10000;x.config.overhead_basis='none';x.machines=[];x.plans=[];x.estimate!.machines_not_required=true;x.pos=[];
 x.labour=Array.from({length:360},(_,i)=>{const day=new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10);return {...timer(`l-${i}`),started_at:`${day}T00:00:00.000000Z`,ended_at:`${day}T01:00:00.000500Z`};});
 expect(before(x).labourPence).toBe(3600000);expect(actualJobProfit(x).labourPence).toBe(3600001);
 expect(jobProgress(x,{...remaining(),machineHours:{}},[],[])).toMatchObject({state:'projected',recordedBasePence:3600001,completionPence:3600001});
});
it.each(['labour rate','machine rate','hours','supplier','approval'])('missing %s blocks all completion profit',kind=>{
 const x=fixture();if(kind==='labour rate')x.config.labour_rate_pence=null;if(kind==='machine rate')x.rates=[];if(kind==='hours')x.labour=null;if(kind==='supplier')x.pos=null;if(kind==='approval')x.config.approved_at=null;
 expect(jobProgress(x,remaining(),[],[])).toMatchObject({state:'incomplete',completionPence:null,projectedProfitPence:null,projectedMarginPct:null});
});
it('OFF wins even with valid rates, work, quote and approvals',()=>{
 const x=fixture();x.config.enabled=false;expect(actualJobProfit(x).state).toBe('off');expect(jobProgress(x,remaining(),[],[])).toMatchObject({state:'off',completionPence:null,projectedProfitPence:null});
});
