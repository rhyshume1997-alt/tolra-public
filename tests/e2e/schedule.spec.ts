/** Machine schedule: removing a booking takes it off the chart, the table and the dashboard straight away. */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("removing a booking takes it off the machine chart, the list and the dashboard", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const jobNo = `J-BK-${w.runId}`;
  const { data: machine } = await admin.from("machines").insert({ organization_id: org, name: `Mill ${w.runId}` }).select("id").single();
  const start = new Date();
  start.setHours(9, 0, 0, 0);
  await admin.from("machine_bookings").insert({ organization_id: org, machine_id: machine!.id, job_no: jobNo, description: "Booking test", start_at: start.toISOString(), estimated_hours: 4 });
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/schedule");
  const chart = page.locator(`button[title^="${jobNo} on "]`);
  await expect(chart.first()).toBeVisible();
  await chart.first().click();
  await page.getByRole("button", { name: "Remove booking" }).click();
  await expect(page.getByText("Booking removed")).toBeVisible();
  await expect(chart).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: jobNo })).toHaveCount(0);
  expect((await admin.from("machine_bookings").select("id").eq("job_no", jobNo)).data).toEqual([]);
  await page.reload();
  await expect(page.getByText(`Mill ${w.runId}`).first()).toBeVisible();
  await expect(chart).toHaveCount(0);
  await page.goto("/dashboard");
  await expect(page.getByText(jobNo)).toHaveCount(0);
});
