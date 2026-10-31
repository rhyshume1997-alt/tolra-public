/**
 * Workshop "My jobs" on the shop-floor tablet (components/workshop/my-jobs.tsx): each job assigned to the operator is a card with one
 * main action, full width and at least 56 px tall, and a running job's Pause tap at least 48 px; the specification sits in its notes
 * strip; status and due light are words, not colour alone. Tapping an action only opens the job on the Job Board (/jobs?job=<id>, shown
 * and highlighted), where the board's own Start / Pause / Finish do the work. Nothing scrolls sideways at 390, 768, 820 and 1280.
 * Screenshots at phone and tablet are written to test-results/workshop-my-jobs-screenshots (kept elsewhere with MY_JOBS_SHOTS_DIR).
 *
 * Runs in its own company (createSoloTenant) with its own workshop user, so the jobs it assigns never show on another spec's dashboard.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, createSoloTenant, EMAIL_DOMAIN, type SyntheticUser } from "../support/fixtures";
import { VIEWPORTS, deviceContext, type ViewportSpec } from "../support/ui-pr1-screenshots";
import { signIn, world } from "./helpers";

const w = world();
const baseURL = () => String(test.info().project.use.baseURL);
const SHOTS_DIR = process.env.MY_JOBS_SHOTS_DIR ?? path.resolve(__dirname, "../../test-results/workshop-my-jobs-screenshots");
const PHONE = VIEWPORTS.find((v) => v.name === "phone")!;
const TABLET = VIEWPORTS.find((v) => v.name === "tablet")!;
const DESKTOP = VIEWPORTS.find((v) => v.name === "desktop")!;
const SMALL_TABLET: ViewportSpec = { name: "tablet", width: 768, height: 1024, touch: true };
const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
const SPEC = "Deburr all edges, break sharp corners 0.5 x 45";

let operator: SyntheticUser;
const J = { todo: "", running: "", other: "" };
const ids: Record<string, string> = {};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const admin = adminClient();
  const solo = await createSoloTenant(w.runId, `myjobs-${randomUUID().slice(0, 6)}`);
  const email = `operator.myjobs.${randomUUID().slice(0, 6)}.${w.runId}@${EMAIL_DOMAIN}`;
  const password = generatePassword(16);
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Lee Operator" } });
  expect(created.error).toBeNull();
  operator = { id: created.data.user!.id, email, password, role: "workshop" };
  const { data: added, error: addError } = await admin.rpc("add_member", { p_org: solo.id, p_email: email, p_role: "workshop" });
  expect(addError).toBeNull();
  expect(added).toBe("member");
  J.todo = `J-MJTODO-${w.runId}`;
  J.running = `J-MJRUN-${w.runId}`;
  J.other = `J-MJOTHER-${w.runId}`;
  // One row per insert (a batch sends null for keys a row lacks, overriding column defaults).
  const rows = [
    { job_no: J.running, customer: "Severn Valve Co", description: "Valve body", quantity_required: 4, stage: "machining", date_required: london(-2), started_at: new Date(Date.now() - 3_600_000).toISOString(), specification: SPEC, assigned_to: operator.id },
    { job_no: J.todo, customer: "Aldridge Hydraulics Ltd", description: "Gland nut", quantity_required: 50, stage: "setup", date_required: london(10), assigned_to: operator.id },
    { job_no: J.other, customer: "Not Mine Ltd", description: "Someone else's", date_required: london(1) },
  ];
  for (const row of rows) {
    const { data, error } = await admin.from("jobs").insert({ organization_id: solo.id, ...row }).select("id").single();
    expect(error).toBeNull();
    ids[row.job_no] = data!.id as string;
  }
});

const card = (page: Page, no: string) => page.locator(`[data-testid="my-job"][data-job-id="${ids[no]}"]`);
const box = async (locator: Locator) => (await locator.boundingBox())!;
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function saveShot(page: Page, name: string) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  // Playwright empties test-results/ on every run: a copy outside it is kept when asked (MY_JOBS_SHOTS_DIR).
  if (process.env.MY_JOBS_SHOTS_DIR) copyFileSync(file, path.join(process.env.MY_JOBS_SHOTS_DIR, `${name}.png`));
}

/** The main action fills the card's content width and is at least 56 px tall; the Pause tap is at least 48 px. */
async function expectBigTaps(page: Page) {
  for (const no of [J.todo, J.running]) {
    const job = card(page, no);
    const action = job.getByTestId("my-job-action");
    await expect(action).toBeVisible();
    const a = await box(action);
    const c = await box(job);
    expect(a.height, `${no} main action at least 56 px tall`).toBeGreaterThanOrEqual(56);
    // Full width: the card's width less its padding (16 px each side below sm, 20 px from sm) and its 1 px border.
    expect(a.width, `${no} main action full width`).toBeGreaterThanOrEqual(c.width - 2 * 21 - 1);
  }
  const pause = card(page, J.running).getByTestId("my-job-pause");
  await expect(pause).toBeVisible();
  const p = await box(pause);
  expect(p.height, "Pause at least 48 px tall").toBeGreaterThanOrEqual(48);
  expect(p.width, "Pause at least 48 px wide").toBeGreaterThanOrEqual(48);
  await expect(card(page, J.todo).getByTestId("my-job-pause"), "no Pause before the job starts").toHaveCount(0);
}

test("tablet: my jobs only, one big main action each, Pause on the running job, the notes strip, words beside every light", async ({ browser }) => {
  const context = await deviceContext(browser, TABLET, baseURL());
  const page = await context.newPage();
  try {
    await signIn(page, operator);
    const list = page.getByTestId("my-jobs");
    await expect(list).toBeVisible();
    await expect(list.getByTestId("my-job")).toHaveCount(2);
    await expect(page.locator(`[data-testid="my-job"][data-job-id="${ids[J.other]}"]`)).toHaveCount(0);
    // Soonest due first: the late running job, then the one not started.
    await expect(list.getByTestId("my-job").first()).toHaveAttribute("data-job-id", ids[J.running]);

    const running = card(page, J.running);
    await expect(running).toContainText("Severn Valve Co · Valve body · qty 4");
    await expect(running).toContainText("Running");
    await expect(running.getByTestId("my-job-due")).toHaveText("Late");
    await expect(running.getByTestId("my-job-notes")).toContainText(SPEC);
    await expect(running.getByTestId("my-job-action")).toHaveText("Finish on the Job Board");
    await expect(running.getByTestId("my-job-action")).toHaveAttribute("data-kind", "finish");

    const todo = card(page, J.todo);
    await expect(todo).toContainText("Not started");
    await expect(todo.getByTestId("my-job-due")).toHaveText("On time");
    await expect(todo.getByTestId("my-job-notes")).toHaveCount(0);
    await expect(todo.getByTestId("my-job-action")).toHaveText("Start on the Job Board");

    await expectBigTaps(page);
    expect(await noSidewaysScroll(page), "no sideways scroll at 820").toBe(true);
    await saveShot(page, "tablet-820-my-jobs");

    // The main action opens that job on the Job Board, shown and highlighted, with the board's own Start for it.
    await todo.getByTestId("my-job-action").tap();
    await expect(page).toHaveURL(new RegExp(`/jobs\\?job=${ids[J.todo]}$`));
    await expect(page.locator(`[data-job-id="${ids[J.todo]}"][data-highlighted="true"]:visible`).first()).toBeVisible();
    await expect(page.locator(`[data-job-id="${ids[J.todo]}"]:visible`).first().getByTestId("play-pause")).toBeVisible();
    await saveShot(page, "tablet-820-after-start-tap");

    // Pause goes to the same place for the running job: the board's own Pause / Resume.
    await page.goto("/dashboard");
    await card(page, J.running).getByTestId("my-job-pause").tap();
    await expect(page).toHaveURL(new RegExp(`/jobs\\?job=${ids[J.running]}$`));
    await expect(page.locator(`[data-job-id="${ids[J.running]}"][data-highlighted="true"]:visible`).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const viewport of [PHONE, SMALL_TABLET, DESKTOP]) {
  test(`${viewport.width}: the same big taps, nothing scrolls sideways`, async ({ browser }) => {
    const context = await deviceContext(browser, viewport, baseURL());
    const page = await context.newPage();
    try {
      await signIn(page, operator);
      await expect(page.getByTestId("my-job")).toHaveCount(2);
      await expectBigTaps(page);
      expect(await noSidewaysScroll(page), `no sideways scroll at ${viewport.width}`).toBe(true);
      if (viewport !== DESKTOP) await saveShot(page, `${viewport.name}-${viewport.width}-my-jobs`);
    } finally {
      await context.close();
    }
  });
}
