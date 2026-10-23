/**
 * Which company settings a DRAFT invoice is shown, checked and printed with (audit A3 follow-up). Saving a draft
 * stores an issuer snapshot (create_with_lines, 021), but issue_invoice (027) checks the totals at the CURRENT
 * standard VAT rate and replaces the snapshot with the current one. So a draft must follow current settings in the
 * details panel, the totals check and the PDF (lib/invoice-totals invoiceIssuer), and an issued invoice keeps its
 * issue-time snapshot. Uses a real saved draft on the local stack; synthetic data only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { storedTotalsProblem } from "@/components/pdf/BaseDocumentPDF";
import { type CompanyProfile, parseCompanyProfile } from "@/lib/company";
import { invoiceDisplayTotals, invoiceIssuer } from "@/lib/invoice-totals";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
let admin: SupabaseClient;
let original: Record<string, unknown>;

const LINES = [{ description: "Machined part", quantity: 1, unitPrice: 100, vatPct: 20, vatExempt: false }];

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
const current = async () => {
  const { data } = await adminClient().from("organization_settings").select("company_profile").eq("organization_id", world.tenants.alpha.id).single();
  return parseCompanyProfile(data!.company_profile) as CompanyProfile;
};

/** £100 line at 20% + £20 carriage taxed at the standard rate, saved as a draft the way the app saves it. */
async function saveDraft(vat: number, total: number) {
  const { data, error } = await admin.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: "Draft Settings Co", subtotal: 100, carriage: 20, vat, total, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items",
    p_fk: "invoice_id",
    p_lines: LINES.map((l, position) => ({ position, description: l.description, quantity: l.quantity, unit_price: l.unitPrice, vat_pct: l.vatPct, vat_exempt: l.vatExempt })),
  });
  if (error) throw new Error(error.message);
  return data as string;
}
const row = async (id: string) => (await adminClient().from("invoices").select("*").eq("id", id).single()).data as Record<string, unknown>;
const view = (r: Record<string, unknown>) => ({
  carriage: Number(r.carriage), vatEnabled: r.vat_enabled === true, carriageVat: r.carriage_vat === true,
  issuerSnapshot: r.issuer_snapshot, rawStatus: String(r.status),
});
/** The check the PDF and the details panel run before showing lines (invoiceTotalsProblem in the invoices page). */
const pdfProblem = (r: Record<string, unknown>, company: CompanyProfile) => storedTotalsProblem({
  lineItems: LINES, carriage: Number(r.carriage), showVat: r.vat_enabled === true, carriageVat: r.carriage_vat === true, company,
  storedTotals: { reference: String(r.invoice_ref ?? "draft"), issued: r.status !== "draft", total: Number(r.total), subtotal: Number(r.subtotal), vat: Number(r.vat) },
});

describe("a saved draft follows current company settings; an issued invoice keeps its snapshot", () => {
  it("draft saved at 20%, rate then changed to 17.5%: details, totals check, PDF and issuing all use 17.5%", async () => {
    const id = await saveDraft(24, 144);
    const saved = await row(id);
    expect(saved.status).toBe("draft");
    expect(saved.issuer_snapshot).toMatchObject({ defaultVatRate: 20, vatRegistered: true }); // the draft DOES carry a snapshot
    await setProfile({ ...original, defaultVatRate: 17.5 });
    try {
      const now = await current();
      const draft = view(saved);
      // Details panel: current settings, not the draft's saved snapshot (which would still say £144).
      expect(invoiceIssuer(draft, now).defaultVatRate).toBe(17.5);
      expect(invoiceDisplayTotals(draft, LINES, now).totals).toMatchObject({ subtotal: 100, vat: 23.5, total: 143.5 });
      expect(invoiceDisplayTotals({ ...draft, rawStatus: "issued" }, LINES, now).totals.total).toBe(144);
      // Totals check / PDF: the stored £144 no longer adds up at today's rate, so it is flagged instead of printed...
      expect(pdfProblem(saved, invoiceIssuer(draft, now))).not.toBeNull();
      // ...exactly as issuing it would refuse it (issue_invoice checks at the current rate).
      const refused = await admin.rpc("issue_invoice", { p_invoice: id });
      expect(refused.error?.message).toMatch(/don't match/);
      expect((await row(id)).status).toBe("draft");
    } finally {
      await setProfile(original);
    }
  });

  it("the ORIGINAL draft, corrected after the rate change, issues at today's rate and then keeps it", async () => {
    // Saved at 20% (snapshot 20%, stored £144), then the company moves to 17.5%.
    const id = await saveDraft(24, 144);
    expect((await row(id)).issuer_snapshot).toMatchObject({ defaultVatRate: 20 });
    await setProfile({ ...original, defaultVatRate: 17.5 });
    try {
      expect((await admin.rpc("issue_invoice", { p_invoice: id })).error?.message).toMatch(/don't match/);
      // The app has no draft-invoice editing screen; a correction is an update of the same draft row (allowed while
      // it is a draft). Its saved 20% snapshot stays as it was: only issuing replaces it.
      const corrected = await admin.from("invoices").update({ vat: 23.5, total: 143.5 }).eq("id", id).select("id");
      expect(corrected.error).toBeNull();
      expect(corrected.data).toHaveLength(1);
      const draft = await row(id);
      expect(draft).toMatchObject({ status: "draft" });
      expect(draft.issuer_snapshot).toMatchObject({ defaultVatRate: 20 }); // stale snapshot still on the draft
      const now = await current();
      expect(invoiceDisplayTotals(view(draft), LINES, now).totals).toMatchObject({ vat: 23.5, total: 143.5 });
      expect(pdfProblem(draft, invoiceIssuer(view(draft), now))).toBeNull(); // details/PDF agree with the corrected totals
      const issued = await admin.rpc("issue_invoice", { p_invoice: id });
      expect(issued.error).toBeNull();
    } finally {
      await setProfile({ ...original, defaultVatRate: 20, vatRegistered: false });
    }
    try {
      const after = await row(id);
      const now = await current();
      expect(after).toMatchObject({ status: "issued" });
      expect(after.issuer_snapshot).toMatchObject({ defaultVatRate: 17.5, vatRegistered: true }); // replaced at issue
      expect(invoiceDisplayTotals(view(after), LINES, now).totals).toMatchObject({ vat: 23.5, total: 143.5 });
      expect(pdfProblem(after, invoiceIssuer(view(after), now))).toBeNull();
      expect([after.subtotal, after.vat, after.total].map(Number)).toEqual([100, 23.5, 143.5]);
    } finally {
      await setProfile(original);
    }
  });
});
