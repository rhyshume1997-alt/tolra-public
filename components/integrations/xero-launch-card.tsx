'use client';
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
/** Admin page only; server and DB enforce the permission independently. */
export function XeroLaunchCard(){
 const [state,setState]=useState<{enabled:boolean;connected:boolean}|null>(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{let live=true;fetch('/api/integrations/xero/launch').then(async r=>{if(!r.ok)throw Error();return r.json();}).then(v=>{if(live)setState(v);}).catch(()=>{if(live)setMessage('Transfer controls unavailable. Transfers stay off.');});return()=>{live=false;};},[]);
 async function change(){
  if(!state||busy)return;setBusy(true);setMessage('');
  try{const r=await fetch('/api/integrations/xero/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:!state.enabled})});if(!r.ok)throw Error();const value=await r.json();setState({...state,enabled:value.enabled});setMessage(value.enabled?'Xero transfers are on. Queued transfers may now be sent.':'Xero transfers are off. A transfer already sent cannot be recalled.');}
  catch{setMessage('The setting was not confirmed. Reload before trying again.');}finally{setBusy(false);}
 }
 return <section className="rounded-lg border p-4 space-y-2"><h2 className="font-semibold">Xero transfers: {state?.enabled?'ON':'OFF'}</h2><p>Connecting Xero does not turn transfers on. An admin must turn them on for this company after approval.</p><Button disabled={!state||busy||(!state.connected&&!state.enabled)} onClick={()=>void change()}>{state?.enabled?'Turn transfers off':'Turn transfers on'}</Button><p role="status">{message}</p></section>;
}
