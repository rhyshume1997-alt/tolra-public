/**
 * My jobs: Open drawing and Problem (migration 117), end to end in the browser.
 *
 *   - Open drawing opens the job's CURRENT drawing revision (the one the Job Board's Worksheet dialog lists as current), never the revision an
 *     upload replaced; a job with no drawing says so and opens nothing.
 *   - The operator taps Problem on My jobs, picks a reason, adds a note and sends: the card carries a Problem tag and a flag in words; the Job
 *     Board shows a Problem tag on that job's row; a report with no connection says "Reporting a problem needs a connection" and saves nothing.
 *   - The admin sees "Problems reported" in Needs attention, opens the jobs with a problem from View all, clears it from the job's worksheet with a
 *     note; the tag and the Needs attention item go; both events are in the job's activity.
 *
 * Runs in its own company (createSoloTenant) with its own workshop user, drawings and jobs, so nothing here shows on another spec's board.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, createSoloTenant, EMAIL_DOMAIN, type SyntheticUser } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
// 1x1 PNG: the drawings bucket accepts image/png.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let org = "";
let operator: SyntheticUser;
let admin: SyntheticUser;
const J = { run: "", nodrawing: "" };
const ids: Record<string, string> = {};
const NOTE = "Spindle alarm on the Haas";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const db = adminClient();
  const solo = await createSoloTenant(w.runId, `problems-${randomUUID().slice(0, 6)}`);
  org = solo.id;
  admin = solo.admin;
  const email = `operator.problems.${randomUUID().slice(0, 6)}.${w.runId}@${EMAIL_DOMAIN}`;
  const password = generatePassword(16);
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Pat Operator" } });
  expect(created.error).toBeNull();
  operator = { id: created.data.user!.id, email, password, role: "workshop" };
  const added = await db.rpc("add_member", { p_org: org, p_email: email, p_role: "workshop" });
  expect(added.error).toBeNull();
  J.run = `J-PBRUN-${w.runId}`;
  J.nodrawing = `J-PBNONE-${w.runId}`;
  for (const [no, customer, description] of [[J.run, "Severn Valve Co", "Valve body"], [J.nodrawing, "Aldridge Hydraulics Ltd", "Gland nut"]]) {
    const { data, error } = await db.from("jobs").insert({ organization_id: org, job_no: no, customer, description, quantity_required: 4, stage: "machining", assigned_to: operator.id }).select("id").single();
    expect(error).toBeNull();
    ids[no] = data!.id as string;
  }

  // Two revisions of one drawing: revision A (replaced) and revision C (current), both really stored, so a signed link can be made for either.
  const stamp = Date.now();
  const pathA = `${org}/${ids[J.run]}/${stamp}-bracket-rev-a.png`;
  const pathC = `${org}/${ids[J.run]}/${stamp + 1}-bracket-rev-c.png`;
  for (const path of [pathA, pathC]) expect((await db.storage.from("job-drawings").upload(path, PNG, { contentType: "image/png" })).error).toBeNull();
  const current = await db.from("job_files").insert({ organization_id: org, job_id: ids[J.run], kind: "drawing", ref: "bracket", revision: "C", file_name: "bracket-rev-c.png", storage_bucket: "job-drawings", storage_path: pathC, created_at: new Date(stamp + 2000).toISOString() }).select("id").single();
  expect(current.error).toBeNull();
  const replaced = await db.from("job_files").insert({ organization_id: org, job_id: ids[J.run], kind: "drawing", ref: "bracket", revision: "A", file_name: "bracket-rev-a.png", storage_bucket: "job-drawings", storage_path: pathA, superseded_at: new Date(stamp + 2000).toISOString(), superseded_by: current.data!.id, created_at: new Date(stamp - 5000).toISOString() });
  expect(replaced.error).toBeNull();
});

const card = (page: Page, no: string) => page.locator(`[data-testid="my-job"][data-job-id="${ids[no]}"]`);
const problemRows = async (jobId: string) => (await adminClient().from("job_problems").select("*").eq("job_id", jobId).order("reported_at")).data ?? [];
const height = async (locator: Locator) => (await locator.boundingBox())!.height;
/** Every window.open on this page is recorded (and not opened), so the link the tap made can be read. */
const recordOpens = (page: Page) => page.addInitScript(() => {
  (window as unknown as { __opened: string[] }).__opened = [];
  window.open = ((url?: string | URL) => { (window as unknown as { __opened: string[] }).__opened.push(String(url)); return null; }) as typeof window.open;
});
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? []);

test("Open drawing opens the current revision the worksheet marks, not the one it replaced; no drawing says so", async ({ page }) => {
  await recordOpens(page);
  await signIn(page, operator);
  const run = card(page, J.run);
  await expect(run).toBeVisible();
  const open = run.getByTestId("my-job-drawing");
  expect(await height(open), "Open drawing at least 48 px tall").toBeGreaterThanOrEqual(48);
  await open.click();
  await expect.poll(() => opened(page)).toHaveLength(1);
  const [url] = await opened(page);
  expect(url).toContain(`/job-drawings/${org}/${ids[J.run]}/`);
  expect(url).toContain("bracket-rev-c.png");
  expect(url).not.toContain("bracket-rev-a.png");
  await expect(run.getByTestId("my-job-drawing-note")).toHaveCount(0);

  // The Job Board's Worksheet dialog lists the same one, marked as the current revision.
  await page.goto("/jobs");
  await page.getByRole("row").filter({ hasText: J.run }).getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${J.run}` });
  await expect(sheet.getByRole("listitem").filter({ hasText: "bracket-rev-c.png" })).toContainText("RevC");
  await expect(sheet.getByText("(replaces A)")).toBeVisible();
  await expect(sheet.getByText("bracket-rev-a.png", { exact: true })).toHaveCount(0);

  // A job with no drawing says so, and nothing is opened.
  await page.keyboard.press("Escape");
  await page.goto("/dashboard");
  const none = card(page, J.nodrawing);
  await none.getByTestId("my-job-drawing").click();
  await expect(none.getByTestId("my-job-drawing-note")).toHaveText("No drawing is attached to this job.");
  expect(await opened(page)).toEqual([]);
});

test("the operator reports a Problem from My jobs; the card and the Job Board show it in words; with no connection nothing is saved", async ({ page, context }) => {
  await signIn(page, operator);
  const run = card(page, J.run);
  const problem = run.getByTestId("my-job-problem");
  await expect(problem).toBeVisible();
  expect(await height(problem), "Problem at least 48 px tall").toBeGreaterThanOrEqual(48);
  await expect(run.getByTestId("my-job-problem-flag")).toHaveCount(0);

  await problem.click();
  const form = run.getByTestId("my-job-problem-form");
  await form.getByTestId("my-job-problem-reason").selectOption("machine");
  await form.getByTestId("my-job-problem-note").fill(NOTE);
  expect(await height(form.getByTestId("my-job-problem-send")), "Report problem at least 48 px tall").toBeGreaterThanOrEqual(48);
  await form.getByTestId("my-job-problem-send").click();
  await expect(run.getByTestId("my-job-problem-flag")).toContainText("Problem reported: Machine. Waiting for the office.");
  await expect(run.getByTestId("my-job-problem-tag")).toHaveText("Problem");
  await expect(run.getByTestId("my-job-problem-form")).toHaveCount(0);
  await expect(card(page, J.nodrawing).getByTestId("my-job-problem-tag")).toHaveCount(0);
  const [saved, ...others] = await problemRows(ids[J.run]);
  expect(others).toEqual([]);
  expect(saved).toMatchObject({ organization_id: org, reason: "machine", note: NOTE, status: "open", reported_by: operator.id });
  // Nothing about the job changed: it can still be started, paused and finished from the board as before.
  await expect(run.getByTestId("my-job-action")).toHaveText("Start on the Job Board");

  // The Job Board shows the Problem tag on that job, and on no other.
  await run.getByTestId("my-job-action").click();
  await expect(page).toHaveURL(new RegExp(`/jobs\\?job=${ids[J.run]}$`));
  await expect(page.locator(`[data-job-id="${ids[J.run]}"]:visible`).first().getByTestId("problem-tag")).toHaveText("Problem");
  await expect(page.locator(`[data-job-id="${ids[J.nodrawing]}"]:visible`).first().getByTestId("problem-tag")).toHaveCount(0);

  // No connection: the report says so and saves nothing (it is never queued).
  await page.goto("/dashboard");
  const other = card(page, J.nodrawing);
  await other.getByTestId("my-job-problem").click();
  await other.getByTestId("my-job-problem-note").fill("Offline attempt");
  await context.setOffline(true);
  try {
    await other.getByTestId("my-job-problem-send").click();
    await expect(other.getByTestId("my-job-problem-error")).toHaveText("Reporting a problem needs a connection");
  } finally {
    await context.setOffline(false);
  }
  expect(await problemRows(ids[J.nodrawing])).toEqual([]);
  await expect(other.getByTestId("my-job-problem-tag")).toHaveCount(0);
});

test("the admin sees Problems reported in Needs attention, clears it from the worksheet with a note, and the history keeps both", async ({ page }) => {
  await signIn(page, admin);
  const attention = page.getByTestId("needs-attention");
  await expect(attention.getByTestId("attention-count-jobs-problems")).toHaveText("1");
  await expect(attention.getByTestId("attention-jobs-problems")).toContainText(`Job ${J.run} has a problem: Machine: ${NOTE}`);
  await expect(attention.getByTestId("attention-jobs-problems")).toContainText("Severn Valve Co (reported today)");
  await attention.getByTestId("attention-jobs-problems").getByRole("link", { name: /View all/ }).click();
  await expect(page).toHaveURL(/\/jobs\?filter=problems/);
  await expect(page.getByTestId("list-filter-notice")).toBeVisible();
  await expect(page.getByText(J.run).first()).toBeVisible();
  await expect(page.getByText(J.nodrawing)).toHaveCount(0);

  await page.getByRole("row").filter({ hasText: J.run }).getByRole("button", { name: "Worksheet" }).click();
  const sheet = page.getByRole("dialog", { name: `Worksheet - ${J.run}` });
  const panel = sheet.getByTestId("job-problems");
  await expect(panel).toContainText(`Machine: ${NOTE}`);
  await expect(panel).toContainText("Reported by");
  await expect(panel).toContainText("Waiting for the office.");
  expect(await height(panel.getByTestId("job-problem-resolve")), "Mark resolved at least 48 px tall").toBeGreaterThanOrEqual(48);
  // A note is needed.
  await panel.getByTestId("job-problem-resolve").click();
  await expect(panel.getByRole("alert")).toContainText("Say what was done");
  expect((await problemRows(ids[J.run]))[0]).toMatchObject({ status: "open" });
  await panel.getByTestId("job-problem-note").fill("Spindle reset and tested");
  await panel.getByTestId("job-problem-resolve").click();
  await expect(page.getByText("Problem resolved.")).toBeVisible();
  await expect(sheet.getByTestId("job-problems")).toHaveCount(0);
  expect((await problemRows(ids[J.run]))[0]).toMatchObject({ status: "resolved", resolved_by: admin.id, resolution_note: "Spindle reset and tested" });

  // Both events are in the job's activity.
  await sheet.getByRole("button", { name: /Activity/ }).click();
  await expect(sheet.getByText("Problem reported", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Problem resolved", { exact: true })).toBeVisible();
  await expect(sheet.getByText("What was done: Spindle reset and tested")).toBeVisible();
  await expect(sheet.getByText(`Note: ${NOTE}`)).toBeVisible();

  // The tag and the Needs attention item are gone.
  await page.keyboard.press("Escape");
  await page.goto("/jobs");
  await expect(page.locator(`[data-job-id="${ids[J.run]}"]:visible`).first().getByTestId("problem-tag")).toHaveCount(0);
  await page.goto("/dashboard");
  await expect(page.getByTestId("needs-attention")).toBeVisible();
  await expect(page.getByTestId("attention-jobs-problems")).toHaveCount(0);
});
