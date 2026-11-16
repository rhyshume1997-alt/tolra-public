import { describe, expect, it } from "vitest";

import { THROWAWAY_FLAG, assertThrowaway, importPayload, planDemoData } from "../../scripts/demo-seed/plan.mjs";

const LOCAL = { TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", TEST_SUPABASE_URL: "http://127.0.0.1:54321", TEST_SUPABASE_SERVICE_ROLE_KEY: "local" };

describe("demo seed guards", () => {
  it("runs only with the flag and loopback addresses", () => {
    expect(() => assertThrowaway({ argv: [THROWAWAY_FLAG], env: LOCAL })).not.toThrow();
    expect(() => assertThrowaway({ argv: [], env: LOCAL })).toThrow(/Refusing/);
    expect(() => assertThrowaway({ argv: [THROWAWAY_FLAG], env: { ...LOCAL, TEST_DATABASE_URL: "postgresql://u:p@db.abcdef.supabase.co:5432/postgres" } })).toThrow(/not this machine/);
    expect(() => assertThrowaway({ argv: [THROWAWAY_FLAG], env: { ...LOCAL, TEST_SUPABASE_URL: "https://abcdef.supabase.co" } })).toThrow(/not this machine/);
    expect(() => assertThrowaway({ argv: [THROWAWAY_FLAG], env: { ...LOCAL, TEST_DATABASE_URL: "" } })).toThrow(/not set/);
    expect(() => assertThrowaway({ argv: [THROWAWAY_FLAG], env: { ...LOCAL, TEST_SUPABASE_SERVICE_ROLE_KEY: "" } })).toThrow(/SERVICE_ROLE/);
  });
});

describe("demo seed data is clearly fake and covers the screenshots", () => {
  const today = new Date(Date.UTC(2026, 10, 3));
  const plan = planDemoData(today);

  it("has three Example customers, jobs, and paid / due / overdue invoices", () => {
    expect(plan.customers.map((c) => c.name)).toEqual(["Example Customer A", "Example Customer B", "Example Customer C"]);
    expect(plan.jobs.length).toBeGreaterThanOrEqual(3);
    const states = new Set(plan.invoices.map((i) => i.state));
    expect(states).toEqual(new Set(["paid", "due", "overdue"]));
    for (const inv of plan.invoices) {
      if (inv.state === "overdue") expect(inv.due_date < "2026-11-03").toBe(true);
      if (inv.state === "due") expect(inv.due_date > "2026-11-03").toBe(true);
    }
    expect(plan.payments).toHaveLength(1);
    expect(plan.times.length).toBeGreaterThanOrEqual(2);
  });

  it("uses only example addresses, a fake profile, and round amounts", () => {
    for (const c of plan.customers) expect(c.email).toMatch(/@example\.test$/);
    expect(String(plan.profile.email)).toMatch(/@example\.test$/);
    for (const inv of plan.invoices) for (const l of inv.lines) expect(Number.isInteger(l.unit_price) && l.unit_price % 5 === 0).toBe(true);
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/marpet|jnr|tolra\.co\.uk|rhyshume/i);
  });

  it("the payment fully pays the paid invoice (10 x 10 + 20% VAT = 120)", () => {
    const paid = plan.invoices.find((i) => i.state === "paid")!;
    const net = paid.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
    expect(plan.payments.find((p) => p.invoice_ref === paid.invoice_ref)!.amount).toBe(net * 1.2);
  });

  it("the import payload leaves out the internal state marker", () => {
    const payload = importPayload(plan) as { invoices: Record<string, unknown>[] };
    expect(payload.invoices.every((i) => !("state" in i))).toBe(true);
  });
});
