/**
 * RFQ display preferences (Rhys, Fri 23 Oct): the RFQ card shows only the fields ticked in its Columns button, in the order
 * lib/rfq-display.ts defines. Hiding one field removes it from the card, is remembered after a reload (stored with the
 * company's other column choices), and the Outstanding -> Quoted flow still works with a field hidden. A company of its own,
 * because the choice is company-wide.
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
const customer = () => `Display Co ${w.runId.slice(0, 6)}`;
let solo: Awaited<ReturnType<typeof createSoloTenant>>;

test.beforeAll(async () => {
  solo = await createSoloTenant(w.runId, `rfqdisp-${randomUUID().slice(0, 6)}`);
  await adminClient().from("rfqs").insert({ organization_id: solo.id, customer: customer(), description: `Display flanges ${w.runId}`, status: "ready" });
});

const card = (page: import("@playwright/test").Page) => page.locator('[data-slot="card"]', { hasText: customer() });
/**
 * The company's saved RFQ hidden list, read from the database. A Columns tick redraws the card at once and saves in the
 * background (lib/org-settings.ts enqueue -> persistChange: look up the company, re-read the row, then upsert), so a reload
 * straight after the redraw can cut that save off. Wait on this before a reload that must show the saved choice.
 */
const savedHidden = async () => {
  const { data } = await adminClient().from("organization_settings").select("hidden_columns").eq("organization_id", solo.id).maybeSingle();
  return ((data?.hidden_columns as Record<string, string[]> | null)?.rfq ?? []).includes("received");
};

for (const width of [1280, 390]) {
  test(`hide Received at ${width}: the card drops it, and it stays hidden after a reload`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, solo.admin);
    await page.goto("/rfq");
    await expect(card(page)).toContainText("Received:");
    await expect(card(page).locator('[data-rfq-field="value"]')).toBeVisible();

    await page.getByRole("button", { name: "Columns" }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Received" });
    if ((await item.getAttribute("aria-checked")) === "true") await item.click();
    await page.keyboard.press("Escape");
    await expect(card(page)).not.toContainText("Received:");
    await expect(card(page).locator('[data-rfq-field="received"]')).toHaveCount(0);
    await expect(card(page).locator('[data-rfq-field="value"]')).toBeVisible();
    // The customer and the actions cannot be switched off: they are listed ticked and disabled.
    await page.getByRole("button", { name: "Columns" }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: "Customer" })).toBeDisabled();
    await expect(page.getByRole("menuitemcheckbox", { name: "Customer" })).toBeChecked();
    await expect(page.getByRole("menuitemcheckbox", { name: "Actions" })).toBeDisabled();
    await page.keyboard.press("Escape");

    await expect.poll(savedHidden, { timeout: 15_000 }).toBe(true);
    await page.reload();
    await expect(card(page)).toContainText("Outstanding");
    await expect(card(page)).not.toContainText("Received:");
    // No sideways page scroll with a field hidden.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Put it back for the next test (Received on again).
    await page.getByRole("button", { name: "Columns" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Received" }).click();
    await page.keyboard.press("Escape");
    await expect(card(page)).toContainText("Received:");
    // The save runs after the screen updates: wait until it has reached the database, then reload to show it was kept.
    await expect.poll(savedHidden, { timeout: 15_000 }).toBe(false);
    await page.reload();
    await expect(card(page)).toContainText("Received:");
  });
}

test("Outstanding -> Quoted still works with a field hidden", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, solo.admin);
  await page.goto("/rfq");
  await expect(card(page)).toContainText("Outstanding");
  await page.getByRole("button", { name: "Columns" }).click();
  const received = page.getByRole("menuitemcheckbox", { name: "Received" });
  if ((await received.getAttribute("aria-checked")) === "true") await received.click();
  await page.keyboard.press("Escape");
  await expect(card(page)).toContainText("Outstanding");
  await expect(card(page)).not.toContainText("Received:");

  await card(page).getByRole("link", { name: "Quote" }).click();
  const builder = page.getByRole("dialog", { name: /Quote Builder: RFQ from/ });
  await expect(builder.getByRole("textbox", { name: "Quote description" })).toHaveValue(`Display flanges ${w.runId}`);
  await builder.getByRole("textbox", { name: "Description", exact: true }).fill("Flange");
  await builder.getByRole("spinbutton", { name: "Unit price" }).fill("25");
  await builder.getByRole("button", { name: "Save Quote" }).click();
  await expect(builder).toBeHidden();

  await page.goto("/rfq");
  await expect(card(page)).toHaveCount(0);
  await page.getByRole("button", { name: /^Quoted \(/ }).click();
  await expect(card(page)).toContainText("Quoted, draft");
  await expect(card(page)).not.toContainText("Received:");
});

test("Outstanding -> Quoted still works with Stage hidden (checked via the Quoted tab and the quote ref, not the card text)", async ({ page }) => {
  const admin = adminClient();
  const stageCustomer = `Display Stage Co ${w.runId.slice(0, 6)}`;
  const { data: rfq } = await admin.from("rfqs").insert({ organization_id: solo.id, customer: stageCustomer, description: `Stage hidden ${w.runId}`, status: "ready" }).select("id").single();
  const stageCard = () => page.locator('[data-slot="card"]', { hasText: stageCustomer });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, solo.admin);
  await page.goto("/rfq");
  await expect(stageCard()).toContainText("Outstanding");
  await page.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Stage" }).click();
  await page.keyboard.press("Escape");
  await expect(stageCard().locator('[data-rfq-field="stage"]')).toHaveCount(0);
  await expect(stageCard()).not.toContainText("Outstanding");
  // Still in the Outstanding list, with its Quote action.
  await page.getByRole("button", { name: /^Outstanding \(/ }).click();
  await stageCard().getByRole("link", { name: "Quote" }).click();
  const builder = page.getByRole("dialog", { name: /Quote Builder: RFQ from/ });
  await builder.getByRole("textbox", { name: "Description", exact: true }).fill("Flange");
  await builder.getByRole("spinbutton", { name: "Unit price" }).fill("25");
  await builder.getByRole("button", { name: "Save Quote" }).click();
  await expect(builder).toBeHidden();
  const quote = (await admin.from("quotes").select("id, quote_ref, rfq_id").eq("customer", stageCustomer).single()).data!;
  expect(quote.rfq_id).toBe(rfq!.id);

  await page.goto("/rfq");
  await expect(stageCard()).toHaveCount(0); // gone from Outstanding
  await page.getByRole("button", { name: /^Quoted \(/ }).click();
  await expect(stageCard()).toHaveCount(1); // in the Quoted list
  await expect(stageCard().locator('[data-rfq-field="stage"]')).toHaveCount(0);
  // The link names the quote. The Quotes page reads ?quote=<id> once its list has loaded, opens that quote and
  // tidies the address back to /quotes (app/(dashboard)/quotes/page.tsx), so the ?quote= address is only there for a
  // moment: check the link's target, then that the right quote opened, not the address after the page has used it.
  const open = stageCard().getByRole("link", { name: `Open ${quote.quote_ref}` });
  await expect(open).toHaveAttribute("href", `/quotes?quote=${quote.id}`);
  await open.click();
  await expect(page.getByRole("dialog", { name: `${quote.quote_ref} quote details` })).toBeVisible();
  await expect(page).toHaveURL(/\/quotes$/);
});
