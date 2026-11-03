'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getCurrentOrganizationId } from '@/lib/supabase-business';
import { loadCostingRates, saveCostingDefaults, saveCostingMaterial, saveCostingMachine, deleteCostingMaterial, deleteCostingMachine, BUILT_IN_COSTING_DEFAULTS, type CostingRates as StoredRates } from '@/lib/costing/rates-store';
import { CostingRatesEditor } from './costing-rates-editor';
import { PriceThisPart, type CostedQuoteLine } from './price-this-part';
import type { CostingRates } from './types';
import { fromPence, toPence } from '@/lib/money';

export function mapCostingRates(source: StoredRates): CostingRates {
 const defaults = source.defaults ?? BUILT_IN_COSTING_DEFAULTS;
 return {
  materials: source.materials.map(m=>({id:m.id,name:m.name,unit:m.priceUnit,price:fromPence(m.pricePence),scrapPct:m.scrapPct})),
  machines: source.machines.map(m=>({id:m.id,name:m.name,hourlyRate:fromPence(m.hourlyRatePence)})),
  labourPerHour:fromPence(defaults.labourRatePence),
  programmingPerHour:fromPence(defaults.programmingRatePence),
  overheadPct:defaults.overheadPct - 100,
  marginPct:defaults.defaultMarginPct,
 };
}
function useSavedRates() {
 const [stored,setStored]=useState<StoredRates|null>(null);
 const [error,setError]=useState('');
 const [loading,setLoading]=useState(true);
 const reload=useCallback(async()=>{
   setLoading(true);
   const result=await loadCostingRates(supabase);
   if(result.status==='ok'){setStored(result.rates);setError('');}
   else {setStored(null);setError(result.status==='not_applied'?"Costing is not set up yet. Ask the person who looks after Tolra.":result.message);}
   setLoading(false);
 },[]);
 useEffect(()=>{void reload();},[reload]);
 return {stored,error,loading,reload};
}
export function ConnectedCostingRatesCard(){
 const {stored,error,loading,reload}=useSavedRates();
 const [draft,setDraft]=useState<CostingRates|null>(null);
 const [saving,setSaving]=useState(false);
 const [message,setMessage]=useState('');
 useEffect(()=>{setDraft(stored?mapCostingRates(stored):null);},[stored]);
 async function save(){
  if(!draft||!stored||!supabase||saving)return;
  setSaving(true);setMessage('');
  try {
   const org=await getCurrentOrganizationId();
   const defaults=await saveCostingDefaults(supabase,org,{
    labourRatePence:toPence(draft.labourPerHour),programmingRatePence:toPence(draft.programmingPerHour),
    overheadPct:draft.overheadPct+100,defaultMarginPct:draft.marginPct,
   });
   if(!defaults.ok)throw Error(defaults.message);
   for(const m of draft.materials){
    const saved=await saveCostingMaterial(supabase,org,{id:stored.materials.some(item=>item.id===m.id)?m.id:undefined,name:m.name,pricePence:toPence(m.price),priceUnit:m.unit,scrapPct:m.scrapPct});
    if(!saved.ok)throw Error(saved.message);
   }
   for(const m of stored.materials.filter(old=>!draft.materials.some(item=>item.id===old.id))){
    const result=await deleteCostingMaterial(supabase,org,m.id);
    if(!result.ok)throw Error(result.message);
   }
   for(const m of draft.machines){
    const previous=stored.machines.find(item=>item.id===m.id);
    const saved=await saveCostingMachine(supabase,org,{id:previous?.id,name:m.name,hourlyRatePence:toPence(m.hourlyRate),labourRatePence:previous?.labourRatePence??null});
    if(!saved.ok)throw Error(saved.message);
   }
   for(const m of stored.machines.filter(old=>!draft.machines.some(item=>item.id===old.id))){
    const result=await deleteCostingMachine(supabase,org,m.id);
    if(!result.ok)throw Error(result.message);
   }
   await reload();setMessage('Costing rates saved.');
  }catch(e){setMessage(e instanceof Error?e.message:'Could not save costing rates.');}
  finally{setSaving(false);}
 }
 return <section aria-label="Company costing settings" className="rounded-lg border p-4">
   {loading?<p>Loading costing rates</p>:error?<p role="status">{error}</p>:draft?<CostingRatesEditor value={draft} onChange={setDraft} saving={saving} onSave={()=>{void save();}} />:null}
   {message&&<p role="status">{message}</p>}
 </section>;
}
export function ConnectedPriceThisPart({onAdd}:{onAdd:(line:CostedQuoteLine)=>void}){
 const {stored,error,loading}=useSavedRates();
 if(loading||error||!stored?.enabled)return null;
 return <PriceThisPart rates={mapCostingRates(stored)} onAdd={onAdd}/>;
}
