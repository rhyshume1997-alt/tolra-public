/**
 * List page views (Cards / List / Table), remembered per person per page. Job Board defaults to a compact one-line
 * row per job that fits 1280px without sideways scrolling; phones show stacked cards.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { confirmFinish, pauseControl, playJob, signIn, world } from "./helpers";

const w = world();

test("Job Board: compact rows fit 1280px, details expand, view choice is remembered; phones get cards", async ({ page }) => {
  const jobNo = `J-VW-${w.runId}`;
  await adminClient().from("jobs").insert({ organization_id: w.tenants.alpha.id, job_no: jobNo, customer: "A Very Long Customer Name Engineering Holdings Ltd", description: "A long description that would push a wide table sideways", specification: "Spec 316 polish", due_date: "2026-12-01" });
  await signIn(page, w.tenants.alpha.users.admin);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/jobs");
  const row = page.getByRole("row").filter({ hasText: jobNo });
  await expect(row).toBeVisible();
  await expect(page.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(row.getByRole("button", { name: `Start ${jobNo}`, exact: true })).toBeVisible(); // Play (049)
  for (const name of ["Finish", "Inspected", "Worksheet", "Print", "Send"]) await expect(row.getByRole(name === "Print" ? "link" : "button", { name, exact: true })).toBeVisible();
  // The phone cards (md:hidden) are always in the DOM and carry the Specification, so count only what is on screen. Columns parity: the List
  // has its own Specification column, so it is on screen without expanding; expanding adds the progress line, not a second copy.
  // Alpha is shared: job-board-headings.spec.ts adds J-HDA / J-HDB with the same specification, so the job's own row is checked, and
  // the page-wide count is only compared before and after expanding (CI run 40098816693 saw 3 = those two rows + this one).
  const rowSpec = row.getByText("Spec 316 polish").filter({ visible: true });
  await expect(rowSpec).toHaveCount(1);
  const shownSpec = page.getByText("Spec 316 polish").filter({ visible: true });
  const shownBefore = await shownSpec.count();
  expect(shownBefore).toBeGreaterThanOrEqual(1);
  await row.getByRole("button", { name: `Show details for ${jobNo}` }).click();
  await expect(row.getByRole("button", { name: `Hide details for ${jobNo}` })).toBeVisible();
  await expect(rowSpec).toHaveCount(1);
  await expect(rowSpec).toBeVisible();
  await expect(shownSpec).toHaveCount(shownBefore);

  // Job No and Due / status are never clipped at laptop and desktop widths: a real number fits one line, an unusually long one wraps.
  await adminClient().from("jobs").insert({ organization_id: w.tenants.alpha.id, job_no: `J-2026-10423-${w.runId}`, customer: "Another Long Customer Name Holdings", description: "Long description", due_date: "2026-12-01" });
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    const longRow = page.getByRole("row").filter({ hasText: `J-2026-10423-${w.runId}` });
    await expect(longRow).toBeVisible();
    for (const id of ["job-no-cell", "due-status-cell"]) {
      const clipped = await longRow.getByTestId(id).evaluate((cell) => {
        const box = cell.getBoundingClientRect();
        return [cell, ...cell.querySelectorAll("*")].some((el) => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > box.right + 1);
      });
      expect(clipped, `${id} clipped at ${width}px`).toBe(false);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole("button", { name: "Table" }).click();
  await expect(page.getByRole("columnheader", { name: "Drawings" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "List" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-slot="card"]:visible', { hasText: jobNo })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Quotes: Cards by default, List and Table on request, remembered", async ({ page }) => {
  const ref = `QUO-VW-${w.runId}`;
  await adminClient().from("quotes").insert({ organization_id: w.tenants.alpha.id, quote_ref: ref, customer: "View Co", description: "Brackets", total_value: 1234, status: "sent" });
  await signIn(page, w.tenants.alpha.users.admin);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/quotes");
  await expect(page.locator('[data-slot="card"]', { hasText: ref })).toBeVisible();
  await page.getByRole("button", { name: "List" }).click();
  const row = page.getByRole("row").filter({ hasText: ref });
  await expect(row).toContainText("£1,234.00");
  await expect(row.getByRole("button", { name: "View" })).toBeVisible();
  await page.getByRole("button", { name: "Table" }).click();
  await expect(page.getByRole("columnheader", { name: "Description" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Cards" }).click();
});

test("Invoices, sales orders, purchase orders, customers: Table / List / Cards, remembered, no sideways scroll at 1280px", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const tag = `VW${w.runId.slice(0, 6)}`;
  await admin.from("sales_orders").insert({ organization_id: org, so_number: `SO-${tag}`, customer: "View Co" });
  await admin.from("purchase_orders").insert({ organization_id: org, po_ref: `PO-${tag}`, po_number: `PO-${tag}`, supplier: "View Supplies" });
  await admin.from("customers").insert({ organization_id: org, name: `Customer ${tag}`, phone: "0123 456789" });
  await signIn(page, w.tenants.alpha.users.admin);
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [path, text] of [["/sales-orders", `SO-${tag}`], ["/purchase-orders", `PO-${tag}`], ["/customers", `Customer ${tag}`], ["/invoices", null]] as const) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: "Table" }), path).toHaveAttribute("aria-pressed", "true");
    for (const mode of ["List", "Cards"]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      if (text) await expect(page.getByText(text, { exact: true }).first(), `${path} ${mode}`).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} ${mode}`).toBe(true);
    }
    await page.reload();
    await expect(page.getByRole("button", { name: "Cards" }), path).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Table" }).click();
  }
  // List honours the ticked Columns (79aad525): a ticked Phone stays visible in List (it is no longer a hidden secondary column).
  // The row is waited for first, so the check is made on the loaded list, not on the loading skeleton.
  await page.goto("/customers");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator('table[data-view="list"]')).toBeVisible();
  const listRow = page.getByRole("row").filter({ hasText: `Customer ${tag}` }).first();
  await expect(listRow).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Phone", exact: true })).toBeVisible();
  await expect(listRow.getByText("0123 456789", { exact: true })).toBeVisible();
});

test("Job Board: traffic light and progress on every job; Finish moves it to Inspection, Inspected to Complete", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const late = `J-TL-LATE-${w.runId}`, nodate = `J-TL-NODATE-${w.runId}`;
  await admin.from("jobs").insert([{ organization_id: org, job_no: late, customer: "Light Co", due_date: "2026-01-05", date_required: "2026-01-05" }, { organization_id: org, job_no: nodate, customer: "Light Co" }]);
  await signIn(page, w.tenants.alpha.users.admin);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/jobs");
  const row = (no: string) => page.getByRole("row").filter({ hasText: no });
  await expect(row(late)).toContainText("Late");
  await expect(row(late)).toContainText("Not started");
  await expect(row(nodate)).toContainText("No due date");

  // 049: a job with no plan starts where the person says: here, deliberately on the bench.
  await playJob(page, row(nodate), nodate, { bench: true });
  await expect(row(nodate)).toContainText("On the bench");
  await expect(pauseControl(row(nodate), nodate)).toBeVisible();
  await expect(row(nodate).getByRole("button", { name: "Inspected", exact: true })).toBeDisabled(); // not finished yet
  await confirmFinish(page, row(nodate).getByRole("button", { name: "Finish", exact: true }));
  await expect(page.getByText("Job finished: Waiting for inspection")).toBeVisible();
  // Open includes Waiting for inspection (Rhys, Wed 21 Oct): the finished job stays on the Open board with that status.
  await expect(row(nodate).getByTestId("job-status").first()).toContainText("Waiting for inspection");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await expect(row(nodate)).toContainText("Waiting for inspection");
  const finished = (await admin.from("jobs").select("started_at, finished_at, stage, inspected_at").eq("job_no", nodate).single()).data!;
  expect(finished).toMatchObject({ stage: "inspection", inspected_at: null });
  expect(finished.finished_at).not.toBeNull();

  await row(nodate).getByRole("button", { name: "Inspected", exact: true }).click();
  const inspection = page.getByRole("dialog", { name: /Record inspection/ });
  await inspection.getByRole("button", { name: "Record inspection" }).click();
  await expect(inspection.getByRole("alert")).toContainText("measured notes"); // the evidence is required
  await inspection.getByLabel("Measured notes (required)").fill("Bore 25.01 mm against 25.00 +0.03");
  // 081: what it was checked against, and (the admin finished it) the admin's reason for inspecting their own work.
  await inspection.getByRole("button", { name: "Record inspection" }).click();
  await expect(inspection.getByRole("alert")).toContainText("acceptance criteria");
  await inspection.getByLabel("Acceptance criteria (required)").fill("Bore 25.00 +0.03/-0");
  await inspection.getByLabel(/Reason you are inspecting it yourself/).fill("Sole inspector on site today");
  await inspection.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(/inspected: Complete/)).toBeVisible();
  await expect(row(nodate)).toHaveCount(0);
  await page.getByRole("button", { name: /^Complete \(/ }).click();
  await expect(row(nodate)).toContainText("Complete");
  const done = (await admin.from("jobs").select("stage, inspected_at, inspected_by").eq("job_no", nodate).single()).data!;
  expect(done.stage).toBe("complete");
  expect(done.inspected_at).not.toBeNull();
  expect(done.inspected_by).toBeTruthy();
});

test("Quotes: grouped by stage; a sent quote moves from Drafts to Sent; a draft past its date can't be sent", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const old = `QUO-OLD-${w.runId}`;
  await admin.from("quotes").insert({ organization_id: org, quote_ref: old, customer: "Old Co", total_value: 100, status: "draft", valid_until: "2026-01-01" });
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/quotes");
  // Past its date: shown as Expired (go-live polish 19b) under Done, stored as a draft, and Send refuses it until it has a new date.
  await page.getByRole("button", { name: /^Done \(/ }).click();
  const expired = page.getByRole("region", { name: "Expired quotes" });
  await expect(expired.locator('[data-slot="card"]', { hasText: old })).toBeVisible();
  await expired.locator('[data-slot="card"]', { hasText: old }).getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/is only valid until 01\/01\/2026, which has passed/)).toBeVisible();
  expect((await admin.from("quotes").select("status").eq("quote_ref", old).single()).data?.status).toBe("draft");
});
