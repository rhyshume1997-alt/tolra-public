/** RFQ page: an RFQ that has a quote opens it instead of offering Clarify. */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("RFQ: a quoted RFQ that was left on clarification offers Open <quote>, not Clarify", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const customer = `RFQ Sweep ${w.runId}`;
  const ref = `QUO-SW-${w.runId}`;
  const { data: rfq } = await admin.from("rfqs").insert({ organization_id: org, customer, description: `Sweep ${w.runId}`, status: "clarification" }).select("id").single();
  expect((await admin.from("quotes").insert({ organization_id: org, quote_ref: ref, customer, total_value: 10, status: "sent", rfq_id: rfq!.id })).error).toBeNull();
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/rfq");
  await page.getByRole("button", { name: /^Quoted \(/ }).click();
  const card = page.locator('[data-slot="card"]', { hasText: customer });
  await expect(card.getByRole("link", { name: `Open ${ref}` })).toBeVisible();
  await expect(card.getByRole("button", { name: "Clarify" })).toHaveCount(0);
});

test("RFQ: the new-RFQ material has no default", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/rfq");
  await page.getByRole("button", { name: "New RFQ", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create New RFQ" });
  await expect(dialog.locator('select[name="material"]')).toHaveValue(""); // no default material
});
