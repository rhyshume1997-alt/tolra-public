/**
 * Machines on sales-order lines, carried to the job (migration 043), through the real API path: Supabase Auth + PostgREST with signed-in
 * synthetic users, so the database's own rules are under test.
 *
 *   * set_sales_order_line_machines: admin and office set a line's machines; workshop, viewer and anon can't; another company's order,
 *     line or machine is refused; a refusal leaves nothing behind; refused once the order is converted;
 *   * the plan is read by the four company roles and written by the function only (no insert, update or delete grant);
 *   * a rebuild of the order's lines (ensure_sales_order_lines after the value changed) keeps the plan: rows re-attach by position;
 *   * convert_sales_order carries the plan summed per machine (two lines on one machine make one job_machines row), each machine
 *     booked at its next free slot (061; before 061 no booking) and the source line kept; converting again carries nothing more; an
 *     order without a plan converts as before;
 *   * set_job_machines: admin, office and workshop edit hours, add, remove and book after conversion; viewer refused; cross-company
 *     refused; a clash (found by the function from the bookings) refused for non-admins and audited for an admin; a bad machine rolls the whole edit back; the order's plan is untouched;
 *   * the read-only verify script is clean.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generatePassword } from "@/lib/password";

import { enrolTotp, passSecondStep } from "../support/totp";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, setRequireAdminMfaForTest, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let mill: string;
let lathe: string;
let retired: string;
let betaMachine: string;
let betaOrder: string;
let betaJob: string;
let n = 0;

const START = "2026-11-02T08:00:00Z";
const LINES = [{ description: "Flange 80mm", quantity: 12, unit_price: 150, vat_pct: 20 }, { description: "Spacer", quantity: 4, unit_price: 2.5, vat_pct: 0 }];

/** An order for the alpha company: with a two-line quote whose net equals the order (two order lines), or plain (one summary line). */
async function order(withQuote: boolean, over: Record<string, unknown> = {}) {
  n += 1;
  const service = adminClient();
  const org = world.tenants.alpha.id;
  let quoteId: string | null = null;
  const ref = `QUO-SOM-${world.runId}-${n}`;
  if (withQuote) {
    const { data: quote, error } = await service.from("quotes").insert({ organization_id: org, quote_ref: ref, customer: "Acme", status: "draft", total_value: 0 }).select("id").single();
    if (error) throw new Error(error.message);
    quoteId = quote.id;
    const { error: lineError } = await service.from("quote_line_items").insert(LINES.map((l, position) => ({ ...l, position, quote_id: quoteId, organization_id: org })));
    if (lineError) throw new Error(lineError.message);
    const pence = (x: number) => Math.round(x * 100);
    const total = LINES.reduce((sum, l) => { const net = pence(l.quantity * l.unit_price); return sum + net + Math.round(net * l.vat_pct / 100); }, 0) / 100;
    expect((await service.from("quotes").update({ total_value: total, vat_enabled: true }).eq("id", quoteId)).error).toBeNull();
    expect((await service.from("quotes").update({ status: "accepted" }).eq("id", quoteId)).error).toBeNull();
  }
  const { data, error } = await service.from("sales_orders").insert({
    organization_id: org, so_number: `PO-SOM-${world.runId}-${n}`, customer_po: `PO-SOM-${world.runId}-${n}`, customer: "Acme", quote_id: quoteId, quote_ref: withQuote ? ref : null,
    total_value: withQuote ? 1810 : 480, status: "open", order_date: "2026-10-09", ...over,
  }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
/** The order's lines, made if need be (as the dialog does), by position. */
async function lines(client: SupabaseClient, orderId: string) {
  const ensured = await client.rpc("ensure_sales_order_lines", { p_order: orderId });
  if (ensured.error) throw new Error(ensured.error.message);
  const { data } = await client.from("sales_order_lines").select("id, position, description").eq("sales_order_id", orderId).order("position");
  return data!;
}
const setLine = (client: SupabaseClient, orderId: string, lineId: string, machines: unknown) => client.rpc("set_sales_order_line_machines", { p_order: orderId, p_line: lineId, p_machines: machines });
const setJob = (client: SupabaseClient, jobId: string, machines: unknown, over: { p_clash_override?: boolean; p_clashes?: unknown; p_override_reason?: string | null } = {}) =>
  client.rpc("set_job_machines", { p_job: jobId, p_machines: machines, p_clash_override: false, p_clashes: [], p_override_reason: null, ...over });
const plan = async (orderId: string) => (await adminClient().from("sales_order_line_machines").select("line_key, sales_order_line_id, machine_id, estimated_hours, position").eq("sales_order_id", orderId).order("line_key").order("position")).data!;
const jobPlan = async (jobId: string) => (await adminClient().from("job_machines").select("machine_id, estimated_hours, booking_id, position, source_so_line_id").eq("job_id", jobId).order("position")).data!;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  const service = adminClient();
  const machine = async (org: string, name: string, active = true) => (await service.from("machines").insert({ organization_id: org, name, active }).select("id").single()).data!.id as string;
  mill = await machine(world.tenants.alpha.id, `SOM Mill ${world.runId}`);
  lathe = await machine(world.tenants.alpha.id, `SOM Lathe ${world.runId}`);
  retired = await machine(world.tenants.alpha.id, `SOM Old saw ${world.runId}`, false);
  betaMachine = await machine(world.tenants.beta.id, `SOM Beta Mill ${world.runId}`);
  betaOrder = (await service.from("sales_orders").insert({ organization_id: world.tenants.beta.id, so_number: `PO-SOM-B-${world.runId}`, customer: "Beta customer", total_value: 100, status: "open" }).select("id").single()).data!.id;
  betaJob = (await service.from("jobs").insert({ organization_id: world.tenants.beta.id, job_no: `J-SOMB-${world.runId}`, customer: "Beta customer" }).select("id").single()).data!.id;
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("setting the machines on an order line", () => {
  it.each(["admin", "office"])("%s sets a line's machines and hours; the whole company reads them, nobody writes the table directly", async (role) => {
    const id = await order(false);
    const [summary] = await lines(as[role], id);
    expect(summary.description).toMatch(/^Customer order PO-SOM-/);
    const { data, error } = await setLine(as[role], id, summary.id, [{ machine_id: mill, hours: 3 }, { machine_id: lathe, hours: 1.5 }]);
    expect(error).toBeNull();
    expect(data.machines.map((m: { machine_id: string; hours: number }) => [m.machine_id, m.hours])).toEqual([[mill, 3], [lathe, 1.5]]);
    expect((await plan(id)).map((r) => [r.line_key, r.sales_order_line_id, r.machine_id, Number(r.estimated_hours), r.position])).toEqual([[0, summary.id, mill, 3, 0], [0, summary.id, lathe, 1.5, 1]]);
    // Replaces the line's plan.
    expect((await setLine(as[role], id, summary.id, [{ machine_id: lathe, hours: 2 }])).error).toBeNull();
    expect((await plan(id)).map((r) => [r.machine_id, Number(r.estimated_hours)])).toEqual([[lathe, 2]]);
    for (const reader of ["workshop", "viewer"]) {
      expect((await as[reader].from("sales_order_line_machines").select("machine_id, estimated_hours").eq("sales_order_id", id)).data).toEqual([{ machine_id: lathe, estimated_hours: 2 }]);
    }
    expect((await as.betaAdmin.from("sales_order_line_machines").select("id").eq("sales_order_id", id)).data).toEqual([]);
    expect((await as.admin.from("sales_order_line_machines").insert({ organization_id: world.tenants.alpha.id, sales_order_id: id, line_key: 0, machine_id: mill, estimated_hours: 1 })).error?.code).toBe("42501");
    expect((await as.admin.from("sales_order_line_machines").update({ estimated_hours: 9 }).eq("sales_order_id", id).select("id")).data ?? []).toEqual([]);
    expect((await as.admin.from("sales_order_line_machines").delete().eq("sales_order_id", id).select("id")).data ?? []).toEqual([]);
    const audit = await withDb((db) => db.query("select action, metadata from security_audit.audit_log where entity_table = 'sales_orders' and entity_id = $1 and action = 'SET_SO_LINE_MACHINES' order by created_at", [id]));
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[1].metadata.before.map((m: { hours: number }) => m.hours)).toEqual([3, 1.5]);
  });

  it("workshop, viewer and anon can't; another company's order, line or machine is refused and leaves nothing", async () => {
    const id = await order(false);
    const [summary] = await lines(as.admin, id);
    expect((await setLine(as.workshop, id, summary.id, [{ machine_id: mill, hours: 1 }])).error?.code).toBe("42501");
    expect((await setLine(as.viewer, id, summary.id, [{ machine_id: mill, hours: 1 }])).error?.code).toBe("42501");
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    expect((await setLine(anon, id, summary.id, [])).error).not.toBeNull();
    expect((await setLine(as.betaAdmin, id, summary.id, [{ machine_id: mill, hours: 1 }])).error?.code).toBe("P0002");
    expect((await setLine(as.admin, betaOrder, summary.id, [{ machine_id: mill, hours: 1 }])).error?.code).toBe("P0002");
    // A line of another order in the same company is not this order's line.
    const other = await order(false);
    const [otherLine] = await lines(as.admin, other);
    expect((await setLine(as.admin, id, otherLine.id, [{ machine_id: mill, hours: 1 }])).error?.code).toBe("P0002");
    expect((await setLine(as.admin, id, summary.id, [{ machine_id: lathe, hours: 1 }, { machine_id: betaMachine, hours: 1 }])).error?.code).toBe("P0002");
    expect((await setLine(as.admin, id, summary.id, [{ machine_id: retired, hours: 1 }])).error?.code).toBe("P0002");
    expect((await setLine(as.admin, id, summary.id, [{ machine_id: mill, hours: 1 }, { machine_id: mill, hours: 2 }])).error?.code).toBe("22023");
    expect((await setLine(as.admin, id, summary.id, [{ machine_id: mill, hours: 1001 }])).error?.code).toBe("22023");
    expect((await setLine(as.admin, id, summary.id, [{ machine_id: mill }])).error?.code).toBe("22023");
    expect((await setLine(as.admin, id, summary.id, Array.from({ length: 11 }, (_, i) => ({ machine_id: i % 2 ? mill : lathe, hours: 1 })))).error?.code).toBe("22023");
    expect(await plan(id)).toEqual([]);
    expect(await plan(betaOrder)).toEqual([]);
  });

  it("a rebuild of the order's lines keeps the plan: rows re-attach to the rebuilt line by position", async () => {
    const id = await order(true);
    const two = await lines(as.office, id);
    expect(two.map((l) => l.description)).toEqual(["Flange 80mm", "Spacer"]);
    expect((await setLine(as.office, id, two[0].id, [{ machine_id: mill, hours: 4 }])).error).toBeNull();
    expect((await setLine(as.office, id, two[1].id, [{ machine_id: lathe, hours: 1 }])).error).toBeNull();
    // The order's value changes before anything is despatched: ensure_sales_order_lines deletes and rebuilds the lines.
    expect((await adminClient().from("sales_orders").update({ total_value: 1810.5 }).eq("id", id)).error).toBeNull();
    // The quote's lines no longer add up to the order, so the rebuild is ONE summary line for the order's value.
    const rebuilt = await lines(as.office, id);
    expect(rebuilt.map((l) => l.description)).toEqual([expect.stringMatching(/^Customer order PO-SOM-/)]);
    // Detached by the rebuild (ON DELETE SET NULL), still there; line 0's rows re-attach by position on the next write, line 1's stay
    // detached (no such line now) and are still carried to the job.
    expect((await plan(id)).map((r) => [r.line_key, r.sales_order_line_id, r.machine_id])).toEqual([[0, null, mill], [1, null, lathe]]);
    // Line 0's rows re-attach by position on the next write; line 1's rows have no line any more and are removed (never carried twice).
    expect((await setLine(as.office, id, rebuilt[0].id, [{ machine_id: mill, hours: 5 }])).error).toBeNull();
    expect((await plan(id)).map((r) => [r.line_key, r.sales_order_line_id, r.machine_id, Number(r.estimated_hours)])).toEqual([[0, rebuilt[0].id, mill, 5]]);
    const stale = await withDb((db) => db.query("select metadata -> 'stale_removed' as s from security_audit.audit_log where entity_table = 'sales_orders' and entity_id = $1 and action = 'SET_SO_LINE_MACHINES' order by created_at desc limit 1", [id]));
    expect(stale.rows[0].s).toEqual([{ line_key: 1, machine_id: lathe, hours: 1 }]);
    const { data, error } = await as.office.rpc("convert_sales_order", { p_order: id });
    expect(error).toBeNull();
    expect(data).toEqual({ job_id: expect.any(String), job_no: expect.stringMatching(/^J-/), created: true });
    expect((await jobPlan(data.job_id)).map((r) => [r.machine_id, Number(r.estimated_hours), r.source_so_line_id])).toEqual([[mill, 5, rebuilt[0].id]]);
  });

  it("a rebuild followed straight by a conversion carries nothing stale either", async () => {
    const id = await order(true);
    const two = await lines(as.office, id);
    expect((await setLine(as.office, id, two[0].id, [{ machine_id: mill, hours: 4 }])).error).toBeNull();
    expect((await setLine(as.office, id, two[1].id, [{ machine_id: mill, hours: 1 }, { machine_id: lathe, hours: 2 }])).error).toBeNull();
    expect((await adminClient().from("sales_orders").update({ total_value: 1810.5 }).eq("id", id)).error).toBeNull();
    await lines(as.office, id);
    const { data, error } = await as.office.rpc("convert_sales_order", { p_order: id });
    expect(error).toBeNull();
    expect((await jobPlan(data.job_id)).map((r) => [r.machine_id, Number(r.estimated_hours)])).toEqual([[mill, 4]]);
    expect((await plan(id)).map((r) => r.line_key)).toEqual([0]);
  });

  it("a machine may not carry more than 1000 hours across the order's lines; refused when set, not capped", async () => {
    const id = await order(true);
    const two = await lines(as.admin, id);
    expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 600 }])).error).toBeNull();
    const over = await setLine(as.admin, id, two[1].id, [{ machine_id: mill, hours: 500 }, { machine_id: lathe, hours: 1 }]);
    expect(over.error?.code).toBe("22023");
    expect(over.error?.message).toContain("1000");
    expect((await plan(id)).map((r) => [r.line_key, r.machine_id, Number(r.estimated_hours)])).toEqual([[0, mill, 600]]);
    expect((await setLine(as.admin, id, two[1].id, [{ machine_id: mill, hours: 400 }])).error).toBeNull();
  });

  it("the workshop with the sales-orders section hidden reads no plan rows", async () => {
    const id = await order(false);
    const [summary] = await lines(as.admin, id);
    expect((await setLine(as.admin, id, summary.id, [{ machine_id: mill, hours: 2 }])).error).toBeNull();
    expect((await as.workshop.from("sales_order_line_machines").select("id").eq("sales_order_id", id)).data).toHaveLength(1);
    expect((await as.admin.rpc("set_member_access", { p_user: world.tenants.alpha.users.workshop.id, p_hidden_sections: ["sales-orders"] })).error).toBeNull();
    try {
      expect((await as.workshop.from("sales_order_line_machines").select("id").eq("sales_order_id", id)).data).toEqual([]);
      // The job's plan is not behind that gate: the workshop still reads job_machines.
      expect((await as.workshop.from("job_machines").select("id").limit(1)).error).toBeNull();
    } finally {
      expect((await as.admin.rpc("set_member_access", { p_user: world.tenants.alpha.users.workshop.id, p_hidden_sections: [] })).error).toBeNull();
    }
  });

  it("an admin at aal1 in a company that requires the second step can still open despatch on a planned order whose value changed", async () => {
    const id = await order(true);
    const two = await lines(as.admin, id);
    expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 4 }])).error).toBeNull();
    expect((await adminClient().from("sales_orders").update({ total_value: 1810.5 }).eq("id", id)).error).toBeNull();
    const converted = await order(true);
    const cl = await lines(as.admin, converted);
    expect((await setLine(as.admin, converted, cl[0].id, [{ machine_id: lathe, hours: 2 }])).error).toBeNull();
    const jobId = (await as.admin.rpc("convert_sales_order", { p_order: converted })).data.job_id as string;
    expect((await adminClient().from("sales_orders").update({ total_value: 1810.5 }).eq("id", converted)).error).toBeNull();
    await setRequireAdminMfaForTest(world.tenants.alpha.id, true);
    try {
      // Setting machines needs the second step now ...
      const r = await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 5 }]);
      expect(r.error?.hint).toBe("mfa_required");
      // ... but the read path that rebuilds the lines (and clears the plan's line links by referential action) does not.
      const d = await as.admin.rpc("despatch_lines", { p_order: id, p_job: null });
      expect(d.error).toBeNull();
      expect((await plan(id)).map((r) => [r.line_key, r.sales_order_line_id])).toEqual([[0, null]]);
      // The same for a converted order: job_machines.source_so_line_id is cleared by referential action, and 042's guards don't fire on it.
      const d2 = await as.admin.rpc("despatch_lines", { p_order: converted, p_job: null });
      expect(d2.error).toBeNull();
      expect((await jobPlan(jobId)).map((r) => [r.machine_id, Number(r.estimated_hours), r.source_so_line_id])).toEqual([[lathe, 2, null]]);
    } finally {
      await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = $1", [world.tenants.alpha.id]));
    }
  });
});

describe("carrying the plan to the job", () => {
  it("sums the lines per machine on the job, keeps the source line, books each machine at its next free slot (061), and carries only once", async () => {
    const id = await order(true);
    const two = await lines(as.admin, id);
    expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 4 }, { machine_id: lathe, hours: 2 }])).error).toBeNull();
    expect((await setLine(as.admin, id, two[1].id, [{ machine_id: mill, hours: 1.5 }])).error).toBeNull();
    const { data, error } = await as.office.rpc("convert_sales_order", { p_order: id });
    expect(error).toBeNull();
    // The result is exactly what it was before 043; the carry is read from job_machines.
    expect(data).toEqual({ job_id: expect.any(String), job_no: expect.stringMatching(/^J-/), created: true });
    const carried = await jobPlan(data.job_id);
    expect(carried.map((r) => [r.machine_id, Number(r.estimated_hours), r.position, r.source_so_line_id])).toEqual([
      [mill, 5.5, 0, two[0].id], [lathe, 2, 1, two[0].id]]);
    // 061: each machine is on the schedule at its next free slot, linked to its plan row, for the carried hours.
    const { data: carriedBookings } = await adminClient().from("machine_bookings").select("id, machine_id, job_no, estimated_hours, status").eq("job_id", data.job_id);
    expect(carriedBookings!.map((b) => [b.machine_id, Number(b.estimated_hours), b.status, b.job_no]).sort()).toEqual([[lathe, 2, "booked", data.job_no], [mill, 5.5, "booked", data.job_no]].sort());
    expect(carried.map((r) => r.booking_id).sort()).toEqual(carriedBookings!.map((b) => b.id).sort());
    // The whole company reads the job's plan; the order's plan is unchanged and now closed to edits.
    expect((await as.viewer.from("job_machines").select("machine_id").eq("job_id", data.job_id)).data).toHaveLength(2);
    expect((await plan(id)).map((r) => Number(r.estimated_hours))).toEqual([4, 2, 1.5]);
    const closed = await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 9 }]);
    expect(closed.error?.code).toBe("42501");
    expect(closed.error?.hint).toBe("order_converted");
    // Converting again: the same job, nothing more carried; carrying by hand is refused (one carry per job), also after the workshop
    // has taken every machine off the job.
    expect((await as.office.rpc("convert_sales_order", { p_order: id })).data).toEqual({ job_id: data.job_id, job_no: data.job_no, created: false });
    expect((await as.office.rpc("carry_so_machines", { p_order: id, p_job: data.job_id })).error?.hint).toBe("job_has_plan");
    expect(await jobPlan(data.job_id)).toHaveLength(2);
    expect((await setJob(as.workshop, data.job_id, [])).error).toBeNull();
    expect((await as.office.rpc("carry_so_machines", { p_order: id, p_job: data.job_id })).error?.hint).toBe("job_has_plan");
    expect(await jobPlan(data.job_id)).toEqual([]);
    const audit = await withDb((db) => db.query("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'CARRY_MACHINES'", [data.job_id]));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.machines.map((m: { machine_id: string; hours: number; lines: unknown[]; booked: boolean }) => [m.machine_id, m.hours, m.lines.length, m.booked])).toEqual([[mill, 5.5, 2, true], [lathe, 2, 1, true]]);
    expect(audit.rows[0].metadata.machines_booked).toBe(2);
  });

  it("an order without a plan converts as before; carrying into a job the order wasn't converted to is refused", async () => {
    const id = await order(false);
    const { data, error } = await as.admin.rpc("convert_sales_order", { p_order: id });
    expect(error).toBeNull();
    expect(data).toEqual({ job_id: expect.any(String), job_no: expect.stringMatching(/^J-\d{4,}$/), created: true });
    expect(await jobPlan(data.job_id)).toEqual([]);
    const otherJob = (await as.admin.rpc("create_job", { p_customer: "Acme", p_description: "Other", p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null })).data.job_id;
    expect((await as.admin.rpc("carry_so_machines", { p_order: id, p_job: otherJob })).error?.code).toBe("42501");
    expect((await as.workshop.rpc("carry_so_machines", { p_order: id, p_job: data.job_id })).error?.code).toBe("42501");
    expect((await as.betaAdmin.rpc("carry_so_machines", { p_order: id, p_job: data.job_id })).error?.code).toBe("P0002");
    expect((await as.admin.rpc("carry_so_machines", { p_order: betaOrder, p_job: data.job_id })).error?.code).toBe("P0002");
  });
});

describe("editing the machines on the job", () => {
  /**
   * A converted job with the mill planned for 3 h and NOT booked: 061 books it at the next free slot on conversion, so that booking is
   * taken off the schedule here (delete_machine_booking leaves the plan row, unlinked), as a converted order left the job before 061.
   * The tests below are 043's rules for editing that plan (an existing plan row is never booked without a start).
   */
  async function convertedJob() {
    const id = await order(false);
    const [summary] = await lines(as.admin, id);
    expect((await setLine(as.admin, id, summary.id, [{ machine_id: mill, hours: 3 }])).error).toBeNull();
    const { data } = await as.admin.rpc("convert_sales_order", { p_order: id });
    const { data: auto } = await adminClient().from("machine_bookings").select("id").eq("job_id", data.job_id);
    expect(auto).toHaveLength(1);
    expect((await as.admin.rpc("delete_machine_booking", { p_id: auto![0].id })).error).toBeNull();
    expect((await jobPlan(data.job_id)).map((r) => [r.machine_id, Number(r.estimated_hours), r.booking_id])).toEqual([[mill, 3, null]]);
    return { orderId: id, jobId: data.job_id as string, jobNo: data.job_no as string };
  }

  it.each(["admin", "office", "workshop"])("%s changes hours, adds a machine with a booking, and removes one; the order's plan stays as ordered", async (role) => {
    const { orderId, jobId, jobNo } = await convertedJob();
    const { data, error } = await setJob(as[role], jobId, [{ machine_id: mill, hours: 4 }, { machine_id: lathe, hours: 2, start_at: START }]);
    expect(error).toBeNull();
    expect(data.machines.map((m: { machine_id: string; hours: number; booking_id: string | null }) => [m.machine_id, m.hours, Boolean(m.booking_id)])).toEqual([[mill, 4, false], [lathe, 2, true]]);
    const after = await jobPlan(jobId);
    expect(after.map((r) => [r.machine_id, Number(r.estimated_hours), r.position])).toEqual([[mill, 4, 0], [lathe, 2, 1]]);
    const { data: booking } = await adminClient().from("machine_bookings").select("machine_id, job_id, job_no, start_at, estimated_hours, status").eq("id", after[1].booking_id!).single();
    expect(booking).toMatchObject({ machine_id: lathe, job_id: jobId, job_no: jobNo, estimated_hours: 2, status: "booked" });
    expect(new Date(booking!.start_at).toISOString()).toBe("2026-11-02T08:00:00.000Z");
    // Booking the mill too, then moving the lathe's booking by giving a new start; then removing the lathe takes its booking away.
    expect((await setJob(as[role], jobId, [{ machine_id: mill, hours: 4, start_at: START }, { machine_id: lathe, hours: 2.5, start_at: "2026-11-03T08:00:00Z" }])).error).toBeNull();
    const moved = await adminClient().from("machine_bookings").select("id, machine_id, start_at, estimated_hours").eq("job_id", jobId).order("machine_id");
    expect(moved.data!.map((b) => [b.machine_id, new Date(b.start_at).toISOString(), Number(b.estimated_hours)]).sort()).toEqual([[lathe, "2026-11-03T08:00:00.000Z", 2.5], [mill, "2026-11-02T08:00:00.000Z", 4]].sort());
    expect((await setJob(as[role], jobId, [{ machine_id: mill, hours: 4 }])).error).toBeNull();
    expect((await jobPlan(jobId)).map((r) => [r.machine_id, Number(r.estimated_hours)])).toEqual([[mill, 4]]);
    expect((await adminClient().from("machine_bookings").select("machine_id").eq("job_id", jobId)).data).toEqual([{ machine_id: mill }]);
    // Removing every machine clears the plan; the order still shows what was ordered.
    expect((await setJob(as[role], jobId, [])).error).toBeNull();
    expect(await jobPlan(jobId)).toEqual([]);
    expect((await adminClient().from("machine_bookings").select("id").eq("job_id", jobId)).data).toEqual([]);
    expect((await plan(orderId)).map((r) => [r.machine_id, Number(r.estimated_hours)])).toEqual([[mill, 3]]);
    const audit = await withDb((db) => db.query("select count(*)::int as n from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'SET_JOB_MACHINES'", [jobId]));
    expect(audit.rows[0].n).toBe(4);
  });

  it("a running booking stays on the schedule when its machine leaves the job; a booked one takes new hours without moving", async () => {
    const { jobId } = await convertedJob();
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 3, start_at: START }])).error).toBeNull();
    const [{ booking_id }] = await jobPlan(jobId);
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 6 }])).error).toBeNull();
    expect((await adminClient().from("machine_bookings").select("start_at, estimated_hours").eq("id", booking_id!).single()).data).toMatchObject({ estimated_hours: 6 });
    expect((await adminClient().from("machine_bookings").update({ status: "running" }).eq("id", booking_id!)).error).toBeNull();
    expect((await setJob(as.admin, jobId, [])).error).toBeNull();
    expect((await adminClient().from("machine_bookings").select("id, status").eq("id", booking_id!).single()).data).toEqual({ id: booking_id, status: "running" });
  });

  it("viewer, anon and another company are refused; a bad machine rolls the whole edit back", async () => {
    const { jobId } = await convertedJob();
    expect((await setJob(as.viewer, jobId, [{ machine_id: mill, hours: 1 }])).error?.code).toBe("42501");
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    expect((await setJob(anon, jobId, [])).error).not.toBeNull();
    expect((await setJob(as.betaAdmin, jobId, [{ machine_id: betaMachine, hours: 1 }])).error?.code).toBe("P0002");
    expect((await setJob(as.admin, betaJob, [{ machine_id: mill, hours: 1 }])).error?.code).toBe("P0002");
    expect((await setJob(as.admin, jobId, [{ machine_id: lathe, hours: 2, start_at: START }, { machine_id: betaMachine, hours: 1 }])).error?.code).toBe("P0002");
    expect((await setJob(as.admin, jobId, [{ machine_id: lathe, hours: 2 }, { machine_id: retired, hours: 1 }])).error?.code).toBe("P0002");
    expect((await setJob(as.admin, jobId, [{ machine_id: lathe, hours: 2 }, { machine_id: lathe, hours: 1 }])).error?.code).toBe("22023");
    expect((await setJob(as.admin, jobId, [{ machine_id: lathe, hours: 2, start_at: "not a date" }])).error?.code).toBe("22023");
    expect((await setJob(as.admin, jobId, [{ machine_id: lathe, hours: -1 }])).error?.code).toBe("22023");
    expect((await jobPlan(jobId)).map((r) => [r.machine_id, Number(r.estimated_hours)])).toEqual([[mill, 3]]);
    expect((await adminClient().from("machine_bookings").select("id").eq("job_id", jobId)).data).toEqual([]);
    expect((await adminClient().from("job_machines").select("id").eq("job_id", betaJob)).data).toEqual([]);
  });

  it("a clash is found by the function itself; refused for office and workshop, an admin may book anyway, which is audited", async () => {
    const { jobId } = await convertedJob();
    // Another job's booking on the mill over the time; this job's own bookings never count against it.
    const clashNo = `J-SOMCL-${world.runId}`;
    const AT = "2026-12-01T08:00:00Z"; // a day no other test books
    expect((await adminClient().from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: mill, job_no: clashNo, description: "Clash", start_at: "2026-12-01T09:00:00Z", estimated_hours: 4 })).error).toBeNull();
    for (const role of ["office", "workshop"]) {
      const r = await setJob(as[role], jobId, [{ machine_id: mill, hours: 3, start_at: AT }], { p_clashes: [], p_clash_override: true });
      expect(r.error?.code).toBe("42501");
      expect(r.error?.hint).toBe("machine_clash");
      expect(r.error?.message).toContain(clashNo);
    }
    // The app's own list of clashes is a hint: without a real overlap nothing is refused.
    expect((await setJob(as.office, jobId, [{ machine_id: mill, hours: 3, start_at: "2026-12-03T08:00:00Z" }], { p_clashes: [{ machine_id: mill, job_no: "J-0001" }] })).error).toBeNull();
    // A free time, then moving onto the clash: this job's own booking on the mill is not a clash with itself.
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 3, start_at: AT }], { p_clashes: [] })).error?.hint).toBe("machine_clash");
    // An admin needs a reason (3 to 500 characters) to book anyway.
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 3, start_at: AT }], { p_clash_override: true })).error?.hint).toBe("override_reason");
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 3, start_at: AT }], { p_clash_override: true, p_override_reason: "no" })).error?.hint).toBe("override_reason");
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 3, start_at: AT }], { p_clash_override: true, p_override_reason: "x".repeat(501) })).error?.hint).toBe("override_reason");
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 3, start_at: AT }], { p_clashes: [], p_clash_override: true, p_override_reason: "Customer priority: runs first" })).error).toBeNull();
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 3, start_at: "2026-12-01T08:30:00Z" }], { p_clashes: [] })).error?.hint).toBe("machine_clash");
    // Resizing a booked booking is checked too: 1 h at 08:00 is free of the 09:00 booking, 2 h is not.
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 1, start_at: "2026-12-01T08:00:00Z" }], { p_clash_override: true, p_override_reason: "Customer priority: runs first" })).error).toBeNull();
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 2 }])).error?.hint).toBe("machine_clash");
    expect((await setJob(as.admin, jobId, [{ machine_id: mill, hours: 1 }])).error).toBeNull();
    // A start out of range, and an over-long clash hint, are refused.
    expect((await setJob(as.admin, jobId, [{ machine_id: lathe, hours: 1, start_at: "1999-12-31T08:00:00Z" }])).error?.code).toBe("22023");
    expect((await setJob(as.admin, jobId, [{ machine_id: lathe, hours: 1 }], { p_clashes: [{ machine_id: mill, job_no: "x".repeat(20001) }] })).error?.code).toBe("22023");
    expect((await setJob(as.admin, jobId, [{ machine_id: lathe, hours: 1 }], { p_clashes: Array.from({ length: 201 }, () => ({ machine_id: mill, job_no: "J-1" })) })).error?.code).toBe("22023");
    // Exactly one OVERRIDE_MACHINE_CLASH per overridden booking, on the booking (the 1 h move at 08:00 was free, so no second one); none on
    // the job, whose SET_JOB_MACHINES event carries the override instead.
    const [{ booking_id }] = await jobPlan(jobId);
    const onBooking = await withDb((db) => db.query("select entity_id, metadata from security_audit.audit_log where entity_table = 'machine_bookings' and entity_id = $1 and action = 'OVERRIDE_MACHINE_CLASH'", [booking_id]));
    expect(onBooking.rows).toHaveLength(1);
    expect(onBooking.rows[0].metadata).toMatchObject({ reason: "Customer priority: runs first", clashing_job_nos: [clashNo], actor_user_id: world.tenants.alpha.users.admin.id });
    const onJob = await withDb((db) => db.query("select count(*)::int as n from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'OVERRIDE_MACHINE_CLASH'", [jobId]));
    expect(onJob.rows[0].n).toBe(0);
    const edits = await withDb((db) => db.query("select metadata -> 'override' as o from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'SET_JOB_MACHINES' and metadata -> 'override' <> 'null'::jsonb order by created_at", [jobId]));
    expect(edits.rows).toHaveLength(1);
    expect(edits.rows[0].o).toMatchObject({ reason: "Customer priority: runs first", clashing_job_nos: [clashNo], booking_ids: [booking_id], actor_user_id: world.tenants.alpha.users.admin.id });
    expect(edits.rows[0].o.conflicts.map((c: { job_no: string; intervals: unknown[] }) => [c.job_no, c.intervals.length > 0])).toEqual([[clashNo, true]]);
    expect(edits.rows[0].o.at).toBeTruthy();
  });

  it("a booking partly done is checked with its real hours done, exactly as the schedule checks it (no spurious refusal)", async () => {
    const { jobId } = await convertedJob();
    expect((await setJob(as.office, jobId, [{ machine_id: lathe, hours: 3, start_at: "2026-12-16T08:00:00Z" }])).error).toBeNull();
    const [{ booking_id }] = await jobPlan(jobId);
    const { data: b } = await adminClient().from("machine_bookings").select("description, notes").eq("id", booking_id!).single();
    // Two of its three hours are done (recorded through the schedule); another job sits right after it.
    expect((await as.office.rpc("save_machine_booking", { p_id: booking_id, p_machine: lathe, p_job: jobId, p_job_no: "x", p_description: b!.description, p_start: "2026-12-16T08:00:00Z", p_hours: 3, p_hours_done: 2, p_status: "booked", p_notes: b!.notes, p_day_plan: null, p_clear_day_plan: false, p_clash_override: false, p_override_reason: null })).error).toBeNull();
    expect((await adminClient().from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: lathe, job_no: `J-SOMPD-${world.runId}`, description: "Next", start_at: "2026-12-16T11:00:00Z", estimated_hours: 2 })).error).toBeNull();
    // Resized to 4 h here: the same answer the schedule's own function gives for the same change.
    const here = await setJob(as.office, jobId, [{ machine_id: lathe, hours: 4 }]);
    const { data: now } = await adminClient().from("machine_bookings").select("estimated_hours, hours_done").eq("id", booking_id!).single();
    const there = await as.office.rpc("save_machine_booking", { p_id: booking_id, p_machine: lathe, p_job: jobId, p_job_no: "x", p_description: b!.description, p_start: "2026-12-16T08:00:00Z", p_hours: 4, p_hours_done: 2, p_status: "booked", p_notes: b!.notes, p_day_plan: null, p_clear_day_plan: false, p_clash_override: false, p_override_reason: null });
    expect(here.error?.hint ?? null).toBe(there.error?.hint ?? null);
    if (!here.error) expect(now).toMatchObject({ estimated_hours: 4, hours_done: 2 });
    // And a resize that cannot clash passes with the hours done kept.
    expect((await setJob(as.office, jobId, [{ machine_id: lathe, hours: 2.5 }])).error).toBeNull();
    expect((await adminClient().from("machine_bookings").select("estimated_hours, hours_done").eq("id", booking_id!).single()).data).toMatchObject({ estimated_hours: 2.5, hours_done: 2 });
  });

  it("a booking from before 042 with long text is still edited here: its text is cut to the schedule function's limits", async () => {
    const { jobId, jobNo } = await convertedJob();
    const service = adminClient();
    const { data: legacy } = await service.from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: lathe, job_id: jobId, job_no: jobNo, description: "D".repeat(600), notes: "N".repeat(2500), start_at: "2026-12-17T08:00:00Z", estimated_hours: 2, status: "booked" }).select("id").single();
    expect((await service.from("job_machines").insert({ organization_id: world.tenants.alpha.id, job_id: jobId, machine_id: lathe, estimated_hours: 2, booking_id: legacy!.id, position: 1 })).error).toBeNull();
    expect((await setJob(as.office, jobId, [{ machine_id: mill, hours: 3 }, { machine_id: lathe, hours: 2.5 }])).error).toBeNull();
    const { data: after } = await service.from("machine_bookings").select("estimated_hours, description, notes").eq("id", legacy!.id).single();
    expect(after).toMatchObject({ estimated_hours: 2.5 });
    expect(after!.description).toHaveLength(500);
    expect(after!.notes).toHaveLength(2000);
    expect((await jobPlan(jobId)).map((r) => [r.machine_id, Number(r.estimated_hours), r.booking_id])).toEqual([[mill, 3, null], [lathe, 2.5, legacy!.id]]);
  });

  it("clashes follow the schedule's own rule: a booking that runs past the working day is busy on the next working day, not overnight", async () => {
    // The lathe works Mon to Fri, 8 h a day. Another job: 6 h from Friday 4 Dec 2026 12:00 London (ends Mon 7 Dec 10:00, not Friday 18:00).
    const other = `J-SOMWD-${world.runId}`;
    expect((await adminClient().from("machine_bookings").insert({ organization_id: world.tenants.alpha.id, machine_id: lathe, job_no: other, description: "Spills over", start_at: "2026-12-04T12:00:00Z", estimated_hours: 6 })).error).toBeNull();
    const { jobId } = await convertedJob();
    // Monday 7 Dec 08:00 for 1 h overlaps that spill-over; a plain-hours span would have called Monday free.
    const monday = await setJob(as.office, jobId, [{ machine_id: lathe, hours: 1, start_at: "2026-12-07T08:00:00Z" }]);
    expect(monday.error?.hint).toBe("machine_clash");
    expect(monday.error?.message).toContain(other);
    // Friday evening is not machine time: 1 h at 17:00 Friday is normalised to the next working slot by the same rule and so also clashes,
    // while Monday 10:00 is free.
    expect((await setJob(as.office, jobId, [{ machine_id: lathe, hours: 1, start_at: "2026-12-07T10:00:00Z" }])).error).toBeNull();
  });
});

describe("the plan row follows the schedule", () => {
  it("a booking made here and then edited or removed through the schedule's own functions keeps the plan row current", async () => {
    const id = await order(false);
    const { data: made } = await as.admin.rpc("convert_sales_order", { p_order: id });
    const jobId = made.job_id as string;
    expect((await setJob(as.office, jobId, [{ machine_id: mill, hours: 3, start_at: "2026-12-14T08:00:00Z" }])).error).toBeNull();
    const [{ booking_id }] = await jobPlan(jobId);
    const { data: booking } = await adminClient().from("machine_bookings").select("*").eq("id", booking_id!).single();
    expect(booking).toMatchObject({ job_id: jobId, estimated_hours: 3, status: "booked" });
    // Edited on the schedule (moved a day, 5 h): the plan row takes the hours and stays linked.
    const saved = await as.office.rpc("save_machine_booking", { p_id: booking_id, p_machine: mill, p_job: jobId, p_job_no: made.job_no, p_description: booking!.description, p_start: "2026-12-15T08:00:00Z", p_hours: 5, p_hours_done: 0, p_status: "booked", p_notes: null, p_day_plan: null, p_clear_day_plan: false, p_clash_override: false, p_override_reason: null });
    expect(saved.error).toBeNull();
    expect((await jobPlan(jobId)).map((r) => [r.machine_id, Number(r.estimated_hours), r.booking_id])).toEqual([[mill, 5, booking_id]]);
    // An edit here afterwards sees the moved booking and resizes it in place (one booking, one row, same hours on both).
    expect((await setJob(as.office, jobId, [{ machine_id: mill, hours: 4 }])).error).toBeNull();
    expect((await jobPlan(jobId)).map((r) => [Number(r.estimated_hours), r.booking_id])).toEqual([[4, booking_id]]);
    expect((await adminClient().from("machine_bookings").select("estimated_hours, start_at").eq("id", booking_id!).single()).data).toMatchObject({ estimated_hours: 4 });
    expect(new Date((await adminClient().from("machine_bookings").select("start_at").eq("id", booking_id!).single()).data!.start_at).toISOString()).toBe("2026-12-15T08:00:00.000Z");
    // Removed on the schedule: the row stays, unlinked, with its hours; an edit here then books nothing until a start is given.
    expect((await as.office.rpc("delete_machine_booking", { p_id: booking_id })).error).toBeNull();
    expect((await jobPlan(jobId)).map((r) => [Number(r.estimated_hours), r.booking_id])).toEqual([[4, null]]);
    expect((await setJob(as.office, jobId, [{ machine_id: mill, hours: 4.5 }])).error).toBeNull();
    expect((await jobPlan(jobId)).map((r) => [Number(r.estimated_hours), r.booking_id])).toEqual([[4.5, null]]);
    expect((await adminClient().from("machine_bookings").select("id").eq("job_id", jobId)).data).toEqual([]);
  });
});

describe("two edits at the same moment", () => {
  it("asking for the same machine and time on two jobs: exactly one is booked, the other is refused as a clash", async () => {
    const a = await convertedJob();
    const b = await convertedJob();
    const AT = "2026-12-10T08:00:00Z";
    const [ra, rb] = await Promise.all([
      setJob(as.admin, a.jobId, [{ machine_id: lathe, hours: 3, start_at: AT }]),
      setJob(as.office, b.jobId, [{ machine_id: lathe, hours: 3, start_at: AT }]),
    ]);
    const errors = [ra.error, rb.error].filter(Boolean);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.hint).toBe("machine_clash");
    const { data: bookings } = await adminClient().from("machine_bookings").select("job_id").eq("machine_id", lathe).eq("start_at", AT);
    expect(bookings).toHaveLength(1);
    expect([a.jobId, b.jobId]).toContain(bookings![0].job_id);
  });

  async function convertedJob() {
    const id = await order(false);
    const { data } = await as.admin.rpc("convert_sales_order", { p_order: id });
    return { orderId: id, jobId: data.job_id as string };
  }
});

describe("no money for the workshop or the viewer, anywhere M1/M2 reaches", () => {
  // Any key that carries a price, a value, a cost or a total (hours and quantities are fine).
  const MONEY = /(^|_)(price|prices|value|values|cost|costs|amount|total|totals|vat|net|gross|margin|rate)(_|$)/i;
  /** Every key in a result, at any depth (a jsonb answer nests its machines and lines). */
  const keysOf = (x: unknown): string[] => (Array.isArray(x) ? x.flatMap(keysOf) : x && typeof x === "object" ? Object.entries(x).flatMap(([k, v]) => [k, ...keysOf(v)]) : []);
  const noMoney = (what: string, x: unknown) => expect(keysOf(x).filter((k) => MONEY.test(k)), what).toEqual([]);

  it("jobs, job_machines, the order's plan, the schedule and every M1/M2 function answer carry no money key; the price tables answer nothing", async () => {
    const id = await order(true);
    const two = await lines(as.admin, id);
    expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 2 }])).error).toBeNull();
    const { data: converted } = await as.admin.rpc("convert_sales_order", { p_order: id });
    const jobId = converted.job_id as string;
    // The admin does see the money (so an empty answer below is the rule, not missing data).
    expect((await as.admin.from("job_values").select("value").eq("job_id", jobId)).data).toHaveLength(1);
    expect((await as.admin.from("sales_order_lines").select("unit_price").eq("sales_order_id", id)).data).toHaveLength(2);
    for (const role of ["workshop", "viewer"]) {
      const c = as[role];
      const job = await c.from("jobs").select("*").eq("id", jobId);
      expect(job.data, `${role} reads the job`).toHaveLength(1);
      noMoney(`${role}: jobs`, job.data);
      const jm = await c.from("job_machines").select("*").eq("job_id", jobId);
      expect(jm.data).toHaveLength(1);
      noMoney(`${role}: job_machines`, jm.data);
      const slm = await c.from("sales_order_line_machines").select("*").eq("sales_order_id", id);
      expect(slm.data).toHaveLength(1);
      noMoney(`${role}: sales_order_line_machines`, slm.data);
      noMoney(`${role}: machine_bookings`, (await c.from("machine_bookings").select("*").eq("job_id", jobId)).data);
      noMoney(`${role}: machines`, (await c.from("machines").select("*").eq("id", mill)).data);
      // The tables that hold prices: nothing for these roles (refused or no rows).
      for (const [table, column, value] of [["job_values", "job_id", jobId], ["sales_order_lines", "sales_order_id", id], ["quote_line_items", "quote_id", (await adminClient().from("sales_orders").select("quote_id").eq("id", id).single()).data!.quote_id], ["quotes", "id", (await adminClient().from("sales_orders").select("quote_id").eq("id", id).single()).data!.quote_id]] as const) {
        const r = await c.from(table).select("*").eq(column, value);
        expect(r.data ?? [], `${role}: ${table}`).toEqual([]);
      }
      const so = await c.from("sales_orders").select("*").eq("id", id);
      if ((so.data ?? []).length > 0) noMoney(`${role}: sales_orders`, so.data);
      // Activity on the job, as the activity view shows it.
      noMoney(`${role}: audit_log_view`, ((await c.from("audit_log_view").select("*").eq("entity_id", jobId)).data ?? []).map((r: { action: string; old_data?: unknown; new_data?: unknown; metadata?: unknown }) => ({ old_data: r.old_data, new_data: r.new_data, metadata: r.metadata })));
      // M1/M2 functions these roles may call: an answer carries no money; a refusal is fine.
      const answers: [string, { data: unknown; error: unknown }][] = [
        ["despatch_lines", await c.rpc("despatch_lines", { p_order: null, p_job: jobId })],
        ["set_job_machines", await setJob(c, jobId, [{ machine_id: mill, hours: 2 }])],
        ["create_job", await c.rpc("create_job", { p_customer: "Acme", p_description: "Money check", p_internal: false, p_related: null, p_required: null, p_machines: [{ machine_id: lathe, hours: 1 }], p_clash_override: false, p_clashes: [], p_override_reason: null })],
        ["convert_sales_order", await c.rpc("convert_sales_order", { p_order: id })],
        ["carry_so_machines", await c.rpc("carry_so_machines", { p_order: id, p_job: jobId })],
        ["set_sales_order_line_machines", await setLine(c, id, two[0].id, [{ machine_id: mill, hours: 2 }])],
      ];
      for (const [name, r] of answers) noMoney(`${role}: ${name}`, r.error ? null : r.data);
      if (role === "viewer") for (const [name, r] of answers) expect(r.error, `viewer: ${name} is refused`).not.toBeNull();
      // PostgREST relationship joins from what they can read to what holds prices: the embedded order line and order come back empty.
      const joined = await c.from("job_machines").select("*, sales_order_lines(*)").eq("job_id", jobId);
      expect(joined.error).toBeNull();
      expect(joined.data!.map((r: { sales_order_lines: unknown }) => r.sales_order_lines), `${role}: job_machines -> sales_order_lines`).toEqual([null]);
      const planJoined = await c.from("sales_order_line_machines").select("*, sales_order_lines(*), sales_orders(*)").eq("sales_order_id", id);
      expect(planJoined.error).toBeNull();
      expect(planJoined.data!.map((r: { sales_order_lines: unknown; sales_orders: unknown }) => [r.sales_order_lines, r.sales_orders]), `${role}: plan -> line, order`).toEqual([[null, null]]);
      noMoney(`${role}: joins`, [joined.data, planJoined.data]);
      // The order's own history (SET_SO_LINE_MACHINES) as far as they can read it.
      noMoney(`${role}: audit_log_view on the order`, ((await c.from("audit_log_view").select("*").eq("entity_id", id)).data ?? []).map((r: { old_data?: unknown; new_data?: unknown; metadata?: unknown }) => ({ old_data: r.old_data, new_data: r.new_data, metadata: r.metadata })));
    }
    // The CARRY_MACHINES and SET_SO_LINE_MACHINES payloads themselves carry hours and machines only (whoever reads them).
    const payloads = await withDb((db) => db.query("select action, metadata from security_audit.audit_log where entity_id in ($1, $2) and action in ('CARRY_MACHINES', 'SET_SO_LINE_MACHINES', 'SET_JOB_MACHINES')", [jobId, id]));
    expect(payloads.rows.map((r) => r.action).sort()).toEqual(expect.arrayContaining(["CARRY_MACHINES", "SET_SO_LINE_MACHINES"]));
    noMoney("audit payloads", payloads.rows.map((r) => r.metadata));
    // Another company's admin reads none of it.
    expect((await as.betaAdmin.from("job_machines").select("id").eq("job_id", jobId)).data).toEqual([]);
    expect((await as.betaAdmin.from("sales_order_line_machines").select("id").eq("sales_order_id", id)).data).toEqual([]);
    expect((await as.betaAdmin.from("audit_log_view").select("id").in("entity_id", [jobId, id])).data ?? []).toEqual([]);
    expect((await as.betaAdmin.from("job_values").select("value").eq("job_id", jobId)).data ?? []).toEqual([]);
  });

  it("with the sales-orders section hidden, the workshop and the viewer read no plan row, through a join neither; the job's own plan stays readable", async () => {
    const id = await order(true);
    const two = await lines(as.admin, id);
    expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 2 }])).error).toBeNull();
    const jobId = (await as.admin.rpc("convert_sales_order", { p_order: id })).data.job_id as string;
    for (const role of ["workshop", "viewer"] as const) {
      const c = as[role];
      expect((await c.from("sales_order_line_machines").select("id").eq("sales_order_id", id)).data, `${role} sees the plan while the section is visible`).toHaveLength(1);
      expect((await as.admin.rpc("set_member_access", { p_user: world.tenants.alpha.users[role].id, p_hidden_sections: ["sales-orders"] })).error).toBeNull();
      try {
        expect((await c.from("sales_order_line_machines").select("*").eq("sales_order_id", id)).data, `${role}: plan gated`).toEqual([]);
        const joined = await c.from("job_machines").select("machine_id, estimated_hours, sales_order_lines(*)").eq("job_id", jobId);
        expect(joined.data, `${role}: job plan readable, line embed empty`).toEqual([{ machine_id: mill, estimated_hours: 2, sales_order_lines: null }]);
        expect((await c.from("sales_order_lines").select("*").eq("sales_order_id", id)).data ?? []).toEqual([]);
        expect((await c.from("sales_orders").select("*").eq("id", id)).data ?? []).toEqual([]);
      } finally {
        expect((await as.admin.rpc("set_member_access", { p_user: world.tenants.alpha.users[role].id, p_hidden_sections: [] })).error).toBeNull();
      }
    }
  });
});

describe("the order-line link the statement guards leave out can't be written by a caller", () => {
  // 043 re-makes the second-step and read-only-support statement guards on these three tables with a column list that leaves out the
  // order-line link, so the referential ON DELETE SET NULL inside the read path despatch_lines is not refused. The link must therefore
  // be unwritable by any API caller: no table or column UPDATE grant, and every definer function that writes it guarded itself.
  const LINKS = [["sales_order_line_machines", "sales_order_line_id"], ["job_machines", "source_so_line_id"], ["job_rework", "sales_order_line_id"]] as const;

  /** A converted order with a plan, a rework row on its first line, and the three links set. */
  async function linked() {
    const id = await order(true);
    const two = await lines(as.admin, id);
    expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 2 }])).error).toBeNull();
    const jobId = (await as.admin.rpc("convert_sales_order", { p_order: id })).data.job_id as string;
    const rework = await adminClient().from("job_rework").insert({ organization_id: world.tenants.alpha.id, job_id: jobId, reason: "Link check", instructions: "None", affects_all: false, sales_order_line_id: two[0].id }).select("id").single();
    expect(rework.error).toBeNull();
    return { id, jobId, line: two[0].id, reworkId: rework.data!.id as string };
  }
  const links = async (x: { id: string; jobId: string; reworkId: string }) => [
    (await adminClient().from("sales_order_line_machines").select("sales_order_line_id").eq("sales_order_id", x.id)).data!.map((r) => r.sales_order_line_id),
    (await adminClient().from("job_machines").select("source_so_line_id").eq("job_id", x.jobId)).data!.map((r) => r.source_so_line_id),
    (await adminClient().from("job_rework").select("sales_order_line_id").eq("id", x.reworkId)).data!.map((r) => r.sales_order_line_id),
  ];
  /** A direct update of ONLY the link column, as the API offers it: refused (42501, no grant), nothing changed. */
  async function directUpdatesRefused(c: SupabaseClient, x: { id: string; jobId: string; line: string; reworkId: string }, who: string) {
    const before = await links(x);
    for (const [table, column] of LINKS) {
      const key = table === "sales_order_line_machines" ? ["sales_order_id", x.id] : table === "job_machines" ? ["job_id", x.jobId] : ["id", x.reworkId];
      const r = await c.from(table).update({ [column]: null }).eq(key[0], key[1]).select("id");
      expect(r.error?.code, `${who}: ${table}.${column} = null`).toBe("42501");
    }
    expect(await links(x)).toEqual(before);
    expect(before.flat().every((v) => v === x.line)).toBe(true);
  }

  it("no API role holds UPDATE on any of the three tables or on the link column", async () => {
    const rows = await withDb((db) => db.query<{ t: string; r: string; tab: boolean; col: boolean }>(
      `select t, r, has_table_privilege(r, 'public.' || t, 'UPDATE') as tab, has_column_privilege(r, 'public.' || t, c, 'UPDATE') as col
         from (values ('sales_order_line_machines', 'sales_order_line_id'), ('job_machines', 'source_so_line_id'), ('job_rework', 'sales_order_line_id')) v(t, c)
         cross join (values ('anon'), ('authenticated')) a(r)`));
    expect(rows.rows.filter((x) => x.tab || x.col)).toEqual([]);
  });

  it("an admin at aal1 in a company that requires the second step: direct link updates refused on all three tables, the guarded functions refused, despatch_lines still rebuilds", async () => {
    const x = await linked();
    const open = await order(true);
    const openLines = await lines(as.admin, open);
    expect((await setLine(as.admin, open, openLines[0].id, [{ machine_id: lathe, hours: 1 }])).error).toBeNull();
    await setRequireAdminMfaForTest(world.tenants.alpha.id, true);
    try {
      await directUpdatesRefused(as.admin, x, "admin aal1");
      expect((await setLine(as.admin, open, openLines[0].id, [{ machine_id: lathe, hours: 2 }])).error?.hint).toBe("mfa_required");
      expect((await as.admin.rpc("carry_so_machines", { p_order: x.id, p_job: x.jobId })).error?.hint).toBe("mfa_required");
      // The legitimate path: the order's value changes, the read path rebuilds the lines, the links are cleared by the referential action.
      expect((await adminClient().from("sales_orders").update({ total_value: 1810.5 }).eq("id", x.id)).error).toBeNull();
      expect((await as.admin.rpc("despatch_lines", { p_order: x.id, p_job: null })).error).toBeNull();
      expect(await links(x)).toEqual([[null], [null], [null]]);
    } finally {
      await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = $1", [world.tenants.alpha.id]));
    }
  });

  it("a read-only support session: direct link updates refused on all three tables, the guarded functions refused, despatch_lines still rebuilds", async () => {
    const x = await linked();
    const open = await order(true);
    const openLines = await lines(as.admin, open);
    const email = `som-owner.${world.runId}@example.test`;
    const password = generatePassword(16);
    const made = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Owner Person" } });
    expect(made.error).toBeNull();
    expect((await adminClient().rpc("add_member", { p_org: world.tenants.beta.id, p_email: email, p_role: "viewer" })).data).toBe("member");
    await withDb((db) => db.query("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner')", [made.data.user!.id]));
    const factor = await enrolTotp(await signedInClient({ email, password }));
    const support = await signedInClient({ email, password });
    await passSecondStep(support, factor.factorId, factor.secret);
    await support.auth.refreshSession();
    expect((await support.rpc("platform_enter_organization", { p_org: world.tenants.alpha.id, p_reason: "Looking at an order's machines" })).error).toBeNull();
    expect((await support.from("job_machines").select("id").eq("job_id", x.jobId)).data).toHaveLength(1);
    await directUpdatesRefused(support, x, "support");
    expect((await setLine(support, open, openLines[0].id, [{ machine_id: lathe, hours: 2 }])).error).not.toBeNull();
    expect(await plan(open)).toEqual([]);
    expect((await support.rpc("carry_so_machines", { p_order: x.id, p_job: x.jobId })).error).not.toBeNull();
    expect((await setJob(support, x.jobId, [])).error).not.toBeNull();
    expect(await jobPlan(x.jobId)).toHaveLength(1);
    // Support reads Despatch on an order whose lines are current. A rebuild (the value changed) is a write of sales_order_lines, which
    // 036 already refuses for a read-only session as a whole: nothing is rebuilt, the links stand. The company's own admin then opens it
    // and the rebuild clears the links by the referential action.
    expect((await support.rpc("despatch_lines", { p_order: x.id, p_job: null })).error).toBeNull();
    expect((await adminClient().from("sales_orders").update({ total_value: 1810.5 }).eq("id", x.id)).error).toBeNull();
    expect((await support.rpc("despatch_lines", { p_order: x.id, p_job: null })).error?.hint).toBe("support_read_only");
    expect(await links(x)).toEqual([[x.line], [x.line], [x.line]]);
    expect((await as.admin.rpc("despatch_lines", { p_order: x.id, p_job: null })).error).toBeNull();
    expect(await links(x)).toEqual([[null], [null], [null]]);
    await withDb((db) => db.query("delete from security_audit.platform_admins where user_id = $1", [made.data.user!.id]));
  });
});

describe("conversion: idempotent, atomic, consistent", () => {
  const carryEvents = (jobId: string) => withDb((db) => db.query("select id from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'CARRY_MACHINES'", [jobId])).then((r) => r.rows.length);

  it("two conversions at the same moment from two connections: the same job, one carried plan, one CARRY_MACHINES event", async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = await order(true);
      const two = await lines(as.admin, id);
      expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 3 }])).error).toBeNull();
      expect((await setLine(as.admin, id, two[1].id, [{ machine_id: mill, hours: 1 }, { machine_id: lathe, hours: 2 }])).error).toBeNull();
      const [a, b] = await Promise.all([as.admin.rpc("convert_sales_order", { p_order: id }), as.office.rpc("convert_sales_order", { p_order: id })]);
      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      expect(a.data.job_id).toBe(b.data.job_id);
      expect([a.data.created, b.data.created].sort()).toEqual([false, true]);
      expect((await adminClient().from("jobs").select("id").eq("converted_from_sales_order_id", id)).data).toHaveLength(1);
      expect((await jobPlan(a.data.job_id)).map((r) => [r.machine_id, Number(r.estimated_hours)])).toEqual([[mill, 4], [lathe, 2]]);
      expect(await carryEvents(a.data.job_id)).toBe(1);
    }
  });

  it("a conversion racing an edit of the order's plan: the job gets the old plan or the new one entirely, never a mix", async () => {
    for (let round = 0; round < 4; round += 1) {
      const id = await order(true);
      const two = await lines(as.admin, id);
      expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 3 }])).error).toBeNull();
      const [edit, converted] = await Promise.all([
        setLine(as.office, id, two[0].id, [{ machine_id: lathe, hours: 5 }, { machine_id: mill, hours: 1 }]),
        as.admin.rpc("convert_sales_order", { p_order: id }),
      ]);
      expect(converted.error).toBeNull();
      const got = (await jobPlan(converted.data.job_id)).map((r) => [r.machine_id, Number(r.estimated_hours)]);
      if (edit.error) {
        expect(edit.error.hint).toBe("order_converted");
        expect(got).toEqual([[mill, 3]]);
      } else {
        expect(got).toEqual([[lathe, 5], [mill, 1]]);
      }
      expect(await carryEvents(converted.data.job_id)).toBe(1);
    }
  });

  it("a failure while carrying leaves no job and the order not converted; the retry converts with one plan and no duplicate rows", async () => {
    const id = await order(true);
    const two = await lines(as.admin, id);
    expect((await setLine(as.admin, id, two[0].id, [{ machine_id: mill, hours: 7.77 }])).error).toBeNull();
    expect((await setLine(as.admin, id, two[1].id, [{ machine_id: lathe, hours: 1 }])).error).toBeNull();
    const { data: session } = await as.admin.auth.getSession();
    const claims = JSON.parse(Buffer.from(session.session!.access_token.split(".")[1], "base64url").toString("utf8"));
    // One transaction, rolled back at the end, so the test-only trigger is never visible to anything else: the carry's insert into
    // job_machines fails for this order's machine (after the order was marked converted and the job made, in the same function call).
    await withDb(async (db: Client) => {
      await db.query("begin");
      try {
        await db.query(`create function public.zz_test_fail_carry() returns trigger language plpgsql as $f$ begin
          if new.estimated_hours = 7.77 then raise exception 'injected carry failure'; end if; return new; end $f$`);
        await db.query("create trigger zz_test_fail_carry before insert on public.job_machines for each row execute function public.zz_test_fail_carry()");
        await db.query("savepoint before_convert");
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
        await expect(db.query("select public.convert_sales_order($1) as r", [id])).rejects.toThrow("injected carry failure");
        await db.query("rollback to savepoint before_convert");
        await db.query("reset role");
        const state = (await db.query("select status, converted_to_job_id from public.sales_orders where id = $1", [id])).rows[0];
        expect(state.converted_to_job_id).toBeNull();
        expect(state.status).not.toBe("converted");
        expect((await db.query("select count(*)::int as n from public.jobs where converted_from_sales_order_id = $1", [id])).rows[0].n).toBe(0);
        expect((await db.query("select count(*)::int as n from public.job_values v join public.jobs j on j.id = v.job_id where j.converted_from_sales_order_id = $1", [id])).rows[0].n).toBe(0);
      } finally {
        await db.query("rollback");
      }
    });
    expect(await withDb((db) => db.query("select to_regproc('public.zz_test_fail_carry') is null as gone")).then((r) => r.rows[0].gone)).toBe(true);
    const retry = await as.admin.rpc("convert_sales_order", { p_order: id });
    expect(retry.error).toBeNull();
    expect(retry.data.created).toBe(true);
    expect((await jobPlan(retry.data.job_id)).map((r) => [r.machine_id, Number(r.estimated_hours)])).toEqual([[mill, 7.77], [lathe, 1]]);
    expect((await as.admin.rpc("convert_sales_order", { p_order: id })).data).toMatchObject({ job_id: retry.data.job_id, created: false });
    expect(await jobPlan(retry.data.job_id)).toHaveLength(2);
    expect(await carryEvents(retry.data.job_id)).toBe(1);
  });
});

describe("verify script", () => {
  it("is clean on the test stack", async () => {
    const text = readFileSync(path.join(__dirname, "../../supabase/verify/sales_order_machines.sql"), "utf8");
    const rows = await withDb((db) => db.query<{ n: number; check_name: string; value: string; expected: string }>(text));
    const facts = rows.rows.filter((r) => r.expected === "true");
    expect(facts.length).toBeGreaterThanOrEqual(7);
    expect(facts.filter((r) => r.value !== "true")).toEqual([]);
  });
});
