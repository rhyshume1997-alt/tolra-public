/**
 * Trusted economics at create time (audit B3: D11, D12, D13, A8, A14). The app's totals (lib/money.ts) must be
 * exactly what the database recomputes from the stored lines, and anything else is refused with nothing stored.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals, type MoneyLine } from "@/lib/money";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
let client: SupabaseClient;
let seq = 0;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  client = await signedInClient(world.tenants.alpha.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

type Line = MoneyLine & { description?: string };

async function createThenIssue(args: Record<string, unknown>) {
  const created = await client.rpc("create_with_lines", args);
  if (created.error) return created;
  const issued = await client.rpc("issue_invoice", { p_invoice: created.data as string });
  return issued.error ? { data: null, error: issued.error } : created;
}

function invoiceCall(lines: Line[], carriage: number, opts: { vatEnabled?: boolean; carriageVat?: boolean } = {}, tamper = 0) {
  const vatEnabled = opts.vatEnabled ?? true;
  const carriageVat = opts.carriageVat ?? false;
  const totals = documentTotals(lines, carriage, { vatEnabled, carriageVat, standardRate: 20 });
  seq += 1;
  // Since 033 an API user creates a draft; the totals are checked again when it is issued. Both steps are checked here.
  return createThenIssue({
    p_parent: "invoices",
    p_header: {
      customer: "Synthetic", subtotal: totals.subtotal, carriage: totals.carriage, vat: totals.vat,
      total: Math.round((totals.total + tamper) * 100) / 100, vat_enabled: vatEnabled, carriage_vat: carriageVat, status: "draft", amount_paid: 0,
    },
    p_child: "invoice_line_items",
    p_fk: "invoice_id",
    p_lines: lines.map((line, position) => ({
      position, description: line.description ?? `Line ${position}`, quantity: line.quantity, unit_price: line.unitPrice,
      vat_pct: line.vatPct ?? 20, vat_exempt: Boolean(line.vatExempt),
    })),
  });
}

function quoteCall(lines: Line[], vatEnabled = true, totalOverride?: number) {
  const totals = documentTotals(lines, 0, { vatEnabled, standardRate: 20 });
  seq += 1;
  return client.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: `QUO-T${seq}`, customer: "Synthetic", total_value: totalOverride ?? totals.total, vat_enabled: vatEnabled, status: "draft" },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: lines.map((line, position) => ({ position, description: line.description ?? `Line ${position}`, quantity: line.quantity, unit_price: line.unitPrice, vat_pct: line.vatPct ?? 20, vat_exempt: Boolean(line.vatExempt) })),
  });
}

async function documentCount() {
  const admin = adminClient();
  const [q, i] = await Promise.all([
    admin.from("quotes").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id),
    // Issued invoices only: a draft that failed its check at issue is kept (and is not a finished document).
    admin.from("invoices").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id).neq("status", "draft"),
  ]);
  return (q.count ?? 0) + (i.count ?? 0);
}

/** Small deterministic generator, so a failure is reproducible. */
function* cases(count: number) {
  let state = 20261009;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rates = [20, 5, 0, 17.5];
  for (let c = 0; c < count; c += 1) {
    const lines: Line[] = [];
    for (let l = 0; l < 1 + Math.floor(next() * 4); l += 1) {
      lines.push({
        quantity: Math.max(1, Math.floor(next() * 5000)) / 1000,
        unitPrice: Math.floor(next() * 1_000_000) / 100,
        vatPct: rates[Math.floor(next() * rates.length)],
        vatExempt: next() < 0.15,
      });
    }
    yield { lines, carriage: next() < 0.5 ? Math.floor(next() * 5000) / 100 : 0, vatEnabled: next() < 0.85, carriageVat: next() < 0.5 };
  }
}

describe("app totals and database totals agree", () => {
  it("boundary values the float maths used to get wrong", async () => {
    for (const lines of [[{ quantity: 0.02, unitPrice: 7.25 }], [{ quantity: 0.5, unitPrice: 2.01 }], [{ quantity: 3, unitPrice: 0.33 }], [{ quantity: 1.333, unitPrice: 3 }]]) {
      expect((await invoiceCall(lines, 0)).error).toBeNull();
      expect((await quoteCall(lines)).error).toBeNull();
    }
  });

  it("60 mixed invoices (fractional quantities, several rates, exempt lines, carriage with and without VAT)", async () => {
    for (const c of cases(60)) {
      const { error } = await invoiceCall(c.lines, c.carriage, c);
      expect({ case: c, error: error?.message ?? null }).toEqual({ case: c, error: null });
    }
  });

  it("zero-priced draft lines, exempt-only and VAT-off documents are still accepted", async () => {
    expect((await quoteCall([{ quantity: 1, unitPrice: 0 }])).error).toBeNull();
    expect((await quoteCall([{ quantity: 2, unitPrice: 30, vatExempt: true }])).error).toBeNull();
    expect((await invoiceCall([{ quantity: 1, unitPrice: 99.99 }], 12.5, { vatEnabled: false, carriageVat: true })).error).toBeNull();
  });
});

describe("refused at the trusted boundary, with nothing stored", () => {
  const refused: [string, () => PromiseLike<{ error: { message: string } | null }>, RegExp][] = [
    ["tampered invoice total", () => invoiceCall([{ quantity: 2, unitPrice: 150 }], 0, {}, 0.01), /totals don't match/],
    ["tampered quote total", () => quoteCall([{ quantity: 2, unitPrice: 150 }], true, 300), /total doesn't match/],
    ["VAT left off the header while switched on", () => quoteCall([{ quantity: 1, unitPrice: 100 }], true, 100), /total doesn't match/],
    ["no lines", () => quoteCall([], true, 0), /at least one line/],
    ["priced line without a description", () => quoteCall([{ quantity: 1, unitPrice: 10, description: "  " }]), /needs a description/],
    ["price with fractions of a penny", () => invoiceCall([{ quantity: 1, unitPrice: 0.125 }], 0), /pounds and pence/],
    ["quantity with 4 decimal places", () => invoiceCall([{ quantity: 1.0001, unitPrice: 1 }], 0), /3 decimal places/],
    ["zero quantity", () => quoteCall([{ quantity: 0, unitPrice: 1 }]), /more than 0/],
    ["negative price", () => quoteCall([{ quantity: 1, unitPrice: -5 }]), /negative/],
  ];

  for (const [name, call, message] of refused) {
    it(name, async () => {
      const before = await documentCount();
      const { error } = await call();
      expect(error?.message ?? "accepted").toMatch(message);
      expect(await documentCount()).toBe(before);
    });
  }
});

describe("unchanged", () => {
  it("delivery notes are created as before", async () => {
    const { error } = await client.rpc("create_with_lines", {
      p_parent: "delivery_notes",
      p_header: { dn_number: "DN-T1", customer: "Synthetic" },
      p_child: "delivery_note_items",
      p_fk: "delivery_note_id",
      p_lines: [{ position: 0, description: "Bracket", quantity: 4 }],
    });
    expect(error).toBeNull();
  });
});
