/**
 * Quote versions and partial acceptance (068), in the browser: a sent quote is revised as v2 (the old one kept, read only, superseded),
 * v2 is accepted for one of its two lines, and only that line reaches the sales order and the job. Part and drawing show on the lines.
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("revise a sent quote as v2, accept v2 for one line only", async ({ page }) => {
  const tag = w.runId;
  const customer = `Versions Co ${tag}`;
  const ref = `QUO-${tag.slice(0, 4).replace(/\D/g, "6")}8`;
  expect((await adminClient().from("customers").insert({ organization_id: w.tenants.beta.id, name: customer })).error).toBeNull();
  const admin = await signedInClient(w.tenants.beta.users.admin);
  const { data: quoteId, error } = await admin.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 360, vat_enabled: true, status: "sent", valid_until: "2099-12-31", description: "Shafts and collars" },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: [
      { position: 0, description: "Shaft", quantity: 2, unit_price: 100, vat_pct: 20, vat_exempt: false, part_number: "S-1", drawing_number: "DS-1", drawing_revision: "B" },
      { position: 1, description: "Collar", quantity: 10, unit_price: 10, vat_pct: 20, vat_exempt: false },
    ],
  });
  expect(error).toBeNull();

  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/quotes");
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} quote details` });
  await expect(details.getByText("Part S-1; Dwg DS-1 rev B")).toBeVisible();
  await details.getByRole("button", { name: "Revise (v2)" }).click();
  await page.getByRole("dialog", { name: `Revise ${ref} as v2?` }).getByRole("button", { name: "Revise" }).click();
  // The new version opens as a draft to correct; the old one is superseded.
  const builder = page.getByRole("dialog", { name: `Correct draft ${ref} v2` });
  await expect(builder).toBeVisible();
  await expect(builder.getByRole("textbox", { name: "Part number" }).first()).toHaveValue("S-1");
  await builder.getByRole("button", { name: "Save Correction" }).click();
  await expect(builder).toBeHidden();
  await expect.poll(async () => (await adminClient().from("quotes").select("status").eq("id", quoteId).single()).data?.status).toBe("superseded");
  const { data: v2 } = await adminClient().from("quotes").select("id, version, status, previous_version_id").eq("quote_ref", `${ref} v2`).eq("organization_id", w.tenants.beta.id).single();
  expect(v2).toMatchObject({ version: 2, status: "draft", previous_version_id: quoteId });
  // The customer gets v2 (recorded as sent here; the send flow is its own spec).
  expect((await admin.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", v2!.id)).error).toBeNull();

  await page.reload();
  await page.locator('[data-slot="card"]', { hasText: `${ref} v2` }).getByRole("button", { name: "View" }).click();
  const v2details = page.getByRole("dialog", { name: `${ref} v2 quote details` });
  await expect(v2details.getByTestId("quote-versions")).toContainText("v1");
  await v2details.getByRole("button", { name: "Mark Accepted" }).click();
  const confirm = page.getByRole("dialog", { name: `Mark ${ref} v2 as accepted?` });
  await confirm.getByLabel("Customer PO (optional)").fill(`PO-V-${tag}`);
  await confirm.getByRole("checkbox", { name: "Ordered: Collar" }).uncheck();
  await expect(confirm.getByTestId("accept-lines-total")).toContainText("£200.00");
  await page.getByRole("button", { name: "Confirm Accepted" }).click();
  await expect.poll(async () => (await adminClient().from("quotes").select("status").eq("id", v2!.id).single()).data?.status).toBe("accepted");
  // The accept made a job, so the dialog closes (its overlay would block the toast's "Open job"); reopen v2 to check its lines.
  // An accepted quote is listed under Done, not Open.
  await expect(v2details).toBeHidden();
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^Done \(/ }).click();
  await page.locator('[data-slot="card"]', { hasText: `${ref} v2` }).getByRole("button", { name: "View" }).click();
  await expect(v2details.getByTestId("quote-line-declined")).toHaveCount(1);

  const { data: orders } = await adminClient().from("sales_orders").select("id, total_value, quote_ref").eq("quote_id", v2!.id);
  expect(orders).toHaveLength(1);
  expect({ value: Number(orders![0].total_value), quote: orders![0].quote_ref }).toEqual({ value: 200, quote: `${ref} v2` });
  const { data: jobs } = await adminClient().from("jobs").select("job_no, specification").eq("converted_from_sales_order_id", orders![0].id);
  expect(jobs).toHaveLength(1);
  expect(jobs![0].specification).toContain("Shaft [Part S-1; Dwg DS-1 rev B] x 2");
  expect(jobs![0].specification).not.toContain("Collar");

  // v1 stays viewable, read only: no decision, no send.
  await v2details.getByRole("button", { name: /^v1/ }).click();
  const v1details = page.getByRole("dialog", { name: `${ref} quote details` });
  await expect(v1details.getByTestId("quote-superseded")).toContainText(`Replaced by ${ref} v2`);
  await expect(v1details.getByRole("button", { name: "Mark Accepted" })).toHaveCount(0);
  await expect(v1details.getByRole("button", { name: "Send to Customer" })).toHaveCount(0);
});
