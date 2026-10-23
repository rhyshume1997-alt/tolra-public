/**
 * Pause for bench jobs (migration 046) in the browser: a job with no machine shows Pause once started; Pause shows "Paused" on the board
 * and the worksheet; Start resumes it (a new bench run, the job's start time kept); Finish ends it. Offline, a Pause queues on the device,
 * the board shows Paused, and it syncs once when the connection is back (one pause recorded, one audit row). Bench -> machine: a bench
 * job started, then started on a machine from the dialog, shows on the machine (its bench run ended), never Paused or Pause-for-bench.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { confirmFinish, confirmPause, pauseControl, playControl, playJob, signIn, world } from "./helpers";

const w = world();
// Run-specific names are built in beforeAll, never at module scope: `npm run test:e2e:list` runs with no world file.
let jobA = "";
let jobB = "";
let jobC = "";
let millName = "";
let mill = "";
const ids: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  jobA = `J-BPA-${w.runId}`;
  jobB = `J-BPB-${w.runId}`;
  jobC = `J-BPC-${w.runId}`;
  millName = `BP Mill ${w.runId}`;
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const machine = (await admin.from("machines").select("id").eq("organization_id", org).eq("name", millName).maybeSingle()).data;
  mill = machine ? (machine.id as string) : ((await admin.from("machines").insert({ organization_id: org, name: millName, active: true }).select("id").single()).data!.id as string);
  for (const no of [jobA, jobB, jobC]) {
    const found = (await admin.from("jobs").select("id").eq("organization_id", org).eq("job_no", no).maybeSingle()).data;
    ids[no] = found ? (found.id as string) : ((await admin.from("jobs").insert({ organization_id: org, job_no: no, customer: "Bench Co", description: `Bench work ${no}` }).select("id").single()).data!.id as string);
  }
});

const row = (page: Page, no: string) => page.locator(`tr[data-job-id="${ids[no]}"]`);
/** Paused shows twice in the row since e9ab705: the Stage cell's progress line and the status chip. Assert each by its own locator (strict mode). */
const expectPaused = async (page: Page, no: string) => {
  await expect(row(page, no).getByTestId("job-progress")).toHaveText("Paused");
  await expect(row(page, no).locator('[data-slot="badge"]').filter({ hasText: /^Paused$/ })).toBeVisible();
};
const benchRuns = async (no: string) => (await adminClient().from("machine_runs").select("machine_id, ended_at, end_reason").eq("job_id", ids[no]).order("started_at")).data!;
const pauseAudits = (no: string) => withDb(async (db) => (await db.query("select count(*)::int as c from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = 'PAUSE_MACHINE_RUN'", [ids[no]])).rows[0].c as number);

test("a bench job shows Pause; Pause shows Paused on the board and the worksheet; Start resumes it; Finish ends it", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await expect(pauseControl(row(page, jobA), jobA)).toHaveCount(0);
  // 049: no plan, so the bench is a deliberate choice in the Machine column; then Play.
  await playJob(page, row(page, jobA), jobA, { bench: true });
  await expect(page.getByText(`${jobA} started on the bench.`)).toBeVisible();
  await expect(pauseControl(row(page, jobA), jobA)).toBeVisible();
  await expect(row(page, jobA).getByTestId("machine-na")).toHaveText("N/A (bench)");
  await expect(row(page, jobA).getByRole("button", { name: `Start ${jobA}`, exact: true })).toHaveCount(0);
  expect(await benchRuns(jobA)).toEqual([{ machine_id: null, ended_at: null, end_reason: null }]);
  const startedAt = (await adminClient().from("jobs").select("started_at").eq("id", ids[jobA]).single()).data!.started_at;

  await confirmPause(page, pauseControl(row(page, jobA), jobA));
  await expect(page.getByText(`${jobA} paused.`)).toBeVisible();
  await expectPaused(page, jobA);
  await expect(pauseControl(row(page, jobA), jobA)).toHaveCount(0);
  expect((await benchRuns(jobA)).map((r) => r.end_reason)).toEqual(["paused"]);
  // The worksheet says so too.
  await row(page, jobA).getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${jobA}` });
  await expect(sheet.getByTestId("worksheet-bench")).toContainText("Paused");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Resume (prefilled with the bench, what it last ran on): a new bench run; the job's start time is kept.
  await expect(playControl(row(page, jobA), jobA)).toHaveAccessibleName(`Resume ${jobA}`);
  // The first Start's toast stays 8 s (the Toaster's duration); wait it out so the next one is the Resume's own, not that one.
  await expect(page.getByText(`${jobA} started on the bench.`)).toHaveCount(0, { timeout: 15_000 });
  await playControl(row(page, jobA), jobA).click();
  await expect(page.getByText(`${jobA} started on the bench.`)).toBeVisible();
  await expect(pauseControl(row(page, jobA), jobA)).toBeVisible();
  await expect(row(page, jobA).getByText("Paused", { exact: true })).toHaveCount(0);
  expect((await benchRuns(jobA)).map((r) => [r.machine_id, r.end_reason])).toEqual([[null, "paused"], [null, null]]);
  expect((await adminClient().from("jobs").select("started_at").eq("id", ids[jobA]).single()).data!.started_at).toBe(startedAt);

  await confirmFinish(page, row(page, jobA).getByRole("button", { name: "Finish", exact: true }));
  await expect(page.getByText(/Job finished/)).toBeVisible();
  expect((await benchRuns(jobA)).map((r) => r.end_reason)).toEqual(["paused", "finished"]);
});

test("the viewer sees the bench job's state but no Start or Pause", async ({ page }) => {
  // B on the bench, started by the workshop through the API.
  const workshop = await signedInClient(w.tenants.alpha.users.workshop);
  expect((await workshop.rpc("start_machine_run", { p_job: ids[jobB], p_machines: [], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null })).error).toBeNull();
  await signIn(page, w.tenants.alpha.users.viewer);
  await page.goto("/jobs");
  await expect(row(page, jobB)).toBeVisible();
  await expect(playControl(row(page, jobB), jobB)).toHaveCount(0);
  await expect(row(page, jobB).getByText("On the bench", { exact: true })).toBeVisible();
  await expect(row(page, jobB).getByRole("button", { name: /^Choose where / })).toHaveCount(0); // text only for a viewer
  // pause_machine_run refuses a viewer (044/046), so the board offers no Pause on any layout (audit #6).
  await expect(page.getByRole("button", { name: new RegExp(`^Pause ${jobB}`) })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
});

test("offline: a Pause queues on the device, the board shows Paused, and it syncs once when the connection is back", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await expect(pauseControl(row(page, jobB), jobB)).toBeVisible(); // the bench state is now on the device
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  // Read from the device's copy: still running on the bench.
  await expect(pauseControl(row(page, jobB), jobB)).toBeVisible();
  await confirmPause(page, pauseControl(row(page, jobB), jobB));
  await expect(page.getByText(`${jobB} paused on this device. It will sync when you're back online.`)).toBeVisible();
  await expect(row(page, jobB).getByTestId("run-waiting")).toHaveText("Paused, waiting to sync");
  // Survives a reload (the device's queue, folded into the board's state: R3.4).
  await page.reload();
  await expect(row(page, jobB).getByTestId("run-waiting")).toHaveText("Paused, waiting to sync");
  await expect(playControl(row(page, jobB), jobB)).toHaveAccessibleName(`Resume ${jobB}`);
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();
  expect((await benchRuns(jobB)).map((r) => r.end_reason)).toEqual([null]);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await benchRuns(jobB)).map((r) => r.end_reason), { timeout: 15_000 }).toEqual(["paused"]);
  await expect(page.getByText("1 change waiting to sync.")).toHaveCount(0);
  // Synced once: a second pass (focus, the minute timer) sends nothing more.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(1_000);
  expect(await pauseAudits(jobB)).toBe(1);
  expect((await benchRuns(jobB)).map((r) => r.end_reason)).toEqual(["paused"]);
  // Back online the board reads the server: Paused, and Start resumes.
  await page.reload();
  await expectPaused(page, jobB);
  await expect(playControl(row(page, jobB), jobB)).toHaveAccessibleName(`Resume ${jobB}`);
});

test("bench -> machine: a bench job started, then started on a machine from the dialog, shows on the machine; its bench run ended; no Paused, no bench Pause", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await playJob(page, row(page, jobC), jobC, { bench: true });
  await expect(page.getByText(`${jobC} started on the bench.`)).toBeVisible();
  await expect(pauseControl(row(page, jobC), jobC)).toBeVisible();
  expect(await benchRuns(jobC)).toEqual([{ machine_id: null, ended_at: null, end_reason: null }]);

  // Add a machine while it runs (plan 2.2): the Machine column's Add.
  await row(page, jobC).getByRole("button", { name: `Add a machine to ${jobC}` }).click();
  const picker = page.locator('[data-testid="machine-picker"]:visible');
  await picker.getByLabel(`Add ${millName}`).check();
  await picker.getByRole("button", { name: "Add 1 machine" }).click();
  await expect(page.getByText(`${jobC} started on ${millName}.`)).toBeVisible();
  // On the machine: the live use shows, the one Pause frees the machine, nothing says Paused or on the bench.
  await expect(row(page, jobC).getByTestId("job-in-use")).toContainText(millName);
  await expect(pauseControl(row(page, jobC), jobC)).toHaveCount(1);
  await expect(pauseControl(row(page, jobC), jobC)).toHaveAccessibleName(`Pause ${jobC}, stops the job and frees ${millName}`);
  await expect(row(page, jobC).getByText("Paused", { exact: true })).toHaveCount(0);
  const runs = await benchRuns(jobC);
  expect(runs.map((r) => [r.machine_id, r.end_reason])).toEqual([[null, "to_machine"], [mill, null]]);
  expect(runs.filter((r) => r.ended_at === null)).toHaveLength(1);
  await row(page, jobC).getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${jobC}` });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("worksheet-bench")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // After a reload (the server's state): still on the machine, not Paused.
  await page.reload();
  await expect(row(page, jobC).getByTestId("job-in-use")).toContainText(millName);
  await expect(row(page, jobC).getByText("Paused", { exact: true })).toHaveCount(0);
  await expect(pauseControl(row(page, jobC), jobC)).toHaveAccessibleName(`Pause ${jobC}, stops the job and frees ${millName}`);
  // Pause frees the machine; Finish ends the job.
  await confirmPause(page, pauseControl(row(page, jobC), jobC));
  await expect(page.getByText(`${jobC} paused: ${millName} freed.`)).toBeVisible();
  await confirmFinish(page, row(page, jobC).getByRole("button", { name: "Finish", exact: true }));
  await expect(page.getByText(/Job finished/)).toBeVisible();
  expect((await benchRuns(jobC)).filter((r) => r.ended_at === null)).toEqual([]);
});
