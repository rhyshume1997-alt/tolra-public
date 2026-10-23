/**
 * UI PR 2 ("Tablet shell and responsive repairs"), in the browser, against the local disposable backend only.
 *
 * - Navigation is a drawer through 1024px inclusive and the fixed sidebar only above it (1025px+).
 * - Role / company and the connection state stay discoverable in the top bar without another row of chrome.
 * - Records: phone cards below 768px; cards or compact lists from 768px to 1024px; dense tables only above 1024px.
 * - Stacked records carry visible field captions; long company names, e-mails and descriptions wrap.
 * - The quote detail (line columns, action footer) stays usable and reachable at 390px; dialogs keep the shared
 *   viewport bound; no page-level sideways scrolling at 390 / 820 / 1024.
 * - Touch targets stay >= 44px (the workshop Job Board's 64 / 48 from PR 1 is checked by ui-pr1.spec.ts).
 * - Network: every browser context here aborts and records any request that is not loopback (and the suite fails on one).
 *
 * Synthetic data only (alpha tenant of the synthetic world; nothing here leaves this machine).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { EDGE, SCREENSHOT_DIR, VIEWPORTS, deviceContext, saveScreenshot, type ViewportSpec } from "../support/ui-pr2-screenshots";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
const alpha = () => w.tenants.alpha;
const tag = () => w.runId.slice(0, 6);
const baseURL = () => String(test.info().project.use.baseURL);

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic data (built inside tests and hooks, never at import)
// ---------------------------------------------------------------------------------------------------------------------

/** Exactly `length` characters of readable text. */
function text(seed: string, length: number) {
  return seed.repeat(Math.ceil(length / seed.length) + 1).slice(0, length - 1) + "d";
}
const COMPANY_120 = () => text("Hargreaves Whitcombe Aerospace Precision Engineering and Advanced Manufacturing Holdings Northern Division Limited ", 120);
const DESCRIPTION_240 = () => text("Turned and milled stainless steel hydraulic manifold block with six cross-drilled ports, threaded insert seats, deburred and passivated, supplied with full material certification and first-off inspection report ", 240);
const LONG_EMAIL = () => `accounts.payable.department.northern.division.${tag()}@very-long-subdomain-name-for-layout-testing.example.test`;
const LONG_ADDRESS = () => text("Unit 14 Hargreaves Industrial Estate Whitcombe Road Northern Business Park Greater Testchester TE57 9XY United Kingdom ", 240);

const ref = (kind: string) => `${kind}-UI2-${tag()}`;
const QUOTE = () => ref("QUO");
const JOB = () => ref("J");
const SO = () => ref("SO");
const PO = () => ref("PO");
const DN = () => ref("DLN");
/** Customer name that is unique to this run and long: 120 characters plus the tag. */
const CUSTOMER = () => `${COMPANY_120()} ${tag()}`;

test.beforeAll(async () => {
  const admin = adminClient();
  const org = alpha().id;
  expect(COMPANY_120()).toHaveLength(120);
  expect(DESCRIPTION_240()).toHaveLength(240);
  const check = (what: string, result: { error: { message: string } | null }) => expect(result.error, what).toBeNull();

  check("customer", await admin.from("customers").insert({ organization_id: org, name: CUSTOMER(), email: LONG_EMAIL(), address: LONG_ADDRESS(), phone: "01000 000000", contact_name: "Pat Contact" }));
  check("supplier", await admin.from("suppliers").insert({ organization_id: org, name: `${COMPANY_120()} Supplies ${tag()}`, email: LONG_EMAIL(), contact_name: "Sam Supplier", phone: "01000 111111", notes: DESCRIPTION_240() }));

  const quote = await admin.from("quotes").insert({ organization_id: org, quote_ref: QUOTE(), customer: CUSTOMER(), description: DESCRIPTION_240(), total_value: 392, vat_enabled: false, status: "draft", valid_until: "2099-12-31", customer_notes: LONG_EMAIL(), internal_notes: DESCRIPTION_240() }).select("id").single();
  check("quote", quote);
  check("quote lines", await admin.from("quote_line_items").insert([
    { organization_id: org, quote_id: quote.data!.id, position: 0, description: DESCRIPTION_240(), quantity: 1250, unit_price: 0.25, vat_pct: 0 },
    { organization_id: org, quote_id: quote.data!.id, position: 1, description: `Carriage ${LONG_EMAIL()}`, quantity: 3, unit_price: 26.5, vat_pct: 0 },
  ]));
  // Issued quotes can't have their lines changed, so the lines go in while it is a draft and it is sent afterwards.
  check("quote sent", await admin.from("quotes").update({ status: "sent" }).eq("id", quote.data!.id));

  check("job", await admin.from("jobs").insert({ organization_id: org, job_no: JOB(), customer: CUSTOMER(), description: DESCRIPTION_240(), stage: "material", due_date: "2099-01-05", date_required: "2099-01-05" }));
  check("sales order", await admin.from("sales_orders").insert({ organization_id: org, so_number: SO(), customer: CUSTOMER() }));
  check("purchase order", await admin.from("purchase_orders").insert({ organization_id: org, po_ref: PO(), po_number: PO(), supplier: `${COMPANY_120()} Supplies ${tag()}` }));
  check("delivery note", await admin.from("delivery_notes").insert({ organization_id: org, dn_number: DN(), customer: CUSTOMER(), status: "pending" }));
  check("invoice", await admin.from("invoices").insert({ organization_id: org, invoice_ref: null, customer: CUSTOMER(), status: "draft", subtotal: 50, vat: 0, total: 50, vat_enabled: false, due_date: "2099-01-31", description: DESCRIPTION_240() }));
});

test.afterAll(async () => {
  const admin = adminClient();
  const org = alpha().id;
  await admin.from("quotes").delete().eq("organization_id", org).like("quote_ref", `QUO-UI2-${tag()}%`);
  await admin.from("jobs").delete().eq("organization_id", org).like("job_no", `J-UI2-${tag()}%`);
  await admin.from("sales_orders").delete().eq("organization_id", org).like("so_number", `SO-UI2-${tag()}%`);
  await admin.from("purchase_orders").delete().eq("organization_id", org).like("po_ref", `PO-UI2-${tag()}%`);
  await admin.from("delivery_notes").delete().eq("organization_id", org).like("dn_number", `DLN-UI2-${tag()}%`);
  await admin.from("invoices").delete().eq("organization_id", org).like("customer", `%${tag()}`);
  await admin.from("customers").delete().eq("organization_id", org).like("name", `%${tag()}`);
  await admin.from("suppliers").delete().eq("organization_id", org).like("name", `%${tag()}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Helpers: network guard, measuring, devices
// ---------------------------------------------------------------------------------------------------------------------

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const blocked: string[] = [];
let loopbackRequests = 0;

/** Any request that is not to this machine is aborted and recorded, and the test fails afterwards. */
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
const overflow: Array<{ where: string; scrollWidth: number; clientWidth: number }> = [];
const shots: string[] = [];

test.afterAll(() => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  writeFileSync(path.join(SCREENSHOT_DIR, "measurements.json"), JSON.stringify({ loopbackRequests, blocked, screenshots: shots.map((file) => path.basename(file)), pageScroll: overflow, measured }, null, 2));
});

/** Measures a control's hit area; the box must be at least minW x minH CSS pixels. */
async function expectTarget(context: string, name: string, locator: Locator, minW = 44, minH = 44) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${context}: ${name} has a box`).not.toBeNull();
  measured.push({ context, name, width: Math.round(box!.width * 10) / 10, height: Math.round(box!.height * 10) / 10 });
  expect(box!.width, `${context}: ${name} width ${box!.width}`).toBeGreaterThanOrEqual(minW - 0.5);
  expect(box!.height, `${context}: ${name} height ${box!.height}`).toBeGreaterThanOrEqual(minH - 0.5);
}

async function noSidewaysScroll(page: Page, where: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  overflow.push({ where, scrollWidth, clientWidth });
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

async function visit(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("networkidle");
}

/** The job's card (phone, Cards view) or row (list view), whichever the screen shows. */
const jobEntry = (page: Page) => page.locator(`[data-testid="job-card"][data-job-no="${JOB()}"]:visible, tr:has-text("${JOB()}"):visible`);

/** The fixed sidebar is the only <aside> in the shell. */
const sidebar = (page: Page) => page.locator("aside");

/** A tap on a touch device, a click on a mouse one. */
async function press(page: Page, locator: Locator) {
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await locator.tap();
  else await locator.click();
}

async function openQuote(page: Page) {
  await visit(page, "/quotes");
  const card = page.locator('[data-slot="card"]', { hasText: QUOTE() });
  await press(page, card.getByRole("button", { name: "View", exact: true }));
  const dialog = page.getByRole("dialog", { name: `${QUOTE()} quote details` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("quote-line")).toHaveCount(2);
  return dialog;
}

/** The dialog sits inside the screen and keeps the shared viewport bound (100dvh - 2rem). */
async function expectDialogFits(page: Page, dialog: Locator, where: string) {
  const viewport = page.viewportSize()!;
  const box = (await dialog.boundingBox())!;
  expect(box.x, `${where}: left`).toBeGreaterThanOrEqual(-0.5);
  expect(box.y, `${where}: top`).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, `${where}: right`).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box.y + box.height, `${where}: bottom`).toBeLessThanOrEqual(viewport.height + 0.5);
  const inner = await dialog.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, maxHeight: getComputedStyle(el).maxHeight }));
  expect(inner.scrollWidth, `${where}: dialog scrolls sideways`).toBeLessThanOrEqual(inner.clientWidth + 1);
  expect(Math.abs(parseFloat(inner.maxHeight) - (viewport.height - 32)), `${where}: max-height ${inner.maxHeight} is the shared bound`).toBeLessThanOrEqual(1);
}

/** What an element's ::before shows (the field caption on a stacked cell). */
const captionOf = (cell: Locator) => cell.evaluate((el) => { const style = getComputedStyle(el, "::before"); return { content: style.content, display: style.display }; });

// ---------------------------------------------------------------------------------------------------------------------
// 1. Navigation: drawer through 1024px inclusive, fixed sidebar above it
// ---------------------------------------------------------------------------------------------------------------------

test("shell: drawer (no fixed sidebar) at 820 and 1024, fixed sidebar from 1025; touch targets >= 44px", async ({ browser }) => {
  for (const viewport of [TABLET, EDGE]) {
    const { context, page } = await device(browser, viewport);
    const where = `admin @${viewport.width}`;
    await signIn(page, alpha().users.admin);
    await visit(page, "/jobs");
    await expect(sidebar(page), `${where}: no fixed sidebar`).toBeHidden();
    const toggle = page.getByRole("button", { name: "Open menu" });
    await expect(toggle).toBeVisible();
    await expectTarget(where, "drawer toggle", toggle);
    // The content is not pushed right by a sidebar that isn't there.
    expect(await page.evaluate(() => Math.round(document.querySelector("main")!.getBoundingClientRect().left)), `${where}: main starts at the edge padding`).toBeLessThan(40);
    for (const name of ["Log out"]) await expectTarget(where, name, page.getByRole("button", { name, exact: true }));

    await toggle.tap();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expectTarget(where, "drawer close", drawer.getByRole("button", { name: "Close", exact: true }));
    for (const name of ["Job Board", "Quote Generator", "Customers"]) await expectTarget(where, `drawer ${name}`, drawer.getByRole("link", { name }));
    await expect(drawer.getByTestId("drawer-connection")).toHaveText("Online");
    // Choosing a destination closes the drawer and opens the page.
    await drawer.getByRole("link", { name: "Customers" }).tap();
    await expect(page).toHaveURL(/\/customers/);
    await expect(drawer).toBeHidden();
    await noSidewaysScroll(page, `${where} /customers after drawer`);
    await context.close();
  }

  // Wide screens: the fixed sidebar, no drawer toggle, and one pixel makes the difference (1024 vs 1025).
  const wide = await device(browser, DESKTOP);
  await signIn(wide.page, alpha().users.admin);
  await visit(wide.page, "/dashboard");
  await wide.page.setViewportSize({ width: 1025, height: 800 });
  await expect(sidebar(wide.page), "1025: fixed sidebar").toBeVisible();
  await expect(wide.page.getByRole("button", { name: "Open menu" })).toBeHidden();
  await wide.page.setViewportSize({ width: 1024, height: 800 });
  await expect(sidebar(wide.page), "1024: drawer").toBeHidden();
  await expect(wide.page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await wide.page.setViewportSize({ width: 1280, height: 800 });
  await expect(sidebar(wide.page), "1280: fixed sidebar").toBeVisible();
  expect(await wide.page.evaluate(() => Math.round(document.querySelector("main")!.getBoundingClientRect().left))).toBeGreaterThanOrEqual(248);
  await expect(wide.page.getByTestId("shell-status"), "no extra chip beside a sidebar that already says it").toBeHidden();

  // An open drawer does not outlive the layout change (a tablet turned to landscape).
  await wide.page.setViewportSize({ width: 820, height: 1180 });
  await wide.page.getByRole("button", { name: "Open menu" }).click();
  await expect(wide.page.getByRole("dialog")).toBeVisible();
  await wide.page.setViewportSize({ width: 1280, height: 800 });
  await expect(wide.page.getByRole("dialog")).toBeHidden();
  await expect(sidebar(wide.page)).toBeVisible();
  await wide.context.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Role / company and connection stay discoverable
// ---------------------------------------------------------------------------------------------------------------------

test("shell: the menu button opens the drawer, not the company selector, and the two controls never overlap (390, 820, 1024, 1280)", async ({ browser }) => {
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const viewport of [PHONE, TABLET, EDGE, DESKTOP]) {
    const { context, page } = await device(browser, viewport);
    const where = `admin @${viewport.width}`;
    await signIn(page, alpha().users.admin);
    await visit(page, "/jobs");
    const menu = page.getByRole("button", { name: "Open menu" });
    const chip = page.getByTestId("shell-status");
    if (viewport.width > 1024) {
      await expect(menu, `${where}: fixed sidebar, no menu button`).toBeHidden();
      await expect(chip, `${where}: no status chip`).toBeHidden();
      await context.close();
      continue;
    }
    await expect(menu).toBeVisible();
    await expect(chip).toBeVisible();
    expect(overlap((await menu.boundingBox())!, (await chip.boundingBox())!), `${where}: menu button and status chip overlap`).toBe(false);
    if (viewport.width === PHONE.width) {
      await menu.tap();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      // Nothing in the drawer took focus from the tap: the organisation select (when present) is untouched.
      expect(await page.evaluate(() => document.activeElement?.tagName), `${where}: opening the drawer must not focus the company selector`).not.toBe("SELECT");
      // The drawer itself holds focus (Radix would otherwise focus its first control, the company selector for a two-company person).
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role")), `${where}: the drawer itself takes focus`).toBe("dialog");
      const picker = drawer.getByRole("combobox", { name: "Switch organisation" });
      if (await picker.count()) await expect(picker).not.toBeFocused();
    }
    await context.close();
  }
});

test("shell: view, company and connection are one small control in the top bar, and the drawer says the rest", async ({ browser }) => {
  for (const [role, user] of [["Admin", alpha().users.admin], ["Office", alpha().users.office], ["Workshop", alpha().users.workshop]] as const) {
    for (const viewport of [PHONE, TABLET]) {
      const { context, page } = await device(browser, viewport);
      const where = `${role} @${viewport.width}`;
      await signIn(page, user);
      await visit(page, "/jobs");
      const chip = page.getByTestId("shell-status");
      await expect(chip, where).toBeVisible();
      await expect(chip, `${where}: name carries view, company, connection`).toHaveAttribute("aria-label", new RegExp(`^${role} view, .+, Online$`));
      await expect(chip).toHaveAttribute("data-connection", "online");
      await expectTarget(where, "status chip", chip);
      // It is part of the top bar, not another row: same bar as the menu button, nothing stacked above the page title.
      const header = await page.locator("header.sticky").boundingBox();
      const chipBox = (await chip.boundingBox())!;
      expect(header!.height, `${where}: top bar stays one row`).toBeLessThanOrEqual(64.5);
      expect(chipBox.y, where).toBeGreaterThanOrEqual(header!.y - 0.5);
      expect(chipBox.y + chipBox.height, where).toBeLessThanOrEqual(header!.y + header!.height + 0.5);
      if (viewport.width >= 640) await expect(chip, `${where}: words once there is room`).toContainText(`${role} · Online`);
      // Tapping it opens the drawer, which names the view next to the connection.
      await chip.tap();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText(role);
      await expect(drawer.getByTestId("drawer-connection")).toHaveText("Online");
      await context.close();
    }
  }
});

test("shell: when the connection is lost the top bar and the drawer say Offline (the existing banner stays the place to act)", async ({ browser }) => {
  const { context, page } = await device(browser, TABLET);
  await signIn(page, alpha().users.workshop);
  await visit(page, "/jobs"); // online first: the device takes its copy
  await expect(page.getByTestId("shell-status")).toHaveAttribute("data-connection", "online");
  for (const pattern of ["**/rest/v1/**", "**/auth/v1/**", "**/storage/v1/**"]) await context.route(pattern, (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(page.getByText(/Offline - last synced \d\d:\d\d/)).toBeVisible();
  const chip = page.getByTestId("shell-status");
  await expect(chip).toHaveAttribute("data-connection", "offline");
  await expect(chip).toHaveAttribute("aria-label", /Offline/);
  await expect(chip.getByTestId("connection-dot")).toHaveAttribute("data-tone", "warn");
  await chip.tap();
  await expect(page.getByRole("dialog").getByTestId("drawer-connection")).toHaveText("Offline");
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Records: cards below 768, cards or compact lists to 1024, dense tables above
// ---------------------------------------------------------------------------------------------------------------------

test("lists: Job Board and list pages never show a dense table up to 1024px (the choice returns on a wide screen)", async ({ page }) => {
  await guardNetwork(page.context());
  await signIn(page, alpha().users.admin);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/jobs");
  await expect(page.getByTestId("selection-summary")).toBeVisible();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Drawings" })).toBeVisible();

  for (const width of [1024, 820, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("columnheader", { name: "Drawings" }), `jobs @${width}: dense table`).toHaveCount(0);
    await expect(page.locator('[data-testid="job-card"]:visible').first(), `jobs @${width}: cards instead`).toBeVisible();
    await expect(page.getByRole("button", { name: "Table", exact: true }), `jobs @${width}: no Table option`).toBeHidden();
    await expect(page.getByRole("button", { name: "Cards", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "List", exact: true })).toBeVisible();
    await noSidewaysScroll(page, `jobs table choice @${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("columnheader", { name: "Drawings" }), "the table choice is kept for a wide screen").toBeVisible();
  await expect(page.getByRole("button", { name: "Table", exact: true })).toHaveAttribute("aria-pressed", "true");

  // The same on the other list pages: a stored Table choice shows as cards at tablet width, header row hidden.
  for (const route of ["/customers", "/sales-orders", "/purchase-orders", "/invoices", "/suppliers"]) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(route);
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.locator("thead").first(), `${route} @1280`).toBeVisible();
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.locator("thead").first(), `${route} @900: header row gone with the dense table`).toBeHidden();
    await expect(page.getByRole("button", { name: "Table", exact: true }), `${route} @900`).toBeHidden();
    await noSidewaysScroll(page, `${route} stored table choice @900`);
  }
  for (const route of ["/delivery-notes", "/suppliers"]) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(route);
    await expect(page.locator("thead").first(), `${route} @1280`).toBeVisible();
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.locator("thead").first(), `${route} @900`).toBeHidden();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. No page-level sideways scrolling; long values wrap; captions on stacked records
// ---------------------------------------------------------------------------------------------------------------------

const PAGES = ["/dashboard", "/jobs", "/quotes", "/invoices", "/customers", "/sales-orders", "/purchase-orders", "/delivery-notes", "/suppliers"];

for (const viewport of [PHONE, TABLET, EDGE]) {
  test(`no sideways page scroll at ${viewport.width}px with a 120-character company, 240-character description and long e-mail / address (admin)`, async ({ browser }) => {
    const { context, page } = await device(browser, viewport);
    await signIn(page, alpha().users.admin);
    for (const route of PAGES) {
      await visit(page, route);
      if (route === "/customers") await expect(page.getByText(LONG_EMAIL())).toBeVisible();
      if (route === "/quotes") await expect(page.locator('[data-slot="card"]', { hasText: QUOTE() })).toContainText(COMPANY_120());
      if (route === "/jobs") await expect(jobEntry(page).first()).toBeVisible();
      await noSidewaysScroll(page, `admin ${route} @${viewport.width}`);
    }
    // Wide regions scroll inside their container: the page itself does not. Nothing may poke out of the card it sits in.
    await visit(page, "/customers");
    const escapees = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main td, main [data-slot='card'] p")]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > document.documentElement.clientWidth + 1; })
      .map((el) => (el.textContent ?? "").trim().slice(0, 40)).slice(0, 3));
    expect(escapees, `customers @${viewport.width}: values past the screen edge`).toEqual([]);
    await context.close();
  });
}

test("quote detail with long values: no sideways scroll, captions on stacked lines, actions reachable at 390px", async ({ browser }) => {
  const { context, page } = await device(browser, PHONE);
  await signIn(page, alpha().users.admin);
  const dialog = await openQuote(page);
  await expectDialogFits(page, dialog, "quote detail @390");
  await noSidewaysScroll(page, "admin quote detail @390");
  // Long values are all there, wrapped.
  await expect(dialog).toContainText(COMPANY_120());
  await expect(dialog.getByTestId("quote-lines")).toContainText(DESCRIPTION_240());
  await expect(dialog).toContainText(LONG_EMAIL()); // customer notes: one unbroken 110-character token
  // Stacked lines have no header row: each figure names itself.
  await expect(dialog.getByTestId("quote-lines").getByText("Description", { exact: true }), "header row is for wide dialogs").toBeHidden();
  const line = dialog.getByTestId("quote-line").first();
  for (const caption of ["Qty", "Unit Price", "Total"]) await expect(line.getByText(caption, { exact: true }), `caption ${caption}`).toBeVisible();
  // The four columns are not fixed-width any more: every figure is inside the dialog.
  const inside = await dialog.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>("[data-testid='quote-line'] span")].filter((s) => { const r = s.getBoundingClientRect(); return r.width > 0 && (r.right > bounds.right + 0.5 || r.left < bounds.left - 0.5); }).length;
  });
  expect(inside, "line figures outside the dialog").toBe(0);

  // The action footer: wraps (stacked, full width) and every button can be reached and pressed.
  const actions = dialog.getByTestId("quote-actions");
  const names = ["Copy", "Mark Rejected", "Mark Accepted", "Download PDF", "Send to Customer"];
  for (const name of names) {
    const button = actions.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expectTarget("phone/admin quote actions", name, button, 44, 44);
    const box = (await button.boundingBox())!;
    const dialogBox = (await dialog.boundingBox())!;
    expect(box.x, `${name} left`).toBeGreaterThanOrEqual(dialogBox.x - 0.5);
    expect(box.x + box.width, `${name} right`).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 0.5);
    expect(box.y + box.height, `${name} above the bottom of the screen`).toBeLessThanOrEqual(page.viewportSize()!.height + 0.5);
    await button.click({ trial: true }); // fails if something covers it
  }
  await expectTarget("phone/admin quote detail", "dialog close", dialog.getByRole("button", { name: "Close", exact: true }));
  await context.close();
});

test("quote detail at 820: four columns with a header row, actions wrap inside the dialog", async ({ browser }) => {
  const { context, page } = await device(browser, TABLET);
  await signIn(page, alpha().users.admin);
  const dialog = await openQuote(page);
  await expectDialogFits(page, dialog, "quote detail @820");
  await expect(dialog.getByTestId("quote-lines").getByText("Unit Price", { exact: true }).first()).toBeVisible();
  const actions = dialog.getByTestId("quote-actions");
  const boxes = [];
  for (const name of ["Copy", "Mark Rejected", "Mark Accepted", "Download PDF", "Send to Customer"]) {
    const button = actions.getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expectTarget("tablet/admin quote actions", name, button, 44, 44);
    boxes.push((await button.boundingBox())!);
  }
  const dialogBox = (await dialog.boundingBox())!;
  for (const box of boxes) expect(box.x + box.width, "action inside the dialog").toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 0.5);
  await noSidewaysScroll(page, "admin quote detail @820");
  await context.close();
});

test("dialogs keep the shared viewport bound (no 90vh / 92vh override): worksheet and quote builder at phone and tablet", async ({ browser }) => {
  for (const viewport of [PHONE, TABLET]) {
    const { context, page } = await device(browser, viewport);
    await signIn(page, alpha().users.admin);
    await visit(page, "/jobs");
    await jobEntry(page).first().getByRole("button", { name: "Worksheet" }).tap();
    const sheet = page.getByRole("dialog", { name: `Worksheet - ${JOB()}` });
    await expect(sheet).toBeVisible();
    await expectDialogFits(page, sheet, `worksheet @${viewport.width}`);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await visit(page, "/quotes");
    await page.getByRole("button", { name: "New quote" }).tap();
    const builder = page.getByRole("dialog", { name: "Quote Builder" });
    await expect(builder).toBeVisible();
    await expectDialogFits(page, builder, `quote builder @${viewport.width}`);
    if (viewport.width < 768) {
      // Stacked line-item fields name themselves (the header row only exists from 768px).
      const line = builder.locator("form .space-y-2 > div").nth(1);
      for (const caption of ["Description", "Qty", "Unit price", "VAT", "Line total"]) await expect(line.getByText(caption, { exact: true }), `builder caption ${caption}`).toBeVisible();
      await expectTarget("phone/admin quote builder", "Remove line", line.getByRole("button", { name: "Remove line" }));
    }
    await context.close();
  }
});

test("stacked records carry visible captions (phone and tablet), tables keep their header row on wide screens", async ({ browser }) => {
  const rows: Array<{ route: string; find: (page: Page) => Locator; captions: Record<string, string>; longText: string }> = [
    { route: "/customers", find: (p) => p.getByRole("row").filter({ hasText: LONG_EMAIL() }), captions: { Name: "Name", Email: "Email", Phone: "Phone", Address: "Address" }, longText: LONG_EMAIL() },
    { route: "/sales-orders", find: (p) => p.getByRole("row").filter({ hasText: SO() }), captions: { "SO Ref": "SO Ref", Customer: "Customer", Status: "Status" }, longText: COMPANY_120() },
    { route: "/purchase-orders", find: (p) => p.getByRole("row").filter({ hasText: PO() }), captions: { "PO Ref": "PO Ref", Supplier: "Supplier", "Total (inc VAT)": "Total (inc VAT)" }, longText: COMPANY_120() },
    { route: "/invoices", find: (p) => p.getByRole("row").filter({ hasText: COMPANY_120() }), captions: { Customer: "Customer", Status: "Status", Amount: "Amount" }, longText: COMPANY_120() },
    { route: "/delivery-notes", find: (p) => p.getByRole("row").filter({ hasText: DN() }), captions: { "DN Ref": "DN Ref", Customer: "Customer", Status: "Status" }, longText: COMPANY_120() },
    { route: "/suppliers", find: (p) => p.getByRole("row").filter({ hasText: LONG_EMAIL() }), captions: { Name: "Name", Email: "Email", Notes: "Notes" }, longText: LONG_EMAIL() },
  ];
  for (const viewport of [PHONE, TABLET, DESKTOP]) {
    const { context, page } = await device(browser, viewport);
    await signIn(page, alpha().users.admin);
    for (const item of rows) {
      const where = `${item.route} @${viewport.width}`;
      await visit(page, item.route);
      const row = item.find(page).first();
      await expect(row, where).toBeVisible();
      for (const label of Object.values(item.captions)) {
        const cell = row.locator(`td[data-label="${label}"]`);
        const caption = await captionOf(cell);
        if (viewport.name === "desktop") expect(caption.display, `${where}: ${label} caption stays hidden beside a header row`).toBe("none");
        else {
          expect(caption.content, `${where}: ${label} caption text`).toBe(`"${label}"`);
          expect(caption.display, `${where}: ${label} caption shown`).toBe("block");
        }
      }
      if (viewport.name === "desktop") {
        await expect(page.locator("thead").first(), where).toBeVisible();
        continue;
      }
      await expect(page.locator("thead").first(), `${where}: stacked, no header row`).toBeHidden();
      // The long value is wrapped inside the record, not running past it or the screen.
      const fits = await row.evaluate((el, long) => {
        const record = el.getBoundingClientRect();
        const cell = [...el.querySelectorAll("td")].find((td) => (td.textContent ?? "").includes(long.slice(0, 40)));
        const r = cell?.getBoundingClientRect();
        return { found: Boolean(cell), recordRight: record.right, screen: document.documentElement.clientWidth, cellRight: r?.right ?? 0, cellScroll: cell ? cell.scrollWidth - cell.clientWidth : 0 };
      }, item.longText);
      expect(fits.found, `${where}: long value shown`).toBe(true);
      expect(fits.cellRight, `${where}: long value inside the record`).toBeLessThanOrEqual(fits.recordRight + 1);
      expect(fits.recordRight, `${where}: record inside the screen`).toBeLessThanOrEqual(fits.screen + 1);
      expect(fits.cellScroll, `${where}: long value not clipped`).toBeLessThanOrEqual(1);
      // Touched controls on a record are >= 44px.
      const first = row.getByRole("button").first();
      await expectTarget(`${viewport.name}/admin ${item.route}`, "record button", first, 44, 44);
    }
    // Job cards (phone, and the Cards choice): captioned values.
    if (viewport.name === "phone") {
      await visit(page, "/jobs");
      const card = page.locator(`[data-testid="job-card"][data-job-no="${JOB()}"]:visible`);
      for (const caption of ["Customer", "Description", "Stage", "Due", "Started", "Finished"]) await expect(card.locator("dt", { hasText: caption }), `job card ${caption}`).toBeVisible();
      await expect(card).toContainText(COMPANY_120());
      await expect(card).toContainText(DESCRIPTION_240());
    }
    await context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Nine screenshots: ADMIN / OFFICE / WORKSHOP x 390x844, 820x1180, 1280x800 (entry screen with the shell + a detail)
// ---------------------------------------------------------------------------------------------------------------------

test("screenshots: the shell with a quote detail open, for each role at phone, tablet and desktop widths", async ({ browser }) => {
  const roles = [["admin", alpha().users.admin], ["office", alpha().users.office], ["workshop", alpha().users.workshop]] as const;
  for (const [role, user] of roles) {
    for (const viewport of [PHONE, TABLET, DESKTOP]) {
      const { context, page } = await device(browser, viewport);
      await signIn(page, user);
      const where = `${role} @${viewport.width}`;
      let detail: Locator;
      if (role === "workshop") {
        // The workshop view has no quotes (the page is for admin and office): its entry screen is the Job Board, and the
        // detail is the job worksheet.
        await visit(page, "/jobs");
        await press(page, jobEntry(page).first().getByRole("button", { name: "Worksheet" }));
        detail = page.getByRole("dialog", { name: `Worksheet - ${JOB()}` });
        await expect(detail).toBeVisible();
      } else {
        detail = await openQuote(page);
      }
      // The shell is on screen: a top bar chip with the drawer behind it, or the fixed sidebar.
      if (viewport.width <= 1024) await expect(page.getByTestId("shell-status"), where).toBeVisible();
      else await expect(sidebar(page), where).toBeVisible();
      await expectDialogFits(page, detail, `${where} detail`);
      await noSidewaysScroll(page, `${where} detail`);
      shots.push(await saveScreenshot(page, role, viewport, role === "workshop" ? "job-board-worksheet" : "quote-detail"));
      await context.close();
    }
  }
  expect(shots).toHaveLength(9);
});
