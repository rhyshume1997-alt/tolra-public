/**
 * Reports (app/(dashboard)/reports, lib/reports/*), in the browser. OFF (no "reports:on" marker in organization_settings.hidden_nav, the default):
 * the notice "Reports are switched off for your company." and none of the page's own reads. ON: admin and office see the figures for the
 * seeded jobs; the workshop is refused; another company's jobs never appear; no cost (no pound sign) is shown anywhere.
 *
 * Seeded in the alpha company, finished in a month 8 months ago so no other spec's jobs share that month: A on time, B late, C no due date, D internal
 * (finished late, must not count), plus A's plan (mill, 2.00 h) and run (2.50 h). The WIP check is exact by before/after: the page is read, then an open
 * job started 10 days ago and an open job not started are added, and the 8-14 and not-started counts must each go up by exactly 1 (the alpha company
 * is shared, so absolute counts are not asserted). Those two jobs are deleted again in afterAll.
 * The beta company gets its own finished job and machine, which alpha must never show.
 *
 * Reads are fingerprinted EXACTLY as postgrest-js sends them (select with its whitespace stripped, filters through URLSearchParams), because
 * other pages read the same tables. The marker is set and removed through SQL on the alpha company only and afterAll removes it again whatever happened.
 * Serial (the marker is shared state). Everything carries the run id, so teardown removes it with the run. Like the other specs there is no per-spec skip:
 * with no backend, global setup fails; listing needs none.
 * Must not change: the marker text (lib/reports/reports-switch.ts) or the visible texts asserted here.
 */
import { expect, test, type Page } from "@playwright/test";

import { REPORTS_OFF_NOTICE, REPORTS_ON_MARKER } from "@/lib/reports/reports-switch";

import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const JOB_SELECT = "id, job_no, customer, is_internal, started_at, finished_at, date_required, due_date".replace(/\s+/g, "");
const SESSION_SELECT = "id, job_id, started_at, ended_at, voided_at".replace(/\s+/g, "");
const REWORK_SELECT_START = "id,job_id,inspection_id,status,reason,instructions";
const DAY = 86_400_000;

let org = "";
let otherOrg = "";
let jobAId = "";
let millName = "";
let otherMillName = "";
let otherJobNo = "";
let monthKey = "";

test.describe.configure({ mode: "serial" });

const setSwitch = (on: boolean) => withDb(async (db) => {
  const done = await db.query(
    "update public.organization_settings set hidden_nav = case when $2::boolean then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1",
    [org, on, REPORTS_ON_MARKER],
  );
  if (done.rowCount !== 1) throw new Error(`no organization_settings row for ${org}`);
});

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  otherOrg = w.tenants.beta.id;
  millName = `Mill ${w.runId.slice(0, 6)}`;
  otherMillName = `Beta Mill ${w.runId.slice(0, 6)}`;
  otherJobNo = `J-RPT-BETA-${w.runId}`;
  const admin = adminClient();
  const finishedAt = new Date();
  finishedAt.setUTCMonth(finishedAt.getUTCMonth() - 8, 15);
  finishedAt.setUTCHours(12, 0, 0, 0);
  monthKey = finishedAt.toISOString().slice(0, 7);
  const day = (offset: number) => new Date(finishedAt.getTime() + offset * DAY).toISOString().slice(0, 10);
  const one = async (organization: string, table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", organization).eq(column, value).maybeSingle()).data;
    if (found) return found.id as string;
    const made = await admin.from(table).insert({ organization_id: organization, ...row }).select("id").single();
    expect(made.error).toBeNull();
    return made.data!.id as string;
  };
  const finished = { started_at: new Date(finishedAt.getTime() - DAY).toISOString(), finished_at: finishedAt.toISOString() };
  const no = (tag: string) => `J-RPT-${tag}-${w.runId}`;
  const machine = await one(org, "machines", "name", millName, { name: millName });
  jobAId = await one(org, "jobs", "job_no", no("A"), { job_no: no("A"), customer: "Reports Co", description: "On time", ...finished, date_required: day(3) });
  await one(org, "jobs", "job_no", no("B"), { job_no: no("B"), customer: "Reports Co", description: "Late", ...finished, date_required: day(-3) });
  await one(org, "jobs", "job_no", no("C"), { job_no: no("C"), customer: "Reports Co", description: "No due date", ...finished });
  await one(org, "jobs", "job_no", no("D"), { job_no: no("D"), customer: null, is_internal: true, description: "Tooling, late", ...finished, date_required: day(-3) });
  if (!(await admin.from("job_machines").select("id").eq("job_id", jobAId).eq("machine_id", machine).maybeSingle()).data) {
    expect((await admin.from("job_machines").insert({ organization_id: org, job_id: jobAId, machine_id: machine, estimated_hours: 2 })).error).toBeNull();
  }
  if (!(await admin.from("machine_runs").select("id").eq("job_id", jobAId).eq("machine_id", machine).maybeSingle()).data) {
    const started = finishedAt.getTime() - 5 * 3_600_000;
    expect((await admin.from("machine_runs").insert({ organization_id: org, job_id: jobAId, machine_id: machine, started_at: new Date(started).toISOString(), ended_at: new Date(started + 2.5 * 3_600_000).toISOString(), end_reason: "paused" })).error).toBeNull();
  }
  // Another company's finished job with a run: alpha must never show it.
  const otherMachine = await one(otherOrg, "machines", "name", otherMillName, { name: otherMillName });
  const otherJob = await one(otherOrg, "jobs", "job_no", otherJobNo, { job_no: otherJobNo, customer: "Other Co", description: "Other company", ...finished, date_required: day(-3) });
  if (!(await admin.from("machine_runs").select("id").eq("job_id", otherJob).eq("machine_id", otherMachine).maybeSingle()).data) {
    const started = finishedAt.getTime() - 5 * 3_600_000;
    expect((await admin.from("machine_runs").insert({ organization_id: otherOrg, job_id: otherJob, machine_id: otherMachine, started_at: new Date(started).toISOString(), ended_at: new Date(started + 3_600_000).toISOString(), end_reason: "paused" })).error).toBeNull();
  }
  await setSwitch(false);
});

const openNo = (tag: string) => `J-RPT-${tag}-${w.runId}`;
const removeOpenJobs = () => withDb(async (db) => { await db.query("delete from public.jobs where organization_id = $1 and job_no = any($2)", [org, [openNo("E"), openNo("F")]]); });
const addOpenJobs = async () => {
  const made = await adminClient().from("jobs").insert([
    { organization_id: org, job_no: openNo("E"), customer: "Reports Co", description: "Open, 10 days", started_at: new Date(Date.now() - 10 * DAY).toISOString() },
    { organization_id: org, job_no: openNo("F"), customer: "Reports Co", description: "Open, not started" },
  ]);
  expect(made.error).toBeNull();
};

test.afterAll(async () => {
  await removeOpenJobs();
  await setSwitch(false);
});

/** The page's own reads, by exact query shape. `finished` and `open` are the two jobs reads; the others each belong to one card. */
function reportReads(page: Page) {
  const reads = { finished: [] as string[], open: [] as string[], despatch: [] as string[], sessions: [] as string[], rework: [] as string[] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    const q = url.searchParams;
    const path = url.pathname;
    if (path.endsWith("/rest/v1/jobs") && q.get("select") === JOB_SELECT) {
      if (q.getAll("finished_at").some((v) => v.startsWith("gte."))) reads.finished.push(request.url());
      if (q.get("finished_at") === "is.null") reads.open.push(request.url());
    }
    if (path.endsWith("/rest/v1/delivery_notes") && q.get("select") === "id,job_id,despatched_at" && q.get("despatched_at") === "not.is.null") reads.despatch.push(request.url());
    if (path.endsWith("/rest/v1/operator_sessions") && q.get("select") === SESSION_SELECT && (q.get("job_id") ?? "").startsWith("in.(") && (q.get("job_id") ?? "").includes(jobAId)) reads.sessions.push(request.url());
    if (path.endsWith("/rest/v1/job_rework") && (q.get("select") ?? "").startsWith(REWORK_SELECT_START) && q.getAll("raised_at").some((v) => v.startsWith("gte."))) reads.rework.push(request.url());
  });
  return reads;
}

const cellTexts = (row: ReturnType<Page["locator"]>) => row.getByRole("cell").allTextContents();

async function openReports(page: Page) {
  await page.goto("/reports");
  await expect(page.getByTestId("reports-view")).toBeVisible();
  await expect(page.getByTestId("reports-calculated-at")).toBeVisible();
  // Every card has settled (a card shows a skeleton until its read ends).
  await expect(page.getByTestId("report-on-time").getByTestId("on-time-month")).toHaveCount(12);
  await expect(page.getByTestId("report-ncr").getByTestId("ncr-month")).toHaveCount(12);
}

test("switch off (the default): the notice, and none of the page's reads", async ({ page }) => {
  test.setTimeout(120_000);
  await setSwitch(false);
  const reads = reportReads(page);
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/reports");
  await expect(page.getByText(REPORTS_OFF_NOTICE)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("reports-view")).toHaveCount(0);
  for (const [name, found] of Object.entries(reads)) expect(found, `${name} reads while off`).toHaveLength(0);
  // Control: switched on, every one of the same fingerprints fires, so the zeros above are real zeros and not matches that cannot fire.
  await setSwitch(true);
  await openReports(page);
  for (const [name, found] of Object.entries(reads)) expect(found.length, `${name} reads while on`).toBeGreaterThanOrEqual(1);
});

test("switch on: admin and office see the seeded figures, nothing of another company, and no cost", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await setSwitch(true);
  for (const role of ["admin", "office"] as const) {
    const context = role === "admin" ? page.context() : await browser.newContext();
    const p = role === "admin" ? page : await context.newPage();
    await signIn(p, w.tenants.alpha.users[role]);
    await openReports(p);
    // On-time: A on time, B late, C no due date; D (internal) not counted. 1 of 2 dated jobs = 50%.
    const month = p.getByTestId("on-time-month").and(p.locator(`[data-month="${monthKey}"]`));
    await expect(month).toHaveCount(1);
    const cells = await cellTexts(month);
    expect(cells.slice(1)).toEqual(["3", "1", "1", "1", "50%"]);
    // Late jobs: the one late job is in the month's Late column (1); an empty month shows a dash, not 0%.
    const empty = p.getByTestId("on-time-month").filter({ hasText: "–" });
    expect(await empty.count()).toBeGreaterThanOrEqual(1);
    // WIP ageing, exact by before/after: adding one open job started 10 days ago and one not started moves those two counts by exactly 1.
    const band = async (key: string) => Number((await cellTexts(p.getByTestId("wip-band").and(p.locator(`[data-band="${key}"]`))))[1]);
    await removeOpenJobs();
    await openReports(p);
    const before = { aged: await band("8-14"), idle: await band("not-started"), others: [await band("0-7"), await band("15-30"), await band("31-60"), await band("61+")] };
    await addOpenJobs();
    await openReports(p);
    expect(await band("8-14")).toBe(before.aged + 1);
    expect(await band("not-started")).toBe(before.idle + 1);
    expect([await band("0-7"), await band("15-30"), await band("31-60"), await band("61+")]).toEqual(before.others);
    await removeOpenJobs();
    // Machine hours: the mill, planned 2.00, actual 2.50, +0.50, over plan.
    const mill = p.getByTestId("machine-row").filter({ hasText: millName });
    await expect(mill).toHaveCount(1);
    const m = await cellTexts(mill);
    expect([m[2], m[3], m[4], m[6]]).toEqual(["2.00", "2.50", "+0.50", "Over plan"]);
    // Another company's job and machine never appear.
    await expect(p.getByText(otherMillName)).toHaveCount(0);
    await expect(p.getByText(otherJobNo)).toHaveCount(0);
    // No cost anywhere on the page, and it says so.
    await expect(p.getByTestId("reports-view")).not.toContainText("£");
    await expect(p.getByTestId("reports-view")).toContainText("No costs are shown here");
    if (role === "office") await context.close();
  }
});

test("switch on: the workshop is refused and nothing is read", async ({ browser }) => {
  test.setTimeout(120_000);
  await setSwitch(true);
  const context = await browser.newContext();
  const page = await context.newPage();
  const reads = reportReads(page);
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Access Denied" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("reports-view")).toHaveCount(0);
  for (const [name, found] of Object.entries(reads)) expect(found, `${name} reads for the workshop`).toHaveLength(0);
  await context.close();
});
