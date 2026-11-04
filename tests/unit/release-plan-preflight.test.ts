import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReleasePlan } from "../../scripts/check-release-plan.mjs";
const root = path.resolve(__dirname, "../..");
const copies: string[] = [];
function tree() {
  const copy = mkdtempSync(path.join(tmpdir(), "tolra-release-plan-"));
  copies.push(copy);
  cpSync(path.join(root,"supabase"),path.join(copy,"supabase"),{recursive:true});
  return copy;
}
afterEach(() => copies.splice(0).forEach(p => rmSync(p,{recursive:true,force:true})));
describe("no proposal silently disappears from release preflight", () => {
  it("covers every proposal, both ordered post-144 packages and every preflight marker", () => {
    expect(checkReleasePlan(root)).toEqual([]);
  });
  it("orders the post-144 phases 145, 146, 147 and leaves the numbered cutover and its catalogue alone", () => {
    const plan = JSON.parse(readFileSync(path.join(root, "supabase/release-plan.json"), "utf8"));
    expect(plan.numbered_through).toBe(144);
    expect(plan.phases.map((p: { number: number; after: string }) => [p.number, p.after])).toEqual([[145, "144"], [146, "145"], [147, "146"]]);
    const c17 = plan.phases[2];
    expect(c17).toMatchObject({ source: "supabase/proposals/c17_job_delivery_note.sql", release: "supabase/release/147_job_delivery_note.release.sql", rollback: "supabase/release/147_job_delivery_note.rollback.sql", verify: "supabase/verify/job_delivery_note_147.sql", marker: "post-144 marker 147 job_delivery_note" });
    const preflight = readFileSync(path.join(root, "supabase/verify/release_preflight.sql"), "utf8");
    expect(preflight).toContain("('supabase/proposals/c17_job_delivery_note.sql', 'post-144 release 147; apply only after 146')");
  });
  it("fails when a new proposal has no plan or preflight disposition", () => {
    const copy=tree();
    writeFileSync(path.join(copy,"supabase/proposals/new_unreviewed.sql"),"SELECT 1;");
    expect(checkReleasePlan(copy)).toContain("Proposal missing from release preflight: supabase/proposals/new_unreviewed.sql");
    expect(checkReleasePlan(copy)).toContain("Proposal missing from release plan: supabase/proposals/new_unreviewed.sql");
  });
  it("fails when an existing proposal path or phase marker is removed from preflight", () => {
    const copy=tree(); const file=path.join(copy,"supabase/verify/release_preflight.sql");
    writeFileSync(file,readFileSync(file,"utf8").replaceAll("'supabase/proposals/n2_tolra_provided_ai.sql'","'removed'").replaceAll("'post-144 marker 145 company_setup'","'removed marker'"));
    expect(checkReleasePlan(copy)).toContain("Proposal missing from release preflight: supabase/proposals/n2_tolra_provided_ai.sql");
    expect(checkReleasePlan(copy)).toContain("Release marker missing: post-144 marker 145 company_setup");
  });
  it("lists 138, 140, 141 and 144 in order for the JNR cutover and refuses a missing file, marker or release", () => {
    const plan = JSON.parse(readFileSync(path.join(root, "supabase/release-plan.json"), "utf8"));
    expect(plan.jnr_cutover_numbered_order.map((entry: { number: number }) => entry.number)).toEqual([138, 140, 141, 144]);
    const copy = tree();
    rmSync(path.join(copy, "supabase/verify/opening_wip_141.sql"));
    const preflight = path.join(copy, "supabase/verify/release_preflight.sql");
    writeFileSync(preflight, readFileSync(preflight, "utf8").replaceAll("'140 import source ref'", "'removed'"));
    const file = path.join(copy, "supabase/release-plan.json");
    const edited = JSON.parse(readFileSync(file, "utf8"));
    edited.jnr_cutover_numbered_order = edited.jnr_cutover_numbered_order.filter((entry: { number: number }) => entry.number !== 138);
    writeFileSync(file, JSON.stringify(edited));
    const problems = checkReleasePlan(copy);
    expect(problems).toContain("Missing cutover verify: supabase/verify/opening_wip_141.sql");
    expect(problems).toContain("Cutover marker missing: 140 import source ref");
    expect(problems).toContain("Required JNR cutover release missing from the plan: 138");
  });
  it("refuses number collisions, reordered dependencies and a stale release copy", () => {
    const copy=tree();const file=path.join(copy,"supabase/release-plan.json");
    const plan=JSON.parse(readFileSync(file,"utf8")); plan.phases[0].number=144;plan.phases[1].after="144";
    writeFileSync(file,JSON.stringify(plan));
    writeFileSync(path.join(copy,"supabase/proposals/n5_company_setup.sql"),readFileSync(path.join(copy,"supabase/proposals/n5_company_setup.sql"),"utf8").replace("completed boolean","completed integer"));
    expect(checkReleasePlan(copy)).toContain("Release/migration number collision");
    expect(checkReleasePlan(copy).some((x:string)=>x.startsWith("Wrong release order"))).toBe(true);
    expect(checkReleasePlan(copy)).toContain("Canonical proposal changed without packaging update: supabase/proposals/n5_company_setup.sql");
  });
});
