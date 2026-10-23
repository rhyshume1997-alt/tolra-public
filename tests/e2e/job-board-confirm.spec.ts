/**
 * Job Board: a single job's Pause and Finish ask first ("Pause J-1?" / "Finish J-1?", Cancel and "Pause job" / "Finish job").
 * Nothing is sent or queued until the confirm: Cancel (and Escape) send no request. Offline, the same confirm, then the change queues once
 * and syncs once. The dialog has a title and takes focus.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { pauseControl, playJob, signIn, world } from "./helpers";

const w = world();
let org = "";
const J: Record<string, string> = {};
const ids: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  const admin = adminClient();
  for (const key of ["pause", "finish", "offPause", "offFinish"]) {
    J[key] = `J-JC${key.toUpperCase()}-${w.runId}`;
    const found = (await admin.from("jobs").select("id").eq("organization_id", org).eq("job_no", J[key]).maybeSingle()).data;
    ids[key] = found ? (found.id as string) : ((await admin.from("jobs").insert({ organization_id: org, job_no: J[key], customer: "Confirm Co", description: `Confirm ${key}` }).select("id").single()).data!.id as string);
  }
});

const row = (page: Page, key: string) => page.locator(`tr[data-job-id="${ids[key]}"]`);
const finishButton = (page: Page, key: string) => row(page, key).getByRole("button", { name: "Finish", exact: true });
const runsOf = async (key: string) => (await adminClient().from("machine_runs").select("end_reason").eq("job_id", ids[key]).order("started_at")).data!.map((r) => r.end_reason as string | null);
const finishedAt = async (key: string) => (await adminClient().from("jobs").select("finished_at").eq("id", ids[key]).single()).data!.finished_at as string | null;
const auditCount = (key: string, action: string) => withDb(async (db) => (await db.query("select count(*)::int as c from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2", [ids[key], action])).rows[0].c as number);
const goOffline = async (page: Page) => { for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await page.route(pattern, (route) => route.abort("internetdisconnected")); };
const goOnline = async (page: Page) => { await page.unrouteAll({ behavior: "ignoreErrors" }); await page.evaluate(() => window.dispatchEvent(new Event("online"))); };
/** Counts the requests that would pause or finish (online or aborted offline), by the rpc's name. */
function countRpc(page: Page, name: "pause_machine_run" | "finish_job") {
  const seen: string[] = [];
  page.on("request", (request) => { if (request.url().includes(`/rpc/${name}`)) seen.push(request.url()); });
  return seen;
}

test("Pause: the dialog names the job and takes focus; Cancel and Escape send nothing; Confirm pauses once", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await playJob(page, row(page, "pause"), J.pause, { bench: true });
  await expect(pauseControl(row(page, "pause"), J.pause)).toBeVisible();
  const sent = countRpc(page, "pause_machine_run");
  const dialog = page.getByRole("dialog", { name: `Pause ${J.pause}?` });

  await pauseControl(row(page, "pause"), J.pause).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Are you sure you want to pause this job?");
  await expect(dialog.getByRole("button", { name: "Pause job", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await pauseControl(row(page, "pause"), J.pause).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(500);
  expect(sent).toHaveLength(0);
  expect(await runsOf("pause")).toEqual([null]); // still running

  await pauseControl(row(page, "pause"), J.pause).click();
  await dialog.getByRole("button", { name: "Pause job", exact: true }).click();
  await expect(page.getByText(`${J.pause} paused.`)).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(await runsOf("pause")).toEqual(["paused"]);
});

test("Finish: Cancel and Escape send nothing; Confirm finishes once", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await playJob(page, row(page, "finish"), J.finish, { bench: true });
  await expect(pauseControl(row(page, "finish"), J.finish)).toBeVisible();
  const sent = countRpc(page, "finish_job");
  const dialog = page.getByRole("dialog", { name: `Finish ${J.finish}?` });

  await finishButton(page, "finish").click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Are you sure you want to finish this job?");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await finishButton(page, "finish").click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(500);
  expect(sent).toHaveLength(0);
  expect(await finishedAt("finish")).toBeNull();

  await finishButton(page, "finish").click();
  await dialog.getByRole("button", { name: "Finish job", exact: true }).click();
  await expect(page.getByText("Job finished: Waiting for inspection")).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(await finishedAt("finish")).not.toBeNull();
});

test("offline Pause: Cancel queues nothing; Confirm queues once and syncs once", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await playJob(page, row(page, "offPause"), J.offPause, { bench: true });
  await expect(pauseControl(row(page, "offPause"), J.offPause)).toBeVisible();
  await goOffline(page);
  const dialog = page.getByRole("dialog", { name: `Pause ${J.offPause}?` });
  await pauseControl(row(page, "offPause"), J.offPause).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/changes? waiting to sync/)).toHaveCount(0);

  await pauseControl(row(page, "offPause"), J.offPause).click();
  await dialog.getByRole("button", { name: "Pause job", exact: true }).click();
  await expect(page.getByText(`${J.offPause} paused on this device. It will sync when you're back online.`)).toBeVisible();
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();
  expect(await runsOf("offPause")).toEqual([null]); // not on the server yet
  await goOnline(page);
  await expect.poll(() => runsOf("offPause"), { timeout: 20_000 }).toEqual(["paused"]);
  await expect(page.getByText(/changes? waiting to sync/)).toHaveCount(0);
  expect(await auditCount("offPause", "PAUSE_MACHINE_RUN")).toBe(1);
});

test("offline Finish: Cancel queues nothing; Confirm queues once and syncs once", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await playJob(page, row(page, "offFinish"), J.offFinish, { bench: true });
  await expect(pauseControl(row(page, "offFinish"), J.offFinish)).toBeVisible();
  await goOffline(page);
  const dialog = page.getByRole("dialog", { name: `Finish ${J.offFinish}?` });
  await finishButton(page, "offFinish").click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/changes? waiting to sync/)).toHaveCount(0);

  await finishButton(page, "offFinish").click();
  await dialog.getByRole("button", { name: "Finish job", exact: true }).click();
  await expect(page.getByText("on this device. It will sync when you're back online.")).toBeVisible();
  await expect(page.getByText("1 change waiting to sync.")).toBeVisible();
  expect(await finishedAt("offFinish")).toBeNull();
  await goOnline(page);
  await expect.poll(() => finishedAt("offFinish"), { timeout: 20_000 }).not.toBeNull();
  await expect(page.getByText(/changes? waiting to sync/)).toHaveCount(0);
});
