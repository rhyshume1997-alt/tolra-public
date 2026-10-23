/**
 * The Job Board's Machines dialog against a job booked on the Machine Schedule (live sweep N4-N7): a job whose plan row carries the mill
 * with 0 h (as a converted sales order leaves it) and a 6.5 h booking made on the schedule (save_machine_booking, which does not link the
 * plan row).
 *  - N4: opening the dialog and pressing Cancel sends no write request at all (network assertion) and changes nothing in the database.
 *  - N5: the dialog shows the booking (6.5 h, booked, its start) and the board says "6.5 h (booked)"; saving new hours resizes that booking,
 *    never a second one.
 *  - N6: Start on the mill moves the job from Material to Machining.
 *  - N7: the worksheet shows Machine #1 and Job Time Quoted from the job's machine and booking, without saving them by itself.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

import { type SyntheticWorld, adminClient, signedInClient } from "../support/fixtures";
import { playControl, signIn, world } from "./helpers";

// The world exists only after global setup (CI's `test:e2e:list` collects with none), so it is read in beforeAll, never at import.
let w: SyntheticWorld;
let org = "";
let millName = "";
let jobNo = "";
let jobId = "";
let mill = "";

test.describe.configure({ mode: "serial" });

/** The next working day (Mon-Fri) at least a week ahead, 08:00 local: free on a machine made for this run. */
function startAhead(): string {
  const day = new Date();
  day.setDate(day.getDate() + 7);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1);
  day.setHours(8, 0, 0, 0);
  return day.toISOString();
}

test.beforeAll(async () => {
  w = world();
  org = w.tenants.alpha.id;
  millName = `BD Mill ${w.runId}`;
  jobNo = `J-BD-${w.runId}`;
  // Idempotent: a worker that restarts after a failure runs this again.
  const admin = adminClient();
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  mill = await one("machines", "name", millName, { name: millName });
  jobId = await one("jobs", "job_no", jobNo, { job_no: jobNo, customer: "Board Dialog Co", description: "Converted from SMOKE-BD", stage: "material" });
  // The plan as a converted order leaves it: the mill, 0 h, no booking linked.
  if (!(await admin.from("job_machines").select("id").eq("job_id", jobId).maybeSingle()).data) {
    await admin.from("job_machines").insert({ organization_id: org, job_id: jobId, machine_id: mill, estimated_hours: 0 });
  }
  // A 6.5 h booking made on the Machine Schedule for the job, through the schedule's own function (not linked to the plan row).
  if (!(await admin.from("machine_bookings").select("id").eq("job_id", jobId).maybeSingle()).data) {
    const office = await signedInClient(w.tenants.alpha.users.office);
    const { error } = await office.rpc("save_machine_booking", {
      p_id: null, p_machine: mill, p_job: jobId, p_job_no: jobNo, p_description: "Board dialog", p_start: startAhead(), p_hours: 6.5, p_hours_done: 0,
      p_status: "booked", p_notes: null, p_day_plan: null, p_clear_day_plan: false, p_clash_override: false, p_override_reason: null,
    });
    if (error) throw error;
  }
});

const row = (page: Page) => page.locator(`tr[data-job-id="${jobId}"]`);
const state = async () => {
  const admin = adminClient();
  const [plan, bookings, job] = await Promise.all([
    admin.from("job_machines").select("machine_id, estimated_hours, booking_id").eq("job_id", jobId).order("position"),
    admin.from("machine_bookings").select("id, machine_id, start_at, estimated_hours, status").eq("job_id", jobId).order("id"),
    admin.from("jobs").select("stage, machine_1, job_time_quoted_hr, worksheet_version, updated_at").eq("id", jobId).single(),
  ]);
  return { plan: plan.data, bookings: bookings.data, job: job.data };
};
/**
 * Any request that could write: a POST/PATCH/PUT/DELETE to the data API, storage or the app's own API routes (/api/audit writes the
 * audit trail), or any RPC but the read-only ones the shell and the board call. Sign-in token refreshes (/auth/v1) are not writes.
 */
const READ_RPCS = new Set([
  "machines_in_use", "company_people", "assignable_people", "bench_runs_state", "my_session", "my_organizations", "current_user_organization_id",
  "is_platform_admin", "has_org_role", "job_rework_summary", "job_signoff_revision", "record_activity", "org_activity",
]);
const isWrite = (request: Request) => {
  const url = new URL(request.url());
  const data = url.pathname.includes("/rest/v1/") || url.pathname.includes("/storage/v1/") || url.pathname.startsWith("/api/");
  if (!data || request.method() === "GET" || request.method() === "HEAD" || request.method() === "OPTIONS") return false;
  const rpc = url.pathname.match(/\/rest\/v1\/rpc\/([^/?]+)/)?.[1];
  return !(rpc && READ_RPCS.has(rpc));
};

test("N4: opening the Machines dialog and pressing Cancel writes nothing", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/jobs");
  await expect(row(page).getByTestId("job-machines")).toContainText(millName);
  await page.waitForLoadState("networkidle");
  const before = await state();
  const writes: string[] = [];
  page.on("request", (request) => { if (isWrite(request)) writes.push(`${request.method()} ${request.url()}`); });

  await row(page).getByRole("button", { name: "Machines" }).click();
  const dialog = page.getByRole("dialog", { name: `Machines - ${jobNo}` });
  await expect(dialog.getByLabel("Hours on machine 1")).toHaveValue("6.5");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // Open and close once more with Escape, then let anything pending go out.
  await row(page).getByRole("button", { name: "Machines" }).click();
  await expect(dialog.getByLabel("Hours on machine 1")).toHaveValue("6.5");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.waitForLoadState("networkidle");

  expect(writes).toEqual([]);
  expect(await state()).toEqual(before);
});

test("a failed load keeps Save disabled, shows Retry, and writes nothing; Retry loads the machines", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await expect(row(page).getByTestId("job-machines")).toContainText(millName);
  await page.waitForLoadState("networkidle");
  const before = await state();
  const writes: string[] = [];
  page.on("request", (request) => { if (isWrite(request)) writes.push(`${request.method()} ${request.url()}`); });
  // The dialog's read of the job's plan fails (the board has already loaded its own).
  const fail = (route: import("@playwright/test").Route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom", code: "XX000" }) });
  await page.route(/\/rest\/v1\/job_machines\?/, fail);

  await row(page).getByRole("button", { name: "Machines" }).click();
  const dialog = page.getByRole("dialog", { name: `Machines - ${jobNo}` });
  await expect(dialog.getByTestId("job-machines-load-error")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save machines" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add machine" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Save machines" }).click({ force: true });
  await dialog.getByRole("button", { name: "Retry" }).click(); // Retry while the read still fails: still blocked
  await expect(dialog.getByTestId("job-machines-load-error")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save machines" })).toBeDisabled();
  await page.waitForLoadState("networkidle");
  expect(writes).toEqual([]);
  expect(await state()).toEqual(before);

  await page.unroute(/\/rest\/v1\/job_machines\?/, fail);
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByTestId("job-machines-load-error")).toHaveCount(0);
  await expect(dialog.getByLabel("Hours on machine 1")).toHaveValue("6.5");
  await expect(dialog.getByRole("button", { name: "Save machines" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(writes).toEqual([]);
});

test("N5: the dialog shows the schedule booking; saving resizes it and never books the mill twice", async ({ page }) => {
  const before = await state();
  expect(before.bookings).toHaveLength(1);
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await expect(row(page).getByTestId("job-machines")).toHaveText(`${millName} 6.5 h (booked)`);
  await row(page).getByRole("button", { name: "Machines" }).click();
  const dialog = page.getByRole("dialog", { name: `Machines - ${jobNo}` });
  await expect(dialog.getByLabel("Hours on machine 1")).toHaveValue("6.5");
  await expect(dialog.getByLabel("Book machine 1 on schedule")).toBeChecked();
  await expect(dialog.getByText("Booked on the schedule")).toBeVisible();
  const start = new Date(before.bookings![0].start_at as string);
  const local = new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await expect(dialog.getByLabel("Start on machine 1")).toHaveValue(local);

  // Save with nothing changed: nothing is sent.
  await dialog.getByRole("button", { name: "Save machines" }).click();
  await expect(page.getByText(`No changes to ${jobNo}'s machines.`)).toBeVisible();
  expect(await state()).toEqual(before);

  await row(page).getByRole("button", { name: "Machines" }).click();
  await dialog.getByLabel("Hours on machine 1").fill("7");
  await dialog.getByRole("button", { name: "Save machines" }).click();
  await expect(page.getByText(`Machines saved on ${jobNo}`)).toBeVisible();
  const after = await state();
  expect(after.bookings).toHaveLength(1);
  expect(after.bookings![0]).toMatchObject({ id: before.bookings![0].id, machine_id: mill, estimated_hours: 7, status: "booked", start_at: before.bookings![0].start_at });
  expect(after.plan!.map((p) => [p.machine_id, Number(p.estimated_hours)])).toEqual([[mill, 7]]);
  await expect(row(page).getByTestId("job-machines")).toHaveText(`${millName} 7 h (booked)`);
});

test("N7: the worksheet shows the job's machine and booked hours, and saves them only on Save", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await row(page).getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${jobNo}` });
  await expect(sheet.getByRole("button", { name: "Save Worksheet" })).toBeEnabled();
  await expect(sheet.getByLabel("Machine 1", { exact: true })).toHaveValue(millName);
  await expect(sheet.getByLabel("Job Time Quoted (hr)")).toHaveValue("7");
  await expect(sheet.getByTestId("worksheet-prefill")).toContainText("Machine #1");
  expect((await state()).job).toMatchObject({ machine_1: null, job_time_quoted_hr: null });
  await sheet.getByRole("button", { name: "Save Worksheet" }).click();
  await expect(page.getByText("Worksheet saved")).toBeVisible();
  expect((await state()).job).toMatchObject({ machine_1: millName, job_time_quoted_hr: 7 });
});

test("N6: Start on the mill moves the job from Material to Machining", async ({ page }) => {
  expect((await state()).job!.stage).toBe("material");
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await expect(row(page).getByTestId("job-machines")).toContainText(millName);
  // 049: the free planned mill is preselected in the Machine column; the picker shows the stage Play moves the job to.
  await row(page).getByRole("button", { name: new RegExp(`^Choose where ${jobNo} runs: ${millName}`) }).click();
  const picker = page.locator('[data-testid="machine-picker"]:visible');
  await expect(picker.getByLabel(`Start on ${millName}`)).toBeChecked();
  await expect(picker.getByLabel("Stage after starting")).toHaveValue("machining");
  await page.keyboard.press("Escape");
  await playControl(row(page), jobNo).click();
  await expect(page.getByText(`${jobNo} started on ${millName}.`)).toBeVisible();
  await expect.poll(async () => (await state()).job!.stage).toBe("machining");
  await expect(row(page)).toContainText("Machining");
  // Finish it so later specs see the mill free.
  const workshop = await signedInClient(w.tenants.alpha.users.workshop);
  await workshop.rpc("finish_job", { p_job: jobId, p_client_op_id: crypto.randomUUID(), p_finished_at: new Date().toISOString() });
});
