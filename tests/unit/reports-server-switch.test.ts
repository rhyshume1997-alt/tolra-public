/**
 * BOUNDARY: proves the server gate of the Reports and Revenue layouts. Input: fake Supabase clients that record every call. Output: failing
 * assertions if an OFF (or refused) company reaches any report table read, or if the switches stop being independent.
 * Must not change: loosening a rule here needs Rhys's decision.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let state: { role: boolean | null; roleError: boolean; hiddenNav: string[] | null; row: boolean; error: boolean; client: boolean } = { role: true, roleError: false, hiddenNav: [], row: true, error: false, client: true };

vi.mock("@/lib/server/auth", () => ({
  isErrorResponse: (v: unknown) => (v as { refused?: boolean })?.refused === true,
  requireProfile: async (roles: string[]) => {
    calls.push(`requireProfile:${roles.join("+")}`);
    if (!state.client || state.roleError || !state.role) return { refused: true };
    return {
      supabase: {
        from: (table: string) => ({
          select: () => ({ maybeSingle: async () => { calls.push(`from:${table}`); return { data: state.row ? { hidden_nav: state.hiddenNav } : null, error: state.error ? { code: "x" } : null }; } }),
        }),
      },
    };
  },
}));

import ReportsOperationsLayout from "@/app/(dashboard)/reports/(operations)/layout";
import RevenueLayout from "@/app/(dashboard)/reports/revenue/layout";
import { decideSwitch } from "@/lib/reports/server-switch";
import { reportsEnabled } from "@/lib/reports/reports-switch";
import { revenueEnabled } from "@/lib/reports/revenue/revenue-switch";

const CHILD = { marker: "child" } as unknown as React.ReactNode;
const set = (patch: Partial<typeof state>) => { state = { role: true, roleError: false, hiddenNav: [], row: true, error: false, client: true, ...patch }; };
const root = path.resolve(__dirname, "../..");
const REPORT_TABLES = /invoices|payments|quotes|jobs|credit_notes|sales_order|ncr|time_entries/;

beforeEach(() => { calls.length = 0; set({}); });

describe("decideSwitch", () => {
  const read = (over = {}) => ({ ok: true, roleAllowed: true, hiddenNav: ["reports:on"], ...over });
  it("is on only with a good read, an allowed role and the module's own marker", () => {
    expect(decideSwitch(reportsEnabled, read())).toBe(true);
    expect(decideSwitch(reportsEnabled, read({ ok: false }))).toBe(false);
    expect(decideSwitch(reportsEnabled, read({ roleAllowed: false }))).toBe(false);
    expect(decideSwitch(reportsEnabled, read({ hiddenNav: null }))).toBe(false);
    expect(decideSwitch(reportsEnabled, read({ hiddenNav: [] }))).toBe(false);
    expect(decideSwitch(reportsEnabled, read({ hiddenNav: ["Reports:on"] }))).toBe(false);
    expect(decideSwitch(reportsEnabled, read({ hiddenNav: ["reports-revenue:on"] }))).toBe(false);
    expect(decideSwitch(revenueEnabled, read({ hiddenNav: ["reports:on"] }))).toBe(false);
    expect(decideSwitch(revenueEnabled, read({ hiddenNav: ["reports-revenue:on"] }))).toBe(true);
  });
});

describe("layouts stop before any report data is read when OFF or refused", () => {
  const cases: Array<[string, Partial<typeof state>]> = [
    ["switch off", { hiddenNav: [] }],
    ["no company row", { row: false }],
    ["read error", { error: true }],
    ["no session or refused profile", { client: false }],
    ["workshop or viewer", { role: false, hiddenNav: ["reports:on", "reports-revenue:on"] }],
    ["role check error", { roleError: true, hiddenNav: ["reports:on", "reports-revenue:on"] }],
  ];
  for (const [name, patch] of cases) {
    for (const [label, Layout] of [["reports", ReportsOperationsLayout], ["revenue", RevenueLayout]] as const) {
      it(`${label}: ${name} returns the notice, never the children`, async () => {
        set(patch);
        const out = (await Layout({ children: CHILD })) as { props: { children: unknown } };
        expect(out.props.children).not.toBe(CHILD);
        expect(JSON.stringify(out)).toContain(`${label}-off`);
        expect(calls.filter((c) => c.startsWith("from:") && c !== "from:organization_settings")).toEqual([]);
        expect(calls.join(",")).not.toMatch(REPORT_TABLES);
      });
    }
  }

  it("admin or office with the switch ON passes the children through", async () => {
    set({ hiddenNav: ["reports:on"] });
    expect(((await ReportsOperationsLayout({ children: CHILD })) as { props: { children: unknown } }).props.children).toBe(CHILD);
    set({ hiddenNav: ["reports-revenue:on"] });
    expect(((await RevenueLayout({ children: CHILD })) as { props: { children: unknown } }).props.children).toBe(CHILD);
  });

  it("the two switches are independent", async () => {
    set({ hiddenNav: ["reports:on"] });
    expect(JSON.stringify(await RevenueLayout({ children: CHILD }))).toContain("revenue-off");
    set({ hiddenNav: ["reports-revenue:on"] });
    expect(JSON.stringify(await ReportsOperationsLayout({ children: CHILD }))).toContain("reports-off");
  });

  it("only ever reads organization_settings and the role check", async () => {
    set({ hiddenNav: ["reports:on"] });
    await ReportsOperationsLayout({ children: CHILD });
    expect(calls).toEqual(["requireProfile:admin+office", "from:organization_settings"]);
  });
});

describe("source", () => {
  it("the layouts and helper hold no report data read and the old page moved without a layout above revenue", () => {
    for (const f of ["lib/reports/server-switch.ts", "app/(dashboard)/reports/(operations)/layout.tsx", "app/(dashboard)/reports/revenue/layout.tsx"]) {
      const text = readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(text, f).not.toMatch(/components\/reports|load-reports|load-revenue|service[_-]?role/i);
      expect(text.match(/\.from\(/g)?.length ?? 0, f).toBeLessThanOrEqual(f.startsWith("lib") ? 1 : 0);
    }
  });
});
