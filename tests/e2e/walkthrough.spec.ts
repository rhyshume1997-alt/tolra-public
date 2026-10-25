/**
 * Acceptance walkthrough of the issues Rhys reported on the preview, done the way staff do them: every action through
 * the screen (data set-up only where staff would already have records). Set WALKTHROUGH_SHOTS=<dir> to save a
 * screenshot after each step for review.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { confirmFinish, confirmSend, playJob, signIn, world } from "./helpers";

const w = world();
const SHOTS = process.env.WALKTHROUGH_SHOTS;
let shotNo = 0;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  shotNo += 1;
  // Let animations (dialogs, toasts) finish before the picture, rather than waiting a fixed time.
  await expect.poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 5000 }).toBe(0);
  await page.screenshot({ path: `${SHOTS}/${String(shotNo).padStart(2, "0")}-${name}.png` });
}
const tag = () => w.runId.slice(0, 6);
const in7Days = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("1. Job Board: start and finish a job - it moves, with a traffic light; then inspection; hours/days", async ({ page }) => {
  const late = `J-WALK-LATE-${tag()}`, job = `J-WALK-${tag()}`;
  // "Average job time" is a figure over every finished job in the company, so this test works in a company of its own: other
  // specs finish jobs in the shared test companies and would change it.
  const solo = await createSoloTenant(w.runId, `walk-${randomUUID().slice(0, 6)}`);
  await adminClient().from("jobs").insert([
    { organization_id: solo.id, job_no: job, customer: "Walk Co", description: "Bracket", due_date: in7Days(), date_required: in7Days() },
    { organization_id: solo.id, job_no: late, customer: "Walk Co", description: "Late shaft", due_date: "2026-01-05", date_required: "2026-01-05" },
  ]);
  await signIn(page, solo.admin);
  await page.goto("/jobs");
  const row = (no: string) => page.getByRole("row").filter({ hasText: no });
  await expect(row(job)).toContainText("On time");
  await expect(row(late)).toContainText("Overdue");
  await shot(page, "jobs-traffic-lights");

  await playJob(page, row(job), job, { bench: true });
  await expect(row(job)).toContainText("On the bench");
  await shot(page, "jobs-started-in-progress");

  await confirmFinish(page, row(job).getByRole("button", { name: "Finish", exact: true }));
  await expect(page.getByText("Job finished: Waiting for inspection")).toBeVisible();
  // Open includes Waiting for inspection (Rhys, Wed 21 Oct): the finished job stays on the Open board with that status.
  await expect(row(job).getByTestId("job-status").first()).toContainText("Waiting for inspection");
  await shot(page, "jobs-finished-moved-off-active");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await expect(row(job)).toContainText("Waiting for inspection");
  await shot(page, "jobs-in-inspection");

  await row(job).getByRole("button", { name: "Inspected", exact: true }).click();
  const inspection = page.getByRole("dialog", { name: /Record inspection/ });
  await inspection.getByLabel("Acceptance criteria (required)").fill("Drawing: length 60.00 +/-0.1, bore 25.00 +0.03/-0");
  await inspection.getByLabel("Measured notes (required)").fill("Length 60.00 mm, bore 25.01 mm");
  // 081: the admin finished it, so the pass is recorded with the admin's reason (not independent, internal only).
  await inspection.getByLabel(/Reason you are inspecting it yourself/).fill("Walkthrough: sole inspector on site");
  await inspection.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(/inspected: Complete/)).toBeVisible();
  await page.getByRole("button", { name: /^Complete \(/ }).click();
  await expect(row(job)).toContainText("Complete");
  await shot(page, "jobs-inspected-done");

  // Seconds-long test job: the Hours / Days toggle is honoured even for a short average. A multi-day job switches between them too.
  await expect(page.getByText("<0.1 d")).toBeVisible();
  await page.getByRole("button", { name: "Hours", exact: true }).click();
  await expect(page.getByText(/^0\.\d h$/)).toBeVisible();
  await page.getByRole("button", { name: "Days", exact: true }).click();
  await adminClient().from("jobs").update({ started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-03T08:00:00Z" }).eq("organization_id", solo.id).eq("job_no", job);
  await page.reload();
  await page.getByRole("button", { name: /^Complete \(/ }).click();
  await page.getByRole("button", { name: "Hours", exact: true }).click();
  await expect(page.getByText("48.0 h")).toBeVisible();
  await shot(page, "jobs-average-time-hours");
  await page.getByRole("button", { name: "Days", exact: true }).click();
  await expect(page.getByText("2.0 d")).toBeVisible();
});

test("2. Quotes: send a quote - it leaves Drafts for Sent; a past-dated draft can't be sent", async ({ page }) => {
  const customer = `Walk Quote Co ${tag()}`;
  await adminClient().from("customers").insert({ organization_id: w.tenants.beta.id, name: customer, email: `walk.${tag()}@example.test` });
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/quotes");
  await page.getByRole("button", { name: "New quote" }).first().click();
  const builder = page.getByRole("dialog", { name: "Quote Builder" });
  await builder.getByRole("combobox").first().selectOption({ label: customer });
  await builder.getByLabel("Valid until").fill(in7Days());
  await builder.getByRole("textbox", { name: "Quote description" }).fill("Walkthrough brackets");
  await builder.getByRole("textbox", { name: "Description", exact: true }).fill("Bracket");
  await builder.getByRole("spinbutton", { name: "Unit price" }).fill("100");
  await builder.getByRole("button", { name: "Save Quote" }).click();
  await expect(builder).toBeHidden();
  const drafts = page.getByRole("region", { name: "Draft quotes" });
  const sent = page.getByRole("region", { name: "Sent quotes" });
  const card = (region: typeof drafts) => region.locator('[data-slot="card"]', { hasText: customer });
  await expect(card(drafts)).toBeVisible();
  await shot(page, "quotes-new-in-drafts");

  const download = page.waitForEvent("download");
  await card(drafts).getByRole("button", { name: "Send", exact: true }).click();
  await confirmSend(page);
  await download;
  const confirm = page.getByRole("dialog", { name: /gone to the customer\?/ });
  await shot(page, "quotes-send-confirm");
  await confirm.getByRole("button", { name: /sent it/ }).click();
  await expect(page.getByText(/moved from Drafts to Sent/)).toBeVisible();
  await expect(card(drafts)).toHaveCount(0);
  await expect(card(sent)).toBeVisible();
  await expect(card(sent).getByRole("button", { name: "Resend" })).toBeVisible();
  await shot(page, "quotes-moved-to-sent");

  // A draft whose valid-until date has already passed.
  await page.getByRole("button", { name: "New quote" }).first().click();
  await builder.getByRole("combobox").first().selectOption({ label: customer });
  await builder.getByLabel("Valid until").fill("2026-01-01");
  await builder.getByRole("textbox", { name: "Description", exact: true }).fill("Old bracket");
  await builder.getByRole("spinbutton", { name: "Unit price" }).fill("50");
  await builder.getByRole("button", { name: "Save Quote" }).click();
  await expect(builder).toBeHidden();
  // Past its date and not decided: Expired (go-live polish 19b), under Done; still a draft underneath, so it can't be sent until edited.
  await page.getByRole("button", { name: /^Done \(/ }).click();
  const old = page.getByRole("region", { name: "Expired quotes" }).locator('[data-slot="card"]', { hasText: "Date has passed" });
  await expect(old).toBeVisible();
  await old.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/which has passed\. Edit the quote and set a new date before sending/)).toBeVisible();
  await shot(page, "quotes-past-date-blocked");
});

test("3. RFQ: quote it and send the quote - the RFQ moves from Outstanding to Quoted", async ({ page }) => {
  const customer = `Walk RFQ Co ${tag()}`;
  await adminClient().from("customers").insert({ organization_id: w.tenants.beta.id, name: customer, email: `rfq.${tag()}@example.test` });
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/rfq");
  await page.getByRole("button", { name: /New RFQ/ }).first().click();
  const create = page.getByRole("dialog", { name: "Create New RFQ" });
  await create.getByRole("textbox", { name: "Customer" }).fill(customer);
  await create.getByRole("textbox", { name: "Description" }).fill("Walkthrough flanges x20");
  await create.getByRole("button", { name: "Save RFQ" }).click();
  await expect(create).toBeHidden();
  const rfqCard = () => page.locator('[data-slot="card"]', { hasText: customer });
  await expect(rfqCard()).toContainText("Outstanding");
  await shot(page, "rfq-outstanding");

  await rfqCard().getByRole("link", { name: "Quote" }).click();
  const builder = page.getByRole("dialog", { name: /Quote Builder: RFQ from/ });
  await expect(builder.getByRole("textbox", { name: "Quote description" })).toHaveValue("Walkthrough flanges x20");
  await builder.getByLabel("Valid until").fill(in7Days());
  await builder.getByRole("textbox", { name: "Description", exact: true }).fill("Flange");
  await builder.getByRole("spinbutton", { name: "Unit price" }).fill("25");
  await shot(page, "rfq-builder-prefilled");
  await builder.getByRole("button", { name: "Save Quote" }).click();
  await expect(builder).toBeHidden();

  const quoteCard = page.getByRole("region", { name: "Draft quotes" }).locator('[data-slot="card"]', { hasText: customer });
  const download = page.waitForEvent("download");
  await quoteCard.getByRole("button", { name: "Send", exact: true }).click();
  await confirmSend(page);
  await download;
  await page.getByRole("dialog", { name: /gone to the customer\?/ }).getByRole("button", { name: /sent it/ }).click();
  await expect(page.getByText(/moved from Drafts to Sent/)).toBeVisible();

  await page.goto("/rfq");
  await expect(rfqCard()).toHaveCount(0);
  await page.getByRole("button", { name: /^Quoted \(/ }).click();
  await expect(rfqCard()).toContainText("Quoted, awaiting reply");
  await shot(page, "rfq-moved-to-quoted");
});

test("4. Machine schedule: add a booking, remove it - it comes off the chart", async ({ page }) => {
  const machine = `Walk Mill ${tag()}`;
  const jobNo = `J-WBK-${tag()}`;
  // A Monday at 15:54, six minutes before the machine closes: the booking starts in the last sliver of the day and finishes
  // on Tuesday. Fixed, so the bar is the same however late in the day the suite runs.
  await page.clock.install({ time: new Date(2026, 9, 12, 15, 54) });
  await adminClient().from("machines").insert({ organization_id: w.tenants.beta.id, name: machine });
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/schedule");
  await page.getByRole("button", { name: "New booking" }).first().click();
  const book = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: /Book job|Book anyway/ }) });
  await book.getByLabel("Job").selectOption({ index: 0 });
  await book.getByPlaceholder("Job number").fill(jobNo);
  await book.getByLabel("Machine").selectOption({ label: machine });
  await book.getByLabel(/Estimated hours/).fill("4");
  await book.getByRole("button", { name: /Book job|Book anyway/ }).click();
  await expect(page.getByText("Job booked onto machine")).toBeVisible();
  const bar = page.locator(`button[title^="${jobNo} on "]`);
  await expect(bar.first()).toBeVisible();
  await shot(page, "schedule-booked");

  await bar.first().click();
  await page.getByRole("button", { name: "Remove booking" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Remove this booking? This can't be undone." })).toBeVisible();
  await page.getByRole("button", { name: "Yes, remove booking" }).click();
  await expect(page.getByText("Booking removed")).toBeVisible();
  await expect(bar).toHaveCount(0);
  await shot(page, "schedule-removed");
  await page.reload();
  await expect(page.getByText(machine).first()).toBeVisible();
  await expect(bar).toHaveCount(0);
});

test("5. Sales order: convert it - it moves out of Open into Done", async ({ page }) => {
  const ref = `SO-WALK-${tag()}`;
  await adminClient().from("sales_orders").insert({ organization_id: w.tenants.beta.id, so_number: ref, customer: "Walk Co", status: "open", order_date: new Date().toISOString().slice(0, 10) });
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/sales-orders");
  const row = () => page.getByRole("row").filter({ hasText: ref });
  await expect(row()).toBeVisible();
  await shot(page, "so-open");
  await row().getByRole("button", { name: "Convert to Job" }).click();
  await page.waitForURL(/\/jobs\?job=/);
  await page.goto("/sales-orders");
  await expect(row()).toHaveCount(0);
  await page.getByRole("button", { name: /^Done \(/ }).click();
  await expect(row()).toBeVisible();
  await expect(row().getByRole("button", { name: "Convert to Job" })).toHaveCount(0); // hidden once converted
  await expect(row().getByRole("button", { name: "Despatch", exact: true })).toHaveCount(0); // and so is Despatch (the job carries it on)
  await shot(page, "so-converted-in-done");
});

test("6. Table and List look different", async ({ page }) => {
  const admin = adminClient();
  for (let i = 1; i <= 3; i++) await admin.from("sales_orders").insert({ organization_id: w.tenants.beta.id, so_number: `SO-VIEW${i}-${tag()}`, customer: "A Long Customer Name Engineering Ltd", status: "open", order_date: "2026-10-01", delivery_date: "2026-11-01" });
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/sales-orders");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Expected Delivery" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Table", exact: true })).toHaveAttribute("aria-pressed", "true");
  await shot(page, "view-table");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
  // List honours the ticked Columns (068fed0): a ticked Expected Delivery stays visible. List differs from Table by its density styling
  // (app/globals.css [data-view="list"]), not by dropping columns; with every column ticked its rows can legitimately be taller than
  // Table's (the action buttons stack), so row heights are not compared (ChatGPT ruling, 23 Oct).
  await expect(page.getByRole("columnheader", { name: "Expected Delivery" })).toBeVisible();
  await expect(page.locator('table[data-view="list"]')).toBeVisible();
  // Every action button is still there in List view, whole (not cut off sideways), once the row is scrolled to.
  const listRow = page.getByRole("row").filter({ hasText: `SO-VIEW1-${tag()}` });
  await listRow.scrollIntoViewIfNeeded();
  for (const name of ["View", "Edit", "Convert to Job", "Despatch"]) await expect(listRow.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
  // No sideways page scroll in List view.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await shot(page, "view-list");
  await page.getByRole("button", { name: "Table", exact: true }).click();
});
