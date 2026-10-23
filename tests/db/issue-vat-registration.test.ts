/**
 * Issuing after the company stops being VAT registered (A3 review, separate change). The PDF never prints VAT for a
 * company that isn't VAT registered (BaseDocumentPDF), so a document whose stored totals include VAT can't be printed
 * once registration is off. The server's issue check (check_document_totals) must therefore apply the same rule, or
 * issue_invoice (and sending a quote) would accept totals the app can then never print. Migration 030.
 * Synthetic data, local stack only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let admin: SupabaseClient;
let original: Record<string, unknown>;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  admin = await signedInClient(world.tenants.alpha.users.admin);
  const { data } = await adminClient().from("organization_settings").select("company_profile").eq("organization_id", world.tenants.alpha.id).single();
  original = data!.company_profile as Record<string, unknown>;
});

afterAll(async () => {
  if (original) await setProfile(original);
  if (world) await destroySyntheticWorld(world.runId);
});

async function setProfile(profile: Record<string, unknown>) {
  const { error } = await adminClient().from("organization_settings").update({ company_profile: profile }).eq("organization_id", world.tenants.alpha.id);
  if (error) throw new Error(error.message);
}

const LINE = { position: 0, description: "Machined part", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false };

async function draftInvoice(vat: number, total: number, carriage = 0) {
  const { data, error } = await admin.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: "VAT Registration Co", subtotal: 100, carriage, vat, total, vat_enabled: true, carriage_vat: carriage > 0, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: [LINE],
  });
  if (error) throw new Error(error.message);
  return data as string;
}

let quoteSeq = 0;

async function draftQuote(total: number) {
  const { data, error } = await admin.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: `QUO-VATREG-${world.runId}-${++quoteSeq}`, customer: "VAT Registration Co", description: "Quote", total_value: total, vat_enabled: true, status: "draft" },
    p_child: "quote_line_items", p_fk: "quote_id", p_lines: [LINE],
  });
  if (error) throw new Error(error.message);
  return data as string;
}

describe("issuing when the company is no longer VAT registered", () => {
  it("an invoice drafted with VAT can't be issued once the company is not VAT registered", async () => {
    const id = await draftInvoice(20, 120);
    await setProfile({ ...original, vatRegistered: false });
    try {
      const { error } = await admin.rpc("issue_invoice", { p_invoice: id });
      expect(error?.message).toMatch(/don't match/);
      const { data } = await adminClient().from("invoices").select("status, invoice_ref").eq("id", id).single();
      expect(data).toEqual({ status: "draft", invoice_ref: null });
    } finally {
      await setProfile(original);
    }
  });

  it("the same invoice drafted without VAT (as the app saves it when not registered) issues", async () => {
    await setProfile({ ...original, vatRegistered: false });
    try {
      const id = await draftInvoice(0, 100);
      const { data, error } = await admin.rpc("issue_invoice", { p_invoice: id });
      expect(error).toBeNull();
      expect(String(data)).toMatch(/^INV-/);
    } finally {
      await setProfile(original);
    }
  });

  it("a quote drafted with VAT can't be sent once the company is not VAT registered", async () => {
    const id = await draftQuote(120);
    await setProfile({ ...original, vatRegistered: false });
    try {
      const { error } = await admin.from("quotes").update({ status: "sent" }).eq("id", id).select("id");
      expect(error?.message).toMatch(/doesn't match/);
    } finally {
      await setProfile(original);
    }
  });

  it("carriage VAT counts too: a draft with VAT on its carriage can't be issued once not registered", async () => {
    // £100 line + £20 carriage, both at 20%: VAT 24, total 144 while registered.
    const id = await draftInvoice(24, 144, 20);
    await setProfile({ ...original, vatRegistered: false });
    try {
      const { error } = await admin.rpc("issue_invoice", { p_invoice: id });
      expect(error?.message).toMatch(/don't match.*VAT 0(\.00)?, total 120\.00/);
    } finally {
      await setProfile(original);
    }
    // Registered again, the same draft issues unchanged.
    const { error } = await admin.rpc("issue_invoice", { p_invoice: id });
    expect(error).toBeNull();
  });

  it("an invoice issued while registered keeps its VAT and can still be paid after registration is turned off", async () => {
    const id = await draftInvoice(24, 144, 20);
    const { error: issueError } = await admin.rpc("issue_invoice", { p_invoice: id });
    expect(issueError).toBeNull();
    await setProfile({ ...original, vatRegistered: false });
    try {
      const { error } = await admin.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: 144, p_paid_on: "2026-10-01", p_method: "BACS", p_reference: null });
      expect(error).toBeNull();
      const { data } = await adminClient().from("invoices").select("status, subtotal, carriage, vat, total, issuer_snapshot").eq("id", id).single();
      expect(data).toMatchObject({ status: "paid", subtotal: 100, carriage: 20, vat: 24, total: 144 });
      expect((data!.issuer_snapshot as Record<string, unknown>).vatRegistered).not.toBe(false);
    } finally {
      await setProfile(original);
    }
  });

  it("only JSON false means not registered (same rule as the app: vatRegistered !== false)", async () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ["false", { ...original, vatRegistered: false }, false],
      ["true", { ...original, vatRegistered: true }, true],
      ["missing", Object.fromEntries(Object.entries(original).filter(([k]) => k !== "vatRegistered")), true],
      ["null", { ...original, vatRegistered: null }, true],
      ["string 'false'", { ...original, vatRegistered: "false" }, true],
      ["0", { ...original, vatRegistered: 0 }, true],
    ];
    try {
      for (const [label, profile, expected] of cases) {
        await setProfile(profile);
        const { data, error } = await admin.rpc("org_vat_registered", { p_org: world.tenants.alpha.id });
        expect(error, label).toBeNull();
        expect(data, label).toBe(expected);
      }
    } finally {
      await setProfile(original);
    }
  });

  it("the hosted check (supabase/verify/vat_registration_030.sql) runs read only and finds a draft 030 would refuse", async () => {
    const sql = readFileSync(path.resolve(__dirname, "../../supabase/verify/vat_registration_030.sql"), "utf8");
    const run = () => withDb(async (db) => {
      await db.query("begin transaction read only");
      try {
        return (await db.query<{ check_name: string; value: string }>(sql)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    const value = (rows: Array<{ check_name: string; value: string }>, name: string) => rows.find((r) => r.check_name.startsWith(name))?.value;
    const id = await draftInvoice(20, 120);
    const quote = await draftQuote(120);
    const before = await run();
    expect(value(before, "030 applied: org_vat_registered exists")).toBe("true");
    expect(value(before, "030 applied: check_document_totals uses it")).toBe("true");
    await setProfile({ ...original, vatRegistered: false });
    try {
      const rows = await run();
      expect(Number(value(rows, "companies NOT VAT registered"))).toBeGreaterThanOrEqual(1);
      expect(Number(value(rows, "draft invoices 030 would refuse"))).toBeGreaterThanOrEqual(1);
      expect(Number(value(rows, "draft quotes 030 would refuse"))).toBeGreaterThanOrEqual(1);
    } finally {
      await setProfile(original);
    }
    // Clean up so later cases see a registered company with no blocked drafts of ours.
    await adminClient().from("invoices").delete().eq("id", id);
    await adminClient().from("quotes").delete().eq("id", quote);
  });

  it("while registered, nothing changes: the VAT-inclusive invoice issues", async () => {
    const id = await draftInvoice(20, 120);
    const { error } = await admin.rpc("issue_invoice", { p_invoice: id });
    expect(error).toBeNull();
  });
});
