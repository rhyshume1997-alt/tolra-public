/**
 * E6: two people editing the same customer. Each form holds the customer as it was read (with its updated_at). The first save
 * goes through; the second is refused with "Someone else changed this customer", nothing of it is written, and the list reloads
 * with the first person's value. Two browser contexts of the same admin stand in for two people.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function openEdit(page: Page, name: string) {
  await page.goto("/customers");
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit customer" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a second save of a customer someone else changed is refused and writes nothing", async ({ browser }) => {
  const db = adminClient();
  const name = `ZZ TEST Conflict ${w.runId.slice(0, 8)} Ltd`;
  const { data: created, error } = await db.from("customers").insert({ organization_id: w.tenants.alpha.id, name, contact_name: "Original Contact" }).select("id").single();
  expect(error).toBeNull();
  const id = created!.id as string;
  const contactInDb = async () => (await db.from("customers").select("contact_name").eq("id", id).single()).data?.contact_name;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await signIn(pageA, w.tenants.alpha.users.admin);
    await signIn(pageB, w.tenants.alpha.users.admin);

    // Both open the same customer, as it is now.
    const formA = await openEdit(pageA, name);
    const formB = await openEdit(pageB, name);
    await expect(formA.getByPlaceholder("Contact name")).toHaveValue("Original Contact");
    await expect(formB.getByPlaceholder("Contact name")).toHaveValue("Original Contact");

    // A saves first.
    await formA.getByPlaceholder("Contact name").fill("Changed By A");
    await formA.getByRole("button", { name: "Save Customer" }).click();
    await expect(pageA.getByText("Customer updated")).toBeVisible();
    await expect(formA).toBeHidden();
    expect(await contactInDb()).toBe("Changed By A");

    // B, still on the old version, saves a different change: refused.
    await formB.getByPlaceholder("Contact name").fill("Changed By B");
    await formB.getByRole("button", { name: "Save Customer" }).click();
    await expect(pageB.getByText(/Someone else changed this customer while you were editing, so nothing was saved/)).toBeVisible();
    await expect(formB).toBeHidden();
    expect(await contactInDb()).toBe("Changed By A");

    // B's list was reloaded and shows A's value; after a full reload so does the database, and B's text was never written.
    await expect(pageB.getByRole("row").filter({ hasText: name })).toContainText("Changed By A");
    await pageB.reload();
    await expect(pageB.getByRole("row").filter({ hasText: name })).toContainText("Changed By A");
    await expect(pageB.getByRole("row").filter({ hasText: name })).not.toContainText("Changed By B");
    expect(await contactInDb()).toBe("Changed By A");

    // Opened again on the fresh record, B's change goes through.
    const retry = await openEdit(pageB, name);
    await retry.getByPlaceholder("Contact name").fill("Changed By B");
    await retry.getByRole("button", { name: "Save Customer" }).click();
    await expect(pageB.getByText("Customer updated")).toBeVisible();
    expect(await contactInDb()).toBe("Changed By B");
  } finally {
    await contextA.close();
    await contextB.close();
    await db.from("customers").delete().eq("id", id);
  }
});
