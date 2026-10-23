/**
 * Role and tenant negative cases through the browser (audit B1/D27): the middleware is the real page gate, and a
 * user never sees another organisation's records.
 */
import { expect, test } from "@playwright/test";

import type { Role } from "../support/fixtures";
import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

/** Pages each role must be turned away from (sent to the dashboard), and one page it must reach. */
const CASES: Record<Exclude<Role, "admin">, { refused: string[]; allowed: string }> = {
  office: { refused: ["/admin/users", "/settings"], allowed: "/invoices" },
  workshop: { refused: ["/admin/users", "/invoices", "/sales-orders", "/quotes", "/customers", "/purchase-orders"], allowed: "/jobs" },
  viewer: { refused: ["/admin/users", "/invoices", "/sales-orders", "/quotes", "/delivery-notes", "/suppliers"], allowed: "/jobs" },
};

for (const [role, { refused, allowed }] of Object.entries(CASES) as [Exclude<Role, "admin">, (typeof CASES)["office"]][]) {
  test(`${role}: pasted URLs outside the role go to the dashboard; ${allowed} opens`, async ({ page }) => {
    await signIn(page, w.tenants.alpha.users[role]);
    for (const path of refused) {
      await page.goto(path);
      await expect(page, `${role} ${path}`).toHaveURL(/\/dashboard/);
    }
    await page.goto(allowed);
    await expect(page).toHaveURL(new RegExp(`${allowed}$`));
  });
}

test("signed out: a business page sends you to sign in", async ({ page }) => {
  await page.goto("/invoices");
  await expect(page).toHaveURL(/\/login/);
});

test("tenants: each admin sees only their own organisation's customers", async ({ page }) => {
  const names = { alpha: `Alpha only ${w.runId}`, beta: `Beta only ${w.runId}` };
  const { error } = await adminClient().from("customers").insert([
    { organization_id: w.tenants.alpha.id, name: names.alpha },
    { organization_id: w.tenants.beta.id, name: names.beta },
  ]);
  expect(error).toBeNull();

  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/customers");
  await expect(page.getByRole("cell", { name: names.beta })).toBeVisible();
  await expect(page.getByText(names.alpha)).toHaveCount(0);
});
