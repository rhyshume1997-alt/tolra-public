/**
 * Job Board columns: the headers and the cells always agree, and the Columns picker drives all three views (Rhys, Fri 23 Oct).
 *
 * Table / List: header cell count == body cell count on every row (checkbox included); header texts == the ticked picker list in
 * Astra's order. Cards: the field labels in that order. Unticking Started and Finished removes header and cells together and re-ticking
 * restores them; a deterministic subset (every second unlockable column) leaves the counts equal with Job No, Due and Actions always
 * present; Reset to default; the choice survives a reload; the table's own scroll container scrolled to its right end shows the last
 * header (Actions) at the same top as the first; the page never scrolls sideways.
 *
 * Widths: tables exist at 1280 and 1523 px. Phones (< 768) always show Cards and from 768 to 1024 px a chosen Table is shown as Cards,
 * so at 390 and 768 the Table case asserts that fallback (and the Cards labels) instead. The view is chosen at 1280 px, then the window
 * is resized. Every test that changes the picker puts it back (Reset to default, clicked only when something is hidden) in a finally.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import { adminClient, createSoloTenant, type SyntheticUser } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
// Its own company (Verifier, 23 Oct): this file saves Job Board column choices (organization_settings.hidden_columns.jobs), so it
// never runs on the shared test companies, where another spec could see a hidden column (or one left hidden after a crash).
let org = "";
let soloAdmin: SyntheticUser;

/** Astra's order (lib/job-board-files.ts JOB_TABLE_COLUMNS), everything ticked. */
const ALL = ["Job No", "Customer", "Description", "Specification", "Drawings", "Attachments", "Stage", "Machine", "Operator", "Due", "Started", "Finished", "Inspection", "Actions"];
/** Locked in the picker (contract): ticked and cannot be unticked. */
const LOCKED = ["Job No", "Due", "Actions"];
/** Cards stack the Job No in the card's title and put the buttons below the fields, so those two are not labelled fields (Due is). */
const CARD_FIELDS = (labels: string[]) => labels.filter((label) => label !== "Job No" && label !== "Actions");
const WIDTHS = [390, 768, 1280, 1523];
const TABLE_WIDTHS = [1280, 1523];

type View = "Cards" | "List" | "Table";

/** Selectors: CONTRACT (HEADINGS-CONTRACT.md): Columns button, menuitemcheckbox items, "Reset to default" menuitem, data-disabled locks, table-container, card dt. */
const SEL = {
  columnsButton: (page: Page) => page.getByRole("button", { name: "Columns", exact: true }),
  menu: (page: Page) => page.getByRole("menu"),
  item: (menu: Locator, label: string) => menu.getByRole("menuitemcheckbox", { name: label, exact: true }),
  items: (menu: Locator) => menu.getByRole("menuitemcheckbox"),
  reset: (menu: Locator) => menu.getByRole("menuitem", { name: /Reset to default/i }),
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const admin = adminClient();
  // A fresh label per worker start: a retried worker re-runs beforeAll, and a company's slug and admin email must be new.
  const solo = await createSoloTenant(w.runId, `jbcols${Date.now().toString(36)}`);
  org = solo.id;
  soloAdmin = solo.admin;
  for (const key of ["a", "b"]) {
    const jobNo = `J-CC${key.toUpperCase()}-${w.runId}`;
    const found = (await admin.from("jobs").select("id").eq("organization_id", org).eq("job_no", jobNo).maybeSingle()).data;
    if (!found) {
      const { error } = await admin.from("jobs").insert({ organization_id: org, job_no: jobNo, customer: "Columns Co", description: `Columns ${key}`, specification: "Spec 316 polish", due_date: "2026-12-01" });
      expect(error).toBeNull();
    }
  }
});

/** Chooses the view at 1280 px (the switcher is hidden on phones), then resizes. Returns what the width really shows. */
async function openView(page: Page, width: number, view: View): Promise<"cards" | "list" | "table"> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/jobs");
  const choice = page.getByRole("group", { name: "View" }).getByRole("button", { name: view, exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width, height: 900 });
  return settle(page, width, view);
}

/** What `view` shows at `width`, waited for. */
async function settle(page: Page, width: number, view: View): Promise<"cards" | "list" | "table"> {
  const shown = width < 768 ? "cards" : view === "Table" && width <= 1024 ? "cards" : (view.toLowerCase() as "cards" | "list" | "table");
  if (shown === "cards") {
    await expect(page.locator('[data-testid="job-card"]:visible').first()).toBeVisible();
    await expect(page.locator("table:visible")).toHaveCount(0);
  } else {
    await expect(page.locator("table:visible").first()).toBeVisible();
    await expect(page.locator("tbody tr:visible").first()).toBeVisible();
  }
  return shown;
}

async function openMenu(page: Page) {
  const menu = SEL.menu(page);
  if (!(await menu.isVisible())) {
    await expect(SEL.columnsButton(page)).toBeEnabled(); // disabled until the saved columns load
    await SEL.columnsButton(page).click();
  }
  await expect(menu).toBeVisible();
  return menu;
}
async function closeMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(SEL.menu(page)).toHaveCount(0);
}

/** Ticks or unticks one picker item and waits for the check mark to follow. */
async function tick(page: Page, label: string, on: boolean) {
  const menu = await openMenu(page);
  const item = SEL.item(menu, label);
  if ((await item.getAttribute("aria-checked")) === String(on)) return;
  await item.click();
  await expect(item).toHaveAttribute("aria-checked", String(on));
}

/**
 * Back to the default (everything ticked). Reset to default is disabled while nothing is hidden (components/column-toggle.tsx
 * `disabled={!hidden.length}`), so it is clicked only when an item is unticked; otherwise the test asserts it is disabled. Either way
 * every item ends ticked and Reset ends disabled (CI run 40098816693: an unconditional click timed out on the disabled item).
 */
async function resetColumns(page: Page) {
  const menu = await openMenu(page);
  await expect(SEL.items(menu)).toHaveCount(ALL.length);
  const states = await SEL.items(menu).evaluateAll((items) => items.map((item) => item.getAttribute("aria-checked")));
  if (states.some((state) => state !== "true")) {
    await expect(SEL.reset(menu)).toBeEnabled();
    await SEL.reset(menu).click();
  }
  for (const label of ALL) await expect(SEL.item(menu, label)).toHaveAttribute("aria-checked", "true");
  await expect(SEL.reset(menu), "Reset to default is disabled once nothing is hidden").toBeDisabled();
  await closeMenu(page);
}

/**
 * Runs `action` (one picker change) and waits for its save to reach the server. A change shows at once but is saved after it, in a
 * queue (lib/org-settings.ts enqueue -> persistChange: read the row, then upsert it), and the page load reads the server row first,
 * so a reload before the upsert answers drops the change (CI run 40107098185, test 18). Waits for the upsert's own response and
 * checks it succeeded (a refused save would be undone on screen); no sleep.
 */
async function savedToServer(page: Page, action: () => Promise<void>) {
  const upsert = page.waitForResponse((response) => response.url().includes("/rest/v1/organization_settings") && response.request().method() === "POST");
  await action();
  const response = await upsert;
  expect(response.ok(), `organization_settings save answered ${response.status()}`).toBe(true);
}

/** The picker list as shown, in order. */
async function pickerLabels(page: Page): Promise<string[]> {
  const menu = await openMenu(page);
  const labels = (await SEL.items(menu).allInnerTexts()).map((text) => text.trim());
  await closeMenu(page);
  return labels;
}

/** Header cell texts of the table on screen (the checkbox and the sr-only "Details" cell are not headings). */
async function headerTexts(page: Page): Promise<string[]> {
  const texts = await page.locator("table:visible").first().locator("thead th").allTextContents();
  return texts.map((text) => text.trim()).filter((text) => text && text !== "Details");
}

/** Column span totals: the header row and every body row, group and detail rows included (a full-width row counts its span). */
async function cellCounts(page: Page) {
  return page.locator("table:visible").first().evaluate((table) => {
    const span = (row: Element) => Array.from(row.children).reduce((sum, cell) => sum + ((cell as HTMLTableCellElement).colSpan || 1), 0);
    return {
      header: span(table.querySelector("thead tr")!),
      rows: Array.from(table.querySelectorAll("tbody tr")).map((row) => ({ text: (row.textContent ?? "").trim().slice(0, 30), cells: span(row) })),
    };
  });
}

async function expectCountsEqual(page: Page, at: string) {
  const counts = await cellCounts(page);
  expect(counts.rows.length, `${at}: body rows`).toBeGreaterThan(0);
  expect(counts.rows.filter((row) => row.cells !== counts.header), `${at}: body rows whose cell count differs from the ${counts.header} headers`).toEqual([]);
  return counts.header;
}

async function expectNoSidewaysPage(page: Page, at: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${at}: the page scrolls sideways`).toBe(true);
}

/** The card field labels (dt) of the first card on screen. */
async function cardLabels(page: Page): Promise<string[]> {
  return (await page.locator('[data-testid="job-card"]:visible').first().locator("dt").allTextContents()).map((text) => text.trim());
}

/** Every second unlockable column, starting with the first unlockable one (Customer, Specification, Attachments, Machine, Started, Inspection). */
const subset = ALL.filter((label) => !LOCKED.includes(label)).filter((_, index) => index % 2 === 0);
const without = (labels: string[], gone: string[]) => labels.filter((label) => !gone.includes(label));

test.describe("Job Board columns count", () => {
  test("the picker lists Astra's columns in order, all ticked, Job No, Due and Actions locked", async ({ page }) => {
    await signIn(page, soloAdmin);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/jobs");
    await expect(SEL.columnsButton(page)).toBeVisible();
    await resetColumns(page);
    expect(await pickerLabels(page)).toEqual(ALL);
    const menu = await openMenu(page);
    for (const label of ALL) await expect(SEL.item(menu, label), `${label} ticked`).toHaveAttribute("aria-checked", "true");
    for (const label of LOCKED) await expect(SEL.item(menu, label), `${label} cannot be unticked`).toHaveAttribute("data-disabled", "");
    for (const label of without(ALL, LOCKED)) await expect(SEL.item(menu, label), `${label} can be unticked`).not.toHaveAttribute("data-disabled", "");
    await closeMenu(page);
  });

  for (const width of WIDTHS) {
    test(`Table at ${width}px: header cells == body cells on every row, headers in Astra's order${TABLE_WIDTHS.includes(width) ? "" : " (Table falls back to Cards here)"}`, async ({ page }) => {
      await signIn(page, soloAdmin);
      const shown = await openView(page, width, "Table");
      await expectNoSidewaysPage(page, `table@${width}`);
      if (shown === "cards") {
        expect(width, "only 1280 and 1523 show the Table").toBeLessThan(1280);
        expect(CARD_FIELDS(await cardLabels(page)).filter((label) => ALL.includes(label)), `table@${width}: Cards labels in order`).toEqual(CARD_FIELDS(ALL));
        return;
      }
      expect(shown).toBe("table");
      await resetColumns(page);
      const header = await expectCountsEqual(page, `table@${width}`);
      expect(header, "checkbox column + 14 columns").toBe(ALL.length + 1);
      expect(await headerTexts(page), `table@${width}: header texts`).toEqual(ALL);
    });
  }

  for (const width of WIDTHS) {
    test(`List at ${width}px: header cells == body cells, Started and Finished present, in order${width < 768 ? " (phones show Cards)" : ""}`, async ({ page }) => {
      await signIn(page, soloAdmin);
      const shown = await openView(page, width, "List");
      await expectNoSidewaysPage(page, `list@${width}`);
      if (shown === "cards") {
        expect(CARD_FIELDS(await cardLabels(page)).filter((label) => ALL.includes(label)), `list@${width}: Cards labels in order`).toEqual(CARD_FIELDS(ALL));
        return;
      }
      await resetColumns(page);
      await expectCountsEqual(page, `list@${width}`);
      const texts = await headerTexts(page);
      expect(texts, `list@${width}: header texts`).toEqual(ALL);
      expect(texts).toEqual(expect.arrayContaining(["Started", "Finished"]));
    });
  }

  for (const width of WIDTHS) {
    test(`Cards at ${width}px: field labels in Astra's order, no sideways page scroll`, async ({ page }) => {
      await signIn(page, soloAdmin);
      await openView(page, width, "Cards");
      await expectNoSidewaysPage(page, `cards@${width}`);
      expect(CARD_FIELDS(await cardLabels(page)).filter((label) => ALL.includes(label)), `cards@${width}: labels`).toEqual(CARD_FIELDS(ALL));
    });
  }

  for (const view of ["Table", "List"] as const) {
    test(`${view}: unticking Started and Finished removes header and cells together; re-ticking restores them`, async ({ page }) => {
      await signIn(page, soloAdmin);
      await openView(page, 1280, view);
      try {
        await resetColumns(page);
        const before = await expectCountsEqual(page, `${view} all`);
        await tick(page, "Started", false);
        await tick(page, "Finished", false);
        await closeMenu(page);
        await expect(page.getByRole("columnheader", { name: "Started", exact: true })).toHaveCount(0);
        await expect(page.getByRole("columnheader", { name: "Finished", exact: true })).toHaveCount(0);
        expect(await headerTexts(page), `${view}: headers without Started and Finished`).toEqual(without(ALL, ["Started", "Finished"]));
        expect(await expectCountsEqual(page, `${view} without Started and Finished`), "two cells fewer on the header row").toBe(before - 2);
        await tick(page, "Started", true);
        await tick(page, "Finished", true);
        await closeMenu(page);
        expect(await headerTexts(page), `${view}: headers restored`).toEqual(ALL);
        expect(await expectCountsEqual(page, `${view} restored`)).toBe(before);
      } finally {
        await resetColumns(page);
      }
    });
  }

  for (const view of ["Table", "List"] as const) {
    test(`${view}: every second unlockable column unticked, counts equal, Job No, Due and Actions stay`, async ({ page }) => {
      await signIn(page, soloAdmin);
      await openView(page, 1280, view);
      try {
        await resetColumns(page);
        for (const label of subset) await tick(page, label, false);
        await closeMenu(page);
        const expected = without(ALL, subset);
        expect(expected).toEqual(expect.arrayContaining(LOCKED));
        await expect(page.getByRole("columnheader", { name: subset[0], exact: true })).toHaveCount(0);
        const texts = await headerTexts(page);
        expect(texts, `${view}: headers after unticking ${subset.join(", ")}`).toEqual(expected);
        for (const kept of LOCKED) expect(texts).toContain(kept);
        expect(texts[0]).toBe("Job No");
        expect(texts[texts.length - 1]).toBe("Actions");
        // Cells before the columns: Table has the select box; List has the select box and the Details chevron (app/(dashboard)/jobs/page.tsx).
        const leading = view === "List" ? 2 : 1;
        expect(await expectCountsEqual(page, `${view} subset`), `${view}: ${leading} leading cell(s) + ${expected.length} columns`).toBe(expected.length + leading);
        await expectNoSidewaysPage(page, `${view} subset`);
      } finally {
        await resetColumns(page);
      }
    });
  }

  test("Cards follow the ticked set; Reset to default brings everything back; the choice survives a reload", async ({ page }) => {
    await signIn(page, soloAdmin);
    await openView(page, 1280, "Table");
    try {
      await resetColumns(page);
      // Each untick is saved before the next (the queue runs one at a time), and both are on the server before the reload.
      await savedToServer(page, () => tick(page, "Started", false));
      await savedToServer(page, () => tick(page, "Finished", false));
      await closeMenu(page);
      await page.reload();
      await expect(page.locator("table:visible").first()).toBeVisible();
      expect(await headerTexts(page), "after a reload the unticked columns stay gone").toEqual(without(ALL, ["Started", "Finished"]));
      const menu = await openMenu(page);
      await expect(SEL.item(menu, "Started")).toHaveAttribute("aria-checked", "false");
      await expect(SEL.item(menu, "Finished")).toHaveAttribute("aria-checked", "false");
      await closeMenu(page);
      await expectCountsEqual(page, "table after reload");
      // Cards (same company setting) carry the same ticked set, in the same order.
      await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Cards", exact: true }).click();
      await expect(page.locator('[data-testid="job-card"]:visible').first()).toBeVisible();
      expect(CARD_FIELDS(await cardLabels(page)).filter((label) => ALL.includes(label)), "Cards labels without Started and Finished").toEqual(CARD_FIELDS(without(ALL, ["Started", "Finished"])));
      await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Table", exact: true }).click();
      await expect(page.locator("table:visible").first()).toBeVisible();
      // Something is hidden here, so resetColumns clicks Reset to default: one save, on the server before the reload.
      await savedToServer(page, () => resetColumns(page));
      expect(await headerTexts(page), "Reset to default").toEqual(ALL);
      await page.reload();
      await expect(page.locator("table:visible").first()).toBeVisible();
      expect(await headerTexts(page), "Reset to default survives a reload").toEqual(ALL);
    } finally {
      await resetColumns(page);
    }
  });

  for (const width of TABLE_WIDTHS) {
    test(`Table at ${width}px: scrolled to its right end the last header (Actions) has the first header's top; the page does not scroll`, async ({ page }) => {
      await signIn(page, soloAdmin);
      await openView(page, width, "Table");
      await resetColumns(page);
      await expectNoSidewaysPage(page, `table@${width} before scrolling`);
      // The table's own scroll container: the nearest ancestor that scrolls sideways.
      const table = page.locator("table:visible").first();
      const result = await table.evaluate(async (el) => {
        const box = el.closest<HTMLElement>('[data-slot="table-container"]');
        if (!box || !/(auto|scroll)/.test(getComputedStyle(box).overflowX)) return null;
        box.scrollLeft = box.scrollWidth;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const heads = Array.from(el.querySelectorAll("thead th")).filter((th) => (th.textContent ?? "").trim());
        const first = heads[0].getBoundingClientRect();
        const last = heads[heads.length - 1];
        const lastRect = last.getBoundingClientRect();
        const bounds = box.getBoundingClientRect();
        // Select box and Job No stay put while the rest scrolls (sticky, left offsets 0 and the select column's width).
        const all = Array.from(el.querySelectorAll<HTMLElement>("thead th"));
        const sticky = all.slice(0, 2).map((th) => ({ position: getComputedStyle(th).position, left: Math.round(th.getBoundingClientRect().left - bounds.left), width: Math.round(all[0].getBoundingClientRect().width) }));
        const jobNoInView = all[1].getBoundingClientRect().left >= bounds.left - 1 && all[1].getBoundingClientRect().right <= bounds.right + 1;
        return {
          sticky, jobNoInView, jobNoText: (all[1].textContent ?? "").trim(),
          scrollable: box.scrollWidth > box.clientWidth + 1,
          atEnd: Math.abs(box.scrollLeft + box.clientWidth - box.scrollWidth) <= 1,
          lastText: (last.textContent ?? "").trim(),
          firstTop: first.top,
          lastTop: lastRect.top,
          lastInside: lastRect.left >= bounds.left - 1 && lastRect.right <= bounds.right + 1,
          pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });
      expect(result, `table@${width}: the table sits in a sideways scroll container`).not.toBeNull();
      expect(result!.scrollable, `table@${width}: 14 columns overflow the container`).toBe(true);
      expect(result!.atEnd, `table@${width}: scrolled to the right end`).toBe(true);
      expect(result!.lastText).toBe("Actions");
      expect(Math.abs(result!.lastTop - result!.firstTop), `table@${width}: Actions top ${result!.lastTop} vs first header top ${result!.firstTop}`).toBeLessThanOrEqual(1);
      expect(result!.lastInside, `table@${width}: the Actions header is inside the container`).toBe(true);
      expect(result!.pageScrolls, `table@${width}: the page scrolled sideways`).toBe(false);
      expect(result!.sticky.map((cell) => cell.position), `table@${width}: select and Job No headers are sticky`).toEqual(["sticky", "sticky"]);
      expect(result!.sticky[0].left, `table@${width}: the select column stays at the container's left`).toBeLessThanOrEqual(1);
      expect(Math.abs(result!.sticky[1].left - result!.sticky[0].width), `table@${width}: Job No sits right after the select column`).toBeLessThanOrEqual(1);
      expect(result!.jobNoText).toBe("Job No");
      expect(result!.jobNoInView, `table@${width}: Job No is still in view at the right end`).toBe(true);
      await expect(page.getByRole("columnheader", { name: "Actions", exact: true })).toBeInViewport();
    });
  }
});
