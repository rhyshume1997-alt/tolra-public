/**
 * Success only for rows the database really changed (audit R7). A record removed (or no longer visible) after the
 * screen loaded is reported, not shown as done; a bulk action that reaches some rows says how many.
 */
import { expect, test } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { playJob, signIn, world } from "./helpers";

const w = world();

test("bulk Finish: a job removed meanwhile isn't counted; the others are finished and the shortfall is said", async ({ page }) => {
  const org = w.tenants.beta.id;
  const kept = `J-R7K-${w.runId}`;
  const gone = `J-R7G-${w.runId}`;
  const { data, error } = await adminClient().from("jobs").insert([kept, gone].map((job_no) => ({ organization_id: org, job_no, customer: "R7 Co" }))).select("id, job_no");
  expect(error).toBeNull();
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/jobs");
  for (const jobNo of [kept, gone]) await page.getByRole("row").filter({ hasText: jobNo }).getByRole("checkbox").check();
  expect((await adminClient().from("jobs").delete().eq("id", data!.find((j) => j.job_no === gone)!.id).select("id")).data).toHaveLength(1);

  await expect(page.getByRole("button", { name: /^Start Selected/ })).toHaveCount(0); // bulk Start was removed; Finish Selected stays
  await page.getByRole("button", { name: /^Finish Selected/ }).click();
  // Bulk Finish asks first, naming the jobs it will finish.
  const confirm = page.getByRole("dialog", { name: "Finish 2 selected jobs?" });
  await expect(confirm.getByTestId("bulk-targets")).toContainText(kept);
  await expect(confirm.getByTestId("bulk-targets")).toContainText(gone);
  await confirm.getByRole("button", { name: "Finish 2 jobs" }).click();
  await expect(page.getByText("2 job(s) finished: Waiting for inspection: 1 of 2 jobs. 1 couldn't be updated (1 was removed, or you no longer have access). Reload the board.")).toBeVisible();
  const finished = (await adminClient().from("jobs").select("finished_at").eq("job_no", kept).single()).data!;
  expect(finished.finished_at).not.toBeNull();
});

test("Start on a job removed meanwhile: an error, not 'Job started'", async ({ page }) => {
  const jobNo = `J-R7S-${w.runId}`;
  const { data } = await adminClient().from("jobs").insert({ organization_id: w.tenants.beta.id, job_no: jobNo, customer: "R7 Co" }).select("id").single();
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/jobs");
  const row = page.getByRole("row").filter({ hasText: jobNo });
  await expect(row).toBeVisible();
  await adminClient().from("jobs").delete().eq("id", data!.id);
  await playJob(page, row, jobNo, { bench: true });
  await expect(page.getByText("The job wasn't updated: removed, or you no longer have access. Reload the board.")).toBeVisible();
  await expect(page.getByText("Job started", { exact: true })).toHaveCount(0);
});

test("Recording a payment on an invoice removed meanwhile: an error, not 'paid'", async ({ page }) => {
  const ref = `INV-R7-${w.runId}`;
  expect((await adminClient().from("invoices").insert({ organization_id: w.tenants.beta.id, invoice_ref: ref, customer: "R7 Co", total: 80, subtotal: 80, vat: 0, vat_enabled: false, amount_paid: 0, status: "sent", due_date: "2099-01-01" })).error).toBeNull();
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/invoices");
  const row = page.getByRole("row").filter({ hasText: ref });
  await row.getByRole("button", { name: "Record payment" }).click();
  // Issued invoices can't be deleted through the API; the database owner removes it (as maintenance would).
  await withDb((db) => db.query("delete from public.invoices where invoice_ref = $1", [ref]));
  await page.getByRole("button", { name: "Save payment" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Invoice not found");
  await expect(page.getByText(/paid in full|recorded on/)).toHaveCount(0);
});
