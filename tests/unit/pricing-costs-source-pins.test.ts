/**
 * Pricing and profit, stage A1: source pins for the guards that no runtime test here can reach (the proposal SQL is rehearsed on the scratch
 * database only, see supabase/proposals/p172_pricing_costing_settings.rehearsal.md; the screens are proven in a real browser by
 * tests/e2e/settings-pricing-costs.spec.ts). Each pin fails if the guard is edited away.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const SQL = read("supabase/proposals/p172_pricing_costing_settings.sql");
const ROLLBACK = read("supabase/proposals/p172_pricing_costing_settings.rollback.sql");

describe("p172 SQL guards", () => {
  it("one table, row security on, no write grant, one select policy for the designated person only", () => {
    expect(SQL).toMatch(/CREATE TABLE public\.company_pricing_costs/);
    expect(SQL).toMatch(/ALTER TABLE public\.company_pricing_costs ENABLE ROW LEVEL SECURITY/);
    expect(SQL).toMatch(/REVOKE ALL ON public\.company_pricing_costs FROM PUBLIC, anon, authenticated/);
    expect(SQL).toMatch(/GRANT SELECT ON public\.company_pricing_costs TO authenticated/);
    expect(SQL).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL|TRUNCATE)[^;]*company_pricing_costs/i);
    expect(SQL.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(SQL).toMatch(/FOR SELECT TO authenticated\s+USING \(organization_id = \(SELECT public\.current_user_organization_id\(\)\)\s+AND profit_viewer_id = \(SELECT auth\.uid\(\)\)\s+AND \(SELECT public\.has_org_role\(ARRAY\['admin'\]\)\)\)/);
  });
  it("every function is a definer with a fixed search_path; the internal guard has no grant; the three callable ones are not for anon", () => {
    expect((SQL.match(/^SECURITY DEFINER$/gm) ?? []).length).toBe(4);
    expect((SQL.match(/^SET search_path = pg_catalog, public$/gm) ?? []).length).toBe(4);
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.pricing_costs_admin_caller\(\) FROM PUBLIC, anon, authenticated/);
    for (const sig of ["pricing_costs_overview()", "set_pricing_profit_viewer(UUID)", "save_pricing_costs(JSONB, INTEGER)"]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
  });
  it("the caller guard asks for the second step, a session, the admin role, and refuses support and read-only sessions", () => {
    const guard = SQL.slice(SQL.indexOf("CREATE FUNCTION public.pricing_costs_admin_caller"), SQL.indexOf("-- ---- 4."));
    for (const needle of ["assert_privileged_aal()", "auth.uid() IS NULL", "has_org_role(ARRAY['admin'])", "'support'", "'read_only'", "ERRCODE = '42501'"]) expect(guard).toContain(needle);
  });
  it("save is for the designated person only, checks the version, and holds no default figure", () => {
    const save = SQL.slice(SQL.indexOf("CREATE FUNCTION public.save_pricing_costs"));
    expect(save).toContain("c.profit_viewer_id = v_uid FOR UPDATE");
    expect(save).toContain("stale_version");
    expect(save).toContain("Invalid figures");
    const table = SQL.slice(SQL.indexOf("CREATE TABLE"), SQL.indexOf("-- ---- 2."));
    expect(table.match(/DEFAULT/g)).toHaveLength(3); // running_costs, version, updated_at: nothing numeric
    expect(table).not.toMatch(/(men|hours_per_week|weeks_per_year|hourly_cost|yearly_target|profit_target_pct)\s+\S+\s+DEFAULT/);
  });
  it("designation: active admins only, any change blanks the figures, audit never holds a figure", () => {
    const set = SQL.slice(SQL.indexOf("CREATE FUNCTION public.set_pricing_profit_viewer"), SQL.indexOf("-- ---- 6."));
    expect(set).toContain("m.role = 'admin'");
    expect(set).toContain("m.active = TRUE");
    expect(set).toMatch(/men = NULL, hours_per_week = NULL, weeks_per_year = NULL, hourly_cost = NULL,\s+yearly_target = NULL, profit_target_pct = NULL, running_costs = '\[\]'::JSONB/);
    const audits = SQL.match(/INSERT INTO security_audit\.audit_log[\s\S]*?\);/g) ?? [];
    expect(audits).toHaveLength(2);
    for (const a of audits) expect(a).not.toMatch(/men|hourly|yearly_target|running_costs|hoursPerWeek/);
  });
  it("rollback refuses while a figure exists and drops only its own objects", () => {
    expect(ROLLBACK).toContain("costing figures exist");
    for (const drop of ["save_pricing_costs(JSONB, INTEGER)", "set_pricing_profit_viewer(UUID)", "pricing_costs_overview()", "public.company_pricing_costs", "pricing_costs_admin_caller()"]) expect(ROLLBACK).toContain(drop);
    expect((ROLLBACK.match(/DROP /g) ?? []).length).toBe(5);
  });
});

describe("the app guards", () => {
  const CARD = read("components/costing/pricing-costs-card.tsx");
  const PANEL = read("components/costing/pricing-costs-panel.tsx");
  const STORE = read("lib/costing/pricing-costs-store.ts");
  it("the panel (and so every query) is mounted only when the switch is on and confirmed; the card is admin only", () => {
    expect(CARD).toContain("{on && confirmedOn ? <PricingCostsPanel");
    expect(CARD).toContain("if (!canSwitchPricingCosts(activeRole)) return null;");
    expect(CARD).toContain("useCompanyUiSwitch(PRICING_COSTS_ON_MARKER)");
  });
  it("the Settings page gets exactly one import and one line", () => {
    const page = read("app/(dashboard)/settings/page.tsx");
    expect(page.match(/PricingCostsCard/g)).toHaveLength(2);
  });
  it("only the store talks to the database, through the table and the three functions", () => {
    expect(PANEL).not.toMatch(/supabase|fetch\(|\.rpc\(|\.from\(/);
    expect(STORE).not.toMatch(/service_role|fetch\(|\/api\//);
    expect(STORE.match(/\.rpc\("([a-z_]+)"/g)).toEqual(['.rpc("pricing_costs_overview"', '.rpc("set_pricing_profit_viewer"', '.rpc("save_pricing_costs"']);
    expect(STORE).toMatch(/\.from\("company_pricing_costs"\)\.select/);
    expect(STORE).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
  it("no figure leaves the screen: no toast, console, storage or URL carries the inputs", () => {
    for (const src of [PANEL, STORE, read("lib/costing/pricing-costs.ts"), read("lib/costing/pricing-costs-form.ts")]) {
      expect(src).not.toMatch(/console\.|localStorage|sessionStorage|toast\(|toast\./);
    }
  });
  it("the wording says profit before dividends and uses the owner's empty-state line", () => {
    expect(PANEL).toContain("PROFIT_BASIS_NOTE");
    expect(read("lib/costing/pricing-costs.ts")).toContain('"profit before dividends"');
    expect(read("lib/costing/pricing-costs.ts")).toContain('"Enter your rates in Settings"');
  });
});
