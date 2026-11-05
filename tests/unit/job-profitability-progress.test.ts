import {expect,it} from 'vitest';
import {actualJobProfit,type ActualCostInputs,type CostTimer} from '@/lib/job-profitability-actuals';
import {jobProgress,type RemainingWork} from '@/lib/job-profitability-progress';
const timer = (id: string, start = '08:00', end: string | null = '09:00'): CostTimer => ({ id, organization_id: 'org', job_id: 'job', user_id: 'worker', machine_id: 'mill', operator_id: 'worker', started_at: `2026-11-04T${start}:00Z`, ended_at: end ? `2026-11-04T${end}:00Z` : null });
const fixture = (): ActualCostInputs => ({ organizationId: 'org', jobId: 'job', config: { enabled: true, revision: 1, approved_at: '2026-11-04', labour_rate_pence: 2000, overhead_basis: 'labour', overhead_rate_pence: 500 }, rates: [{ machine_id: 'mill', rate_pence: 3000, includes_labour: false, includes_overhead: false }], labour: [timer('l')], machines: [timer('m')], plans: [{ machine_id: 'mill', estimated_hours: 1 }], estimate: { supplier_pence: 1000, labour_hours: 1, overhead_hours: 1, labour_not_required: false, machines_not_required: false }, pos: [{ id: 'po', total_value: '100.00', linked_net: '10.00', status: 'sent' }], invoices: [{ id: 'invoice', status: 'sent', subtotal: '200.00' }], credits: [{ invoice_id: 'invoice', status: 'issued', subtotal: '10.00' }], quoteLines: [{ quantity: 1, unit_price: 200 }] });

const remaining=():RemainingWork=>({labourHours:'1',machineHours:{mill:'1'},overheadHours:'1',supplierPence:1000,confirmed:true,reworkLabour:null,reworkMaterial:null});
it('projects quoted revenue less issued credits, actual cost and explicit remaining work',()=>{
 expect(jobProgress(fixture(),remaining(),[],[])).toMatchObject({state:'projected',recordedBasePence:6500,actualSoFarPence:6500,remainingPence:6500,completionPence:13000,projectedProfitPence:6000});
});
it('supports recorded costs before invoicing without inventing actual profit',()=>{
 const x=fixture();x.invoices=[];x.credits=[];expect(actualJobProfit(x).actualProfitPence).toBeNull();
 expect(jobProgress(x,remaining(),[],[])).toMatchObject({state:'projected',actualSoFarPence:6500,projectedProfitPence:7000});
});
it('does not derive remaining work by subtracting hours from the original estimate',()=>{
 const r=remaining();r.labourHours=null;expect(jobProgress(fixture(),r,[],[])).toMatchObject({state:'incomplete',completionPence:null});
});
it.each(['supplier','confirmation','machine','overhead','rate','rework-read'])('keeps missing %s incomplete, never zero',kind=>{
 const x=fixture(),r=remaining();if(kind==='supplier')r.supplierPence=null;if(kind==='confirmation')r.confirmed=false;if(kind==='machine')r.machineHours={};if(kind==='overhead')r.overheadHours=null;if(kind==='rate')x.rates=[];
 const out=jobProgress(x,r,kind==='rework-read'?null:[],[]);expect(out.state).toBe('incomplete');expect(out.completionPence).toBeNull();expect(out.projectedProfitPence).toBeNull();
});
it('prices recorded extra rework and overhead while keeping already-included costs out',()=>{
 const entries=[{id:'h',organization_id:'org',job_id:'job',kind:'hours',hours:'1'},{id:'m',organization_id:'org',job_id:'job',kind:'material'}];const values=[{entry_id:'m',organization_id:'org',material_cost:'5.00'}];
 const r=remaining();expect(jobProgress(fixture(),r,entries,values).state).toBe('incomplete');
 r.reworkLabour='additional';r.reworkMaterial='additional';expect(jobProgress(fixture(),r,entries,values)).toMatchObject({recordedReworkPence:2500,actualSoFarPence:9500,completionPence:16000,projectedProfitPence:3000});
 r.reworkLabour='included';r.reworkMaterial='included';expect(jobProgress(fixture(),r,entries,values).actualSoFarPence).toBe(6500);
});
it('refuses unpriced or foreign rework and unsafe amounts',()=>{
 const entries=[{id:'m',organization_id:'org',job_id:'job',kind:'material'}];expect(jobProgress(fixture(),remaining(),entries,[]).state).toBe('incomplete');
 expect(jobProgress(fixture(),remaining(),[{...entries[0],organization_id:'foreign'}],[]).state).toBe('incomplete');
 const r=remaining();r.supplierPence=Number.MAX_SAFE_INTEGER;expect(jobProgress(fixture(),r,[],[]).state).toBe('incomplete');
});
it('warns about a projected loss and an estimate overrun',()=>{
 const r=remaining();r.supplierPence=50000;const out=jobProgress(fixture(),r,[],[]);expect(out.projectedProfitPence).toBeLessThan(0);expect(out.warnings).toContain('This projection shows a loss.');expect(out.warnings).toContain('Projected cost is above the estimate.');
});
it('keeps the feature off by default and accepts explicit remaining zero',()=>{
 const x=fixture();x.config.enabled=false;expect(jobProgress(x,remaining(),null,null).state).toBe('off');x.config.enabled=true;
 const r=remaining();r.labourHours='0';r.machineHours={mill:'0'};r.overheadHours='0';r.supplierPence=0;expect(jobProgress(x,r,[],[]).remainingPence).toBe(0);
});
it('rounds aggregated rework hours once, halves up',()=>{
 const x=fixture();x.config.labour_rate_pence=1;x.config.overhead_basis='none';
 const r=remaining();r.reworkLabour='additional';const entry={organization_id:'org',job_id:'job',kind:'hours',hours:'0.5'};
 expect(jobProgress(x,r,[{...entry,id:'one'},{...entry,id:'two'}],[]).recordedReworkPence).toBe(1);
 expect(jobProgress(x,r,[{...entry,id:'one'}],[]).recordedReworkPence).toBe(1);
});
it('preserves machine-inclusive labour/overhead and warns when loss is near',()=>{
 const x=fixture(),r=remaining();x.rates[0].includes_labour=true;x.rates[0].includes_overhead=true;
 r.labourHours='0';r.overheadHours='0';r.supplierPence=0;
 expect(jobProgress(x,r,[],[])).toMatchObject({recordedBasePence:4000,completionPence:7000});
 r.supplierPence=11500;expect(jobProgress(x,r,[],[]).warnings).toContain('Projected margin is 10% or less; little room for extra cost.');
});
