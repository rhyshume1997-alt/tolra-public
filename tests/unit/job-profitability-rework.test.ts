import {expect,it} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {loadJobRework} from '@/lib/job-profitability-rework';
it('pages all recorded rework and scopes every read to company/job and selected material identities',async()=>{
 const calls:{table:string;filters:unknown[]}[]=[];
 const db={from:(table:string)=>{
  const filters:unknown[]=[];calls.push({table,filters});
  const q={select:()=>q,eq:(k:string,v:string)=>{filters.push([k,v]);return q;},in:(k:string,v:string[])=>{filters.push([k,v]);return q;},order:()=>q,
   range:async(from:number)=>({data:(table==='job_rework_entries'?[{id:'h',organization_id:'A',job_id:'job',kind:'hours',hours:1},{id:'m',organization_id:'A',job_id:'job',kind:'material'}]:[{entry_id:'m',organization_id:'A',material_cost:2}]).slice(from,from+1),error:null})};return q;
 }} as unknown as SupabaseClient;
 const r=await loadJobRework(db,'A','job');expect(r.entries).toHaveLength(2);expect(r.values).toHaveLength(1);
 for(const c of calls){expect(c.filters).toContainEqual(['organization_id','A']);if(c.table==='job_rework_entries')expect(c.filters).toContainEqual(['job_id','job']);else expect(c.filters).toContainEqual(['entry_id',['m']]);}
});
it('propagates failed record reads so the caller keeps costing incomplete',async()=>{
 const db={from:()=>{throw Error('synthetic read refused');}} as unknown as SupabaseClient;
 await expect(loadJobRework(db,'A','job')).rejects.toThrow('read refused');
});
