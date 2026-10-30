/**
 * Job Board redesign (taller rows, a sticky selection bar, nothing hover-only), in the browser:
 *
 *   * Start (bench), Inspected (a failed inspection) and Rework still work from the redesigned rows;
 *   * every control in a job's row or card, and the header tick box, is at least 48px tall: a mouse at 1280, a touch tablet at 820, a
 *     touch phone at 390 (cards);
 *   * with a job ticked, the selection bar stays in view after scrolling to the bottom, sits just below the app's top bar (not under it)
 *     and reads light on the brand navy (contrast at least 4.5:1); unticked it is not sticky; on a 390 phone its controls sit in two
 *     rows (three columns), each still 48px+;
 *   * the page never scrolls sideways at 390, 768 and 1280, with or without a selection;
 *   * screenshots at 1280 and 820 (touch), the board as it opens and with a selection scrolled down, saved to
 *     test-results/job-board-redesign-screenshots (CI's integration-evidence artifact).
 *
 * Runs in its own company (createSoloTenant): it starts, finishes and fails inspections, which the shared companies' specs must not see.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { VIEWPORTS, deviceContext } from "../support/ui-pr1-screenshots";
import { adminClient, createSoloTenant, type SyntheticUser } from "../support/fixtures";
import { pauseControl, pickMachines, playControl, signIn, world } from "./helpers";

const w = world();
let org = "";
let soloAdmin: SyntheticUser;
const J: Record<string, string> = {};
const ids: Record<string, string> = {};

const SHOTS_DIR = path.resolve(__dirname, "../../test-results/job-board-redesign-screenshots");
/** Playwright empties test-results/ on every run: a copy outside it is kept when asked (JOB_BOARD_SHOTS_DIR). */
async function saveShot(page: Page, name: string) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  if (process.env.JOB_BOARD_SHOTS_DIR) {
    mkdirSync(process.env.JOB_BOARD_SHOTS_DIR, { recursive: true });
    copyFileSync(file, path.join(process.env.JOB_BOARD_SHOTS_DIR, `${name}.png`));
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const admin = adminClient();
  // A fresh label per worker start: a retried worker re-runs beforeAll, and a company's slug and admin email must be new.
  const solo = await createSoloTenant(w.runId, `jbredesign${Date.now().toString(36)}`);
  org = solo.id;
  soloAdmin = solo.admin;
  J.start = `J-RD-START-${w.runId}`;
  J.inspect = `J-RD-INSPECT-${w.runId}`;
  J.measure = `J-RD-MEASURE-${w.runId}`;
  // Enough rows that the board scrolls well past the selection bar's own place at every width.
  for (let i = 1; i <= 14; i += 1) J[`fill${i}`] = `J-RD-FILL${String(i).padStart(2, "0")}-${w.runId}`;
  for (const [key, no] of Object.entries(J)) {
    const finished = key === "inspect" ? { stage: "inspection", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", quantity_required: 10 } : {};
    const { data, error } = await admin.from("jobs").insert({ organization_id: org, job_no: no, customer: "Redesign Co", description: `Redesign ${key}`, due_date: "2099-01-05", date_required: "2099-01-05", ...finished }).select("id").single();
    expect(error).toBeNull();
    ids[no] = data!.id as string;
  }
});

const row = (page: Page, no: string) => page.locator(`tr[data-job-id="${ids[no]}"]`);

/** The controls under `selector` that are on screen and shorter than 48px ("name (height)"); an empty list passes. */
const shortTargets = (page: Page, selector: string) => page.evaluate((sel) => {
  const out: string[] = [];
  for (const scope of Array.from(document.querySelectorAll(sel))) {
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>("button, a[href], select, [data-slot='select-box-hit']"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue; // not shown at this width (the other layout's copy)
      if (r.height < 47.5) out.push(`${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)} (${r.height.toFixed(1)}px)`);
    }
  }
  return out;
}, selector);

/** How many controls under `selector` are on screen (so a check over them is never vacuous). */
const shownTargets = (page: Page, selector: string) => page.evaluate((sel) => Array.from(document.querySelectorAll(sel))
  .flatMap((scope) => Array.from(scope.querySelectorAll<HTMLElement>("button, a[href], select, [data-slot='select-box-hit']")))
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length, selector);

const scrollsSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

/** Ticks the measuring job, scrolls to the bottom, and checks the bar is stuck just below the top bar, in view, light on navy. */
async function expectStickyBar(page: Page, at: string) {
  const bar = page.getByTestId("selection-bar");
  await expect(bar).not.toHaveAttribute("data-selected", "true");
  expect(await bar.evaluate((el) => getComputedStyle(el).position), `${at}: unticked, the bar is not sticky`).not.toBe("sticky");
  await page.getByRole("checkbox", { name: `Select ${J.measure}` }).check();
  await expect(page.getByTestId("selection-summary")).toContainText("1 selected");
  await expect(bar).toHaveAttribute("data-selected", "true");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY), `${at}: the board scrolled`).toBeGreaterThan(200);
  const topBar = page.getByRole("banner");
  await expect.poll(async () => {
    const top = (await topBar.boundingBox())!;
    const box = (await bar.boundingBox())!;
    return Math.abs(box.y - (top.y + top.height)) <= 1;
  }, { message: `${at}: the selection bar sits just below the top bar, not under it` }).toBe(true);
  await expect(bar).toBeInViewport();
  await expect(bar.getByRole("button", { name: /^Finish Selected/ })).toBeInViewport();
  await expect(bar.getByRole("button", { name: "Clear selection" })).toBeInViewport();
  // High contrast: the status text on the bar's background, by the WCAG formula.
  const ratio = await bar.evaluate((el) => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => [r, g, b].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const back = lum(rgb(getComputedStyle(el).backgroundColor));
    const fore = lum(rgb(getComputedStyle(el.querySelector("[role=status]")!).color));
    return (Math.max(back, fore) + 0.05) / (Math.min(back, fore) + 0.05);
  });
  expect(ratio, `${at}: the bar's text contrast`).toBeGreaterThanOrEqual(4.5);
  expect(await scrollsSideways(page), `${at}: the page scrolls sideways with a job ticked`).toBe(false);
}

test("Start, Inspected and Rework still work from the redesigned rows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, soloAdmin);
  await page.goto("/jobs");

  // Start on the bench: Play becomes Pause, the start is recorded.
  const start = row(page, J.start);
  await pickMachines(page, start, J.start, { bench: true });
  await playControl(start, J.start).click();
  await expect(page.getByText(`${J.start} started on the bench.`)).toBeVisible();
  await expect(pauseControl(start, J.start)).toBeVisible();
  await expect.poll(async () => (await adminClient().from("jobs").select("started_at").eq("id", ids[J.start]).single()).data!.started_at).not.toBeNull();

  // Inspected: a failed inspection puts the job back to Running, tagged Rework.
  const inspect = row(page, J.inspect);
  await inspect.getByRole("button", { name: "Inspected", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Record inspection: ${J.inspect}` });
  await dialog.getByLabel("Fail").check();
  await dialog.getByLabel("Measured notes (required)").fill("Bore 25.08 mm: oversize");
  await dialog.getByLabel("Reason it failed (required)").fill("Bore oversize");
  await dialog.getByLabel("Rework instructions for the workshop (required)").fill("Re-bore and re-measure");
  await dialog.getByLabel("Acceptance criteria (required)").fill("Drawing rev A: bore 25.00 +0.03/-0");
  await dialog.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(`${J.inspect} failed inspection: put back to Running, tagged Rework`)).toBeVisible();
  expect((await adminClient().from("jobs").select("stage, inspected_at").eq("id", ids[J.inspect]).single()).data).toMatchObject({ stage: "rework", inspected_at: null });

  // Rework: the row's Rework opens the job's rework.
  await expect(inspect.getByTestId("rework-tag")).toBeVisible();
  await inspect.getByRole("button", { name: "Rework", exact: true }).click();
  const rework = page.getByRole("dialog", { name: `Rework: ${J.inspect}` });
  await expect(rework).toContainText("Waiting for the workshop");
  await expect(rework).toContainText("Re-bore and re-measure");
});

test("every row control is at least 48px tall: mouse at 1280, touch tablet at 820, touch phone cards at 390", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, soloAdmin);
  await page.goto("/jobs");
  for (const view of ["List", "Table"] as const) {
    await page.getByRole("group", { name: "View" }).getByRole("button", { name: view, exact: true }).click();
    await expect(row(page, J.measure)).toBeVisible();
    const scope = `tr[data-job-id="${ids[J.measure]}"], tr[data-job-id="${ids[J.start]}"], tr[data-job-id="${ids[J.inspect]}"], thead`;
    expect(await shownTargets(page, scope), `${view}@1280: controls to measure`).toBeGreaterThan(8);
    expect(await shortTargets(page, scope), `${view}@1280: controls under 48px`).toEqual([]);
  }
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "List", exact: true }).click();

  const baseURL = String(test.info().project.use.baseURL);
  for (const viewport of [VIEWPORTS[1], VIEWPORTS[0]]) {
    const context = await deviceContext(browser, viewport, baseURL);
    const touch = await context.newPage();
    await signIn(touch, soloAdmin);
    await touch.goto("/jobs");
    const scope = viewport.name === "phone"
      ? `[data-testid="job-card"][data-job-id="${ids[J.measure]}"], [data-testid="job-card"][data-job-id="${ids[J.start]}"]`
      : `tr[data-job-id="${ids[J.measure]}"], tr[data-job-id="${ids[J.start]}"], thead`;
    await expect(touch.locator(scope).first()).toBeVisible();
    expect(await shownTargets(touch, scope), `${viewport.name}: controls to measure`).toBeGreaterThan(8);
    expect(await shortTargets(touch, scope), `${viewport.name}@${viewport.width}: controls under 48px`).toEqual([]);
    await context.close();
  }
});

for (const width of [1280, 768, 390]) {
  test(`at ${width}px: the selection bar stays in view below the top bar, and nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signIn(page, soloAdmin);
    await page.goto("/jobs");
    await expect(page.getByTestId("selection-summary")).toBeVisible();
    await expect(page.locator(`[data-job-id="${ids[J.measure]}"]:visible`)).toBeVisible();
    expect(await scrollsSideways(page), `${width}: the page scrolls sideways`).toBe(false);
    await expectStickyBar(page, `${width}`);
    if (width === 390) {
      // Compact on a phone: the bar's controls sit in two rows (three columns), not four wrapped lines, and every one is still 48px+.
      const bar = page.getByTestId("selection-bar");
      const rows = await bar.evaluate((el) => Array.from(el.querySelectorAll("button"))
        .map((b) => b.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top + r.height / 2).sort((a, b) => a - b)
        .filter((mid, i, mids) => i === 0 || mid - mids[i - 1] > 10).length);
      expect(rows, "390: rows of controls in the selection bar").toBeLessThanOrEqual(2);
      expect((await bar.boundingBox())!.height, "390: the selection bar's height").toBeLessThanOrEqual(180);
      expect(await shortTargets(page, '[data-testid="selection-bar"]'), "390: selection bar controls under 48px").toEqual([]);
    }
  });
}

test("screenshots: the board as it opens and with a selection scrolled down, at 1280 and 820 (touch)", async ({ browser }) => {
  const baseURL = String(test.info().project.use.baseURL);
  for (const viewport of [VIEWPORTS[2], VIEWPORTS[1]]) {
    const context = await deviceContext(browser, { ...viewport, height: 900 }, baseURL);
    const page = await context.newPage();
    await signIn(page, soloAdmin);
    await page.goto("/jobs");
    await expect(page.locator(`[data-job-id="${ids[J.measure]}"]:visible`)).toBeVisible();
    await saveShot(page, `admin-${viewport.width}x900-board`);
    await expectStickyBar(page, `${viewport.name}@${viewport.width}`);
    await saveShot(page, `admin-${viewport.width}x900-selected-scrolled`);
    await context.close();
  }
});
