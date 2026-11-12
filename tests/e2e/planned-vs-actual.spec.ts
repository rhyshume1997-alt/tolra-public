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

/**
 * Requests that are the panel's OWN reads of the seeded job, by exact query shape (the Job Board and the worksheet prefill also read
 * operator_sessions / machine_runs, for other jobs and with other filters, so tables alone can't be counted):
 * - jobs: select=finished_at and id=eq.<job id> (loadPlannedVsActual's first read);
 * - operator_sessions: job_id=eq.<job id> (the panel's labour read; the Job Board's is job_id=in.(...) with end_source).
 */
function panelReads(page: Page) {
  const reads = { jobs: [] as string[], sessions: [] as string[] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    const q = url.searchParams;
    if (url.pathname.endsWith("/rest/v1/jobs") && q.get("select") === "finished_at" && q.get("id") === `eq.${jobId}`) reads.jobs.push(request.url());
    if (url.pathname.endsWith("/rest/v1/operator_sessions") && q.get("job_id") === `eq.${jobId}`) reads.sessions.push(request.url());
  });
  return reads;
}

test("switch off (the default): no panel, and nothing is read for it", async ({ page }) => {
  test.setTimeout(120_000);
  await setSwitch(false);
  const reads = panelReads(page);
  await signIn(page, w.tenants.alpha.users.admin);
  let dialog = await openWorksheet(page);
  await page.waitForLoadState("networkidle");
  await expect(dialog.getByTestId("planned-vs-actual")).toHaveCount(0);
  // Nothing was read for the panel (its own queries for this job; other readers of these tables are ignored by the match).
  expect(reads.jobs).toHaveLength(0);
  expect(reads.sessions).toHaveLength(0);
  // Control: with the switch on, the same fingerprint does show up, so the zero above is a real zero and not a match that can't fire.
  await setSwitch(true);
  dialog = await openWorksheet(page); // reloads /jobs, so the company's settings (and the marker) are read afresh
  await expect(dialog.getByTestId("planned-vs-actual")).toBeVisible();
  await expect(dialog.getByTestId("pva-calculated-at")).toBeVisible();
  expect(reads.jobs.length).toBeGreaterThanOrEqual(1);
  expect(reads.sessions.length).toBeGreaterThanOrEqual(1);
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
    await expect(panel.getByTestId("pva-calculated-at")).toHaveText(/^Calculated at \d{2}:\d{2} on \d{1,2} [A-Z][a-z]{2,3} \d{4} \(UK time\)$/);
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
  await page.route("**/rest/v1/operator_sessions?*", (route) => (new URL(route.request().url()).searchParams.get("job_id") === `eq.${jobId}` ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }) : route.continue()));
  await signIn(page, w.tenants.alpha.users.admin);
  const dialog = await openWorksheet(page);
  await expect(dialog.getByTestId("planned-vs-actual")).toHaveText(READ_ERROR);
  await expect(dialog.getByTestId("planned-vs-actual")).toHaveCount(1);
  await expect(dialog.getByTestId("pva-step")).toHaveCount(0);
  // The worksheet is still usable: a field takes input.
  await dialog.getByLabel("Drawing #").fill("DWG-PVA");
  await expect(dialog.getByLabel("Drawing #")).toHaveValue("DWG-PVA");
});
