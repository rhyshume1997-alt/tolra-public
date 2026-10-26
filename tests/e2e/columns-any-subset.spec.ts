/**
 * Columns, any subset (Rhys, Fri 23 Oct): for every table-shaped page in the ROUTES allow-list below (a subset of COLUMN_TABLES), the header
 * labels and the cells agree under any Columns selection, in Cards, List and Table, at 390, 768 and 1280.
 *
 * It iterates the allow-list (route + SEED row required), so a new screen needs an explicit entry in both. Per table and width, on one signed-in page and with no sleeps:
 *   - everything ticked: header texts == the definition's labels in order, header count == cell count on every row, and each cell's
 *     own label (the Cards' labelled fields) walks the same order; Quotes' Cards show the labelled fields under the card title;
 *   - an every-second-column subset unticked through the page's Columns button: headers and cells go together, counts still equal,
 *     order kept, the locked columns (selection box, Actions) still there; the choice survives a reload;
 *   - Reset to default brings every column back.
 * The page never scrolls sideways, and a table's own scroll container reaches its last header.
 * Offered views: the switcher is hidden on phones (390 = the stacked cards every page shows), and Table is offered above 1024px only.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { COLUMN_TABLES, type TableDef } from "@/lib/org-settings";
import { resetColumns, setColumnTicks, signIn, world } from "./helpers";

const w = world();

/**
 * Only the screens this spec can drive today: an explicit allow-list of table key -> route. Each must also have a SEED row below
 * (a table without one is skipped, never run against an empty page). COLUMN_TABLES also holds hours, approvals, rfq, schedule and
 * dashboard (other layouts, other routes, no seed rows, a differently named picker button) and the Job Board (its own spec): add one
 * here only with its route, a SEED entry and a picker this spec can drive.
 */
const ROUTES: Record<string, string> = { quotes: "/quotes", "sales-orders": "/sales-orders", "purchase-orders": "/purchase-orders", invoices: "/invoices", "delivery-notes": "/delivery-notes", customers: "/customers", suppliers: "/suppliers" };
const WIDTHS = [390, 768, 1280] as const;
const VIEWS = ["Cards", "List", "Table"] as const;
type View = (typeof VIEWS)[number];

/** Cards that show the ref as the card title rather than a labelled field (Quotes). */
const TITLE_COLUMN: Record<string, string> = { quotes: "Quote" };

/** One row per page in the Open phase, so there is something to show. A table without an entry relies on rows already in the tenant. */
const SEED: Record<string, (org: string, tag: string) => Record<string, unknown> & { table: string }> = {
  quotes: (organization_id, tag) => ({ table: "quotes", organization_id, quote_ref: `QUO-CAS-${tag}`, customer: "Subset Co", description: "Subset check", total_value: 1234, status: "sent", valid_until: "2099-12-31" }),
  "sales-orders": (organization_id, tag) => ({ table: "sales_orders", organization_id, so_number: `SO-CAS-${tag}`, customer: "Subset Co" }),
  "purchase-orders": (organization_id, tag) => ({ table: "purchase_orders", organization_id, po_ref: `PO-CAS-${tag}`, po_number: `PO-CAS-${tag}`, supplier: "Subset Supplies" }),
  invoices: (organization_id) => ({ table: "invoices", organization_id, customer: "Subset Co", status: "draft" }),
  "delivery-notes": (organization_id, tag) => ({ table: "delivery_notes", organization_id, dn_number: `DLN-CAS-${tag}`, customer: "Subset Co", status: "pending" }),
  customers: (organization_id, tag) => ({ table: "customers", organization_id, name: `Subset Customer ${tag}`, phone: "0123 456789" }),
  suppliers: (organization_id, tag) => ({ table: "suppliers", organization_id, name: `Subset Supplier ${tag}`, email: "subset@example.test", reliability_status: "good" }),
};

/** The allow-list, and only those with a seed row. */
const TABLES = COLUMN_TABLES.filter((table) => table.key in ROUTES && table.key in SEED);

type Snap = {
  table: boolean;
  headers: string[];
  headerCount: number;
  lastHeader: string;
  rowCells: number[];
  rowLabels: string[][];
  cardFields: string[][];
  pageOverflow: boolean;
  reachesLast: boolean | null;
};

/** What is on screen now: the visible table (Cards / List / Table) or, with none, the Quotes cards' labelled fields. */
function snapshot(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const shown = (el: Element) => Boolean((el as HTMLElement).offsetParent);
    const text = (el: Element) => (el.textContent ?? "").trim();
    const table = Array.from(document.querySelectorAll('table[data-view], table[aria-label="Quotes"]')).find(shown);
    const pageOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    if (!table) {
      const cardFields = Array.from(document.querySelectorAll('section[aria-label$=" quotes"] dl')).filter(shown).map((dl) => Array.from(dl.querySelectorAll("dt")).map(text));
      return { table: false, headers: [], headerCount: 0, lastHeader: "", rowCells: [], rowLabels: [], cardFields, pageOverflow, reachesLast: null };
    }
    const ths = Array.from(table.querySelectorAll("thead th"));
    const rows = Array.from(table.querySelectorAll("tbody tr")).filter((tr) => !tr.querySelector("td[colspan]"));
    let reachesLast: boolean | null = null;
    const head = table.querySelector("thead");
    if (head && ths.length && getComputedStyle(head).display !== "none") {
      const box = table.parentElement as HTMLElement;
      box.scrollLeft = box.scrollWidth;
      reachesLast = ths[ths.length - 1].getBoundingClientRect().right <= box.getBoundingClientRect().right + 1;
    }
    return {
      table: true,
      headers: ths.map(text).filter((label) => label && label !== "Actions"),
      headerCount: ths.length,
      lastHeader: ths.length ? text(ths[ths.length - 1]) : "",
      rowCells: rows.map((tr) => tr.querySelectorAll(":scope > td").length),
      rowLabels: rows.map((tr) => Array.from(tr.querySelectorAll(":scope > td[data-label]")).map((td) => td.getAttribute("data-label") ?? "")),
      cardFields: [],
      pageOverflow,
      reachesLast,
    };
  });
}

/** Everything wrong with what is on screen, given the labels that should be showing. Empty means it agrees. */
function problems(snap: Snap, tableKey: string, shown: string[], locked: number | null): string[] {
  const out: string[] = [];
  if (snap.pageOverflow) out.push("page scrolls sideways");
  if (snap.table) {
    if (!snap.rowCells.length) out.push("no rows");
    if (JSON.stringify(snap.headers) !== JSON.stringify(shown)) out.push(`headers ${JSON.stringify(snap.headers)} != ${JSON.stringify(shown)}`);
    if (snap.lastHeader !== "Actions") out.push(`last header is "${snap.lastHeader}", not Actions`);
    if (locked !== null && snap.headerCount - snap.headers.length !== locked) out.push(`locked columns ${snap.headerCount - snap.headers.length} != ${locked}`);
    snap.rowCells.forEach((cells, i) => {
      if (cells !== snap.headerCount) out.push(`row ${i}: ${cells} cells for ${snap.headerCount} headers`);
      const labels = snap.rowLabels[i];
      if (labels.length && JSON.stringify(labels) !== JSON.stringify(shown)) out.push(`row ${i}: cell labels ${JSON.stringify(labels)} != ${JSON.stringify(shown)}`);
    });
    if (snap.reachesLast === false) out.push("table's scroll container does not reach the last header");
  } else {
    const fields = shown.filter((label) => label !== TITLE_COLUMN[tableKey]);
    if (!snap.cardFields.length) out.push("no cards");
    snap.cardFields.forEach((captions, i) => { if (JSON.stringify(captions) !== JSON.stringify(fields)) out.push(`card ${i}: fields ${JSON.stringify(captions)} != ${JSON.stringify(fields)}`); });
  }
  return out;
}

/** Locked columns are listed in the picker, ticked and disabled (they cannot be hidden). */
async function expectLockedDisabled(page: Page, labels: string[]) {
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  for (const label of labels) {
    const item = menu.getByRole("menuitemcheckbox", { name: label, exact: true });
    await expect(item).toHaveAttribute("aria-checked", "true");
    await expect(item).toHaveAttribute("aria-disabled", "true");
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

const labelsOf = (table: TableDef, hidden: Set<string>) => table.columns.filter((column) => !hidden.has(column.key)).map((column) => column.label);

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  const org = w.tenants.alpha.id;
  const tag = w.runId.slice(0, 6);
  for (const table of TABLES) {
    const seed = SEED[table.key]?.(org, tag);
    if (!seed) continue;
    const { table: name, ...row } = seed;
    expect((await adminClient().from(name).insert(row)).error, `seed ${table.key}`).toBeNull();
  }
  page = await browser.newPage();
  await signIn(page, w.tenants.alpha.users.admin);
});

test.afterAll(async () => { await page.close(); });

for (const table of TABLES) {
  for (const width of WIDTHS) {
    test(`${table.label} @${width}: headers and cells agree under any Columns selection`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(ROUTES[table.key]);
      const switcher = page.getByRole("group", { name: "View" });
      const all = labelsOf(table, new Set());
      const subset = table.columns.filter((column, i) => i % 2 === 1 && !column.locked); // every second column; locked ones are in the picker (ticked, disabled) and never unticked
      const hidden = new Set(subset.map((column) => column.key));
      const some = labelsOf(table, hidden);
      expect(subset.length, `${table.key} has columns to untick`).toBeGreaterThan(0);

      // Phones have no switcher (stacked cards); the Table button exists above 1024px only.
      const views: Array<View | null> = (await switcher.isVisible()) ? VIEWS.filter((view) => view !== "Table" || width > 1024) : [null];
      await resetColumns(page, all);
      await expectLockedDisabled(page, table.columns.filter((column) => column.locked).map((column) => column.label));
      let reloaded = false;
      let locked: number | null = null;

      for (const view of views) {
        if (view) {
          await page.getByRole("group", { name: "View" }).getByRole("button", { name: view, exact: true }).click();
          await expect(page.getByRole("group", { name: "View" }).getByRole("button", { name: view, exact: true })).toHaveAttribute("aria-pressed", "true");
        }
        const where = `${table.key} ${view ?? "phone"} @${width}`;

        await expect.poll(async () => problems(await snapshot(page), table.key, all, locked), { message: `${where}: all ticked` }).toEqual([]);
        const first = await snapshot(page);
        if (first.table && locked === null) locked = first.headerCount - first.headers.length;

        await setColumnTicks(page, subset.map((column) => [column.label, false] as [string, boolean]));
        await expect.poll(async () => problems(await snapshot(page), table.key, some, locked), { message: `${where}: subset unticked` }).toEqual([]);

        if (!reloaded) {
          reloaded = true;
          await page.reload();
          if (view) await expect(page.getByRole("group", { name: "View" }).getByRole("button", { name: view, exact: true })).toHaveAttribute("aria-pressed", "true");
          await expect.poll(async () => problems(await snapshot(page), table.key, some, locked), { message: `${where}: subset survives a reload` }).toEqual([]);
        }

        await resetColumns(page, all);
        await expect.poll(async () => problems(await snapshot(page), table.key, all, locked), { message: `${where}: reset restores every column` }).toEqual([]);
      }
    });
  }
}
