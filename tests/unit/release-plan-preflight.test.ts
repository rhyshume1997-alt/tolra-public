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
  it("orders the post-144 phases 145, 146, 147, 148, 149, 150, 151, 152 and leaves the numbered cutover and its catalogue alone", () => {
    const plan = JSON.parse(readFileSync(path.join(root, "supabase/release-plan.json"), "utf8"));
    expect(plan.numbered_through).toBe(144);
    expect(plan.phases.map((p: { number: number; after: string }) => [p.number, p.after])).toEqual([[145, "144"], [146, "145"], [147, "146"], [148, "147"], [149, "148"], [150, "149"], [151, "150"], [152, "151"], [153, "152"], [154, "153"], [156, "154"], [157, "156"], [158, "157"], [159, "158"], [160, "159"], [163, "160"], [164, "163"], [165, "164"], [167, "165"], [170, "167"]]);
    const c17 = plan.phases[2];
    expect(c17).toMatchObject({ source: "supabase/proposals/c17_job_delivery_note.sql", release: "supabase/release/147_job_delivery_note.release.sql", rollback: "supabase/release/147_job_delivery_note.rollback.sql", verify: "supabase/verify/job_delivery_note_147.sql", marker: "post-144 marker 147 job_delivery_note" });
    const preflight = readFileSync(path.join(root, "supabase/verify/release_preflight.sql"), "utf8");
    expect(preflight).toContain("('supabase/proposals/c17_job_delivery_note.sql', 'post-144 release 147; apply only after 146')");
    expect(plan.phases[3]).toMatchObject({ source: "supabase/proposals/p148_job_profitability_actuals.sql", release: "supabase/release/148_job_profitability_actuals.release.sql", rollback: "supabase/release/148_job_profitability_actuals.rollback.sql", verify: "supabase/verify/job_profitability_actuals_148.sql", marker: "post-144 marker 148 job_profitability_actuals" });
    expect(preflight).toContain("('supabase/proposals/p148_job_profitability_actuals.sql', 'post-144 release 148; apply only after 147 (reads only 143''s rates)')");
    expect(plan.phases[4]).toMatchObject({ source: "supabase/proposals/x149_xero_launch_hold.sql", release: "supabase/release/149_xero_launch_hold.release.sql", rollback: "supabase/release/149_xero_launch_hold.rollback.sql", verify: "supabase/verify/xero_launch_hold_149.sql", marker: "post-144 marker 149 xero_launch_hold" });
    expect(preflight).toContain("('supabase/proposals/x149_xero_launch_hold.sql', 'post-144 release 149; apply only after 147')");
    expect(plan.phases[6]).toMatchObject({ source: "supabase/proposals/p151_xero_invite_hardening.sql", release: "supabase/release/151_xero_invite_hardening.release.sql", rollback: "supabase/release/151_xero_invite_hardening.rollback.sql", verify: "supabase/verify/xero_invite_hardening_151.sql", marker: "post-144 marker 151 xero_invite_hardening" });
    expect(preflight).toContain("('supabase/proposals/p151_xero_invite_hardening.sql', 'post-144 release 151; apply only after 150 (replaces 107''s token invite functions; no 107 token link survives)')");
    expect(plan.phases[7]).toMatchObject({ number: 152, after: "151", source: "supabase/proposals/p152_sliq_import_route.sql", release: "supabase/release/152_sliq_import_route.release.sql", rollback: "supabase/release/152_sliq_import_route.rollback.sql", verify: "supabase/verify/sliq_import_route_152.sql", marker: "post-144 marker 152 sliq_import_route" });
    expect(preflight).toContain("('supabase/proposals/p152_sliq_import_route.sql', 'post-144 release 152; apply only after 151 (SliQ go-live import route over 076/085; an addition to 138..151)')");
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
  it("lists 138, 140, 141, 143 and 144 in order for the JNR cutover and refuses a missing file, marker or release", () => {
    const plan = JSON.parse(readFileSync(path.join(root, "supabase/release-plan.json"), "utf8"));
    expect(plan.jnr_cutover_numbered_order.map((entry: { number: number }) => entry.number)).toEqual([138, 140, 141, 143, 144]);
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

// Numbering and chain regressions (release 160 was renumbered row 62 -> 63 and L14 -> L15 when 159 landed first). Each check is a pure
// function over the file text, run on the real files and on an in-memory copy with a duplicate, so it is proven able to fail.
/** The check number of every release "NNN needs: ..." row of release preflight, with its release, in file order. */
function needsRows(preflight: string) {
  return [...preflight.matchAll(/SELECT (\d+), '(\d{3}) needs:/g)].map(m => ({ row: Number(m[1]), release: Number(m[2]) }));
}
/** Every explicit check number of release preflight ("SELECT <n>, '...'"), in file order. */
function checkNumbers(preflight: string) {
  return [...preflight.matchAll(/SELECT (\d+), '/g)].map(m => Number(m[1]));
}
/** The limitation ids of the summary table ("| L<n> |") and of the detailed headings ("### L<n>."), in file order. */
function limitationIds(doc: string) {
  return { table: [...doc.matchAll(/^\| (L\d+) \|/gm)].map(m => m[1]), headings: [...doc.matchAll(/^### (L\d+)\./gm)].map(m => m[1]) };
}
const duplicates = <T>(xs: T[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
describe("release preflight rows, limitation ids and the release chain stay unique and complete", () => {
  const preflight = readFileSync(path.join(root, "supabase/verify/release_preflight.sql"), "utf8");
  const limitations = readFileSync(path.join(root, "docs/release/KNOWN-LIMITATIONS-AND-RECOVERY.md"), "utf8");
  it("every release 'needs' row of release preflight has its own row number, each post-144 release one row; 159 is row 62 and 160 is row 63", () => {
    const rows = needsRows(preflight);
    expect(rows.length).toBeGreaterThan(20);
    expect(duplicates(rows.map(r => r.row))).toEqual([]);
    // Release 017 has three needs rows of its own (three different things it needs); a post-144 release has exactly one.
    expect(duplicates(rows.filter(r => r.release >= 145).map(r => r.release))).toEqual([]);
    expect(duplicates(checkNumbers(preflight))).toEqual([]);
    expect(rows.filter(r => r.release >= 157)).toEqual([{ row: 60, release: 157 }, { row: 61, release: 158 }, { row: 62, release: 159 }, { row: 63, release: 160 }, { row: 64, release: 163 }, { row: 65, release: 164 }, { row: 66, release: 165 }, { row: 67, release: 167 }, { row: 68, release: 170 }]);
    // Proven able to fail: a later release that reused row 63.
    const reused = preflight.replace("  UNION ALL SELECT 100 + row_number() OVER (), 'marker ' || migration,", "  UNION ALL SELECT 63, '161 needs: reused', 'x', 'y'\n  UNION ALL SELECT 100 + row_number() OVER (), 'marker ' || migration,");
    expect(reused).not.toBe(preflight);
    expect(duplicates(needsRows(reused).map(r => r.row))).toEqual([63]);
    expect(duplicates(checkNumbers(reused))).toEqual([63]);
  });
  it("every limitation id is unique in the summary table and in the detailed headings, and the two lists agree; 159 is L14 and 160 is L15", () => {
    const ids = limitationIds(limitations);
    expect(ids.table.length).toBeGreaterThanOrEqual(15);
    expect(duplicates(ids.table)).toEqual([]);
    expect(duplicates(ids.headings)).toEqual([]);
    expect(ids.headings).toEqual(ids.table);
    expect(limitations).toMatch(/^\| L14 \| Release 159:/m);
    expect(limitations).toMatch(/^\| L15 \| Release 160:/m);
    expect(limitations).toMatch(/^### L14\. Release 159:/m);
    expect(limitations).toMatch(/^### L15\. Release 160:/m);
    // Proven able to fail: a later release that reused L15, in the table and in a heading.
    const reused = limitationIds(limitations.replace(/^(\| L15 \|.*\n)/m, "$1| L15 | Release 161: reused | x | Low | x |\n").replace(/^(### L15\. )/m, "### L15. Release 161: reused\n\n$1"));
    expect(duplicates(reused.table)).toEqual(["L15"]);
    expect(duplicates(reused.headings)).toEqual(["L15"]);
  });
  it("the release plan and the fixture both run 157, 158 and 159 before 160, none missing, each phase once and in rising order", () => {
    const plan = JSON.parse(readFileSync(path.join(root, "supabase/release-plan.json"), "utf8")) as { phases: { number: number; after: string }[] };
    const fixture = [...readFileSync(path.join(root, "tests/support/post-144-release-fixture.ts"), "utf8").matchAll(/\{ number: (\d+), marker: "/g)].map(m => Number(m[1]));
    const chainOk = (order: number[]) => duplicates(order).length === 0 && order.every((n, i) => i === 0 || n > order[i - 1])
      && [157, 158, 159].every(n => order.includes(n) && order.indexOf(n) < order.indexOf(160)) && order.indexOf(160) === order.indexOf(159) + 1;
    for (const [name, order] of [["plan", plan.phases.map(p => p.number)], ["fixture", fixture]] as const) {
      expect(order.slice(-10), name).toEqual([156, 157, 158, 159, 160, 163, 164, 165, 167, 170]);
      expect(chainOk(order), name).toBe(true);
    }
    expect(plan.phases.find(p => p.number === 160)?.after).toBe("159");
    // Proven able to fail: 159 missing, 160 before 159, or 160 twice.
    expect(chainOk([156, 157, 158, 160])).toBe(false);
    expect(chainOk([156, 157, 158, 160, 159])).toBe(false);
    expect(chainOk([156, 157, 158, 159, 160, 160])).toBe(false);
  });
});
