/**
 * Weekly hours > "Payroll export" (E4d): everyone's paid hours for 1 to 5 whole weeks in one CSV, one row per person per week.
 *
 * Seeds clock time (synthetic alpha people, two winter weeks so UK time = UTC, away from the weeks other hours specs use):
 *   Workshop: Mon 5 Jan 2026 08:00 to 16:30, and Wed 14 Jan 2026 08:00 to 12:00   (weeks of 2026-01-05 and 2026-01-12)
 *   Office:   Tue 6 Jan 2026 09:00 to 17:00                                         (week of 2026-01-05)
 * The break allowance is whatever the company's time settings say, so no figure is hard-coded: the file's Paid (h:mm) must equal the
 * figure the review shows on screen for the same person and week. The workshop login does not see the button.
 */
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const WEEK1 = "2026-01-05";
const WEEK2 = "2026-01-12";
const workshop = () => w.tenants.alpha.users.workshop;
const office = () => w.tenants.alpha.users.office;

// The documented columns of the payroll file (lib/time-payroll-export.ts PAYROLL_COLUMNS), in order.
const HEADER = [
  "Person", "Week Starting", "Week Ending", "Days Worked", "Clocked (hours)", "Breaks Deducted (hours)", "Paid (hours)", "Paid (h:mm)",
  "Overtime Days", "Overtime Paid (hours)", "Saturday Days", "Saturday Paid (hours)", "Sunday Days", "Sunday Paid (hours)", "Bank holiday Days", "Bank holiday Paid (hours)",
  "Unsaved Suggested Tick Days", "Approval", "Approved By", "Approved On", "Checks",
];

test.beforeAll(async () => {
  await withDb(async (db) => {
    const org = w.tenants.alpha.id;
    const shift = (user: string, inAt: string, outAt: string) => db.query(
      `insert into public.attendance_events (organization_id, user_id, client_op_id, action, at, source, recorded_by)
       values ($1, $2, gen_random_uuid(), 'in', $3, 'clock', $2), ($1, $2, gen_random_uuid(), 'out', $4, 'clock', $2)`, [org, user, inAt, outAt]);
    await shift(workshop().id, "2026-01-05T08:00:00Z", "2026-01-05T16:30:00Z");
    await shift(workshop().id, "2026-01-14T08:00:00Z", "2026-01-14T12:00:00Z");
    await shift(office().id, "2026-01-06T09:00:00Z", "2026-01-06T17:00:00Z");
  });
});

/** The Paid figure the review shows for a person in a week ("7:45"). */
async function paidOnScreen(page: Page, week: string, userId: string) {
  await page.goto(`/time/week?week=${week}`);
  const row = page.getByTestId(`week-row-${userId}`);
  await expect(row).toBeVisible();
  const paid = (await row.getByTestId("week-paid").innerText()).trim();
  expect(paid).toMatch(/^\d+:\d{2}$/);
  return paid;
}

const hoursOf = (hm: string) => { const [h, m] = hm.split(":").map(Number); return Math.round((h + m / 60) * 100) / 100; };

test("Payroll export: 2 weeks as CSV downloads one row per person per week, Paid matches the screen", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, office());

  // What the review shows on screen.
  const screen = {
    officeWeek1: await paidOnScreen(page, WEEK1, office().id),
    workshopWeek1: await paidOnScreen(page, WEEK1, workshop().id),
    workshopWeek2: await paidOnScreen(page, WEEK2, workshop().id),
  };

  // Open the dialog from the first week and ask for two weeks.
  await page.goto(`/time/week?week=${WEEK1}`);
  await expect(page.getByTestId(`week-row-${workshop().id}`)).toBeVisible();
  await page.getByTestId("payroll-export-open").click();
  const dialog = page.getByTestId("payroll-export-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Payroll export" })).toBeVisible();
  await expect(dialog.getByTestId("payroll-from")).toHaveValue(WEEK1);
  await expect(dialog.getByTestId("payroll-range")).toHaveText("2026-01-05 to 2026-01-11 (1 week)");
  await dialog.getByTestId("payroll-weeks").fill("2");
  await expect(dialog.getByTestId("payroll-range")).toHaveText("2026-01-05 to 2026-01-18 (2 weeks)");

  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("payroll-csv").click()]);
  expect(download.suggestedFilename()).toMatch(new RegExp(`^${w.tenants.alpha.name} Payroll Hours 2026-01-05 to 2026-01-18-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  await expect(dialog).toBeHidden();

  const text = readFileSync(await download.path(), "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).split("\r\n");
  expect(lines.at(-1)).toBe("");
  const header = lines[0].split(",");
  expect(header).toEqual(HEADER);
  const rows = lines.slice(1, -1).map((line) => Object.fromEntries(line.split(",").map((value, i) => [header[i], value])) as Record<string, string>);
  const rowOf = (person: string, weekStart: string) => rows.filter((r) => r.Person === person && r["Week Starting"] === weekStart);

  // One row per person per week, for the two people who have time; every row covers its whole Monday to Sunday week.
  for (const [person, weekStart, weekEnd, paid] of [
    ["Office alpha", WEEK1, "2026-01-11", screen.officeWeek1],
    ["Workshop alpha", WEEK1, "2026-01-11", screen.workshopWeek1],
    ["Workshop alpha", WEEK2, "2026-01-18", screen.workshopWeek2],
  ] as const) {
    const found = rowOf(person, weekStart);
    expect(found, `${person} ${weekStart}`).toHaveLength(1);
    expect(found[0]).toMatchObject({ "Week Ending": weekEnd, "Paid (h:mm)": paid, "Paid (hours)": String(hoursOf(paid)), Approval: "Not approved" });
  }
  expect(rowOf("Office alpha", WEEK2)).toHaveLength(0);
  // Hours only: nothing in the file is a rate or pay.
  expect(header.some((h) => /rate|pay\b|£/i.test(h))).toBe(false);
});

test("Payroll export: the workshop login does not see the button", async ({ page }) => {
  await signIn(page, workshop());
  await page.goto(`/time/week?week=${WEEK1}`);
  await expect(page.getByTestId(`week-row-${workshop().id}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toBeVisible();
  await expect(page.getByTestId("payroll-export-open")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Payroll export" })).toHaveCount(0);
});
