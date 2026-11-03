"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

type State = {enabled:boolean;key_set:boolean};
export function TolraAiControl() {
  const [status,setStatus] = useState<State | null>(null);
  const [key,setKey] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  useEffect(()=>{
    let live=true;
    void fetch("/api/platform/tolra-ai",{cache:"no-store"}).then(async r=>{
      if (r.ok && live) setStatus(await r.json() as State);
      else if (live) setError("Tolra AI controls are not available yet.");
    }).catch(()=>{if(live)setError("Could not load Tolra AI controls.");});
    return ()=>{live=false;};
  },[]);
  async function save(enabled:boolean) {
    if(busy)return;
    setBusy(true);setError("");
    const replacement=enabled?key.trim():"";setKey("");
    try {
      const r=await fetch("/api/platform/tolra-ai",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled,...(replacement?{key:replacement}:{})})});
      if(!r.ok)throw new Error();
      setStatus(await r.json() as State);
    } catch {setError("Could not save Tolra AI. Check the key and try again.");}
    finally {setBusy(false);}
  }
  return <Card><CardHeader><CardTitle>Tolra-provided AI</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm">Off until you add your provider key and switch it on. Companies then choose on or off. Each starts with a £10 monthly allowance; set individual limits below, up to £1,000. The existing server AI switch must also be on.</p>
    {status && <><p>{status.enabled?"On":"Off"}. {status.key_set?"A provider key is saved. It is never shown again.":"No provider key saved."}</p>
    <label className="grid gap-1 text-sm">{status.key_set?"Replacement Anthropic key":"Anthropic key"}<Input aria-label="Tolra Anthropic key" type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)} disabled={busy}/></label>
    <div className="flex gap-2"><Button disabled={busy||(!status.key_set&&!key.trim())} onClick={()=>void save(true)}>Switch on{key.trim()?" and save key":""}</Button><Button variant="outline" disabled={busy} onClick={()=>void save(false)}>Switch off</Button></div></>}
    {error&&<p role="alert">{error}</p>}
  </CardContent></Card>;
}
