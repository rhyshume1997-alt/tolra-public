/**
 * The dashboard's "Needs attention" list: one item per rule in a fresh company (so the counts are exact), each with its count and
 * its "View all" page, and a workshop user who never sees money items. Rules themselves: tests/unit/attention-items.test.ts.
 */
import { expect, test } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
// Noon UTC, offsetDays whole days from today's London date: that instant has the same London date in GMT and BST, so the app's whole
// London calendar days ("N days") are exactly -offsetDays at any hour. Now minus N x 24 h is not: within 6 days after the clocks
// go back, a run between 23:00 and 24:00 UTC lands on the next London date and shows N - 1 (CI run 40420511653, 26 Oct 2026).
const stamp = (offsetDays: number) => new Date(Date.parse(`${london(0)}T12:00:00Z`) + offsetDays * 86_400_000).toISOString();

test("admin sees one item per rule with its count and View all link", async ({ page }) => {
  const solo = await createSoloTenant(w.runId, "attention");
  const org = solo.id;
  const db = adminClient();
  const ok = async (p: PromiseLike<{ error: { message: string } | null }>) => expect((await p).error).toBeNull();
  // One row per insert: a batch whose rows carry different keys sends null for the keys a row lacks, overriding column defaults.
  const each = async (table: string, rows: Record<string, unknown>[]) => { for (const row of rows) await ok(db.from(table).insert(row)); };

  await each("quotes", [
    { organization_id: org, quote_ref: "Q-EXPIRED", customer: "Acme", status: "sent", valid_until: london(-3), sent_at: stamp(-20) },
    { organization_id: org, quote_ref: "Q-SILENT", customer: "Acme", status: "sent", valid_until: london(30), sent_at: stamp(-20) },
    { organization_id: org, quote_ref: "Q-ACCEPTED", customer: "Acme", status: "accepted", valid_until: london(-3), sent_at: stamp(-20) },
  ]);
  await ok(db.from("rfqs").insert({ organization_id: org, customer: "Clarify Co", description: "Needs a drawing", status: "clarification", created_at: stamp(-6) }));
  await ok(db.from("purchase_orders").insert({ organization_id: org, po_ref: "PO-LATE", supplier: "Steel Ltd", status: "sent", expected_delivery: london(-4) }));
  await each("jobs", [
    { organization_id: org, job_no: "J-LATE", customer: "Acme", date_required: london(-2) },
    { organization_id: org, job_no: "J-INSPECT", customer: "Acme", finished_at: stamp(-3), stage: "inspection" },
  ]);
  await each("invoices", [
    { organization_id: org, invoice_ref: "INV-OVERDUE", customer: "Acme", status: "sent", total: 120, subtotal: 120, vat: 0, vat_enabled: false, due_date: london(-5) },
    { organization_id: org, invoice_ref: "INV-DRAFT", customer: "Acme", status: "draft", total: 50, subtotal: 50, vat: 0, vat_enabled: false, created_at: stamp(-5) },
  ]);
  await each("delivery_notes", [
    { organization_id: org, dn_number: "DLN-AWAIT", customer: "Acme", status: "awaiting", created_at: stamp(-4), updated_at: stamp(-4) },
    { organization_id: org, dn_number: "DLN-OUT", customer: "Acme", status: "despatched", delivery_date: london(-2) },
  ]);

  await signIn(page, solo.admin);
  const card = page.getByTestId("needs-attention");
  for (const id of ["quotes-expired", "quotes-no-decision", "rfqs-clarification", "pos-late", "jobs-late", "invoices-overdue", "invoices-draft", "delivery-awaiting", "jobs-inspection", "delivery-uninvoiced"]) {
    await expect(card.getByTestId(`attention-count-${id}`), id).toHaveText("1");
  }
  const href = async (id: string) => card.getByTestId(`attention-${id}`).getByRole("link", { name: /View all/ }).getAttribute("href");
  expect(await href("quotes-expired")).toBe("/quotes?filter=expired");
  expect(await href("rfqs-clarification")).toBe("/rfq?filter=clarification");
  expect(await href("pos-late")).toBe("/purchase-orders?filter=late");
  expect(await href("jobs-late")).toBe("/jobs?filter=overdue");
  expect(await href("invoices-overdue")).toBe("/invoices?filter=overdue");
  expect(await href("delivery-awaiting")).toBe("/delivery-notes?filter=awaiting-old");
  await expect(card.getByText("Q-EXPIRED")).toBeVisible();
  await expect(card.getByText("Q-ACCEPTED")).toHaveCount(0);
  await expect(card.getByText("RFQ awaiting clarification")).toBeVisible();
  await expect(card.getByText("6 days")).toBeVisible();

  // "View all" opens the list filtered to exactly the rows counted: the expired quote, not the silent or accepted ones.
  await card.getByTestId("attention-quotes-expired").getByRole("link", { name: /View all/ }).click();
  await expect(page).toHaveURL(/\/quotes\?filter=expired/);
  await expect(page.getByTestId("list-filter-notice")).toBeVisible();
  await expect(page.getByText("Q-EXPIRED").first()).toBeVisible();
  await expect(page.getByText("Q-SILENT")).toHaveCount(0);
  await expect(page.getByText("Q-ACCEPTED")).toHaveCount(0);
  // An unknown value is harmless: no notice, the page opens as normal.
  await page.goto("/quotes?filter=bogus");
  await expect(page.getByTestId("list-filter-notice")).toHaveCount(0);
});

test("workshop sees workshop items and no money items", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const db = adminClient();
  const tag = w.runId;
  expect((await db.from("jobs").insert({ organization_id: org, job_no: `J-ATT-${tag}`, customer: "Acme", date_required: london(-2) })).error).toBeNull();
  expect((await db.from("invoices").insert({ organization_id: org, invoice_ref: `INV-ATT-${tag}`, customer: "Acme", status: "sent", total: 99, subtotal: 99, vat: 0, vat_enabled: false, due_date: london(-5) })).error).toBeNull();
  expect((await db.from("delivery_notes").insert({ organization_id: org, dn_number: `DLN-ATT-${tag}`, customer: "Acme", status: "signed", delivery_date: london(-2) })).error).toBeNull();

  await signIn(page, w.tenants.alpha.users.workshop);
  const card = page.getByTestId("needs-attention");
  await expect(card.getByText(`J-ATT-${tag}`)).toBeVisible();
  await expect(card.getByTestId("attention-jobs-late")).toBeVisible();
  for (const id of ["invoices-overdue", "invoices-draft", "delivery-uninvoiced", "quotes-expired", "pos-late"]) {
    await expect(card.getByTestId(`attention-${id}`), id).toHaveCount(0);
  }
  await expect(card.getByText(`INV-ATT-${tag}`)).toHaveCount(0);
  await expect(card.getByText(`DLN-ATT-${tag}`)).toHaveCount(0);
});
