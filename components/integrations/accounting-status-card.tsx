'use client';
import {useEffect,useState} from 'react';
import type {AccountingStatus} from '@/lib/integrations/accounting-status';
export function AccountingStatusCard(){
 const [rows,setRows]=useState<AccountingStatus[]|null>(null),[error,setError]=useState(false);
 useEffect(()=>{let active=true;fetch('/api/integrations/accounting-status').then(async r=>{if(!r.ok)throw Error();return r.json();}).then(v=>{if(active)setRows(v.providers);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[]);
 return <section className="rounded-lg border p-4"><h2 className="font-semibold">Accounting status</h2><p className="text-sm">This shows setup and the latest recorded transfer. It does not test a live account.</p>{!rows?<p role="status">{error?'Status unavailable. No readiness is confirmed.':'Loading status…'}</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Provider','Available','Setup','Connection','Mapping','Transfers','Ready','Last transfer','Failures'].map(h=><th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.id}>{[r.name,r.available?'Available':'Unavailable',r.configuration,r.connection,r.mapping,r.transfers,r.readiness,r.lastTransfer,r.failures].map((v,i)=><td key={i} className="p-2">{v}</td>)}</tr>)}</tbody></table></div>}</section>;
}
