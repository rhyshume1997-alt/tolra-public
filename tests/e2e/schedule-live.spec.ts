/**
 * The Machine Schedule shows live use (migration 044 runs, client only): a job with no booking started on the mill from the Job Board
 * shows on /schedule as the card's pill "In use by <name> since HH:MM" (never "Free now" beside IN USE), a red actual bar on today's
 * timeline and a "Running now (not booked)" row. When the job is paused elsewhere, coming back to the tab (focus) re-reads live use
 * without a reload: the bar turns grey (ended), the pill says Free now and the row goes.
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { playJob, signIn, world } from "./helpers";

/** A run block fills the day cell top to bottom exactly as a booking segment does (inset-y-1: 4px clear above and below). */
async function expectFullHeight(page: import("@playwright/test").Page, block: import("@playwright/test").Locator) {
  const box = (await block.boundingBox())!;
  const cell = (await block.locator("xpath=..").boundingBox())!;
  expect(box.height).toBeGreaterThan(cell.height / 2); // never the old 10px bar
  expect(Math.abs(box.height - (cell.height - 8))).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - (cell.y + 4))).toBeLessThanOrEqual(1);
  return { box, cell };
}

const w = world();
// Run-specific names are built in beforeAll, never at module scope (`npm run test:e2e:list` runs with no world file).
let org = "";
let millName = "";
let jobNo = "";
let mill = "";
let jobId = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  millName = `SL Mill ${w.runId}`;
  jobNo = `J-SL-${w.runId}`;
  // Idempotent: a worker that restarts after a failure runs this again.
  const admin = adminClient();
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  mill = await one("machines", "name", millName, { name: millName });
  jobId = await one("jobs", "job_no", jobNo, { job_no: jobNo, customer: "Live Co", description: "Schedule live use" });
});

test("an unbooked job started on the mill shows on the schedule's card, timeline and table; after a Pause elsewhere, focus refreshes it", async ({ page }) => {
  const admin = adminClient();
  const workshop = w.tenants.alpha.users.workshop;
  // The operator's display name as the company list gives it (whatever an earlier spec left it as; never an e-mail).
  const name = ((await admin.from("user_profiles").select("full_name").eq("id", workshop.id).single()).data!.full_name as string).trim();
  expect(name).not.toContain("@");

  await signIn(page, workshop);
  await page.goto("/jobs");
  const jobRow = page.locator(`tr[data-job-id="${jobId}"]`);
  await playJob(page, jobRow, jobNo, { machines: [millName] });
  await expect(page.getByText(`${jobNo} started on ${millName}.`)).toBeVisible();
  expect((await admin.from("machine_bookings").select("id").eq("machine_id", mill)).data).toEqual([]); // no booking: runs only

  await page.goto("/schedule");
  const card = page.getByTestId("machine-status").filter({ hasText: millName });
  await expect(card.getByTestId("machine-status-pill")).toHaveText(new RegExp(`^In use by ${name} since (\\w{3} )?\\d\\d:\\d\\d$`));
  await expect(card).not.toContainText("Free now");
  await expect(card).not.toContainText("Nothing booked");
  await expect(card).toContainText(`Job ${jobNo} running`);
  await expect(card).toContainText("Next free: When paused or finished");
  await expect(card.getByTestId("machine-in-use")).toContainText(`IN USE: ${jobNo}, by ${name} since`);

  const bar = page.locator(`[data-testid="run-bar"][data-job-id="${jobId}"]`);
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveAttribute("data-state", "open");
  await expect(bar).toHaveAttribute("aria-label", new RegExp(`^Actual: ${jobNo} on ${millName} by ${name}, (\\w{3} )?\\d\\d:\\d\\d to now \\(running\\)`));
  await expect(bar).toHaveAttribute("data-kind", "running");
  await expect(bar).toHaveClass(/bg-\[#2563EB\]/);
  await expect(bar).toContainText("Running");
  await expectFullHeight(page, bar);
  await bar.click();
  await expect(page.getByTestId("run-detail")).toContainText("still running");
  await expect(page.getByTestId("run-detail")).toContainText("Not booked on the schedule.");
  await page.keyboard.press("Escape");

  const running = page.getByTestId("running-unbooked").filter({ hasText: jobNo });
  await expect(running).toHaveCount(1);
  await expect(running).toContainText(millName);
  await expect(running).toContainText("Running now (not booked)");
  await expect(running).toContainText(`by ${name} since`);
  await expect(running.getByRole("button", { name: "Book it" })).toBeVisible();
  // No hours are planned for this job on the mill: the run's time so far, and no invented finish.
  await expect(running).toContainText(/running for \d+:\d\d/);
  await expect(running.getByTestId("unbooked-left")).toHaveText("No hours planned");
  await expect(running.getByTestId("unbooked-finish")).toHaveText("-");

  // Paused on another device (the operator's own session, as the board does it); this tab is not reloaded.
  const operator = await signedInClient(workshop);
  const paused = await operator.rpc("pause_machine_run", { p_job: jobId, p_machines: null, p_client_op_id: null, p_ended_at: null });
  expect(paused.error).toBeNull();
  expect((await admin.from("machine_runs").select("end_reason").eq("job_id", jobId)).data).toEqual([{ end_reason: "paused" }]);
  // Coming back to the tab re-reads live use straight away (the 60 s timer would take up to a minute).
  await Promise.all([
    page.waitForRequest((r) => r.url().includes("/rpc/machines_in_use"), { timeout: 5_000 }),
    page.evaluate(() => window.dispatchEvent(new Event("focus"))),
  ]);

  await expect(bar).toHaveAttribute("data-state", "ended");
  await expect(bar).toHaveAttribute("data-kind", "paused");
  await expect(bar).toHaveClass(/bg-\[#CA8A04\]/);
  await expect(bar).toContainText("Paused");
  await expectFullHeight(page, bar);
  await expect(bar).toHaveAttribute("aria-label", new RegExp(`^Actual: ${jobNo} on ${millName} by ${name}, (\\w{3} )?\\d\\d:\\d\\d to (\\w{3} )?\\d\\d:\\d\\d \\(ended\\)`));
  await expect(card.getByTestId("machine-status-pill")).toHaveText("Free now");
  await expect(card.getByTestId("machine-in-use")).toHaveCount(0);
  await expect(running).toHaveCount(0);
  await expect(page.getByTestId("schedule-live-error")).toHaveCount(0);
});

test("finished and paused runs fill their hours of the day cell top to bottom, hour by hour, like a booking", async ({ page }) => {
  const admin = adminClient();
  const name = `SL Lathe ${w.runId}`;
  let machine = (await admin.from("machines").select("id").eq("organization_id", org).eq("name", name).maybeSingle()).data?.id as string | undefined;
  if (!machine) machine = (await admin.from("machines").insert({ organization_id: org, name }).select("id").single()).data!.id as string;
  // This week's Monday (the first column of the default view): finished 09:00-11:00, paused 12:00-14:00 on an 08:00-16:00 day.
  const monday = new Date();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const at = (h: number) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), h).toISOString();
  if (!(await admin.from("machine_runs").select("id").eq("machine_id", machine)).data?.length) {
    const ins = await admin.from("machine_runs").insert([
      { organization_id: org, job_id: jobId, machine_id: machine, started_at: at(9), ended_at: at(11), end_reason: "finished" },
      { organization_id: org, job_id: jobId, machine_id: machine, started_at: at(12), ended_at: at(14), end_reason: "paused" },
    ]);
    expect(ins.error).toBeNull();
  }
  await signIn(page, w.tenants.alpha.users.office);
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.goto("/schedule");
  const row = page.locator("div.grid").filter({ hasText: name }).filter({ has: page.getByTestId("run-bar") }).last();
  const finished = row.locator('[data-testid="run-bar"][data-kind="finished"]');
  const paused = row.locator('[data-testid="run-bar"][data-kind="paused"]');
  await expect(finished).toHaveCount(1);
  await expect(paused).toHaveCount(1);
  await expect(finished).toHaveAttribute("data-from", "09:00");
  await expect(finished).toHaveAttribute("data-to", "11:00");
  await expect(paused).toHaveAttribute("data-from", "12:00");
  await expect(paused).toHaveAttribute("data-to", "14:00");
  await expect(finished).toContainText("Finished");
  await expect(paused).toContainText("Paused");
  await expect(finished).toHaveClass(/bg-\[#16A34A\]/);
  await expect(paused).toHaveClass(/bg-\[#CA8A04\]/);
  await expect(page.getByText("No fill is free, grey is booked, blue is running, yellow is paused, green is complete.")).toBeVisible();
  const f = await expectFullHeight(page, finished);
  const p = await expectFullHeight(page, paused);
  // Hours covered: 2 of the 8 hours of the day, at 1/8 and 4/8 across the cell.
  for (const [{ box, cell }, start] of [[f, 1 / 8], [p, 4 / 8]] as const) {
    expect(Math.abs(box.width - cell.width / 4)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.x - (cell.x + cell.width * start))).toBeLessThanOrEqual(2);
  }
  // The one hour boundary inside each block is marked, so it reads hour by hour.
  await expect(finished.locator("span[aria-hidden]")).toHaveCount(1);
  await finished.click();
  await expect(page.getByTestId("run-detail")).toContainText("ended");
});

test("the timeline's Now label never covers a day name, on desktop, tablet and phone widths", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  for (const width of [1536, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/schedule");
    const label = page.getByTestId("now-marker-label");
    await expect(label).toBeVisible();
    const box = (await label.boundingBox())!;
    const headers = page.getByTestId("day-header");
    await expect(headers.first()).toBeVisible();
    for (const header of await headers.all()) {
      const h = await header.boundingBox();
      if (!h) continue;
      const overlaps = box.x < h.x + h.width && box.x + box.width > h.x && box.y < h.y + h.height && box.y + box.height > h.y;
      expect(overlaps, `Now label overlaps a day header at ${width}px`).toBe(false);
    }
    // The label sits on the marker line, under the machine rows.
    const marker = (await page.getByTestId("now-marker").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(marker.y + marker.height + 1);
  }
});

test("a booking wholly covered by machine use stays reachable: a slim strip opens it by click and keyboard", async ({ page }) => {
  const admin = adminClient();
  const name = `SL Press ${w.runId}`;
  const job = `J-COV-${w.runId}`;
  let machine = (await admin.from("machines").select("id").eq("organization_id", org).eq("name", name).maybeSingle()).data?.id as string | undefined;
  if (!machine) machine = (await admin.from("machines").insert({ organization_id: org, name }).select("id").single()).data!.id as string;
  // This week's Monday: booked 10:00-12:00, but the machine ran 09:30-13:00, so the run bar covers all of the booking.
  // The booking is complete: the schedule counts an unfinished booking's remaining hours from now once its start has passed (scheduleBooking),
  // so a "booked" one starting earlier this week would be drawn out to the end of the day and not be wholly covered. A complete one ends at start + estimate.
  const monday = new Date();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const at = (h: number, m = 0) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), h, m).toISOString();
  if (!(await admin.from("machine_bookings").select("id").eq("job_no", job)).data?.length) {
    const b = await admin.from("machine_bookings").insert({ organization_id: org, machine_id: machine, job_id: jobId, job_no: job, start_at: at(10), estimated_hours: 2, status: "complete" });
    expect(b.error).toBeNull();
    const r = await admin.from("machine_runs").insert({ organization_id: org, job_id: jobId, machine_id: machine, started_at: at(9, 30), ended_at: at(13), end_reason: "finished" });
    expect(r.error).toBeNull();
  }
  await signIn(page, w.tenants.alpha.users.office);
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.goto("/schedule");
  await page.getByLabel(/^Show finished/).check(); // a complete booking is off the chart by default
  const strip = page.locator(`button[data-booking-id][data-covered="true"][title^="${job} on "]`);
  await expect(strip).toHaveCount(1);
  await expect(strip).toHaveAccessibleName(new RegExp(`${job} on ${name}`));
  await strip.click();
  await expect(page.getByRole("dialog")).toContainText(job);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await strip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText(job);
});

test("an unbooked run on a job planned for 6.5 h on the mill shows running for, hours left against the plan, an Est. finish and the card's Next free", async ({ page }) => {
  const admin = adminClient();
  const planMillName = `SL Plan Mill ${w.runId}`;
  const planJobNo = `J-SLP-${w.runId}`;
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  const planMill = await one("machines", "name", planMillName, { name: planMillName });
  const planJob = await one("jobs", "job_no", planJobNo, { job_no: planJobNo, customer: "Plan Co", description: "Planned hours, no booking" });
  // A plan row with hours but no booking (a direct insert books nothing): Start finds no booking, so the run is unbooked.
  expect((await admin.from("job_machines").insert({ organization_id: org, job_id: planJob, machine_id: planMill, estimated_hours: 6.5 })).error).toBeNull();

  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const jobRow = page.locator(`tr[data-job-id="${planJob}"]`);
  // The board reads the job's plan after the jobs (fire-and-forget). Until it lands, the picker lists the mill unticked in name order; when
  // it lands, the mill jumps to the top and Play's default pre-ticks it (free planned machines), so a check() racing it is intercepted by the
  // row that slid into place and its retry unticks the default. Wait for the plan line first: the picker then opens settled.
  await expect(jobRow.getByTestId("job-machines")).toContainText(planMillName);
  await playJob(page, jobRow, planJobNo, { machines: [planMillName] });
  await expect(page.getByText(`${planJobNo} started on ${planMillName}.`)).toBeVisible();
  expect((await admin.from("machine_runs").select("booking_id").eq("job_id", planJob)).data).toEqual([{ booking_id: null }]);
  // The Job Board row: running for, and left against the plan, though there is no booking.
  await expect(jobRow.getByTestId("run-timer")).toHaveText(new RegExp(`^${planMillName}: running for \\d+:\\d\\d, \\d+:\\d\\d left$`));

  await page.goto("/schedule");
  const running = page.getByTestId("running-unbooked").filter({ hasText: planJobNo });
  await expect(running).toContainText("Running now (not booked)");
  await expect(running).toContainText(/running for \d+:\d\d/);
  await expect(running.getByTestId("unbooked-left")).toHaveText(/^\d+:\d\d left \(plan 6:30\)$/);
  await expect(running.getByTestId("unbooked-finish")).toHaveText(/^about \w{3} \d\d:\d\d \(plan\)$/);
  await expect(running.getByRole("button", { name: "Book it" })).toBeVisible();
  const card = page.getByTestId("machine-status").filter({ hasText: planMillName });
  await expect(card).toContainText(/Next free: About \w{3} \d\d:\d\d \(plan\), or sooner if paused/);
  await expect(card).toContainText(/running for \d+:\d\d/);

  const operator = await signedInClient(w.tenants.alpha.users.workshop);
  await operator.rpc("pause_machine_run", { p_job: planJob, p_machines: null, p_client_op_id: null, p_ended_at: null });
});
