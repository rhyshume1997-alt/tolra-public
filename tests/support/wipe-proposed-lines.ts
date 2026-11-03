export type WipeRow = { ord:number; action:string; table:string; predicate?:string|null; export?:boolean };
export function parseWipeRows(markdown:string): WipeRow[] {
 return [...markdown.matchAll(/^\((\d+),\s*'(WIPE|KEEP|APPEND)',\s*'((?:public|security_audit)\.[a-z_]+)',\s*(NULL|'([^']*)'),\s*(TRUE|FALSE)\),?$/gm)].map(m=>({ord:Number(m[1]),action:m[2],table:m[3],predicate:m[4]==='NULL'?null:m[5],export:m[6]==='TRUE'}));
}
const decisions:Record<string,string>={chase_steps:'KEEP',chase_pauses:'WIPE',chase_sends:'WIPE',costing_materials:'KEEP',costing_machines:'KEEP',costing_defaults:'KEEP',company_setup_progress:'KEEP',ai_helper_tolra_companies:'KEEP',ai_helper_tolra_control:'KEEP'};
export function validateWipeRows(existing:WipeRow[],proposed:WipeRow[]) {
 const problems:string[]=[];const updated=new Map(existing.map(row=>[row.ord,row]));const seen=new Set<number>();
 for(const row of proposed) {
  if(seen.has(row.ord))problems.push(`Duplicate ordinal ${row.ord}`);seen.add(row.ord);
  const old=updated.get(row.ord);
  if(old&&old.table!==row.table)problems.push(`Ordinal collision ${row.ord}`);
  if(old?.action==='KEEP'&&row.action!=='KEEP')problems.push(`Protected table changed: ${row.table}`);
  if(row.action==='WIPE'&&row.predicate!=='organization_id = {org}')problems.push(`Unscoped wipe: ${row.table}`);
  updated.set(row.ord,row);
 }
 for(const [name,action] of Object.entries(decisions)) {
  const rows=proposed.filter(r=>r.table===`public.${name}`);
  if(rows.length!==1||rows[0].action!==action)problems.push(`Wrong/missing reviewer decision: ${name}`);
 }
 for(const child of ['chase_sends','chase_pauses']) {
  const row=proposed.find(r=>r.table===`public.${child}`);
  for(const parent of ['invoices','customers','email_history']) {
   const parentRow=existing.find(r=>r.table===`public.${parent}`);
   if(!row||!parentRow||row.ord>=parentRow.ord)problems.push(`Unsafe parent order: ${child} before ${parent}`);
  }
 }
 const control=proposed.find(r=>r.table==='public.ai_helper_tolra_control');
 if(control?.predicate!==null||control.export!==false)problems.push('Global control must be KEEP, no company predicate, never export');
 const baselineCounts=new Map<string,number>();
 for(const row of existing)baselineCounts.set(row.table,(baselineCounts.get(row.table)??0)+1);
 const tables=new Map<string,number>();
 for(const row of updated.values()) {
  const count=(tables.get(row.table)??0)+1;tables.set(row.table,count);
  if(count>Math.max(1,baselineCounts.get(row.table)??0))problems.push(`Duplicate table ${row.table}`);
 }
 for(const row of proposed)if(row.table!=='public.ai_helper_tolra_control'&&row.predicate!=='organization_id = {org}')problems.push(`Wrong company scope: ${row.table}`);
 const archive=proposed.find(r=>r.table==='security_audit.chase_approval_evidence');
 if(archive?.action!=='KEEP'||archive.export!==false)problems.push('Evidence archive must be protected and not exported');
 for(const table of ['ai_helper_requests','ai_helper_usage'])if(!proposed.some(r=>r.table===`public.${table}`&&r.action==='KEEP'))problems.push(`AI history must be kept: ${table}`);
 return problems;
}
