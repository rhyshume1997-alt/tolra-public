/**
 * Sales Orders OFF, which is how a new company starts (lib/sales-orders-switch): no menu item, /sales-orders sends the person to Quotes
 * with a notice, and accepting a quote still makes the internal sales order and the job, with the customer's PO carried through to the
 * order, the job and the draft invoice, without Sales Orders ever being opened.
 *
 * Runs in its own company (createSoloTenant with salesOrders: false), because createSyntheticWorld switches Sales Orders ON for alpha and
 * beta. Nothing shared is changed; the company carries the run id, so teardown removes it with the rest of the run.
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { salesOrdersEnabled } from "@/lib/sales-orders-switch";

import { adminClient, createSoloTenant, withDb } from "../support/fixtures";
import { confirmSend, signIn, world } from "./helpers";

const w = world();

/** The exact text of SALES_ORDERS_OFF_NOTICE (lib/sales-orders-switch.ts), shown by components/sales-orders-gate.tsx. */
const OFF_NOTICE = "Sales Orders is switched off for your company. An admin can switch it on in Settings > Menu.";

test("Sales Orders off (the default): no menu item, /sales-orders goes to Quotes, and accepting a quote still makes the order, the job and the PO", async ({ page }) => {
  test.setTimeout(240_000);
  const admin = adminClient();
  const solo = await createSoloTenant(w.runId, `so-off-${randomUUID().slice(0, 6)}`, undefined, { salesOrders: false });
  const org = solo.id;
  const customer = `SO Off Co ${w.runId}`;
  expect((await admin.from("customers").insert({ organization_id: org, name: customer })).error).toBeNull();

  // 0. The company really is on the default: the "sales-orders:on" marker is absent (and so is the old plain hide).
  const settings = await admin.from("organization_settings").select("hidden_nav").eq("organization_id", org).single();
  expect(settings.error).toBeNull();
  const hiddenNav = (settings.data!.hidden_nav ?? []) as string[];
  expect(hiddenNav).not.toContain("sales-orders:on");
  expect(hiddenNav).not.toContain("sales-orders");
  expect(salesOrdersEnabled(hiddenNav)).toBe(false);

  // Any page load of, or navigation to, Sales Orders (a background route prefetch is not a visit and is not counted).
  const salesOrderVisits: string[] = [];
  const isSalesOrders = (url: string) => new URL(url).pathname.startsWith("/sales-orders");
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame() && isSalesOrders(frame.url())) salesOrderVisits.push(`navigated ${frame.url()}`); });
  page.on("request", (request) => { if (request.resourceType() === "document" && isSalesOrders(request.url())) salesOrderVisits.push(`loaded ${request.url()}`); });

  await page.setViewportSize({ width: 1280, height: 720 });
  await signIn(page, solo.admin);

  // 1. No Sales Orders item in the fixed sidebar (desktop) or in the drawer (phone width). "Quote Generator" being there shows the menu is drawn.
  await page.goto("/quotes");
  const sidebar = page.locator("aside");
  await expect(sidebar.getByRole("link", { name: "Quote Generator" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Sales Orders" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("link", { name: "Quote Generator" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Sales Orders" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });

  // 2. A pasted or bookmarked address ends on Quotes, with the notice. This is the one deliberate visit to /sales-orders.
  await page.goto("/sales-orders");
  await page.waitForURL(/\/quotes$/);
  await expect(page.locator("[data-sonner-toast]", { hasText: OFF_NOTICE })).toBeVisible();
  const deliberate = salesOrderVisits.splice(0);
  expect(deliberate.some((visit) => visit.startsWith("loaded")), "the deliberate visit was seen by the tracker").toBe(true);

  // 3. The quote, with the customer's PO typed on it (as tests/e2e/quote-customer-po.spec.ts).
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

  // 4. Sent (the PDF is made for attaching, then the person confirms it went).
  const draftCard = page.getByRole("region", { name: "Draft quotes" }).locator('[data-slot="card"]', { hasText: customer });
  const download = page.waitForEvent("download");
  await draftCard.getByRole("button", { name: "Send", exact: true }).click();
  await confirmSend(page);
  await download;
  await page.getByRole("dialog", { name: /gone to the customer\?/ }).getByRole("button", { name: /sent it/ }).click();
  await expect.poll(async () => (await quoteRow()).status).toBe("sent");

  // 5. Mark Accepted: the dialog starts with the quote's PO.
  await page.reload();
  await page.getByRole("region", { name: "Sent quotes" }).locator('[data-slot="card"]', { hasText: customer }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${quoteRef} quote details` });
  await expect(details.getByTestId("quote-detail-customer-po")).toContainText("4471");
  await details.getByRole("button", { name: "Mark Accepted" }).click();
  const decision = page.getByRole("dialog", { name: `Mark ${quoteRef} as accepted?` });
  await expect(decision.getByLabel("Customer PO (optional)")).toHaveValue("4471");
  await decision.getByRole("button", { name: "Confirm Accepted" }).click();
  await expect.poll(async () => (await quoteRow()).status).toBe("accepted");

  // 6. The internal sales order and the job are made anyway, and both carry the PO (checked in the database; there is no screen for the order).
  const orderFor = async () => (await admin.from("sales_orders").select("id, so_number, customer_po, converted_to_job_id").eq("quote_id", quoteId).eq("organization_id", org).maybeSingle()).data;
  await expect.poll(async () => (await orderFor())?.customer_po ?? null).toBe("4471");
  const order = (await orderFor())!;
  const jobFor = async () => (await admin.from("jobs").select("id, job_no, customer_po, converted_from_sales_order_id").eq("quote_id", quoteId).eq("organization_id", org).maybeSingle()).data;
  await expect.poll(async () => (await jobFor())?.customer_po ?? null).toBe("4471");
  const job = (await jobFor())!;
  expect(job.converted_from_sales_order_id).toBe(order.id);
  expect(order.converted_to_job_id).toBe(job.id);

  // 7. Finished and despatched (the order's lines sent out on a note), then the Job Finish draft (099 drafts what was despatched).
  await withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: solo.admin.id, role: "authenticated", aal: "aal2" })]);
      await db.query("select public.ensure_sales_order_lines($1)", [order.id]);
      await db.query("update public.jobs set started_at = now() - interval '1 hour', finished_at = now() where id = $1", [job.id]);
      const note = (await db.query<{ id: string }>(
        "insert into public.delivery_notes (organization_id, dn_number, customer, sales_order_id, job_id, status, delivery_date) values ($1, $2, $3, $4, $5, 'despatched', current_date) returning id",
        [org, `DLN-SOFF-${w.runId}`, customer, order.id, job.id])).rows[0].id;
      await db.query(`insert into public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity, sales_order_line_id)
                      select l.organization_id, $1, l.position, l.description, l.quantity, l.id from public.sales_order_lines l where l.sales_order_id = $2`, [note, order.id]);
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

  // 8. The draft invoice on screen says "Customer PO 4471".
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: customer }).getByRole("button", { name: "View" }).click();
  const invoice = page.getByRole("dialog", { name: /invoice details/ });
  await expect(invoice).toContainText(/Customer PO\s*4471/);

  // Sales Orders was not opened again after the deliberate visit in step 2.
  expect(salesOrderVisits).toEqual([]);
});
