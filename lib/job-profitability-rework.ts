import type {SupabaseClient} from '@supabase/supabase-js';
import {fetchAll} from '@/lib/fetch-all';
import type {ReworkEntry,ReworkValue} from '@/lib/job-profitability-progress';
/** Existing RLS-protected records only; complete paging, company/job scope and no silent truncation. */
export async function loadJobRework(db:SupabaseClient,org:string,job:string){
 const result=await fetchAll<ReworkEntry>((from,to)=>db.from('job_rework_entries').select('id,organization_id,job_id,kind,hours').eq('organization_id',org).eq('job_id',job).order('id').range(from,to));
 if(result.truncated)throw Error('Too many rework records to cost safely');
 const values:ReworkValue[]=[];
 const ids=result.rows.filter(e=>e.kind==='material').map(e=>e.id);
 for(let i=0;i<ids.length;i+=200){
  const page=await fetchAll<ReworkValue>((from,to)=>db.from('job_rework_entry_values').select('entry_id,organization_id,material_cost').eq('organization_id',org).in('entry_id',ids.slice(i,i+200)).order('entry_id').range(from,to));
  if(page.truncated)throw Error('Rework prices were truncated');values.push(...page.rows);
 }
 return {entries:result.rows,values};
}
