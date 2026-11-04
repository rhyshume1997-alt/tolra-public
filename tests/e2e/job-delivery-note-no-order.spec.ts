/**
 * C17 (post-144 release 147): a delivery note for a job that did NOT come from a sales order. Office makes it from the job card; it is
 * linked to the job and the customer record by key, listed on the job card and the customer page, and its print sheet carries the
 * goods-out wording and the Received by / Signature / Date line. Workshop and viewer get no button, and a viewer calling the function
 * directly is refused. Needs the Supabase stack with release 147 installed (the CI install step); not runnable without it.
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function inspectedJobWithoutOrder() {
  const org = w.tenants.alpha.id;
  const service = adminClient();
  const t = `${w.runId.slice(0, 6)}${randomUUID().slice(0, 4)}`;
  const name = `No Order ${t} Ltd`;
  const customer = (await service.from("customers").insert({ organization_id: org, name }).select("id").single()).data!;
  const no = `J-NO-${t}`;
  const { data: job, error } = await service.from("jobs").insert({
    organization_id: org, job_no: no, customer: name, description: "Brackets", stage: "complete",
    started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", inspected_at: "2026-10-03T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
  }).select("id").single();
  expect(error).toBeNull();
  return { no, id: job!.id as string, customerId: customer.id as string, name };
}

async function openJobCard(page: import("@playwright/test").Page, no: string) {
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Complete \(/ }).click();
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Cards", exact: true }).click();
  return page.locator(`[data-testid="job-card"][data-job-no="${no}"]`);
}

test("office makes a delivery note from a job with no sales order; it is linked by key and listed on the job card and customer page", async ({ page }) => {
  const { no, id, customerId, name } = await inspectedJobWithoutOrder();
  await signIn(page, w.tenants.alpha.users.office);
  const card = await openJobCard(page, no);
  await card.getByRole("button", { name: "Delivery note", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Delivery note - ${no}` });
  // The customer record whose name is the job's customer is chosen already.
  await expect(dialog.getByLabel("Customer")).toHaveValue(customerId);
  await dialog.getByLabel("Description 1").fill("Bracket 40mm");
  await dialog.getByLabel("Quantity 1").fill("4");
  // A double click sends one request: one note.
  await dialog.getByRole("button", { name: "Save Delivery Note" }).dblclick();
  await expect(page.getByText(/Delivery note DLN-\d+ created/)).toBeVisible();
  const notes = (await adminClient().from("delivery_notes").select("id, dn_number, job_id, customer_id, job_ref, customer, status").eq("job_id", id)).data!;
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ job_id: id, customer_id: customerId, job_ref: no, customer: name, status: "awaiting" });

  await page.reload();
  const again = await openJobCard(page, no);
  await again.getByTestId("delivery-notes-for").getByText("Delivery notes").click();
  await expect(again.getByTestId("delivery-notes-list").getByText(notes[0].dn_number)).toBeVisible();

  await page.goto(`/customers?customer=${customerId}`);
  await page.getByTestId("delivery-notes-for").getByText("Delivery notes").click();
  await expect(page.getByTestId("delivery-notes-list").getByText(notes[0].dn_number)).toBeVisible();
});

test("the print sheet of that note says goods out and has the signature line", async ({ page }) => {
  const { id, customerId } = await inspectedJobWithoutOrder();
  const office = await signedInClient(w.tenants.alpha.users.office);
  const made = await office.rpc("create_job_delivery_note", {
    p_job: id, p_customer: customerId, p_request: randomUUID(), p_ship_date: "2026-11-04", p_tax_date: "2026-11-04", p_ship_via: null, p_notes: null,
    p_lines: [{ description: "Spacer", quantity: 2 }],
  });
  expect(made.error).toBeNull();
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto(`/delivery-notes/${made.data.id}/print`);
  await expect(page.getByTestId("dn-goods-out")).toHaveText("Goods out: the items listed above were despatched.");
  await expect(page.getByTestId("dn-received")).toHaveText(/Received by: _+ Signature: _+ Date: _+/);
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("dn-goods-out")).toBeVisible();
  await expect(page.getByTestId("dn-received")).toBeVisible();
});

test("workshop and viewer get no button on a no-order job, and a viewer calling the function is refused", async ({ page }) => {
  const { no, id, customerId } = await inspectedJobWithoutOrder();
  for (const role of ["workshop", "viewer"] as const) {
    // One page, two people: drop the first sign-in, or /login sends the browser straight to the dashboard and the form never shows.
    await page.context().clearCookies();
    await signIn(page, w.tenants.alpha.users[role]);
    await page.goto("/jobs");
    await page.getByRole("button", { name: /^Complete \(/ }).click();
    await expect(page.getByText(no).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Delivery note", exact: true })).toHaveCount(0);
  }
  const viewer = await signedInClient(w.tenants.alpha.users.viewer);
  const refused = await viewer.rpc("create_job_delivery_note", {
    p_job: id, p_customer: customerId, p_request: randomUUID(), p_ship_date: "2026-11-04", p_tax_date: "2026-11-04", p_ship_via: null, p_notes: null,
    p_lines: [{ description: "Spacer", quantity: 2 }],
  });
  expect(refused.error?.code).toBe("42501");
  expect((await adminClient().from("delivery_notes").select("id").eq("job_id", id)).data).toEqual([]);
});

test("a hand-made delivery note that names an invoice takes the next DLN number, not the invoice's (no DLN-0456 bypass)", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const name = `Hand Made ${w.runId.slice(0, 6)}${randomUUID().slice(0, 4)} Ltd`;
  expect((await adminClient().from("customers").insert({ organization_id: org, name })).error).toBeNull();
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/delivery-notes");
  await page.getByRole("button", { name: "New delivery note" }).click();
  const dialog = page.getByRole("dialog", { name: "New Delivery Note" });
  await dialog.getByRole("button", { name: "Without an order" }).click();
  await dialog.locator("select[name=customer]").selectOption({ label: name });
  await dialog.locator("input[name=invoice_ref]").fill("INV-0456");
  await dialog.getByPlaceholder(/Items, one per line/).fill("Spacer x 1");
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(page.getByText(/Delivery note DLN-\d+ created/)).toBeVisible();
  const made = (await adminClient().from("delivery_notes").select("dn_number, invoice_ref").eq("organization_id", org).eq("customer", name).single()).data!;
  expect(made.invoice_ref).toBe("INV-0456");
  expect(made.dn_number).toMatch(/^DLN-\d{4,}$/);
  expect(made.dn_number).not.toBe("DLN-0456");
});
