import type { SupabaseClient } from "@supabase/supabase-js";
import type { CostingRates as Draft } from "@/components/costing/types";
import { toPence, decimalPlaces } from "@/lib/money";
import { defaultsProblem, machineProblem, materialProblem, type CostingRates as Saved } from "@/lib/costing/rates-store";
export function costingSnapshot(saved: Saved) {
  return { materials: saved.materials.map(m => ({ id:m.id,name:m.name,price_pence:m.pricePence,price_unit:m.priceUnit,scrap_pct:m.scrapPct })), machines:saved.machines.map(m=>({id:m.id,name:m.name,hourly_rate_pence:m.hourlyRatePence,labour_rate_pence:m.labourRatePence})), defaults:saved.defaults ? {labour_rate_pence:saved.defaults.labourRatePence,programming_rate_pence:saved.defaults.programmingRatePence,overhead_pct:saved.defaults.overheadPct,default_margin_pct:saved.defaults.defaultMarginPct} : null };
}
export async function saveAtomicCosting(db: SupabaseClient, org: string, saved: Saved, draft: Draft) {
  const money=[draft.labourPerHour,draft.programmingPerHour,...draft.materials.map(m=>m.price),...draft.machines.flatMap(m=>[m.hourlyRate,...(m.labourPerHour == null ? [] : [m.labourPerHour])])];
  if(money.some(n=>!Number.isFinite(n)||n<0||decimalPlaces(n)>2))throw new Error("Enter costs in pounds and pence, with no more than two decimal places.");
  const defaults={labourRatePence:toPence(draft.labourPerHour),programmingRatePence:toPence(draft.programmingPerHour),overheadPct:draft.overheadPct+100,defaultMarginPct:draft.marginPct};
  const materials=draft.materials.map(m=>({id:m.id,name:m.name,pricePence:toPence(m.price),priceUnit:m.unit,scrapPct:m.scrapPct}));
  const machines=draft.machines.map(m=>({id:m.id,name:m.name,hourlyRatePence:toPence(m.hourlyRate),labourRatePence:m.labourPerHour == null ? null : toPence(m.labourPerHour)}));
  const problem=defaultsProblem(defaults) ?? materials.map(materialProblem).find(Boolean) ?? machines.map(machineProblem).find(Boolean);
  if(problem)throw new Error(problem);
  const next:Saved={enabled:true,materials:materials.map(m=>({...m,updatedAt:null})),machines:machines.map(m=>({...m,updatedAt:null})),defaults:{...defaults,updatedAt:null}};
  const {error}=await db.rpc("save_costing_settings_atomic",{p_org:org,p_expected:costingSnapshot(saved),p_value:costingSnapshot(next)});
  if(error)throw new Error(error.code==='40001'?"Costing rates changed. Reload before saving.":"Could not save costing rates. Reload the page; if it still fails, ask the person who looks after Tolra.");
}
