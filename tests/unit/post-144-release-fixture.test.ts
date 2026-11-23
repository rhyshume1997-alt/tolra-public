import { expect, it, vi } from "vitest";
import { preparePost144Fixture, storageObjectsDiagnosticSql } from "../support/post-144-release-fixture";
import { releaseRank, post144ProofFiles } from "../support/db-release-sequencer";
function fixture(initial=false) {
  const calls:string[]=[];const states=[initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial,initial];
  const markers=["post-144 marker 145 company_setup","post-144 marker 146 tolra_provided_ai","post-144 marker 147 job_delivery_note","post-144 marker 148 job_profitability_actuals","post-144 marker 149 xero_launch_hold","post-144 marker 150 ai_cap_key_off","post-144 marker 151 xero_invite_hardening","post-144 marker 152 sliq_import_route","post-144 marker 153 document_customer_link","post-144 marker 154 customer_portal_signin","post-144 marker 156 invoice_ref_case","post-144 marker 157 jobs_integrity_guard","post-144 marker 158 machine_run_integrity","post-144 marker 159 drawings_update_roles","post-144 marker 160 legacy_reopen_revoke","post-144 marker 163 chase_steps_atomic","post-144 marker 164 platform_companies","post-144 marker 165 owner_issues","post-144 marker 167 roadmap_rollouts","post-144 marker 170 worksheet_custom"];
  return { calls, states, verify:async()=>{calls.push("identity");},query:async(sql:string)=>{
    calls.push(sql);
    if (sql.includes("AS check_name")) return {rows:[{ok:true,passed:true}]};
    if(sql.includes("-- Post-144 release step 145")) states[0]=true;
    if(sql.includes("-- Post-144 release step 146")) {expect(states[0]).toBe(true);states[1]=true;}
    if(sql.includes("-- Post-144 release step 147")) {expect(states[1]).toBe(true);states[2]=true;}
    if(sql.includes("-- Post-144 release step 148")) {expect(states[2]).toBe(true);states[3]=true;}
    if(sql.includes("-- Post-144 release step 149")) {expect(states[3]).toBe(true);states[4]=true;}
    if(sql.includes("-- Post-144 release step 150")) {expect(states[4]).toBe(true);states[5]=true;}
    if(sql.includes("-- Post-144 release step 151")) {expect(states[5]).toBe(true);states[6]=true;}
    if(sql.includes("-- Post-144 release step 152")) {expect(states[6]).toBe(true);states[7]=true;}
    if(sql.includes("-- Post-144 release step 153")) {expect(states[7]).toBe(true);states[8]=true;}
    if(sql.includes("-- Post-144 release step 154")) {expect(states[8]).toBe(true);states[9]=true;}
    if(sql.includes("-- Post-144 release step 156")) {expect(states[9]).toBe(true);states[10]=true;}
    if(sql.includes("-- Post-144 release step 157")) {expect(states[10]).toBe(true);states[11]=true;}
    if(sql.includes("-- Post-144 release step 158")) {expect(states[11]).toBe(true);states[12]=true;}
    if(sql.includes("-- Post-144 release step 159")) {expect(states[12]).toBe(true);states[13]=true;}
    if(sql.includes("-- Post-144 release step 160")) {expect(states[13]).toBe(true);states[14]=true;}
    if(sql.includes("-- Post-144 release step 163")) {expect(states[14]).toBe(true);states[15]=true;}
    if(sql.includes("-- Post-144 release step 164")) {expect(states[15]).toBe(true);states[16]=true;}
    if(sql.includes("-- Post-144 release step 165")) {expect(states[16]).toBe(true);states[17]=true;}
    if(sql.includes("-- Post-144 release step 167")) {expect(states[17]).toBe(true);states[18]=true;}
    if(sql.includes("-- Post-144 release step 170")) {expect(states[18]).toBe(true);states[19]=true;}
    return {rows:states.map((v,i)=>({check:markers[i],value:v?"applied":"not applied"}))};
  }};
}
it("prepares 145 before 146 before 147 before 148 before 149 before 150 before 151 before 152 only after identity, verifies each and unlocks",async()=>{
 const f=fixture();await preparePost144Fixture(f);expect(f.calls[0]).toBe("identity");
 const a=f.calls.findIndex(s=>s.includes("-- Post-144 release step 145")),b=f.calls.findIndex(s=>s.includes("-- Post-144 release step 146")),c=f.calls.findIndex(s=>s.includes("-- Post-144 release step 147")),p=f.calls.findIndex(s=>s.includes("-- Post-144 release step 148")),d=f.calls.findIndex(s=>s.includes("-- Post-144 release step 149")),e=f.calls.findIndex(s=>s.includes("-- Post-144 release step 150")),g=f.calls.findIndex(s=>s.includes("-- Post-144 release step 151")),h=f.calls.findIndex(s=>s.includes("-- Post-144 release step 152"));
 expect(a).toBeGreaterThan(0);expect(b).toBeGreaterThan(a);expect(c).toBeGreaterThan(b);expect(p).toBeGreaterThan(c);expect(d).toBeGreaterThan(p);expect(e).toBeGreaterThan(d);expect(g).toBeGreaterThan(e);expect(h).toBeGreaterThan(g);expect(f.calls.at(-1)).toContain("pg_advisory_unlock");expect(f.states).toEqual([true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true]);
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

it("sorts real sequencer input without dropping files, keeping 145, 146, the cap race, 147, 148, 149, 150 and 151 last", async () => {
 const { default: ReleaseSequencer } = await import("../support/db-release-sequencer");
 const ctx = {} as ConstructorParameters<typeof ReleaseSequencer>[0];
 const sequencer = new ReleaseSequencer(ctx);
 const baseline = ["catalogue", "definer-functions", "time-labour", "workshop-network-128"].map(name => ({moduleId:`/repo/tests/db/${name}.test.ts`}));
 const proofs = post144ProofFiles.map(name => ({moduleId:`/repo/tests/db/${name}`}));
 expect(post144ProofFiles.slice(-7)).toEqual(["dln-day-of-counter.test.ts", "job-profitability-148.test.ts", "xero-launch-hold-149.test.ts", "xero-launch-paths-149.test.ts", "xero-held-backlog-approval.test.ts", "ai-cap-key-off-150.test.ts", "xero-invite-151.test.ts"]);
 const input = [proofs[12], proofs[11], proofs[10], proofs[9], proofs[8], proofs[7], proofs[6], proofs[5], proofs[4], proofs[3], proofs[2], baseline[3], proofs[1], baseline[0], proofs[0], baseline[2], baseline[1]];
 const original = [...input];
 const sorted = await sequencer.sort(input);
 expect(sorted).toEqual([...baseline, ...proofs]);
 expect(input).toEqual(original);
 expect(await sequencer.shard(input)).toEqual(input);
 const windows = proofs.toReversed().map(spec => ({moduleId:spec.moduleId.replaceAll("/", "\\")}));
 expect((await sequencer.sort(windows)).map(spec => spec.moduleId.replaceAll("\\", "/"))).toEqual(proofs.map(spec => spec.moduleId));
});

it("still runs every verification file when releases are already installed", async () => {
 const f=fixture(true);await preparePost144Fixture(f);
 expect(f.calls.filter(sql=>sql.includes("AS check_name"))).toHaveLength(20);
 expect(f.calls.some(sql=>sql.includes("create_job_delivery_note is security definer with a pinned search path"))).toBe(true);
 expect(f.calls.some(sql=>sql.includes("private membership helper stays private"))).toBe(true);
 expect(f.calls.some(sql=>sql.includes("original reserve is not a public bypass"))).toBe(true);
 expect(f.calls.some(sql=>sql.includes("own-key cap defaults to 1000p on new rows"))).toBe(true);
 expect(f.calls.some(sql=>sql.includes("the claim refuses a held company BEFORE it changes any row"))).toBe(true);
 expect(f.calls.some(sql=>sql.includes("'no_second_rate_store_or_editor'"))).toBe(true);
 expect(f.calls.some(sql=>sql.includes("the 107 token functions are gone"))).toBe(true);
 expect(f.calls.some(sql=>sql.includes("map: each record column is a foreign key with ON DELETE CASCADE"))).toBe(true);
});
it.each(["empty", "false"])("refuses %s verification rows and always unlocks", async failure => {
 const f=fixture(true),original=f.query;
 f.query=async(sql:string)=>{
  if(sql.includes("AS check_name")){f.calls.push(sql);return {rows:failure==="empty"?[]:[{ok:false,passed:false}]};}
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

it("an explicit148 financial target verifies all four dependencies without claiming149/150/151 proof",async()=>{
 const f=fixture();await preparePost144Fixture({...f,through:148});
 expect(f.states).toEqual([true,true,true,true,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false,false]);
 expect(f.calls.filter(sql=>sql.includes('AS check_name'))).toHaveLength(4);
 expect(f.calls.some(sql=>sql.includes('-- Post-144 release step 149'))).toBe(false);
 expect(f.calls.at(-1)).toContain('pg_advisory_unlock');
});

it.each([144,155,161,148.5,Number.NaN])("invalid focused fixture target %s refuses before SQL",async through=>{
 const f=fixture();await expect(preparePost144Fixture({...f,through:through as 148})).rejects.toThrow('Invalid release fixture target');expect(f.calls).toEqual([]);
});

it("a failed fixture prints read-only storage.objects diagnostics and rethrows the ORIGINAL failure, then unlocks",async()=>{
 const spy=vi.spyOn(console,"error").mockImplementation(()=>{});
 const f=fixture(true),original=f.query;
 f.query=async(sql:string)=>{
  if(sql===storageObjectsDiagnosticSql){f.calls.push(sql);return {rows:[{check:"storage.objects owner",value:"supabase_storage_admin"},{check:"current_user",value:"postgres"}]};}
  if(sql.includes("AS check_name")) {f.calls.push(sql);return {rows:[{ok:false,passed:false}]};}
  return original(sql);
 };
 await expect(preparePost144Fixture(f)).rejects.toThrow("Release verification failed");
 expect(f.calls.filter(s=>s===storageObjectsDiagnosticSql)).toHaveLength(1);
 expect(f.calls.at(-1)).toContain("pg_advisory_unlock");
 const printed=spy.mock.calls.map(c=>String(c[0])).join("\n");
 expect(printed).toContain("storage.objects owner: supabase_storage_admin");expect(printed).toContain("current_user: postgres");
 spy.mockRestore();
});
it("a diagnostic error or an unlock error never replaces the original failure",async()=>{
 const spy=vi.spyOn(console,"error").mockImplementation(()=>{});
 const f=fixture(true),original=f.query;
 f.query=async(sql:string)=>{
  if(sql===storageObjectsDiagnosticSql) throw new Error("diagnostic denied");
  if(sql.includes("pg_advisory_unlock")) throw new Error("unlock refused");
  if(sql.includes("AS check_name")) return {rows:[]};
  return original(sql);
 };
 await expect(preparePost144Fixture(f)).rejects.toThrow("Release verification failed");
 spy.mockRestore();
});
it("an unlock error on an otherwise successful run is still reported",async()=>{
 const f=fixture(true),original=f.query;
 f.query=async(sql:string)=>{if(sql.includes("pg_advisory_unlock")) throw new Error("unlock refused");return original(sql);};
 await expect(preparePost144Fixture(f)).rejects.toThrow("unlock refused");
});
it("a successful run prints no diagnostics",async()=>{
 const f=fixture(true);await preparePost144Fixture(f);expect(f.calls).not.toContain(storageObjectsDiagnosticSql);
});
it("the diagnostic SQL is one read-only SELECT: no write, role switch or privilege change",()=>{
 expect(storageObjectsDiagnosticSql.trimStart()).toMatch(/^SELECT /);
 expect(storageObjectsDiagnosticSql).not.toContain(";");
 expect(storageObjectsDiagnosticSql.replace(/'[^']*'/g,"''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|SET|RESET|TRUNCATE|COPY|DO|CALL|EXECUTE)\b/);
 for(const word of ["pg_roles","pg_auth_members","relowner","has_table_privilege","storage.objects"]) expect(storageObjectsDiagnosticSql).toContain(word);
});
it("CI prints the read-only ownership diagnostic on every run, after the Database suite, informational and without changing anything",async()=>{
 const {readFileSync}=await import("node:fs");
 const ci=readFileSync(".github/workflows/ci.yml","utf8");
 const start=ci.indexOf("name: \"Ownership diagnostic (informational, read-only");
 expect(start).toBeGreaterThan(0);
 expect(ci.indexOf("name: Database suite (")).toBeGreaterThan(0);
 expect(start).toBeGreaterThan(ci.indexOf("name: Database suite ("));
 const step=ci.slice(start,ci.indexOf("\n      - name:",start+10));
 expect(step).toContain("if: ${{ always() }}");expect(step).not.toContain("failure()");expect(step).toContain("continue-on-error: true");
 expect(step.match(/<<'SQL'/g)).toHaveLength(1);
 for(const word of ["pg_roles","pg_auth_members","relowner","has_table_privilege","storage.objects"]) expect(step).toContain(word);
 expect(step.replace(/'[^']*'/g,"''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|RESET|TRUNCATE|COPY)\b|SET ROLE|supabase_admin|PASSWORD|TOKEN|SECRET/i);
});
it("ROLLBACK, the diagnostic and the unlock all failing never replace the original exception",async()=>{
 const spy=vi.spyOn(console,"error").mockImplementation(()=>{});
 const f=fixture(true),original=f.query;
 f.query=async(sql:string)=>{
  if(sql==="ROLLBACK") throw new Error("rollback refused");
  if(sql===storageObjectsDiagnosticSql) throw new Error("diagnostic denied");
  if(sql.includes("pg_advisory_unlock")) throw new Error("unlock refused");
  if(sql.includes("AS check_name")) return {rows:[]};
  return original(sql);
 };
 const failure=await preparePost144Fixture(f).then(()=>undefined,e=>e as Error);
 expect(failure?.message).toBe("Release verification failed: post-144 marker 145 company_setup");
 spy.mockRestore();
});

it("after a release fails inside its own transaction: ROLLBACK, then the diagnostic, then the unlock, and the ORIGINAL error is rethrown",async()=>{
 const spy=vi.spyOn(console,"error").mockImplementation(()=>{});
 const f=fixture(),original=f.query;let aborted=false;
 f.query=async(sql:string)=>{
  if(sql==="ROLLBACK"){f.calls.push(sql);aborted=false;return {rows:[]};}
  if(aborted){f.calls.push(sql);throw Object.assign(new Error("current transaction is aborted"),{code:"25P02"});}
  if(sql.includes("-- Post-144 release step 145")){f.calls.push(sql);aborted=true;throw new Error("release 145 failed: original");}
  if(sql===storageObjectsDiagnosticSql){f.calls.push(sql);return {rows:[{check:"storage.objects owner",value:"owner_x"}]};}
  return original(sql);
 };
 await expect(preparePost144Fixture(f)).rejects.toThrow("release 145 failed: original");
 const tail=f.calls.slice(-3);
 expect(tail[0]).toBe("ROLLBACK");expect(tail[1]).toBe(storageObjectsDiagnosticSql);expect(tail[2]).toContain("pg_advisory_unlock");
 expect(spy.mock.calls.map(c=>String(c[0])).join("\n")).toContain("storage.objects owner: owner_x");
 spy.mockRestore();
});

it("CI prints the baseline runner's login evidence: informational, read-only, sanitised, after the environment export and before any release or suite step",async()=>{
 const {readFileSync}=await import("node:fs");
 const {spawnSync}=await import("node:child_process");
 const ci=readFileSync(".github/workflows/ci.yml","utf8");
 const start=ci.indexOf("name: \"Baseline runner evidence (informational, read-only");
 expect(start).toBeGreaterThan(0);
 expect(start).toBeGreaterThan(ci.indexOf("name: Export this job's disposable test environment"));
 expect(start).toBeLessThan(ci.indexOf("name: Database suite ("));
 const step=ci.slice(start,ci.indexOf("\n      - name:",start+10));
 expect(step).toContain("if: ${{ always() }}");expect(step).not.toContain("failure()");expect(step).toContain("continue-on-error: true");
 expect(step).toContain("exit 0");
 expect(step.match(/<<'SQL'/g)).toHaveLength(1);
 const sql=step.slice(step.indexOf("<<'SQL'"),step.indexOf("\n          SQL")).replace(/'[^']*'/g,"''");
 expect(sql).toMatch(/\bpg_class\b/);expect(sql).toMatch(/\bpg_roles\b/);
 expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|RESET|TRUNCATE|COPY|SET|pg_authid|rolpassword)\b/i);
 expect(step).not.toMatch(/SET ROLE|supabase_admin|set -x|printenv|\benv\b|--debug|echo "\$TEST_|-U /i);
 // The log filter, run on a synthetic sample that carries a password, an address and a connection string: only login names and counts come out.
 const filter=step.match(/sed -nE '[^']+'/)?.[0];
 expect(filter).toBeDefined();
 const sample=[
  "2026-11-16 05:00:00 UTC [41] LOG:  connection authorized: user=postgres database=postgres application_name=supabase password=hunter2 host=10.1.2.3",
  "2026-11-16 05:00:01 UTC [42] LOG:  connection authorized: user=supabase_admin database=postgres SSL enabled postgresql://u:pw@10.9.9.9:5432/db",
  "2026-11-16 05:00:02 UTC [43] LOG:  connection authorized: user=postgres database=postgres",
  "2026-11-16 05:00:03 UTC [44] LOG:  statement: select 'user=leak' password=secret",
 ].join("\n");
 const out=spawnSync("bash",["-c",`grep -F 'connection authorized' | ${filter} | sort | uniq -c`],{input:sample,encoding:"utf8"}).stdout;
 expect(out.trim().split("\n").map(l=>l.trim())).toEqual(["2 postgres","1 supabase_admin"]);
 for(const secret of ["hunter2","10.","pw","@","postgresql://","leak","secret"]) expect(out).not.toContain(secret);
});
