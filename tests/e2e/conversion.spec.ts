/**
 * Sales order -> job through the browser (audit B2): one click makes one job; afterwards the order can't be
 * converted again, even once despatched.
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("convert an order to its job once; despatched later, it still can't make a second job", async ({ page }) => {
  const ref = `PO-E2E-${w.runId}`;
  const { data: order, error } = await adminClient().from("sales_orders").insert({
    organization_id: w.tenants.alpha.id, so_number: ref, customer_po: ref, customer: "E2E Conversion Co", total_value: 480, status: "open", order_date: "2026-10-09",
  }).select("id").single();
  expect(error).toBeNull();

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/sales-orders");
  const row = page.getByRole("row").filter({ hasText: ref });
  await row.getByRole("button", { name: "Convert to Job" }).click();
  await page.waitForURL(/\/jobs\?job=/);
  const jobId = new URL(page.url()).searchParams.get("job")!;

  const { data: jobs } = await adminClient().from("jobs").select("id, drawings").eq("converted_from_sales_order_id", order!.id);
  expect(jobs).toEqual([{ id: jobId, drawings: [] }]);
  // The link names the job it made, and the board scrolls to and highlights it.
  await expect(page.locator(`[data-job-id="${jobId}"][data-highlighted="true"]:visible`).first()).toBeVisible();

  await page.goto("/sales-orders");
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }).click(); // converted orders move to Done
  await expect(page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "Despatch", exact: true })).toHaveCount(0); // and Despatch: the job carries it on
  await expect(page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "Convert to Job" })).toHaveCount(0); // hidden once converted
  await adminClient().from("sales_orders").update({ status: "despatched" }).eq("id", order!.id);
  await page.reload();
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }).click(); // converted orders move to Done
  await expect(page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "Despatch", exact: true })).toHaveCount(0); // and Despatch: the job carries it on
  await expect(page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "Convert to Job" })).toHaveCount(0); // hidden once converted
  const { count } = await adminClient().from("jobs").select("id", { count: "exact", head: true }).eq("converted_from_sales_order_id", order!.id);
  expect(count).toBe(1);
});

test("a converted order's Edit is disabled with its reason, and the database refuses a change of its value (088)", async ({ page }) => {
  const ref = `PO-E2E-088-${w.runId}`;
  const { data: order, error } = await adminClient().from("sales_orders").insert({
    organization_id: w.tenants.alpha.id, so_number: ref, customer_po: ref, customer: "E2E Conversion Co", total_value: 480, status: "open", order_date: "2026-10-09",
  }).select("id").single();
  expect(error).toBeNull();

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/sales-orders");
  const row = page.getByRole("row").filter({ hasText: ref });
  await expect(row.getByRole("button", { name: "Edit" })).toBeEnabled(); // not converted yet: editable
  await row.getByRole("button", { name: "Convert to Job" }).click();
  await page.waitForURL(/\/jobs\?job=/);
  const { data: job } = await adminClient().from("jobs").select("job_no").eq("converted_from_sales_order_id", order!.id).single();
  const reason = `Converted to ${job!.job_no}: change the job, not the order.`;

  await page.goto("/sales-orders");
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }).click(); // converted orders move to Done
  const converted = page.getByRole("row").filter({ hasText: ref });
  await expect(converted.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(converted.getByTestId("so-edit-blocked-row")).toHaveAttribute("title", reason);
  await converted.getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog").getByTestId("so-edit-blocked")).toHaveText(reason);

  // A plain API write of the value is refused by the database too (088), with the same sentence; the order keeps its value.
  const office = await signedInClient(w.tenants.alpha.users.office);
  const { error: refused } = await office.from("sales_orders").update({ total_value: 999 }).eq("id", order!.id);
  expect(refused).toMatchObject({ code: "42501", hint: "sales_order_converted", message: reason });
  expect((await adminClient().from("sales_orders").select("total_value").eq("id", order!.id).single()).data!.total_value).toBe(480);
});
