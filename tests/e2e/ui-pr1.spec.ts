/**
 * UI PR 1 ("Quick wins and job action consistency"), in the browser, against the local disposable backend only.
 *
 * - Start / Finish are shared by cards, list and table: repeat taps never replace a recorded time (even from a stale board).
 * - Cards have their own tick box, the count is visible, "all filtered" is not "selected", and bulk Start / Finish ask first
 *   naming the real target jobs.
 * - Removing a draft invoice, a draft credit note or a certificate asks first.
 * - Every link offered (bell, dashboard tiles, menu) opens a permitted page for the view and page access in force.
 * - Touch: hit areas are measured (>= 44px; workshop Start / Finish >= 64px high, secondary >= 48px) on phone and tablet
 *   contexts that really are `(pointer: coarse)`; nothing scrolls sideways at 390px with a 120-character company name, a
 *   240-character description and a long e-mail / address on screen.
 * - Network: every browser context here aborts and records any request that is not loopback (and the suite fails on one);
 *   the app server is already guarded by tests/support/no-network.cjs (playwright.config.ts), checked at teardown.
 *
 * Synthetic data only (alpha tenant of the synthetic world; extra users use @example.test addresses that teardown removes).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

import { adminClient, EMAIL_DOMAIN, type SyntheticUser } from "../support/fixtures";
import { generatePassword } from "@/lib/password";
import { SCREENSHOT_DIR, VIEWPORTS, deviceContext, saveScreenshot, type ViewportSpec } from "../support/ui-pr1-screenshots";
import { confirmFinish, pauseControl, pickMachines, playControl, playJob, signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
const alpha = () => w.tenants.alpha;
const tag = () => w.runId.slice(0, 6);
const baseURL = () => String(test.info().project.use.baseURL);

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic data
// ---------------------------------------------------------------------------------------------------------------------

/** Exactly `length` characters of readable text. */
function text(seed: string, length: number) {
  return seed.repeat(Math.ceil(length / seed.length) + 1).slice(0, length - 1) + "d";
}
const COMPANY_120 = () => text("Hargreaves Whitcombe Aerospace Precision Engineering and Advanced Manufacturing Holdings Northern Division Limited ", 120);
const DESCRIPTION_240 = () => text("Turned and milled stainless steel hydraulic manifold block with six cross-drilled ports, threaded insert seats, deburred and passivated, supplied with full material certification and first-off inspection report ", 240);
const LONG_EMAIL = () => `accounts.payable.department.northern.division.${tag()}@very-long-subdomain-name-for-layout-testing.example.test`;
const LONG_ADDRESS = () => text("Unit 14 Hargreaves Industrial Estate Whitcombe Road Northern Business Park Greater Testchester TE57 9XY United Kingdom ", 240);

const no = (suffix: string) => `UI1-${tag()}-${suffix}`;
// Job numbers include this run's id, which lives in the synthetic world file written by global setup. They are built on
// first use inside a test, never at import: `npm run test:e2e:list` (CI's collection step) runs with no world file.
const unstarted = () => Array.from({ length: 14 }, (_, i) => no(`U${String(i + 1).padStart(2, "0")}`));
const JOB_SUFFIXES = { long: "LONG", started: "S1", finished: "F1", rework: "R1", tapA: "TAPA", tapB: "TAPB", tapC: "TAPC", stale: "STALE", staleF: "STALEF", certJob: "CERT" } as const;
const JOBS = new Proxy({} as Record<keyof typeof JOB_SUFFIXES, string>, {
  get: (_target, key) => no(JOB_SUFFIXES[key as keyof typeof JOB_SUFFIXES]),
});

type Extra = { office: SyntheticUser; hidden: SyntheticUser; noInspect: SyntheticUser };
let extra: Extra;

async function addMember(label: string, role: "office" | "workshop", columns: Record<string, unknown>): Promise<SyntheticUser> {
  const admin = adminClient();
  const email = `${label}.alpha.${w.runId}@${EMAIL_DOMAIN}`;
  const password = generatePassword(16);
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `${label} alpha` } });
  if (created.error || !created.data.user) throw new Error(`createUser ${email}: ${created.error?.message}`);
  const { data, error } = await admin.rpc("add_member", { p_org: alpha().id, p_email: email, p_role: role });
  if (error || data !== "member") throw new Error(`add_member ${email}: ${error?.message ?? data}`);
  const update = await admin.from("organization_members").update(columns).eq("organization_id", alpha().id).eq("user_id", created.data.user.id);
  if (update.error) throw new Error(update.error.message);
  return { id: created.data.user.id, email, password, role };
}

test.beforeAll(async () => {
  const admin = adminClient();
  const org = alpha().id;
  expect(COMPANY_120()).toHaveLength(120);
  expect(DESCRIPTION_240()).toHaveLength(240);
  const base = { organization_id: org, due_date: "2099-01-05", date_required: "2099-01-05" };
  const rows = [
    { ...base, job_no: JOBS.long, customer: COMPANY_120(), description: DESCRIPTION_240(), stage: "material" },
    ...unstarted().map((job_no) => ({ ...base, job_no, customer: "Synthetic Select Co", description: "Selection test part", stage: "material" })),
    { ...base, job_no: JOBS.started, customer: "Synthetic Select Co", description: "Already started", stage: "machining", started_at: "2026-10-01T08:00:00Z" },
    { ...base, job_no: JOBS.finished, customer: "Synthetic Select Co", description: "Awaiting inspection", stage: "inspection", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z" },
    { ...base, job_no: JOBS.rework, customer: "Synthetic Select Co", description: "In rework", stage: "rework", started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z" },
    ...[JOBS.tapA, JOBS.tapB, JOBS.tapC, JOBS.stale, JOBS.staleF].map((job_no) => ({ ...base, job_no, customer: "Synthetic Tap Co", description: "Repeat tap test", stage: "material" })),
    { ...base, job_no: JOBS.certJob, customer: "Synthetic Cert Co", description: "Cert pack", stage: "material" },
  ];
  const inserted = await admin.from("jobs").insert(rows);
  expect(inserted.error).toBeNull();
  // A long e-mail and address on a customer, and a drafted e-mail so the approval link has something to point at.
  expect((await admin.from("customers").insert({ organization_id: org, name: `${COMPANY_120()} ${tag()}`, email: LONG_EMAIL(), address: LONG_ADDRESS(), phone: "01000 000000" })).error).toBeNull();
  expect((await admin.from("email_history").insert({ organization_id: org, to_email: `queue.${tag()}@${EMAIL_DOMAIN}`, subject: `UI1 approval ${tag()}`, body: "Synthetic draft", status: "drafted", related_to_type: "general" })).error).toBeNull();
  extra = {
    office: await addMember("uiofficex", "office", {}),
    // Office with the approval queue, customers and quotes hidden from them by an admin (Page access).
    hidden: await addMember("uihidden", "office", { hidden_sections: ["approval", "customers", "quotes"] }),
    // A workshop user who is not an inspector (the alpha workshop user is).
    noInspect: await addMember("uinoinspect", "workshop", { can_inspect: false }),
  };
});

test.afterAll(async () => {
  const admin = adminClient();
  const org = alpha().id;
  const mine = await admin.from("jobs").select("id").eq("organization_id", org).like("job_no", `UI1-${tag()}-%`);
  const ids = (mine.data ?? []).map((row) => row.id as string);
  if (ids.length) await admin.from("job_files").delete().in("job_id", ids);
  await admin.from("jobs").delete().eq("organization_id", org).like("job_no", `UI1-${tag()}-%`);
  await admin.from("email_history").delete().eq("organization_id", org).like("subject", `UI1 approval ${tag()}%`);
  await admin.from("delivery_notes").delete().eq("organization_id", org).like("dn_number", `DLN-UI1-${tag()}%`);
  await admin.from("customers").delete().eq("organization_id", org).like("name", `%${tag()}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Helpers: network guard, measuring, devices
// ---------------------------------------------------------------------------------------------------------------------

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const blocked: string[] = [];
let loopbackRequests = 0;

/**
 * The browser side of the isolation: any request that is not to this machine is aborted and recorded, and the test fails
 * afterwards. (The app server's own outbound traffic is blocked by tests/support/no-network.cjs and checked at teardown.)
 */
async function guardNetwork(context: BrowserContext) {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["data:", "blob:", "about:"].includes(url.protocol) || LOOPBACK.has(url.hostname)) {
      loopbackRequests += 1;
      return route.continue();
    }
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
}

test.afterEach(() => {
  expect(blocked, "requests that left this machine").toEqual([]);
});

type Measured = { context: string; name: string; width: number; height: number };
const measured: Measured[] = [];

test.afterAll(() => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  writeFileSync(path.join(SCREENSHOT_DIR, "measurements.json"), JSON.stringify({ loopbackRequests, blocked, measured }, null, 2));
});

/** Measures a control's hit area; the box must be at least minW x minH CSS pixels. */
async function expectTarget(context: string, name: string, locator: Locator, minW: number, minH: number) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${context}: ${name} has a box`).not.toBeNull();
  measured.push({ context, name, width: Math.round(box!.width * 10) / 10, height: Math.round(box!.height * 10) / 10 });
  expect(box!.width, `${context}: ${name} width ${box!.width}`).toBeGreaterThanOrEqual(minW - 0.5);
  expect(box!.height, `${context}: ${name} height ${box!.height}`).toBeGreaterThanOrEqual(minH - 0.5);
}

/** The hit area of a tick box is the label around it. */
const hitArea = (checkbox: Locator) => checkbox.locator("xpath=..");

async function noSidewaysScroll(page: Page, where: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth, `${where}: scrollWidth ${scrollWidth} vs clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth + 1);
}

const isCoarse = (page: Page) => page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);

async function device(browser: Browser, viewport: ViewportSpec) {
  const context = await deviceContext(browser, viewport, baseURL());
  await guardNetwork(context);
  const page = await context.newPage();
  expect(await isCoarse(page)).toBe(viewport.touch);
  return { context, page };
}

const PHONE = VIEWPORTS[0];
const TABLET = VIEWPORTS[1];
const DESKTOP = VIEWPORTS[2];

const jobsOf = async (job_no: string) => (await adminClient().from("jobs").select("id, started_at, finished_at, stage, inspected_at").eq("organization_id", alpha().id).eq("job_no", job_no).single()).data!;

async function openJobs(page: Page) {
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
  await expect(page.getByTestId("selection-summary")).toBeVisible();
}

/** The row (list or table view) or card for a job, whichever the screen shows. */
// The job-number cell also holds the assignee chip since 044 ("J-1 Unassigned Take this job"): matched by its leading job number.
const rowOf = (page: Page, job_no: string) => page.getByRole("row").filter({ has: page.getByRole("cell", { name: new RegExp(`^${job_no.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`) }) });
const cardOf = (page: Page, job_no: string) => page.locator(`[data-testid="job-card"][data-job-no="${job_no}"]:visible`);

// ---------------------------------------------------------------------------------------------------------------------
// 1. Start / Finish: repeat taps never replace a recorded time
// ---------------------------------------------------------------------------------------------------------------------

test("Start then Finish: a double tap sends one update, repeat taps are disabled and recorded times never change", async ({ page }) => {
  await guardNetwork(page.context());
  const patches: string[] = [];
  // A job with no machine starts through start_machine_run (migration 046: its bench run, so it can be paused) and finishes through
  // finish_job (044): counted with the plain updates.
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/rest/v1/jobs")) patches.push(request.postData() ?? "");
    if (request.method() === "POST" && request.url().includes("/rest/v1/rpc/start_machine_run")) patches.push(`start_machine_run started_at ${request.postData() ?? ""}`);
    if (request.method() === "POST" && request.url().includes("/rest/v1/rpc/finish_job")) patches.push(`finish_job finished_at ${request.postData() ?? ""}`);
  });
  await signIn(page, alpha().users.workshop);
  await openJobs(page);

  const row = rowOf(page, JOBS.tapA);
  await expect(playControl(row, JOBS.tapA)).toBeVisible(); // nothing ticked yet: Play asks for a pick first (aria-disabled)
  // 049: a job with no plan starts where the person says (here the bench, ticked deliberately), then Play.
  await pickMachines(page, row, JOBS.tapA, { bench: true });
  await playControl(row, JOBS.tapA).dblclick();
  await expect.poll(async () => (await jobsOf(JOBS.tapA)).started_at).not.toBeNull();
  const started = (await jobsOf(JOBS.tapA)).started_at;
  // Running now: the control is Pause; there is no Start to tap again.
  await expect(pauseControl(row, JOBS.tapA)).toBeVisible();
  await expect(row.getByRole("button", { name: `Start ${JOBS.tapA}`, exact: true })).toHaveCount(0);
  expect(patches.filter((body) => body.includes("started_at"))).toHaveLength(1);
  await page.waitForTimeout(500);
  expect((await jobsOf(JOBS.tapA)).started_at).toBe(started);

  await confirmFinish(page, row.getByRole("button", { name: "Finish" }), { twice: true }); // two quick confirm taps, one request
  await expect.poll(async () => (await jobsOf(JOBS.tapA)).finished_at).not.toBeNull();
  const after = await jobsOf(JOBS.tapA);
  expect(after.started_at).toBe(started); // the existing start time is kept
  expect(after.stage).toBe("inspection");
  // A finished job leaves the Active tab for Inspection.
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await expect(row.getByRole("button", { name: "Finish" })).toBeDisabled();
  await expect(playControl(row, JOBS.tapA)).toHaveCount(0); // finished: no Play or Pause
  expect(patches.filter((body) => body.includes("finished_at"))).toHaveLength(1);
  await row.getByRole("button", { name: "Finish" }).click({ force: true });
  await page.waitForTimeout(500);
  expect(await jobsOf(JOBS.tapA)).toEqual(after);
});

test("Finish on a job that was never started records both at the same moment, and cards and table agree", async ({ page }) => {
  await guardNetwork(page.context());
  await signIn(page, alpha().users.office);
  await openJobs(page);
  // Cards view: the same helper decides.
  await page.getByRole("button", { name: "Cards", exact: true }).click();
  const card = cardOf(page, JOBS.tapB);
  await confirmFinish(page, card.getByRole("button", { name: "Finish" }));
  await expect.poll(async () => (await jobsOf(JOBS.tapB)).finished_at).not.toBeNull();
  const done = await jobsOf(JOBS.tapB);
  expect(done.started_at).toBe(done.finished_at);
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await expect(playControl(card, JOBS.tapB)).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Finish" })).toBeDisabled();
  // Table view.
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("button", { name: "All", exact: true }).first().click(); // the Show tab "All", not the status filter
  const row = rowOf(page, JOBS.tapB);
  await expect(playControl(row, JOBS.tapB)).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Finish" })).toBeDisabled();
  // Already started (bulk Start, no runs): "Start timer" (049, R2.3) and Finish open; rework: neither shown; viewer: neither shown.
  await expect(playControl(rowOf(page, JOBS.started), JOBS.started)).toHaveAccessibleName(`Start timer ${JOBS.started}`);
  await expect(rowOf(page, JOBS.started).getByRole("button", { name: "Finish" })).toBeEnabled();
  await expect(rowOf(page, JOBS.rework).getByRole("button", { name: "Start" })).toHaveCount(0);
  await expect(rowOf(page, JOBS.rework).getByRole("button", { name: "Finish" })).toHaveCount(0);
  await expect(rowOf(page, JOBS.rework).getByRole("button", { name: "Rework", exact: true })).toBeVisible();
});

test("a board that is out of date still can't replace a recorded start or finish time", async ({ page }) => {
  await guardNetwork(page.context());
  await signIn(page, alpha().users.admin);
  await openJobs(page);
  // Wait until the board has loaded both rows as open, then change them behind its back.
  await expect(playControl(rowOf(page, JOBS.stale), JOBS.stale)).toHaveAccessibleName(`Start ${JOBS.stale}`);
  await expect(rowOf(page, JOBS.staleF).getByRole("button", { name: "Finish" })).toBeEnabled();
  const startedElsewhere = "2026-10-05T07:30:00+00:00";
  const finishedElsewhere = "2026-10-06T16:45:00+00:00";
  expect((await adminClient().from("jobs").update({ started_at: startedElsewhere }).eq("organization_id", alpha().id).eq("job_no", JOBS.stale)).error).toBeNull();
  expect((await adminClient().from("jobs").update({ started_at: startedElsewhere, finished_at: finishedElsewhere, stage: "inspection" }).eq("organization_id", alpha().id).eq("job_no", JOBS.staleF)).error).toBeNull();
  // The page still shows both as open: tap Start on one and Finish on the other.
  await expect(playControl(rowOf(page, JOBS.stale), JOBS.stale)).toHaveAccessibleName(`Start ${JOBS.stale}`);
  await expect(rowOf(page, JOBS.staleF).getByRole("button", { name: "Finish" })).toBeEnabled();
  // 049: Play on the bench (ticked deliberately) times the job from now; its recorded start time is never replaced.
  await playJob(page, rowOf(page, JOBS.stale), JOBS.stale, { bench: true });
  await expect(page.getByText(`${JOBS.stale} started on the bench.`)).toBeVisible();
  await confirmFinish(page, rowOf(page, JOBS.staleF).getByRole("button", { name: "Finish" }));
  await expect(page.getByText("The job wasn't updated: it was already finished, so the recorded time is kept. Reload the board.")).toBeVisible();
  const a = await jobsOf(JOBS.stale);
  const b = await jobsOf(JOBS.staleF);
  expect(new Date(a.started_at!).toISOString()).toBe(new Date(startedElsewhere).toISOString());
  expect(new Date(b.started_at!).toISOString()).toBe(new Date(startedElsewhere).toISOString());
  expect(new Date(b.finished_at!).toISOString()).toBe(new Date(finishedElsewhere).toISOString());
});

test("viewer sees neither Start nor Finish; only an inspector is offered the Inspected action on a finished job", async ({ page, browser }) => {
  await guardNetwork(page.context());
  await signIn(page, alpha().users.viewer);
  await openJobs(page);
  await expect(rowOf(page, JOBS.started).getByRole("button", { name: "Start" })).toHaveCount(0);
  await expect(rowOf(page, JOBS.started).getByRole("button", { name: "Finish" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Start Selected/ })).toHaveCount(0);

  // An inspector (the alpha workshop user) can open the inspection dialog on the finished job; a workshop user who is not an inspector is not offered Inspected.
  const second = await browser.newContext({ baseURL: baseURL() });
  await guardNetwork(second);
  const other = await second.newPage();
  await signIn(other, alpha().users.workshop);
  await openJobs(other);
  await other.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await rowOf(other, JOBS.finished).getByRole("button", { name: "Inspected" }).click();
  const dialog = other.getByRole("dialog", { name: `Record inspection: ${JOBS.finished}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("An admin has to make you an inspector")).toHaveCount(0);
  await second.close();

  const third = await browser.newContext({ baseURL: baseURL() });
  await guardNetwork(third);
  const nonInspector = await third.newPage();
  await signIn(nonInspector, extra.noInspect);
  await openJobs(nonInspector);
  await nonInspector.getByRole("button", { name: /^Waiting for inspection/ }).click();
  // G20: someone not on the inspectors list is not offered Inspected at all (no tap that ends in a dialog that cannot save).
  await expect(rowOf(nonInspector, JOBS.finished)).toBeVisible();
  await expect(rowOf(nonInspector, JOBS.finished).getByRole("button", { name: "Inspected" })).toHaveCount(0);
  await third.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Card selection, counts, "all filtered" vs "selected", bulk confirmation naming the jobs (phone, touch)
// ---------------------------------------------------------------------------------------------------------------------

test("phone: cards select one by one, the count is right, bulk Finish names the real targets and leaves finished jobs alone", async ({ browser }) => {
  const { context, page } = await device(browser, PHONE);
  await signIn(page, alpha().users.office);
  await openJobs(page);
  const summary = page.getByTestId("selection-summary");

  const pick = ["U01", "U02", "U03"].map((s) => no(s));
  for (const job of pick) {
    const box = cardOf(page, job).getByRole("checkbox", { name: `Select ${job}` });
    await expectTarget("phone/office", `card checkbox ${job}`, hitArea(box), 44, 44);
    await box.tap();
  }
  await expect(summary).toContainText("3 selected");
  expect(await summary.textContent()).toMatch(/3 selected of \d+ filtered jobs?/);

  // Select all filtered is its own thing: the label carries the number, and it matches what is on screen.
  const allButton = page.getByRole("button", { name: /^Select all \d+ filtered$/ });
  const filtered = Number(/(\d+)/.exec((await allButton.textContent())!)![1]);
  expect(await page.locator('[data-testid="job-card"]:visible').count()).toBe(filtered);
  await expectTarget("phone/office", "Select all filtered", allButton, 44, 44);
  await allButton.tap();
  await expect(summary).toContainText(`${filtered} selected of ${filtered} filtered`);
  await page.getByRole("button", { name: "Clear selection" }).tap();
  await expect(summary).toContainText("0 selected");

  // Three unstarted jobs and one already started.
  for (const job of [...pick, JOBS.started]) await cardOf(page, job).getByRole("checkbox", { name: `Select ${job}` }).tap();
  await expect(summary).toContainText("4 selected");
  // Bulk Start is gone from the Job Board (a start is recorded per job with Play); Finish Selected stays, and counts the selection.
  await expect(page.getByRole("button", { name: /^Start Selected/ })).toHaveCount(0);
  const finishSelected = page.getByRole("button", { name: /^Finish Selected/ });
  await expect(finishSelected).toHaveText("Finish Selected (4)");
  await expectTarget("phone/office", "Finish Selected", finishSelected, 44, 44);
  const dialog = page.getByRole("dialog");

  // A long selection is cut sensibly: 11 names, the first 8 and "+3 more". One already finished job is selected too: it is left as it is.
  await page.getByRole("button", { name: "Clear selection" }).tap();
  const many = unstarted().slice(3, 14); // 11 unstarted jobs: the targets
  for (const job of [...many, JOBS.finished]) await cardOf(page, job).getByRole("checkbox", { name: `Select ${job}` }).tap();
  await expect(summary).toContainText("12 selected");
  await page.getByRole("button", { name: /^Finish Selected/ }).tap();
  await expect(dialog.getByRole("heading", { name: "Finish 11 selected jobs?" })).toBeVisible();
  const listed = (await dialog.getByTestId("bulk-targets").textContent())!;
  expect(listed).toContain("+3 more");
  // The finished job is named under "Left as they are", never among the targets.
  await expect(dialog.getByTestId("bulk-skipped")).toContainText("Left as they are (1)");
  await expect(dialog.getByTestId("bulk-skipped")).toContainText(JOBS.finished);
  await expect(dialog.getByTestId("bulk-targets")).not.toContainText(JOBS.finished);
  // The board's order decides which eight are named; all of them are ones that were selected, none repeated.
  const named = listed.match(new RegExp(`UI1-${tag()}-U\\d\\d`, "g")) ?? [];
  expect(named).toHaveLength(8);
  expect(new Set(named).size).toBe(8);
  for (const job of named) expect(many).toContain(job);
  // Touch targets in the bulk dialog: Cancel and the "Finish 11 jobs" confirm (the count of targets, not of the selection).
  await expectTarget("phone/office", "bulk dialog Cancel", dialog.getByRole("button", { name: "Cancel", exact: true }), 44, 44);
  await expectTarget("phone/office", "bulk dialog Finish 11 jobs", dialog.getByRole("button", { name: "Finish 11 jobs", exact: true }), 44, 44);
  await dialog.getByRole("button", { name: "Cancel" }).tap();
  for (const job of many) expect((await jobsOf(job)).finished_at).toBeNull();

  // Selected jobs that a filter hides are dropped from the selection, so Finish acts on visible jobs only.
  await page.getByRole("button", { name: /^Late \(\d+\)$/ }).tap();
  await expect(summary).toContainText("0 selected of");
  await expect(page.getByRole("button", { name: /^Finish Selected/ })).toBeDisabled();
  await page.getByRole("button", { name: "All", exact: true }).first().tap();
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Removing drafts and certificates asks first (tablet, touch)
// ---------------------------------------------------------------------------------------------------------------------

test("tablet: deleting a draft invoice, a draft credit note and a certificate each asks first", async ({ browser }) => {
  const admin = adminClient();
  const org = alpha().id;
  const customer = `UI1 Draft ${tag()} Ltd`;
  // A draft invoice, an issued invoice for the credit note, and a certificate on a delivery note.
  const draft = await admin.from("invoices").insert({ organization_id: org, invoice_ref: null, customer, status: "draft", subtotal: 50, vat: 0, total: 50, vat_enabled: false, due_date: "2099-01-31", description: "Draft" }).select("id").single();
  expect(draft.error).toBeNull();
  const ref = `INV-UI1-${tag()}`;
  const issued = await admin.from("invoices").insert({ organization_id: org, invoice_ref: null, customer: "UI1 Credit Ltd", status: "draft", subtotal: 100, vat: 20, total: 120, vat_enabled: true, due_date: "2099-01-31", description: "Bush" }).select("id").single();
  expect(issued.error).toBeNull();
  expect((await admin.from("invoice_line_items").insert({ organization_id: org, invoice_id: issued.data!.id, position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20 })).error).toBeNull();
  expect((await admin.from("invoices").update({ invoice_ref: ref, status: "sent" }).eq("id", issued.data!.id)).error).toBeNull();
  const certJob = (await jobsOf(JOBS.certJob)).id;
  const dn = `DLN-UI1-${tag()}`;
  expect((await admin.from("delivery_notes").insert({ organization_id: org, dn_number: dn, customer: "Synthetic Cert Co", job_ref: JOBS.certJob, status: "awaiting" })).error).toBeNull();
  const cert = await admin.from("job_files").insert({ organization_id: org, job_id: certJob, kind: "cert", ref: "Heat UI1", file_name: "cert-ui1.png", storage_bucket: "job-drawings", storage_path: `${org}/${certJob}/certs/ui1-cert.png` }).select("id").single();
  expect(cert.error).toBeNull();

  const { context, page } = await device(browser, TABLET);
  await signIn(page, extra.office);
  const dialog = page.getByRole("dialog").last();

  // Draft invoice.
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: customer }).getByRole("button", { name: "View" }).tap();
  await page.getByRole("button", { name: "Delete Draft" }).tap();
  await expect(page.getByRole("heading", { name: `Delete this draft invoice for ${customer}?` })).toBeVisible();
  expect((await admin.from("invoices").select("id").eq("id", draft.data!.id)).data).toHaveLength(1);
  await expectTarget("tablet/office", "Keep draft", dialog.getByRole("button", { name: "Keep draft" }), 44, 44);
  await expectTarget("tablet/office", "dialog close (confirm)", dialog.getByRole("button", { name: "Close", exact: true }), 44, 44);
  await dialog.getByRole("button", { name: "Keep draft" }).tap();
  expect((await admin.from("invoices").select("id").eq("id", draft.data!.id)).data).toHaveLength(1);
  await page.getByRole("button", { name: "Delete Draft" }).tap();
  await dialog.getByRole("button", { name: "Delete draft", exact: true }).tap();
  await expect.poll(async () => (await admin.from("invoices").select("id").eq("id", draft.data!.id)).data).toHaveLength(0);

  // Draft credit note.
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).tap();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  const panel = details.getByRole("region", { name: "Credit notes" });
  await panel.getByRole("button", { name: "New credit note" }).tap();
  await panel.getByLabel("Quantity to credit: Bush").fill("1");
  await panel.getByLabel("Reason for the credit").fill("One bush returned");
  await panel.getByRole("button", { name: "Save draft credit note" }).tap();
  const noteRow = panel.getByTestId("credit-note-row");
  await expect(noteRow).toContainText("Draft");
  await noteRow.getByRole("button", { name: "Delete draft" }).tap();
  await expect(page.getByRole("heading", { name: `Delete draft credit note for ${ref}?` })).toBeVisible();
  expect((await admin.from("credit_notes").select("id").eq("invoice_id", issued.data!.id)).data).toHaveLength(1);
  await page.getByRole("dialog").last().getByRole("button", { name: "Keep draft" }).tap();
  expect((await admin.from("credit_notes").select("id").eq("invoice_id", issued.data!.id)).data).toHaveLength(1);
  await noteRow.getByRole("button", { name: "Delete draft" }).tap();
  await page.getByRole("dialog").last().getByRole("button", { name: "Delete draft", exact: true }).tap();
  await expect.poll(async () => (await admin.from("credit_notes").select("id").eq("invoice_id", issued.data!.id)).data).toHaveLength(0);

  // Certificate.
  await page.goto("/delivery-notes");
  await page.getByRole("row").filter({ hasText: dn }).getByRole("button", { name: "View" }).tap();
  const detail = page.getByRole("dialog", { name: dn });
  await detail.getByRole("button", { name: "Remove" }).tap();
  await expect(page.getByRole("heading", { name: "Remove cert-ui1.png from the cert pack?" })).toBeVisible();
  expect((await admin.from("job_files").select("id").eq("id", cert.data!.id)).data).toHaveLength(1);
  await page.getByRole("dialog").last().getByRole("button", { name: "Keep certificate" }).tap();
  expect((await admin.from("job_files").select("id").eq("id", cert.data!.id)).data).toHaveLength(1);
  await detail.getByRole("button", { name: "Remove" }).tap();
  await page.getByRole("dialog").last().getByRole("button", { name: "Remove certificate" }).tap();
  await expect.poll(async () => (await admin.from("job_files").select("id").eq("id", cert.data!.id)).data).toHaveLength(0);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Every link offered opens a permitted page
// ---------------------------------------------------------------------------------------------------------------------

async function offeredLinks(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const hrefs = await page.$$eval("a[href^='/']", (anchors) => anchors.filter((a) => (a as HTMLElement).offsetParent !== null).map((a) => a.getAttribute("href")!));
  return [...new Set(hrefs.map((href) => href.split("#")[0]).filter((href) => !href.startsWith("/api/")))];
}

async function expectLinksOpen(page: Page, who: string, links: string[]) {
  expect(links.length, `${who}: found links`).toBeGreaterThan(0);
  for (const href of links) {
    await page.goto(href);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Access Denied" }), `${who}: ${href} access denied`).toHaveCount(0);
    expect(new URL(page.url()).pathname, `${who}: ${href} opened`).toBe(new URL(href, "http://x").pathname);
    expect(page.url(), `${who}: ${href} blocked redirect`).not.toContain("blocked=1");
    await page.waitForTimeout(2300); // the page's own role gate would redirect after 2 seconds
    expect(new URL(page.url()).pathname, `${who}: ${href} still open`).toBe(new URL(href, "http://x").pathname);
  }
}

async function chooseView(page: Page, label: "Admin" | "Office" | "Workshop") {
  await page.goto("/select-role");
  await page.getByRole("button", { name: `Continue as ${label}` }).click();
  await page.waitForURL(/\/dashboard/);
}

const identities: Array<{ name: string; user: () => SyntheticUser; view?: "Workshop"; bell: boolean; approvalLink: boolean }> = [
  { name: "admin", user: () => alpha().users.admin, bell: true, approvalLink: true },
  { name: "office", user: () => alpha().users.office, bell: true, approvalLink: true },
  { name: "workshop", user: () => alpha().users.workshop, bell: false, approvalLink: false },
  { name: "viewer", user: () => alpha().users.viewer, bell: false, approvalLink: false },
  { name: "admin in the workshop view", user: () => alpha().users.admin, view: "Workshop", bell: false, approvalLink: false },
  { name: "office with approval, customers and quotes hidden", user: () => extra.hidden, bell: false, approvalLink: false },
];

for (const identity of identities) {
  test(`links offered to ${identity.name} open permitted pages (no access denied, no blocked redirect)`, async ({ page }) => {
    // Every offered link is opened and held 2.3 s (the role gate's delay); the admin's list alone took 84 s of the 90 s default.
    test.setTimeout(240_000);
    await guardNetwork(page.context());
    await signIn(page, identity.user());
    if (identity.view) await chooseView(page, identity.view);
    const links = await offeredLinks(page);
    const bell = page.getByRole("link", { name: "Notifications" });
    if (identity.bell) await expect(bell).toBeVisible();
    else await expect(bell).toHaveCount(0);
    expect(links.includes("/approval"), `${identity.name}: approval link offered`).toBe(identity.approvalLink);
    if (identity.name.startsWith("office with")) {
      for (const hidden of ["/approval", "/customers", "/quotes"]) expect(links, `${hidden} must not be offered`).not.toContain(hidden);
      await page.goto("/approval");
      await expect(page).toHaveURL(/\/dashboard/); // and it really is closed to them
    }
    await expectLinksOpen(page, identity.name, links);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Touch sizes and layout, per role and device
// ---------------------------------------------------------------------------------------------------------------------

test("phone: nothing scrolls sideways at 390px with a 120-character company, a 240-character description and a long e-mail and address", async ({ browser }) => {
  const { context, page } = await device(browser, PHONE);
  await signIn(page, alpha().users.office);
  for (const route of ["/jobs", "/dashboard", "/customers"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    if (route === "/jobs") {
      await expect(cardOf(page, JOBS.long)).toContainText(COMPANY_120());
      await expect(cardOf(page, JOBS.long)).toContainText(DESCRIPTION_240());
    }
    if (route === "/customers") await expect(page.getByText(LONG_EMAIL())).toBeVisible();
    await noSidewaysScroll(page, `office ${route} @390`);
  }
  // With a dialog open.
  await page.goto("/jobs");
  await cardOf(page, JOBS.long).getByRole("button", { name: "Worksheet" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await noSidewaysScroll(page, "office worksheet dialog @390");
  await context.close();
});

test("phone, workshop: Start and Finish are at least 64px high, secondary controls at least 48px", async ({ browser }) => {
  const { context, page } = await device(browser, PHONE);
  await signIn(page, alpha().users.workshop);
  await openJobs(page);
  const card = cardOf(page, JOBS.tapC);
  await expectTarget("phone/workshop", "Start", playControl(card, JOBS.tapC), 44, 64);
  await expectTarget("phone/workshop", "Finish", card.getByRole("button", { name: "Finish" }), 44, 64);
  for (const name of ["Worksheet", "Print"]) await expectTarget("phone/workshop", name, card.getByRole(name === "Print" ? "link" : "button", { name }), 48, 48);
  await expectTarget("phone/workshop", "card checkbox", hitArea(card.getByRole("checkbox", { name: `Select ${JOBS.tapC}` })), 48, 48);
  await expectTarget("phone/workshop", "Select all filtered", page.getByRole("button", { name: /^Select all \d+ filtered$/ }), 44, 48);
  await expect(page.getByRole("button", { name: /^Start Selected/ })).toHaveCount(0);
  await expectTarget("phone/workshop", "Finish Selected", page.getByRole("button", { name: /^Finish Selected/ }), 44, 64);
  await expectTarget("phone/workshop", "Open tab", page.getByRole("button", { name: /^Open \(/ }), 44, 48);
  // Tap Start for real on the card (G20: no separate Done): the bench ticked in the bottom sheet, then the sheet's own Start.
  await card.getByRole("button", { name: new RegExp(`^Choose where ${JOBS.tapC} runs`) }).tap();
  const sheet = page.getByRole("dialog", { name: `${JOBS.tapC}: which machine?` });
  await expect(sheet.getByRole("button", { name: "Start", exact: true })).toBeDisabled(); // nothing ticked: no guessed default
  await sheet.getByLabel("No machine (bench)").check();
  await sheet.getByRole("button", { name: "Start", exact: true }).tap();
  await expect.poll(async () => (await jobsOf(JOBS.tapC)).started_at).not.toBeNull();
  await expect(pauseControl(card, JOBS.tapC)).toBeVisible();
  await noSidewaysScroll(page, "workshop /jobs @390");
  await context.close();
});

// The Job Board's List is a wide table with sticky columns that scrolls sideways inside its card, so up to 1024px (a tablet) it is shown as
// Cards (lib/view-mode listNeedsWide): the touch targets are checked on the cards, which have the same controls and the same sizes.
test("tablet: the job cards keep 44px targets with visible labels; admin and office are 44px, workshop 64/48", async ({ browser }) => {
  for (const [who, user] of [["office", alpha().users.office], ["admin", alpha().users.admin], ["workshop", alpha().users.workshop]] as const) {
    const { context, page } = await device(browser, TABLET);
    await signIn(page, user);
    await openJobs(page);
    // Cards are what a tablet shows (the List needs the desk layout), and there is no wide table in the page.
    const card = cardOf(page, JOBS.started);
    await expect(card).toBeVisible();
    await expect(page.locator("table:visible")).toHaveCount(0);
    const startH = who === "workshop" ? 64 : 44;
    const secondH = who === "workshop" ? 48 : 44;
    const start = playControl(card, JOBS.started);
    const finish = card.getByRole("button", { name: "Finish" });
    await expectTarget(`tablet/${who}`, "card Start", start, 44, startH);
    await expectTarget(`tablet/${who}`, "card Finish", finish, 44, startH);
    // Labelled on touch: the word is on screen, the accessible name is unchanged.
    await expect(finish).toContainText("Finish");
    await expect(card.getByRole("link", { name: "Print" })).toContainText("Print");
    for (const name of ["Worksheet"]) await expectTarget(`tablet/${who}`, `card ${name}`, card.getByRole("button", { name }), 44, secondH);
    await expectTarget(`tablet/${who}`, "card Print", card.getByRole("link", { name: "Print" }), 44, secondH);
    await expectTarget(`tablet/${who}`, "card checkbox", hitArea(card.getByRole("checkbox", { name: `Select ${JOBS.started}` })), 44, secondH);
    await expectTarget(`tablet/${who}`, "Select all filtered", page.getByRole("button", { name: /^Select all \d+ filtered$/ }), 44, secondH);
    await expectTarget(`tablet/${who}`, "view switcher Cards", page.getByRole("button", { name: "Cards", exact: true }), 44, secondH);
    await expectTarget(`tablet/${who}`, "Hours/Days toggle", page.getByRole("button", { name: "Hours", exact: true }), 44, secondH);
    // Touch it for real.
    await card.getByRole("checkbox", { name: `Select ${JOBS.started}` }).tap();
    await expect(page.getByTestId("selection-summary")).toContainText("1 selected");
    await context.close();
  }
});

test("dialog close and the sidebar menu are 44px on touch", async ({ browser }) => {
  const { context, page } = await device(browser, PHONE);
  await signIn(page, alpha().users.office);
  await openJobs(page);
  await page.getByRole("button", { name: "Open menu" }).tap();
  const menu = page.getByRole("dialog");
  await expect(menu).toBeVisible();
  await expectTarget("phone/office", "menu close", menu.getByRole("button", { name: "Close", exact: true }), 44, 44);
  for (const name of ["Job Board", "Quote Generator"]) await expectTarget("phone/office", `menu ${name}`, menu.getByRole("link", { name }), 44, 44);
  await expectTarget("phone/office", "account settings", menu.getByRole("button", { name: "Settings" }), 44, 44);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Nine screenshots: ADMIN / OFFICE / WORKSHOP x 390x844, 820x1180, 1280x800
// ---------------------------------------------------------------------------------------------------------------------

test("screenshots: Job Board with a selection, for each role at phone, tablet and desktop widths", async ({ browser }) => {
  test.slow(); // nine sign-ins and board loads in one test: 3x the 90s default
  const roles = [["admin", alpha().users.admin], ["office", alpha().users.office], ["workshop", alpha().users.workshop]] as const;
  const saved: string[] = [];
  for (const [role, user] of roles) {
    for (const viewport of [PHONE, TABLET, DESKTOP]) {
      const { context, page } = await device(browser, viewport);
      await signIn(page, user);
      await openJobs(page);
      for (const job of [JOBS.long, unstarted()[0]]) await page.getByRole("checkbox", { name: `Select ${job}` }).first().check();
      await expect(page.getByTestId("selection-summary")).toContainText("2 selected");
      if (viewport.name === "phone") await noSidewaysScroll(page, `${role} /jobs @390`);
      saved.push(await saveScreenshot(page, role, viewport, "job-board"));
      await context.close();
    }
  }
  expect(saved).toHaveLength(9);
});
