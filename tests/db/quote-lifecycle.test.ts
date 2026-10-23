/**
 * Quote decisions and issued quotes (audit B4b: D1, D2 minimum; migration 020).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals } from "@/lib/money";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
let office: SupabaseClient;
let seq = 0;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  office = await signedInClient(world.tenants.alpha.users.office);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

async function quote(status: "draft" | "sent" = "draft") {
  seq += 1;
  const lines = [{ quantity: 4, unitPrice: 25, vatPct: 20 }];
  const { data, error } = await office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: `QUO-L${seq}`, customer: "Lifecycle Co", total_value: documentTotals(lines).total, vat_enabled: true, status, valid_until: "2026-12-31", description: "Scope" },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: lines.map((l, position) => ({ position, description: "Bush", quantity: l.quantity, unit_price: l.unitPrice, vat_pct: 20, vat_exempt: false })),
  });
  if (error) throw new Error(error.message);
  return data as string;
}

const statusOf = async (id: string) => (await adminClient().from("quotes").select("status").eq("id", id).single()).data?.status;

describe("decisions", () => {
  it("draft -> sent -> accepted, and accepted is final", async () => {
    const id = await quote();
    expect((await office.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    expect((await office.from("quotes").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    for (const next of ["rejected", "sent", "draft", "expired"]) {
      expect((await office.from("quotes").update({ status: next }).eq("id", id)).error).not.toBeNull();
    }
    expect(await statusOf(id)).toBe("accepted");
  });

  it("a draft can be rejected directly; rejected is final", async () => {
    const id = await quote();
    expect((await office.from("quotes").update({ status: "rejected", rejected_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    expect((await office.from("quotes").update({ status: "accepted" }).eq("id", id)).error).not.toBeNull();
  });

  it("viewers and the other company can't record a decision", async () => {
    const id = await quote("sent");
    const viewer = await signedInClient(world.tenants.alpha.users.viewer);
    const beta = await signedInClient(world.tenants.beta.users.admin);
    for (const client of [viewer, beta]) {
      const { data } = await client.from("quotes").update({ status: "accepted" }).eq("id", id).select("id");
      expect(data ?? []).toEqual([]);
    }
    expect(await statusOf(id)).toBe("sent");
  });
});

describe("issued quotes are locked; drafts stay correctable", () => {
  it("a sent quote's value, customer, validity and lines can't change, and it can't be deleted", async () => {
    const id = await quote("sent");
    const before = (await adminClient().from("quotes").select("*").eq("id", id).single()).data;
    for (const patch of [{ total_value: 1 }, { customer: "Other" }, { valid_until: "2027-06-30" }, { description: "Changed" }]) {
      expect((await office.from("quotes").update(patch).eq("id", id)).error).not.toBeNull();
    }
    expect((await office.from("quote_line_items").update({ unit_price: 1 }).eq("quote_id", id)).error).not.toBeNull();
    expect((await office.from("quote_line_items").insert({ organization_id: world.tenants.alpha.id, quote_id: id, position: 5, description: "Extra", quantity: 1, unit_price: 1 })).error).not.toBeNull();
    expect((await office.from("quotes").delete().eq("id", id)).error).not.toBeNull();
    expect((await adminClient().from("quotes").select("*").eq("id", id).single()).data).toEqual(before);
  });

  it("internal notes stay editable on a sent quote", async () => {
    const id = await quote("sent");
    expect((await office.from("quotes").update({ internal_notes: "Chased by phone" }).eq("id", id)).error).toBeNull();
  });

  it("a draft can be corrected (header and lines) and deleted", async () => {
    const id = await quote("draft");
    expect((await office.from("quote_line_items").update({ description: "Corrected bush" }).eq("quote_id", id)).error).toBeNull();
    expect((await office.from("quotes").update({ customer_notes: "Updated" }).eq("id", id)).error).toBeNull();
    expect((await office.from("quotes").delete().eq("id", id)).error).toBeNull();
  });
});
