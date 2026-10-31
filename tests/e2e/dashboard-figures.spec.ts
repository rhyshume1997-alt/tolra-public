/**
 * E6: the admin dashboard's figures (Open quotes, Open jobs, Money owed) are worked out from the company's records. This asserts
 * the figures a known set of rows must produce, not how the page reads them.
 *
 * The rows go into a company of their own (createSoloTenant), so the figures are exact whatever the other specs left behind.
 * Teardown removes the company with the rest of the run (destroySyntheticWorld).
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));

/** The big number of a dashboard tile, and the line under it, found by the tile's label. */
const tile = (page: Page, label: string) => {
  const heading = page.locator("[data-kpi-label]").filter({ hasText: new RegExp(`^${label}$`) });
  return { value: heading.locator("xpath=following-sibling::p[1]"), sub: heading.locator("xpath=following-sibling::p[2]") };
};

test("dashboard figures match the records in the company", async ({ page }) => {
  const solo = await createSoloTenant(w.runId, "dashfig");
  const org = solo.id;
  const db = adminClient();
  const ok = async (p: PromiseLike<{ error: { message: string } | null }>) => expect((await p).error).toBeNull();
  // One row per insert: a batch whose rows carry different keys sends null for the keys a row lacks, overriding column defaults.
  const each = async (table: string, rows: Record<string, unknown>[]) => { for (const row of rows) await ok(db.from(table).insert(row)); };
  const customer = "ZZ TEST Dashboard Ltd";

  // Quotes: two sent and still valid (open: 100 + 250), a draft, an expired sent one and an accepted one (none of them open).
  await each("quotes", [
    { organization_id: org, quote_ref: "ZZ-Q-OPEN1", customer, status: "sent", valid_until: london(30), sent_at: new Date().toISOString(), total_value: 100 },
    { organization_id: org, quote_ref: "ZZ-Q-OPEN2", customer, status: "sent", valid_until: london(30), sent_at: new Date().toISOString(), total_value: 250 },
    { organization_id: org, quote_ref: "ZZ-Q-DRAFT", customer, status: "draft", total_value: 999 },
    { organization_id: org, quote_ref: "ZZ-Q-EXPIRED", customer, status: "sent", valid_until: london(-3), sent_at: new Date(Date.now() - 20 * 86_400_000).toISOString(), total_value: 777 },
    { organization_id: org, quote_ref: "ZZ-Q-WON", customer, status: "accepted", valid_until: london(30), sent_at: new Date().toISOString(), total_value: 400 },
  ]);
  // Jobs: not started and due in two days, not started and two days late, finished and waiting for inspection (all three open),
  // and one inspected and complete (not open).
  await each("jobs", [
    { organization_id: org, job_no: "ZZ-J-DUE", customer, date_required: london(2) },
    { organization_id: org, job_no: "ZZ-J-LATE", customer, date_required: london(-2) },
    { organization_id: org, job_no: "ZZ-J-INSPECT", customer, stage: "inspection", started_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), finished_at: new Date(Date.now() - 86_400_000).toISOString() },
    { organization_id: org, job_no: "ZZ-J-DONE", customer, stage: "complete", started_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), finished_at: new Date(Date.now() - 4 * 86_400_000).toISOString(), inspected_at: new Date(Date.now() - 3 * 86_400_000).toISOString() },
  ]);
  // Invoices: two issued and unpaid (120 overdue, 80 not yet due: 200 owed across 2) and a draft (not owed).
  await each("invoices", [
    { organization_id: org, invoice_ref: "ZZ-INV-OVERDUE", customer, status: "sent", total: 120, subtotal: 120, vat: 0, vat_enabled: false, due_date: london(-5) },
    { organization_id: org, invoice_ref: "ZZ-INV-LATER", customer, status: "sent", total: 80, subtotal: 80, vat: 0, vat_enabled: false, due_date: london(10) },
    { organization_id: org, invoice_ref: "ZZ-INV-DRAFT", customer, status: "draft", total: 50, subtotal: 50, vat: 0, vat_enabled: false },
  ]);

  await signIn(page, solo.admin);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await expect(tile(page, "Open quotes").value).toHaveText("2");
  await expect(tile(page, "Open quotes").sub).toContainText("£350 awaiting reply");
  await expect(tile(page, "Open jobs").value).toHaveText("3");
  await expect(tile(page, "Open jobs").sub).toHaveText(/^1 due by .+, 1 late$/);
  await expect(tile(page, "Money owed").value).toHaveText("£200");
  await expect(tile(page, "Money owed").sub).toHaveText("Across 2 invoices, £120 overdue");

  // The same records moving a figure: a further unpaid invoice raises money owed and the invoice count by exactly its amount.
  await ok(db.from("invoices").insert({ organization_id: org, invoice_ref: "ZZ-INV-EXTRA", customer, status: "sent", total: 30, subtotal: 30, vat: 0, vat_enabled: false, due_date: london(20) }));
  await page.reload();
  await expect(tile(page, "Money owed").value).toHaveText("£230");
  await expect(tile(page, "Money owed").sub).toHaveText("Across 3 invoices, £120 overdue");
});
