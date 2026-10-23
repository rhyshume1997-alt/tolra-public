/**
 * Correcting a draft quote (audit B4b: D2 minimum; migration 021): header and lines replaced in one step with the
 * same checks as creation, refused once issued or when someone else saved first, nothing changed on failure.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals, type MoneyLine } from "@/lib/money";

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

const rows = (lines: (MoneyLine & { description: string })[]) => lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unitPrice, vat_pct: l.vatPct ?? 20, vat_exempt: Boolean(l.vatExempt) }));

async function draft() {
  seq += 1;
  const lines = [{ description: "Bush", quantity: 4, unitPrice: 25, vatPct: 20 }];
  const { data, error } = await office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: `QUO-D${seq}`, customer: "Draft Co", total_value: documentTotals(lines).total, vat_enabled: true, status: "draft" },
    p_child: "quote_line_items", p_fk: "quote_id", p_lines: rows(lines).map((r, position) => ({ ...r, position })),
  });
  if (error) throw new Error(error.message);
  const { data: q } = await adminClient().from("quotes").select("id, updated_at").eq("id", data).single();
  return q as { id: string; updated_at: string };
}

const replace = (client: SupabaseClient, q: { id: string; updated_at: string }, lines: (MoneyLine & { description: string })[], header: Record<string, unknown> = {}, total?: number) =>
  client.rpc("replace_draft_quote", {
    p_quote: q.id, p_expected_updated_at: q.updated_at,
    p_header: { customer: "Draft Co", total_value: total ?? documentTotals(lines).total, vat_enabled: true, ...header },
    p_lines: rows(lines),
  });

const snapshot = async (id: string) => ({
  quote: (await adminClient().from("quotes").select("customer, total_value, updated_at, description").eq("id", id).single()).data,
  lines: (await adminClient().from("quote_line_items").select("description, quantity, unit_price, vat_pct, position").eq("quote_id", id).order("position")).data,
});

describe("draft correction", () => {
  it("replaces header and lines; the correction survives a reload", async () => {
    const q = await draft();
    const lines = [{ description: "Bush 40mm", quantity: 10, unitPrice: 25, vatPct: 20 }, { description: "Spacer", quantity: 2, unitPrice: 4.5, vatPct: 0 }];
    const { data, error } = await replace(office, q, lines, { description: "Revised scope" });
    expect(error).toBeNull();
    const after = await snapshot(q.id);
    expect(after.quote).toMatchObject({ description: "Revised scope", total_value: documentTotals(lines).total, updated_at: expect.any(String) });
    expect(new Date(after.quote!.updated_at).getTime()).toBe(new Date(data as string).getTime());
    expect(after.lines?.map((l) => [l.description, Number(l.quantity), Number(l.unit_price), Number(l.vat_pct), l.position])).toEqual([["Bush 40mm", 10, 25, 20, 0], ["Spacer", 2, 4.5, 0, 1]]);
  });

  it("a stale edit (someone else saved first) is refused and changes nothing", async () => {
    const q = await draft();
    expect((await replace(office, q, [{ description: "First", quantity: 1, unitPrice: 10 }])).error).toBeNull();
    const before = await snapshot(q.id);
    const { error } = await replace(office, q, [{ description: "Second", quantity: 1, unitPrice: 99 }]);
    expect(error?.message).toMatch(/changed by someone else/);
    expect(await snapshot(q.id)).toEqual(before);
  });

  it("a failing line or total rolls the whole correction back", async () => {
    for (const [lines, total] of [
      [[{ description: "Good", quantity: 1, unitPrice: 10 }, { description: "", quantity: 1, unitPrice: 5 }], undefined],
      [[{ description: "Bad price", quantity: 1, unitPrice: 0.125 }], 0.15],
      [[{ description: "Tampered", quantity: 1, unitPrice: 10 }], 1],
    ] as const) {
      const q = await draft();
      const before = await snapshot(q.id);
      const { error } = await replace(office, q, lines as never, {}, total as number | undefined);
      expect(error).not.toBeNull();
      expect(await snapshot(q.id)).toEqual(before);
    }
  });

  it("issued quotes, viewers and the other company are refused", async () => {
    const q = await draft();
    await adminClient().from("quotes").update({ status: "sent" }).eq("id", q.id);
    expect((await replace(office, q, [{ description: "X", quantity: 1, unitPrice: 1 }])).error?.message).toMatch(/issued/);
    const q2 = await draft();
    const viewer = await signedInClient(world.tenants.alpha.users.viewer);
    expect((await replace(viewer, q2, [{ description: "X", quantity: 1, unitPrice: 1 }])).error).not.toBeNull();
    const beta = await signedInClient(world.tenants.beta.users.admin);
    expect((await replace(beta, q2, [{ description: "X", quantity: 1, unitPrice: 1 }])).error).not.toBeNull();
  });
});
