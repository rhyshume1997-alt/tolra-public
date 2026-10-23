/**
 * One customer, start to finish, every step on screen the way staff do it, with exact penny totals checked in the database at
 * every step: RFQ -> quote (draft, sent, accepted) -> sales order -> job -> inspection -> delivery note (from the order) -> invoice
 * (draft from the delivery note, issued) -> part payment -> final payment.
 *
 * The figures are chosen so that rounding matters: 3 x 33.33 = 99.99 net; VAT at 20% is 19.998, which is 20.00 (not 19.99);
 * gross 119.99; a part payment of 50.00 leaves 69.99.
 */
import { expect, test } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { confirmFinish, confirmSend, signIn, world } from "./helpers";

const w = world();
const pence = (n: unknown) => Math.round(Number(n) * 100);
const tag = () => w.runId.slice(0, 6);
const in7Days = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

test("customer journey: RFQ to quote to order to job to delivery note to invoice to payment, to the penny", async ({ page }) => {
  test.setTimeout(240_000);
  const admin = adminClient();
  const org = w.tenants.alpha.id; // tenant beta's money is asserted exactly by receivables.spec
  const customer = `Journey Ltd ${tag()}`;
  const customerPo = `CPO-${tag()}`;
  expect((await admin.from("customers").insert({ organization_id: org, name: customer, email: `journey.${tag()}@example.test` })).error).toBeNull();
  await signIn(page, w.tenants.alpha.users.admin);

  // 1. RFQ.
  await page.goto("/rfq");
  await page.getByRole("button", { name: /New RFQ/ }).first().click();
  const rfqDialog = page.getByRole("dialog", { name: "Create New RFQ" });
  await rfqDialog.getByRole("textbox", { name: "Customer" }).fill(customer);
  await rfqDialog.getByRole("textbox", { name: "Description" }).fill("Three brackets");
  await rfqDialog.getByRole("button", { name: "Save RFQ" }).click();
  await expect(rfqDialog).toBeHidden();
  const rfqCard = () => page.locator('[data-slot="card"]', { hasText: customer });
  await expect(rfqCard()).toContainText("Outstanding");

  // 2. Quote from the RFQ: 3 x 33.33 at 20% VAT.
  await rfqCard().getByRole("link", { name: "Quote" }).click();
  const builder = page.getByRole("dialog", { name: /Quote Builder: RFQ from/ });
  await builder.getByLabel("Valid until").fill(in7Days());
  await builder.getByRole("textbox", { name: "Description", exact: true }).fill("Bracket");
  await builder.getByRole("spinbutton", { name: "Quantity" }).fill("3");
  await builder.getByRole("spinbutton", { name: "Unit price" }).fill("33.33");
  await builder.getByRole("button", { name: "Save Quote" }).click();
  await expect(builder).toBeHidden();
  const quoteRow = async () => (await admin.from("quotes").select("id, quote_ref, status, total_value, rfq_id").eq("customer", customer).single()).data!;
  const draft = await quoteRow();
  expect({ status: draft.status, total: pence(draft.total_value) }).toEqual({ status: "draft", total: 11999 });
  const quoteRef = draft.quote_ref as string;
  const lines = (await admin.from("quote_line_items").select("quantity, unit_price, vat_pct").eq("quote_id", draft.id)).data!;
  expect(lines.map((l) => [Number(l.quantity), pence(l.unit_price), Number(l.vat_pct)])).toEqual([[3, 3333, 20]]);

  // 3. Send it (the PDF is made for attaching, then the person confirms it went), 4. the customer accepts.
  await page.goto("/quotes");
  const draftCard = page.getByRole("region", { name: "Draft quotes" }).locator('[data-slot="card"]', { hasText: customer });
  const download = page.waitForEvent("download");
  await draftCard.getByRole("button", { name: "Send", exact: true }).click();
  await confirmSend(page);
  await download;
  await page.getByRole("dialog", { name: /gone to the customer\?/ }).getByRole("button", { name: /sent it/ }).click();
  await expect.poll(async () => (await quoteRow()).status).toBe("sent");
  expect(pence((await quoteRow()).total_value)).toBe(11999);

  await page.reload();
  await page.getByRole("region", { name: "Sent quotes" }).locator('[data-slot="card"]', { hasText: customer }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${quoteRef} quote details` });
  // 4b. Accepting with the customer's PO makes the sales order and, the company's setting being automatic (the default), its job (058).
  const quoteJobNo = `J-${quoteRef.replace(/\D/g, "").replace(/^0+(?=\d{4})/, "")}`;
  const numberTaken = ((await admin.from("jobs").select("id").eq("organization_id", org).eq("job_no", quoteJobNo)).data ?? []).length > 0;
  await details.getByRole("button", { name: "Mark Accepted" }).click();
  await page.getByRole("dialog", { name: `Mark ${quoteRef} as accepted?` }).getByLabel("Customer PO (optional)").fill(customerPo);
  await page.getByRole("button", { name: "Confirm Accepted" }).click();
  await expect.poll(async () => (await quoteRow()).status).toBe("accepted");
  expect(pence((await quoteRow()).total_value)).toBe(11999);

  // 5. The sales order made from the accepted quote: referenced by the customer's PO, held at the NET value, 99.99.
  await expect.poll(async () => ((await admin.from("sales_orders").select("id").eq("quote_id", draft.id)).data ?? []).length).toBe(1);
  const order = (await admin.from("sales_orders").select("id, total_value, quote_ref, customer_po").eq("so_number", customerPo).single()).data!;
  expect({ total: pence(order.total_value), quote: order.quote_ref, po: order.customer_po }).toEqual({ total: 9999, quote: quoteRef, po: customerPo });
  await page.goto("/sales-orders");
  // Already converted: Convert to Job is not offered again.
  // A converted order with its PO is finished, so it is under Done, not Open (028); there Convert to Job is not shown.
  await expect(page.getByRole("row").filter({ hasText: customerPo })).toHaveCount(0);
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^Done \(/ }).click();
  await expect(page.getByRole("row").filter({ hasText: customerPo }).getByRole("button", { name: "Convert to Job" })).toHaveCount(0); // hidden once converted

  // 6. Job: the quote's number (when no other job in this company already has it, which depends on what ran before), the net value, the quantity and the workshop's description (no prices).
  const job = (await admin.from("jobs").select("id, job_no, quantity_required, specification, customer_po, started_at").eq("converted_from_sales_order_id", order.id).single()).data!;
  expect({ po: job.customer_po, started: job.started_at }).toEqual({ po: customerPo, started: null });
  if (numberTaken) expect(job.job_no).toMatch(/^J-\d+$/); // taken already: the next J number, never a duplicate
  else expect(job.job_no).toBe(quoteJobNo);
  if (numberTaken) expect(job.job_no).not.toBe(quoteJobNo);
  expect(job.quantity_required).toBe(3);
  expect(job.specification).toContain("Bracket x 3");
  expect(job.specification).not.toMatch(/33\.33|99\.99|119\.99/);
  const value = (await admin.from("job_values").select("value").eq("job_id", job.id).single()).data!;
  expect(pence(value.value)).toBe(9999);

  // 7. The job is finished and inspected (a pass records who measured what; nothing is despatched before that), then a delivery note
  // is made from the sales order for all three, with no invoice number needed first, and sent out.
  await page.goto("/jobs");
  await confirmFinish(page, page.getByRole("row").filter({ hasText: job.job_no }).getByRole("button", { name: "Finish", exact: true }));
  await page.getByRole("button", { name: /^Waiting for inspection/ }).click();
  await page.getByRole("row").filter({ hasText: job.job_no }).getByRole("button", { name: "Inspected", exact: true }).click();
  const inspection = page.getByRole("dialog", { name: `Record inspection: ${job.job_no}` });
  await inspection.getByLabel("Acceptance criteria (required)").fill("Drawing BR-1: length 60.00 +/-0.1, bore 25.00 +0.03/-0");
  await inspection.getByLabel("Measured notes (required)").fill("Length 60.00 mm, bore 25.01 mm on all three");
  // 081: the admin finished this job, so the pass isn't independent: it is recorded with the admin's reason (internal only).
  await inspection.getByLabel(/Reason you are inspecting it yourself/).fill("Sole inspector on site for this run");
  await inspection.getByRole("button", { name: "Record inspection" }).click();
  await expect(page.getByText(`${job.job_no} inspected: Complete`)).toBeVisible();

  const counter = await withDb(async (db) => (await db.query("select coalesce(max(last), 0)::int as last from public.doc_counters where organization_id = $1 and prefix = 'INV'", [org])).rows[0].last as number);
  const invoiceRef = `INV-${String(counter + 1).padStart(4, "0")}`;
  await page.goto("/delivery-notes");
  await page.getByRole("button", { name: "New delivery note" }).first().click();
  const noteForm = page.getByRole("dialog", { name: "New Delivery Note" });
  await noteForm.getByRole("button", { name: "From a sales order" }).click(); // the form opens on "From a job" once jobs exist
  await noteForm.getByLabel("Sales order").selectOption({ label: `${customerPo} - ${customer}` });
  await expect(noteForm.getByLabel("Quantity to despatch: Bracket")).toHaveValue("3");
  await noteForm.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(noteForm).toBeHidden();
  const note = (await admin.from("delivery_notes").select("id, dn_number, customer, job_ref, sales_order_id, invoice_ref").eq("customer", customer).single()).data!;
  expect(note.dn_number).toMatch(/^DLN-\d+$/);
  expect({ order: note.sales_order_id, job: note.job_ref, invoice: note.invoice_ref }).toEqual({ order: order.id, job: job.job_no, invoice: null });
  const noteItems = (await admin.from("delivery_note_items").select("description, quantity").eq("delivery_note_id", note.id)).data!;
  expect(noteItems.map((i) => [i.description, Number(i.quantity)])).toEqual([["Bracket", 3]]);
  await page.getByRole("row").filter({ hasText: note.dn_number }).getByRole("button", { name: "Mark Despatched" }).click();
  await expect.poll(async () => (await admin.from("delivery_notes").select("status").eq("id", note.id).single()).data?.status).toBe("despatched");

  // 8. Invoice: the job's draft was made when it was finished, at the order's price (081: no figures typed, no number, one draft per
  // job; the note sent out went on it), and it reads "Ready to issue" now the job is Complete; then a person issues it.
  await page.goto("/invoices");
  await expect(page.getByRole("row").filter({ hasText: customer }).getByTestId("draft-job-stage")).toHaveText("Ready to issue");
  const invoice = async () => (await admin.from("invoices").select("id, invoice_ref, status, subtotal, vat, total, amount_paid, customer_po, quote_ref").eq("customer", customer).single()).data!;
  const drafted = await invoice();
  expect({ ref: drafted.invoice_ref, status: drafted.status, sub: pence(drafted.subtotal), vat: pence(drafted.vat), total: pence(drafted.total) }).toEqual({ ref: null, status: "draft", sub: 9999, vat: 2000, total: 11999 });

  await page.getByRole("row").filter({ hasText: customer }).getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog", { name: /invoice details/ }).getByRole("button", { name: "Issue Invoice" }).click();
  await page.getByRole("dialog", { name: `Issue this invoice to ${customer}?` }).getByRole("button", { name: "Issue Invoice" }).click();
  await expect.poll(async () => (await invoice()).invoice_ref).toBe(invoiceRef);
  const issued = await invoice();
  expect({ status: issued.status, sub: pence(issued.subtotal), vat: pence(issued.vat), total: pence(issued.total), paid: pence(issued.amount_paid), po: issued.customer_po, quote: issued.quote_ref })
    .toEqual({ status: "issued", sub: 9999, vat: 2000, total: 11999, paid: 0, po: customerPo, quote: quoteRef });

  // 9. Payments: part, then the rest. The balance is exact at each step.
  await page.reload();
  const row = () => page.getByRole("row").filter({ hasText: invoiceRef });
  await row().getByRole("button", { name: "Record payment" }).click();
  const pay = page.getByRole("dialog", { name: `Record a payment on ${invoiceRef}` });
  await expect(pay.getByLabel("Amount received")).toHaveValue("119.99");
  await pay.getByLabel("Amount received").fill("50");
  await pay.getByRole("button", { name: "Save payment" }).click();
  await expect(pay).toBeHidden();
  await expect(row()).toContainText("£50.00 paid, £69.99 still owed");
  expect(await invoice()).toMatchObject({ status: "partial" });
  expect(pence((await invoice()).amount_paid)).toBe(5000);

  await row().getByRole("button", { name: "Record payment" }).click();
  const rest = page.getByRole("dialog", { name: `Record a payment on ${invoiceRef}` });
  await expect(rest.getByLabel("Amount received")).toHaveValue("69.99");
  await rest.getByRole("button", { name: "Save payment" }).click();
  await expect(page.getByText(`${invoiceRef} paid in full`)).toBeVisible();
  await expect.poll(async () => (await invoice()).status).toBe("paid");
  const paid = await invoice();
  expect(pence(paid.amount_paid)).toBe(11999);
  const payments = (await admin.from("invoice_payments").select("amount").eq("invoice_id", paid.id).order("created_at")).data!;
  expect(payments.map((p) => pence(p.amount))).toEqual([5000, 6999]);
  expect(payments.reduce((sum, p) => sum + pence(p.amount), 0)).toBe(pence(paid.total));
});
