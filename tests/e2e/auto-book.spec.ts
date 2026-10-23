/**
 * A machine picked on a job goes on the Machine Schedule by itself at its next free slot (migration 061, Rhys 15 Oct): the workshop adds
 * a machine on the Job Board's Machines dialog without ticking "Book on schedule", saves, is told "Booked on the schedule from <time>",
 * and the schedule shows the job's booking on that machine. Its start is the machine's next free time in working hours (a machine made
 * for this run, so nothing else is booked on it).
 */
import { expect, test, type Page } from "@playwright/test";

import { type SyntheticWorld, adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

let w: SyntheticWorld;
let org = "";
let machineName = "";
let jobNo = "";
let jobId = "";
let machine = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  w = world();
  org = w.tenants.alpha.id;
  machineName = `AB Mill ${w.runId}`;
  jobNo = `J-AB-${w.runId}`;
  // Idempotent: a worker that restarts after a failure runs this again.
  const admin = adminClient();
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  machine = await one("machines", "name", machineName, { name: machineName });
  jobId = await one("jobs", "job_no", jobNo, { job_no: jobNo, customer: "Auto Book Co", description: "Auto-book check", stage: "material" });
});

const row = (page: Page) => page.locator(`tr[data-job-id="${jobId}"]`);

test("a machine picked on a job is booked at its next free slot and shows on the schedule", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await row(page).getByRole("button", { name: "Machines" }).click();
  const dialog = page.getByRole("dialog", { name: `Machines - ${jobNo}` });
  await dialog.getByRole("button", { name: "Add machine" }).click();
  await dialog.getByLabel("Machine 1", { exact: true }).selectOption({ label: machineName });
  await dialog.getByLabel("Hours on machine 1").fill("3");
  await expect(dialog.getByLabel("Book machine 1 on schedule")).not.toBeChecked();
  await expect(dialog.getByTestId("auto-book-hint")).toContainText("next free time");
  await dialog.getByRole("button", { name: "Save machines" }).click();
  await expect(page.getByText(`Machines saved on ${jobNo}`)).toBeVisible();
  await expect(page.getByText(new RegExp(`${machineName}: Booked on the schedule from .+ until .+`))).toBeVisible();

  // One booking, linked to the plan row, for the job's hours, starting in the machine's working hours (08:00 to 16:00 UK, Mon-Fri).
  const { data: plan } = await adminClient().from("job_machines").select("machine_id, estimated_hours, booking_id").eq("job_id", jobId);
  expect(plan!.map((p) => [p.machine_id, Number(p.estimated_hours), Boolean(p.booking_id)])).toEqual([[machine, 3, true]]);
  const { data: bookings } = await adminClient().from("machine_bookings").select("id, machine_id, start_at, estimated_hours, status").eq("job_id", jobId);
  expect(bookings).toHaveLength(1);
  expect(bookings![0]).toMatchObject({ id: plan![0].booking_id, machine_id: machine, estimated_hours: 3, status: "booked" });
  const start = new Date(bookings![0].start_at as string);
  const uk = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(start);
  const hour = Number(uk.find((p) => p.type === "hour")!.value);
  expect(["Sat", "Sun"]).not.toContain(uk.find((p) => p.type === "weekday")!.value);
  expect(hour >= 8 && hour < 16).toBe(true);
  expect(start.getTime()).toBeGreaterThanOrEqual(Date.now() - 5 * 60_000);

  // The schedule shows it (two weeks shown, so a slot on the next working day is in view).
  await page.goto("/schedule");
  await page.getByRole("group", { name: "Timeline length" }).getByRole("button", { name: "2 weeks" }).click();
  await expect(page.locator(`button[title^="${jobNo} on ${machineName}"]`).first()).toBeVisible();

  // Saving again with nothing changed books nothing more.
  await page.goto("/jobs");
  await row(page).getByRole("button", { name: "Machines" }).click();
  await page.getByRole("dialog", { name: `Machines - ${jobNo}` }).getByRole("button", { name: "Save machines" }).click();
  await expect(page.getByText(`No changes to ${jobNo}'s machines.`)).toBeVisible();
  expect((await adminClient().from("machine_bookings").select("id").eq("job_id", jobId)).data).toHaveLength(1);
});
