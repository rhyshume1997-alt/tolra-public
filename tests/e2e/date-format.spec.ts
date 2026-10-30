/**
 * Migration 109, per-person date format: an office user changes it in Account Settings (live preview, then save), sees an invoice's dates
 * in the new format and switches back; the admin of the same company keeps their own (DD/MM/YYYY). Synthetic data only (alpha tenant);
 * the world is read inside the test, never at import.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

test("date format: office changes it (live preview, saved), invoice dates follow, back to DD/MM/YYYY; the company admin keeps their own", async ({ page, browser }) => {
  const w = world();
  const db = adminClient();
  const office = w.tenants.alpha.users.office;
  const admin = w.tenants.alpha.users.admin;
  const { data: invoice, error } = await db.from("invoices").insert({
    organization_id: w.tenants.alpha.id, invoice_ref: null, customer: `Date Format ${w.runId.slice(0, 6)} Ltd`, status: "draft",
    subtotal: 100, vat: 0, total: 100, vat_enabled: false, invoice_date: "2031-03-07", due_date: "2031-04-06", description: "Bush",
  }).select("id").single();
  expect(error).toBeNull();
  const details = () => page.getByRole("dialog", { name: /invoice details/ });
  const savedFormat = async (userId: string) => (await db.from("user_preferences").select("date_format").eq("user_id", userId).maybeSingle()).data?.date_format ?? null;

  await signIn(page, office);
  try {
    // Before any choice: DD/MM/YYYY.
    await page.goto(`/invoices?invoice=${invoice!.id}`);
    await expect(details()).toContainText("07/03/2031");
    await expect(details()).toContainText("06/04/2031");

    // Account Settings: the live preview follows the radio before anything is saved.
    // The invoice details dialog is modal: close it before reaching the sidebar.
    await page.keyboard.press("Escape");
    await expect(details()).toBeHidden();
    await page.getByRole("button", { name: "Settings" }).first().click();
    const settings = page.getByRole("dialog", { name: "Account Settings" });
    const preview = settings.getByTestId("date-format-preview");
    await expect(preview).toHaveText(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
    await settings.getByRole("radio", { name: /^YYYY-MM-DD \(ISO\)/ }).check();
    await expect(preview).toHaveText(/^\d{4}-\d{2}-\d{2}, \d{2}:\d{2}$/);
    await settings.getByRole("button", { name: "Save date format" }).click();
    await expect(settings.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await expect.poll(() => savedFormat(office.id)).toBe("ymd-number");

    // A list page that shows dates now writes them in ISO.
    await page.goto(`/invoices?invoice=${invoice!.id}`);
    await expect(details()).toContainText("2031-03-07");
    await expect(details()).toContainText("2031-04-06");
    await expect(details()).not.toContainText("07/03/2031");

    // The admin of the same company is unaffected: their own format is still DD/MM/YYYY.
    const other = await browser.newContext({ baseURL: String(test.info().project.use.baseURL) });
    try {
      const adminPage = await other.newPage();
      await signIn(adminPage, admin);
      await adminPage.goto(`/invoices?invoice=${invoice!.id}`);
      const adminDetails = adminPage.getByRole("dialog", { name: /invoice details/ });
      await expect(adminDetails).toContainText("07/03/2031");
      await expect(adminDetails).toContainText("06/04/2031");
      await expect(adminDetails).not.toContainText("2031-03-07");
      expect(await savedFormat(admin.id)).toBeNull();
    } finally {
      await other.close();
    }

    // Back to DD/MM/YYYY.
    // The invoice details dialog is modal: close it before reaching the sidebar.
    await page.keyboard.press("Escape");
    await expect(details()).toBeHidden();
    await page.getByRole("button", { name: "Settings" }).first().click();
    const again = page.getByRole("dialog", { name: "Account Settings" });
    await again.getByRole("radio", { name: /^DD\/MM\/YYYY/ }).check();
    await again.getByRole("button", { name: "Save date format" }).click();
    await expect(again.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await expect.poll(() => savedFormat(office.id)).toBe("dmy-number");
    await page.goto(`/invoices?invoice=${invoice!.id}`);
    await expect(details()).toContainText("07/03/2031");
    await expect(details()).toContainText("06/04/2031");
  } finally {
    // The login goes with the world at the end of the run; put the row back to the default for specs that run before that.
    await db.from("user_preferences").delete().eq("user_id", office.id);
  }
});
