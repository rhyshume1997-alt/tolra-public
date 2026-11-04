/** Disposable-only post-baseline preparation. Never imported by application code. */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {verifyBackendIdentity,withDb} from './fixtures';
export async function prepareSliqCutoverBackend(){
 await verifyBackendIdentity();
 const root=path.resolve(__dirname,'../..'),read=(f:string)=>readFileSync(path.join(root,f),'utf8');
 const plan=JSON.parse(read('supabase/cutover-import-plan.json'));
 await withDb(async db=>{
  await db.query('SELECT pg_advisory_lock(140141)');
  try{for(const phase of plan.imports){
   const state=(await db.query(read('supabase/verify/release_preflight.sql'))).rows.find(r=>r.check===phase.marker);
   if(!state)throw new Error(`Missing import marker ${phase.marker}`);
   if(state.value!=='applied')await db.query(read(phase.release));
   const checks=(await db.query(read(phase.verify))).rows;
   if(!checks.length||checks.some(r=>r.ok!==true))throw new Error(`Import release verification failed: ${phase.number}`);
  }}finally{await db.query('SELECT pg_advisory_unlock(140141)');}
 });
}
