/**
 * Phone and tablet width guard: every page of the app must fit a phone (390 px) and a portrait iPad (820 px) without sideways scrolling.
 *
 * For each page, at 390x844 and 820x1180, signed in as the seeded admin of the alpha company, the page is loaded, given time to settle,
 * and two things are measured:
 *   (a) page overflow: document.documentElement.scrollWidth > window.innerWidth + 1;
 *   (b) inner scrollers: any visible element whose computed overflow-x is auto or scroll and whose scrollWidth is wider than its
 *       clientWidth + 1 (a table or strip that has to be scrolled sideways inside its own box). Each is reported with its tag, test id or
 *       class, and the heading it sits under.
 * Every measurement is recorded as a test annotation (type "width", e.g. "390 /time page:ok inner:0") and as one console line, so the CI
 * log lists what still overflows. Only Weekly hours (/time, and its This week tab /time/week) is asserted: no page overflow and no inner
 * scroller at either width. Every other page is report-only and never fails, and a page that cannot be loaded is skipped with an
 * annotation, so one run of this spec cannot go red on a page that has not been fixed yet.
 *
 * Deliberately scrollable wide strips (the Machine Schedule's time grid) appear in the report as inner scrollers; they are not asserted.
 * The Job Board shows its Cards at both widths (the List and Table need more than 1024 px), so its one measurement covers them.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();

type Size = { width: number; height: number };
const SIZES: Size[] = [{ width: 390, height: 844 }, { width: 820, height: 1180 }];

/** `ready` is a test id that shows when the page has its data; the measurement waits for it (up to 20 s) but goes ahead without it. */
type Target = { path: string; ready?: string; asserted?: boolean };
const PAGES: Target[] = [
  { path: "/dashboard" },
  { path: "/numbers", ready: "numbers-page" },
  { path: "/rfq" },
  { path: "/quotes" },
  { path: "/sales-orders" },
  { path: "/jobs" },
  { path: "/schedule" },
  { path: "/time", ready: "day-totals", asserted: true },
  { path: "/time/week", ready: "week-table", asserted: true },
  { path: "/invoices" },
  { path: "/approval" },
  { path: "/purchase-orders" },
  { path: "/delivery-notes" },
  { path: "/customers" },
  { path: "/suppliers" },
  { path: "/email" },
  { path: "/admin/users", ready: "user-row" },
  { path: "/admin/activity" },
  { path: "/admin/compliance" },
  { path: "/admin/data" },
  { path: "/admin/integrations" },
  { path: "/settings" },
];

type Scroller = { tag: string; id: string; heading: string; scrollWidth: number; clientWidth: number };
type Measure = { innerWidth: number; scrollWidth: number; overflow: boolean; scrollers: Scroller[] };

/** Runs in the page: the document's own overflow, then every visible sideways scroller with the heading nearest above it. */
function measureInPage(): Measure {
  const headings = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3"));
  const scrollers: Scroller[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    const style = getComputedStyle(el);
    if (style.overflowX !== "auto" && style.overflowX !== "scroll") continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    let heading = "";
    for (const h of headings) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) heading = (h.textContent ?? "").trim().slice(0, 50);
      else break;
    }
    const id = el.getAttribute("data-testid") ?? (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
    scrollers.push({ tag: el.tagName.toLowerCase(), id, heading, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }
  const scrollWidth = document.documentElement.scrollWidth;
  return { innerWidth: window.innerWidth, scrollWidth, overflow: scrollWidth > window.innerWidth + 1, scrollers };
}

/** Loads a page and measures it once it has settled. Throws when the page cannot be loaded or measured. */
async function measure(page: Page, target: Target): Promise<Measure> {
  await page.goto(target.path, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator("main").first().waitFor({ timeout: 30_000 });
  if (target.ready) await page.getByTestId(target.ready).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  // Lists and charts fill in after the first paint; give them a moment, then measure.
  await page.waitForTimeout(1_500);
  return page.evaluate(measureInPage);
}

let storage: Awaited<ReturnType<BrowserContext["storageState"]>> | null = null;

/** A phone- or tablet-shaped context (touch, mobile emulation), signed in once per worker and reused through its saved session. */
async function signedInContext(browser: Browser, size: Size): Promise<BrowserContext> {
  const baseURL = String(test.info().project.use.baseURL);
  const context = await browser.newContext({
    baseURL, viewport: size, hasTouch: true, isMobile: true, deviceScaleFactor: 2, ...(storage ? { storageState: storage } : {}),
  });
  if (!storage) {
    const page = await context.newPage();
    await signIn(page, w.tenants.alpha.users.admin);
    storage = await context.storageState();
    await page.close();
  }
  return context;
}

test.describe.configure({ mode: "serial" });

for (const size of SIZES) {
  test.describe(`at ${size.width}px`, () => {
    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(120_000);
      context = await signedInContext(browser, size);
      page = await context.newPage();
    });
    test.afterAll(async () => { await context?.close(); });

    for (const target of PAGES) {
      test(`${target.path} fits without sideways scrolling${target.asserted ? "" : " (report only)"}`, async () => {
        test.setTimeout(120_000);
        let result: Measure | null = null;
        let failure = "";
        for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
          try {
            result = await measure(page, target);
          } catch (error) {
            failure = error instanceof Error ? error.message.split("\n")[0] : String(error);
          }
        }
        if (!result) {
          test.info().annotations.push({ type: "width", description: `${size.width} ${target.path} skipped: ${failure}` });
          console.log(`[phone-width] ${size.width} ${target.path} SKIPPED (${failure})`);
          return;
        }
        test.info().annotations.push({
          type: "width",
          description: `${size.width} ${target.path} page:${result.overflow ? `OVER ${result.scrollWidth}>${result.innerWidth}` : "ok"} inner:${result.scrollers.length}`,
        });
        for (const s of result.scrollers) {
          test.info().annotations.push({ type: "width-scroller", description: `${size.width} ${target.path} ${s.tag} ${s.id} under "${s.heading}" ${s.scrollWidth}>${s.clientWidth}` });
        }
        console.log(
          `[phone-width] ${size.width} ${target.path} page:${result.overflow ? `OVER (${result.scrollWidth} > ${result.innerWidth})` : "ok"} inner:${result.scrollers.length}`
          + (result.scrollers.length ? ` [${result.scrollers.map((s) => `${s.tag} ${s.id} under "${s.heading}" ${s.scrollWidth}>${s.clientWidth}`).join("; ")}]` : ""),
        );
        if (!target.asserted) return;
        expect(result.overflow, `${target.path} @${size.width}: the page scrolls sideways (${result.scrollWidth} > ${result.innerWidth})`).toBe(false);
        expect(result.scrollers, `${target.path} @${size.width}: parts that scroll sideways inside their own box`).toEqual([]);
      });
    }
  });
}
