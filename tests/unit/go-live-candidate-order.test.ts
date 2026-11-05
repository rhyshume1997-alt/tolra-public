import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const read = (file: string) => readFileSync(resolve(__dirname, "../..", file), "utf8");
describe("combined go-live candidate keeps both release lines and proposal proofs", () => {
  it("has unique numbered migrations and retains both new preflight markers", () => {
    const files = readdirSync(resolve(__dirname, "../../supabase/migrations")).filter(f => /^\d{3}_.*\.sql$/.test(f));
    const numbers = files.map(f => f.slice(0, 3));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(files).toContain("138_chase_steps.sql");
    expect(files).toContain("140_import_source_ref.sql");
    expect(files).toContain("141_opening_wip.sql");
    expect(files).toContain("144_accounting_connections.sql");
    const preflight = read("supabase/verify/release_preflight.sql");
    expect(preflight).toContain("('138 chase steps'");
    expect(preflight).toContain("('140 import source ref'");
    expect(preflight).toContain("('141 opening wip'");
    expect(preflight).toContain("('144 accounting connections'");
    expect(preflight.indexOf("('138 chase steps'")).toBeLessThan(preflight.indexOf("('140 import source ref'"));
    expect(preflight.indexOf("('140 import source ref'")).toBeLessThan(preflight.indexOf("('141 opening wip'"));
    expect(preflight.indexOf("('141 opening wip'")).toBeLessThan(preflight.indexOf("('144 accounting connections'"));
    expect(preflight).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  });
  it("runs the full ordered database proofs once, then the independent upgrade rehearsal", async () => {
    const ci = read(".github/workflows/ci.yml");
    const upgrade = ci.indexOf("run: scripts/upgrade-rehearsal.sh 013");
    expect(upgrade).toBeGreaterThan(0);
    expect(ci.slice(0, upgrade)).toContain("run: npm run test:db");
    expect(ci.slice(0, upgrade)).not.toContain("--exclude");
    expect(ci.match(/run: npm run test:db/g)).toHaveLength(1);
    expect(ci).not.toContain("-f supabase/release/145_company_setup.release.sql");
    expect(ci).not.toContain("-f supabase/release/146_tolra_provided_ai.release.sql");
    const {default: ReleaseSequencer, post144ProofFiles} = await import("../support/db-release-sequencer");
    const paths = readdirSync(resolve(__dirname, "../../tests/db")).filter(file => file.endsWith(".test.ts")).map(file => ({moduleId: `/repo/tests/db/${file}`}));
    const sequencer = new ReleaseSequencer({} as ConstructorParameters<typeof ReleaseSequencer>[0]);
    const sorted = await sequencer.sort(paths.toReversed());
    expect(sorted).toHaveLength(paths.length);
    expect(new Set(sorted.map(file=>file.moduleId))).toEqual(new Set(paths.map(file=>file.moduleId)));
    expect(sorted.slice(-post144ProofFiles.length).map(file=>file.moduleId)).toEqual(post144ProofFiles.map(file=>`/repo/tests/db/${file}`));
    expect(post144ProofFiles).toContain("job-delivery-note-147.test.ts");
    expect(post144ProofFiles).toContain("ai-cap-key-off-150.test.ts");
    const fixture = read("tests/support/post-144-release-fixture.ts");
    expect(fixture.indexOf('verifyFile: "supabase/verify/company_setup_145.sql"')).toBeLessThan(fixture.indexOf('verifyFile: "supabase/verify/tolra_provided_ai_146.sql"'));
    expect(fixture.indexOf('verifyFile: "supabase/verify/tolra_provided_ai_146.sql"')).toBeLessThan(fixture.indexOf('verifyFile: "supabase/verify/job_delivery_note_147.sql"'));
    expect(ci).toContain("147_job_delivery_note|job_delivery_note_147|post-144 marker 147 job_delivery_note");
    expect(fixture.indexOf('verifyFile: "supabase/verify/job_delivery_note_147.sql"')).toBeLessThan(fixture.indexOf('verifyFile: "supabase/verify/ai_cap_key_off_150.sql"'));
    expect(ci).toContain("150_ai_cap_key_off|ai_cap_key_off_150|post-144 marker 150 ai_cap_key_off");
    expect(fixture).toContain("verify: verifyBackendIdentity");
    expect(fixture).toContain("checks.some(row => (row.ok ?? row.passed) !== true)");
  });
  it("keeps both independently named functions and chase tables in the numbered snapshot, with no proposal tables", () => {
    const catalogue = JSON.parse(read("tests/db/catalogue.snapshot.json")) as Array<{kind: string; object: string}>;
    const keys = catalogue.map(row => `${row.kind}:${row.object}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of ["public.accounting_cloud_connections_ready()", "public.accounting_cloud_enqueue()"])
      expect(catalogue.some(row => row.kind === "function" && row.object === name)).toBe(true);
    for (const name of ["public.opening_wip", "public.source_ref_import_only()"])
      expect(catalogue.some(row => row.object === name)).toBe(true);
    for (const name of ["public.chase_steps", "public.chase_sends", "public.chase_pauses"])
      expect(catalogue.some(row => row.object === name)).toBe(true);
    expect(catalogue.some(row => /company_setup_progress|ai_helper_tolra_(control|companies)|create_job_delivery_note|delivery_notes_request_guard/.test(row.object))).toBe(false);
  });
});
