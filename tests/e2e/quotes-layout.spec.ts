/**
 * Quotes table layout: every column header and the Status badge and Actions buttons stay fully inside their cells at the
 * widths people use (desktop 1280, 1024 and tablet 820), in the List view (and the Table view where it is offered, above 1024px).
 * The longest status word, "Superseded", is the case that used to spill out of the Status column.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function seedQuotes(tag: string, description = "Layout check") {
  const org = w.tenants.alpha.id;
  const customer = `Layout Co ${tag}`;
  expect((await adminClient().from("customers").insert({ organization_id: org, name: customer })).error).toBeNull();
  const admin = await signedInClient(w.tenants.alpha.users.admin);
  const ref = `QUO-LAY-${tag}`;
  const { data: quoteId, error } = await admin.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status: "sent", valid_until: "2099-12-31", description },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: [{ position: 0, description: "Shaft", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
  });
  expect(error).toBeNull();
  // Revising leaves v1 "superseded" (the longest status word) and v2 a draft.
  expect((await admin.rpc("revise_quote", { p_quote: quoteId })).error).toBeNull();
  return { ref, customer };
}

/** Everything the Quotes table shows must sit inside its own cell, and the table must never be wider than its card. */
async function expectFits(page: Page, label: string, ref: string) {
  const table = page.getByRole("table", { name: "Quotes" });
  await expect(table, label).toBeVisible();
  const problems = await table.evaluate((el, quoteRef) => {
    const out: string[] = [];
    const container = el.parentElement!;
    if (container.scrollWidth > container.clientWidth + 1) out.push(`table scrolls sideways (${container.scrollWidth} > ${container.clientWidth})`);
    for (const th of Array.from(el.querySelectorAll("thead th"))) {
      const name = th.textContent?.trim() || "(select all)";
      if (th.scrollWidth > th.clientWidth + 1) out.push(`header ${name}: ${th.scrollWidth} > ${th.clientWidth}`);
    }
    const heads = Array.from(el.querySelectorAll("thead th"));
    const column = (name: string) => heads.findIndex((th) => th.textContent?.trim() === name);
    for (const row of Array.from(el.querySelectorAll("tbody tr")).filter((tr) => tr.textContent?.includes(quoteRef))) {
      for (const name of ["Status", "Actions"]) {
        const cell = row.children[column(name)] as HTMLElement | undefined;
        if (!cell) { out.push(`no ${name} column`); continue; }
        if (cell.scrollWidth > cell.clientWidth + 1) out.push(`${name} cell: ${cell.scrollWidth} > ${cell.clientWidth}`);
        const edge = cell.getBoundingClientRect().right;
        for (const item of Array.from(cell.querySelectorAll('[data-slot="badge"], button'))) {
          const right = item.getBoundingClientRect().right;
          if (right > edge + 1) out.push(`${name} cell: ${item.textContent?.trim() || item.getAttribute("aria-label")} ends ${Math.round(right - edge)}px past its cell`);
        }
      }
    }
    return out;
  }, ref);
  expect(problems, label).toEqual([]);
}

test("Quotes table: every header, the Status badge (Superseded) and the Actions buttons fit at 1280, 1024 and 820", async ({ page }) => {
  const { ref } = await seedQuotes(w.runId);
  await signIn(page, w.tenants.alpha.users.admin);
  for (const [width, height] of [[1280, 800], [1024, 800], [820, 1100]]) {
    await page.setViewportSize({ width, height });
    await page.goto("/quotes");
    const views = width > 1024 ? ["List", "Table"] : ["List"]; // Table is offered only above 1024px
    for (const view of views) {
      await page.getByRole("button", { name: view, exact: true }).click();
      await expect(page.getByRole("button", { name: view, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("table", { name: "Quotes" }).getByRole("row").filter({ hasText: ref }).first()).toBeVisible();
      await expectFits(page, `${view} @${width}`, ref);
    }
  }
});

/**
 * Opens a seeded quote's v1 details from its card at 820: Cards chosen explicitly, and the Done phase, because revise_quote leaves v1
 * superseded (a final status, so under Done, never Open, the page's default phase); the Open phase shows only the " v2" draft.
 */
async function viewV1FromCard(page: Page, ref: string) {
  await page.goto("/quotes");
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Cards", exact: true }).click();
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^Done \(/ }).click();
  await page.locator('[data-slot="card"]', { hasText: ref, hasNotText: " v2" }).getByRole("button", { name: "View" }).click();
}

test("quote details show the quote's description in full (wrapping), and nothing when there is none", async ({ page }) => {
  const description = `Machine 40 steel shafts to drawing DS-1 rev B, then zinc plate and bag in tens. ${"Deliver to the Unit 4 yard. ".repeat(6)}`.trim();
  const { ref } = await seedQuotes(`D${w.runId}`, description);
  await signIn(page, w.tenants.alpha.users.admin);
  await page.setViewportSize({ width: 820, height: 1100 });
  await viewV1FromCard(page, ref);
  const details = page.getByRole("dialog", { name: `${ref} quote details` });
  const shown = details.getByTestId("quote-description");
  await expect(shown).toContainText("Machine 40 steel shafts to drawing DS-1 rev B");
  await expect(shown).toContainText("Deliver to the Unit 4 yard.");
  const box = await shown.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(box.scroll, "wraps, not clipped").toBeLessThanOrEqual(box.client + 1);
  await page.keyboard.press("Escape");
  // A quote with no description shows no Description block.
  const none = await seedQuotes(`E${w.runId}`, "");
  await viewV1FromCard(page, none.ref);
  await expect(page.getByRole("dialog", { name: `${none.ref} quote details` })).toBeVisible();
  await expect(page.getByTestId("quote-description")).toHaveCount(0);
});
