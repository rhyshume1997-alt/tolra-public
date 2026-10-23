/**
 * Marking a purchase order's goods as received survives a reload and is stored in the right company: the other company's
 * order, even with the same reference, is left alone.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("goods received: the status and time are stored for this company, survive a reload, and nothing else changes", async ({ page }) => {
  const ref = `PO-RCV-${w.runId.slice(0, 6)}`;
  const service = adminClient();
  const row = (org: string) => ({ organization_id: org, po_ref: ref, supplier: "Receipt Steel Ltd", total_value: 250, status: "issued", order_date: "2026-10-01", expected_delivery: "2026-10-09" });
  const { data: mine, error } = await service.from("purchase_orders").insert(row(w.tenants.alpha.id)).select("id").single();
  expect(error).toBeNull();
  const { data: theirs } = await service.from("purchase_orders").insert(row(w.tenants.beta.id)).select("id").single();

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/purchase-orders");
  const received = page.getByRole("row").filter({ hasText: ref });
  await received.getByRole("button", { name: "Mark Received" }).click();
  await expect(page.getByText("1 purchase order(s) moved to Received")).toBeVisible();

  const stored = async (id: string) => (await service.from("purchase_orders").select("status, received_at, organization_id").eq("id", id).single()).data!;
  expect(await stored(mine!.id)).toMatchObject({ status: "received", organization_id: w.tenants.alpha.id });
  expect((await stored(mine!.id)).received_at).toBeTruthy();
  expect(await stored(theirs!.id)).toMatchObject({ status: "issued", received_at: null, organization_id: w.tenants.beta.id });

  // After a reload the order is still received: it has left the open list, and shows under Received with the button off.
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: ref })).toHaveCount(0);
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All" }).click();
  const again = page.getByRole("row").filter({ hasText: ref });
  await expect(again).toContainText("received");
  await expect(again.getByRole("button", { name: "Mark Received" })).toBeDisabled();
  expect((await stored(mine!.id)).status).toBe("received");
});
