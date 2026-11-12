/**
 * Reporting > Revenue (stage 1), in the browser, read-only. OFF (no "reports-revenue:on" marker in organization_settings.hidden_nav,
 * the default): the page says "Revenue reports are switched off for your company." and makes none of its own reads. ON: admin and
 * office see it, workshop is refused; with seeded invoices, a credit note, payments, a part-numbered line, a manual line and an open
 * quote the figures are the expected ones, invoiced and cash and pipeline are separate and no combined total exists; another
 * company's invoice never appears; a table downloads as CSV; the filters live in the page only.
 *
 * Company A (a solo company: its own figures, one admin) carries the seeded rows. Company B (solo) proves they never mix. The office
 * and workshop checks use the alpha company (it has those users), so its marker is set through SQL and afterAll removes it again,
 * whatever happened. Serial: the marker is shared state. Every row carries the run id or a solo company, so teardown removes them.
 * Like the rest of the suite there is no per-spec skip: with no backend, global setup fails; listing needs none.
 * Must not change: the marker text (lib/reports/revenue/revenue-switch.ts), the select strings the reads use
 * (lib/reports/revenue/load-revenue.ts REVENUE_SELECT: the fingerprint below), or the texts asserted here.
 */
import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";
import { REVENUE_SELECT } from "@/lib/reports/revenue/load-revenue";
import { REVENUE_OFF_NOTICE, REVENUE_ON_MARKER } from "@/lib/reports/revenue/revenue-switch";

import { adminClient, createSoloTenant, EMAIL_DOMAIN, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "Europe/London" });

type Solo = Awaited<ReturnType<typeof createSoloTenant>>;
let a: Solo;
let b: Solo;
let throwawayUserId = "";

const london = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
function monthOf(offsetMonths: number) {
  const [year, month] = london(0).split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + offsetMonths, 1));
  return { key: first.toISOString().slice(0, 7), label: new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }).format(first) };
}
const last = monthOf(-1);
const current = monthOf(0);

/** Sets or removes the marker for a company (the hidden_nav list the Settings switch will use). */
const setSwitch = (org: string, on: boolean) => withDb(async (db) => {
  const done = await db.query(
    "update public.organization_settings set hidden_nav = case when $2::boolean then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1",
    [org, on, REVENUE_ON_MARKER],
  );
  if (done.rowCount !== 1) throw new Error(`no organization_settings row for ${org}`);
});

/**
 * Invoices (Acme 600: a part-numbered line 300 + a manual line 300; Beta 400: a manual line 360 + carriage 40; a draft and a void one
 * that are not sales), a credit note of 100 today, payments of 300 (last month) and 200 (today), and an open quote of 300.
 */
async function seed(org: string, spec: { invoices: Array<{ customer: string; net: number; carriage?: number; status?: string; lines?: Array<{ quantity: number; price: number; part?: string }> }>; credit?: [customer: string, net: number]; payments?: Array<[amount: number, invoiceIndex: number]>; quote?: [customer: string, quantity: number, price: number] }) {
  const db = adminClient();
  const ok = async (p: PromiseLike<{ error: { message: string } | null }>) => expect((await p).error).toBeNull();
  const tag = org.slice(0, 6);
  let firstInvoice: string | null = null;
  const invoiceIds: string[] = [];
  for (const [i, invoice] of spec.invoices.entries()) {
    const carriage = invoice.carriage ?? 0;
    const lineTotal = invoice.net - carriage;
    const status = invoice.status ?? "sent";
    const made = await db.from("invoices").insert({ organization_id: org, invoice_ref: status === "draft" ? null : `INV-REV-${tag}-${i}`, customer: invoice.customer, status, invoice_date: `${last.key}-10`, subtotal: lineTotal, carriage, vat: lineTotal * 0.2, total: lineTotal * 1.2 + carriage, vat_enabled: true, description: `Revenue ${i}` }).select("id").single();
    expect(made.error).toBeNull();
    firstInvoice ??= made.data!.id;
    invoiceIds.push(made.data!.id);
    for (const [position, line] of (invoice.lines ?? []).entries()) {
      // The invoice is already issued, and an issued invoice's lines are locked against the API roles (019), while a line billing an
      // order line is only ever made by the despatch functions (099). So the lines are written by SQL in one transaction with
      // triggers skipped (session_replication_role = replica), setting what the functions would: the kind and the link. The order and
      // its line (with the part number) are ordinary rows.
      let orderLineId: string | null = null;
      if (line.part) {
      const order = await db.from("sales_orders").insert({ organization_id: org, so_number: `SO-REV-${tag}-${i}`, customer: invoice.customer, total_value: 0, vat_enabled: false, status: "open" }).select("id").single();
      expect(order.error).toBeNull();
      const orderLine = await db.from("sales_order_lines").insert({ organization_id: org, sales_order_id: order.data!.id, position: 0, description: "Revenue part", quantity: line.quantity, unit_price: line.price, vat_pct: 20, vat_exempt: false, part_number: ` ${line.part} ` }).select("id").single();
      expect(orderLine.error).toBeNull();
      orderLineId = orderLine.data!.id;
      }
      await withDb(async (pg) => {
        await pg.query("begin");
        try {
          await pg.query("set local session_replication_role = replica");
          await pg.query(
            "insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, sales_order_line_id, line_kind) values ($1, $2, $3, $4, $5, $6, 20, $7, $8)",
            [org, made.data!.id, position, orderLineId ? "Revenue part" : `Manual ${position}`, line.quantity, line.price, orderLineId, orderLineId ? "order" : "manual"],
          );
          await pg.query("commit");
        } catch (error) {
          await pg.query("rollback");
          throw error;
        }
      });
    }
  }
  if (spec.credit) {
    const [customer, net] = spec.credit;
    await ok(db.from("credit_notes").insert({ organization_id: org, invoice_id: firstInvoice, customer, status: "issued", credit_ref: `CN-REV-${tag}`, credit_date: london(0), subtotal: net, vat: net * 0.2, total: net * 1.2, vat_enabled: true, allocated_amount: 0, issued_at: new Date().toISOString() }));
  }
  for (const [i, [amount, which]] of (spec.payments ?? []).entries()) {
    await ok(db.from("invoice_payments").insert({ organization_id: org, invoice_id: invoiceIds[which], amount, paid_on: i === 0 ? `${last.key}-10` : london(0) }));
  }
  if (spec.quote) {
    const [customer, quantity, price] = spec.quote;
    const quote = await db.from("quotes").insert({ organization_id: org, quote_ref: `QUO-REV-${tag}`, customer, total_value: quantity * price * 1.2, vat_enabled: true, status: "draft", valid_until: london(30) }).select("id").single();
    expect(quote.error).toBeNull();
    await ok(db.from("quote_line_items").insert({ organization_id: org, quote_id: quote.data!.id, position: 0, description: "Revenue quote line", quantity, unit_price: price, vat_pct: 20 }));
    // Issue the quote only after its line exists: an issued quote's lines are locked by the database.
    await ok(db.from("quotes").update({ status: "sent", sent_at: `${last.key}-12T10:00:00Z` }).eq("id", quote.data!.id));
  }
}

/**
 * The page's own reads, by exact table, select string and a distinctive filter of each query. postgrest-js removes whitespace outside
 * quotes from select(), so the sent `select=id,customer,...` is compared with REVENUE_SELECT's whitespace removed. Other readers of
 * these tables (the menu, the shell) differ in select or filter and are not counted.
 */
const READS = ["invoices", "credits", "payments", "paymentInvoices", "invoiceLines", "orderLines", "quotes", "quoteLines"] as const;
type ReadName = (typeof READS)[number];
const TABLE: Record<ReadName, string> = { invoices: "invoices", credits: "credit_notes", payments: "invoice_payments", paymentInvoices: "invoices", invoiceLines: "invoice_line_items", orderLines: "sales_order_lines", quotes: "quotes", quoteLines: "quote_line_items" };
const FILTER: Record<ReadName, (q: URLSearchParams) => boolean> = {
  invoices: (q) => (q.getAll("or").length === 2),
  credits: (q) => q.get("status") === "eq.issued" && (q.get("credit_date") ?? "").length > 0,
  payments: (q) => q.getAll("paid_on").some((v) => v.startsWith("gte.")),
  paymentInvoices: (q) => (q.get("id") ?? "").startsWith("in.("),
  invoiceLines: (q) => (q.get("invoice_id") ?? "").startsWith("in.("),
  orderLines: (q) => (q.get("id") ?? "").startsWith("in.("),
  quotes: (q) => q.get("status") === "eq.sent" && q.getAll("sent_at").some((v) => v.startsWith("gte.")),
  quoteLines: (q) => (q.get("quote_id") ?? "").startsWith("in.("),
};
const SELECT: Record<ReadName, string> = {
  invoices: REVENUE_SELECT.invoices, credits: REVENUE_SELECT.credits, payments: REVENUE_SELECT.payments, paymentInvoices: REVENUE_SELECT.paymentInvoices,
  invoiceLines: REVENUE_SELECT.invoiceLines, orderLines: REVENUE_SELECT.orderLines, quotes: REVENUE_SELECT.quotes, quoteLines: REVENUE_SELECT.quoteLines,
};
const squash = (text: string | null) => (text ?? "").replace(/\s+/g, "");

function revenueReads(page: Page) {
  const reads: ReadName[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const table = url.pathname.split("/rest/v1/")[1];
    if (!table) return;
    for (const name of READS) {
      if (TABLE[name] === table && squash(url.searchParams.get("select")) === squash(SELECT[name]) && FILTER[name](url.searchParams)) reads.push(name);
    }
  });
  return reads;
}

test.beforeAll(async () => {
  a = await createSoloTenant(w.runId, "revenue-a");
  b = await createSoloTenant(w.runId, "revenue-b");
  await seed(a.id, {
    invoices: [
      { customer: "Rev Acme", net: 600, lines: [{ quantity: 3, price: 100, part: "PN-REV-1" }, { quantity: 1, price: 300 }] },
      { customer: "Rev Beta", net: 400, carriage: 40, lines: [{ quantity: 1, price: 360 }] },
      { customer: "Rev Draft Co", net: 5000, status: "draft" },
      { customer: "Rev Void Co", net: 5000, status: "void" },
    ],
    credit: ["Rev Acme", 100],
    payments: [[300, 0], [200, 1]], // 300 on Acme's invoice last month, 200 on Beta's today
    quote: ["Rev Acme", 2, 150],
  });
  await seed(b.id, { invoices: [{ customer: "Zeta Ltd", net: 7000, lines: [{ quantity: 1, price: 7000 }] }], payments: [[7000, 0]] });
  await setSwitch(a.id, false);
  await setSwitch(w.tenants.alpha.id, false);
});

test.afterAll(async () => {
  // Whatever happened above: no marker left behind (the solo companies go with the run's teardown).
  await setSwitch(w.tenants.alpha.id, false);
  if (a) await setSwitch(a.id, false);
  // And no throwaway user left behind if the hidden-sections test stopped before its own cleanup (its membership goes with it).
  if (throwawayUserId) await adminClient().auth.admin.deleteUser(throwawayUserId);
});

test("switch off (the default): the notice, and none of the page's own reads", async ({ page }) => {
  test.setTimeout(120_000);
  const reads = revenueReads(page);
  await signIn(page, a.admin);
  await page.goto("/reports/revenue");
  await expect(page.getByTestId("revenue-off")).toContainText(REVENUE_OFF_NOTICE);
  await expect(page.getByTestId("revenue-page")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(reads).toHaveLength(0);

  // Control: switched on, the same fingerprint shows up for every table, so the zero above is a real zero.
  await setSwitch(a.id, true);
  await page.goto("/reports/revenue");
  await expect(page.getByTestId("revenue-page")).toBeVisible();
  await expect(page.getByTestId("revenue-invoiced-total")).toBeVisible();
  for (const name of READS) expect(reads, name).toContain(name);
});

test("switch on, admin: the expected figures, three separate sections, no combined total, and not another company's rows", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await setSwitch(a.id, true);
  await signIn(page, a.admin);
  await page.goto("/reports/revenue");
  const body = page.getByTestId("revenue-page");
  await expect(body).toBeVisible();
  await expect(body).toContainText("never added together");
  await expect(body).toContainText("matched by the name");

  // Invoiced (ex VAT, less credit notes): 600 + 400 last month, the 100 credit note on its own date this month.
  const invoiced = page.getByTestId("revenue-invoiced");
  await expect(invoiced.getByTestId(`revenue-invoiced-${last.key}`).locator("[data-col=invoiced]")).toHaveText("£1,000.00");
  await expect(invoiced.getByTestId(`revenue-invoiced-${current.key}`).locator("[data-col=invoiced]")).toHaveText("-£100.00");
  await expect(invoiced.getByTestId("revenue-invoiced-total")).toHaveText("£900.00");
  await expect(invoiced.getByTestId(`revenue-invoiced-${last.key}`)).toContainText(last.label);

  // Cash received: 300 last month (on Acme's invoice), 200 today (on Beta's); by customer Acme 60%, Beta 40%.
  const cash = page.getByTestId("revenue-cash");
  await expect(cash.getByTestId(`revenue-cash-${last.key}`).locator("[data-col=received]")).toHaveText("£300.00");
  await expect(cash.getByTestId(`revenue-cash-${current.key}`).locator("[data-col=received]")).toHaveText("£200.00");
  await expect(cash.getByTestId("revenue-cash-total")).toHaveText("£500.00");
  const cashCustomers = page.getByTestId("revenue-cash-customers");
  await expect(cashCustomers.getByTestId("revenue-cash-customer-row").filter({ hasText: "Rev Acme" }).locator("[data-col=received]")).toHaveText("£300.00");
  await expect(cashCustomers.getByTestId("revenue-cash-customer-row").filter({ hasText: "Rev Beta" }).locator("[data-col=share]")).toHaveText("40%");

  // By customer: Acme 500 (600 less its 100 credit), Beta 400; shares add to 100; the draft and void invoices are not sales.
  const customers = page.getByTestId("revenue-customers");
  await expect(customers.getByTestId("revenue-customer-row")).toHaveCount(2);
  const acme = customers.getByTestId("revenue-customer-row").filter({ hasText: "Rev Acme" });
  await expect(acme.locator("[data-col=invoiced]")).toHaveText("£500.00");
  await expect(acme.locator("[data-col=share]")).toHaveText("56%");
  await expect(customers.getByTestId("revenue-customer-row").filter({ hasText: "Rev Beta" }).locator("[data-col=share]")).toHaveText("44%");
  await expect(customers).not.toContainText("Rev Draft Co");
  await expect(customers).not.toContainText("Rev Void Co");

  // By part number: the part-numbered line under its trimmed part number, the manual lines Uncategorised, Beta's carriage its own row,
  // the credit note one row; the rows add up to the invoiced 900, and every invoice adds up by line.
  const parts = page.getByTestId("revenue-parts");
  const part = (name: string) => parts.getByTestId("revenue-part-row").filter({ has: page.getByRole("rowheader", { name, exact: true }) }).locator("[data-col=invoiced]");
  await expect(part("PN-REV-1")).toHaveText("£300.00");
  await expect(part("Uncategorised")).toHaveText("£660.00");
  await expect(part("Carriage")).toHaveText("£40.00");
  await expect(part("Credit notes (not split by product)")).toHaveText("-£100.00");
  await expect(parts.getByTestId("revenue-parts-mismatch")).toHaveCount(0);

  // Pipeline: its own section, 300 ex VAT from one open quote, titled "not revenue".
  const pipeline = page.getByTestId("revenue-pipeline");
  await expect(page.getByRole("heading", { name: "Pipeline (not revenue)" })).toBeVisible();
  await expect(pipeline.getByTestId(`revenue-pipeline-${last.key}`).locator("[data-col=quoted]")).toHaveText("£300.00");
  await expect(pipeline.getByTestId("revenue-pipeline-total")).toHaveText("£300.00");
  await expect(pipeline.getByTestId("revenue-pipeline-count")).toHaveText("1");

  // No combined total anywhere: not invoiced + cash (1,400), + pipeline (1,700), or invoiced + pipeline (1,200).
  for (const combined of ["£1,400.00", "£1,700.00", "£1,200.00", "Grand total", "Combined"]) await expect(body, combined).not.toContainText(combined);

  // None of company B is anywhere on A's page, nor in the customer choices.
  for (const other of ["Zeta", "£7,000", "£7,900"]) await expect(body, other).not.toContainText(other);
  expect(await page.getByLabel("Customer").locator("option").allTextContents()).toEqual(["All customers", "Rev Acme", "Rev Beta"]);

  // The customer filter: Beta only. Invoiced 400 and cash 200 (Beta's payment only); the pipeline (Acme's quote) is empty.
  await page.getByLabel("Customer").selectOption("Rev Beta");
  await expect(invoiced.getByTestId("revenue-invoiced-total")).toHaveText("£400.00");
  await expect(customers.getByTestId("revenue-customer-row")).toHaveCount(1);
  await expect(cash.getByTestId("revenue-cash-total")).toHaveText("£200.00");
  await expect(cashCustomers.getByTestId("revenue-cash-customer-row")).toHaveCount(1);
  await expect(pipeline.getByTestId("revenue-pipeline-count")).toHaveText("0");

  // The date range: ending before this month drops the credit note and this month's cash; a start after last month's invoices empties it.
  await page.getByLabel("Customer").selectOption("");
  await page.getByLabel("To date").fill(`${last.key}-28`);
  await expect(invoiced.getByTestId("revenue-invoiced-total")).toHaveText("£1,000.00");
  await expect(cash.getByTestId("revenue-cash-total")).toHaveText("£300.00");
  await page.getByLabel("From date").fill(`${last.key}-11`);
  await expect(invoiced.getByTestId("revenue-invoiced-total")).toHaveText("£0.00");

  // Filters are held in the page only: not in the address, not in storage.
  await expect(page).toHaveURL(/\/reports\/revenue$/);
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(stored).not.toContain("Rev Beta");
  expect(stored).not.toContain(`${last.key}-28`);

  // Company B signs in separately and sees only its own.
  await setSwitch(b.id, true);
  const second = await browser.newContext({ timezoneId: "Europe/London" });
  const pageB = await second.newPage();
  try {
    await signIn(pageB, b.admin);
    await pageB.goto("/reports/revenue");
    await expect(pageB.getByTestId("revenue-invoiced-total")).toHaveText("£7,000.00");
    await expect(pageB.getByTestId("revenue-cash-total")).toHaveText("£7,000.00");
    for (const other of ["Rev Acme", "Rev Beta", "PN-REV-1", "£900.00", "£500.00"]) await expect(pageB.getByTestId("revenue-page"), other).not.toContainText(other);
  } finally {
    await second.close();
  }
});

test("a table downloads as CSV, and it holds only this company's rows and one basis", async ({ page }) => {
  test.setTimeout(120_000);
  await setSwitch(a.id, true);
  await signIn(page, a.admin);
  await page.goto("/reports/revenue");
  await expect(page.getByTestId("revenue-customers").getByTestId("revenue-customer-row")).toHaveCount(2);
  const download = page.waitForEvent("download");
  await page.getByTestId("revenue-customers").getByRole("button", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^Revenue invoiced by customer-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile((await file.path())!, "utf8");
  expect(csv).toContain("Customer");
  expect(csv).toContain("Rev Acme");
  expect(csv).toContain("Rev Beta");
  expect(csv).not.toContain("Zeta");
  expect(csv).not.toMatch(/total|received|cash|pipeline/i);
});

test("a read that fails is one muted line for that table, and the others stand", async ({ page }) => {
  test.setTimeout(120_000);
  await setSwitch(a.id, true);
  await signIn(page, a.admin);
  await page.route("**/rest/v1/invoice_payments*", (route) => route.abort());
  await page.goto("/reports/revenue");
  await expect(page.getByTestId("revenue-cash-failed")).toBeVisible();
  await expect(page.getByTestId("revenue-invoiced-total")).toHaveText("£900.00");
  await expect(page.getByTestId("revenue-pipeline-total")).toHaveText("£300.00");
});

test("switch on: office sees the report; workshop and viewer are refused and read nothing", async ({ browser }) => {
  test.setTimeout(180_000);
  await setSwitch(w.tenants.alpha.id, true);
  const officeContext = await browser.newContext({ timezoneId: "Europe/London" });
  const office = await officeContext.newPage();
  try {
    await signIn(office, w.tenants.alpha.users.office);
    await office.goto("/reports/revenue");
    await expect(office.getByTestId("revenue-page")).toBeVisible();
    await expect(office.getByTestId("revenue-invoiced")).toBeVisible();
    await expect(office.getByRole("heading", { name: "Pipeline (not revenue)" })).toBeVisible();
  } finally {
    await officeContext.close();
  }
  for (const role of ["workshop", "viewer"] as const) {
    const context = await browser.newContext({ timezoneId: "Europe/London" });
    const other = await context.newPage();
    const reads = revenueReads(other);
    try {
      await signIn(other, w.tenants.alpha.users[role]);
      await other.goto("/reports/revenue");
      await expect(other.getByRole("heading", { name: "Access Denied" }), role).toBeVisible();
      await expect(other.getByTestId("revenue-page"), role).toHaveCount(0);
      await other.waitForLoadState("networkidle");
      expect(reads, `${role}: no revenue reads`).toHaveLength(0);
    } finally {
      await context.close();
    }
  }
});

test("a hidden Invoices section: one notice, no invoice figures, no invoice reads (never £0.00); a hidden Quotes section: its own notice", async ({ browser }) => {
  test.setTimeout(180_000);
  // A throwaway office user in company A (a solo company of this run), as tests/e2e/job-board-play.spec.ts does: created here, deleted
  // in finally (its membership goes with it: organization_members.user_id is ON DELETE CASCADE), and afterAll deletes it too if this
  // stopped early. No shared user's hidden_sections is ever changed.
  const db = adminClient();
  const email = `revhide.${w.runId}@${EMAIL_DOMAIN}`;
  const password = generatePassword(16);
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "revhide" } });
  if (created.error || !created.data.user) throw new Error(`createUser ${email}: ${created.error?.message}`);
  const userId = created.data.user.id;
  throwawayUserId = userId;
  const context = await browser.newContext({ timezoneId: "Europe/London" });
  const page = await context.newPage();
  const reads = revenueReads(page);
  try {
    const added = await db.rpc("add_member", { p_org: a.id, p_email: email, p_role: "office" });
    if (added.error || added.data !== "member") throw new Error(`add_member ${email}: ${added.error?.message ?? added.data}`);
    const hide = async (sections: string[]) => expect((await db.from("organization_members").update({ hidden_sections: sections }).eq("organization_id", a.id).eq("user_id", userId)).error).toBeNull();
    await setSwitch(a.id, true);

    await hide(["invoices"]);
    await signIn(page, { id: userId, email, password, role: "office" });
    await page.goto("/reports/revenue");
    await expect(page.getByTestId("revenue-invoices-hidden")).toHaveText("Invoices are hidden for you, so revenue can't be shown.");
    await expect(page.getByTestId("revenue-pipeline")).toBeVisible();
    for (const testId of ["revenue-invoiced", "revenue-cash", "revenue-customers", "revenue-parts"]) await expect(page.getByTestId(testId)).toHaveCount(0);
    await expect(page.getByTestId("revenue-page")).not.toContainText("Total invoiced");
    for (const name of ["invoices", "credits", "payments", "paymentInvoices", "invoiceLines", "orderLines"] as const) expect(reads, name).not.toContain(name);
    expect(reads).toContain("quotes");

    reads.length = 0;
    await hide(["quotes"]);
    await page.reload();
    await expect(page.getByTestId("revenue-quotes-hidden")).toHaveText("Quotes are hidden for you.");
    await expect(page.getByTestId("revenue-invoiced")).toBeVisible();
    await expect(page.getByTestId("revenue-pipeline")).toHaveCount(0);
    expect(reads).not.toContain("quotes");
    expect(reads).not.toContain("quoteLines");
    expect(reads).toContain("invoices");
  } finally {
    await context.close();
    const removed = await db.auth.admin.deleteUser(userId);
    expect(removed.error, `delete the test user ${email}`).toBeNull();
    throwawayUserId = "";
    const member = await db.from("organization_members").select("user_id").eq("user_id", userId);
    expect(member.error).toBeNull();
    expect(member.data, "no membership left for the test user").toEqual([]);
  }
});
