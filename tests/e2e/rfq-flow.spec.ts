/** RFQ to quote: quoting from an RFQ links the quote; the RFQ moves from Outstanding to Quoted once a quote exists (draft, then sent). */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("RFQ: Quote opens the builder for it, the quote is linked, and the RFQ moves Outstanding -> Quoted -> Won", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const customer = `RFQ Flow ${w.runId}`;
  await admin.from("customers").insert({ organization_id: org, name: customer });
  const { data: rfq } = await admin.from("rfqs").insert({ organization_id: org, customer, description: `Flanges ${w.runId}`, status: "ready" }).select("id").single();
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/rfq");
  const card = () => page.locator('[data-slot="card"]', { hasText: customer });
  await expect(card()).toContainText("Outstanding");
  await card().getByRole("link", { name: "Quote" }).click();
  const dialog = page.getByRole("dialog", { name: /Quote Builder: RFQ from/ });
  await expect(dialog.getByRole("textbox", { name: "Quote description" })).toHaveValue(`Flanges ${w.runId}`);
  await dialog.getByRole("textbox", { name: "Description", exact: true }).fill("Flange");
  await dialog.getByRole("spinbutton", { name: "Unit price" }).fill("50");
  await dialog.getByRole("button", { name: "Save Quote" }).click();
  await expect(dialog).toBeHidden();
  const quote = (await admin.from("quotes").select("id, quote_ref, rfq_id").eq("customer", customer).single()).data!;
  expect(quote.rfq_id).toBe(rfq!.id);

  await page.goto("/rfq");
  // A quote exists (still a draft): the RFQ is Quoted, not New / Outstanding (go-live polish 11), and says the quote hasn't gone yet.
  await expect(card()).toHaveCount(0); // gone from Outstanding
  await page.getByRole("button", { name: /^Quoted \(/ }).click();
  await expect(card()).toContainText(`Quoted, draft · ${quote.quote_ref}`);
  await expect(card().getByText("Ready", { exact: true })).toHaveCount(0);
  await admin.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", quote.id);
  await page.reload();
  await expect(card()).toHaveCount(0); // the page opens on Outstanding
  await page.getByRole("button", { name: /^Quoted \(/ }).click();
  await expect(card()).toContainText("Quoted, awaiting reply");
  // One "Quoted": the stage tab. The old intake badge (New / Ready) is gone once a quote has gone, and no lower chip says Quoted.
  await expect(card().getByText("Ready", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Quoted", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeVisible();
  // A status chip does not hide it either.
  await page.getByRole("button", { name: "Clarification", exact: true }).click();
  await expect(card()).toContainText("Quoted, awaiting reply");
  await page.getByRole("button", { name: "All", exact: true }).last().click();
  await admin.from("quotes").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", quote.id);
  await page.reload();
  await page.getByRole("button", { name: /^Won \(/ }).click();
  await expect(card()).toContainText("Won");
});
