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
