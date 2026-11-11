/**
 * Jobs: planned vs actual machine time on the worksheet, in the browser (lib/jobs/planned-vs-actual*, components/jobs/planned-vs-actual-panel).
 * OFF (no "job-time-variance:on" marker in organization_settings.hidden_nav, the default): no panel, and the panel's own read
 * (operator_sessions) is never made. ON: admin and office see the figures (planned 2.00, actual 2.50, +0.50, Over plan) and when they were
 * calculated; the workshop sees nothing. A failed read shows one muted line and the worksheet still works.
 *
 * Shares the alpha company (it needs its office and workshop users), so the marker is set and removed through SQL on that company only,
 * and afterAll removes it again whatever happened: nothing leaks to other specs. Serial, as the marker is shared state. The job, machine,
 * plan and run carry the run id, so teardown removes them with the rest of the run. Like the other specs of this suite there is no
 * per-spec skip: with no backend, global setup fails (the suite never skips); listing needs none.
 * Must not change: the marker text (lib/jobs/planned-vs-actual-switch.ts) or the visible texts asserted here.
 */
import { expect, test, type Page } from "@playwright/test";

import { JOB_TIME_VARIANCE_ON_MARKER } from "@/lib/jobs/planned-vs-actual-switch";

import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const READ_ERROR = "Planned vs actual can't be read right now.";
let org = "";
let jobNo = "";
let jobId = "";
let millName = "";

test.describe.configure({ mode: "serial" });

/** Sets the marker for the alpha company (the same hidden_nav list the switch lives in); `false` removes it. */
const setSwitch = (on: boolean) => withDb(async (db) => {
  const done = await db.query(
    "update public.organization_settings set hidden_nav = case when $2::boolean then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1",
    [org, on, JOB_TIME_VARIANCE_ON_MARKER],
  );
  if (done.rowCount !== 1) throw new Error(`no organization_settings row for ${org}`);
});

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  jobNo = `J-PVA-${w.runId}`;
  millName = `Mill ${w.runId.slice(0, 6)}`;
  const admin = adminClient();
  // Idempotent: a worker that restarts after a failure runs this again.
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    if (found) return found.id as string;
    const made = await admin.from(table).insert({ organization_id: org, ...row }).select("id").single();
    expect(made.error).toBeNull();
    return made.data!.id as string;
  };
  const machine = await one("machines", "name", millName, { name: millName });
  jobId = await one("jobs", "job_no", jobNo, { job_no: jobNo, customer: "Variance Co", description: "Planned vs actual" });
  // Plan: the mill for 2 h. Run: the mill for 2.5 h, ended.
  if (!(await admin.from("job_machines").select("id").eq("job_id", jobId).eq("machine_id", machine).maybeSingle()).data) {
    expect((await admin.from("job_machines").insert({ organization_id: org, job_id: jobId, machine_id: machine, estimated_hours: 2 })).error).toBeNull();
  }
  if (!(await admin.from("machine_runs").select("id").eq("job_id", jobId).eq("machine_id", machine).maybeSingle()).data) {
    const started = Date.now() - 6 * 3_600_000;
    const run = await admin.from("machine_runs").insert({ organization_id: org, job_id: jobId, machine_id: machine, started_at: new Date(started).toISOString(), ended_at: new Date(started + 2.5 * 3_600_000).toISOString(), end_reason: "paused" });
    expect(run.error).toBeNull();
  }
  await setSwitch(false);
});

test.afterAll(async () => {
  await setSwitch(false);
});

async function openWorksheet(page: Page) {
  await page.goto("/jobs");
  await page.locator(`[data-testid="job-card"][data-job-no="${jobNo}"]:visible, tr:has-text("${jobNo}"):visible`).first().getByRole("button", { name: "Worksheet" }).click();
  const dialog = page.getByRole("dialog", { name: `Worksheet - ${jobNo}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save Worksheet" })).toBeEnabled();
  return dialog;
}

/** Counts the REST reads the page makes to a table (any method). */
function countReads(page: Page, table: string) {
  const urls: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith(`/rest/v1/${table}`)) urls.push(request.url()); });
  return urls;
}

test("switch off (the default): no panel, and nothing is read for it", async ({ page }) => {
  test.setTimeout(120_000);
  await setSwitch(false);
  const sessions = countReads(page, "operator_sessions");
  const runs = countReads(page, "machine_runs");
  await signIn(page, w.tenants.alpha.users.admin);
  runs.length = 0; // count from the first opening of the worksheet on
  let dialog = await openWorksheet(page);
  await page.waitForLoadState("networkidle");
  await expect(dialog.getByTestId("planned-vs-actual")).toHaveCount(0);
  // operator_sessions is read only by the panel: none.
  expect(sessions).toHaveLength(0);
  // machine_runs is also read by the worksheet's own plan prefill (lib/job-machine-plan.ts, same select), so its requests can't be told
  // apart by URL. Robust check: the panel adds exactly one machine_runs read. Count what opening the worksheet makes with the panel off,
  // switch it on, open it again, and the difference must be exactly the panel's one read (so off made none for the panel).
  const offCount = runs.length;
  await setSwitch(true);
  runs.length = 0;
  dialog = await openWorksheet(page); // reloads /jobs, so the company's settings (and the marker) are read afresh
  await expect(dialog.getByTestId("planned-vs-actual")).toBeVisible();
  await expect(dialog.getByTestId("pva-calculated-at")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(sessions.length).toBeGreaterThan(0);
  expect(runs.length).toBe(offCount + 1);
});

test("switch on: admin and office see planned 2.00, actual 2.50, +0.50, Over plan and when it was calculated; workshop sees no panel", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await setSwitch(true);
  for (const role of ["admin", "office"] as const) {
    const context = role === "admin" ? page.context() : await browser.newContext();
    const p = role === "admin" ? page : await context.newPage();
    await signIn(p, w.tenants.alpha.users[role]);
    const dialog = await openWorksheet(p);
    const panel = dialog.getByTestId("planned-vs-actual");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Planned vs actual machine time (read-only, from machine runs)");
    await expect(panel).toContainText("Each row is a machine on this job's plan, not an individual operation.");
    await expect(panel.getByRole("columnheader", { name: "Machine (job step)" })).toBeVisible();
    const row = panel.getByTestId("pva-step").filter({ hasText: millName });
    await expect(row).toHaveCount(1);
    const cells = row.getByRole("cell");
    await expect(cells.nth(1)).toHaveText("2.00");
    await expect(cells.nth(2)).toHaveText("2.50");
    await expect(cells.nth(3)).toHaveText("+0.50");
    await expect(cells.nth(4)).toHaveText("Over plan");
    const total = panel.getByRole("row").filter({ hasText: "Total (machines)" });
    await expect(total.getByRole("cell").nth(1)).toHaveText("2.00");
    await expect(total.getByRole("cell").nth(2)).toHaveText("2.50");
    await expect(total.getByRole("cell").nth(3)).toHaveText("+0.50");
    await expect(panel.getByTestId("pva-calculated-at")).toHaveText(/^Calculated at \d{2}:\d{2} on \d{1,2} [A-Z][a-z]{2} \d{4} \(UK time\)$/);
    if (role === "office") await context.close();
  }
  const workshopContext = await browser.newContext();
  const wp = await workshopContext.newPage();
  await signIn(wp, w.tenants.alpha.users.workshop);
  const dialog = await openWorksheet(wp);
  await wp.waitForLoadState("networkidle");
  await expect(dialog.getByTestId("planned-vs-actual")).toHaveCount(0);
  await workshopContext.close();
});

test("switch on, read fails: one muted line, and the worksheet still renders and works", async ({ page }) => {
  test.setTimeout(120_000);
  await setSwitch(true);
  await page.route("**/rest/v1/operator_sessions*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }));
  await signIn(page, w.tenants.alpha.users.admin);
  const dialog = await openWorksheet(page);
  await expect(dialog.getByTestId("planned-vs-actual")).toHaveText(READ_ERROR);
  await expect(dialog.getByTestId("planned-vs-actual")).toHaveCount(1);
  await expect(dialog.getByTestId("pva-step")).toHaveCount(0);
  // The worksheet is still usable: a field takes input.
  await dialog.getByLabel("Drawing #").fill("DWG-PVA");
  await expect(dialog.getByLabel("Drawing #")).toHaveValue("DWG-PVA");
});
