'use client';
import {useEffect,useState} from 'react';
import {jobProgress,progressMachineIds,type RemainingWork,type ReworkEntry,type ReworkValue} from '@/lib/job-profitability-progress';
import {plannedCostPence,type ActualCostInputs} from '@/lib/job-profitability-actuals';
import {loadJobRework} from '@/lib/job-profitability-rework';
import {supabase} from '@/lib/supabase';
import {gbp} from '@/lib/money';
const cash=(n:number|null)=>n===null?'Not available':gbp(n/100);
export function JobProfitabilityProgress({input}:{input:ActualCostInputs&{machineChoices:{id:string;name:string}[]}}){
 const [remaining,setRemaining]=useState<RemainingWork>({labourHours:null,machineHours:{},overheadHours:null,supplierPence:null,confirmed:false,reworkLabour:null,reworkMaterial:null});
 const [rework,setRework]=useState<{entries:ReworkEntry[];values:ReworkValue[]}|null>(null);
 useEffect(()=>{let active=true;if(input.config.enabled&&supabase)loadJobRework(supabase,input.organizationId,input.jobId).then(v=>{if(active)setRework(v);},()=>{if(active)setRework(null);});return()=>{active=false;};},[input.organizationId,input.jobId,input.config.enabled]);
 if(!input.config.enabled)return null;
 const result=jobProgress(input,remaining,rework?.entries??null,rework?.values??null);
 const set=(key:'labourHours'|'overheadHours',value:string)=>setRemaining(r=>({...r,[key]:value||null}));
 return <section className="space-y-3 rounded border p-3" aria-label="Job progress projection"><h4 className="font-semibold">Job in progress — projection</h4><p>This is a projection using the quoted value, issued credits and work left. It is not actual profit. Remaining-work entries below are not saved. Total planned hours do not tell us how much work is left.</p>
 <dl className="grid grid-cols-2 gap-2">{Object.entries({'Estimated cost':cash(result.estimatedCostPence),'Recorded production and supplier costs':cash(result.recordedBasePence),'Recorded rework valuation (may already be included)':cash(result.recordedReworkPence),'Actual cost so far including agreed extra rework':cash(result.actualSoFarPence),'Remaining planned cost':cash(result.remainingPence),'Expected cost at completion — projection':cash(result.completionPence),'Projected profit':cash(result.projectedProfitPence),'Projected margin':result.projectedMarginPct===null?'Not available':`${result.projectedMarginPct.toFixed(2)}%`}).map(([k,v])=><div key={k}><dt>{k}</dt><dd className="font-semibold">{v}</dd></div>)}</dl>
 {result.state==='incomplete'&&<p role="status">Costing incomplete: {result.missing.join('; ')}.</p>}{result.warnings.map(w=><p key={w} className="text-amber-800">{w}</p>)}
 <details><summary>Work still to do for this projection</summary><div className="grid gap-2 py-2">
 <label>Extra remaining labour hours — exclude labour already in machine rates<input aria-label="Remaining labour hours" className="ml-2 border" inputMode="decimal" onChange={e=>set('labourHours',e.target.value)} /></label>
 {progressMachineIds(input).map(id=><label key={id}>Remaining hours: {input.machineChoices.find(m=>m.id===id)?.name??id}<input aria-label={`Remaining machine ${id}`} className="ml-2 border" inputMode="decimal" onChange={e=>{const value=e.target.value;setRemaining(r=>({...r,machineHours:{...r.machineHours,[id]:value||null}}));}} /></label>)}
 {input.config.overhead_basis!=='none'&&<label>Extra remaining overhead hours — exclude overheads already in machine rates<input aria-label="Remaining overhead hours" className="ml-2 border" inputMode="decimal" onChange={e=>set('overheadHours',e.target.value)} /></label>}
 <label>Further supplier cost (£), beyond the recorded purchase allocations<input aria-label="Remaining supplier cost" className="ml-2 border" inputMode="decimal" onChange={e=>{const value=e.target.value;let p:number|null=null;if(/^\d+(?:\.\d{1,2})?$/.test(value)){try{p=plannedCostPence(value,100);}catch{p=null;}}setRemaining(r=>({...r,supplierPence:p}));}} /></label>
 <p>A blank is unknown. Enter 0 only when no more of that cost is expected. Include remaining rework in these amounts too.</p>
 <label>Recorded rework hours<select aria-label="Rework labour treatment" onChange={e=>setRemaining(r=>({...r,reworkLabour:(e.target.value||null) as RemainingWork['reworkLabour']}))}><option value="">Not confirmed</option><option value="included">Already in timers or machine-inclusive costs</option><option value="additional">Extra; not in timers or machine-inclusive costs</option></select></label>
 <label>Recorded rework material<select aria-label="Rework material treatment" onChange={e=>setRemaining(r=>({...r,reworkMaterial:(e.target.value||null) as RemainingWork['reworkMaterial']}))}><option value="">Not confirmed</option><option value="included">Already in supplier purchases</option><option value="additional">Extra; not in supplier purchases</option></select></label>
 <label><input type="checkbox" onChange={e=>setRemaining(r=>({...r,confirmed:e.target.checked}))} /> These entries cover all remaining work for this projection.</label>
 </div></details></section>;
}
