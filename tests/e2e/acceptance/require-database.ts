import {readFileSync} from 'node:fs';
import {expect,test} from '@playwright/test';
import {verifyBackendIdentity,withDb} from '../../support/fixtures';
import {isolatedBackend} from '../../support/isolation';

// No optional-database skips. Collection is safe; execution requires a verified disposable backend.
export function requireReviewerDatabase(){
 test.beforeAll(async()=>{
  if(process.env.REVIEWER_REQUIRE_DATABASE==='0')throw Error('REVIEWER_REQUIRE_DATABASE cannot disable acceptance proofs');
  const backend=isolatedBackend();await verifyBackendIdentity(backend);
  for(const file of ['chase_steps_138','import_source_ref_140','opening_wip_141','accounting_connections_144','company_setup_145','tolra_provided_ai_146']){
   const sql=readFileSync(`supabase/verify/${file}.sql`,'utf8');
   const result=await withDb(db=>db.query(sql),backend);
   expect(result.rows.length,`Missing verification rows: ${file}`).toBeGreaterThan(0);
   expect(result.rows.every(row=>row.ok===true),`Release verification failed: ${file}`).toBe(true);
  }
 });
}
