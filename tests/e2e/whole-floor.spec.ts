/**
 * Whole floor on the workshop Dashboard (lib/whole-floor, components/workshop/whole-floor): a workshop person sees every machine right
 * now, one row each, read-only. Seeded in its own company (createSoloTenant) so the machines, runs and the Columns choice disturb no
 * other spec: a Mill running a late job, a Lathe paused on a job, a Haas with nothing on it.
 *   - The workshop person sees Whole floor with a row per machine in its state (Running, Paused, Idle) and the late job marked Late.
 *   - Every row is at least 56px tall, and every dot has a visible word beside it.
 *   - The page never scrolls sideways at 390, 768, 820 and 1280.
 *   - Hiding it in the Dashboard's display settings (the same Columns list; the Dashboard's own Columns button is admin and office
 *     only) hides it for the workshop, and showing it again brings it back.
 * Screenshots of the card at tablet (820) and phone (390) go to test-results/whole-floor-screenshots (WHOLE_FLOOR_SHOTS_DIR keeps a copy).
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { EMAIL_DOMAIN, adminClient, createSoloTenant, type SyntheticUser } from "../support/fixtures";
import { VIEWPORTS, deviceContext, type ViewportSpec } from "../support/ui-pr1-screenshots";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
const SHOTS_DIR = process.env.WHOLE_FLOOR_SHOTS_DIR ?? path.resolve(__dirname, "../../test-results/whole-floor-screenshots");
const LABEL = "Whole floor (workshop)";
const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));

let org = "";
let admin: SyntheticUser;
let workshop: SyntheticUser;
const names = { mill: "", lathe: "", haas: "" };
const jobNos = { late: "", paused: "" };

const ok = async (p: PromiseLike<{ error: { message: string } | null }>) => expect((await p).error).toBeNull();

test.beforeAll(async () => {
  const tag = w.runId.slice(0, 6);
  const solo = await createSoloTenant(w.runId, `floor${Date.now().toString(36)}`);
  org = solo.id;
  admin = solo.admin;
  // The company's workshop person (the e-mail carries the run id, so teardown removes them with the rest of the run).
  const db = adminClient();
  const email = `workshop.floor${Date.now().toString(36)}.${w.runId}@${EMAIL_DOMAIN}`;
  const password = `Fl-${randomUUID()}`;
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Lee Barker" } });
  expect(created.error).toBeNull();
  workshop = { id: created.data.user!.id, email, password, role: "workshop" };
  const added = await db.rpc("add_member", { p_org: org, p_email: email, p_role: "workshop" });
  expect(added.error).toBeNull();
  expect(added.data).toBe("member");

  names.mill = `Floor Mill ${tag}`;
  names.lathe = `Floor Lathe ${tag}`;
  names.haas = `Floor Haas ${tag}`;
  jobNos.late = `J-FL1-${tag}`;
  jobNos.paused = `J-FL2-${tag}`;
  const machine = async (name: string) => {
    const { data, error } = await db.from("machines").insert({ organization_id: org, name }).select("id").single();
    expect(error).toBeNull();
    return data!.id as string;
  };
  const job = async (job_no: string, date_required: string) => {
    const { data, error } = await db.from("jobs").insert({ organization_id: org, job_no, customer: "Severn Valve Co", description: "Valve body", date_required, started_at: new Date(Date.now() - 6 * 3_600_000).toISOString() }).select("id").single();
    expect(error).toBeNull();
    return data!.id as string;
  };
  const [mill, lathe] = [await machine(names.mill), await machine(names.lathe)];
  await machine(names.haas);
  const [lateJob, pausedJob] = [await job(jobNos.late, london(-3)), await job(jobNos.paused, london(5))];
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  // Running now on the Mill; paused an hour ago on the Lathe (nothing open on the Lathe or for its job).
  await ok(db.from("machine_runs").insert({ organization_id: org, job_id: lateJob, machine_id: mill, operator_id: workshop.id, started_at: hoursAgo(2) }));
  await ok(db.from("machine_runs").insert({ organization_id: org, job_id: pausedJob, machine_id: lathe, operator_id: workshop.id, started_at: hoursAgo(3), ended_at: hoursAgo(1), end_reason: "paused", ended_by: workshop.id }));
});

test.afterAll(async () => {
  if (org) await adminClient().from("organization_settings").update({ hidden_columns: {} }).eq("organization_id", org);
});

const floorOf = (page: Page) => page.getByTestId("whole-floor");
const rowOf = (floor: Locator, name: string) => floor.getByTestId("floor-row").filter({ hasText: name });

async function saveShot(floor: Locator, name: string) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await floor.screenshot({ path: file });
  // Playwright empties test-results/ on every run: a copy outside it is kept when asked (WHOLE_FLOOR_SHOTS_DIR).
  if (process.env.WHOLE_FLOOR_SHOTS_DIR) copyFileSync(file, path.join(process.env.WHOLE_FLOOR_SHOTS_DIR, `${name}.png`));
}

async function openAsWorkshop(browser: Browser, baseURL: string, viewport: ViewportSpec) {
  const context = await deviceContext(browser, viewport, baseURL);
  const page = await context.newPage();
  await signIn(page, workshop);
  return { context, page };
}

const SIZES: ViewportSpec[] = [
  VIEWPORTS.find((v) => v.name === "phone")!,
  { name: "tablet", width: 768, height: 1024, touch: true },
  VIEWPORTS.find((v) => v.name === "tablet")!,
  VIEWPORTS.find((v) => v.name === "desktop")!,
];

for (const viewport of SIZES) {
  test(`a workshop person sees every machine on the Whole floor, big rows with a word by every dot (${viewport.width})`, async ({ browser, baseURL }) => {
    const { context, page } = await openAsWorkshop(browser, baseURL!, viewport);
    const floor = floorOf(page);
    await expect(floor.getByText("Whole floor", { exact: true })).toBeVisible();
    await expect(floor.getByTestId("floor-failed")).toHaveCount(0);

    const mill = rowOf(floor, names.mill);
    const lathe = rowOf(floor, names.lathe);
    const haas = rowOf(floor, names.haas);
    await expect(mill).toHaveAttribute("data-state", "running");
    await expect(lathe).toHaveAttribute("data-state", "paused");
    await expect(haas).toHaveAttribute("data-state", "idle");
    await expect(mill).toContainText(jobNos.late);
    await expect(mill).toContainText("Running");
    await expect(mill.locator('[data-testid="floor-state"][data-state="late"]')).toHaveText("Late");
    await expect(mill).toContainText("Lee Barker");
    await expect(lathe).toContainText(jobNos.paused);
    await expect(lathe).toContainText("Paused");
    await expect(lathe.locator('[data-testid="floor-state"][data-state="late"]')).toHaveCount(0);
    await expect(haas).toContainText("Idle");
    await expect(floor.getByTestId("floor-count-running")).toHaveText("1");
    await expect(floor.getByTestId("floor-count-paused")).toHaveText("1");
    await expect(floor.getByTestId("floor-count-idle")).toHaveText("1");
    await expect(floor.getByTestId("floor-count-late")).toHaveText("1");

    // Glove-sized: every row at least 56px tall; any link in it at least 48px.
    const rows = floor.getByTestId("floor-row");
    await expect(rows).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      const box = (await rows.nth(i).boundingBox())!;
      expect(box.height, `row ${i} is at least 56px`).toBeGreaterThanOrEqual(56);
      const link = rows.nth(i).getByRole("link");
      if (await link.count()) expect((await link.boundingBox())!.height, `row ${i}'s link is at least 48px`).toBeGreaterThanOrEqual(48);
    }

    // Never colour alone: each dot sits in a state with a visible word.
    const dots = floor.getByTestId("floor-dot");
    const n = await dots.count();
    expect(n).toBeGreaterThanOrEqual(8); // four in the summary, one per row, Late on the Mill
    for (let i = 0; i < n; i += 1) {
      const word = (await dots.nth(i).locator('xpath=ancestor::*[@data-testid="floor-state"][1]').innerText()).trim();
      expect(word, `dot ${i} has a word`).toMatch(/^(Running|Paused|Idle|Late)$/);
      await expect(dots.nth(i)).toBeVisible();
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll").toBe(true);
    await floor.scrollIntoViewIfNeeded();
    if (viewport.width === 820 || viewport.width === 390) await saveShot(floor, `workshop-${viewport.width}x${viewport.height}-whole-floor`);
    await context.close();
  });
}

test("hiding Whole floor in the Dashboard's display settings hides it for the workshop, and showing it brings it back", async ({ browser, baseURL }) => {
  const desktop = VIEWPORTS.find((v) => v.name === "desktop")!;
  const adminContext = await deviceContext(browser, desktop, baseURL!);
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, admin);
  await adminPage.goto("/settings");
  const box = adminPage.getByTestId("display-screen-dashboard").getByRole("checkbox", { name: LABEL, exact: true });
  const hiddenNow = async () => {
    const { data } = await adminClient().from("organization_settings").select("hidden_columns").eq("organization_id", org).maybeSingle();
    return ((data?.hidden_columns as Record<string, string[]> | null)?.dashboard ?? []).includes("whole-floor");
  };
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect.poll(hiddenNow).toBe(true);

  const { context, page } = await openAsWorkshop(browser, baseURL!, VIEWPORTS.find((v) => v.name === "tablet")!);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Jobs running", { exact: true })).toBeVisible();
  await expect(floorOf(page)).toHaveCount(0);

  await box.check();
  await expect.poll(hiddenNow).toBe(false);
  await page.reload();
  await expect(floorOf(page).getByText("Whole floor", { exact: true })).toBeVisible();
  await context.close();
  await adminContext.close();
});
