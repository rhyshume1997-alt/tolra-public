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
    expect(files).toContain("144_accounting_connections.sql");
    const preflight = read("supabase/verify/release_preflight.sql");
    expect(preflight).toContain("('138 chase steps'");
    expect(preflight).toContain("('144 accounting connections'");
    expect(preflight).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  });
  it("runs the numbered catalogue and upgrade before both guarded proposal proofs", () => {
    const ci = read(".github/workflows/ci.yml");
    const upgrade = ci.indexOf("run: scripts/upgrade-rehearsal.sh 013");
    const n5 = ci.indexOf("-f supabase/proposals/n5_company_setup.sql");
    const n2 = ci.indexOf("-f supabase/proposals/n2_tolra_provided_ai.sql");
    expect(upgrade).toBeGreaterThan(0);
    expect(n5).toBeGreaterThan(upgrade);
    expect(n2).toBeGreaterThan(n5);
    const specs = ["company-setup-isolation", "tolra-provided-ai", "tolra-ai-cap-concurrency"];
    for (const spec of specs) {
      expect(ci.slice(0, upgrade)).toContain(`--exclude tests/db/${spec}.test.ts`);
      expect(ci.slice(upgrade)).toContain(`tests/db/${spec}.test.ts`);
    }
    for (const [start, end] of [[ci.lastIndexOf("      - name:", n5), n2], [ci.lastIndexOf("      - name:", n2), ci.indexOf("      - name: Build against", n2)]]) {
      expect(ci.slice(start, end)).toContain('case "$TEST_DATABASE_URL" in postgresql://*@127.0.0.1:*)');
      expect(ci.slice(start, end)).toContain('END {exit (bad || NR == 0)}');
    }
  });
  it("keeps both independently named functions and chase tables in the numbered snapshot, with no proposal tables", () => {
    const catalogue = JSON.parse(read("tests/db/catalogue.snapshot.json")) as Array<{kind: string; object: string}>;
    const keys = catalogue.map(row => `${row.kind}:${row.object}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of ["public.accounting_cloud_connections_ready()", "public.accounting_cloud_enqueue()"])
      expect(catalogue.some(row => row.kind === "function" && row.object === name)).toBe(true);
    for (const name of ["public.chase_steps", "public.chase_sends", "public.chase_pauses"])
      expect(catalogue.some(row => row.object === name)).toBe(true);
    expect(catalogue.some(row => /company_setup_progress|ai_helper_tolra_(control|companies)/.test(row.object))).toBe(false);
  });
});
