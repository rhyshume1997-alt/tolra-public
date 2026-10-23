/**
 * updated_at moves (migration 037, issue #3 item 8). Issuing or paying an invoice, and changing a job, used to leave updated_at at
 * the creation time. One trigger now sets it for signed-in users; the service role, the database owner and the importer keep the
 * dates they write. The legacy importer's own database test (legacy-import.test.ts) runs in the same suite.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
const LONG_AGO = "2020-01-01T00:00:00+00:00";
const ms = (value: string) => new Date(value).getTime();

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const outcome = (r: { error: { code?: string; message?: string } | null }) => ({ code: r.error?.code ?? null, message: r.error?.message ?? null });
const SAVED = { code: null, message: null };
const updatedAt = async (table: string, id: string) => ((await adminClient().from(table).select("updated_at").eq("id", id).single()).data as { updated_at: string }).updated_at;
/** Puts updated_at far in the past with the service role (exempt, so it stays), to show the move clearly. */
const age = async (table: string, id: string) => {
  expect(outcome(await adminClient().from(table).update({ updated_at: LONG_AGO }).eq("id", id))).toEqual(SAVED);
  expect(ms(await updatedAt(table, id))).toBe(ms(LONG_AGO));
};

describe("updated_at follows changes made by signed-in users", () => {
  it("an invoice's updated_at moves when it is issued and when a payment is recorded", async () => {
    const created = await as.admin.rpc("create_with_lines", {
      p_parent: "invoices",
      p_header: { customer: "Updated Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
      p_child: "invoice_line_items", p_fk: "invoice_id",
      p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
    });
    expect(outcome(created)).toEqual(SAVED);
    const id = created.data as string;
    await age("invoices", id);
    expect(outcome(await as.admin.rpc("issue_invoice", { p_invoice: id }))).toEqual(SAVED);
    const issued = await updatedAt("invoices", id);
    expect(ms(issued)).toBeGreaterThan(Date.now() - 60_000);
    await age("invoices", id);
    const paid = await as.office.rpc("record_invoice_payment", { p_invoice: id, p_amount: 60, p_paid_on: "2026-10-10", p_method: "BACS", p_reference: null, p_request_id: randomUUID() });
    expect(outcome(paid)).toEqual(SAVED);
    expect(ms(await updatedAt("invoices", id))).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a job's updated_at moves when it is started, finished or edited, and not by an update that changes nothing", async () => {
    const { data } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-UPD-${world.runId}`, customer: "Updated Co" }).select("id").single();
    const id = data!.id as string;
    await age("jobs", id);
    expect(outcome(await as.workshop.from("jobs").update({ started_at: new Date().toISOString() }).eq("id", id))).toEqual(SAVED);
    expect(ms(await updatedAt("jobs", id))).toBeGreaterThan(Date.now() - 60_000);
    await age("jobs", id);
    expect(outcome(await as.workshop.from("jobs").update({ status: "on_track" }).eq("id", id))).toEqual(SAVED); // already on_track
    expect(ms(await updatedAt("jobs", id))).toBe(ms(LONG_AGO));
    expect(outcome(await as.office.from("jobs").update({ status: "at_risk" }).eq("id", id))).toEqual(SAVED);
    expect(ms(await updatedAt("jobs", id))).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a quote's updated_at moves with an ordinary edit, and a value a function sets itself (the draft-correction token) is kept", async () => {
    const { data } = await adminClient().from("quotes").insert({ organization_id: world.tenants.alpha.id, quote_ref: `QUO-UPD-${world.runId}`, customer: "Updated Co", status: "draft", total_value: 0 }).select("id").single();
    const id = data!.id as string;
    await age("quotes", id);
    expect(outcome(await as.office.from("quotes").update({ description: "Edited" }).eq("id", id))).toEqual(SAVED);
    expect(ms(await updatedAt("quotes", id))).toBeGreaterThan(Date.now() - 60_000);
    await age("quotes", id);
    const replaced = await as.office.rpc("replace_draft_quote", { p_quote: id, p_expected_updated_at: LONG_AGO, p_header: { customer: "Updated Co", total_value: 6, vat_enabled: true }, p_lines: [{ position: 0, description: "Bush", quantity: 1, unit_price: 5, vat_pct: 20, vat_exempt: false }] });
    expect(outcome(replaced)).toEqual(SAVED);
    expect(ms(await updatedAt("quotes", id))).toBe(ms(replaced.data as string));
  });

  it("the service role and the database owner keep the dates they write (imports, repairs)", async () => {
    const { data } = await adminClient().from("suppliers").insert({ organization_id: world.tenants.alpha.id, name: `Updated Supplier ${world.runId}`, updated_at: LONG_AGO }).select("id").single();
    const id = data!.id as string;
    expect(ms(await updatedAt("suppliers", id))).toBe(ms(LONG_AGO));
    expect(outcome(await adminClient().from("suppliers").update({ email: "s@example.test" }).eq("id", id))).toEqual(SAVED);
    expect(ms(await updatedAt("suppliers", id))).toBe(ms(LONG_AGO));
  });
});
