'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useUser } from '@/lib/use-user';
import { saveAtomicCosting } from '@/lib/costing/atomic-settings';
import { loadCostingRates, BUILT_IN_COSTING_DEFAULTS, type CostingRates as StoredRates } from '@/lib/costing/rates-store';
import { CostingRatesEditor } from './costing-rates-editor';
import { PriceThisPart, type CostedQuoteLine } from './price-this-part';
import type { CostingRates } from './types';
import { fromPence } from '@/lib/money';

export function mapCostingRates(source: StoredRates): CostingRates {
 const defaults = source.defaults ?? BUILT_IN_COSTING_DEFAULTS;
 return {
  materials: source.materials.map(m=>({id:m.id,name:m.name,unit:m.priceUnit,price:fromPence(m.pricePence),scrapPct:m.scrapPct})),
  machines: source.machines.map(m=>({id:m.id,name:m.name,hourlyRate:fromPence(m.hourlyRatePence),labourPerHour:m.labourRatePence == null ? null : fromPence(m.labourRatePence)})),
  labourPerHour:fromPence(defaults.labourRatePence),
  programmingPerHour:fromPence(defaults.programmingRatePence),
  overheadPct:defaults.overheadPct - 100,
  marginPct:defaults.defaultMarginPct,
 };
}
function useSavedRates() {
 const {profile}=useUser();
 const organizationId=profile?.organization_id;
 const generation=useRef(0);
 const [stored,setStored]=useState<StoredRates|null>(null);
 const [error,setError]=useState('');
 const [loading,setLoading]=useState(true);
 const reload=useCallback(async()=>{
   const run=++generation.current;
   setLoading(true); setStored(null);
   if(!organizationId){setLoading(false);return false;}
   const result=await loadCostingRates(supabase);
   if(run!==generation.current)return false;
   if(result.status==='ok'){setStored(result.rates);setError('');}
   else {setStored(null);setError(result.status==='not_applied'?"Costing is not set up yet. Ask the person who looks after Tolra.":result.message);}
   setLoading(false); return result.status==='ok';
 },[organizationId]);
 useEffect(()=>{void reload();},[reload]);
 return {stored,error,loading,reload,organizationId};
}
export function ConnectedCostingRatesCard(){
 const {stored,error,loading,reload,organizationId}=useSavedRates();
 const busy=useRef(false);
 const [draft,setDraft]=useState<CostingRates|null>(null);
 const [saving,setSaving]=useState(false);
 const [message,setMessage]=useState('');
 useEffect(()=>{setDraft(stored?mapCostingRates(stored):null);},[stored]);
 async function save(){
  if(!draft||!stored||!supabase||!organizationId||busy.current)return;
  busy.current=true;
  setSaving(true);setMessage('');
  try {
   await saveAtomicCosting(supabase,organizationId,stored,draft);
   const refreshed=await reload();setMessage(refreshed?'Costing rates saved.':'Costing rates saved. Reload the page to check them before editing again.');
  }catch(e){setMessage(e instanceof Error?e.message:'Could not save costing rates.');}
  finally{busy.current=false;setSaving(false);}
 }
 return <section aria-label="Company costing settings" className="rounded-lg border p-4">
   {loading?<p>Loading costing rates</p>:error?<p role="status">{error}</p>:draft?<CostingRatesEditor value={draft} onChange={setDraft} saving={saving} onSave={()=>{void save();}} />:null}
   {message&&<p role="status">{message}</p>}
 </section>;
}
export function ConnectedPriceThisPart({onAdd}:{onAdd:(line:CostedQuoteLine)=>void}){
 const {stored,error,loading,organizationId}=useSavedRates();
 if(loading||error||!stored?.enabled)return null;
 return <PriceThisPart key={organizationId} rates={mapCostingRates(stored)} onAdd={onAdd}/>;
}
