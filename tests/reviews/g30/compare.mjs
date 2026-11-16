/** Offline only. No DB URL, SQL execution, provider, real data or hidden/truncated difference output. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
function manifest(m) {
 if(!m || m.format_version!==1 || m.table!=='public.ai_helper_requests' || m.read_only!==true || !Array.isArray(m.rows)
   || !Number.isSafeInteger(m.total) || m.total<0 || !m.counts || typeof m.counts!=='object' || Array.isArray(m.counts))throw new Error('Invalid snapshot or missing read-only receipt');
 const ids=new Map(),counts={};
 for(const row of m.rows){
  if(!row || !uuid.test(row.id) || !uuid.test(row.organization_id) || !hash.test(row.row_sha256) || ids.has(row.id))throw new Error('Invalid/duplicate record ID, company or row hash');
  ids.set(row.id,row);counts[row.organization_id]=(counts[row.organization_id]||0)+1;
 }
 if(m.total!==m.rows.length || Object.keys(m.counts).length!==Object.keys(counts).length
   || Object.entries(m.counts).some(([org,n])=>!uuid.test(org)||!Number.isSafeInteger(n)||n!==counts[org]))throw new Error('Count/identity mismatch in snapshot');
 return {ids,counts};
}
export function compareSnapshots(before,after,{jnr,disposition,expectedJnrBefore}={}) {
 if(typeof jnr==='string')jnr=jnr.toLowerCase();
 if(!uuid.test(jnr)||!['WIPE','KEEP'].includes(disposition))throw new Error('Choose the exact target company UUID and approved WIPE or KEEP policy');
 if(expectedJnrBefore!==undefined && (!Number.isSafeInteger(expectedJnrBefore)||expectedJnrBefore<0))throw new Error('Invalid expected baseline count');
 const a=manifest(before),b=manifest(after),differences=[];
 for(const [id,old] of a.ids){
  const next=b.ids.get(id);
  if(!next)differences.push({kind:'removed',id,before_company:old.organization_id,before_hash:old.row_sha256,expected:disposition==='WIPE'&&old.organization_id===jnr});
  else {
   if(next.organization_id!==old.organization_id)differences.push({kind:'owner_changed',id,before_company:old.organization_id,after_company:next.organization_id,expected:false});
   if(next.row_sha256!==old.row_sha256)differences.push({kind:'row_changed',id,before_company:old.organization_id,after_company:next.organization_id,before_hash:old.row_sha256,after_hash:next.row_sha256,expected:false});
  }
 }
 for(const [id,next] of b.ids)if(!a.ids.has(id))differences.push({kind:'added',id,after_company:next.organization_id,after_hash:next.row_sha256,expected:false});
 differences.sort((x,y)=>x.id.localeCompare(y.id)||x.kind.localeCompare(y.kind));
 const companies=[...new Set([jnr,...Object.keys(a.counts),...Object.keys(b.counts)])].sort();
 const counts=companies.map(org=>({organization_id:org,before:a.counts[org]||0,after:b.counts[org]||0,
   expected_after:org===jnr&&disposition==='WIPE'?0:a.counts[org]||0})).map(row=>({...row,ok:row.after===row.expected_after}));
 const baselineOk=expectedJnrBefore===undefined || (a.counts[jnr]||0)===expectedJnrBefore;
 return {table:before.table,policy:{jnr,disposition,expected_jnr_before:expectedJnrBefore??null},
  ok:baselineOk&&counts.every(c=>c.ok)&&differences.every(d=>d.expected),
  baseline_count_ok:baselineOk,totals:{before:before.total,after:after.total},company_counts:counts,
  difference_count:differences.length,differences};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const [before,after,...args]=process.argv.slice(2),options={};
  if(!before||!after||args.length%2)throw new Error('Usage: node compare.mjs before.json after.json --jnr UUID --disposition WIPE|KEEP [--expected-jnr-before 41]');
  for(let i=0;i<args.length;i+=2){
   const key=({'--jnr':'jnr','--disposition':'disposition','--expected-jnr-before':'expectedJnrBefore'})[args[i]];
   if(!key||Object.hasOwn(options,key))throw new Error('Unknown or repeated argument');
   options[key]=key==='expectedJnrBefore'?Number(args[i+1]):args[i+1];
  }
  const first=readFileSync(before,'utf8'),second=readFileSync(after,'utf8');
  const result=compareSnapshots(JSON.parse(first),JSON.parse(second),options);
  result.input_sha256={before:createHash('sha256').update(first).digest('hex'),after:createHash('sha256').update(second).digest('hex')};
  process.stdout.write(JSON.stringify(result,null,2)+'\n');process.exitCode=result.ok?0:1;
 }catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=2;}
}
