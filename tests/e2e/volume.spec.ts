/**
 * More jobs than one API request returns (audit B6: D10): the job board counts all of them.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("the job board shows every open job beyond the 1,000-row API cap", async ({ page }) => {
  test.setTimeout(180_000);
  const org = w.tenants.alpha.id;
  for (let start = 0; start < 1_200; start += 400) {
    const { error } = await adminClient().from("jobs").insert(Array.from({ length: 400 }, (_, i) => ({ organization_id: org, job_no: `J-VOL-${w.runId}-${start + i}`, customer: "Volume Co" })));
    expect(error).toBeNull();
  }
  const { count } = await adminClient().from("jobs").select("id", { count: "exact", head: true }).eq("organization_id", org).or("stage.eq.rework,inspected_at.is.null"); // Open: Not started + Running + Waiting for inspection
  expect(count).toBeGreaterThan(1_200);

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await expect(page.getByRole("button", { name: /Open jobs/ }).or(page.getByText("Open jobs").locator("..")).first()).toContainText(String(count), { timeout: 60_000 });
});
