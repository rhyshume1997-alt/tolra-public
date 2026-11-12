/**
 * Jobs: the NCR register at /jobs/ncr, in the browser (components/jobs/ncr-register, lib/jobs/load-ncr-register, lib/jobs/ncr-register*).
 * OFF (no "job-ncr-register:on" marker in organization_settings.hidden_nav, the default): the off notice, and none of the page's own reads
 * (job_rework, job_inspections, job_problems, job_rework_entries, job_rework_entry_values, jobs) is made. ON: admin and office see a seeded
 * rework, concession and problem with their type, status and the summary tiles; an empty date range shows zero tiles and no rows; the
 * Type and Status filters change the rows; workshop and viewer see "Access Denied" and nothing is read; beta's records never show for alpha.
 *
 * Shares the alpha company (it needs its office, workshop and viewer users), so the marker is set and removed through SQL on that company
 * only, and afterAll removes it again whatever happened: nothing leaks to other specs. Serial, as the marker is shared state. The records
 * sit on jobs carrying the run id, in March 2001 (a window no other spec writes to), so teardown removes them with the rest of the run and
 * the counts below are this spec's alone. Like the other specs of this suite there is no per-spec skip: with no backend, global setup
 * fails (the suite never skips); listing needs none.
 * Must not change: the marker text (lib/jobs/ncr-register-switch.ts) or the visible texts asserted here.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { NCR_REGISTER_OFF_NOTICE, NCR_REGISTER_ON_MARKER } from "@/lib/jobs/ncr-register-switch";

import { adminClient, withDb, type TenantKey } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
let org = "";

/** The seeded records' window (UK dates; noon UTC is the same date in the UK in March) and one with nothing in it. */
const RANGE = { from: "2001-03-01", to: "2001-03-31" };
const EMPTY_RANGE = { from: "2001-01-01", to: "2001-01-31" };
const AT = { rework: "2001-03-05T12:00:00Z", reworkClosed: "2001-03-08T12:00:00Z", concession: "2001-03-06T12:00:00Z", problem: "2001-03-07T12:00:00Z" };

type Seeded = { jobNo: string; jobId: string; rework: string; instructions: string; concession: string; problem: string };
const seeded = {} as Record<TenantKey, Seeded>;

test.describe.configure({ mode: "serial" });

/** Sets the marker for the alpha company (the same hidden_nav list the switch lives in); `false` removes it. */
const setSwitch = (on: boolean) => withDb(async (db) => {
  const done = await db.query(
    "update public.organization_settings set hidden_nav = case when $2::boolean then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1",
    [org, on, NCR_REGISTER_ON_MARKER],
  );
  if (done.rowCount !== 1) throw new Error(`no organization_settings row for ${org}`);
});

/**
 * One job in the company with three records on it: a rework (raised 5 Mar, 4 affected, 1 scrapped, 1 remade, closed on passing
 * re-inspection 8 Mar), a concession inspection (6 Mar) and an open Problem (7 Mar). Idempotent: a worker that restarts runs this again.
 */
async function seed(key: TenantKey): Promise<Seeded> {
  const admin = adminClient();
  const orgId = w.tenants[key].id;
  const tag = `${key} ${w.runId}`;
  const out = {
    jobNo: key === "alpha" ? `J-NCR-${w.runId}` : `J-NCRB-${w.runId}`, jobId: "",
    rework: `NCR rework ${tag}`, instructions: `Re-bore 4 off ${tag}`, concession: `NCR concession ${tag}`, problem: `NCR problem ${tag}`,
  };
  const found = (await admin.from("jobs").select("id").eq("organization_id", orgId).eq("job_no", out.jobNo).maybeSingle()).data;
  if (found) out.jobId = found.id as string;
  else {
    const { data, error } = await admin.from("jobs").insert({
      organization_id: orgId, job_no: out.jobNo, customer: "NCR Co", description: "Bush", stage: "inspection", quantity_required: 10,
      started_at: "2001-03-01T08:00:00Z", finished_at: "2001-03-02T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
    }).select("id").single();
    expect(error).toBeNull();
    out.jobId = data!.id as string;
  }
  const none = async (table: string) => !(await admin.from(table).select("id").eq("job_id", out.jobId).limit(1)).data?.length;
  if (await none("job_rework")) {
    expect((await admin.from("job_rework").insert({
      organization_id: orgId, job_id: out.jobId, status: "closed", closed_how: "passed", reason: out.rework, instructions: out.instructions,
      affects_all: false, quantity_affected: 4, quantity_scrapped: 1, quantity_remade: 1, raised_at: AT.rework, closed_at: AT.reworkClosed,
    })).error).toBeNull();
  }
  if (await none("job_inspections")) {
    const version = (await admin.from("jobs").select("worksheet_version").eq("id", out.jobId).single()).data!.worksheet_version as number;
    expect((await admin.from("job_inspections").insert({
      organization_id: orgId, job_id: out.jobId, result: "concession", release_decision: "released", measured_notes: "Bore 0.02 over, fit checked",
      concession_reason: out.concession, inspector_id: null, inspector_name: `Office ${key}`, inspected_at: AT.concession, worksheet_version: version,
    })).error).toBeNull();
  }
  if (await none("job_problems")) {
    expect((await admin.from("job_problems").insert({
      organization_id: orgId, job_id: out.jobId, reason: "machine", note: out.problem, status: "open", reported_at: AT.problem, request_id: randomUUID(),
    })).error).toBeNull();
  }
  return out;
}

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  seeded.alpha = await seed("alpha");
  seeded.beta = await seed("beta");
  await setSwitch(false);
});

test.afterAll(async () => {
  await setSwitch(false);
});

/**
 * The register's own reads, by exact query shape (lib/jobs/load-ncr-register: supabase-js sends the column list with its spaces removed).
 * Nothing else on /jobs/ncr reads these tables with these column lists. The first three are made on every load (the control below).
 */
const READS: Record<string, string> = {
  job_rework: "id,job_id,inspection_id,status,reason,instructions,affects_all,quantity_affected,quantity_scrapped,quantity_remade,raised_at,closed_at,closed_how,follow_up_of,sales_order_line_id",
  job_inspections: "id,job_id,result,concession_reason,measured_notes,inspector_name,inspected_at",
  job_problems: "id,job_id,reason,note,status,reported_at,resolved_at,resolution_note",
  job_rework_entries: "id,rework_id,kind,hours",
  job_rework_entry_values: "entry_id,material_cost",
  jobs: "id,job_no,customer",
};

function registerReads(page: Page) {
  const reads: Record<string, string[]> = Object.fromEntries(Object.keys(READS).map((table) => [table, []]));
  page.on("request", (request) => {
    const url = new URL(request.url());
    const table = /\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (table && table in READS && url.searchParams.get("select") === READS[table]) reads[table].push(request.url());
  });
  return reads;
}

const expectNoReads = (reads: Record<string, string[]>) => {
  for (const table of Object.keys(READS)) expect(reads[table], `${table} read`).toHaveLength(0);
};

/** The page body: the heading's block. */
const register = (page: Page) => page.getByRole("heading", { level: 1, name: "NCR register", exact: true }).locator("xpath=../..");
const field = (scope: Locator, label: RegExp, control: "input" | "select") => scope.locator("label").filter({ hasText: label }).locator(control);
/** Each summary tile as [label, value]. */
const tiles = (scope: Locator) => scope.locator('[data-slot="card"]').evaluateAll((cards) => cards.map((card) => Array.from(card.querySelectorAll("div")).filter((d) => !d.querySelector("div")).map((d) => d.textContent ?? "")));
const rows = (scope: Locator) => scope.getByRole("table").locator("tbody tr");
const typeCells = (scope: Locator) => rows(scope).locator("td:nth-child(3)");

async function openRegister(page: Page, range: { from: string; to: string }) {
  await page.goto("/jobs/ncr");
  const body = register(page);
  await expect(body).toBeVisible();
  await field(body, /^From$/, "input").fill(range.from);
  await field(body, /^To$/, "input").fill(range.to);
  return body;
}

const SEEDED_TILES = [
  ["Total", "3"], ["Open", "1"], ["Closed", "2"], ["Concession inspections (by inspection date)", "1"],
  ["Failed inspections, no linked rework (legacy)", "0"], ["Rework", "1"], ["Inspection fail", "0"], ["Concession", "1"], ["Problem", "1"],
  ["Quantity scrapped", "1"], ["Average days to close", "1.5"],
];

test("switch off (the default): the off notice, and none of the register's reads is made", async ({ page }) => {
  await setSwitch(false);
  const reads = registerReads(page);
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/jobs/ncr");
  await expect(page.getByText(NCR_REGISTER_OFF_NOTICE, { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: "NCR register", exact: true })).toHaveCount(0);
  expectNoReads(reads);
  // Control: with the switch on, the same fingerprints do show up, so the zeros above are real zeros and not matches that can't fire.
  await setSwitch(true);
  await page.goto("/jobs/ncr"); // a fresh load, so the company's settings (and the marker) are read afresh
  await expect(register(page).locator('[data-slot="card"]').first()).toBeVisible();
  expect(reads.job_rework.length).toBeGreaterThanOrEqual(1);
  expect(reads.job_inspections.length).toBeGreaterThanOrEqual(1);
  expect(reads.job_problems.length).toBeGreaterThanOrEqual(1);
});

for (const role of ["admin", "office"] as const) {
  test(`switch on, ${role}: the seeded rework, concession and problem show with their type, status and the tile counts`, async ({ page }) => {
    await setSwitch(true);
    await signIn(page, w.tenants.alpha.users[role]);
    const body = await openRegister(page, RANGE);
    const { jobNo, rework, instructions, concession, problem } = seeded.alpha;
    await expect.poll(() => tiles(body)).toEqual(SEEDED_TILES);
    await expect(typeCells(body)).toHaveText(["Problem", "Concession", "Rework"]); // newest raised first
    const [p, c, r] = [rows(body).nth(0).getByRole("cell"), rows(body).nth(1).getByRole("cell"), rows(body).nth(2).getByRole("cell")];

    await expect(p.nth(0)).toHaveText(`${jobNo} Problem 2001-03-07`);
    await expect(p.nth(3)).toHaveText(`Machine: ${problem}`);
    await expect(p.nth(7)).toHaveText("Open");
    await expect(p.nth(8)).toHaveText("");

    await expect(c.nth(0)).toHaveText(`${jobNo} Concession 2001-03-06`);
    await expect(c.nth(3)).toContainText(concession);
    await expect(c.nth(3)).toContainText("Concession recorded by Office alpha");
    await expect(c.nth(7)).toHaveText("Closed");
    await expect(c.nth(8)).toContainText("Closed on concession");
    await expect(c.nth(9)).toHaveText("0");

    await expect(r.nth(0)).toHaveText(`${jobNo} Rework 2001-03-05`);
    await expect(r.nth(3)).toContainText(rework);
    await expect(r.nth(3)).toContainText(instructions);
    await expect(r.nth(4)).toHaveText("4");
    await expect(r.nth(5)).toHaveText("1");
    await expect(r.nth(6)).toHaveText("1");
    await expect(r.nth(7)).toHaveText("Closed");
    await expect(r.nth(8)).toContainText("Passed re-inspection");
    await expect(r.nth(9)).toHaveText("3");
  });
}

test("switch on, a date range with no records: every tile is zero and there are no rows", async ({ page }) => {
  await setSwitch(true);
  await signIn(page, w.tenants.alpha.users.admin);
  const body = await openRegister(page, EMPTY_RANGE);
  await expect.poll(() => tiles(body)).toEqual([
    ["Total", "0"], ["Open", "0"], ["Closed", "0"], ["Concession inspections (by inspection date)", "0"],
    ["Failed inspections, no linked rework (legacy)", "0"], ["Rework", "0"], ["Inspection fail", "0"], ["Concession", "0"], ["Problem", "0"],
    ["Quantity scrapped", "0"], ["Average days to close", "None closed"],
  ]);
  await expect(body.getByText("No records match these filters.", { exact: true })).toBeVisible();
  await expect(body.getByRole("table")).toHaveCount(0);
  await expect(body.getByRole("button", { name: "Download CSV" })).toBeDisabled();
});

test("switch on: the Type and Status filters change the rows shown", async ({ page }) => {
  await setSwitch(true);
  await signIn(page, w.tenants.alpha.users.admin);
  const body = await openRegister(page, RANGE);
  await expect(typeCells(body)).toHaveText(["Problem", "Concession", "Rework"]);
  const type = field(body, /^Type/, "select");
  const status = field(body, /^Status/, "select");

  await type.selectOption("Concession");
  await expect(typeCells(body)).toHaveText(["Concession"]);
  await expect(rows(body).first()).toContainText(seeded.alpha.concession);
  await type.selectOption("Rework");
  await expect(typeCells(body)).toHaveText(["Rework"]);
  await type.selectOption("Inspection fail");
  await expect(body.getByText("No records match these filters.", { exact: true })).toBeVisible();
  await expect(body.getByRole("table")).toHaveCount(0);
  await type.selectOption("all");

  await status.selectOption("open");
  await expect(typeCells(body)).toHaveText(["Problem"]);
  await status.selectOption("closed");
  await expect(typeCells(body)).toHaveText(["Concession", "Rework"]);
  await status.selectOption("all");
  await expect(typeCells(body)).toHaveText(["Problem", "Concession", "Rework"]);
});

for (const role of ["workshop", "viewer"] as const) {
  test(`switch on, ${role}: Access Denied, and none of the register's reads is made`, async ({ page }) => {
    await setSwitch(true);
    const reads = registerReads(page);
    await signIn(page, w.tenants.alpha.users[role]);
    await page.goto("/jobs/ncr");
    await expect(page.getByRole("heading", { name: "Access Denied", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "NCR register", exact: true })).toHaveCount(0);
    await expect(page.getByText(NCR_REGISTER_OFF_NOTICE, { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard/); // the refusal sends them back to the dashboard
    expectNoReads(reads);
  });
}

test("switch on: records seeded in the beta company never appear for alpha", async ({ page }) => {
  await setSwitch(true);
  // Control: beta's three records exist, in the same window as alpha's.
  const admin = adminClient();
  const beta = seeded.beta;
  for (const table of ["job_rework", "job_inspections", "job_problems"]) {
    const { data } = await admin.from(table).select("organization_id").eq("job_id", beta.jobId);
    expect(data, table).toEqual([{ organization_id: w.tenants.beta.id }]);
  }
  await signIn(page, w.tenants.alpha.users.admin);
  const body = await openRegister(page, RANGE);
  await expect.poll(() => tiles(body)).toEqual(SEEDED_TILES);
  await expect(typeCells(body)).toHaveText(["Problem", "Concession", "Rework"]);
  for (const text of [beta.jobNo, beta.rework, beta.instructions, beta.concession, beta.problem]) await expect(body).not.toContainText(text);
});
