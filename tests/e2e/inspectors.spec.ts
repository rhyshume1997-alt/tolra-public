/**
 * Admin > Users > Inspectors (migration 083, ISO 9001 7.2): an admin adds someone to the authorised inspectors list with a reason,
 * sees them listed with that reason and in the history, then removes them with a reason. Company beta only, so alpha's inspectors
 * (allowInspectors in global set-up) are untouched; the spec leaves beta's office person off the list again.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { asSeparateDevice, signIn, world } from "./helpers";

test("an admin adds an inspector with a reason, then removes them with a reason; both changes are in the history", async ({ page }) => {
  const w = world();
  const beta = w.tenants.beta;
  const flag = async () => (await adminClient().from("organization_members").select("can_inspect").eq("organization_id", beta.id).eq("user_id", beta.users.office.id).single()).data?.can_inspect;
  expect(await flag()).toBe(false);

  await asSeparateDevice(page);
  await signIn(page, beta.users.admin);
  await page.goto("/admin/users");
  const section = page.getByTestId("authorised-inspectors");
  await expect(section.getByRole("heading", { name: "Inspectors" })).toBeVisible();

  await section.getByRole("button", { name: "Add inspector" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Person to add").selectOption({ label: "Office beta" });
  await dialog.getByLabel("Scope").fill("Dimensional and visual checks");
  await dialog.getByLabel("Reason").fill("short");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("at least 10 characters");
  await dialog.getByLabel("Reason").fill(`Trained on the bore gauges, run ${w.runId}`);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toBeHidden();

  const row = section.getByTestId("inspector-row").filter({ hasText: "Office beta" });
  await expect(row).toContainText(`Trained on the bore gauges, run ${w.runId}`);
  await expect(row).toContainText("Scope: Dimensional and visual checks");
  await expect.poll(flag).toBe(true);

  await row.getByRole("button", { name: "Remove" }).click();
  await dialog.getByLabel("Reason").fill(`Moved to stores, run ${w.runId}`);
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(section.getByTestId("inspector-row").filter({ hasText: "Office beta" })).toHaveCount(0);
  await expect.poll(flag).toBe(false);

  await section.getByText(/^History/).click();
  await expect(section.getByTestId("inspector-history-row").filter({ hasText: `Moved to stores, run ${w.runId}` })).toBeVisible();
  await expect(section.getByTestId("inspector-history-row").filter({ hasText: `Trained on the bore gauges, run ${w.runId}` })).toBeVisible();
});
