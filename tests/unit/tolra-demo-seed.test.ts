import { describe, expect, it } from "vitest";
import { assertDemoTarget, DEMO_DATABASE, demoPlan, seedDemo, type DemoClient } from "@/scripts/seed-tolra-demo";
const now = new Date("2026-11-03T12:00:00Z");
function database(options: { count?: number; address?: string; fail?: boolean } = {}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let id = 0;
  const db: DemoClient = { async query(text, values = []) {
    calls.push({ text, values });
    if (text.startsWith("SELECT current_database")) return { rows: [{ name: DEMO_DATABASE, role: "postgres", address: options.address ?? "127.0.0.1" }] };
    if (text === "SELECT count(*) AS count FROM public.organizations") return { rows: [{ count: options.count ?? 0 }] };
    if (text.includes("FROM auth.users")) return { rows: [{ id: "fake-owner" }] };
    if (text.includes("create_organization")) return { rows: [{ id: "fake-demo-org" }] };
    if (options.fail && text.includes("INSERT INTO public.jobs")) throw new Error("synthetic failure");
    if (text.includes("FROM security_audit.audit_log")) return { rows: [{ count: 12 }] };
    return { rows: [{ id: `fake-${++id}` }] };
  } };
  return { db, calls };
}
describe("explicitly fake, local-only screenshot seed", () => {
  it("refuses hosted, generic local, production-like and malformed targets", () => {
    for (const url of [undefined, "postgresql://postgres:pw@remote.example/tolra_demo_throwaway", "postgresql://postgres:pw@127.0.0.1/postgres", "postgresql://postgres:pw@127.0.0.1/tolra_demo_throwaway?host=remote.example", "postgresql://user:pw@localhost/tolra_demo_throwaway"]) expect(() => assertDemoTarget(url)).toThrow();
    expect(assertDemoTarget("postgresql://postgres:synthetic@127.0.0.1/tolra_demo_throwaway")).toContain("127.0.0.1");
  });
  it("plans fixed fake names, integer-pence prices and paid/due/overdue cases", () => {
    const plan = demoPlan(now);
    expect(plan.company).toBe("Tolra Demo"); expect(plan.customers).toEqual(["Example Customer A", "Example Customer B", "Example Customer C"]);
    expect(plan.invoices.map(row => [row.status, row.dueDate, row.paidPence])).toEqual([["paid", "2026-11-01", 12345], ["sent", "2026-11-10", 0], ["sent", "2026-10-20", 0]]);
    expect(plan.invoices.every(row => Number.isSafeInteger(row.totalPence))).toBe(true);
  });
  it("checks actual database identity and refuses any existing company before inserting", async () => {
    const remote = database({ address: "203.0.113.1" }); await expect(seedDemo(remote.db, now)).rejects.toThrow(/identity/);
    expect(remote.calls.some(call => call.text === "BEGIN")).toBe(false);
    const occupied = database({ count: 1 }); await expect(seedDemo(occupied.db, now)).rejects.toThrow(/empty/);
    expect(occupied.calls.at(-1)?.text).toBe("ROLLBACK"); expect(occupied.calls.some(call => call.text.startsWith("INSERT"))).toBe(false);
  });
  it("scopes every business insert/update to the newly created demo company and retains guards", async () => {
    const { db, calls } = database();
    expect(await seedDemo(db, now)).toMatchObject({ customers: 3, jobs: 3, invoices: 3, machines: 2, machineTimes: 3, auditRows: 12 });
    for (const call of calls.filter(call => /^(INSERT|UPDATE)/.test(call.text))) expect(call.values[0]).toBe("fake-demo-org");
    expect(calls.filter(call => call.text.includes("INSERT INTO public.invoice_payments"))).toHaveLength(1);
    expect(calls.some(call => /DELETE|TRUNCATE|DISABLE TRIGGER|session_replication_role/.test(call.text))).toBe(false);
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });
  it("rolls back every seed write on a failure, without a partial commit", async () => {
    const { db, calls } = database({ fail: true }); await expect(seedDemo(db, now)).rejects.toThrow("synthetic failure");
    expect(calls.at(-1)?.text).toBe("ROLLBACK"); expect(calls.some(call => call.text === "COMMIT")).toBe(false);
  });
});
