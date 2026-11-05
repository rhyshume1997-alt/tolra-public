/** Projection only: explicit remaining work, recorded costs and approved company rates. No writes or payroll. */
import {actualJobProfit,plannedCostPence,type ActualCostInputs} from '@/lib/job-profitability-actuals';
import {invoicedSellPence} from '@/lib/purchase-order-link';
export type ReworkEntry={id:string;organization_id:string;job_id:string;kind:string;hours?:number|string|null};
export type ReworkValue={entry_id:string;organization_id:string;material_cost:number|string|null};
export type RemainingWork={labourHours:string|null;machineHours:Record<string,string|null>;overheadHours:string|null;supplierPence:number|null;confirmed:boolean;reworkLabour:'additional'|'included'|null;reworkMaterial:'additional'|'included'|null};
export type ProgressResult={state:'off'|'incomplete'|'projected';estimatedCostPence:number|null;recordedBasePence:number|null;recordedReworkPence:number|null;actualSoFarPence:number|null;remainingPence:number|null;completionPence:number|null;projectedProfitPence:number|null;projectedMarginPct:number|null;missing:string[];warnings:string[]};
const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
function sum(values:number[]):number { const n=values.reduce((n,v)=>n+BigInt(v),BigInt(0));if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Cost exceeds supported pennies');return Number(n); }
function hoursCost(hours:string|null,rate:number|null){if(!safe(rate))return null;return plannedCostPence(hours,rate);}
function money(value:number|string|null):number|null{return value===null?null:plannedCostPence(String(value),100);}
export function progressMachineIds(input:ActualCostInputs){return [...new Set([...(input.plans??[]).map(p=>p.machine_id),...(input.machines??[]).filter(m=>m.job_id===input.jobId).map(m=>m.machine_id).filter((v):v is string=>!!v)])];}
export function jobProgress(input:ActualCostInputs,remaining:RemainingWork,entries:ReworkEntry[]|null,values:ReworkValue[]|null):ProgressResult{
 const out:ProgressResult={state:'incomplete',estimatedCostPence:null,recordedBasePence:null,recordedReworkPence:null,actualSoFarPence:null,remainingPence:null,completionPence:null,projectedProfitPence:null,projectedMarginPct:null,missing:[],warnings:[]};
 if(!input.config.enabled)return {...out,state:'off'};
 const missing=(s:string)=>{if(!out.missing.includes(s))out.missing.push(s);};
 try{
  const recorded=actualJobProfit(input,{allowUninvoicedCosts:true});
  if(recorded.state!=='complete')recorded.reasons.forEach(missing);
  if(recorded.supplierPence!==null&&recorded.labourPence!==null&&recorded.machinePence!==null&&recorded.overheadPence!==null)out.recordedBasePence=sum([recorded.supplierPence,recorded.labourPence,recorded.machinePence,recorded.overheadPence]);
  if(recorded.quotedPence!==null&&recorded.estimatedProfitPence!==null){const n=sum([recorded.quotedPence,-recorded.estimatedProfitPence]);if(safe(n))out.estimatedCostPence=n;}
  let reworkExtra=0,reworkValue=0;let reworkMicroHours=BigInt(0);
  if(!entries||!values)missing('Rework records could not be read');
  else{
   if(entries.some(e=>e.organization_id!==input.organizationId||e.job_id!==input.jobId)||values.some(v=>v.organization_id!==input.organizationId))missing('Rework records belong to another company or job');
   const seen=new Set<string>();
   for(const e of entries){
    if(seen.has(e.id)){missing('Duplicate rework record');continue;}seen.add(e.id);
    if(e.kind==='hours'){
     const units=e.hours==null?null:plannedCostPence(String(e.hours),1000000);
     if(units===null||!safe(units)){missing('Rework labour hours or rate missing');continue;}
     reworkMicroHours+=BigInt(units);
     if(!remaining.reworkLabour)missing('Confirm whether rework hours are extra or already included');
    }
    if(e.kind==='material'){
     const matches=values.filter(v=>v.entry_id===e.id);const cost=matches.length===1?money(matches[0].material_cost):null;
     if(cost===null){missing('Rework material has no single recorded price');continue;}
     reworkValue=sum([reworkValue,cost]);
     if(!remaining.reworkMaterial)missing('Confirm whether rework material is extra or already in purchases');
     if(remaining.reworkMaterial==='additional')reworkExtra=sum([reworkExtra,cost]);
    }
   }
   if(reworkMicroHours>BigInt(0)){
    const text=`${reworkMicroHours/BigInt(1000000)}.${String(reworkMicroHours%BigInt(1000000)).padStart(6,'0')}`;
    const cost=hoursCost(text,input.config.labour_rate_pence);
    if(cost===null)missing('Rework labour hours or rate missing');else{
     reworkValue=sum([reworkValue,cost]);
     if(remaining.reworkLabour==='additional'){
      reworkExtra=sum([reworkExtra,cost]);
      if(input.config.overhead_basis==='labour'){const oh=hoursCost(text,input.config.overhead_rate_pence);if(oh===null)missing('Rework overhead rate missing');else reworkExtra=sum([reworkExtra,oh]);}
     }
    }
   }
   out.recordedReworkPence=out.missing.some(m=>m.startsWith('Rework')||m==='Duplicate rework record')?null:reworkValue;
  }
  if(out.recordedBasePence!==null&&!out.missing.length)out.actualSoFarPence=sum([out.recordedBasePence,reworkExtra]);
  if(!remaining.confirmed)missing('Confirm all remaining work for this projection');
  if(input.plans===null)missing('Machine plan could not be read');
  let left=0;
  const labour=hoursCost(remaining.labourHours,input.config.labour_rate_pence);if(labour===null)missing('Remaining additional labour hours missing');else left=sum([left,labour]);
  if(!safe(remaining.supplierPence))missing('Remaining supplier cost missing');else left=sum([left,remaining.supplierPence]);
  if(input.config.overhead_basis!=='none'){const oh=hoursCost(remaining.overheadHours,input.config.overhead_rate_pence);if(oh===null)missing('Remaining additional overhead hours missing');else left=sum([left,oh]);}
  for(const id of progressMachineIds(input)){
   const rate=input.rates.find(r=>r.machine_id===id);const cost=hoursCost(remaining.machineHours[id]??null,rate?.rate_pence??null);
   if(cost===null)missing(`Remaining machine hours or rate missing: ${id}`);else left=sum([left,cost]);
  }
  if(out.actualSoFarPence!==null&&out.estimatedCostPence!==null&&out.actualSoFarPence>out.estimatedCostPence)out.warnings.push('Recorded cost is already above the estimate.');
  if(recorded.quotedPence===null)missing('Agreed quoted value missing');
  let revenue:number|null=null;
  if(recorded.quotedPence!==null&&input.invoices&&input.credits){
   const gross=invoicedSellPence(input.invoices,[]),net=invoicedSellPence(input.invoices,input.credits);
   if(gross.issued&&net.issued&&gross.pence!==null&&net.pence!==null){revenue=sum([recorded.quotedPence,-gross.pence,net.pence]);if(net.pence>revenue)missing('Billing exceeds quoted value; check the agreed value');}
   else if(!gross.issued)revenue=recorded.quotedPence;else missing('Credit or invoice value missing');
  }
  if(!out.missing.length&&out.actualSoFarPence!==null&&revenue!==null&&safe(revenue)){
   out.remainingPence=left;out.completionPence=sum([out.actualSoFarPence,left]);out.projectedProfitPence=sum([revenue,-out.completionPence]);
   const profit=BigInt(out.projectedProfitPence),den=BigInt(revenue);const magnitude=profit<BigInt(0)?-profit:profit;
   out.projectedMarginPct=revenue>0?Number((magnitude*BigInt(20000)+den)/(den*BigInt(2)))/100*(profit<BigInt(0)?-1:1):null;out.state='projected';
   if(out.estimatedCostPence!==null&&out.completionPence>out.estimatedCostPence)out.warnings.push('Projected cost is above the estimate.');
   if(out.projectedProfitPence<0)out.warnings.push('This projection shows a loss.');else if(out.projectedMarginPct!==null&&out.projectedMarginPct<=10)out.warnings.push('Projected margin is 10% or less; little room for extra cost.');
  }else if(revenue!==null&&!safe(revenue))missing('Projected revenue is invalid');
 }catch{missing('A cost or time is outside the supported range');}
 return out;
}
