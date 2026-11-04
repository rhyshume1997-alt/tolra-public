// Fixed repository fake fixtures only. Deliberately does not import the importer's write or CLI modules.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getProfile} from '../sliq-import/mapping.mjs';
import {loadFolder,readWorkbooks} from '../sliq-import/load.mjs';
import {analyse} from '../sliq-import/reconcile.mjs';
import {loadSource} from '../sliq-reconcile/source.mjs';
import {loadSnapshot} from '../sliq-reconcile/snapshot.mjs';
import {reconcile} from '../sliq-reconcile/engine.mjs';
const root=fileURLToPath(new URL('../../tests/fixtures/sliq-reconcile/clean/',import.meta.url));
function hashes(folder){
 const result={};
 for(const name of readdirSync(folder).sort()){
  const file=path.join(folder,name);
  result[name]=createHash('sha256').update(readFileSync(file)).digest('hex');
 }
 return result;
}
export async function fakeDryRun(){
 const source=path.join(root,'sliq'),target=path.join(root,'tolra');
 const before={source:hashes(source),target:hashes(target)};
 const loaded=loadFolder(source,getProfile('synthetic'),{workbooks:await readWorkbooks(source)});
 const {report}=analyse(loaded,{organizationId:'11111111-2222-4333-8444-555555555555'});
 const src=await loadSource(source,{mapping:'synthetic'}),{snapshot}=await loadSnapshot(target);
 const {rows,stats}=reconcile(src,snapshot);
 const counts={BLOCKER:0,WARN:0,UNVERIFIED:0,INFO:0};
 for(const row of rows)counts[row.severity]++;
 const unchanged=JSON.stringify(before)===JSON.stringify({source:hashes(source),target:hashes(target)});
 return {fakeDataOnly:true,databaseConnected:false,databaseWrites:0,fileWrites:0,inputHashes:before,inputUnchanged:unchanged,
  import:{writable:report.writable,errors:report.errors.length,held:report.held.length,needsReview:report.needsReview.length,limits:'No target collision or permissions check; writable is not permission to import.'},
  reconciliation:{status:counts.BLOCKER?'FAIL':counts.WARN||counts.UNVERIFIED?'INCOMPLETE':'PASS',counts,stats,outstanding:rows.filter(row=>row.severity!=='INFO').map(({code,severity,reason})=>({code,severity,reason}))},
  status:unchanged && !report.errors.length && !counts.BLOCKER?'FAKE RUN COMPLETED':'FAIL',
  releaseApproved:false,limitations:['Fake exports and a fake target snapshot, no import occurred.','This is not a real JNR header mapping, wipe, preservation, restore, live isolation or cutover proof.','Held and needs-review records remain explicit. No rounding of source invoice totals.']};
}
