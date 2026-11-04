import { expect, it } from "vitest";
import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { releaseRank, post144ProofFiles } from "../support/db-release-sequencer";
const isStandaloneVerification=(sql:string)=>sql.includes("AS check_name")&&!sql.includes("proposal_files(file, disposition)");
function fixture(initial=false) {
  const calls:string[]=[];const states=[initial,initial];
  return { calls, states, verify:async()=>{calls.push("identity");},query:async(sql:string)=>{
    calls.push(sql);
    if (isStandaloneVerification(sql)) return {rows:[{ok:true,passed:true}]};
    if(sql.includes("-- Post-144 release step 145")) states[0]=true;
    if(sql.includes("-- Post-144 release step 146")) {expect(states[0]).toBe(true);states[1]=true;}
    return {rows:states.map((v,i)=>({check:i===0?"post-144 marker 145 company_setup":"post-144 marker 146 tolra_provided_ai",value:v?"applied":"not applied"}))};
  }};
}
it("prepares 145 before 146 only after identity, verifies both and unlocks",async()=>{
 const f=fixture();await preparePost144Fixture(f);expect(f.calls[0]).toBe("identity");
 const a=f.calls.findIndex(s=>s.includes("-- Post-144 release step 145")),b=f.calls.findIndex(s=>s.includes("-- Post-144 release step 146"));
 expect(a).toBeGreaterThan(0);expect(b).toBeGreaterThan(a);expect(f.calls.at(-1)).toContain("pg_advisory_unlock");expect(f.states).toEqual([true,true]);
});
it("does not reapply already verified releases",async()=>{const f=fixture(true);await preparePost144Fixture(f);expect(f.calls.some(s=>s.includes("-- Post-144 release step"))).toBe(false);});
it("does not read or write SQL if backend identity refuses",async()=>{const f=fixture();f.verify=async()=>{throw new Error("foreign company");};await expect(preparePost144Fixture(f)).rejects.toThrow("foreign company");expect(f.calls).toEqual([]);});
it("fails if preflight is missing and always releases the lock",async()=>{const f=fixture();f.query=async(sql:string)=>{f.calls.push(sql);return {rows:[]};};await expect(preparePost144Fixture(f)).rejects.toThrow("Missing release preflight");expect(f.calls.at(-1)).toContain("pg_advisory_unlock");});
it("ranks every post-release proof after every baseline file without dropping any",()=>{
 const baseline=["catalogue","definer-functions","time-labour","workshop-network-128"].map(f=>`/repo/tests/db/${f}.test.ts`);
 const proofs=post144ProofFiles.map(f=>`/repo/tests/db/${f}`);const files=[...proofs,...baseline];
 const sorted=files.toSorted((a,b)=>releaseRank(a)-releaseRank(b));expect(sorted).toHaveLength(files.length);
 expect(sorted.slice(0,baseline.length)).toEqual(baseline);expect(sorted.slice(baseline.length)).toEqual(proofs);
});

it("sorts real sequencer input without dropping files, keeping 145, 146 and the cap race last", async () => {
 const { default: ReleaseSequencer } = await import("../support/db-release-sequencer");
 const ctx = {} as ConstructorParameters<typeof ReleaseSequencer>[0];
 const sequencer = new ReleaseSequencer(ctx);
 const baseline = ["catalogue", "definer-functions", "time-labour", "workshop-network-128"].map(name => ({moduleId:`/repo/tests/db/${name}.test.ts`}));
 const proofs = post144ProofFiles.map(name => ({moduleId:`/repo/tests/db/${name}`}));
 const input = [proofs[3], baseline[3], proofs[2], baseline[0], proofs[1], baseline[2], proofs[0], baseline[1]];
 const original = [...input];
 const sorted = await sequencer.sort(input);
 expect(sorted).toEqual([...baseline, ...proofs]);
 expect(input).toEqual(original);
 expect(await sequencer.shard(input)).toEqual(input);
 const windows = proofs.toReversed().map(spec => ({moduleId:spec.moduleId.replaceAll("/", "\\")}));
 expect((await sequencer.sort(windows)).map(spec => spec.moduleId.replaceAll("\\", "/"))).toEqual(proofs.map(spec => spec.moduleId));
});

it("still runs both verification files when releases are already installed", async () => {
 const f=fixture(true);await preparePost144Fixture(f);
 expect(f.calls.filter(sql=>isStandaloneVerification(sql))).toHaveLength(2);
 expect(f.calls.some(sql=>sql.includes("private membership helper stays private"))).toBe(true);
 expect(f.calls.some(sql=>sql.includes("original reserve is not a public bypass"))).toBe(true);
});
it.each(["empty", "false"])("refuses %s verification rows and always unlocks", async failure => {
 const f=fixture(true),original=f.query;
 f.query=async(sql:string)=>{
  if(isStandaloneVerification(sql)){f.calls.push(sql);return {rows:failure==="empty"?[]:[{ok:false,passed:false}]};}
  return original(sql);
 };
 await expect(preparePost144Fixture(f)).rejects.toThrow("Release verification failed");
 expect(f.calls.at(-1)).toContain("pg_advisory_unlock");
});
it("CI has one release owner and retains the full database command and upgrade rehearsal",async()=>{
 const {readFileSync}=await import("node:fs");
 const ci=readFileSync(".github/workflows/ci.yml","utf8");
 expect(ci).toContain("run: npm run test:db");
 expect(ci).toContain("run: scripts/upgrade-rehearsal.sh 013");
 expect(ci).not.toContain("-f supabase/release/145_company_setup.release.sql");
 expect(ci).not.toContain("-f supabase/release/146_tolra_provided_ai.release.sql");
});
