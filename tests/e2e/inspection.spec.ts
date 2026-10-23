/**
 * Inspection evidence and release rules (migration 034, W5; 081: criteria with the measured result), in the browser: a failed
 * inspection holds the job, a pass releases it, only an admin sees the concession choice, and editing the worksheet afterwards sends the job back to
 * awaiting inspection.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);

async function finishedJob(no: string) {
  const { data, error } = await adminClient().from("jobs").insert({
    organization_id: w.tenants.alpha.id, job_no: no, customer: "Inspection Co", description: "Bush", stage: "inspection",
    started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
  }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}
const stored = async (id: string) => (await adminClient().from("jobs").select("stage, inspected_at, inspected_by, worksheet_version").eq("id", id).single()).data!;

test("a failed inspection puts the job into rework; the concession choice is for admins", async ({ page }) => {
  const no = `J-INSP-${tag()}`;
  const id = await finishedJob(no);
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  const row = page.getByRole("row").filter({ hasText: no });
  await row.getByRole("button", { name: "Inspected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await expect(dialog.getByLabel("Concession")).toHaveCount(0);

  await dialog.getByLabel("Fail").check();
  await dialog.getByLabel("Measured notes (required)").fill("Bore 25.08 mm: oversize");
  // The rework details are required: reason and instructions.
  await dialog.getByRole("button", { name: "Record inspection" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Give the reason it failed");
  await dialog.getByLabel("Reason it failed (required)").fill("Bore oversize");
  await dialog.getByRole("button", { name: "Record inspection" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Give the rework instructions");
  await dialog.getByLabel("Rework instructions for the workshop (required)").fill("Re-bore and re-measure");
  // 081: and what it was checked against (objective evidence: criteria and the measured result).
  await dialog.getByRole("button", { name: "Record inspection" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Add the acceptance criteria");
  await dialog.getByLabel("Acceptance criteria (required)").fill("Drawing rev A: bore 25.00 +0.03/-0");
  await dialog.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(`${no} failed inspection`)).toBeVisible();
  expect(await stored(id)).toMatchObject({ stage: "rework", inspected_at: null });

  // It has left the Inspection list for Rework, where the workshop can't release it (only an admin's concession can, before the rework is done).
  await page.getByRole("button", { name: /^Rework \(/ }).click();
  const reworkRow = page.getByRole("row").filter({ hasText: no });
  await expect(reworkRow).toContainText("Rework");
  await expect(reworkRow.getByRole("button", { name: "Inspected", exact: true })).toBeDisabled();
  const records = (await adminClient().from("job_inspections").select("result, organization_id").eq("job_id", id).order("inspected_at")).data;
  expect(records).toEqual([{ result: "fail", organization_id: w.tenants.alpha.id }]);
});

test("a workshop user an admin hasn't made an inspector isn't offered Inspected, and can't record an inspection", async ({ page }) => {
  const no = `J-INSP3-${tag()}`;
  const { data, error } = await adminClient().from("jobs").insert({
    organization_id: w.tenants.beta.id, job_no: no, customer: "Inspection Co", description: "Pin", stage: "inspection",
    started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
  }).select("id").single();
  expect(error).toBeNull();
  await signIn(page, w.tenants.beta.users.workshop);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  const row = page.getByRole("row").filter({ hasText: no });
  await expect(row).toBeVisible();
  // G20: Inspected is offered only while the person's status is unknown (still loading, or offline); once it loads as "not on the
  // inspectors list" it is gone. toHaveCount(0) retries, so this passes only after that load, and never clicks a button that is leaving.
  await expect(row.getByRole("button", { name: "Inspected", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: `Record inspection: ${no}` })).toHaveCount(0);
  expect((await adminClient().from("job_inspections").select("id").eq("job_id", data!.id)).data).toEqual([]);
  expect((await adminClient().from("jobs").select("inspected_at").eq("id", data!.id).single()).data).toEqual({ inspected_at: null });
});

test("editing the worksheet after sign-off sends the job back to awaiting inspection", async ({ page }) => {
  const no = `J-INSP2-${tag()}`;
  const id = await finishedJob(no);
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  const row = page.getByRole("row").filter({ hasText: no });
  await row.getByRole("button", { name: "Inspected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await expect(dialog.getByLabel("Concession")).toBeVisible();
  await dialog.getByLabel("Acceptance criteria (required)").fill("Drawing rev A: all dimensions");
  await dialog.getByLabel("Measured notes (required)").fill("All dimensions in tolerance");
  await dialog.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(/inspected: Complete/)).toBeVisible();

  // Someone changes the quantity afterwards (the worksheet's own save path).
  await page.getByRole("button", { name: /^Complete \(/ }).click();
  const done = page.getByRole("row").filter({ hasText: no });
  await done.getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${no}` });
  await expect(sheet.getByRole("button", { name: "Save Worksheet" })).toBeEnabled();
  await sheet.getByLabel("Quantity Req").fill("11");
  await sheet.getByRole("button", { name: "Save Worksheet" }).click();
  await expect(page.getByText("Worksheet saved")).toBeVisible();
  await expect.poll(async () => (await stored(id)).inspected_at).toBeNull();
  expect(await stored(id)).toMatchObject({ stage: "inspection", inspected_by: null });
});
