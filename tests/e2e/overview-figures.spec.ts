/**
 * The owner's Overview figures in a fresh company, so each count is exact: the Today figure (everything on Needs attention, and the
 * late or overdue among it), this month's money received against last month, and all machines' load this week. The rules themselves:
 * tests/unit/overview.test.ts.
 */
import { expect, test } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

// The app's Revenue months follow the browser's own month, so the browser runs on London time like the dates below.
test.use({ timezoneId: "Europe/London" });

const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
// Noon UTC on a London date, so "N days" is the same at any hour (see attention.spec.ts).
const stamp = (offsetDays: number) => new Date(Date.parse(`${london(0)}T12:00:00Z`) + offsetDays * 86_400_000).toISOString();

test("the Overview's figures count the seeded rows exactly", async ({ page }) => {
  const solo = await createSoloTenant(w.runId, "overview-figures");
  const org = solo.id;
  const db = adminClient();
  const ok = async (p: PromiseLike<{ error: { message: string } | null }>) => expect((await p).error).toBeNull();

  // Needs attention: one late job and one waiting for inspection, so 2 things, 1 of them late.
  await ok(db.from("jobs").insert({ organization_id: org, job_no: "J-LATE", customer: "Acme", date_required: london(-2) }));
  await ok(db.from("jobs").insert({ organization_id: org, job_no: "J-INSPECT", customer: "Acme", finished_at: stamp(-3), stage: "inspection" }));

  // One machine set to 8 h x 5 days (40 h) with 10 h booked on Monday of this week: 25% booked, 30 h free.
  const { data: machine } = await db.from("machines").insert({ organization_id: org, name: "Figures Mill", hours_per_day: 8, working_days: [1, 2, 3, 4, 5] }).select("id").single();
  const { data: job } = await db.from("jobs").insert({ organization_id: org, job_no: "J-BOOKED", customer: "Acme", description: "Booked" }).select("id").single();
  const monday = new Date();
  monday.setHours(9, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  await ok(db.from("machine_bookings").insert({ organization_id: org, machine_id: machine!.id, job_id: job!.id, job_no: "J-BOOKED", description: "Booked", start_at: monday.toISOString(), estimated_hours: 10 }));

  // £1,000 received last month and £1,500 so far this month: 50% above last month.
  const [year, month] = london(0).split("-").map(Number);
  const lastMonth = new Date(Date.UTC(year, month - 2, 15, 12));
  const lastMonthKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).format(lastMonth);
  const lastMonthLabel = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "Europe/London" }).format(lastMonth);
  const { data: invoice } = await db.from("invoices").insert({ organization_id: org, invoice_ref: "INV-FIGURES", customer: "Acme", status: "sent", total: 2500, subtotal: 2500, vat: 0, vat_enabled: false, invoice_date: `${lastMonthKey}-10` }).select("id").single();
  await ok(db.from("invoice_payments").insert({ organization_id: org, invoice_id: invoice!.id, amount: 1000, paid_on: `${lastMonthKey}-10` }));
  await ok(db.from("invoice_payments").insert({ organization_id: org, invoice_id: invoice!.id, amount: 1500, paid_on: london(0) }));

  await signIn(page, solo.admin);
  await expect(page.getByTestId("overview-today-figure")).toHaveText("2 things need you, 1 of them late or overdue");
  await expect(page.getByTestId("overview-money").getByText(`So far 50% above ${lastMonthLabel} (£1,000)`)).toBeVisible();
  await expect(page.getByTestId("machine-load-overall")).toHaveText("25% of available hours booked · 30h free");

  // On a phone the Today figure has a line of its own under the heading, loading or loaded, so it never jumps when the count arrives.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const title = (await page.locator("#today-title").boundingBox())!;
    const figure = (await page.getByTestId("overview-today-figure").boundingBox())!;
    return figure.y >= title.y + title.height - 1;
  }, { message: "390: the Today figure sits on its own line under the heading" }).toBe(true);
});
