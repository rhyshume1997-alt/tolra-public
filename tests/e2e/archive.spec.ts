/**
 * Open / Done / Archived (migration 028): finished records leave the default list; done and older than the company's
 * setting moves to Archived; admin/office archive and unarchive by hand; nothing is deleted.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("sales orders: open by default, closed ones in Done, old closed ones Archived; manual archive and unarchive", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const tag = w.runId.slice(0, 6);
  const longAgo = new Date(Date.now() - 2 * 365 * 86_400_000).toISOString().slice(0, 10);
  await admin.from("sales_orders").insert([
    { organization_id: org, so_number: `SO-OPEN-${tag}`, customer: "Arc Co", status: "open" },
    { organization_id: org, so_number: `SO-DONE-${tag}`, customer: "Arc Co", status: "closed" },
    { organization_id: org, so_number: `SO-OLD-${tag}`, customer: "Arc Co", status: "closed", order_date: longAgo, delivery_date: longAgo },
  ]);
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/sales-orders");
  const ref = (r: string) => page.getByText(`SO-${r}-${tag}`, { exact: true });
  await expect(ref("OPEN")).toBeVisible();
  await expect(ref("DONE")).toHaveCount(0);
  await expect(ref("OLD")).toHaveCount(0);
  await page.getByRole("button", { name: /^Done \(/ }).click();
  await expect(ref("DONE")).toBeVisible();
  await expect(ref("OLD")).toHaveCount(0);
  await page.getByRole("button", { name: /^Archived \(/ }).click();
  await expect(ref("OLD")).toBeVisible();

  await page.getByRole("button", { name: /^Open \(/ }).click();
  await page.getByRole("row").filter({ hasText: `SO-OPEN-${tag}` }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText(/Archived \(nothing is deleted/)).toBeVisible();
  await expect(ref("OPEN")).toHaveCount(0);
  await page.getByRole("button", { name: /^Archived \(/ }).click();
  await page.getByRole("row").filter({ hasText: `SO-OPEN-${tag}` }).getByRole("button", { name: "Unarchive" }).click();
  await expect(ref("OPEN")).toHaveCount(0);
  await page.getByRole("button", { name: /^Open \(/ }).click();
  await expect(ref("OPEN")).toBeVisible();
  // Nothing deleted, records unchanged.
  expect((await admin.from("sales_orders").select("so_number").like("so_number", `SO-%-${tag}`)).data).toHaveLength(3);
});

test("archive overrides: all of them load past one page, and a failed load says so with Retry (L6)", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.beta.id;
  const tag = w.runId.slice(0, 6);
  const { data: order } = await admin.from("sales_orders").insert({ organization_id: org, so_number: `SO-L6-${tag}`, customer: "Page Co", status: "open" }).select("id").single();
  // 1,200 overrides that sort before the real one: a single request (max 1,000 rows) would never reach it.
  const filler = Array.from({ length: 1200 }, (_, i) => ({ organization_id: org, record_table: "sales_orders", record_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, state: "archived" }));
  expect((await admin.from("record_archive_state").upsert(filler)).error).toBeNull();
  expect((await admin.from("record_archive_state").upsert({ organization_id: org, record_table: "sales_orders", record_id: order!.id, state: "archived" })).error).toBeNull();
  try {
    await signIn(page, w.tenants.beta.users.admin);
    // First load fails: said, with Retry; nothing claims the list is right.
    await page.route("**/rest/v1/record_archive_state*", (route) => route.abort("connectionreset"));
    await page.goto("/sales-orders");
    const warning = page.getByText(/Can't reach the server|archived by hand/);
    await expect(warning).toBeVisible();
    await page.unroute("**/rest/v1/record_archive_state*");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    // The manual archive past the first 1,000 overrides is honoured.
    await expect(page.getByText(`SO-L6-${tag}`, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /^Archived \(/ }).click();
    await expect(page.getByText(`SO-L6-${tag}`, { exact: true })).toBeVisible();
  } finally {
    await admin.from("record_archive_state").delete().eq("organization_id", org).like("record_id", "00000000-0000-4000-8000-%");
  }
});
