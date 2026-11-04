import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const policyText=readFileSync(new URL('./policy.json',import.meta.url),'utf8');
export const policy=JSON.parse(policyText);
export const policySha256=createHash('sha256').update(policyText).digest('hex');
const sha=/^[a-f0-9]{40}$/,hash=/^[a-f0-9]{64}$/;
export function releaseGate(manifest,actualHead,readArtifact,checkoutClean=true){
 const errors=[];
 if(checkoutClean!==true)errors.push('Checkout is not clean');
 if(!sha.test(actualHead??''))errors.push('Actual final commit is not a full SHA');
 if(!manifest||manifest.finalCommit!==actualHead||!sha.test(manifest.finalCommit??''))errors.push('Manifest does not match actual final commit');
 if(manifest?.policySha256!==policySha256)errors.push('Evidence policy missing or differs');
 const entries=Array.isArray(manifest?.results)?manifest.results:[];
 const ids=entries.map(row=>row?.id);
 if(new Set(ids).size!==ids.length)errors.push('Duplicate result IDs');
 for(const id of policy.required){
  const record=entries.find(row=>row?.id===id);
  if(!record){errors.push(`Missing mandatory result: ${id}`);continue;}
  if(record.commit!==actualHead)errors.push(`Older/different result commit: ${id}`);
  if(record.status!=='PASS')errors.push(`Result is not PASS: ${id}`);
  let evidence;
  try{
   if(!hash.test(record.artifact?.sha256??''))throw Error('invalid hash');
   const text=readArtifact(record.artifact.path);
   if(createHash('sha256').update(text).digest('hex')!==record.artifact.sha256)throw Error('hash mismatch');
   evidence=JSON.parse(text);
   if(evidence.id!==id||evidence.commit!==actualHead||evidence.status!=='PASS')throw Error('artifact identity/status mismatch');
  }catch{errors.push(`Missing, altered or stale artifact: ${id}`);continue;}
  if(evidence.exitCode!==0)errors.push(`Command did not exit successfully: ${id}`);
  if(!Number.isFinite(Date.parse(evidence.recordedUtc??'')))errors.push(`Missing result date: ${id}`);
  const isSuite=id.startsWith('db-')||['post-release-browser','unit'].includes(id);
  if(isSuite){
   if(evidence.unhandledErrors!==0||evidence.collectionErrors!==0)errors.push(`Unhandled/collection errors missing or nonzero: ${id}`);
   const c=evidence.counts;
   if(!c||![c.total,c.passed,c.failed,c.skipped].every(n=>Number.isSafeInteger(n)&&n>=0)||c.total===0||c.failed!==0||c.passed+c.skipped!==c.total)errors.push(`Incomplete/failed test counts: ${id}`);
   else if(c.skipped){
    const skipped=evidence.skippedTests,waivers=evidence.acceptedSkips;
    if(!policy.skipWaiversAllowedFor.includes(id)||!Array.isArray(skipped)||new Set(skipped).size!==c.skipped||!Array.isArray(waivers)||waivers.length!==c.skipped)errors.push(`Unaccepted mandatory skips: ${id}`);
    else for(const test of skipped){
     const w=waivers.find(row=>row&&row.testId===test);
     if(!w||w.commit!==actualHead||w.acceptedBy!=='Rhys'||typeof w.reason!=='string'||!w.reason.trim()||!Number.isFinite(Date.parse(w.acceptedUtc??''))||typeof w.reviewEvidence!=='string'||!w.reviewEvidence.trim())errors.push(`Skip lacks exact-head accepted reason: ${id}/${test}`);
    }
   }
  }
  if(id==='backup-restore'&&(!hash.test(evidence.backupSha256??'')||!hash.test(evidence.beforeFingerprint??'')||evidence.beforeFingerprint!==evidence.restoredFingerprint||evidence.restoredOnDisposable!==true||evidence.integrityMatch!==true))errors.push('Backup restore integrity not proved');
  if(id==='preflight'){
   if(JSON.stringify(evidence.appliedReleases)!==JSON.stringify(policy.requiredReleases))errors.push('Required migration order missing/differs');
   for(const n of policy.requiredReleases)if(evidence.markers?.[String(n)]!=='applied')errors.push(`Missing/failed migration marker ${n}`);
  }
  if(id==='reconciliation'&&(evidence.exactPence!==true||evidence.marpetUnchanged!==true||evidence.matched!==true))errors.push('Exact-pence/Marpet reconciliation missing');
  if(id==='mock-production'&&(evidence.fakeDataOnly!==true||evidence.realDataTouched!==false||evidence.allStopRulesPassed!==true))errors.push('Mock production safeguards missing');
 }
 return {status:errors.length?'REFUSE':'READY FOR INDEPENDENT REVIEW',eligibleForReview:!errors.length,approvalGranted:false,finalCommit:actualHead,policySha256,errors};
}
