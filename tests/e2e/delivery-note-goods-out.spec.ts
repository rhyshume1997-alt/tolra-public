/**
 * Delivery notes for go-live: the goods-out wording and the Received by / Signature / Date line on the print sheet, and a customer's delivery
 * notes listed read-only on the Customers page (a note made from the order and a hand-made note that names the customer only).
 * Needs the Supabase stack (the e2e world); not runnable without it.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("the printed delivery note says goods out and has a Received by / Signature / Date line", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const ref = `DLN-GO-${w.runId}`;
  const id = (await adminClient().from("delivery_notes").insert({ organization_id: org, dn_number: ref, customer: "Goods Out Co", status: "despatched" }).select("id").single()).data!.id;
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto(`/delivery-notes/${id}/print`);
  await expect(page.getByTestId("dn-goods-out")).toHaveText("Goods out: the items listed above were despatched.");
  await expect(page.getByTestId("dn-received")).toHaveText(/Received by: _+ Signature: _+ Date: _+/);
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("dn-goods-out")).toBeVisible();
});

test("a customer's delivery notes are listed on the Customers page, linked by id or by name, and link to the print sheet", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const admin = adminClient();
  const name = `Notes List ${w.runId} Ltd`;
  const customer = (await admin.from("customers").insert({ organization_id: org, name }).select("id").single()).data!;
  const linked = (await admin.from("delivery_notes").insert({ organization_id: org, dn_number: `DLN-L1-${w.runId}`, customer: name, customer_id: customer.id, status: "despatched" }).select("id").single()).data!;
  await admin.from("delivery_notes").insert({ organization_id: org, dn_number: `DLN-L2-${w.runId}`, customer: name, status: "awaiting" });
  await admin.from("delivery_notes").insert({ organization_id: org, dn_number: `DLN-L3-${w.runId}`, customer: "Somebody Else Ltd", status: "awaiting" });
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto(`/customers?customer=${customer.id}`);
  await page.getByTestId("delivery-notes-for").getByText("Delivery notes").click();
  const list = page.getByTestId("delivery-notes-list");
  await expect(list.getByText(`DLN-L1-${w.runId}`)).toBeVisible();
  await expect(list.getByText(`DLN-L2-${w.runId}`)).toBeVisible();
  await expect(list.getByText(`DLN-L3-${w.runId}`)).toHaveCount(0);
  await list.getByText(`DLN-L1-${w.runId}`).click();
  await expect(page).toHaveURL(new RegExp(`/delivery-notes/${linked.id}/print`));
});
