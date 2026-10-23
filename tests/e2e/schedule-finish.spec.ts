/**
 * Machine schedule (backlog B31): a booking whose job was finished on the Job Board no longer reads "Booked", on the schedule or in the
 * Job Board's machine cell.
 *  1. A job never played on a machine: finish_job has no open run to end, the stored booking stays "booked", the schedule derives Complete.
 * Finished work is off the chart and the table until "Show finished" is ticked, which shows it as Complete.
 *  2. A job played on the machine and finished: the run completes the booking; the board cell says "(done)", not "(booked)".
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { confirmFinish, playJob, signIn, world } from "./helpers";

const w = world();

test("finishing a job takes its booking off 'Booked' on the schedule and the board", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const machineName = `Finish Mill ${w.runId}`;
  const { data: machine } = await admin.from("machines").insert({ organization_id: org, name: machineName }).select("id").single();
  const start = new Date();
  start.setHours(9, 0, 0, 0);

  // 1. Finished without ever running on the machine.
  const jobNo = `J-FB-${w.runId}`;
  const { data: job } = await admin.from("jobs").insert({ organization_id: org, job_no: jobNo, customer: "Finish Co", description: "Finish unbook", started_at: new Date().toISOString() }).select("id").single();
  await admin.from("machine_bookings").insert({ organization_id: org, machine_id: machine!.id, job_id: job!.id, job_no: jobNo, description: "Finish unbook", start_at: start.toISOString(), estimated_hours: 4 });
  // 2. Played on the machine, then finished.
  const jobNo2 = `J-FR-${w.runId}`;
  const { data: job2 } = await admin.from("jobs").insert({ organization_id: org, job_no: jobNo2, customer: "Finish Co", description: "Finish run" }).select("id").single();
  await admin.from("job_machines").insert({ organization_id: org, job_id: job2!.id, machine_id: machine!.id, estimated_hours: 1 });
  const later = new Date(start.getTime() + 6 * 3600_000);
  await admin.from("machine_bookings").insert({ organization_id: org, machine_id: machine!.id, job_id: job2!.id, job_no: jobNo2, description: "Finish run", start_at: later.toISOString(), estimated_hours: 1 });

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/schedule");
  await expect(page.getByRole("row").filter({ hasText: jobNo })).toContainText("Booked");

  await page.goto("/jobs");
  await confirmFinish(page, page.locator(`tr[data-job-id="${job!.id}"]`).getByRole("button", { name: "Finish", exact: true }));
  await expect(page.getByText(/Job finished/)).toBeVisible();

  const row2 = page.locator(`tr[data-job-id="${job2!.id}"]`);
  await expect(row2.getByTestId("job-machines")).toContainText("(booked)");
  await playJob(page, row2, jobNo2, { machines: [machineName] });
  await confirmFinish(page, row2.getByRole("button", { name: "Finish", exact: true }));
  // A finished job is Waiting for inspection (still Open); the status tile narrows the board to it (views.spec does the same).
  await expect(page.getByText("Job finished: Waiting for inspection").last()).toBeVisible(); 
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await expect(row2.getByTestId("job-machines")).toContainText(machineName);
  await expect(row2.getByTestId("job-machines")).not.toContainText("(booked)");
  await expect(row2.getByTestId("job-machines")).toContainText("(done)");

  await page.goto("/schedule");
  for (const no of [jobNo, jobNo2]) await expect(page.getByRole("row").filter({ hasText: no })).toHaveCount(0);
  await page.getByLabel(/^Show finished/).check();
  for (const no of [jobNo, jobNo2]) {
    const tableRow = page.getByRole("row").filter({ hasText: no });
    await expect(tableRow).toContainText("Complete");
    await expect(tableRow).not.toContainText("Booked");
  }
  await page.reload(); // remembered in this browser
  await expect(page.getByLabel(/^Show finished/)).toBeChecked();
});
