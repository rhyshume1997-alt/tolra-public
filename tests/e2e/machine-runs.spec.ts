/**
 * Live machine use and assignment (migration 044) in the browser: the workshop starts a planned job and picks its machine; the board shows
 * IN USE (machine, who, since) to the office, who can't take that machine for another job but can group the board by machine and assign an
 * operator; the admin takes the machine over (recorded), releases it, pauses and finishes; the schedule's status cards show the live use;
 * and a Start made offline with a machine syncs through start_machine_run: applied when the machine is free, surfaced as a conflict (the
 * job still started, the machine not taken) when someone took it meanwhile.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { confirmFinish, confirmPause, pauseControl, playControl, playJob, signIn, world } from "./helpers";

const w = world();
// Run-specific names are built in beforeAll, never at module scope: `npm run test:e2e:list` (CI's collection step) runs with no world file.
let org = "";
let millName = "";
let latheName = "";
let jobA = ""; // planned on the mill
let jobB = ""; // no plan
let jobC = ""; // planned on the lathe; started offline, clashes when it syncs
let jobD = ""; // takes the lathe while the device is offline
let jobE = ""; // planned on the mill; started offline, applies when it syncs
let mill = "";
let lathe = "";
const ids: Record<string, string> = {};
let workshopName: string | null | undefined; // the shared workshop user's name before this spec renames it

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  millName = `MR Mill ${w.runId}`;
  latheName = `MR Lathe ${w.runId}`;
  jobA = `J-MRA-${w.runId}`;
  jobB = `J-MRB-${w.runId}`;
  jobC = `J-MRC-${w.runId}`;
  jobD = `J-MRD-${w.runId}`;
  jobE = `J-MRE-${w.runId}`;
  // Idempotent: a worker that restarts after a failure runs this again.
  const admin = adminClient();
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  mill = await one("machines", "name", millName, { name: millName });
  lathe = await one("machines", "name", latheName, { name: latheName });
  for (const no of [jobA, jobB, jobC, jobD, jobE]) ids[no] = await one("jobs", "job_no", no, { job_no: no, customer: "Runs Co", description: `Live use ${no}` });
  const plan = async (job: string, machine: string) => {
    const found = (await admin.from("job_machines").select("id").eq("job_id", job).eq("machine_id", machine).maybeSingle()).data;
    if (!found) await admin.from("job_machines").insert({ organization_id: org, job_id: job, machine_id: machine, estimated_hours: 1 });
  };
  await plan(ids[jobA], mill);
  await plan(ids[jobC], lathe);
  await plan(ids[jobE], mill);
  // The shared workshop user is renamed for these tests only; afterAll puts the name back so later specs (who-did-what,
  // rework) still see "Workshop alpha".
  const before = (await admin.from("user_profiles").select("full_name").eq("id", w.tenants.alpha.users.workshop.id).single()).data!.full_name as string | null;
  // A restarted worker sees the name this spec set; the world seeds "Workshop alpha".
  workshopName = before === "Dave Operator" ? "Workshop alpha" : before;
  await admin.from("user_profiles").update({ full_name: "Dave Operator" }).eq("id", w.tenants.alpha.users.workshop.id);
});

test.afterAll(async () => {
  if (workshopName === undefined) return;
  const { error } = await adminClient().from("user_profiles").update({ full_name: workshopName }).eq("id", w.tenants.alpha.users.workshop.id);
  if (error) throw error;
});

const row = (page: Page, no: string) => page.locator(`tr[data-job-id="${ids[no]}"]`);

test("the workshop starts a planned job, picks the mill, sees IN USE with their name, and takes the job", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await expect(row(page, jobA).getByTestId("job-machines")).toContainText(millName); // the plan is loaded
  // The Machine column shows what Play starts on before Play: the free planned mill, preselected (R2.4).
  await row(page, jobA).getByRole("button", { name: `Choose where ${jobA} runs: ${millName}` }).click();
  const picker = page.locator('[data-testid="machine-picker"]:visible');
  await expect(picker.getByLabel(`Start on ${millName}`)).toBeChecked();
  await expect(picker.getByLabel(`Start on ${latheName}`)).not.toBeChecked();
  await page.keyboard.press("Escape");
  await playControl(row(page, jobA), jobA).click();
  await expect(page.getByText(`${jobA} started on ${millName}.`)).toBeVisible();
  await expect(row(page, jobA).getByTestId("job-in-use")).toContainText(`${millName}, since`);
  await expect(row(page, jobA).getByTestId("on-it-now")).toHaveText("On it now: Dave Operator");
  await expect(pauseControl(row(page, jobA), jobA)).toHaveClass(/bg-amber-500/); // Pause: solid amber
  const { data: runs } = await adminClient().from("machine_runs").select("machine_id, operator_id, ended_at").eq("job_id", ids[jobA]);
  expect(runs).toEqual([{ machine_id: mill, operator_id: w.tenants.alpha.users.workshop.id, ended_at: null }]);
  expect((await adminClient().from("jobs").select("started_at, started_by").eq("id", ids[jobA]).single()).data).toMatchObject({ started_by: w.tenants.alpha.users.workshop.id });
  await row(page, jobA).getByRole("button", { name: "Take this job" }).click();
  await expect(row(page, jobA).getByTestId("job-operator")).toHaveText("You");
  await expect(row(page, jobA).getByTestId("on-it-now")).toHaveCount(0);
  await expect(row(page, jobA).getByRole("button", { name: "Hand back" })).toBeVisible();
});

test("the office sees who is on the mill, can't start another job on it, groups the board by machine and assigns an operator; the schedule shows the live use", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await expect(row(page, jobA).getByTestId("job-in-use")).toContainText(millName);
  await expect(row(page, jobA).getByTestId("job-operator")).toHaveText("Dave Operator");
  await row(page, jobB).getByRole("button", { name: new RegExp(`^Choose where ${jobB} runs`) }).click();
  const picker = page.locator('[data-testid="machine-picker"]:visible');
  await expect(picker.getByTestId("picker-machine").filter({ hasText: millName }).getByTestId("picker-in-use")).toContainText(`In use: ${jobA}, Dave Operator since`);
  await expect(picker.getByLabel(`Start on ${millName}`)).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  expect((await adminClient().from("machine_runs").select("id").eq("job_id", ids[jobB])).data).toEqual([]);

  await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "Machine" }).click();
  const groups = page.locator("table").getByTestId("machine-group"); // the list view's headings (the phone cards are in the DOM too, hidden)
  await expect(groups.filter({ hasText: `On ${millName}` })).toBeVisible();
  await expect(groups.filter({ hasText: "No machine" })).toBeVisible();
  const millHeading = page.locator("table tr").filter({ has: page.getByTestId("machine-group").filter({ hasText: `On ${millName}` }) });
  // A and E are both planned on the mill: A is one of the two rows right under the heading.
  await expect(millHeading.locator(`xpath=following-sibling::tr[position()<=2][@data-job-id="${ids[jobA]}"]`)).toHaveCount(1);
  await page.getByRole("group", { name: "Group by" }).getByRole("button", { name: "None" }).click();

  await row(page, jobB).getByLabel(`Assign ${jobB}`).selectOption({ label: "Dave Operator" });
  await expect(page.getByText(`${jobB} assigned to Dave Operator`)).toBeVisible();
  await expect(row(page, jobB).getByTestId("job-operator")).toHaveText("Dave Operator");
  expect((await adminClient().from("jobs").select("assigned_to").eq("id", ids[jobB]).single()).data).toEqual({ assigned_to: w.tenants.alpha.users.workshop.id });

  await page.goto("/schedule");
  const card = page.getByTestId("machine-status").filter({ hasText: millName });
  await expect(card.getByTestId("machine-in-use")).toContainText(`IN USE: ${jobA}, by Dave Operator since`);
  // The pill agrees with the IN USE line: never "Free now" while a run is open.
  await expect(card.getByTestId("machine-status-pill")).toHaveText(/^In use by Dave Operator since (\w{3} )?\d\d:\d\d$/);
  await expect(card).not.toContainText("Free now");
});

test("the admin takes the mill over for another job (recorded), releases it, pauses and finishes", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/jobs");
  // An admin may tick a machine in use; Play then asks for the takeover reason.
  await playJob(page, row(page, jobB), jobB, { machines: [millName] });
  const dialog = page.getByRole("dialog", { name: `Take over for ${jobB}?` });
  await expect(dialog.getByRole("button", { name: `Take over ${millName} and start` })).toBeDisabled(); // a reason first
  await dialog.getByLabel("Why are you taking it over?").fill("Customer waiting on this one");
  await dialog.getByRole("button", { name: `Take over ${millName} and start` }).click();
  await expect(page.getByText(`${jobB} started on ${millName}. Takeover recorded.`)).toBeVisible();
  await expect(row(page, jobB).getByTestId("job-in-use")).toContainText(`${millName}, since`);
  await expect(row(page, jobA).getByTestId("job-in-use")).toHaveCount(0);
  const admin = adminClient();
  const { data: aRuns } = await admin.from("machine_runs").select("end_reason, ended_at").eq("job_id", ids[jobA]);
  expect(aRuns).toEqual([{ end_reason: "override", ended_at: expect.any(String) }]);
  const { data: bRun } = await admin.from("machine_runs").select("override_of, ended_at").eq("job_id", ids[jobB]).single();
  expect(bRun!.override_of).toBeTruthy();
  const audit = await withDb((db) => db.query("select metadata from security_audit.audit_log where action = 'OVERRIDE_MACHINE_IN_USE' and entity_id = $1", [ids[jobB]]));
  expect(audit.rows.map((r) => [r.metadata.reason, r.metadata.actor_user_id])).toEqual([["Customer waiting on this one", w.tenants.alpha.users.admin.id]]);
  expect((await admin.from("machine_runs").select("id").eq("machine_id", mill).is("ended_at", null)).data).toHaveLength(1);

  // Release (a forgotten run), then start again and pause, then finish: every run ends, the machine is free.
  await row(page, jobB).getByRole("button", { name: `Release ${millName}` }).click();
  const release = page.getByRole("dialog", { name: `Release ${millName}?` });
  await expect(release.getByRole("button", { name: "Release machine" })).toBeDisabled();
  await release.getByLabel("Why?").fill("Forgotten after the shift");
  await release.getByRole("button", { name: "Release machine" }).click();
  await expect(page.getByText(`${millName} released (was ${jobB}).`)).toBeVisible();
  await expect(row(page, jobB).getByTestId("job-in-use")).toHaveCount(0);
  // Stopped by admin (092: who released it and the reason given): "Resume", prefilled with what it last ran on (the mill, free again).
  const adminName = (await admin.from("user_profiles").select("full_name").eq("id", w.tenants.alpha.users.admin.id).single()).data!.full_name as string;
  await expect(row(page, jobB).getByTestId("job-progress")).toHaveText(`Stopped by ${adminName}: Forgotten after the shift`);
  await expect(playControl(row(page, jobB), jobB)).toHaveAccessibleName(`Resume ${jobB}`);
  await playControl(row(page, jobB), jobB).click();
  await expect(row(page, jobB).getByTestId("job-in-use")).toContainText(millName);
  await confirmPause(page, pauseControl(row(page, jobB), jobB));
  await expect(page.getByText(`${jobB} paused: ${millName} freed.`)).toBeVisible();
  await expect(row(page, jobB).getByTestId("job-in-use")).toHaveCount(0);
  // Wait for the control to read Resume before pressing it: playControl also matches Pause, which now asks "Are you sure?" first.
  await expect(playControl(row(page, jobB), jobB)).toHaveAccessibleName(`Resume ${jobB}`);
  await playControl(row(page, jobB), jobB).click();
  await expect(row(page, jobB).getByTestId("job-in-use")).toContainText(millName);
  await confirmFinish(page, row(page, jobB).getByRole("button", { name: "Finish", exact: true }));
  await expect(page.getByText(/Job finished/)).toBeVisible();
  const { data: bRuns } = await admin.from("machine_runs").select("end_reason").eq("job_id", ids[jobB]).order("started_at");
  expect(bRuns!.map((r) => r.end_reason)).toEqual(["admin_released", "paused", "finished"]);
  expect((await admin.from("machine_runs").select("id").eq("machine_id", mill).is("ended_at", null)).data).toEqual([]);
});

test("offline: a Start with a machine queues on the device and syncs through start_machine_run; a machine taken meanwhile is surfaced, the job still started", async ({ page }) => {
  const admin = adminClient();
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await expect(row(page, jobC).getByTestId("job-machines")).toContainText(latheName); // the plan and the machines are now on the device
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  // C on the lathe, E on the mill, both queued.
  for (const [no, machine] of [[jobC, latheName], [jobE, millName]] as const) {
    // The free planned machine is preselected (from the device's copy): Play queues the Start.
    await expect(row(page, no).getByRole("button", { name: `Choose where ${no} runs: ${machine}` })).toBeVisible();
    await playControl(row(page, no), no).click();
    await expect(page.getByText(`${no} started on ${machine} on this device. It will sync when you're back online.`)).toBeVisible();
    await expect(row(page, no).getByTestId("run-waiting")).toHaveText(`Running on ${machine}, waiting to sync`);
  }
  await expect(page.getByText("2 changes waiting to sync.")).toBeVisible();
  expect((await admin.from("machine_runs").select("id").in("job_id", [ids[jobC], ids[jobE]])).data).toEqual([]);

  // Meanwhile the office starts D on the lathe.
  const office = await signedInClient(w.tenants.alpha.users.office);
  const taken = await office.rpc("start_machine_run", { p_job: ids[jobD], p_machines: [lathe], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null });
  expect(taken.error).toBeNull();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText("1 offline change needs attention")).toBeVisible();
  // E applied: a run on the mill by Dave. C: started (the plain update), no run, the conflict says why.
  const { data: eRuns } = await admin.from("machine_runs").select("machine_id, operator_id, ended_at").eq("job_id", ids[jobE]);
  expect(eRuns).toEqual([{ machine_id: mill, operator_id: w.tenants.alpha.users.workshop.id, ended_at: null }]);
  expect((await admin.from("machine_runs").select("id").eq("job_id", ids[jobC])).data).toEqual([]);
  expect((await admin.from("jobs").select("started_at").eq("id", ids[jobC]).single()).data!.started_at).not.toBeNull();
  expect((await admin.from("machine_runs").select("job_id").eq("machine_id", lathe).is("ended_at", null)).data).toEqual([{ job_id: ids[jobD] }]);
  await page.getByText("1 offline change needs attention").click();
  await expect(page.getByText(`${jobC} was started while you were offline, but when it synced the machine was already in use: ${latheName} is in use by`)).toBeVisible();
  await expect(page.getByText(new RegExp(`is in use by .* on ${jobD} since`))).toBeVisible();
  // Tidy: free the machines for the other specs.
  expect((await office.rpc("pause_machine_run", { p_job: ids[jobD], p_machines: null, p_client_op_id: null, p_ended_at: null })).error).toBeNull();
  expect((await office.rpc("pause_machine_run", { p_job: ids[jobE], p_machines: null, p_client_op_id: null, p_ended_at: null })).error).toBeNull();
});
