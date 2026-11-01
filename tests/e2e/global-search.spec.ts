/**
 * The global search in the top bar: type a customer or an invoice number, pick the result, and the record opens (the same deep links
 * the app already uses: /quotes?quote=<id>, /invoices?invoice=<id>). Another company's rows never appear, and a workshop person
 * searching a quote's customer finds no quote.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);

async function seed() {
  const admin = adminClient();
  // Each test seeds its own rows: a fresh suffix per call, so the per-company unique quote and invoice numbers never collide.
  const id = `${tag()}${randomUUID().slice(0, 4)}`;
  const customer = `Searchable ${id} Engineering`;
  const quoteRef = `QUO-S${id}`;
  const invoiceRef = `INV-S${id}`;
  const { data: quote, error: quoteError } = await admin.from("quotes").insert({ organization_id: w.tenants.alpha.id, quote_ref: quoteRef, customer, total_value: 100, status: "draft", vat_enabled: false }).select("id").single();
  expect(quoteError).toBeNull();
  const { error: invoiceError } = await admin.from("invoices").insert({ organization_id: w.tenants.alpha.id, invoice_ref: invoiceRef, customer, status: "sent", subtotal: 100, vat: 0, total: 100, vat_enabled: false, due_date: "2099-01-31" });
  expect(invoiceError).toBeNull();
  // The same customer name in the other company: it must never show up.
  const { error: otherError } = await admin.from("quotes").insert({ organization_id: w.tenants.beta.id, quote_ref: `QUO-O${id}`, customer, total_value: 1, status: "draft", vat_enabled: false });
  expect(otherError).toBeNull();
  return { customer, quoteRef, invoiceRef, quoteId: quote!.id as string };
}

const searchBox = (page: Page) => page.getByTestId("global-search-input");

test("search a quote by its customer and open it", async ({ page }) => {
  const { customer, quoteRef } = await seed();
  await signIn(page, w.tenants.alpha.users.office);
  await searchBox(page).fill(customer);
  const group = page.getByTestId("global-search-group-quotes");
  await expect(group).toContainText(quoteRef);
  // Only this company's quote: the other company's quote has the same customer name.
  await expect(group.getByTestId("global-search-result")).toHaveCount(1);
  await group.getByTestId("global-search-result").click();
  await expect(page).toHaveURL(/\/quotes/);
  await expect(page.getByRole("dialog", { name: new RegExp(`${quoteRef} quote details`) })).toBeVisible();
});

test("search an invoice by its number and open it; / focuses the box", async ({ page }) => {
  const { invoiceRef } = await seed();
  await signIn(page, w.tenants.alpha.users.office);
  await page.keyboard.press("/");
  await expect(searchBox(page)).toBeFocused();
  await page.keyboard.type(invoiceRef);
  const group = page.getByTestId("global-search-group-invoices");
  await expect(group).toContainText(invoiceRef);
  await group.getByTestId("global-search-result").first().click();
  await expect(page).toHaveURL(/\/invoices/);
  await expect(page.getByRole("dialog", { name: /invoice details/ })).toContainText(invoiceRef);
});

test("workshop: searching a quote's customer finds no quote or invoice", async ({ page }) => {
  const { customer } = await seed();
  await signIn(page, w.tenants.alpha.users.workshop);
  await searchBox(page).fill(customer);
  await expect(page.getByTestId("global-search-empty")).toBeVisible();
  await expect(page.getByTestId("global-search-group-quotes")).toHaveCount(0);
  await expect(page.getByTestId("global-search-group-invoices")).toHaveCount(0);
});
