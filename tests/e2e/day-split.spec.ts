/**
 * Split a machine booking by day (the booking day-plan migration), in the browser, against the local disposable backend only.
 *
 * - "Split by day" on the booking form: rows of a date, a start and an end time, a running total against the estimated hours, Save
 *   blocked with the reason until they match to the minute; a Saturday 08:00-14:00 + Sunday 08:00-10:00 booking is saved and drawn on
 *   both days with those times, and survives a reload.
 * - Each row shows its total split into basic and out-of-hours time against the company's working hours (08:00-16:00 Mon-Fri by
 *   default): 05:00-22:00 on a Monday is 17h, basic 8h, out of hours 9h; a Saturday row says it isn't a normal working day. The
 *   timeline shows the real times and marks time outside the machine's hours. Mark running stays available while an edit doesn't add up.
 * - An admin changes each day's working hours (a shorter Friday) and which days are worked in Settings > Company details, sees paid time
 *   per day and for the week, and the rows follow.
 * - Clearing the split on the saved booking returns it to the default rule (one 8h Saturday bar) and stores no plan.
 * - Touch targets on the split controls are at least 44 px.
 *
 * Synthetic data only (alpha tenant of the synthetic world). The world is read inside the tests, never at import.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const pad = (n: number) => String(n).padStart(2, "0");
const dateString = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** The Saturday and Sunday of next week: inside the timeline's default two weeks, whatever day the suite runs on. */
function nextWeekend() {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sat = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 12);
  const sun = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 13);
  return { sat, sun, satStr: dateString(sat), sunStr: dateString(sun) };
}

/** "Sun, 25 Oct" or "Sun 25 Oct": the browser and Node format en-GB dates with and without the comma. */
const dayText = (d: Date) => new RegExp(`${d.toLocaleDateString("en-GB", { weekday: "short" })},? ${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })}`);

let machineName = "";
const tag = () => world().runId.slice(0, 6);
const jobNo = (suffix: string) => `DS-${tag()}-${suffix}`;

test.beforeAll(async () => {
  machineName = `Split Mill ${tag()}`;
  const { error } = await adminClient().from("machines").insert({ organization_id: world().tenants.alpha.id, name: machineName });
  expect(error).toBeNull();
});

async function openBookingForm(page: Page, job: string, hours: string) {
  await page.goto("/schedule");
  await page.getByRole("button", { name: "New booking" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Machine").selectOption({ label: machineName });
  await dialog.getByPlaceholder("Job number").fill(job);
  await dialog.getByLabel(/Estimated hours/).fill(hours);
  return dialog;
}

async function fillDay(dialog: Locator, n: number, date: string, start: string, end: string) {
  await dialog.getByLabel(`Day ${n} date`).fill(date);
  await dialog.getByLabel(`Day ${n} start`).fill(start);
  await dialog.getByLabel(`Day ${n} end`).fill(end);
}

async function expectTouchTarget(locator: Locator, what: string) {
  const box = await locator.boundingBox();
  expect(box, what).not.toBeNull();
  expect(box!.height, `${what} is at least 44px high`).toBeGreaterThanOrEqual(44);
}

test("a total that doesn't match the estimated hours blocks Save and says by how much", async ({ page }) => {
  const { satStr, sunStr } = nextWeekend();
  const job = jobNo("MISMATCH");
  await signIn(page, world().tenants.alpha.users.admin);
  const dialog = await openBookingForm(page, job, "8");
  await dialog.getByRole("checkbox", { name: /Split by day/ }).check();
  await fillDay(dialog, 1, satStr, "08:00", "14:00");
  await dialog.getByRole("button", { name: "Add day" }).click();
  await fillDay(dialog, 2, sunStr, "08:00", "09:00");

  await expect(dialog.getByTestId("day-plan-total")).toHaveText("Total 7h of 8h");
  await expect(dialog.getByTestId("day-plan-message")).toContainText("The days add up to 7h but the job is 8h (1h short). Make them match to save.");
  await expect(dialog.getByRole("button", { name: "Book job" })).toBeDisabled();
  expect((await adminClient().from("machine_bookings").select("id").eq("job_no", job)).data).toEqual([]);

  // Too many hours is blocked the same way; the right total unblocks it.
  await dialog.getByLabel("Day 2 end").fill("11:00");
  await expect(dialog.getByTestId("day-plan-message")).toContainText("(1h over)");
  await expect(dialog.getByRole("button", { name: "Book job" })).toBeDisabled();
  await dialog.getByLabel("Day 2 end").fill("09:59");
  await expect(dialog.getByTestId("day-plan-message")).toContainText("(1m short)");
  await dialog.getByLabel("Day 2 end").fill("10:00");
  await expect(dialog.getByTestId("day-plan-total")).toHaveText("Total 8h of 8h");
  await expect(dialog.getByTestId("day-plan-message")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Book job" })).toBeEnabled();

  // Changing the estimated hours afterwards blocks it again until the days follow.
  await dialog.getByLabel(/Estimated hours/).fill("10");
  await expect(dialog.getByRole("button", { name: "Book job" })).toBeDisabled();
  expect((await adminClient().from("machine_bookings").select("id").eq("job_no", job)).data).toEqual([]);
});

test("the split controls are at least 44px high", async ({ page }) => {
  const { satStr } = nextWeekend();
  await signIn(page, world().tenants.alpha.users.admin);
  const dialog = await openBookingForm(page, jobNo("TOUCH"), "8");
  await expectTouchTarget(dialog.locator("label", { hasText: "Split by day" }), "the Split by day switch");
  await dialog.getByRole("checkbox", { name: /Split by day/ }).check();
  await fillDay(dialog, 1, satStr, "08:00", "14:00");
  await expect(dialog.getByLabel("Day 1 start")).toHaveAttribute("type", "time");
  await expect(dialog.getByLabel("Day 1 end")).toHaveAttribute("type", "time");
  await expectTouchTarget(dialog.getByLabel("Day 1 date"), "the date field");
  await expectTouchTarget(dialog.getByLabel("Day 1 start"), "the start field");
  await expectTouchTarget(dialog.getByLabel("Day 1 end"), "the end field");
  await expectTouchTarget(dialog.getByRole("button", { name: "Remove day 1" }), "the remove button");
  const remove = await dialog.getByRole("button", { name: "Remove day 1" }).boundingBox();
  expect(remove!.width).toBeGreaterThanOrEqual(44);
  await expectTouchTarget(dialog.getByRole("button", { name: "Add day" }), "Add day");
  await expectTouchTarget(dialog.getByRole("button", { name: /Book (job|anyway)/ }), "the Book job button");
});

test("Saturday 08:00-14:00 and Sunday 08:00-10:00 is saved, drawn on both days with those hours, and clearing the split returns to the default rule", async ({ page }) => {
  const { sat, sun, satStr, sunStr } = nextWeekend();
  const job = jobNo("SPLIT");
  const admin = adminClient();
  await signIn(page, world().tenants.alpha.users.admin);
  const dialog = await openBookingForm(page, job, "8");
  await dialog.getByRole("checkbox", { name: /Split by day/ }).check();
  await fillDay(dialog, 1, satStr, "08:00", "14:00");
  // A Saturday isn't one of the company's working days (08:00-16:00, Monday to Friday by default): the row says so.
  await expect(dialog.getByTestId("day-plan-row").nth(0).getByTestId("day-plan-row-summary")).toHaveText("6h: basic 0h, out of hours 6h");
  await expect(dialog.getByTestId("day-plan-row").nth(0).getByTestId("day-plan-row-note")).toHaveText("Not a normal working day: all of it is out of hours.");
  await dialog.getByRole("button", { name: "Add day" }).click();
  // The new day is the day after, from the working-hours start, carrying the hours still to place.
  await expect(dialog.getByLabel("Day 2 date")).toHaveValue(sunStr);
  await expect(dialog.getByLabel("Day 2 start")).toHaveValue("08:00");
  await expect(dialog.getByLabel("Day 2 end")).toHaveValue("10:00");
  await expect(dialog.getByTestId("day-plan-total")).toHaveText("Total 8h of 8h");
  await expect(dialog.getByText(/Estimated finish:/)).toContainText("10:00");
  await dialog.getByRole("button", { name: "Book job" }).click();
  await expect(page.getByText("Job booked onto machine")).toBeVisible();

  // Stored as a plan, starting at the first day's start.
  const stored = (await admin.from("machine_bookings").select("day_plan, start_at, estimated_hours").eq("job_no", job).single()).data!;
  expect(stored.day_plan).toEqual([{ date: satStr, start: "08:00", end: "14:00" }, { date: sunStr, start: "08:00", end: "10:00" }]);
  expect(Number(stored.estimated_hours)).toBe(8);
  expect(new Date(stored.start_at).getTime()).toBe(new Date(sat.getFullYear(), sat.getMonth(), sat.getDate(), 8, 0).getTime());

  // Drawn on both days, with each day's hours.
  const bars = page.locator(`button[title^="${job} on "]`);
  await expect(bars).toHaveCount(2);
  await expect(page.locator(`button[title^="${job} on "][data-plan-date="${satStr}"]`)).toHaveAttribute("data-plan-hours", "6");
  await expect(page.locator(`button[title^="${job} on "][data-plan-date="${satStr}"]`)).toContainText("08:00-14:00");
  await expect(page.locator(`button[title^="${job} on "][data-plan-date="${sunStr}"]`)).toHaveAttribute("data-plan-hours", "2");
  await expect(page.locator(`button[title^="${job} on "][data-plan-date="${sunStr}"]`)).toContainText("08:00-10:00");
  // The Saturday bar (6 of the 8 machine hours) is wider than the Sunday bar (2 of 8).
  const satBox = await page.locator(`button[data-plan-date="${satStr}"][title^="${job} on "]`).boundingBox();
  const sunBox = await page.locator(`button[data-plan-date="${sunStr}"][title^="${job} on "]`).boundingBox();
  expect(satBox!.width).toBeGreaterThan(sunBox!.width * 2);
  // The list says when it finishes: Sunday 10:00.
  const row = page.getByRole("row").filter({ hasText: job });
  await expect(row).toContainText(dayText(sun));
  await expect(row).toContainText("10:00");

  // Still there after a reload.
  await page.reload();
  await expect(page.locator(`button[title^="${job} on "]`)).toHaveCount(2);

  // Open it: the split is shown and editable; switching it off and saving returns to the default rule.
  await page.locator(`button[title^="${job} on "]`).first().click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByTestId("booking-day-plan")).toContainText("08:00-14:00 (6h)");
  await expect(detail.getByTestId("booking-day-plan")).toContainText("08:00-10:00 (2h)");
  await expect(detail.getByRole("checkbox", { name: /Split by day/ })).toBeChecked();
  await detail.getByRole("checkbox", { name: /Split by day/ }).uncheck();
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Booking updated")).toBeVisible();

  expect((await admin.from("machine_bookings").select("day_plan, start_at").eq("job_no", job).single()).data!.day_plan).toBeNull();
  // Default rule: 8h starting on a Saturday is one Saturday bar of 08:00 to 16:00; Sunday is not worked.
  await expect(page.locator(`button[title^="${job} on "]`)).toHaveCount(1);
  await expect(page.locator(`button[title^="${job} on "][data-plan-date]`)).toHaveCount(0);
  const after = page.getByRole("row").filter({ hasText: job });
  await expect(after).toContainText("16:00");
  await expect(after).not.toContainText(dayText(sun));
  await page.reload();
  await expect(page.locator(`button[title^="${job} on "]`)).toHaveCount(1);
});

/** Monday of next week: a working day inside the timeline's default two weeks. */
function nextMonday() {
  const { sat } = nextWeekend();
  const mon = new Date(sat.getFullYear(), sat.getMonth(), sat.getDate() - 5);
  return { mon, monStr: dateString(mon) };
}

test("05:00 to 22:00 on a Monday is 17h: basic 8h and out of hours 9h, drawn with its real times; Mark running works while an edit doesn't add up", async ({ page }) => {
  const { monStr } = nextMonday();
  const job = jobNo("LONG");
  const admin = adminClient();
  await signIn(page, world().tenants.alpha.users.admin);
  const dialog = await openBookingForm(page, job, "17");
  await dialog.getByRole("checkbox", { name: /Split by day/ }).check();
  await fillDay(dialog, 1, monStr, "05:00", "22:00");
  const row = dialog.getByTestId("day-plan-row").nth(0);
  await expect(row.getByTestId("day-plan-row-summary")).toHaveText("17h: basic 8h, out of hours 9h");
  await expect(row.getByTestId("day-plan-row-note")).toHaveText("Out of hours: 9h outside 08:00-16:00.");
  await expect(dialog.getByTestId("day-plan-total")).toHaveText("Total 17h of 17h");
  await dialog.getByRole("button", { name: /Book (job|anyway)/ }).click();
  await expect(page.getByText("Job booked onto machine")).toBeVisible();
  expect((await admin.from("machine_bookings").select("day_plan").eq("job_no", job).single()).data!.day_plan).toEqual([{ date: monStr, start: "05:00", end: "22:00" }]);

  // The timeline shows the real times, clamped into the machine's 08:00-16:00 cell and marked out of hours.
  const bar = page.locator(`button[title^="${job} on "][data-plan-date="${monStr}"]`);
  await expect(bar).toContainText("05:00-22:00");
  await expect(bar).toContainText("out of hours");
  await expect(bar).toHaveAttribute("data-out-of-hours", "true");
  await expect(bar).toHaveAttribute("title", /05:00-22:00 \(17h\)/);

  // An edit that doesn't add up blocks Save, but Mark running still works and keeps the stored plan.
  await bar.click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByTestId("booking-day-plan")).toContainText("05:00-22:00 (17h)");
  await detail.getByLabel("Day 1 end").fill("21:00");
  await expect(detail.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "Mark running" })).toBeEnabled();
  await detail.getByRole("button", { name: "Mark running" }).click();
  await expect(page.getByText("Booking updated")).toBeVisible();
  const after = (await admin.from("machine_bookings").select("status, day_plan, estimated_hours").eq("job_no", job).single()).data!;
  expect(after.status).toBe("running");
  expect(after.day_plan).toEqual([{ date: monStr, start: "05:00", end: "22:00" }]);
  expect(Number(after.estimated_hours)).toBe(17);
});

test("an admin changes the working hours and days in Settings, and the split rows follow", async ({ page }) => {
  const { satStr } = nextWeekend();
  const admin = adminClient();
  const org = world().tenants.alpha.id;
  const before = (await admin.from("organization_settings").select("company_profile").eq("organization_id", org).single()).data!.company_profile;
  try {
    await signIn(page, world().tenants.alpha.users.admin);
    await page.goto("/settings");
    const hours = page.getByTestId("working-hours");
    const card = page.getByTestId("company-details-form");
    // Wait for the loaded state first: the pre-load defaults are the same 08:00-16:00, so these two checks mean nothing before it.
    await expect(card).toHaveAttribute("data-loaded", "true");
    await expect(hours.getByLabel("Mon start")).toHaveValue("08:00");
    await expect(hours.getByLabel("Mon finish")).toHaveValue("16:00");
    await expect(hours.getByLabel("Fri finish")).toHaveValue("16:00");
    await expect(hours.getByTestId("working-hours-week-paid")).toHaveText("36:15"); // 5 x 7:15

    // The race: reload with the company profile held back, and edit the moment the page is up.
    // The card must stay locked until the profile is in the form, then keep every edit made after that.
    let holdProfile = true;
    await page.route("**/rest/v1/organization_settings*", async (route) => {
      if (holdProfile && route.request().method() === "GET") await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue().catch(() => {}); // a request still held when the test ends is already gone
    });
    await page.reload();
    await expect(card).toHaveAttribute("data-loaded", "false");
    await expect(hours.getByLabel("Mon start")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save company details" })).toBeDisabled();
    await hours.getByLabel("Mon start").fill("07:00"); // waits for the inputs to be enabled, i.e. for the profile to be loaded
    await expect(card).toHaveAttribute("data-loaded", "true");
    holdProfile = false;
    await hours.getByRole("checkbox", { name: "Sat" }).check();
    // Monday to Saturday work 07:00-15:30, except a shorter Friday that finishes at 14:30.
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      if (day !== "Mon") await hours.getByLabel(`${day} start`).fill("07:00");
      await hours.getByLabel(`${day} finish`).fill(day === "Fri" ? "14:30" : "15:30");
    }
    await expect(hours.getByLabel("Mon start")).toHaveValue("07:00");
    await expect(hours.getByLabel("Fri finish")).toHaveValue("14:30");
    await expect(hours.getByLabel("Sun start")).toBeDisabled();
    // Paid time shows beside each worked day and for the week: 5 x 7:45 + 6:45 = 45:30 paid (50:00 at work, 4:30 breaks).
    await expect(hours.getByTestId("working-hours-day-paid").nth(0)).toHaveText("Paid 7:45");
    await expect(hours.getByTestId("working-hours-day-paid").nth(4)).toHaveText("Paid 6:45");
    await expect(hours.getByTestId("working-hours-week-at-work")).toHaveText("50:00");
    await expect(hours.getByTestId("working-hours-week-breaks")).toHaveText("4:30");
    await expect(hours.getByTestId("working-hours-week-paid")).toHaveText("45:30");
    await expectTouchTarget(hours.getByLabel("Mon start"), "the Monday start");
    await expectTouchTarget(hours.locator("label", { hasText: "Sat" }), "the Saturday tick box");
    await page.getByRole("button", { name: "Save company details" }).click();
    await expect(page.getByText("Company details saved")).toBeVisible();
    const saved = (await admin.from("organization_settings").select("company_profile").eq("organization_id", org).single()).data!.company_profile;
    expect({ workStart: saved.workStart, workEnd: saved.workEnd, workDays: saved.workDays }).toEqual({ workStart: "07:00", workEnd: "15:30", workDays: [1, 2, 3, 4, 5, 6] });
    expect(saved.workHoursByDay["5"]).toEqual({ start: "07:00", end: "14:30" });
    expect(saved.workHoursByDay["6"]).toEqual({ start: "07:00", end: "15:30" });
    expect(saved.workHoursByDay["7"]).toBeUndefined();

    // Saturday is now a working day with 07:00-15:30 as its basic time.
    const dialog = await openBookingForm(page, jobNo("HOURS"), "17");
    await dialog.getByRole("checkbox", { name: /Split by day/ }).check();
    await fillDay(dialog, 1, satStr, "05:00", "22:00");
    const row = dialog.getByTestId("day-plan-row").nth(0);
    await expect(row.getByTestId("day-plan-row-summary")).toHaveText("17h: basic 8h 30m, out of hours 8h 30m");
    await expect(row.getByTestId("day-plan-row-note")).toHaveText("Out of hours: 8h 30m outside 07:00-15:30.");
    await expect(dialog.getByTestId("day-plan")).toContainText("Mon–Thu 07:00–15:30, Fri 07:00–14:30, Sat 07:00–15:30");
    // Adding a day starts it at the new working-hours start.
    await dialog.getByRole("button", { name: "Add day" }).click();
    await expect(dialog.getByLabel("Day 2 start")).toHaveValue("07:00");
  } finally {
    await admin.from("organization_settings").update({ company_profile: before }).eq("organization_id", org);
  }
});
