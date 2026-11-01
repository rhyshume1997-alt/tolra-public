/**
 * Decision 16 / migration 123, the way John works: the customer's PO goes on the QUOTE (shown beside its number), Mark Accepted starts
 * with it filled in, the job carries it and the job's draft invoice shows "Customer PO 4471". Sales Orders is never opened: no page load
 * of, and no navigation to, /sales-orders at any point (the order row the accept makes stays behind the scenes).
 */
import { expect, test } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { confirmSend, signIn, world } from "./helpers";

const w = world();

test("Customer PO 4471 on the quote reaches the job and the draft invoice, without Sales Orders", async ({ page }) => {
  test.setTimeout(180_000);
  const admin = adminClient();
  const org = w.tenants.beta.id;
  const customer = `PO Quote Co ${w.runId}`;
  expect((await admin.from("customers").insert({ organization_id: org, name: customer })).error).toBeNull();

  // Any page load of, or navigation to, Sales Orders (a background route prefetch is not a visit and is not counted).
  const salesOrderVisits: string[] = [];
  const isSalesOrders = (url: string) => new URL(url).pathname.startsWith("/sales-orders");
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame() && isSalesOrders(frame.url())) salesOrderVisits.push(`navigated ${frame.url()}`); });
  page.on("request", (request) => { if (request.resourceType() === "document" && isSalesOrders(request.url())) salesOrderVisits.push(`loaded ${request.url()}`); });

  await signIn(page, w.tenants.beta.users.office);

  // 1. The quote, with the customer's PO typed on it.
  await page.goto("/quotes");
  await page.getByRole("button", { name: "New quote" }).first().click();
  const builder = page.getByRole("dialog", { name: "Quote Builder" });
  await builder.getByRole("combobox").first().selectOption({ label: customer });
  await builder.getByLabel("Customer PO (optional)").fill("4471");
  await builder.getByRole("textbox", { name: "Description", exact: true }).fill("Bush");
  await builder.getByRole("spinbutton", { name: "Quantity" }).fill("2");
  await builder.getByRole("spinbutton", { name: "Unit price" }).fill("50");
  await builder.getByRole("button", { name: "Save Quote" }).click();
  await expect(builder).toBeHidden();
  const quoteRow = async () => (await admin.from("quotes").select("id, quote_ref, status, customer_po").eq("customer", customer).eq("organization_id", org).single()).data!;
  await expect.poll(async () => (await quoteRow()).customer_po).toBe("4471");
  const { id: quoteId, quote_ref: quoteRef } = await quoteRow();

  // 2. Shown beside the quote number.
  const draftCard = page.getByRole("region", { name: "Draft quotes" }).locator('[data-slot="card"]', { hasText: customer });
  await expect(draftCard.getByTestId("quote-customer-po")).toHaveText("Customer PO 4471");

  // 3. Sent (the PDF is made for attaching, then the person confirms it went).
  const download = page.waitForEvent("download");
  await draftCard.getByRole("button", { name: "Send", exact: true }).click();
  await confirmSend(page);
  await download;
  await page.getByRole("dialog", { name: /gone to the customer\?/ }).getByRole("button", { name: /sent it/ }).click();
  await expect.poll(async () => (await quoteRow()).status).toBe("sent");

  // 4. Mark Accepted: the dialog starts with the quote's PO.
  await page.reload();
  await page.getByRole("region", { name: "Sent quotes" }).locator('[data-slot="card"]', { hasText: customer }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${quoteRef} quote details` });
  await expect(details.getByTestId("quote-detail-customer-po")).toContainText("4471");
  await details.getByRole("button", { name: "Mark Accepted" }).click();
  const decision = page.getByRole("dialog", { name: `Mark ${quoteRef} as accepted?` });
  await expect(decision.getByLabel("Customer PO (optional)")).toHaveValue("4471");
  await decision.getByRole("button", { name: "Confirm Accepted" }).click();
  await expect.poll(async () => (await quoteRow()).status).toBe("accepted");

  // 5. The job carries the PO.
  const jobFor = async () => (await admin.from("jobs").select("id, job_no, customer_po, converted_from_sales_order_id").eq("quote_id", quoteId).eq("organization_id", org).maybeSingle()).data;
  await expect.poll(async () => (await jobFor())?.customer_po ?? null).toBe("4471");
  const job = (await jobFor())!;

  // 6. Finished and despatched (the order's lines sent out on a note), then the Job Finish draft (099 drafts what was despatched).
  const office = w.tenants.beta.users.office.id;
  await withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: office, role: "authenticated", aal: "aal2" })]);
      await db.query("select public.ensure_sales_order_lines($1)", [job.converted_from_sales_order_id]);
      await db.query("update public.jobs set started_at = now() - interval '1 hour', finished_at = now() where id = $1", [job.id]);
      const note = (await db.query<{ id: string }>(
        "insert into public.delivery_notes (organization_id, dn_number, customer, sales_order_id, job_id, status, delivery_date) values ($1, $2, $3, $4, $5, 'despatched', current_date) returning id",
        [org, `DLN-CPO-${w.runId}`, customer, job.converted_from_sales_order_id, job.id])).rows[0].id;
      await db.query(`insert into public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity, sales_order_line_id)
                      select l.organization_id, $1, l.position, l.description, l.quantity, l.id from public.sales_order_lines l where l.sales_order_id = $2`, [note, job.converted_from_sales_order_id]);
      await db.query("select public.job_finish_draft_invoice($1, $2)", [job.id, org]);
      await db.query("commit");
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
  const invoiceFor = async () => (await admin.from("invoices").select("id, status, customer_po").eq("job_id", job.id).maybeSingle()).data;
  await expect.poll(async () => (await invoiceFor())?.customer_po ?? null).toBe("4471");
  expect((await invoiceFor())!.status).toBe("draft");

  // 7. The draft invoice on screen says "Customer PO 4471".
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: customer }).getByRole("button", { name: "View" }).click();
  const invoice = page.getByRole("dialog", { name: /invoice details/ });
  await expect(invoice).toContainText(/Customer PO\s*4471/);

  // Sales Orders was never opened.
  expect(salesOrderVisits).toEqual([]);
});
