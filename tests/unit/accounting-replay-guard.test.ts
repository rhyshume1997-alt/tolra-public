import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const baseline = read("supabase/migrations/084_integrations_xero.sql");
const added = read("supabase/migrations/144_accounting_connections.sql");
function body(sql: string, name: string): string | undefined {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) return undefined;
  const after = sql.slice(start);
  return after.match(/AS \$\$([\s\S]*?)\$\$;/)?.[1];
}
const hash = (text: string) => createHash("md5").update(text.replace(/\s/g, "")).digest("hex");
describe("144 does not poison the 044-onwards replay before labour/network migrations", () => {
  it("preserves the exact function body required by the unchanged 084 preflight", () => {
    const expected = baseline.match(/\('public\.integration_enqueue\(\)', '([a-f0-9]{32})'\)/)?.[1];
    expect(expected).toBe("26bba3708dd4f02328376e1cd632f7d0");
    expect(hash(body(baseline, "integration_enqueue")!)).toBe(expected);
    // Model only the actual guard's input: 144 replaces this body if it defines the same name.
    const installed = body(added, "integration_enqueue") ?? body(baseline, "integration_enqueue")!;
    expect(hash(installed), "084 must not stop after older 051/078 definitions have committed and before 092/128 restore them").toBe(expected);
  });
  it("keeps the same Xero-only enqueue behaviour under its own trigger function and restores targets on rollback", () => {
    const expected = body(baseline, "integration_enqueue")!.replace("c.organization_id = NEW.organization_id AND c.status", "c.organization_id = NEW.organization_id AND c.provider = 'xero' AND c.status");
    expect(body(added, "accounting_cloud_enqueue")).toBe(expected);
    expect(added.match(/EXECUTE FUNCTION public\.accounting_cloud_enqueue\(\)/g)).toHaveLength(2);
    expect(added).toContain("REVOKE ALL ON FUNCTION public.accounting_cloud_enqueue() FROM PUBLIC, anon, authenticated");
    const rollback = read("supabase/release/144_accounting_connections.rollback.sql");
    expect(rollback.match(/EXECUTE FUNCTION public\.integration_enqueue\(\)/g)).toHaveLength(2);
    expect(rollback.indexOf("EXECUTE FUNCTION public.integration_enqueue()")).toBeLessThan(rollback.indexOf("DROP FUNCTION public.accounting_cloud_enqueue()"));
  });
});
