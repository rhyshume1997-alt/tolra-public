/**
 * One click per task: the Job Board's "Delivery note" button. It opens the delivery note form for that job with the lines and
 * quantities already filled in (no picking the job again), is shown to admin and office only, and only on a job that came from a
 * sales order and has passed inspection (the same rules as the "From a job" picker on the Delivery Notes page).
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function inspectedJobFromOrder() {
  const org = w.tenants.alpha.id;
  const service = adminClient();
  // One tag per job made: both tests make one, and the quote, order and job numbers must not repeat within a run (or on a retry).
  const t = `${w.runId.slice(0, 6)}${randomUUID().slice(0, 4)}`;
  const customer = `Board DN ${t} Ltd`;
  const { data: quote } = await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-BDN-${t}`, customer, status: "draft", total_value: 0 }).select("id").single();
  expect((await service.from("quote_line_items").insert([{ description: "Flange 80mm", quantity: 12, position: 0, unit_price: 10, vat_pct: 0, vat_exempt: false, quote_id: quote!.id, organization_id: org }])).error).toBeNull();
  await service.from("quotes").update({ total_value: 120 }).eq("id", quote!.id);
  await service.from("quotes").update({ status: "accepted" }).eq("id", quote!.id);
  const so = `PO-BDN-${t}`;
  const { data: order } = await service.from("sales_orders").insert({ organization_id: org, so_number: so, customer_po: so, customer, quote_id: quote!.id, total_value: 120, status: "open" }).select("id").single();
  const no = `J-BDN-${t}`;
  const { data: job, error } = await service.from("jobs").insert({
    organization_id: org, job_no: no, customer, description: "Flanges", stage: "complete", converted_from_sales_order_id: order!.id,
    started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", inspected_at: "2026-10-03T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
  }).select("id").single();
  expect(error).toBeNull();
  expect((await service.from("sales_orders").update({ converted_to_job_id: job!.id }).eq("id", order!.id)).error).toBeNull();
  return { no, id: job!.id as string };
}

test("office makes a delivery note straight from the job: the lines are already there", async ({ page }) => {
  const { no, id } = await inspectedJobFromOrder();
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Complete \(/ }).click();
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Delivery note", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Delivery note - ${no}` });
  // No job picker: the lines of this job are loaded straight away, with the full quantity left to send.
  await expect(dialog.getByLabel("Job")).toHaveCount(0);
  await expect(dialog.getByLabel("Quantity to despatch: Flange 80mm")).toHaveValue("12");
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(page.getByText(/Delivery note DLN-\d+ created/)).toBeVisible();
  const note = (await adminClient().from("delivery_notes").select("id").eq("job_id", id).single()).data!;
  const items = (await adminClient().from("delivery_note_items").select("description, quantity").eq("delivery_note_id", note.id)).data!;
  expect(items.map((i) => [i.description, Number(i.quantity)])).toEqual([["Flange 80mm", 12]]);
});

test("workshop and viewer do not get the Delivery note button on the Job Board", async ({ page }) => {
  const { no } = await inspectedJobFromOrder();
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Complete \(/ }).click();
  await expect(page.getByRole("row").filter({ hasText: no })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delivery note", exact: true })).toHaveCount(0);
});
