/**
 * Migration 124: a supplier purchase order linked to the customer quote or job it was bought for (quote_id, job_id, linked_net).
 * After the order is issued ONLY those three may change besides 076's open columns (status, sent/received times, delivery date, notes);
 * every other column stays locked exactly as before. Links to another company's quote or job are refused. The same proof for plain
 * PostgreSQL with stand-ins: tests/scripts/sql/124_purchase_order_link.proof.sql.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
let office: SupabaseClient;
let seq = 0;
const ids = { quoteA: "", quoteA2: "", jobA: "", jobA2: "", quoteB: "", jobB: "" };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  office = await signedInClient(world.tenants.alpha.users.office);
  const service = adminClient();
  const listed = await service.from("suppliers").insert([{ organization_id: world.tenants.alpha.id, name: "Steel Ltd" }, { organization_id: world.tenants.alpha.id, name: "Other Ltd" }]);
  if (listed.error) throw new Error(`suppliers: ${listed.error.message}`);
  const quote = async (tenant: "alpha" | "beta", ref: string) => {
    const { data, error } = await service.from("quotes").insert({ organization_id: world.tenants[tenant].id, quote_ref: `${ref}-${world.runId}`, customer: "Link Co", status: "draft" }).select("id").single();
    if (error) throw new Error(`quote: ${error.message}`);
    return data.id as string;
  };
  const job = async (tenant: "alpha" | "beta", ref: string) => {
    const { data, error } = await service.from("jobs").insert({ organization_id: world.tenants[tenant].id, job_no: `${ref}-${world.runId}`, customer: "Link Co" }).select("id").single();
    if (error) throw new Error(`job: ${error.message}`);
    return data.id as string;
  };
  ids.quoteA = await quote("alpha", "Q-L1");
  ids.quoteA2 = await quote("alpha", "Q-L2");
  ids.quoteB = await quote("beta", "Q-LB");
  ids.jobA = await job("alpha", "J-L1");
  ids.jobA2 = await job("alpha", "J-L2");
  ids.jobB = await job("beta", "J-LB");
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** An issued order for £250, linked to quote A and job A with £100 of it, made by the office user. */
async function issuedLinkedPo() {
  seq += 1;
  const ref = `PO-L${seq}-${world.runId}`;
  const { data, error } = await office.from("purchase_orders")
    .insert({ organization_id: world.tenants.alpha.id, po_ref: ref, po_number: ref, supplier: "Steel Ltd", total_value: 250, status: "draft",
      items: [{ description: "Bar", qty: 10, unit_price: 25 }], quote_id: ids.quoteA, job_id: ids.jobA, linked_net: 100 })
    .select("id").single();
  expect(error).toBeNull();
  const id = data!.id as string;
  expect((await office.from("purchase_orders").update({ status: "issued" }).eq("id", id)).error).toBeNull();
  return id;
}
const po = async (id: string) => (await adminClient().from("purchase_orders").select("*").eq("id", id).single()).data as Record<string, unknown>;
const without = (row: Record<string, unknown>) => { const { updated_at: _a, updated_by: _b, ...rest } = row; return rest; };

describe("124: an issued purchase order's quote/job link", () => {
  it("quote_id, job_id and linked_net each still change after issue; 076's open columns still do", async () => {
    const id = await issuedLinkedPo();
    expect((await office.from("purchase_orders").update({ quote_id: ids.quoteA2 }).eq("id", id)).error).toBeNull();
    expect((await office.from("purchase_orders").update({ job_id: ids.jobA2 }).eq("id", id)).error).toBeNull();
    expect((await office.from("purchase_orders").update({ linked_net: 12.34 }).eq("id", id)).error).toBeNull();
    expect(await po(id)).toMatchObject({ status: "issued", quote_id: ids.quoteA2, job_id: ids.jobA2, linked_net: 12.34, total_value: 250, supplier: "Steel Ltd" });
    expect((await office.from("purchase_orders").update({ quote_id: null, job_id: null, linked_net: null }).eq("id", id)).error).toBeNull();
    expect((await office.from("purchase_orders").update({ expected_delivery: "2099-02-01", notes: "Supplier moved delivery", sent_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
  });

  it("every other column stays locked after issue, exactly as before 124", async () => {
    const id = await issuedLinkedPo();
    const before = without(await po(id));
    const locked: Record<string, unknown> = {
      id: crypto.randomUUID(), organization_id: world.tenants.beta.id, po_ref: "PO-OTHER", po_number: "PO-OTHER", supplier: "Other Ltd",
      order_date: "2001-01-01", items: [], total_value: 1, created_at: "2001-01-01T00:00:00Z", vat_enabled: true,
      sent_by_name: "Someone Else", sent_by_user_id: world.tenants.alpha.users.office.id,
    };
    for (const [column, value] of Object.entries(locked)) {
      expect((await office.from("purchase_orders").update({ [column]: value }).eq("id", id)).error, column).toMatchObject({ code: "42501" });
    }
    // created_by and received_by: actor_keep (before the lock) keeps the old value for a signed-in user, so nothing changes.
    for (const column of ["created_by", "received_by"]) {
      await office.from("purchase_orders").update({ [column]: world.tenants.alpha.users.admin.id }).eq("id", id);
    }
    expect(without(await po(id))).toEqual(before);
    // A link change together with a locked column is refused whole.
    expect((await office.from("purchase_orders").update({ job_id: null, total_value: 1 }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await office.from("purchase_orders").delete().eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await office.from("purchase_orders").update({ status: "draft" }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect(without(await po(id))).toEqual(before);
  });

  it("an issued order can't be linked to another company's quote or job, or given a negative amount", async () => {
    const id = await issuedLinkedPo();
    expect((await office.from("purchase_orders").update({ quote_id: ids.quoteB }).eq("id", id)).error).toMatchObject({ code: "23514" });
    expect((await office.from("purchase_orders").update({ job_id: ids.jobB }).eq("id", id)).error).toMatchObject({ code: "23514" });
    expect((await office.from("purchase_orders").update({ linked_net: -1 }).eq("id", id)).error).toMatchObject({ code: "23514" });
    expect(await po(id)).toMatchObject({ quote_id: ids.quoteA, job_id: ids.jobA, linked_net: 100 });
  });
});
