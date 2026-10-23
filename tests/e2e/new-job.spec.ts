/**
 * "New job" on the Job Board (migration 042): customer and internal jobs made directly on the board, the Internal tag and Type filter,
 * the related-job link both ways (scroll and highlight), machine bookings from the time estimate with the clash warning and the admin's
 * override, who sees the button, and the offline message.
 */
import { type Page, expect, test } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

// The world exists only after global setup (CI's `test:e2e:list` collects with none), so run-specific values are set in
// beforeAll, never at import.
const w = world();
let org = "";
let customer = "";
let millName = "";
let mill = "";
let relatedJob = "";
let relatedNo = "";
let clashNo = "";
let internalNo = "";
// The clashing booking: a weekday at least a week from now, 09:00 local, for 4 hours. It must stay clear of the mill's next free
// slot (the default start in the workshop test), which is at most the next working day's 08:00 (Monday from Friday evening or the
// weekend). "Two days from now" put it on Monday 09:00 when run on a Saturday, over that default start: a wall-clock-dependent clash.
const clashStart = new Date();
clashStart.setDate(clashStart.getDate() + 7);
while (clashStart.getDay() === 0 || clashStart.getDay() === 6) clashStart.setDate(clashStart.getDate() + 1);
clashStart.setHours(9, 0, 0, 0);
const localInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  customer = `NJ Customer ${w.runId}`;
  millName = `NJ Mill ${w.runId}`;
  relatedNo = `J-NJREL-${w.runId}`;
  clashNo = `J-NJCL-${w.runId}`;
  internalNo = `J-NJIN-${w.runId}`;
  // Idempotent: a worker that restarts after a failure runs this again.
  const admin = adminClient();
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  await one("customers", "name", customer, { name: customer });
  mill = await one("machines", "name", millName, { name: millName });
  relatedJob = await one("jobs", "job_no", relatedNo, { job_no: relatedNo, customer, description: "Housing" });
  await one("jobs", "job_no", internalNo, { job_no: internalNo, customer: null, description: "Tooling", is_internal: true });
  await one("machine_bookings", "job_no", clashNo, { machine_id: mill, job_no: clashNo, description: "Clash", start_at: clashStart.toISOString(), estimated_hours: 4 });
});

async function openNewJob(page: Page) {
  await page.goto("/jobs");
  await page.getByRole("button", { name: "New job" }).click();
  return page.getByRole("dialog", { name: "New job" });
}
async function createdNo(page: Page) {
  const toastText = await page.getByText(/^J-\d+ created$/).first().textContent();
  return toastText!.replace(" created", "");
}

test("an admin creates an internal job related to another job: tagged Internal, filtered, linked both ways", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  const dialog = await openNewJob(page);
  await dialog.getByLabel(/Internal job/).check();
  await dialog.getByLabel("Description").fill(`Soft jaws ${w.runId}`);
  await dialog.getByLabel("Related job (optional)").selectOption(relatedJob);
  await dialog.getByRole("button", { name: "Create job" }).click();
  const jobNo = await createdNo(page);
  const { data: row } = await adminClient().from("jobs").select("id, customer, is_internal, related_job_id, customer_po").eq("organization_id", org).eq("job_no", jobNo).single();
  expect(row).toMatchObject({ customer: null, is_internal: true, related_job_id: relatedJob, customer_po: null });

  // The new row is found and highlighted, with the Internal tag and "Internal" in place of a customer.
  const mine = page.locator(`tr[data-job-id="${row!.id}"]`);
  await expect(mine).toHaveAttribute("data-highlighted", "true");
  await expect(mine.getByTestId("internal-badge")).toBeVisible();
  await expect(mine.getByRole("cell", { name: "Internal", exact: true })).toBeVisible();

  // Type filter.
  await page.getByRole("group", { name: "Job type" }).getByRole("button", { name: /^Internal/ }).click();
  await expect(mine).toBeVisible();
  await expect(page.locator(`tr[data-job-id="${relatedJob}"]`)).toHaveCount(0);
  await page.getByRole("group", { name: "Job type" }).getByRole("button", { name: "Customer" }).click();
  await expect(mine).toHaveCount(0);

  // Forward link: clears the filters (Show all) and highlights the related job; the back link returns.
  await page.getByRole("group", { name: "Job type" }).getByRole("button", { name: /^Internal/ }).click();
  await mine.getByTestId("related-to").getByRole("button", { name: relatedNo }).click();
  const target = page.locator(`tr[data-job-id="${relatedJob}"]`);
  await expect(target).toHaveAttribute("data-highlighted", "true");
  await expect(page.getByRole("button", { name: "All", exact: true }).first()).toHaveAttribute("aria-pressed", "true");
  await expect(target).toBeInViewport();
  await target.getByTestId("related-from").getByRole("button", { name: jobNo }).click();
  await expect(mine).toHaveAttribute("data-highlighted", "true");
});

test("the workshop creates an internal job with a machine: the estimate books the machine", async ({ page }) => {
  // The workshop can't read the customer list (customers are admin/office only), so its New job is an internal one; the
  // customer-job path is covered by the admin clash test below.
  await signIn(page, w.tenants.alpha.users.workshop);
  const dialog = await openNewJob(page);
  await expect(dialog.getByRole("button", { name: "Create job" })).toBeDisabled();
  await expect(dialog.getByText(/The customer list is kept by the office/)).toBeVisible();
  await dialog.getByLabel(/Internal job/).check();
  await dialog.getByLabel("Description").fill(`Shafts ${w.runId}`);
  await dialog.getByRole("button", { name: "Add machine" }).click();
  await dialog.getByLabel("Machine 1", { exact: true }).selectOption({ label: millName });
  await dialog.getByLabel("Hours on machine 1").fill("3");
  await expect(dialog.getByText(/Finishes about/)).toBeVisible();
  await expect(dialog.getByTestId("new-job-clash")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create job" }).click();
  const jobNo = await createdNo(page);
  const admin = adminClient();
  const { data: job } = await admin.from("jobs").select("id, customer, is_internal").eq("organization_id", org).eq("job_no", jobNo).single();
  expect(job).toMatchObject({ customer: null, is_internal: true });
  const { data: links } = await admin.from("job_machines").select("machine_id, estimated_hours, booking_id").eq("job_id", job!.id);
  expect(links!.map((l) => [l.machine_id, Number(l.estimated_hours)])).toEqual([[mill, 3]]);
  const { data: booking } = await admin.from("machine_bookings").select("job_id, job_no, estimated_hours").eq("id", links![0].booking_id).single();
  expect(booking).toMatchObject({ job_id: job!.id, job_no: jobNo });
  await expect(page.locator(`tr[data-job-id="${job!.id}"]`).getByTestId("internal-badge")).toHaveCount(1);
});

async function fillClash(page: Page) {
    const dialog = await openNewJob(page);
    await dialog.locator("select").first().selectOption({ label: customer });
    await dialog.getByLabel("Description").fill(`Clash ${w.runId}`);
    await dialog.getByRole("button", { name: "Add machine" }).click();
    await dialog.getByLabel("Machine 1", { exact: true }).selectOption({ label: millName });
    await dialog.getByLabel("Hours on machine 1").fill("2");
    await dialog.getByLabel("Start on machine 1").fill(localInput(clashStart));
    await expect(dialog.getByTestId("new-job-clash")).toContainText(clashNo);
    return dialog;
}

test("a clash: office must pick a free time", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  const dialog = await fillClash(page);
  await expect(dialog.getByText("Only an admin can book over another job.")).toBeVisible();
  await expect(dialog.getByLabel(/Book anyway/)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Create job" })).toBeDisabled();
});

test("a clash: an admin can book anyway, which is recorded", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  const dialog = await fillClash(page);
  await expect(dialog.getByRole("button", { name: "Create job" })).toBeDisabled();
  await dialog.getByLabel(/Book anyway/).check();
  // Still blocked until a reason is given (the database asks for one too).
  await expect(dialog.getByRole("button", { name: "Create job" })).toBeDisabled();
  await dialog.getByTestId("override-reason").fill("Customer waiting on this part");
  await dialog.getByRole("button", { name: "Create job" }).click();
  const jobNo = await createdNo(page);
  const { data: job } = await adminClient().from("jobs").select("id").eq("organization_id", org).eq("job_no", jobNo).single();
  const audit = await withDb((db) => db.query("select metadata from security_audit.audit_log where action = 'OVERRIDE_MACHINE_CLASH' and entity_id = $1", [job!.id]));
  expect(audit.rows.map((r) => r.metadata.clashing_job_nos)).toEqual([[clashNo]]);
  expect(audit.rows[0].metadata).toMatchObject({ reason: "Customer waiting on this part", actor_user_id: w.tenants.alpha.users.admin.id });
  expect(audit.rows[0].metadata.conflicts).toHaveLength(1);
});

test("the viewer has no New job button", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.viewer);
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New job" })).toHaveCount(0);
});

test("offline: creating a job says it needs a connection", async ({ page, context }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await expect(page.getByRole("button", { name: "New job" })).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByRole("button", { name: "New job" }).click();
    const dialog = page.getByRole("dialog", { name: "New job" });
    await expect(dialog.getByTestId("new-job-offline")).toContainText("needs a connection");
    await expect(dialog.getByRole("button", { name: "Create job" })).toBeDisabled();
    await expect(dialog.getByTestId("new-job-offline").getByRole("button", { name: "Retry" })).toBeVisible();
    // Back online without reopening: the `online` event reloads the machines and clears the offline mark (audit #8).
    await dialog.getByLabel("Description").fill("Reconnect test part");
    await context.setOffline(false);
    await expect(dialog.getByTestId("new-job-offline")).toHaveCount(0);
    await expect(dialog.getByLabel("Description")).toHaveValue("Reconnect test part"); // the form is kept
    await dialog.getByLabel(/Internal job/).check();
    await expect(dialog.getByRole("button", { name: "Create job" })).toBeEnabled();
  } finally {
    await context.setOffline(false);
  }
});

test("a manual delivery note typed with an internal job's number is refused with a clear message", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/delivery-notes");
  await page.getByRole("button", { name: "New delivery note" }).click();
  const dialog = page.getByRole("dialog", { name: "New Delivery Note" });
  await dialog.getByRole("button", { name: "Without an order" }).click();
  // The job is picked from the company's jobs (the list shows an internal job too; the database refuses it on save).
  await dialog.getByLabel("Search by number or customer").fill(internalNo);
  await dialog.locator("select[name=job]").selectOption(internalNo);
  await dialog.locator("select[name=customer]").selectOption({ label: customer });
  await dialog.getByPlaceholder(/Items, one per line/).fill("Spacer x 1");
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(page.getByText(new RegExp(`Job ${internalNo} is internal`))).toBeVisible();
  expect((await adminClient().from("delivery_notes").select("id").eq("organization_id", org).eq("job_ref", internalNo)).data).toEqual([]);
});
