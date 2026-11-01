/**
 * Job Board and Quotes lists do not overlap (Bug 1): in the fixed-layout List and Table views a cell's text must stay inside its cell
 * (the Stage cell's status line, "Running on ...", "Started (not timed)", "Waiting for inspection", "Paused", used to spill into the
 * Machine cell). For every cell: scrollWidth <= clientWidth + 1, and the Stage text box and the Machine cell box do not intersect.
 * The Cards layout (phone, 390 px) scrolls the page sideways never.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
let org = "";
let millName = "";
let mill = "";
const J: Record<string, string> = {};
const ids: Record<string, string> = {};
let releasedText = ""; // 092: "Stopped by <admin's full name>: <reason>" under the Stage of the released job

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  org = w.tenants.alpha.id;
  // A long machine name makes the Machine cell as busy as it can be.
  millName = `LY Mill with a long name ${w.runId}`;
  for (const key of ["running", "untimed", "inspect", "paused", "released"]) J[key] = `J-LY${key.toUpperCase()}-${w.runId}`;
  const admin = adminClient();
  const one = async (table: string, column: string, value: string, row: Record<string, unknown>) => {
    const found = (await admin.from(table).select("id").eq("organization_id", org).eq(column, value).maybeSingle()).data;
    return found ? (found.id as string) : ((await admin.from(table).insert({ organization_id: org, ...row }).select("id").single()).data!.id as string);
  };
  mill = await one("machines", "name", millName, { name: millName, active: true });
  for (const no of Object.values(J)) ids[no] = await one("jobs", "job_no", no, { job_no: no, customer: "Layout Co", description: `Layout ${no}` });
  const start = { p_machines: [mill], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null };
  const pauseArgs = { p_machines: null, p_client_op_id: null, p_ended_at: null };
  const workshop = await signedInClient(w.tenants.alpha.users.workshop);
  // Paused first: started, then paused (its run ends, the machine is free for the next). Then Running on the same mill: a machine
  // another job holds is refused (machine_in_use, 044/049), so the running job must start after the Pause, never before it.
  expect((await workshop.rpc("start_machine_run", { p_job: ids[J.paused], ...start })).error).toBeNull();
  expect((await workshop.rpc("pause_machine_run", { p_job: ids[J.paused], ...pauseArgs })).error).toBeNull();
  expect((await workshop.rpc("start_machine_run", { p_job: ids[J.running], ...start })).error).toBeNull();
  // Released: started on its own (planned, not booked) machine, then freed by an admin: "Stopped by <admin>: <reason>" (092) under the Stage,
  // beside a "Planned: ..." line in the Machine cell, the two that used to run into each other.
  const releaseMillName = `LY Release Mill ${w.runId}`;
  const releaseMill = await one("machines", "name", releaseMillName, { name: releaseMillName, active: true });
  if (!(await admin.from("job_machines").select("id").eq("job_id", ids[J.released])).data?.length) {
    expect((await admin.from("job_machines").insert({ organization_id: org, job_id: ids[J.released], machine_id: releaseMill, estimated_hours: 3 })).error).toBeNull();
  }
  expect((await workshop.rpc("start_machine_run", { p_job: ids[J.released], ...start, p_machines: [releaseMill] })).error).toBeNull();
  const adminUser = await signedInClient(w.tenants.alpha.users.admin);
  expect((await adminUser.rpc("release_machine", { p_machine: releaseMill, p_reason: "Layout check release" })).error).toBeNull();
  const adminName = (await admin.from("user_profiles").select("full_name").eq("id", w.tenants.alpha.users.admin.id).single()).data!.full_name as string;
  releasedText = `Stopped by ${adminName}: Layout check release`;
  // The mill is free again after the Pause; the first job's run is still open, so release it only in afterAll.
  await admin.from("jobs").update({ started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", ids[J.untimed]);
  // One still-booked booking tomorrow at 10:00, so the Machine Schedule has a timeline block for the "no hours left in a block" check to look at.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const bookedAt = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 10).toISOString();
  if (!(await admin.from("machine_bookings").select("id").eq("organization_id", org).eq("job_no", J.untimed)).data?.length) {
    expect((await admin.from("machine_bookings").insert({ organization_id: org, machine_id: mill, job_id: ids[J.untimed], job_no: J.untimed, description: "Layout booked block", start_at: bookedAt, estimated_hours: 2 })).error).toBeNull();
  }
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  await admin.from("jobs").update({ started_at: hourAgo, finished_at: new Date().toISOString() }).eq("id", ids[J.inspect]);
});

test.afterAll(async () => {
  const office = await signedInClient(w.tenants.alpha.users.office);
  for (const id of Object.values(ids)) await office.rpc("pause_machine_run", { p_job: id, p_machines: null, p_client_op_id: null, p_ended_at: null });
});

const box = async (locator: import("@playwright/test").Locator) => (await locator.boundingBox())!;

/** The cells (of the given rows) whose text spills out of them; a row is found by the CSS selector given. */
const spillsOf = (page: Page, rowSelectors: string[]) => page.evaluate((selectors) => {
  const out: string[] = [];
  for (const selector of selectors) {
    for (const cell of Array.from(document.querySelectorAll(`${selector} td`))) {
      const element = cell as HTMLElement;
      if (element.scrollWidth > element.clientWidth + 1) out.push(`${element.textContent?.trim().slice(0, 40)} (${element.scrollWidth} > ${element.clientWidth})`);
    }
  }
  return out;
}, rowSelectors);
const ourRows = () => Object.values(ids).map((id) => `tr[data-job-id="${id}"]`);

/** In the List view the Stage cell's contents sit wholly left of the Machine cell. */
async function expectStageClearOfMachine(page: Page, no: string, label: string) {
  const row = page.locator(`tr[data-job-id="${ids[no]}"]`);
  const progress = await box(row.getByTestId("job-progress"));
  const stageCell = row.locator("td").filter({ has: page.getByTestId("job-progress") });
  const machineCell = stageCell.locator("xpath=following-sibling::td[1]");
  const machine = await box(machineCell);
  const stage = await box(stageCell);
  expect(progress.x + progress.width, `${label} ${no}: Stage status line ends inside the Stage cell`).toBeLessThanOrEqual(stage.x + stage.width + 1);
  expect(stage.x + stage.width, `${label} ${no}: Stage cell does not reach the Machine cell`).toBeLessThanOrEqual(machine.x + 1);
}

for (const width of [1280]) { // Up to 1024px the List is shown as Cards (below).
  test(`List view at ${width}px: the Stage cell's status line stays out of the Machine cell`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, w.tenants.alpha.users.office);
    await page.goto("/jobs");
    await page.getByRole("button", { name: "List", exact: true }).click();
    for (const no of Object.values(J)) await expect(page.locator(`tr[data-job-id="${ids[no]}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-job-id="${ids[J.running]}"]`).getByTestId("job-progress")).toContainText("Running on");
    await expect(page.locator(`tr[data-job-id="${ids[J.untimed]}"]`).getByTestId("job-progress")).toHaveText("Started (not timed)");
    await expect(page.locator(`tr[data-job-id="${ids[J.inspect]}"]`).getByTestId("job-progress")).toHaveText("Waiting for inspection");
    await expect(page.locator(`tr[data-job-id="${ids[J.paused]}"]`).getByTestId("job-progress")).toHaveText("Paused");
    await expect(page.locator(`tr[data-job-id="${ids[J.released]}"]`).getByTestId("job-progress")).toHaveText(releasedText);
    await expect(page.locator(`tr[data-job-id="${ids[J.released]}"]`).getByTestId("job-machines")).toContainText("3 h");
    for (const no of Object.values(J)) await expectStageClearOfMachine(page, no, `list@${width}`);
    // Only the seeded rows are measured: other specs' rows share this company and are not ours to fail on.
    expect(await spillsOf(page, ourRows()), `list@${width}: cells whose text spills out`).toEqual([]);
  });
}

test("Table view at 1280px: Stage, Due, Started and Finished stay inside their cells", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await page.getByRole("button", { name: "Table", exact: true }).click();
  for (const no of Object.values(J)) await expect(page.locator(`tr[data-job-id="${ids[no]}"]`)).toBeVisible();
  expect(await spillsOf(page, ourRows()), "table@1280: cells whose text spills out").toEqual([]);
  // The released row: its progress words stay inside their own cell, clear of the Machine cell's "Planned:" line. In the Table view the
  // words are under the status badge in the Status column, which comes after Machine (the Stage cell holds only the stage there).
  const released = page.locator(`tr[data-job-id="${ids[J.released]}"]`);
  await expect(released.getByTestId("job-progress-text")).toContainText(releasedText);
  const words = await box(released.getByTestId("job-progress-text"));
  const wordsCell = await box(released.locator("td").filter({ has: page.getByTestId("job-progress-text") }));
  const planned = await box(released.getByTestId("job-machines"));
  expect(words.x, "table@1280: the released row's words start inside their cell").toBeGreaterThanOrEqual(wordsCell.x - 1);
  expect(words.x + words.width, "table@1280: the released row's words end inside their cell").toBeLessThanOrEqual(wordsCell.x + wordsCell.width + 1);
  expect(planned.x + planned.width, "table@1280: the Planned line ends before the words' cell starts").toBeLessThanOrEqual(wordsCell.x + 1);
});

test("Cards at 390px: no sideways page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  // By card, not getByText(no).first(): the hidden List table (display: none below md) comes first in the page and holds the same numbers.
  for (const no of Object.values(J)) await expect(page.locator(`[data-testid="job-card"][data-job-id="${ids[no]}"]:visible`)).toBeVisible();
  await expect(page.locator("table:visible")).toHaveCount(0);
  const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(scrolls, "the page scrolls sideways at 390 px").toBe(false);
  // The released card: the words under the status never run into the Planned line below them.
  const card = page.locator(`[data-testid="job-card"][data-job-id="${ids[J.released]}"]:visible`);
  const cardWords = await box(card.getByTestId("job-progress-text"));
  const cardPlanned = await box(card.getByTestId("job-machines"));
  expect(cardWords.y + cardWords.height, "cards@390: the released words end above the Planned line").toBeLessThanOrEqual(cardPlanned.y + 1);
  expect(cardWords.x + cardWords.width, "cards@390: the released words stay inside the card").toBeLessThanOrEqual(page.viewportSize()!.width);
});

for (const width of [1024, 820]) {
  test(`List (the default view) at ${width}px is shown as Cards: no table, nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, w.tenants.alpha.users.office);
    await page.goto("/jobs");
    for (const no of Object.values(J)) await expect(page.locator(`[data-testid="job-card"][data-job-id="${ids[no]}"]:visible`)).toBeVisible();
    await expect(page.locator("table:visible")).toHaveCount(0);
    // The switcher offers Cards only here (no List, no Table): the wide tables need more than 1024px.
    const choices = page.getByRole("group", { name: "View" });
    await expect(choices.getByRole("button", { name: "Cards", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(choices.getByRole("button", { name: "List", exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), `the page scrolls sideways at ${width}`).toBe(false);
  });
}

for (const width of [1280, 820]) {
  test(`Quotes at ${width}px: a Superseded status badge stays inside its cell`, async ({ page }) => {
    const ref = `QUO-LY${w.runId.slice(0, 4).replace(/\D/g, "7")}`;
    const customer = `Layout Quote Co ${w.runId}`;
    const found = (await adminClient().from("quotes").select("id").eq("organization_id", org).eq("quote_ref", ref).maybeSingle()).data;
    if (!found) {
      const admin = await signedInClient(w.tenants.alpha.users.admin);
      const { data: quoteId, error } = await admin.rpc("create_with_lines", {
        p_parent: "quotes",
        p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status: "sent", valid_until: "2099-12-31", description: "Layout" },
        p_child: "quote_line_items",
        p_fk: "quote_id",
        p_lines: [{ position: 0, description: "Part", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
      });
      expect(error).toBeNull();
      // Superseded the only way the database allows (068 quote_lifecycle_guard refuses sent -> superseded without a newer version, for
      // the service role too): revise it, which leaves this quote (v1) superseded and makes a " v2" draft that the Done phase never shows.
      expect((await admin.rpc("revise_quote", { p_quote: quoteId })).error).toBeNull();
    }
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/quotes");
    // The Quotes page opens on Cards (no table): the List view is the table checked here, at both widths.
    await page.getByRole("group", { name: "View" }).getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^Done \(/ }).click();
    const row = page.locator("table:visible tr", { hasText: ref });
    await expect(row).toBeVisible();
    const cell = row.locator("td").filter({ hasText: "Superseded" });
    const badge = await box(cell.getByText("Superseded"));
    const cellBox = await box(cell);
    expect(badge.x + badge.width, "Superseded badge ends inside its cell").toBeLessThanOrEqual(cellBox.x + cellBox.width + 1);
    const spills = await row.locator("td").evaluateAll((cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).map((cell) => cell.textContent?.trim().slice(0, 40)));
    expect(spills, `quotes@${width}: cells whose text spills out`).toEqual([]);
  });
}

for (const width of [1280, 820]) {
  test(`Machine Schedule at ${width}px: bar labels and cards stay inside their boxes, and no block repeats the hours left`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, w.tenants.alpha.users.office);
    await page.goto("/schedule");
    const bar = page.locator(`[data-testid="run-bar"][data-job-id="${ids[J.running]}"]`);
    await expect(bar).toBeVisible();
    // "Running" and the job number are inside the bar, whole (they wrap, they are not cut off with an ellipsis). A run minutes old is drawn
    // at the minimum width (12% of a day, 6-8 px at 2 weeks, all padding), narrower than one letter, so its wrapping labels overflow by a
    // letter whatever they do: a label counts as cut off when it overflows and cannot wrap (an ellipsis, nowrap, or a word that may not
    // break), checked on the elements that hold the text themselves. The bar's full words are its accessible name.
    await expect(bar).toHaveAttribute("aria-label", new RegExp(`^Actual: ${J.running} on `));
    const clipped = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll("[data-testid='run-bar'] span, [data-booking-id] span, [data-testid='machine-status'] span, [data-testid='machine-status'] p"))) {
        const e = el as HTMLElement;
        if (!Array.from(e.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) continue;
        const style = getComputedStyle(e);
        const wraps = !/nowrap|pre/.test(style.whiteSpace) && style.textOverflow !== "ellipsis" && (style.overflowWrap === "anywhere" || style.overflowWrap === "break-word" || style.wordBreak === "break-all");
        if (e.getClientRects().length && e.scrollWidth > e.clientWidth + 1 && !wraps) out.push(`${e.textContent?.trim().slice(0, 30)} (${e.scrollWidth} > ${e.clientWidth})`);
      }
      return out;
    });
    // Only our seeded run's bar is ours to fail on; the cards and bars of other specs' machines sharing the company are measured the same way but reported separately.
    expect(clipped.filter((text) => text.includes("Running") || text.includes(J.running)), "schedule labels cut off").toEqual([]);
    // The hours left are in the card and the table (and a block's tooltip), never repeated inside the Gantt block.
    // Not vacuous: there is at least one booking block to look at (a loop over none would pass whatever the blocks said).
    await expect(page.locator("[data-booking-id]").first()).toBeVisible();
    const blocks = await page.locator("[data-booking-id]").allTextContents();
    expect(blocks.length, "no booking block on the timeline to check").toBeGreaterThan(0);
    for (const text of blocks) expect(text, "a booking block repeats the hours left").not.toMatch(/left/i);
  });
}
