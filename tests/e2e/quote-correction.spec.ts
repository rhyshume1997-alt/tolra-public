/**
 * Correcting a draft and copying a quote (audit B4b: D2 minimum). A draft keeps its number; a stale correction is
 * refused with a clear message; a copy gets a new number; a sent quote offers no edit.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function makeQuote(ref: string, customer: string, status: "draft" | "sent") {
  const client = await signedInClient(w.tenants.beta.users.office);
  const { error } = await client.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status, description: "Original scope" },
    p_child: "quote_line_items", p_fk: "quote_id",
    p_lines: [{ position: 0, description: "Original line", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }],
  });
  expect(error).toBeNull();
}

async function openQuote(page: Page, ref: string) {
  await page.goto("/quotes");
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }).click();
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "View" }).click();
  return page.getByRole("dialog", { name: `${ref} quote details` });
}

test("correct a draft in place; a stale correction is refused; copy makes a new quote", async ({ page }) => {
  const tag = w.runId;
  const customer = `Correction Co ${tag}`;
  expect((await adminClient().from("customers").insert({ organization_id: w.tenants.beta.id, name: customer })).error).toBeNull();
  const ref = `QUO-C${tag.slice(0, 5)}`;
  await makeQuote(ref, customer, "draft");

  await signIn(page, w.tenants.beta.users.office);
  let details = await openQuote(page, ref);
  await details.getByRole("button", { name: "Edit Draft" }).click();
  const builder = page.getByRole("dialog", { name: `Correct draft ${ref}` });
  await builder.getByRole("textbox", { name: "Description", exact: true }).fill("Corrected line");
  await builder.getByRole("spinbutton", { name: "Unit price" }).fill("150");
  await builder.getByRole("button", { name: "Save Correction" }).click();
  await expect(builder).toBeHidden();
  const { data: corrected } = await adminClient().from("quotes").select("id, total_value").eq("quote_ref", ref).single();
  expect(Number(corrected?.total_value)).toBe(180);
  const { data: lines } = await adminClient().from("quote_line_items").select("description").eq("quote_id", corrected!.id);
  expect(lines).toEqual([{ description: "Corrected line" }]);

  // Someone else saves while this person has the draft open: their save is refused, nothing overwritten.
  details = await openQuote(page, ref);
  await details.getByRole("button", { name: "Edit Draft" }).click();
  await adminClient().from("quotes").update({ internal_notes: "Changed elsewhere", updated_at: new Date().toISOString() }).eq("id", corrected!.id);
  const stale = page.getByRole("dialog", { name: `Correct draft ${ref}` });
  await stale.getByRole("spinbutton", { name: "Unit price" }).fill("999");
  await stale.getByRole("button", { name: "Save Correction" }).click();
  await expect(page.getByText(/changed by someone else/)).toBeVisible();
  expect(Number((await adminClient().from("quotes").select("total_value").eq("id", corrected!.id).single()).data?.total_value)).toBe(180);
  await page.keyboard.press("Escape");

  // Copy: new number, same lines; the original is untouched.
  details = await openQuote(page, ref);
  await details.getByRole("button", { name: "Copy" }).click();
  const copy = page.getByRole("dialog", { name: `Copy of ${ref}` });
  await copy.getByRole("button", { name: "Save Quote" }).click();
  await expect(copy).toBeHidden();
  const { data: all } = await adminClient().from("quotes").select("quote_ref, total_value").eq("customer", customer);
  expect(all).toHaveLength(2);
  expect(all!.find((q) => q.quote_ref !== ref)).toMatchObject({ total_value: 180 });
});

test("a sent quote offers Copy but not Edit", async ({ page }) => {
  const ref = `QUO-S${w.runId.slice(0, 5)}`;
  const customer = `Sent Co ${w.runId}`;
  await adminClient().from("customers").insert({ organization_id: w.tenants.beta.id, name: customer });
  await makeQuote(ref, customer, "sent");
  await signIn(page, w.tenants.beta.users.office);
  const details = await openQuote(page, ref);
  await expect(details.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Edit Draft" })).toHaveCount(0);
});
