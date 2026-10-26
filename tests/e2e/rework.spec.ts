/**
 * Failed inspection and rework (migration 037, issue #2), in the browser: the main loop (fail part of a job, the workshop starts the
 * rework, books hours and material, scraps one, finishes, the job is inspected again and released), the Rework light, tab and filter on
 * the Job Board, the who/when lines, the admin-only concession, and a failure of one line of a two-line order holding only that part
 * on the despatch screen (the rest offered and saved).
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);

async function finishedJob(no: string, quantity = 10) {
  const { data, error } = await adminClient().from("jobs").insert({
    organization_id: w.tenants.alpha.id, job_no: no, customer: "Rework Co", description: "Bush", stage: "inspection", quantity_required: quantity,
    started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
  }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}
const stored = async (id: string) => (await adminClient().from("jobs").select("stage, inspected_at, inspected_by").eq("id", id).single()).data!;
/** 081: an inspection records what it was checked against. */
const CRITERIA = "Drawing rev A: bore 25.00 +0.03/-0";
const reworkOf = async (id: string) => (await adminClient().from("job_rework").select("status, quantity_affected, affects_all, quantity_scrapped, quantity_remade, closed_how, reason, instructions").eq("job_id", id).single()).data!;

test("fail part of a job, rework it, scrap one, inspect again and release", async ({ page, browser }) => {
  const no = `J-RW-${tag()}`;
  const id = await finishedJob(no, 10);
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");

  // Fail 4 of the 10.
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Inspected", exact: true }).click();
  const inspect = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await inspect.getByLabel("Fail").check();
  await inspect.getByLabel("Measured notes (required)").fill("Bore 25.08 mm on four parts");
  await inspect.getByLabel("Reason it failed (required)").fill("Four bores oversize");
  await inspect.getByLabel("Part of it").check();
  await inspect.getByLabel("Quantity that failed").fill("4");
  await inspect.getByLabel("Rework instructions for the workshop (required)").fill("Re-bore 4 off to 25.00 +0.03");
  await inspect.getByLabel("Acceptance criteria (required)").fill(CRITERIA);
  await inspect.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(`${no} failed inspection: put back to Running, tagged Rework`)).toBeVisible();
  expect(await stored(id)).toMatchObject({ stage: "rework", inspected_at: null });
  expect(await reworkOf(id)).toMatchObject({ status: "open", quantity_affected: 4, affects_all: false, reason: "Four bores oversize", instructions: "Re-bore 4 off to 25.00 +0.03" });

  // The Rework tag chip (Rework is a purple tag on a Running job, never a status): the job is Running and tagged Rework.
  await page.getByRole("button", { name: /^Rework \(/ }).click();
  const row = page.getByRole("row").filter({ hasText: no });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Rework");
  await expect(row.getByTestId("job-status").first()).toContainText("Running");
  await page.getByRole("button", { name: /^Rework \(/ }).click(); // the tag chip off: still on the Open board
  await expect(page.getByRole("row").filter({ hasText: no })).toBeVisible();
  await page.getByRole("button", { name: /^Rework \(/ }).click(); // and on again

  // The workshop works the rework.
  await row.getByRole("button", { name: "Rework", exact: true }).click();
  const rework = page.getByRole("dialog", { name: `Rework: ${no}` });
  await expect(rework).toContainText("Waiting for the workshop");
  await expect(rework).toContainText("4 of 10");
  await expect(rework).toContainText("Re-bore 4 off to 25.00 +0.03");
  await expect(rework).toContainText("Workshop");
  await rework.getByRole("button", { name: "Start rework" }).click();
  await expect(rework).toContainText("Rework under way");
  await rework.getByLabel("Hours worked").fill("2.5");
  await rework.getByLabel("Material used").fill("1 off EN8 bar");
  await expect(rework.getByLabel("Material cost (£)")).toHaveCount(0); // money is for office and admin
  await rework.getByRole("button", { name: "Add hours / material" }).click();
  await expect(rework.getByRole("list", { name: "Hours, material and scrap" })).toContainText("2.5 h worked");
  await rework.getByLabel("Quantity", { exact: true }).fill("1");
  await rework.getByLabel("Reason", { exact: true }).fill("Cracked on re-bore");
  await rework.getByRole("button", { name: "Scrap quantity" }).click();
  await expect(rework.getByLabel("Rework totals")).toContainText("Remaining to make");
  await expect(rework.getByLabel("Rework totals").locator("div").filter({ hasText: "Remaining to make" })).toContainText("1");
  await expect(rework.getByLabel("Rework totals").locator("div").filter({ hasText: "Still to rework" })).toContainText("3");
  // Finishing says how many replacements were made for the scrapped part (none given: refused, nothing changes).
  await rework.getByRole("button", { name: "Finish rework: send for re-inspection" }).click();
  await expect(rework.getByText(/Enter how many replacements were made/)).toBeVisible();
  await rework.getByLabel(/^Replacements made for the 1 scrapped/).fill("1");
  await rework.getByRole("button", { name: "Finish rework: send for re-inspection" }).click();
  await expect(rework).toContainText("Reworked: awaiting re-inspection");
  expect(await reworkOf(id)).toMatchObject({ status: "finished", quantity_scrapped: 1, quantity_remade: 1 });
  expect(await stored(id)).toMatchObject({ stage: "inspection", inspected_at: null });
  await rework.getByRole("button", { name: "Close", exact: true }).last().click();

  // 081: the workshop finished the rework, so it can't pass it (independent inspection): it is told so, and can't record it.
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Inspected", exact: true }).click();
  const own = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await expect(own).toContainText("You finished this job, so someone else must inspect it.");
  await expect(own.getByRole("button", { name: "Record inspection" })).toBeDisabled();
  await own.getByRole("button", { name: "Cancel" }).click();

  // Inspected again by the office: released.
  const office = await (await browser.newContext()).newPage();
  await signIn(office, w.tenants.alpha.users.office);
  await office.goto("/jobs");
  await office.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await office.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Inspected", exact: true }).click();
  const again = office.getByRole("dialog", { name: `Record inspection: ${no}` });
  await expect(again).toContainText("Bore 25.08 mm on four parts"); // the earlier failure is listed
  await again.getByLabel("Pass").check();
  await again.getByLabel("Acceptance criteria (required)").fill(CRITERIA);
  await again.getByLabel("Measured notes (required)").fill("Re-bored: 25.01, 25.02, 25.00, 25.01 mm");
  await again.getByRole("button", { name: "Record inspection" }).click();
  await expect(office.getByText(/inspected: Complete/)).toBeVisible();
  expect(await stored(id)).toMatchObject({ stage: "complete", inspected_by: "Office alpha" });
  expect(await reworkOf(id)).toMatchObject({ status: "closed", closed_how: "passed" });

  // The who/when lines on the job name each step.
  await office.getByRole("button", { name: /^Complete \(/ }).click();
  await office.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Worksheet" }).first().click();
  const sheet = office.getByRole("dialog", { name: `Worksheet - ${no}` });
  const lines = sheet.getByTestId("who-when").getByTestId("who-when-line");
  await expect(lines).toHaveText([
    /^Created by —/, /^Started by —/, /^Finished by —/, /^Failed inspection by Workshop alpha · /, /^Rework started by Workshop alpha · /,
    /^Scrapped 1 by Workshop alpha · /, /^Rework finished by Workshop alpha · /, /^Inspected by Office alpha · /,
  ]);
  await expect(sheet.getByTestId("who-when")).not.toContainText("@");
});

test("only an admin can release a job in rework, on a concession; the rework closes", async ({ page }) => {
  const no = `J-RWC-${tag()}`;
  const id = await finishedJob(no, 6);
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Inspected", exact: true }).click();
  const inspect = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await inspect.getByLabel("Fail").check();
  await inspect.getByLabel("Measured notes (required)").fill("Thread gauge: no-go enters");
  await inspect.getByLabel("Reason it failed (required)").fill("Thread out of tolerance");
  await inspect.getByLabel("Rework instructions for the workshop (required)").fill("Re-cut the thread");
  await inspect.getByLabel("Acceptance criteria (required)").fill(CRITERIA);
  await inspect.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(`${no} failed inspection`)).toBeVisible();
  expect(await reworkOf(id)).toMatchObject({ status: "open", affects_all: true, quantity_affected: 6 });

  // Still in rework: the admin can record a concession.
  await page.getByRole("button", { name: /^Rework \(/ }).click();
  const row = page.getByRole("row").filter({ hasText: no });
  await row.getByRole("button", { name: "Inspected", exact: true }).click();
  const concession = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await concession.getByLabel("Concession").check();
  await concession.getByLabel("Measured notes (required)").fill("Thread 0.02 over, fit checked");
  await concession.getByLabel("Reason for the concession (required)").fill("Customer agreed by e-mail");
  await concession.getByLabel("Acceptance criteria (required)").fill(CRITERIA);
  await concession.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(/inspected: Complete/)).toBeVisible();
  expect(await stored(id)).toMatchObject({ stage: "complete" });
  expect(await reworkOf(id)).toMatchObject({ status: "closed", closed_how: "concession" });
});

test("a two-line order: one line fails in part, and only that part is held on the despatch screen", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const service = adminClient();
  const customer = `Rework Lines ${tag()} Ltd`;
  const lines = [{ description: "Part A", quantity: 10 }, { description: "Part B", quantity: 10 }];
  const { data: quote } = await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-RWL-${tag()}`, customer, status: "draft", total_value: 0 }).select("id").single();
  expect((await service.from("quote_line_items").insert(lines.map((l, position) => ({ ...l, position, unit_price: 10, vat_pct: 0, vat_exempt: false, quote_id: quote!.id, organization_id: org })))).error).toBeNull();
  await service.from("quotes").update({ total_value: 200 }).eq("id", quote!.id);
  await service.from("quotes").update({ status: "accepted" }).eq("id", quote!.id);
  const so = `PO-RWL-${tag()}`;
  const { data: order } = await service.from("sales_orders").insert({ organization_id: org, so_number: so, customer_po: so, customer, quote_id: quote!.id, total_value: 200, status: "open" }).select("id").single();
  const no = `J-RWL-${tag()}`;
  const { data: job } = await service.from("jobs").insert({
    organization_id: org, job_no: no, customer, description: "Two parts", stage: "inspection", converted_from_sales_order_id: order!.id,
    started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
  }).select("id").single();
  expect((await service.from("sales_orders").update({ converted_to_job_id: job!.id }).eq("id", order!.id)).error).toBeNull();

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Inspected", exact: true }).click();
  const inspect = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await inspect.getByLabel("Fail").check();
  await inspect.getByLabel("Measured notes (required)").fill("Part A bore 25.08 mm on four");
  await inspect.getByLabel("Reason it failed (required)").fill("Four Part A bores oversize");
  await inspect.getByLabel("Part of it").check();
  // The order has two lines: the quantity is entered per line, with the batch.
  await expect(inspect.getByLabel("Quantity that failed: Part A")).toBeVisible();
  await expect(inspect.getByLabel("Quantity that failed", { exact: true })).toHaveCount(0);
  await inspect.getByLabel("Quantity that failed: Part A").fill("4");
  await inspect.getByLabel("Batch or heat number (optional)").fill("Heat 4471");
  await inspect.getByLabel("Rework instructions for the workshop (required)").fill("Re-bore 4 off Part A");
  await inspect.getByLabel("Acceptance criteria (required)").fill(CRITERIA);
  await inspect.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(`${no} failed inspection: put back to Running, tagged Rework`)).toBeVisible();
  const rework = (await service.from("job_rework").select("quantity_affected, batch_ref, sales_order_line_id").eq("job_id", job!.id).single()).data!;
  expect(rework).toMatchObject({ quantity_affected: 4, batch_ref: "Heat 4471" });
  expect(rework.sales_order_line_id).toBeTruthy();
  // 081 (8.6): the job is back to Running (tagged Rework), so the rest goes only on an admin's early release, with a reason.
  const admin = await signedInClient(w.tenants.alpha.users.admin);
  expect((await admin.rpc("release_job_early", { p_job: job!.id, p_reason: "Customer needs Part B and the good Part A now" })).error).toBeNull();

  // The despatch screen holds 4 of Part A only, says why, and offers the rest.
  await page.goto("/delivery-notes");
  await page.getByRole("button", { name: "New delivery note" }).click();
  const dialog = page.getByRole("dialog", { name: "New Delivery Note" });
  await dialog.getByRole("button", { name: "From a sales order" }).click(); // the form opens on "From a job" once jobs exist
  await dialog.getByLabel("Sales order").selectOption({ label: `${so} - ${customer}` });
  const table = dialog.getByRole("table", { name: "Lines to despatch" });
  await expect(table.getByRole("row", { name: /Part A/ })).toContainText("4 in rework (batch Heat 4471)");
  await expect(dialog.getByLabel("Quantity to despatch: Part A")).toHaveValue("6");
  await expect(dialog.getByLabel("Quantity to despatch: Part B")).toHaveValue("10");
  await dialog.getByLabel("Quantity to despatch: Part A").fill("7");
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Only 6 of \"Part A\" can go out now");
  await dialog.getByLabel("Quantity to despatch: Part A").fill("6");
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(page.getByText(/Delivery note DLN-\d+ created/)).toBeVisible();
  const note = (await service.from("delivery_notes").select("id").eq("job_id", job!.id).single()).data!;
  const items = (await service.from("delivery_note_items").select("description, quantity").eq("delivery_note_id", note.id).order("position")).data!;
  expect(items.map((i) => [i.description, Number(i.quantity)])).toEqual([["Part A", 6], ["Part B", 10]]);
});

test("hours and material typed but not added are saved when the rework is finished; a half-valid entry stops the finish", async ({ page }) => {
  const no = `J-RP-${tag()}`;
  const id = await finishedJob(no, 5);
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Inspected", exact: true }).click();
  const inspect = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await inspect.getByLabel("Fail").check();
  await inspect.getByLabel("Measured notes (required)").fill("Bore oversize");
  await inspect.getByLabel("Reason it failed (required)").fill("Bores oversize");
  await inspect.getByLabel("Rework instructions for the workshop (required)").fill("Re-bore");
  await inspect.getByLabel("Acceptance criteria (required)").fill(CRITERIA);
  await inspect.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(`${no} failed inspection: put back to Running, tagged Rework`)).toBeVisible();

  await page.getByRole("button", { name: /^Rework \(/ }).click();
  await page.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Rework", exact: true }).click();
  const rework = page.getByRole("dialog", { name: `Rework: ${no}` });
  await rework.getByRole("button", { name: "Start rework" }).click();
  await expect(rework).toContainText("Rework under way");

  // Half-valid (hours of 0): Finish is refused with a message, nothing is lost or saved.
  await rework.getByLabel("Hours worked").fill("0");
  await rework.getByLabel("Material used").fill("1 off EN8 bar");
  await rework.getByRole("button", { name: "Finish rework: send for re-inspection" }).click();
  await expect(rework.getByText(/typed in but not added/)).toBeVisible();
  await expect(rework.getByLabel("Material used")).toHaveValue("1 off EN8 bar");
  expect((await reworkOf(id)).status).toBe("in_progress");

  // Valid, never added: Finish books both with the finish.
  await rework.getByLabel("Hours worked").fill("1.5");
  await rework.getByRole("button", { name: "Finish rework: send for re-inspection" }).click();
  await expect(rework).toContainText("Reworked: awaiting re-inspection");
  expect((await reworkOf(id)).status).toBe("finished");
  const { data: rows } = await adminClient().from("job_rework_entries").select("kind, hours, description").eq("rework_id", (await adminClient().from("job_rework").select("id").eq("job_id", id).single()).data!.id);
  expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ hours: 1.5 }), expect.objectContaining({ description: expect.stringContaining("EN8") })]));
});
