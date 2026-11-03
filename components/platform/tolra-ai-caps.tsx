"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MAX_TOLRA_CAP_PENCE } from "@/lib/ai-helper/tolra-caps";

type Company = { organizationId:string; name:string; monthlyCapPence:number; spentPence:number; reservedPence:number };
export function TolraAiCaps() {
  const [companies,setCompanies] = useState<Company[]>([]);
  const [drafts,setDrafts] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState<string | null>(null);
  const [message,setMessage] = useState("");
  const load=useCallback(async()=>{
    const response=await fetch("/api/platform/tolra-ai/caps",{cache:"no-store"});
    if(!response.ok)throw new Error("Could not load company AI limits.");
    const data=await response.json() as {companies:Company[]};
    setCompanies(data.companies);setDrafts(Object.fromEntries(data.companies.map(c=>[c.organizationId,String(c.monthlyCapPence)])));
  },[]);
  useEffect(()=>{void load().catch(()=>setMessage("Company AI limits are not available yet."));},[load]);
  async function save(company:Company) {
    if(busy)return;
    const text=drafts[company.organizationId]??"";
    const pence=Number(text);
    if(!/^\d+$/.test(text)||!Number.isSafeInteger(pence)||pence>MAX_TOLRA_CAP_PENCE) {setMessage("Enter whole pence from 0 to 100,000 (£1,000).");return;}
    setBusy(company.organizationId);setMessage("");
    try {
      const response=await fetch("/api/platform/tolra-ai/caps",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({organizationId:company.organizationId,monthlyCapPence:pence})});
      if(!response.ok) {const data=await response.json() as {error?:string};throw new Error(data.error??"Could not save the limit.");}
      await load();setMessage(`AI limit saved for ${company.name}.`);
    } catch(error) {setMessage(error instanceof Error?error.message:"Could not save the limit.");}
    finally {setBusy(null);}
  }
  return <Card><CardHeader><CardTitle>Company AI limits</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-sm">Tolra-provided AI starts at 1,000p (£10) per company per month. Only the platform owner can change it. Maximum: 100,000p (£1,000). Set it to used plus reserved to stop further requests. A limit cannot be lower than this month&apos;s used and reserved AI.</p>
    {companies.map(company=><div key={company.organizationId} className="rounded border p-3">
      <p className="font-medium">{company.name}</p><p className="text-sm">Used: {company.spentPence}p. Reserved: {company.reservedPence}p.</p>
      <label className="grid gap-1 text-sm">Monthly AI limit for {company.name} (pence)<Input type="number" min={0} max={MAX_TOLRA_CAP_PENCE} step={1} value={drafts[company.organizationId]??""} disabled={busy!==null} onChange={e=>setDrafts({...drafts,[company.organizationId]:e.target.value})}/></label>
      <Button type="button" disabled={busy!==null} onClick={()=>void save(company)}>Save limit for {company.name}</Button>
    </div>)}
    {message&&<p role="status">{message}</p>}
  </CardContent></Card>;
}
