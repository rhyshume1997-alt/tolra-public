/**
 * Parts done on a job (migration 118), in its own company (createSoloTenant) with its own workshop operator, so nothing here shows on another
 * spec's dashboard.
 *   - On My jobs the operator sees "0 of 5 parts" and a "+1 part" button at least 48 px tall; five taps give "5 of 5 parts" and the button
 *     is off, saying all the parts are logged. The log has five rows; the job itself (start, finish, stage) is untouched.
 *   - Change the count: taking parts off needs a reason (nothing is saved without one), then is a negative entry with its note; the original
 *     entries stay. The total never goes below 0 or above 5.
 *   - The Whole floor shows "Parts logged: 3 of 5 parts" on the machine the job is running on, and tells the workshop person, in words, that
 *     who is clocked in is shown to office and admin only (the count itself is unit-tested against Weekly hours: tests/unit/floor-attendance).
 *   - The Job Board's job details show the same "3 of 5 parts".
 *   - Offline: a tap says it needs a connection and saves nothing (no row, nothing queued); back online it works and adds exactly one.
 *   - Another device fills the job while this page is stale: the tap is refused in words, nothing is saved, and the count on screen is put right.
 * The database rules (RLS across two companies, roles, caps, idempotency, audit and the job's activity, verify, rollback) are in
 * tests/db/job-part-logs-118.test.ts; the clocked-in count against Weekly hours is in tests/unit/floor-attendance.test.ts.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, createSoloTenant, EMAIL_DOMAIN, type SyntheticUser } from "../support/fixtures";
import { VIEWPORTS, deviceContext } from "../support/ui-pr1-screenshots";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
const baseURL = () => String(test.info().project.use.baseURL);
const TABLET = VIEWPORTS.find((v) => v.name === "tablet")!;
const PHONE = VIEWPORTS.find((v) => v.name === "phone")!;
const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));

let org = "";
let operator: SyntheticUser;
const J = { main: "", full: "" };
const ids: Record<string, string> = {};
const names = { mill: "" };

const ok = async (p: PromiseLike<{ error: { message: string } | null }>) => expect((await p).error).toBeNull();
const card = (page: Page, no: string) => page.locator(`[data-testid="my-job"][data-job-id="${ids[no]}"]`);
const rows = async (job: string) => ((await adminClient().from("job_part_logs").select("quantity, note, logged_by").eq("job_id", ids[job]).order("logged_at")).data ?? []) as Array<{ quantity: number; note: string | null; logged_by: string }>;
const total = async (job: string) => (await rows(job)).reduce((sum, r) => sum + r.quantity, 0);
const height = async (locator: Locator) => (await locator.boundingBox())!.height;

test.beforeAll(async () => {
  const db = adminClient();
  const solo = await createSoloTenant(w.runId, `parts${Date.now().toString(36)}`);
  org = solo.id;
  const email = `operator.parts.${randomUUID().slice(0, 6)}.${w.runId}@${EMAIL_DOMAIN}`;
  const password = generatePassword(16);
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Lee Operator" } });
  expect(created.error).toBeNull();
  operator = { id: created.data.user!.id, email, password, role: "workshop" };
  const added = await db.rpc("add_member", { p_org: org, p_email: email, p_role: "workshop" });
  expect(added.error).toBeNull();
  expect(added.data).toBe("member");

  J.main = `J-PT1-${w.runId}`;
  J.full = `J-PT2-${w.runId}`;
  names.mill = `Parts Mill ${w.runId.slice(0, 6)}`;
  const startedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const jobs = [
    { job_no: J.main, customer: "Severn Valve Co", description: "Valve body", quantity_required: 5, stage: "machining", date_required: london(3), started_at: startedAt, assigned_to: operator.id },
    { job_no: J.full, customer: "Aldridge Hydraulics Ltd", description: "Gland nut", quantity_required: 3, stage: "setup", date_required: london(10), assigned_to: operator.id },
  ];
  for (const row of jobs) {
    const { data, error } = await db.from("jobs").insert({ organization_id: org, ...row }).select("id").single();
    expect(error).toBeNull();
    ids[row.job_no] = data!.id as string;
  }
  // The main job is running now on a machine, so the Whole floor shows it.
  const machine = await db.from("machines").insert({ organization_id: org, name: names.mill }).select("id").single();
  expect(machine.error).toBeNull();
  await ok(db.from("machine_runs").insert({ organization_id: org, job_id: ids[J.main], machine_id: machine.data!.id, operator_id: operator.id, started_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
});

test("My jobs: 0 of 5 parts, five taps of +1 part (48 px) give 5 of 5 and the button goes off; the job is untouched", async ({ browser }) => {
  const context = await deviceContext(browser, TABLET, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, operator);
    const job = card(page, J.main);
    await expect(job.getByTestId("my-job-parts-count")).toContainText("0 of 5 parts");
    const add = job.getByTestId("my-job-add-part");
    expect(await height(add), "+1 part at least 48 px tall").toBeGreaterThanOrEqual(48);
    expect(await height(job.getByTestId("my-job-change-count"))).toBeGreaterThanOrEqual(48);
    const jobBefore = (await adminClient().from("jobs").select("*").eq("id", ids[J.main]).single()).data;

    for (let n = 1; n <= 5; n += 1) {
      await add.click();
      await expect(job.getByTestId("my-job-parts-count")).toContainText(`${n} of 5 parts`);
    }
    await expect(add).toBeDisabled();
    await expect(job.getByTestId("my-job-parts-note")).toHaveText("All the parts are logged.");
    expect((await rows(J.main)).map((r) => r.quantity)).toEqual([1, 1, 1, 1, 1]);
    expect((await rows(J.main)).every((r) => r.logged_by === operator.id)).toBe(true);
    // Logging parts changed nothing about the job.
    expect((await adminClient().from("jobs").select("*").eq("id", ids[J.main]).single()).data).toEqual(jobBefore);
    // Start / Pause / Finish are still the Job Board's own links.
    await expect(job.getByTestId("my-job-action")).toHaveText("Finish on the Job Board");
  } finally {
    await context.close();
  }
});

test("Change the count: taking parts off needs a reason; it is a negative entry with its note and the original entries stay; never below 0", async ({ browser }) => {
  const context = await deviceContext(browser, TABLET, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, operator);
    const job = card(page, J.main);
    await expect(job.getByTestId("my-job-parts-count")).toContainText("5 of 5 parts");
    await job.getByTestId("my-job-change-count").click();
    const form = job.getByTestId("my-job-parts-form");
    await form.getByTestId("my-job-parts-mode-off").click();
    await form.getByTestId("my-job-parts-amount").fill("2");
    // No reason: nothing is saved and it says why.
    await form.getByTestId("my-job-parts-save").click();
    await expect(job.getByTestId("my-job-parts-error")).toContainText("Say why you are taking parts off");
    expect(await total(J.main)).toBe(5);
    // With a reason it is saved.
    await form.getByTestId("my-job-parts-note-input").fill("Counted the wrong tray");
    await form.getByTestId("my-job-parts-save").click();
    await expect(job.getByTestId("my-job-parts-count")).toContainText("3 of 5 parts");
    const logged = await rows(J.main);
    expect(logged).toHaveLength(6);
    expect(logged.at(-1)).toMatchObject({ quantity: -2, note: "Counted the wrong tray", logged_by: operator.id });
    expect(logged.slice(0, 5).map((r) => r.quantity)).toEqual([1, 1, 1, 1, 1]);

    // Taking more off than is there is refused by the database and nothing is saved.
    await job.getByTestId("my-job-change-count").click();
    await form.getByTestId("my-job-parts-mode-off").click();
    await form.getByTestId("my-job-parts-amount").fill("4");
    await form.getByTestId("my-job-parts-note-input").fill("Too many");
    await form.getByTestId("my-job-parts-save").click();
    await expect(job.getByTestId("my-job-parts-error")).toContainText("That would take the count below 0. Nothing was saved.");
    expect(await total(J.main)).toBe(3);
    // Adding several at once, above the quantity, is refused too.
    await form.getByTestId("my-job-parts-mode-add").click();
    await form.getByTestId("my-job-parts-amount").fill("3");
    await form.getByTestId("my-job-parts-save").click();
    await expect(job.getByTestId("my-job-parts-error")).toContainText("above the quantity required. Nothing was saved.");
    expect(await total(J.main)).toBe(3);
    // Adding the 2 that fit is taken.
    await form.getByTestId("my-job-parts-amount").fill("2");
    await form.getByTestId("my-job-parts-save").click();
    await expect(job.getByTestId("my-job-parts-count")).toContainText("5 of 5 parts");
    // Back to 3 for the screens below.
    await job.getByTestId("my-job-change-count").click();
    await form.getByTestId("my-job-parts-mode-off").click();
    await form.getByTestId("my-job-parts-amount").fill("2");
    await form.getByTestId("my-job-parts-note-input").fill("Two were scrap");
    await form.getByTestId("my-job-parts-save").click();
    await expect(job.getByTestId("my-job-parts-count")).toContainText("3 of 5 parts");
    expect(await total(J.main)).toBe(3);
  } finally {
    await context.close();
  }
});

test("Whole floor shows 3 of 5 parts on the machine, and says who is clocked in is for office and admin", async ({ browser }) => {
  const context = await deviceContext(browser, TABLET, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, operator);
    const floor = page.getByTestId("whole-floor");
    const mill = floor.getByTestId("floor-row").filter({ hasText: names.mill });
    await expect(mill).toContainText(J.main);
    await expect(mill.getByTestId("floor-parts")).toContainText("Parts logged: 3 of 5 parts");
    // The workshop person can't read anyone else's clock records, so the count is not shown to them, and it says so.
    await expect(floor.getByTestId("floor-clocked-in-note")).toHaveText("Who is clocked in is shown to office and admin only.");
    await expect(floor.getByTestId("floor-clocked-in")).toHaveCount(0);
    // The rest of the Whole floor is as it was: the state words and counts.
    await expect(mill).toHaveAttribute("data-state", "running");
    await expect(floor.getByTestId("floor-count-running")).toHaveText("1");
  } finally {
    await context.close();
  }
});

test("the Job Board's job details show the same 3 of 5 parts", async ({ browser }) => {
  const context = await deviceContext(browser, PHONE, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, operator);
    await page.goto(`/jobs?job=${ids[J.main]}`);
    const row = page.locator(`[data-job-id="${ids[J.main]}"]:visible`).first();
    await expect(row.getByTestId("job-parts")).toContainText("3 of 5 parts");
    // A job nobody has counted is as it was: no parts line.
    await expect(page.locator(`[data-job-id="${ids[J.full]}"]:visible`).first().getByTestId("job-parts")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("offline: a tap says it needs a connection and saves nothing; back online it adds exactly one", async ({ browser }) => {
  const context = await deviceContext(browser, TABLET, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, operator);
    const job = card(page, J.full);
    await expect(job.getByTestId("my-job-parts-count")).toContainText("0 of 3 parts");
    await context.setOffline(true);
    await expect(job.getByTestId("my-job-parts-note")).toHaveText("Logging parts needs a connection. Nothing was saved.");
    await job.getByTestId("my-job-add-part").click();
    await expect(job.getByTestId("my-job-parts-error")).toHaveText("Logging parts needs a connection. Nothing was saved.");
    await expect(job.getByTestId("my-job-parts-count")).toContainText("0 of 3 parts");
    expect(await rows(J.full)).toEqual([]);
    await context.setOffline(false);
    await expect(job.getByTestId("my-job-parts-note")).toHaveCount(0);
    await job.getByTestId("my-job-add-part").click();
    await expect(job.getByTestId("my-job-parts-count")).toContainText("1 of 3 parts");
    // Exactly one entry: the offline tap was not queued and replayed.
    await page.waitForTimeout(1500);
    expect((await rows(J.full)).map((r) => r.quantity)).toEqual([1]);
  } finally {
    await context.close();
  }
});

test("another device fills the job while this page is stale: the tap is refused in words, nothing is saved, and the count on screen is put right", async ({ browser }) => {
  const context = await deviceContext(browser, TABLET, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, operator);
    const job = card(page, J.full);
    await expect(job.getByTestId("my-job-parts-count")).toContainText("1 of 3 parts");
    // Another tablet logs the last 2 (a direct row, as the other tablet's own tap would have written).
    await ok(adminClient().from("job_part_logs").insert({ organization_id: org, job_id: ids[J.full], quantity: 2, logged_by: operator.id, client_op_id: randomUUID() }));
    await job.getByTestId("my-job-add-part").click();
    await expect(job.getByTestId("my-job-parts-error")).toContainText("That would take the count above the quantity required. Nothing was saved.");
    await expect(job.getByTestId("my-job-parts-count")).toContainText("3 of 3 parts");
    await expect(job.getByTestId("my-job-add-part")).toBeDisabled();
    expect(await total(J.full)).toBe(3);
  } finally {
    await context.close();
  }
});
