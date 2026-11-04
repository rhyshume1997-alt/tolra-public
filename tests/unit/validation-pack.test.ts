import { afterEach, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, {recursive: true, force: true}); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tolra-validation-")); temporary.push(root);
  const pack = join(root, "tests/validation");
  cpSync(resolve("tests/validation"), pack, {recursive: true, filter: path => !path.split(/[\\/]/).includes("evidence")});
  cpSync(resolve("tests/MANUAL-CHECKS-GO-LIVE.md"), join(root, "tests/MANUAL-CHECKS-GO-LIVE.md"));
  const manifestPath = join(pack, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const row of manifest.requirements) for (const kind of ["unit", "database", "browser"]) for (const file of row[kind]) {
    mkdirSync(dirname(join(root, file)), {recursive: true}); writeFileSync(join(root, file), "// synthetic fixture path, never executed\n");
  }
  for (const file of ["package.json", "package-lock.json", "vitest.config.ts"]) writeFileSync(join(root, file), "{}\n");
  function run(script = "check-pack.mjs", args: string[] = []) {
    return spawnSync(process.execPath, [join(pack, script), ...args], {cwd: root, encoding: "utf8", shell: false});
  }
  return {root, pack, manifest, manifestPath, run};
}
it("checks every current candidate mapping without touching a database", () => {
  const result = spawnSync(process.execPath, ["tests/validation/check-pack.mjs"], {encoding: "utf8"});
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("14 requirements");
  const manifest = JSON.parse(readFileSync("tests/validation/manifest.json", "utf8"));
  expect(manifest.base.head).toMatch(/^[a-f0-9]{40}$/);
  expect(result.stdout).toContain(`cites only final SHA ${manifest.base.head}`);
});
it("maps the final-candidate DB, reviewer browser and n1-n6 specs to requirements", () => {
  const manifest = JSON.parse(readFileSync("tests/validation/manifest.json", "utf8"));
  const mapped = new Set(manifest.requirements.flatMap((row: {database: string[]; browser: string[]}) => [...row.database, ...row.browser]));
  const oq = readFileSync("tests/validation/OQ.md", "utf8");
  for (const path of ["tests/db/reviewer-chase-conditions.test.ts", "tests/db/reviewer-inbound-conditions.test.ts", "tests/db/opening-wip-141-isolation.test.ts", "tests/db/sliq-import-preflight-140-141.test.ts", "tests/e2e/reviewer/accounting.spec.ts", "tests/e2e/reviewer/ai-support.spec.ts", "tests/e2e/reviewer/chase.spec.ts", "tests/e2e/reviewer/setup-email-hours.spec.ts", "tests/e2e/n1-n6/n2-tolra-ai.spec.ts", "tests/e2e/n1-n6/n5-setup.spec.ts", "tests/e2e/n1-n6/n6-editor.spec.ts"]) {
    expect(mapped.has(path), path).toBe(true);
    expect(oq, path).toContain(`\`${path}\``);
  }
  for (const v of ["V-ACCOUNTING", "V-AI-CAPS", "V-SETUP-SUPPORT", "V-CHASE-EDIT", "V-CHASE-DOUBLE", "V-CHASE-UNKNOWN", "V-INBOUND", "V-BREAKS", "V-SETUP-ROLES", "V-EMAIL-LEGACY"]) expect(oq, v).toContain(v);
});
it("declares the cutover order and the R1 to R8 restrictions with blank acceptance", () => {
  const manifest = JSON.parse(readFileSync("tests/validation/manifest.json", "utf8"));
  expect(manifest.releaseOrder).toEqual([138, 140, 141, 144, 145, 146]);
  const text = readFileSync("tests/validation/RESTRICTIONS-AND-ASSUMPTIONS.md", "utf8");
  expect(text).toContain("138, 140, 141, 144, 145, 146");
  expect(text).toContain("0.135 becomes 0.14");
  for (const id of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]) expect(text.split("\n").filter(line => line.startsWith(`| ${id} |`) && line.endsWith("| ____ |"))).toHaveLength(1);
});
it.each(["full stale SHA in OQ", "short stale SHA in README", "stale SHA in the manual checklist", "manifest declares a different SHA", "undeclared run id", "stale cutover order", "filled restriction acceptance"])("rejects %s", problem => {
  const f = fixture();
  const edit = (path: string, change: (text: string) => string) => writeFileSync(path, change(readFileSync(path, "utf8")));
  const stale = "fe7514fbea7eaac2fead0237db0fa7d2abcc6db8";
  expect(f.run().status).toBe(0);
  if (problem === "full stale SHA in OQ") edit(join(f.pack, "OQ.md"), text => text + `\nBased on ${stale}\n`);
  if (problem === "short stale SHA in README") edit(join(f.pack, "README.md"), text => text + "\nTested at 41c685c.\n");
  if (problem === "stale SHA in the manual checklist") edit(join(f.root, "tests/MANUAL-CHECKS-GO-LIVE.md"), text => text + `\n${stale.slice(0, 12)}\n`);
  if (problem === "manifest declares a different SHA") { f.manifest.base.head = stale; writeFileSync(f.manifestPath, JSON.stringify(f.manifest)); }
  if (problem === "undeclared run id") edit(join(f.pack, "OUTSTANDING-CHECKS.md"), text => text + "\nRun 41722093670 passed.\n");
  if (problem === "stale cutover order") edit(join(f.pack, "IQ.md"), text => text.replaceAll("138, 140, 141, 144, 145", "138, 144, 145"));
  if (problem === "filled restriction acceptance") edit(join(f.pack, "RESTRICTIONS-AND-ASSUMPTIONS.md"), text => text.replace(/(\| R3 \|.*\| )____ \|/, "$1accepted R.H. 5 Nov |"));
  const result = f.run();
  expect(result.status).not.toBe(0);
  if (problem !== "filled restriction acceptance" && problem !== "stale cutover order") expect(result.stderr).toMatch(/Stale or foreign commit|not declared/);
});
it.each(["missing test", "unsafe database path", "missing manual step", "unmapped URS", "filled VSR"])("rejects %s instead of claiming coverage", problem => {
  const f = fixture();
  if (problem === "missing test") rmSync(join(f.root, f.manifest.requirements[0].unit[0]));
  if (problem === "unsafe database path") {
    f.manifest.requirements[0].unit = ["tests/db/time-labour.test.ts"];
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  }
  if (problem === "missing manual step") {
    const path = join(f.root, "tests/MANUAL-CHECKS-GO-LIVE.md"); writeFileSync(path, readFileSync(path, "utf8").replace("| G03.4 ", "| G99.99 "));
  }
  if (problem === "unmapped URS") {
    const path = join(f.pack, "URS.md"); writeFileSync(path, readFileSync(path, "utf8") + "| URS-999 | Unmapped condition | ____ |\n");
  }
  if (problem === "filled VSR") {
    const path = join(f.pack, "VSR-TEMPLATE.md"); writeFileSync(path, readFileSync(path, "utf8").replace("Rhys, validation lead, name / signature / date: ____", "Rhys, validation lead, name / signature / date: automatically signed"));
  }
  expect(f.run().status).not.toBe(0);
});
it.each(["pass", "failure", "skip", "missing reporter"])("saves honest dated evidence for a unit %s and never starts database commands", outcome => {
  const f = fixture();
  const fakeVitest = join(f.root, "node_modules/vitest/vitest.mjs"); mkdirSync(dirname(fakeVitest), {recursive: true});
  writeFileSync(fakeVitest, `
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const args=process.argv.slice(2), manifest=JSON.parse(readFileSync('tests/validation/manifest.json','utf8'));
const units=[...new Set(manifest.requirements.flatMap(row=>row.unit))].sort();
if (args[0]!=='run'||args[1]!=='--config'||args[2]!=='vitest.config.ts'||JSON.stringify(args.slice(3,3+units.length))!==JSON.stringify(units)||args.some(a=>a.includes('tests/db/')||a.includes('vitest.db'))) throw Error('Unsafe command');
const outcome=${JSON.stringify(outcome)};
console.log('Synthetic unit fixture, no database or provider');
if(outcome!=='missing reporter') {
 const report=args.find(a=>a.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
 const passed=outcome==='pass', skipped=outcome==='skip';
 writeFileSync(report,JSON.stringify({success:passed,numTotalTests:2,numPassedTests:passed?2:1,numFailedTests:outcome==='failure'?1:0,numPendingTests:skipped?1:0,testResults:units.map(file=>({name:resolve(file),assertionResults:[{status:passed?'passed':skipped?'pending':'failed'}]}))}));
}
process.exitCode=outcome==='failure'?1:0;
`);
  execFileSync("git", ["init", "--quiet"], {cwd: f.root});
  execFileSync("git", ["add", "."], {cwd: f.root});
  execFileSync("git", ["-c", "user.name=Synthetic test", "-c", "user.email=synthetic@example.test", "commit", "--quiet", "-m", "Synthetic evidence fixture"], {cwd: f.root});
  const result = f.run("run-evidence.mjs");
  expect(result.status, result.stderr).toBe(outcome === "pass" ? 0 : 1);
  const path = result.stdout.match(/Evidence: (.+\/summary\.json)/)?.[1]; expect(path).toBeDefined();
  expect(path).toMatch(/^tests\/validation\/evidence\/\d{4}-\d{2}-\d{2}T/);
  const summary = JSON.parse(readFileSync(join(f.root, path!), "utf8"));
  expect(summary.status).toBe(outcome === "pass" ? "MAPPED UNIT PASS ONLY" : "FAILED");
  expect(summary.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(summary.commands).toHaveLength(2);
  expect(summary.notRun).toContain("Database permissions and cap race");
  expect(summary.notRun).toContain("VSR approval and Rhys sign-off");
  expect(readFileSync(join(dirname(join(f.root, path!)), "mapped-unit.log"), "utf8")).toContain("Synthetic unit fixture");
  if (outcome === "skip") expect(summary.tests.skipped).toBe(1);
  if (outcome === "failure") expect(summary.tests.failed).toBe(1);
});
