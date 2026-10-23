/**
 * Go-live polish item 22: a real workshop ACCOUNT (a member whose role in the company is workshop, signed in through Supabase Auth
 * and PostgREST with the anon key, like the browser) gets no prices from the database, whatever the app's screens show. The tenancy
 * matrix (tests/db/tenancy.test.ts "reads follow the role matrix") already pins that quotes and invoices rows are not readable by
 * workshop, and machine-runs / order-conversion pin job_values reads. This closes the gaps: the line items and payments that carry
 * the prices, and writes to job_values / quotes / invoices / lines, are refused by RLS for the workshop account too.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
let workshop: SupabaseClient;
let office: SupabaseClient;
const ids: Record<string, string> = {};

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  workshop = await signedInClient(world.tenants.alpha.users.workshop);
  office = await signedInClient(world.tenants.alpha.users.office);
  const org = world.tenants.alpha.id;
  const admin = adminClient();
  const one = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await admin.from(table).insert(row).select("id").single();
    if (error) throw new Error(`${table}: ${error.message}`);
    return data.id as string;
  };
  ids.job = await one("jobs", { organization_id: org, job_no: `J-MONEY-${world.runId}`, customer: "Money Co", description: "Bush" });
  const { error: valueError } = await admin.from("job_values").insert({ organization_id: org, job_id: ids.job, value: 1234.5 });
  if (valueError) throw new Error(`job_values: ${valueError.message}`);
  ids.quote = await one("quotes", { organization_id: org, quote_ref: `Q-MONEY-${world.runId}`, customer: "Money Co", total_value: 120, status: "draft" });
  ids.quoteLine = await one("quote_line_items", { organization_id: org, quote_id: ids.quote, position: 0, description: "Bush", quantity: 1, unit_price: 100, vat_pct: 20 });
  ids.invoice = await one("invoices", { organization_id: org, customer: "Money Co", subtotal: 100, vat: 20, total: 120 });
  ids.invoiceLine = await one("invoice_line_items", { organization_id: org, invoice_id: ids.invoice, position: 0, description: "Bush", quantity: 1, unit_price: 100, vat_pct: 20 });
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("a workshop account gets no prices from the database (RLS)", () => {
  it("is a workshop account in this company (not an admin looking through a workshop view)", async () => {
    expect((await workshop.rpc("current_user_role")).data).toBe("workshop");
    expect((await workshop.rpc("has_org_role", { allowed_roles: ["admin", "office"] })).data).toBe(false);
    // It sees the job itself (the worksheet), just not its value.
    expect((await workshop.from("jobs").select("id").eq("id", ids.job)).data).toHaveLength(1);
  });

  it("reads nothing from job_values, quotes, quote lines, invoices, invoice lines or payments; office reads them", async () => {
    const reads: Array<[string, string, string]> = [
      ["job_values", "job_id", ids.job], ["quotes", "id", ids.quote], ["quote_line_items", "id", ids.quoteLine],
      ["invoices", "id", ids.invoice], ["invoice_line_items", "id", ids.invoiceLine], ["invoice_payments", "invoice_id", ids.invoice],
    ];
    for (const [table, column, id] of reads) {
      const { data } = await workshop.from(table).select("*").eq(column, id);
      expect({ table, rows: data?.length ?? 0 }).toEqual({ table, rows: 0 });
    }
    for (const [table, column, id] of reads.filter(([table]) => table !== "invoice_payments")) {
      expect({ table, rows: ((await office.from(table).select("*").eq(column, id)).data ?? []).length }).toEqual({ table, rows: 1 });
    }
  });

  it("can't write a price: job_values, quotes, invoices and their lines are refused or change nothing", async () => {
    const org = world.tenants.alpha.id;
    expect((await workshop.from("job_values").upsert({ organization_id: org, job_id: ids.job, value: 1 })).error).not.toBeNull();
    expect((await workshop.from("quotes").insert({ organization_id: org, quote_ref: `Q-W-${world.runId}`, customer: "Money Co", total_value: 1 })).error).not.toBeNull();
    expect((await workshop.from("invoices").insert({ organization_id: org, customer: "Money Co", total: 1 })).error).not.toBeNull();
    expect((await workshop.from("quote_line_items").insert({ organization_id: org, quote_id: ids.quote, position: 1, description: "X", quantity: 1, unit_price: 1 })).error).not.toBeNull();
    // Updates through RLS that can't see the row change nothing.
    for (const [table, column, id, patch] of [
      ["job_values", "job_id", ids.job, { value: 1 }], ["quotes", "id", ids.quote, { total_value: 1 }], ["invoices", "id", ids.invoice, { total: 1 }],
      ["quote_line_items", "id", ids.quoteLine, { unit_price: 1 }], ["invoice_line_items", "id", ids.invoiceLine, { unit_price: 1 }],
    ] as const) {
      const { data } = await workshop.from(table).update(patch).eq(column, id).select();
      expect({ table, changed: data?.length ?? 0 }).toEqual({ table, changed: 0 });
    }
    const admin = adminClient();
    expect(Number((await admin.from("job_values").select("value").eq("job_id", ids.job).single()).data?.value)).toBe(1234.5);
    expect(Number((await admin.from("quotes").select("total_value").eq("id", ids.quote).single()).data?.total_value)).toBe(120);
    expect(Number((await admin.from("invoices").select("total").eq("id", ids.invoice).single()).data?.total)).toBe(120);
    expect(Number((await admin.from("quote_line_items").select("unit_price").eq("id", ids.quoteLine).single()).data?.unit_price)).toBe(100);
  });
});
