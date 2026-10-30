/**
 * The job flow in the browser (migration 081): the workshop finishes a job made from a sales order (since 099 Finish drafts only what has
 * been despatched, so nothing here; the job's draft is then made by hand, no number),
 * reopens its own Finish with a reason (113: confirmed, with the "No admin available" tick box), finishes it again, and is told it can't inspect its own work; the office inspects it with the
 * acceptance criteria and the measured result, and it is Complete; the draft then reads "Ready to issue". Then (113) the office issues it
 * and reopens the job through the sign-off: the confirmation names the issued invoice, which stays exactly as it was. Fixed far dates only.
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { confirmFinish, signIn, world } from "./helpers";

const w = world();

test("finish, reopen with a reason, finish again; the finisher can't inspect; the office passes it: Complete, draft Ready to issue", async ({ page, browser }) => {
  const service = adminClient();
  const org = w.tenants.alpha.id;
  const t = `${w.runId.slice(0, 6)}${randomUUID().slice(0, 4)}`;
  const customer = `Flow ${t} Ltd`;
  const no = `J-FLOW-${t}`;
  const { data: order, error: orderError } = await service.from("sales_orders").insert({
    organization_id: org, so_number: `SO-FLOW-${t}`, customer_po: `PO-FLOW-${t}`, customer, status: "confirmed", total_value: 120, vat_enabled: false, vat_pct: 0, vat_exempt: false,
  }).select("id").single();
  expect(orderError).toBeNull();
  const { data: job, error } = await service.from("jobs").insert({
    organization_id: org, job_no: no, customer, description: "Flow brackets", stage: "machining", converted_from_sales_order_id: order!.id,
    started_at: "2026-10-01T08:00:00Z", due_date: "2099-01-05", date_required: "2099-01-05",
  }).select("id").single();
  expect(error).toBeNull();
  expect((await service.from("sales_orders").update({ converted_to_job_id: job!.id }).eq("id", order!.id)).error).toBeNull();
  const stored = async () => (await service.from("jobs").select("finished_at, inspected_at, stage").eq("id", job!.id).single()).data!;

  // 1. The workshop finishes it (the "Are you sure?" stays): Waiting for inspection. Nothing has been despatched, so no draft (099).
  await signIn(page, w.tenants.alpha.users.workshop);
  await page.goto("/jobs");
  const row = () => page.getByRole("row").filter({ hasText: no });
  await confirmFinish(page, row().getByRole("button", { name: "Finish", exact: true }));
  await expect(page.getByText("Job finished: Waiting for inspection")).toBeVisible();
  await expect.poll(async () => (await stored()).finished_at).not.toBeNull();
  expect((await service.from("invoices").select("status, invoice_ref").eq("job_id", job!.id)).data).toEqual([]);
  // The job's draft, made by hand (no number): it reads "Draft, awaiting inspection" until the job is Complete.
  const { data: draft, error: draftError } = await service.from("invoices").insert({
    organization_id: org, customer, job_id: job!.id, status: "draft", subtotal: 120, vat: 0, total: 120, carriage: 0, vat_enabled: false, amount_paid: 0,
    invoice_date: "2099-01-05", due_date: "2099-02-04", description: "Flow brackets", quantity: 1, unit_price: 120,
  }).select("id").single();
  expect(draftError).toBeNull();
  expect((await service.from("invoice_line_items").insert({ organization_id: org, invoice_id: draft!.id, position: 0, description: "Flow brackets", quantity: 1, unit_price: 120, vat_pct: 0, vat_exempt: false })).error).toBeNull();

  // 2. Finished by mistake: the workshop reopens its own Finish, saying why; it is back to Running.
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await expect(row()).toContainText("Waiting for inspection");
  await row().getByRole("button", { name: "Reopen" }).click();
  const reopen = page.getByRole("dialog", { name: `Reopen ${no}` });
  await reopen.getByLabel(/^Reason/).fill("oops");
  await reopen.getByRole("button", { name: "Reopen job" }).click();
  await expect(reopen.getByRole("alert")).toContainText("at least 10 characters");
  await reopen.getByLabel(/^Reason/).fill("Finished by mistake, still deburring");
  // 113 (D30-5): the confirmation names the job and its invoice (a draft here), then who signs it off: no admin is about, so the tick
  // box reopens it now and leaves the admin a request to approve or reject later.
  await reopen.getByRole("button", { name: "Reopen job" }).click();
  await expect(reopen.getByRole("alert")).toContainText("Tick the confirmation first");
  await reopen.getByRole("checkbox", { name: `I am reopening ${no}; its draft invoice stays a draft and is not issued.` }).check();
  await reopen.getByRole("checkbox", { name: /^No admin available: reopen now and notify the admin/ }).check();
  await reopen.getByRole("button", { name: "Reopen now and notify the admin" }).click();
  await expect(page.getByText(`${no} reopened. The admin has been told`)).toBeVisible();
  expect(await stored()).toMatchObject({ finished_at: null, stage: "machining" });
  const signOff = (await service.from("reopen_requests").select("approval_mode, status, reason, reopened_at, notified_at").eq("record_id", job!.id)).data!;
  expect(signOff).toMatchObject([{ approval_mode: "tick_box_notify", status: "pending", reason: "Finished by mistake, still deburring" }]);
  expect(signOff[0].reopened_at).not.toBeNull();
  expect(signOff[0].notified_at).not.toBeNull();
  const flow = (await service.from("job_flow_events").select("kind, reason").eq("job_id", job!.id).order("seq")).data!;
  expect(flow).toEqual([{ kind: "finish", reason: null }, { kind: "reopen", reason: "Finished by mistake, still deburring" }]);

  // 3. Finished again; the workshop finished it, so it can't record the pass.
  await page.goto("/jobs");
  await confirmFinish(page, row().getByRole("button", { name: "Finish", exact: true }));
  await expect(page.getByText("Job finished: Waiting for inspection")).toBeVisible();
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await row().getByRole("button", { name: "Inspected", exact: true }).click();
  const own = page.getByRole("dialog", { name: `Record inspection: ${no}` });
  await expect(own).toContainText("You finished this job, so someone else must inspect it.");
  await expect(own.getByRole("button", { name: "Record inspection" })).toBeDisabled();

  // 4. The office inspects it, with the acceptance criteria and the measured result: Complete.
  const office = await (await browser.newContext()).newPage();
  await signIn(office, w.tenants.alpha.users.office);
  await office.goto("/jobs");
  await office.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await office.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Inspected", exact: true }).click();
  const inspect = office.getByRole("dialog", { name: `Record inspection: ${no}` });
  await inspect.getByLabel("Acceptance criteria (required)").fill("Drawing FB-2 rev A: hole centres 50.00 +/-0.05");
  await inspect.getByLabel("Measured notes (required)").fill("Hole centres 50.01, 49.99 mm");
  await inspect.getByRole("button", { name: "Record inspection" }).click();
  await expect(office.getByText(`${no} inspected: Complete`)).toBeVisible();
  expect((await stored()).stage).toBe("complete");
  const [record] = (await service.from("job_inspections").select("result, independent, acceptance_criteria, inspector_name").eq("job_id", job!.id)).data!;
  expect(record).toEqual({ result: "pass", independent: true, acceptance_criteria: "Drawing FB-2 rev A: hole centres 50.00 +/-0.05", inspector_name: "Office alpha" });

  // 5. Still one draft for the job, and it now reads "Ready to issue".
  await office.goto("/invoices");
  await expect(office.getByRole("row").filter({ hasText: customer }).getByTestId("draft-job-stage")).toHaveText("Ready to issue");
  expect((await service.from("invoices").select("id").eq("job_id", job!.id)).data).toHaveLength(1);

  // 6. Reopen after the invoice is issued (113; orchestrator 30 Oct, from D30-5): the office issues the draft, then reopens the Complete
  // job through the sign-off. The confirmation names the issued invoice, no admin is about so the tick box reopens it now, and the
  // issued invoice and its lines are exactly as they were.
  const officeApi = await signedInClient(w.tenants.alpha.users.office);
  const { data: invoiceRef, error: issueError } = await officeApi.rpc("issue_invoice", { p_invoice: draft!.id });
  expect(issueError).toBeNull();
  const invoiceBefore = (await service.from("invoices").select("*").eq("id", draft!.id).single()).data;
  const linesBefore = (await service.from("invoice_line_items").select("*").eq("invoice_id", draft!.id).order("position")).data;
  expect(invoiceBefore?.invoice_ref).toBe(invoiceRef);
  await office.goto("/jobs");
  await office.getByRole("button", { name: /^Complete \(/ }).click();
  await office.getByRole("row").filter({ hasText: no }).getByRole("button", { name: "Reopen" }).click();
  const again = office.getByRole("dialog", { name: `Reopen ${no}` });
  await again.getByLabel(/^Reason/).fill("Customer reported a burr after invoicing");
  await again.getByRole("checkbox", { name: `I am reopening ${no}; the issued invoice ${invoiceRef} stays as it is.` }).check();
  await again.getByRole("checkbox", { name: /^No admin available: reopen now and notify the admin/ }).check();
  await again.getByRole("button", { name: "Reopen now and notify the admin" }).click();
  await expect(office.getByText(`${no} reopened. The admin has been told`)).toBeVisible();
  expect(await stored()).toMatchObject({ finished_at: null, stage: "machining" });
  expect((await service.from("invoices").select("*").eq("id", draft!.id).single()).data).toEqual(invoiceBefore);
  expect((await service.from("invoice_line_items").select("*").eq("invoice_id", draft!.id).order("position")).data).toEqual(linesBefore);
  const pastInvoice = (await service.from("reopen_requests").select("approval_mode, status, issued_invoices").eq("record_id", job!.id).eq("reason", "Customer reported a burr after invoicing")).data!;
  expect(pastInvoice).toEqual([{ approval_mode: "tick_box_notify", status: "pending", issued_invoices: [invoiceRef] }]);
});
