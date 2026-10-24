/**
 * Job Board Play/Pause (migration 049; plan docs/packets/job-board-ux-plan.md, 2.1 to 2.6, R2.2 to R2.4, R3.1 to R3.4), in the browser:
 *
 *   * workshop: ticks Mill and Lathe, Play, amber Pause, both in use, Pause frees both, Resume; all planned machines busy -> "Pick a
 *     machine"; a bulk-started job shows "Started (not timed)" and Start timer opens a run with the person's own name;
 *   * a second operator picks the paused Mill: warned (cancel, then "I've checked"), recorded against the run shown;
 *   * offline order (R3.4): Start then Pause -> "Paused, waiting to sync" across a reload, one closed run with the captured times; Pause then
 *     Start on a running job -> "Running ..., waiting to sync", running after sync; a Start timer on the bench offline -> "On the bench,
 *     waiting to sync", then a bench run (not started_without_bench); another session takes the machine meanwhile -> the conflict notice,
 *     Play again, the Pause held "Not sent", the other session's run untouched;
 *   * the office assigns from the Operator column while the job runs; focus refresh shows another session's Pause;
 *   * booking over a paused machine on /schedule: confirm; re-paused in between -> asked again, confirmed with a new key;
 *   * viewer: no controls; a disabled tap says why; phone (390 px, coarse pointer): the bottom-sheet picker, Play and Pause.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import { VIEWPORTS, deviceContext } from "../support/ui-pr1-screenshots";
import { adminClient, EMAIL_DOMAIN, signedInClient, withDb } from "../support/fixtures";
import { generatePassword } from "@/lib/password";
import { confirmPause, pauseControl, pickMachines, playControl, playJob, signIn, world } from "./helpers";

const w = world();
let org = "";
let millName = "";
let latheName = "";
let mill = "";
let lathe = "";
const ids: Record<string, string> = {};
const J: Record<string, string> = {};
let workshopName: string | null | undefined;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  millName = `JB Mill ${w.runId}`;
  latheName = `JB Lathe ${w.runId}`;
  for (const key of ["multi", "second", "busy", "bulk", "bulkOff", "offSP", "offPS", "clash", "book", "focus", "phone"]) J[key] = `J-JB${key.toUpperCase()}-${w.runId}`;
  const admin = adminClient();
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  mill = await one("machines", "name", millName, { name: millName, active: true });
  lathe = await one("machines", "name", latheName, { name: latheName, active: true });
  for (const no of Object.values(J)) ids[no] = await one("jobs", "job_no", no, { job_no: no, customer: "Play Co", description: `Play ${no}` });
  const plan = async (job: string, machine: string) => {
    const found = (await admin.from("job_machines").select("id").eq("job_id", job).eq("machine_id", machine).maybeSingle()).data;
    if (!found) await admin.from("job_machines").insert({ organization_id: org, job_id: job, machine_id: machine, estimated_hours: 2 });
  };
  await plan(ids[J.multi], mill);
  await plan(ids[J.multi], lathe);
  await plan(ids[J.busy], mill);
  await plan(ids[J.clash], lathe);
  // Bulk-started (a start time, no runs): "Started (not timed)".
  await admin.from("jobs").update({ started_at: new Date(Date.now() - 3_600_000).toISOString() }).in("id", [ids[J.bulk], ids[J.bulkOff]]);
  const before = (await admin.from("user_profiles").select("full_name").eq("id", w.tenants.alpha.users.workshop.id).single()).data!.full_name as string | null;
  workshopName = before === "Dave Operator" ? "Workshop alpha" : before;
  await admin.from("user_profiles").update({ full_name: "Dave Operator" }).eq("id", w.tenants.alpha.users.workshop.id);
});

test.afterAll(async () => {
  // Free both machines for later specs, and put the shared workshop user's name back.
  const office = await signedInClient(w.tenants.alpha.users.office);
  for (const id of Object.values(ids)) await office.rpc("pause_machine_run", { p_job: id, p_machines: null, p_client_op_id: null, p_ended_at: null });
  if (workshopName !== undefined) await adminClient().from("user_profiles").update({ full_name: workshopName }).eq("id", w.tenants.alpha.users.workshop.id);
});

const row = (page: Page, no: string) => page.locator(`tr[data-job-id="${ids[no]}"]`);
const runsOf = async (no: string) => (await adminClient().from("machine_runs").select("id, machine_id, operator_id, started_at, ended_at, end_reason").eq("job_id", ids[no]).order("started_at").order("created_at")).data!;
const goOffline = async (page: Page) => { for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected")); };
const goOnline = async (page: Page) => { await page.unrouteAll({ behavior: "ignoreErrors" }); await page.evaluate(() => window.dispatchEvent(new Event("online"))); };
const audit = async (no: string, action: string) => (await withDb((db) => db.query("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2 order by created_at", [ids[no], action]))).rows.map((r) => r.metadata as Record<string, unknown>);

test("workshop: Mill and Lathe ticked, Play, amber Pause frees both, Resume; all planned busy asks for a pick; Start timer on a bulk-started job", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const r = row(page, J.multi);
  // Both planned machines are free, so both are preselected; Play starts on both.
  await expect(r.getByRole("button", { name: `Choose where ${J.multi} runs: ${latheName}, ${millName}` })).toBeVisible();
  await expect(playControl(r, J.multi)).toHaveAccessibleName(`Start ${J.multi}`);
  await expect(playControl(r, J.multi)).toHaveClass(/border-\[#16A34A\]/); // Play: green outline
  await playControl(r, J.multi).click();
  await expect(page.getByText(`${J.multi} started on ${latheName}, ${millName}.`)).toBeVisible();
  await expect(pauseControl(r, J.multi)).toHaveAccessibleName(`Pause ${J.multi}, stops the job and frees ${latheName}, ${millName}`);
  await expect(pauseControl(r, J.multi)).toHaveClass(/bg-amber-500/);
  await expect(r.getByTestId("job-in-use")).toContainText(millName);
  await expect(r.getByTestId("job-in-use")).toContainText(latheName);
  expect((await runsOf(J.multi)).filter((x) => !x.ended_at).map((x) => x.machine_id).sort()).toEqual([mill, lathe].sort());

  // The Start is finished only once its refresh is back (Starting... gone, the board's pickers enabled again): until then Play on another
  // job says "Wait for the last change to finish." and opens nothing, by design (jobs/page.tsx play()).
  const busy = row(page, J.busy);
  await expect(pauseControl(r, J.multi)).not.toHaveAttribute("aria-busy", "true");
  await expect(busy.getByRole("button", { name: `Choose where ${J.busy} runs: Pick a machine` })).toBeEnabled();

  // Another job planned only on the mill: nothing free, so Play says "Pick a machine" and opens the picker.
  await expect(playControl(busy, J.busy)).toContainText("Pick a machine");
  await expect(playControl(busy, J.busy)).toHaveAttribute("aria-disabled", "true");
  // Play is aria-disabled here, so the click needs force, which also skips Playwright's "receives events" check: a force click whose
  // centre sits under the "J-JBMULTI started" toast (top right, 8 s) lands on the toast and opens nothing. Put that one check back: the
  // tap must hit Play itself. Then prove play() took the open-the-picker branch (its toast), not the "Wait for the last change" guard.
  const pickPlay = playControl(busy, J.busy);
  await pickPlay.scrollIntoViewIfNeeded();
  await expect.poll(() => pickPlay.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit ? (el.contains(hit) ? "play" : `covered by ${hit.closest("[data-sonner-toast]") ? "a toast" : `${hit.tagName.toLowerCase()} ${(hit.textContent ?? "").trim().slice(0, 60)}`}`) : "off screen";
  }), { message: `nothing covers ${J.busy}'s Play before the forced tap`, timeout: 20_000 }).toBe("play");
  await pickPlay.click({ force: true });
  await expect(page.getByText(`${J.busy}: pick a machine, or No machine (bench), then press Play.`)).toBeVisible();
  const picker = page.locator('[data-testid="machine-picker"]:visible');
  await expect(picker.getByTestId("picker-machine").filter({ hasText: millName }).getByTestId("picker-in-use")).toContainText(`In use: ${J.multi}, Dave Operator`);
  await expect(picker.getByLabel(`Start on ${millName}`)).toBeDisabled();
  await page.keyboard.press("Escape");

  // Pause frees both machines; the job's time stops; Resume (prefilled with both) starts again.
  await confirmPause(page, pauseControl(r, J.multi));
  await expect(page.getByText(`${J.multi} paused: ${latheName}, ${millName} freed.`)).toBeVisible();
  await expect(r.getByTestId("job-in-use")).toHaveCount(0);
  expect((await runsOf(J.multi)).every((x) => x.end_reason === "paused")).toBe(true);
  await expect(playControl(r, J.multi)).toHaveAccessibleName(`Resume ${J.multi}`);
  // The status chip says Paused (not Running) while the job is paused.
  await expect(r.getByTestId("job-status").first()).toContainText("Paused");
  await expect(r.getByTestId("job-status").first()).not.toContainText("Running");
  await expect(r.getByTestId("paused-by")).toContainText("Paused by Dave Operator");
  await playControl(r, J.multi).click();
  await expect(pauseControl(r, J.multi)).toBeVisible();
  await confirmPause(page, pauseControl(r, J.multi));
  await expect(playControl(r, J.multi)).toHaveAccessibleName(`Resume ${J.multi}`);

  // Bulk-started: "Started (not timed)"; Start timer on the bench opens a run for this person, from now; the start time is kept.
  const bulk = row(page, J.bulk);
  await expect(bulk.getByTestId("job-progress")).toHaveText("Started (not timed)");
  const startedBefore = (await adminClient().from("jobs").select("started_at").eq("id", ids[J.bulk]).single()).data!.started_at;
  await playJob(page, bulk, J.bulk, { bench: true });
  await expect(page.getByText(`${J.bulk} started on the bench.`)).toBeVisible();
  const bench = await runsOf(J.bulk);
  expect(bench).toEqual([expect.objectContaining({ machine_id: null, operator_id: w.tenants.alpha.users.workshop.id, ended_at: null })]);
  expect((await adminClient().from("jobs").select("started_at").eq("id", ids[J.bulk]).single()).data!.started_at).toBe(startedBefore);
});

test("a second operator picks the paused Mill: warned (cancel, then I've checked), recorded against the run shown", async ({ page }) => {
  const pausedRun = (await runsOf(J.multi)).filter((x) => x.machine_id === mill).at(-1)!;
  expect(pausedRun.end_reason).toBe("paused");
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  const r = row(page, J.second);
  await r.getByRole("button", { name: new RegExp(`^Choose where ${J.second} runs`) }).click();
  const picker = page.locator('[data-testid="machine-picker"]:visible');
  await expect(picker.getByTestId("picker-machine").filter({ hasText: millName }).getByTestId("picker-paused")).toContainText(`Paused: ${J.multi}, Dave Operator`);
  await picker.getByLabel(`Start on ${millName}`).check();
  await page.keyboard.press("Escape");
  await playControl(r, J.second).click();
  const dialog = page.getByTestId("paused-machine-dialog");
  await expect(dialog.getByTestId("paused-warning")).toContainText(`${millName} was paused on ${J.multi} by Dave Operator`);
  await expect(dialog.getByTestId("paused-warning")).toContainText(`Check with Dave Operator before using the ${millName}`);
  await expect(dialog.getByTestId("paused-warning")).toHaveAttribute("data-run-id", pausedRun.id);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await runsOf(J.second)).toEqual([]);
  await playControl(r, J.second).click();
  await dialog.getByRole("button", { name: `I've checked, use the ${millName}` }).click();
  await expect(page.getByText(`${J.second} started on ${millName}.`)).toBeVisible();
  expect(await audit(J.second, "START_OVER_PAUSED_JOB")).toEqual([expect.objectContaining({ paused_run_id: pausedRun.id, acknowledged: true, superseded: false, actor_user_id: w.tenants.alpha.users.office.id })]);
  // The office assigns from the Operator column while the job runs.
  await r.getByLabel(`Assign ${J.second}`).selectOption({ label: "Dave Operator" });
  await expect(r.getByTestId("job-operator")).toHaveText("Dave Operator");
  await expect(r.getByTestId("on-it-now")).toContainText("On it now:"); // the office started it, Dave is assigned
  await confirmPause(page, pauseControl(r, J.second));
  await expect(playControl(r, J.second)).toBeVisible();
});

test("offline: Start then Pause shows 'Paused, waiting to sync' across a reload; reconnect: one closed run with the captured times", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const r = () => row(page, J.offSP);
  await expect(r()).toBeVisible();
  await goOffline(page);
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await playJob(page, r(), J.offSP, { bench: true });
  await expect(page.getByText(`${J.offSP} started on the bench on this device. It will sync when you're back online.`)).toBeVisible();
  await expect(r().getByTestId("run-waiting")).toHaveText("On the bench, waiting to sync");
  await confirmPause(page, pauseControl(r(), J.offSP));
  await expect(r().getByTestId("run-waiting")).toHaveText("Paused, waiting to sync");
  await expect(playControl(r(), J.offSP)).toHaveAccessibleName(`Resume ${J.offSP}`);
  await page.reload();
  await expect(r().getByTestId("run-waiting")).toHaveText("Paused, waiting to sync");
  await expect(page.getByText("2 changes waiting to sync.")).toBeVisible();
  const queued = await page.evaluate(() => new Promise<{ at: string; kind: string }[]>((resolve, reject) => {
    const open = indexedDB.open("tolra-offline", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const store = open.result.transaction("kv", "readonly").objectStore("kv");
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        const key = (keys.result as string[]).find((k) => k.endsWith("|outbox"));
        const get = store.get(key!);
        get.onsuccess = () => resolve((get.result as { op: { at: string; kind: string } }[]).map((e) => ({ at: e.op.at, kind: e.op.kind })));
      };
    };
  }));
  expect(queued.map((q) => q.kind)).toEqual(["run_start", "run_pause"]);
  await goOnline(page);
  await expect.poll(async () => (await runsOf(J.offSP)).map((x) => x.end_reason), { timeout: 20_000 }).toEqual(["paused"]);
  const [run] = await runsOf(J.offSP);
  expect([new Date(run.started_at).toISOString(), new Date(run.ended_at!).toISOString()]).toEqual([queued[0].at, queued[1].at]);
  await expect(page.getByText("2 changes waiting to sync.")).toHaveCount(0);
});

test("offline: Pause then Start on a running job shows 'Running on the mill, waiting to sync' across a reload; reconnect: running", async ({ page }) => {
  const workshop = await signedInClient(w.tenants.alpha.users.workshop);
  expect((await workshop.rpc("start_machine_run", { p_job: ids[J.offPS], p_machines: [lathe], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null })).error).toBeNull();
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const r = () => row(page, J.offPS);
  await expect(pauseControl(r(), J.offPS)).toBeVisible(); // the live state is now on the device
  await goOffline(page);
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await confirmPause(page, pauseControl(r(), J.offPS));
  await expect(r().getByTestId("run-waiting")).toHaveText("Paused, waiting to sync");
  await playControl(r(), J.offPS).click(); // prefilled with what it ran on (the lathe)
  await expect(r().getByTestId("run-waiting")).toHaveText(`Running on ${latheName}, waiting to sync`);
  await page.reload();
  await expect(r().getByTestId("run-waiting")).toHaveText(`Running on ${latheName}, waiting to sync`);
  await expect(pauseControl(r(), J.offPS)).toBeVisible();
  await goOnline(page);
  await expect.poll(async () => (await runsOf(J.offPS)).map((x) => x.end_reason), { timeout: 20_000 }).toEqual(["paused", null]);
  await expect(r().getByTestId("run-waiting")).toHaveCount(0);
  await expect(pauseControl(r(), J.offPS)).toBeVisible();
  await confirmPause(page, pauseControl(r(), J.offPS));
});

test("offline Start timer on the bench of a bulk-started job: 'On the bench, waiting to sync', then a bench run (not started_without_bench)", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const r = () => row(page, J.bulkOff);
  await expect(r().getByTestId("job-progress")).toHaveText("Started (not timed)");
  await goOffline(page);
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await expect(playControl(r(), J.bulkOff)).toHaveAccessibleName(`Start timer ${J.bulkOff}`);
  await playJob(page, r(), J.bulkOff, { bench: true });
  await expect(r().getByTestId("run-waiting")).toHaveText("On the bench, waiting to sync");
  await goOnline(page);
  await expect.poll(async () => (await runsOf(J.bulkOff)).map((x) => [x.machine_id, x.end_reason]), { timeout: 20_000 }).toEqual([[null, null]]);
  expect(await audit(J.bulkOff, "START_MACHINE_RUN")).toEqual([expect.objectContaining({ bench_requested: true })]);
});

test("another session takes the lathe while this one is offline: conflict notice and Play; the Pause after it is held 'Not sent'; their run stays open", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const r = () => row(page, J.clash);
  await expect(r().getByRole("button", { name: `Choose where ${J.clash} runs: ${latheName}` })).toBeVisible();
  await goOffline(page);
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  await playControl(r(), J.clash).click();
  // The lathe's last run was paused on another unfinished job (the previous test): the check comes first, offline too (it is queued with
  // the Start and recorded when it syncs).
  await page.getByTestId("paused-machine-dialog").getByRole("button", { name: `I've checked, use the ${latheName}` }).click();
  await expect(r().getByTestId("run-waiting")).toHaveText(`Running on ${latheName}, waiting to sync`);
  await confirmPause(page, pauseControl(r(), J.clash));
  await expect(r().getByTestId("run-waiting")).toHaveText("Paused, waiting to sync");
  // Meanwhile the office takes the lathe for another job.
  const office = await signedInClient(w.tenants.alpha.users.office);
  expect((await office.rpc("start_machine_run", { p_job: ids[J.focus], p_machines: [lathe], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null })).error).toBeNull();
  await goOnline(page);
  await expect(page.getByText("2 offline changes need attention")).toBeVisible({ timeout: 20_000 });
  await expect(playControl(r(), J.clash)).toBeVisible();
  await page.getByText("2 offline changes need attention").click();
  await expect(page.getByText(`${J.clash} was started while you were offline, but when it synced the machine was already in use`)).toBeVisible();
  await expect(page.getByText(`Not sent: the Start before it (${J.clash} on`)).toBeVisible();
  expect((await runsOf(J.clash))).toEqual([]);
  expect((await adminClient().from("machine_runs").select("job_id").eq("machine_id", lathe).is("ended_at", null)).data).toEqual([{ job_id: ids[J.focus] }]);
});

test("focus refresh: another session pauses the job; focusing the tab shows it paused", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const r = row(page, J.focus);
  await expect(pauseControl(r, J.focus)).toBeVisible(); // running on the lathe (previous test)
  const office = await signedInClient(w.tenants.alpha.users.office);
  expect((await office.rpc("pause_machine_run", { p_job: ids[J.focus], p_machines: null, p_client_op_id: null, p_ended_at: null })).error).toBeNull();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(playControl(r, J.focus)).toHaveAccessibleName(`Resume ${J.focus}`);
  await expect(r.getByTestId("job-progress")).toHaveText("Paused");
});

test("booking over a paused machine: confirm; re-paused in between, asked again and confirmed with a new key", async ({ page }) => {
  // The mill is paused on the multi job (first test). Re-paused meanwhile is made below, between the two presses.
  const workshop = await signedInClient(w.tenants.alpha.users.workshop);
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/schedule");
  await page.getByRole("button", { name: "New booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Book job onto machine" });
  await dialog.getByLabel("Job").selectOption(ids[J.book]);
  await dialog.getByLabel("Machine").selectOption({ label: millName });
  await dialog.getByLabel(/Estimated hours/).fill("2");
  const warning = dialog.getByTestId("book-paused-warning");
  await expect(warning).toContainText(`${millName} was paused on`);
  const shown = await warning.getAttribute("data-run-id");
  await expect(dialog.getByRole("button", { name: /^Book job$|^Book anyway$/ })).toBeDisabled();
  // The paused job is resumed and paused again by its operator before "I've checked" is pressed.
  const pausedJob = (await adminClient().from("machine_runs").select("job_id").eq("id", shown!).single()).data!.job_id as string;
  expect((await workshop.rpc("start_machine_run", { p_job: pausedJob, p_machines: [mill], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null })).error).toBeNull();
  expect((await workshop.rpc("pause_machine_run", { p_job: pausedJob, p_machines: null, p_client_op_id: null, p_ended_at: null })).error).toBeNull();
  await dialog.getByRole("button", { name: `I've checked, use the ${millName}` }).click();
  await expect(page.getByText(`${millName} was paused again meanwhile`)).toBeVisible();
  await expect(warning).not.toHaveAttribute("data-run-id", shown!);
  await dialog.getByRole("button", { name: `I've checked, use the ${millName}` }).click();
  await expect(dialog.getByTestId("book-paused-checked")).toBeVisible();
  await dialog.getByRole("button", { name: /^Book job$|^Book anyway$/ }).click();
  await expect(page.getByText("Job booked onto machine")).toBeVisible();
  const events = await audit(J.book, "BOOK_OVER_PAUSED_JOB");
  expect(events.map((e) => [e.acknowledged, e.superseded])).toEqual([[false, true], [true, false]]);
  expect(events[0].client_op_id).not.toBe(events[1].client_op_id);
  expect(events[0].acknowledged_run_id).toBe(shown);
});

test("viewer: no Play, Pause or picker", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.viewer);
  await page.goto("/jobs");
  await expect(row(page, J.multi)).toBeVisible();
  await expect(playControl(row(page, J.multi), J.multi)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Choose where / })).toHaveCount(0);
});

test("a disabled tap says why: Finish on a finished job says when it was finished", async ({ page }) => {
  const office = await signedInClient(w.tenants.alpha.users.office);
  expect((await office.rpc("finish_job", { p_job: ids[J.second], p_client_op_id: null, p_finished_at: null })).error).toBeNull();
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  const finished = row(page, J.second);
  await expect(finished.getByRole("button", { name: "Finished" })).toHaveAttribute("aria-disabled", "true");
  await finished.getByRole("button", { name: "Finished" }).click({ force: true });
  await expect(page.getByText(/^Finished \d\d\/\d\d\/\d{4}/)).toBeVisible(); // the reason: when it was finished
});

test("phone (390 px, coarse pointer): the bottom-sheet picker, Play on the bench and amber Pause", async ({ browser }) => {
  const context = await deviceContext(browser, VIEWPORTS[0], String(test.info().project.use.baseURL));
  const page = await context.newPage();
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const card: Locator = page.locator(`[data-testid="job-card"][data-job-no="${J.phone}"]:visible`);
  await expect(card).toBeVisible();
  await pickMachines(page, card, J.phone, { bench: true });
  await playControl(card, J.phone).tap();
  await expect(pauseControl(card, J.phone)).toBeVisible();
  const box = await pauseControl(card, J.phone).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(64); // the workshop's glove-sized target
  await confirmPause(page, pauseControl(card, J.phone), { tap: true });
  await expect(playControl(card, J.phone)).toHaveAccessibleName(`Resume ${J.phone}`);
  expect((await runsOf(J.phone)).map((x) => [x.machine_id, x.end_reason])).toEqual([[null, "paused"]]);
  await context.close();
});

// Bug 5: "Add machine" on a job that runs on the company's only machine explains itself. The other tests' machines belong to alpha, so this
// uses beta, whose other machines are retired for the length of the block (the suite runs one worker, so nothing else reads them now).
test.describe("Add machine with nothing to add", () => {
  let betaMill = "";
  let betaMillName = "";
  let betaJob = "";
  let betaJobNo = "";
  let retired: string[] = [];

  test.beforeAll(async () => {
    const admin = adminClient();
    const beta = w.tenants.beta.id;
    betaMillName = `JB Only ${w.runId}`;
    betaJobNo = `J-JBONLY-${w.runId}`;
    retired = ((await admin.from("machines").select("id").eq("organization_id", beta).eq("active", true)).data ?? []).map((m) => m.id as string);
    if (retired.length) await admin.from("machines").update({ active: false }).in("id", retired);
    betaMill = (await admin.from("machines").insert({ organization_id: beta, name: betaMillName, active: true }).select("id").single()).data!.id as string;
    betaJob = (await admin.from("jobs").insert({ organization_id: beta, job_no: betaJobNo, customer: "Only Co", description: "Only machine" }).select("id").single()).data!.id as string;
    const workshop = await signedInClient(w.tenants.beta.users.workshop);
    expect((await workshop.rpc("start_machine_run", { p_job: betaJob, p_machines: [betaMill], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null })).error).toBeNull();
  });

  test.afterAll(async () => {
    const office = await signedInClient(w.tenants.beta.users.office);
    await office.rpc("pause_machine_run", { p_job: betaJob, p_machines: null, p_client_op_id: null, p_ended_at: null });
    const admin = adminClient();
    await admin.from("machines").update({ active: false }).eq("id", betaMill);
    if (retired.length) await admin.from("machines").update({ active: true }).in("id", retired);
  });

  const reason = () => `${betaMillName} is the only machine, and this job is already on it.`;

  test("office, desk List view: the reason and a link to the Machines card on the Machine Schedule", async ({ page }) => {
    await signIn(page, w.tenants.beta.users.office);
    await page.goto("/jobs");
    const r = page.locator(`tr[data-job-id="${betaJob}"]`);
    await r.getByRole("button", { name: `Add a machine to ${betaJobNo}` }).click();
    const picker = page.getByTestId("picker-empty");
    await expect(picker).toContainText(reason());
    await expect(picker.getByTestId("picker-add-machine-link")).toHaveAttribute("href", "/schedule#machines");
    await picker.getByTestId("picker-add-machine-link").click();
    await expect(page).toHaveURL(/\/schedule#machines$/);
    await expect(page.locator("#machines")).toContainText("Machines");
    await expect(page.locator("#machines").getByRole("button", { name: "Add machine" })).toBeVisible();
  });

  test("workshop, Cards view: the reason, no link, asked to go to an admin or office", async ({ page }) => {
    await signIn(page, w.tenants.beta.users.workshop);
    await page.goto("/jobs");
    await page.getByRole("button", { name: "Cards", exact: true }).click();
    const card = page.locator(`[data-testid="job-card"][data-job-no="${betaJobNo}"]:visible`);
    await card.getByRole("button", { name: `Add a machine to ${betaJobNo}` }).click();
    const picker = page.getByTestId("picker-empty");
    await expect(picker).toContainText(reason());
    await expect(picker).toContainText("Ask an admin or office to add a machine.");
    await expect(picker.getByRole("link")).toHaveCount(0);
  });

  test("phone sheet (390 px): the reason and the link for the office", async ({ browser }) => {
    const context = await deviceContext(browser, VIEWPORTS[0], String(test.info().project.use.baseURL));
    const page = await context.newPage();
    await signIn(page, w.tenants.beta.users.office);
    await page.goto("/jobs");
    const card = page.locator(`[data-testid="job-card"][data-job-no="${betaJobNo}"]:visible`);
    await card.getByRole("button", { name: `Add a machine to ${betaJobNo}` }).tap();
    const picker = page.getByRole("dialog").getByTestId("picker-empty");
    await expect(picker).toContainText(reason());
    await expect(picker.getByTestId("picker-add-machine-link")).toBeVisible();
    await context.close();
  });

  test("office with the Machine Schedule page hidden: the reason, no link to a page they cannot open", async ({ page }) => {
    const admin = adminClient();
    const email = `nosched.beta.${w.runId}@${EMAIL_DOMAIN}`;
    const password = generatePassword(16);
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "nosched beta" } });
    if (created.error || !created.data.user) throw new Error(`createUser ${email}: ${created.error?.message}`);
    const added = await admin.rpc("add_member", { p_org: w.tenants.beta.id, p_email: email, p_role: "office" });
    if (added.error || added.data !== "member") throw new Error(`add_member ${email}: ${added.error?.message ?? added.data}`);
    const hide = await admin.from("organization_members").update({ hidden_sections: ["schedule"] }).eq("organization_id", w.tenants.beta.id).eq("user_id", created.data.user.id);
    expect(hide.error).toBeNull();
    await signIn(page, { id: created.data.user.id, email, password, role: "office" });
    await page.goto("/jobs");
    const r = page.locator(`tr[data-job-id="${betaJob}"]`);
    await r.getByRole("button", { name: `Add a machine to ${betaJobNo}` }).click();
    const picker = page.getByTestId("picker-empty");
    await expect(picker).toContainText(reason());
    await expect(picker.getByTestId("picker-add-machine-link")).toHaveCount(0);
    await expect(picker.getByRole("link")).toHaveCount(0);
  });
});
