import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {releaseGate,policy,policySha256} from '../../scripts/release-gate/check.mjs';
const mandatoryIds:string[]=policy.required;
const HEAD='a'.repeat(40),OLD='b'.repeat(40),HASH='c'.repeat(64);
function fixture(){
 const artifacts=new Map<string,string>();
 const results=mandatoryIds.map((id:string)=>({id,commit:HEAD,status:'PASS',artifact:{path:id+'.json',sha256:''}}));
 const manifest={finalCommit:HEAD,policySha256,results};
 const payload=(id:string)=>({id,commit:HEAD,status:'PASS',recordedUtc:'2026-11-04T09:00:00Z',counts:{total:2,passed:2,failed:0,skipped:0},backupSha256:HASH,beforeFingerprint:HASH,restoredFingerprint:HASH,restoredOnDisposable:true,integrityMatch:true,appliedReleases:[...policy.requiredReleases],markers:Object.fromEntries(policy.requiredReleases.map((n:number)=>[String(n),'applied'])),exactPence:true,marpetUnchanged:true,matched:true,fakeDataOnly:true,realDataTouched:false,allStopRulesPassed:true,skippedTests:[] as string[],acceptedSkips:[] as {testId:string;commit:string;acceptedBy:string;reason:string;acceptedUtc:string;reviewEvidence:string}[]});
 const set=(id:string,changes:Record<string,unknown>)=>{const text=JSON.stringify({...payload(id),...changes});artifacts.set(id+'.json',text);results.find(r=>r.id===id)!.artifact.sha256=createHash('sha256').update(text).digest('hex');};
 for(const id of mandatoryIds)set(id,{});
 const check=()=>releaseGate(manifest,HEAD,(p:string)=>{if(!artifacts.has(p))throw Error('Missing');return artifacts.get(p)!;});
 return {manifest,artifacts,set,payload,check};
}
it('a complete fake evidence set is only ready for independent review, never approved',()=>{expect(fixture().check()).toMatchObject({eligibleForReview:true,approvalGranted:false});});
it.each(mandatoryIds)('refuses missing mandatory %s',id=>{const f=fixture();f.manifest.results=f.manifest.results.filter(r=>r.id!==id);expect(f.check().eligibleForReview).toBe(false);});
it.each(mandatoryIds)('refuses failed %s',id=>{const f=fixture();f.manifest.results.find(r=>r.id===id)!.status='FAIL';expect(f.check().eligibleForReview).toBe(false);});
it.each(['final commit','policy','duplicate','old result','artifact missing','artifact modified','old artifact','bad date','empty suite','failed case','unaccepted skip','bad migration order','145 missing','146 failed','restore mismatch','no restore','bad reconciliation','real data touched'])("refuses %s",problem=>{
 const f=fixture();
 if(problem==='final commit')f.manifest.finalCommit=OLD;
 if(problem==='policy')f.manifest.policySha256='';
 if(problem==='duplicate')f.manifest.results.push({...f.manifest.results[0]});
 if(problem==='old result')f.manifest.results[0].commit=OLD;
 if(problem==='artifact missing')f.artifacts.clear();
 if(problem==='artifact modified')f.artifacts.set('db-full.json','{}');
 if(problem==='old artifact')f.set('db-full',{commit:OLD});
 if(problem==='bad date')f.set('db-full',{recordedUtc:''});
 if(problem==='empty suite')f.set('db-full',{counts:{total:0,passed:0,failed:0,skipped:0}});
 if(problem==='failed case')f.set('db-full',{counts:{total:2,passed:1,failed:1,skipped:0}});
 if(problem==='unaccepted skip')f.set('post-release-browser',{counts:{total:2,passed:1,failed:0,skipped:1}});
 if(problem==='bad migration order')f.set('preflight',{appliedReleases:[138,144,140,141,145,146]});
 if(problem==='145 missing')f.set('preflight',{markers:{146:'applied'}});
 if(problem==='146 failed')f.set('preflight',{markers:{...f.payload('preflight').markers,146:'not applied'}});
 if(problem==='restore mismatch')f.set('backup-restore',{restoredFingerprint:'d'.repeat(64)});
 if(problem==='no restore')f.set('backup-restore',{restoredOnDisposable:false});
 if(problem==='bad reconciliation')f.set('reconciliation',{marpetUnchanged:false});
 if(problem==='real data touched')f.set('mock-production',{realDataTouched:true});
 expect(f.check().eligibleForReview).toBe(false);
});
it('requires an exact-head Rhys waiver for each permitted skipped browser case',()=>{
 const f=fixture(),counts={total:2,passed:1,failed:0,skipped:1},waiver={testId:'cosmetic-only',commit:HEAD,acceptedBy:'Rhys',reason:'Reviewed narrow visual limitation',acceptedUtc:'2026-11-04T09:01:00Z',reviewEvidence:'review/private-reference'};
 f.set('post-release-browser',{counts,skippedTests:['cosmetic-only'],acceptedSkips:[waiver]});expect(f.check().eligibleForReview).toBe(true);
 for(const change of [{commit:OLD},{acceptedBy:'someone'},{reason:''},{reviewEvidence:''},{acceptedUtc:''}]){f.set('post-release-browser',{counts,skippedTests:['cosmetic-only'],acceptedSkips:[{...waiver,...change}]});expect(f.check().eligibleForReview).toBe(false);}
 f.set('db-ai-cap-race',{counts,skippedTests:['cosmetic-only'],acceptedSkips:[waiver]});expect(f.check().eligibleForReview).toBe(false);
});

it('refuses a dirty checkout even when all supplied evidence matches HEAD',()=>{const f=fixture();expect(releaseGate(f.manifest,HEAD,(p:string)=>f.artifacts.get(p)!,false).eligibleForReview).toBe(false);});
it('keeps every mandatory release and proof in the policy',()=>{
 expect(policy.requiredReleases).toEqual([138,140,141,144,145,146]);
 expect(policy.required).toEqual(['backup-restore','preflight','db-full','db-two-company','db-import-140-141','db-chase-atomic','db-chase-exact-once','db-chase-edit','db-paid-claims','db-inbound-never-paid','db-cross-company','db-ai-cap-race','db-ai-key-isolation','db-ai-owner-mfa','db-accounting-isolation','db-rollback','post-release-browser','reconciliation','mock-production','unit','typecheck','lint']);
});
