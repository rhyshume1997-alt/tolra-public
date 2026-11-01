/**
 * Settings > Email schedules (E12 invoice reminders, E13 timesheet e-mails; migration 108) and the daily cron that runs them.
 *
 * What it proves, in the company's own browser session and the database behind it:
 *   - Settings is an admin page (middleware), so office and workshop are sent to the dashboard and never see the card; an admin sees both
 *     schedules Off, with nothing saved yet (every schedule starts Off).
 *   - An admin turns Invoice reminders On, picks Every week + a weekday + a time and saves: the email_schedules row holds those values with
 *     enabled true, the preview says when it is chosen for and that it is sent at the next daily run, and a reload shows the same.
 *   - Once mode (Timesheet e-mails): a date + a time and a recipient are saved as run_at (UK time) and recipients, and the preview shows that moment.
 *   - /api/cron/daily: 401 without the secret (or with a wrong one); with it, 200 and { emailSchedules, xeroSweep }; neither schedule is due yet,
 *     so nothing is sent (the mock provider records no mail), no run is recorded and both schedules stay enabled.
 *   - Another company's admin cannot read this company's schedule rows, nor change them; office can read its own company's but not write.
 *
 * Runs in its own company (createSoloTenant) so no other spec's data changes what the cron sees as "this company". The cron route needs
 * CRON_SECRET: playwright.config.ts sets E2E_CRON_SECRET (tests/e2e/paths.ts) on the app servers. The preview's wording follows
 * EXACT_TIME_SENDING = false (Vercel Hobby, one daily pass): "Chosen time: ... Sent at the next daily run after it: ...".
 * Never read the world at import: it is read inside tests and hooks.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import type { RecordedEmail } from "../support/mock-providers";
import { adminClient, createSoloTenant, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";
import { E2E_CRON_SECRET, E2E_MOCK_PORT } from "./paths";

const w = world();

const SCHEDULE_COLUMNS = "id, organization_id, kind, enabled, frequency, weekday, time_of_day, run_at, timezone, recipients, last_run_at";

type ScheduleRow = {
  id: string; organization_id: string; kind: string; enabled: boolean; frequency: string; weekday: number | null; time_of_day: string;
  run_at: string | null; timezone: string; recipients: string[] | null; last_run_at: string | null;
};

async function rowsFor(orgId: string): Promise<ScheduleRow[]> {
  const { data, error } = await adminClient().from("email_schedules").select(SCHEDULE_COLUMNS).eq("organization_id", orgId);
  expect(error).toBeNull();
  return (data ?? []) as ScheduleRow[];
}

async function recordedMail(): Promise<RecordedEmail[]> {
  const response = await fetch(`http://127.0.0.1:${E2E_MOCK_PORT}/__emails`);
  return response.json();
}

/** Today's date in UK time plus `days`, as YYYY-MM-DD (the card's "once" date is a UK calendar date). */
function ukDatePlus(days: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Wed 4 Nov 2026": how the preview words a calendar date (day name, day, month, year; no comma). */
function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00Z`)).replace(",", "");
}

// ----- roles: Settings is an admin page ------------------------------------------------------------------------------------------
for (const role of ["office", "workshop"] as const) {
  test(`${role}: Settings is turned away to the dashboard, so the Email schedules card is never shown`, async ({ page }) => {
    await signIn(page, w.tenants.alpha.users[role]);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId("email-schedules-card")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Email schedules" })).toHaveCount(0);
  });
}

// ----- the card, the cron and the isolation, in one company of its own ---------------------------------------------------------------------
test.describe("Email schedules in their own company", () => {
  test.describe.configure({ mode: "serial" });

  let page: Page;
  let org: Awaited<ReturnType<typeof createSoloTenant>>;

  const card = () => page.getByTestId("email-schedules-card");
  const invoice = () => page.getByTestId("email-schedule-invoice_reminder");
  const timesheet = () => page.getByTestId("email-schedule-timesheet");
  // By id (components/email-schedules/settings-card.tsx): a select's label text includes its option names, so "Day" would also match "Time of day".
  const field = (kind: "invoice_reminder" | "timesheet", name: "frequency" | "weekday" | "date" | "time" | "recipients") => page.locator(`#email-schedule-${kind}-${name}`);

  test.beforeAll(async ({ browser }) => {
    org = await createSoloTenant(w.runId, `sched-${randomUUID().slice(0, 6)}`);
    page = await browser.newPage();
    await signIn(page, org.admin);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("admin sees the card with Invoice reminders and Timesheet e-mails both Off, and nothing saved", async () => {
    await page.goto("/settings");
    await expect(card()).toBeVisible();
    await expect(card().getByText("Email schedules", { exact: true })).toBeVisible();
    // The card's own words about the daily pass, and that nothing is sent until a schedule is turned on.
    await expect(card()).toContainText("Sent at the next daily run (about 05:00 UK)");
    await expect(card()).toContainText("Nothing is sent until you turn a schedule on");

    await expect(invoice().getByText("Invoice reminders", { exact: true })).toBeVisible();
    await expect(timesheet().getByText("Timesheet e-mails", { exact: true })).toBeVisible();
    await expect(invoice().getByRole("switch", { name: "Invoice reminders: off" })).toHaveAttribute("aria-checked", "false");
    await expect(timesheet().getByRole("switch", { name: "Timesheet e-mails: off" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("email-schedule-invoice_reminder-next")).toHaveText("Off: nothing will be sent.");
    await expect(page.getByTestId("email-schedule-timesheet-next")).toHaveText("Off: nothing will be sent.");
    // An admin can edit: the controls are enabled.
    await expect(invoice().getByRole("button", { name: "Save Invoice reminders" })).toBeEnabled();
    expect(await rowsFor(org.id)).toEqual([]);
  });

  test("admin turns Invoice reminders On, picks Every week + Wednesday + 10:30 and saves", async () => {
    await page.goto("/settings");
    await expect(invoice()).toBeVisible();
    await invoice().getByRole("switch", { name: "Invoice reminders: off" }).click();
    await expect(invoice().getByRole("switch", { name: "Invoice reminders: on" })).toHaveAttribute("aria-checked", "true");
    await field("invoice_reminder", "frequency").selectOption({ label: "Every week" });
    await field("invoice_reminder", "weekday").selectOption({ label: "Wednesday" });
    await field("invoice_reminder", "time").fill("10:30");
    await invoice().getByRole("button", { name: "Save Invoice reminders" }).click();
    await expect(page.getByText("Invoice reminders saved").first()).toBeVisible();

    await expect.poll(async () => (await rowsFor(org.id)).filter((r) => r.kind === "invoice_reminder").length).toBe(1);
    const row = (await rowsFor(org.id)).find((r) => r.kind === "invoice_reminder")!;
    expect(row).toMatchObject({ enabled: true, frequency: "weekly", weekday: 3, run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null });
    expect(row.time_of_day.slice(0, 5)).toBe("10:30");
    // Timesheet e-mails were not touched: no row, so still Off.
    expect((await rowsFor(org.id)).filter((r) => r.kind === "timesheet")).toEqual([]);

    // The preview: the chosen moment (a Wednesday at 10:30 UK time) and when the daily pass sends it.
    const next = page.getByTestId("email-schedule-invoice_reminder-next");
    await expect(next).toContainText(/^Chosen time: Wed \d{1,2} \w{3} \d{4} at 10:30 \((GMT|BST)\)\./);
    await expect(next).toContainText(/Sent at the next daily run after it: \w{3} \d{1,2} \w{3} \d{4} at 0[56]:00 \((GMT|BST)\)\.$/);

    // A reload shows what was saved.
    await page.reload();
    await expect(invoice().getByRole("switch", { name: "Invoice reminders: on" })).toHaveAttribute("aria-checked", "true");
    await expect(field("invoice_reminder", "frequency")).toHaveValue("weekly");
    await expect(field("invoice_reminder", "weekday")).toHaveValue("3");
    await expect(field("invoice_reminder", "time")).toHaveValue("10:30");
    await expect(page.getByTestId("email-schedule-invoice_reminder-next")).toContainText("Chosen time: Wed");
  });

  test("Once mode: Timesheet e-mails on a date and time, to one address, shows that moment", async () => {
    const date = ukDatePlus(5);
    const recipient = `payroll.${w.runId}@example.test`;
    await page.goto("/settings");
    await expect(timesheet()).toBeVisible();
    await timesheet().getByRole("switch", { name: "Timesheet e-mails: off" }).click();
    await field("timesheet", "frequency").selectOption({ label: "Once, on a date" });
    await field("timesheet", "date").fill(date);
    await field("timesheet", "time").fill("14:45");
    await field("timesheet", "recipients").fill(recipient);

    const next = page.getByTestId("email-schedule-timesheet-next");
    await expect(next).toContainText(`Chosen time: ${dayLabel(date)} at 14:45 (`);
    await timesheet().getByRole("button", { name: "Save Timesheet e-mails" }).click();
    await expect(page.getByText("Timesheet e-mails saved").first()).toBeVisible();

    await expect.poll(async () => (await rowsFor(org.id)).filter((r) => r.kind === "timesheet").length).toBe(1);
    const row = (await rowsFor(org.id)).find((r) => r.kind === "timesheet")!;
    expect(row).toMatchObject({ enabled: true, frequency: "once", weekday: null, timezone: "Europe/London", recipients: [recipient], last_run_at: null });
    expect(row.time_of_day.slice(0, 5)).toBe("14:45");
    // run_at is 14:45 UK time on that date: 13:45Z when the UK is on summer time (BST), 14:45Z in winter (GMT).
    expect(row.run_at).not.toBeNull();
    expect(["13:45", "14:45"]).toContain(new Date(row.run_at!).toISOString().slice(11, 16));
    expect(new Date(row.run_at!).toISOString().slice(0, 10)).toBe(date);

    await expect(next).toContainText(`Chosen time: ${dayLabel(date)} at 14:45 (`);
    await expect(next).toContainText("Sent at the next daily run after it:");

    // A reload shows the same moment, and Invoice reminders is still the weekly one from before.
    await page.reload();
    await expect(field("timesheet", "frequency")).toHaveValue("once");
    await expect(field("timesheet", "date")).toHaveValue(date);
    await expect(field("timesheet", "time")).toHaveValue("14:45");
    await expect(field("timesheet", "recipients")).toHaveValue(recipient);
    await expect(page.getByTestId("email-schedule-timesheet-next")).toContainText(`Chosen time: ${dayLabel(date)} at 14:45 (`);
    await expect(field("invoice_reminder", "frequency")).toHaveValue("weekly");
  });

  test("/api/cron/daily: 401 without the secret; with it 200, both results, nothing sent, schedules stay enabled", async ({ request }) => {
    // Refused: no header, a wrong secret, the right value without "Bearer".
    const attempts: Array<Record<string, string>> = [{}, { authorization: "Bearer not-the-secret-not-the-secret" }, { authorization: E2E_CRON_SECRET }];
    for (const headers of attempts) {
      const refused = await request.get("/api/cron/daily", { headers });
      expect(refused.status()).toBe(401);
      expect(await refused.json()).toEqual({ error: "Unauthorized" });
    }

    const before = await recordedMail();
    const response = await request.get("/api/cron/daily", { headers: { authorization: `Bearer ${E2E_CRON_SECRET}` } });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("emailSchedules");
    expect(body).toHaveProperty("xeroSweep");
    expect(body.emailSchedules).not.toHaveProperty("error");
    expect(body.xeroSweep).not.toHaveProperty("error");
    // Both of this company's schedules were read; none had a moment that has passed since it was saved, so nothing went out.
    expect(body.emailSchedules).not.toHaveProperty("skipped");
    expect(body.emailSchedules.schedules).toBeGreaterThanOrEqual(2);
    expect(body.emailSchedules).toMatchObject({ emails: 0, drafted: 0, failed: 0, errors: 0 });

    expect((await recordedMail()).length).toBe(before.length);
    const rows = await rowsFor(org.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.enabled).toBe(true);
      expect(row.last_run_at).toBeNull();
    }
    const { data: runs, error } = await adminClient().from("email_schedule_runs").select("schedule_id").in("schedule_id", rows.map((r) => r.id));
    expect(error).toBeNull();
    expect(runs).toEqual([]);
  });

  test("another company's admin cannot read or change this company's schedules; office reads its own company's but cannot write", async () => {
    const mine = await rowsFor(org.id);
    expect(mine).toHaveLength(2);

    // Beta's admin, signed in with the anon key like the browser: this company's rows are invisible, by company and by id.
    const beta = await signedInClient(w.tenants.beta.users.admin);
    const byCompany = await beta.from("email_schedules").select("id").eq("organization_id", org.id);
    expect(byCompany.error).toBeNull();
    expect(byCompany.data).toEqual([]);
    const byId = await beta.from("email_schedules").select("id").in("id", mine.map((r) => r.id));
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual([]);
    const all = await beta.from("email_schedules").select("organization_id");
    expect(all.error).toBeNull();
    expect((all.data ?? []).every((r) => r.organization_id === w.tenants.beta.id)).toBe(true);

    // ... and cannot change or delete them, nor write a row into this company.
    const update = await beta.from("email_schedules").update({ enabled: false }).eq("organization_id", org.id).select("id");
    expect(update.data ?? []).toEqual([]);
    const remove = await beta.from("email_schedules").delete().eq("organization_id", org.id).select("id");
    expect(remove.data ?? []).toEqual([]);
    const insert = await beta.from("email_schedules").upsert({ organization_id: org.id, kind: "invoice_reminder", enabled: false, frequency: "daily", time_of_day: "08:00" }, { onConflict: "organization_id,kind" });
    expect(insert.error).not.toBeNull();
    expect(await rowsFor(org.id)).toEqual(mine);

    // Alpha's office: may read alpha's schedules (the policy lets the company read), may not write them. Reading this company's: nothing.
    const office = await signedInClient(w.tenants.alpha.users.office);
    const readOther = await office.from("email_schedules").select("id").eq("organization_id", org.id);
    expect(readOther.error).toBeNull();
    expect(readOther.data).toEqual([]);
    const readOwn = await office.from("email_schedules").select("id").eq("organization_id", w.tenants.alpha.id);
    expect(readOwn.error).toBeNull();
    const officeWrite = await office.from("email_schedules").upsert({ organization_id: w.tenants.alpha.id, kind: "invoice_reminder", enabled: true, frequency: "daily", time_of_day: "08:00" }, { onConflict: "organization_id,kind" });
    expect(officeWrite.error).not.toBeNull();
    expect(await rowsFor(w.tenants.alpha.id)).toEqual([]);
  });
});
