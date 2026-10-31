/**
 * The Numbers page, admin only: its three questions answered from seeded rows in a company of its own, a second company beside it
 * proving the numbers never mix, a failed read shown as a dash and never 0, no sideways scroll on a phone, a tablet and a desktop, and
 * every other role turned away. The rules themselves (London months, credit notes once, shares): tests/unit/numbers.test.ts.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

// The page's months follow the UK calendar whatever the browser's zone, but pin it like the other figures specs.
test.use({ timezoneId: "Europe/London" });

const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
/** "YYYY-MM" of the London month before this one, and its label as the page shows it ("Oct 26"). */
function lastMonth() {
  const [year, month] = london(0).split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 2, 1));
  return { key: first.toISOString().slice(0, 7), label: new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(first) };
}
function thisMonth() {
  const [year, month] = london(0).split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

type Seed = { org: string; invoices: Array<[customer: string, net: number, status?: string]>; credit?: [customer: string, net: number]; payments: number[]; machines: Array<[name: string, hours: number]> };

/** Rows in the company, dated last month (and a credit note today), so every month of the page's default six is known. */
async function seed({ org, invoices, credit, payments, machines }: Seed) {
  const db = adminClient();
  const ok = async (p: PromiseLike<{ error: { message: string } | null }>) => expect((await p).error).toBeNull();
  const last = lastMonth();
  let firstInvoice: string | null = null;
  for (const [i, [customer, net, status]] of invoices.entries()) {
    // An issued (or voided) invoice carries its number; a draft has none yet.
    const invoice_ref = status === "draft" ? null : `INV-NUM-${org.slice(0, 6)}-${i}`;
    const { data, error } = await db.from("invoices").insert({ organization_id: org, invoice_ref, customer, status: status ?? "sent", invoice_date: `${last.key}-10`, subtotal: net, vat: net * 0.2, total: net * 1.2, vat_enabled: true, description: `Numbers ${i}` }).select("id").single();
    expect(error).toBeNull();
    firstInvoice ??= data!.id;
  }
  if (credit) {
    const [customer, net] = credit;
    await ok(db.from("credit_notes").insert({ organization_id: org, invoice_id: firstInvoice, customer, status: "issued", credit_ref: `CN-NUM-${org.slice(0, 6)}`, credit_date: london(0), subtotal: net, vat: net * 0.2, total: net * 1.2, vat_enabled: true, allocated_amount: 0, issued_at: new Date().toISOString() }));
  }
  for (const [i, amount] of payments.entries()) {
    await ok(db.from("invoice_payments").insert({ organization_id: org, invoice_id: firstInvoice, amount, paid_on: i === 0 ? `${last.key}-10` : london(0) }));
  }
  const { data: job } = await db.from("jobs").insert({ organization_id: org, job_no: `J-NUM-${org.slice(0, 4)}`, customer: "Numbers Co", description: "Numbers" }).select("id").single();
  for (const [name, hours] of machines) {
    const { data: machine } = await db.from("machines").insert({ organization_id: org, name }).select("id").single();
    const started = `${last.key}-10T09:00:00Z`;
    const ended = new Date(Date.parse(started) + hours * 3_600_000).toISOString();
    await ok(db.from("machine_runs").insert({ organization_id: org, job_id: job!.id, machine_id: machine!.id, started_at: started, ended_at: ended, end_reason: "paused" }));
  }
}

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("Numbers answers its three questions from the company's own rows, and a second company's rows never mix in", async ({ page, browser }) => {
  const a = await createSoloTenant(w.runId, "numbers-a");
  const b = await createSoloTenant(w.runId, "numbers-b");
  const last = lastMonth();
  // Company A: invoiced 600 + 400 ex VAT last month (a draft and a void one are not sales), 100 credited today; 300 received last month and 200 today; 2 h and 1.5 h of machine time.
  await seed({
    org: a.id,
    invoices: [["Acme", 600], ["Beta", 400], ["Draft Co", 5000, "draft"], ["Void Co", 5000, "void"]],
    credit: ["Acme", 100],
    payments: [300, 200],
    machines: [["Numbers Mill", 2], ["Numbers Lathe", 1.5]],
  });
  // Company B: one customer, one big month, and a machine of its own.
  await seed({ org: b.id, invoices: [["Zeta Ltd", 7000]], payments: [7000], machines: [["Zeta Mill", 5]] });

  await signIn(page, a.admin);
  await page.goto("/numbers");
  await expect(page.getByTestId("numbers-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Numbers", level: 1 })).toBeVisible();

  // The tiles: 1,000 invoiced last month less the 100 credit note on its own date today; 500 received.
  await expect(page.getByTestId("numbers-invoiced")).toHaveText("£900");
  await expect(page.getByTestId("numbers-received")).toHaveText("£500");

  // 1. Customers: Acme 500 of 900 (the credit comes off Acme), Beta 400; the draft and void invoices are not sales.
  const customers = page.getByTestId("numbers-customers");
  await expect(customers.getByText("Acme · 56%")).toBeVisible();
  await expect(customers.getByText("Beta · 44%")).toBeVisible();
  await expect(customers.getByText("£500")).toBeVisible();
  await expect(customers).not.toContainText("Draft Co");
  await expect(customers).not.toContainText("Void Co");

  // 2. Cash by month: last month 1,000 invoiced, 300 received; this month the 100 credit note and 200 received. One chart, one money axis.
  const cash = page.getByTestId("numbers-cash");
  const lastRow = cash.getByTestId(`numbers-cash-${last.key}`);
  await expect(lastRow).toContainText(last.label);
  await expect(lastRow.locator("[data-col=invoiced]")).toHaveText("£1,000");
  await expect(lastRow.locator("[data-col=received]")).toHaveText("£300");
  await expect(lastRow.locator("[data-col=gap]")).toHaveText("£700");
  const thisRow = cash.locator("tr", { hasText: thisMonth() });
  await expect(thisRow.locator("[data-col=invoiced]")).toHaveText("-£100");
  await expect(thisRow.locator("[data-col=received]")).toHaveText("£200");
  await expect(thisRow.locator("[data-col=gap]")).toHaveText("-£300");
  await expect(cash.getByText("not money owed", { exact: false })).toBeVisible();
  await expect(page.getByTestId("numbers-cash-chart").locator(".recharts-yAxis")).toHaveCount(1);

  // 3. Machine time: recorded runs per machine.
  const machines = page.getByTestId("numbers-machines");
  await expect(machines.locator("li", { hasText: "Numbers Mill" })).toContainText("2 h");
  await expect(machines.locator("li", { hasText: "Numbers Lathe" })).toContainText("1.5 h");

  // None of company B is anywhere on A's page.
  const body = page.getByTestId("numbers-page");
  for (const other of ["Zeta", "£7,000", "£7,900"]) await expect(body, other).not.toContainText(other);

  // The period can be changed; the figures stay (all of it is inside three months).
  await page.getByLabel("Months to show").selectOption("3");
  await expect(page.getByTestId("numbers-span")).toContainText("Last 3 months");
  await expect(page.getByTestId("numbers-invoiced")).toHaveText("£900");

  // No sideways scroll on a phone, a tablet and a desktop.
  for (const [width, height] of [[390, 844], [768, 1024], [1280, 800]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/numbers");
    await expect(page.getByTestId("numbers-invoiced")).toHaveText("£900");
    expect(await noSidewaysScroll(page), `${width}px`).toBe(true);
  }

  // Company B signs in separately and sees only its own.
  const second = await browser.newContext({ timezoneId: "Europe/London" });
  const pageB = await second.newPage();
  try {
    await signIn(pageB, b.admin);
    await pageB.goto("/numbers");
    await expect(pageB.getByTestId("numbers-invoiced")).toHaveText("£7,000");
    await expect(pageB.getByTestId("numbers-received")).toHaveText("£7,000");
    await expect(pageB.getByTestId("numbers-customers").getByText("Zeta Ltd · 100%")).toBeVisible();
    await expect(pageB.getByTestId("numbers-machines").locator("li", { hasText: "Zeta Mill" })).toContainText("5 h");
    const bodyB = pageB.getByTestId("numbers-page");
    for (const other of ["Acme", "Beta", "Numbers Mill", "Numbers Lathe", "£900", "£500"]) await expect(bodyB, other).not.toContainText(other);
  } finally {
    await second.close();
  }
});

test("a read that fails is a dash and \"Couldn't load this.\", never 0, and the other figures stand", async ({ page }) => {
  const solo = await createSoloTenant(w.runId, "numbers-fail");
  await seed({ org: solo.id, invoices: [["Acme", 600]], payments: [100], machines: [["Fail Mill", 1]] });
  await signIn(page, solo.admin);

  await page.route("**/rest/v1/invoice_payments*", (route) => route.abort());
  await page.goto("/numbers");
  await expect(page.getByTestId("numbers-invoiced")).toHaveText("£600");
  await expect(page.getByTestId("numbers-received")).toHaveText("—");
  await expect(page.getByTestId("numbers-cash")).toContainText("Couldn't load this.");
  await expect(page.getByTestId("numbers-cash").locator("[data-col=received]").first()).toHaveText("—");
  await expect(page.getByTestId("numbers-machines").locator("li", { hasText: "Fail Mill" })).toContainText("1 h");

  // Machine runs failing: the third question is a dash with Retry, and Retry reads again once the read works.
  await page.unroute("**/rest/v1/invoice_payments*");
  await page.route("**/rest/v1/machine_runs*", (route) => route.abort());
  await page.goto("/numbers");
  const machines = page.getByTestId("numbers-machines");
  await expect(machines).toContainText("Couldn't load this.");
  await expect(machines).not.toContainText("0 h");
  await page.unroute("**/rest/v1/machine_runs*");
  await machines.getByRole("button", { name: "Retry" }).click();
  await expect(machines.locator("li", { hasText: "Fail Mill" })).toContainText("1 h");
});

test("only an admin reaches Numbers: office, workshop and viewer are sent to the dashboard and are not offered the page", async ({ page, browser }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await expect(page.getByRole("link", { name: "Numbers", exact: true })).toBeVisible();
  await page.goto("/numbers");
  await expect(page).toHaveURL(/\/numbers$/);

  for (const role of ["office", "workshop", "viewer"] as const) {
    const context = await browser.newContext();
    const other = await context.newPage();
    try {
      await signIn(other, w.tenants.alpha.users[role]);
      await expect(other.getByRole("link", { name: "Numbers", exact: true }), `${role}: no menu item`).toHaveCount(0);
      await other.goto("/numbers");
      await expect(other, `${role}: pasted URL`).toHaveURL(/\/dashboard/);
    } finally {
      await context.close();
    }
  }
});
