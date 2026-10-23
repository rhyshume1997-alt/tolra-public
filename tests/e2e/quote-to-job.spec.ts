/**
 * The native commercial path (audit B4b: D1, with B2; automatic since 058): a sent quote is accepted, and that one step makes its
 * sales order at its net value and the order's one job, not started. A decision is final and the accepted quote no longer offers
 * actions. Accepted without the customer's PO, the order has a provisional number until "Add customer PO".
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("quote -> accepted -> sales order -> job", async ({ page }) => {
  const tag = w.runId;
  const customer = `Journey Co ${tag}`;
  const ref = `QUO-${tag.slice(0, 4).replace(/\D/g, "7")}9`;
  expect((await adminClient().from("customers").insert({ organization_id: w.tenants.beta.id, name: customer })).error).toBeNull();
  const office = await signedInClient(w.tenants.beta.users.admin);
  const { error } = await office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 300, vat_enabled: true, status: "sent", valid_until: "2099-12-31", description: "Machine 10 bushes" },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: [{ position: 0, description: "Bush 40mm", quantity: 10, unit_price: 25, vat_pct: 20, vat_exempt: false }],
  });
  expect(error).toBeNull();

  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/quotes");
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} quote details` });
  await details.getByRole("button", { name: "Mark Accepted" }).click();
  await page.getByRole("dialog", { name: `Mark ${ref} as accepted?` }).getByLabel("Customer PO (optional)").fill(`PO-J-${tag}`);
  await page.getByRole("button", { name: "Confirm Accepted" }).click();
  await expect.poll(async () => (await adminClient().from("quotes").select("status, accepted_at").eq("quote_ref", ref).single()).data?.status).toBe("accepted");
  await expect(details.getByRole("button", { name: "Mark Accepted" })).toHaveCount(0);
  const { data: quoteRow } = await adminClient().from("quotes").select("id").eq("quote_ref", ref).eq("organization_id", w.tenants.beta.id).single();
  // The decision reaches the audit log once, written by the database with what it made (058).
  await expect
    .poll(() =>
      withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.audit_log where action = 'ACCEPT' and entity_table = 'quotes' and entity_id = $1 and organization_id = $2", [quoteRow!.id, w.tenants.beta.id])).rows[0].n),
    )
    .toBe(1);

  // The one step made the sales order (the customer's PO, the net value, the quote) and its job.
  const { data: orders } = await adminClient().from("sales_orders").select("id, so_number, customer_po, total_value, quote_ref, status").eq("quote_id", quoteRow!.id);
  expect(orders).toHaveLength(1);
  const order = orders![0];
  expect({ so: order.so_number, po: order.customer_po, value: Number(order.total_value), quote: order.quote_ref, status: order.status })
    .toEqual({ so: `PO-J-${tag}`, po: `PO-J-${tag}`, value: 250, quote: ref, status: "converted" });
  const { data: jobs } = await adminClient().from("jobs").select("id, job_no, specification, quantity_required, customer_po, started_at").eq("converted_from_sales_order_id", order.id);
  expect(jobs).toHaveLength(1);
  expect(jobs![0].specification).toContain("Bush 40mm x 10");
  expect(jobs![0].quantity_required).toBe(10);
  expect({ po: jobs![0].customer_po, started: jobs![0].started_at }).toEqual({ po: `PO-J-${tag}`, started: null });
  await expect(page.getByText(`Sales order PO-J-${tag} created and job ${jobs![0].job_no} made, not started.`)).toBeVisible();
  // One click from the toast opens that job on the Job Board, scrolled to and highlighted (the link names the job by id).
  await page.getByRole("button", { name: `Open job ${jobs![0].job_no}` }).click();
  await page.waitForURL(`**/jobs?job=${jobs![0].id}`);
  await expect(page.locator(`[data-job-id="${jobs![0].id}"][data-highlighted="true"]:visible`).first()).toBeVisible();

  // On Sales Orders it is already converted: Convert to Job is not offered again, and no second order can be made for the quote.
  await page.goto("/sales-orders");
  // A converted order with its PO is finished, so it is under Done, not Open (028); there Convert to Job is not shown.
  await expect(page.getByRole("row").filter({ hasText: `PO-J-${tag}` })).toHaveCount(0);
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^Done \(/ }).click();
  await expect(page.getByRole("row").filter({ hasText: `PO-J-${tag}` }).getByRole("button", { name: "Convert to Job" })).toHaveCount(0); // hidden once converted
});

test("accepted with no customer PO: a provisional SO number, then Add customer PO gives the order and its job the PO", async ({ page }) => {
  const tag = w.runId;
  const customer = `Provisional Co ${tag}`;
  const ref = `QP-${tag.slice(0, 6)}`;
  expect((await adminClient().from("customers").insert({ organization_id: w.tenants.beta.id, name: customer })).error).toBeNull();
  const office = await signedInClient(w.tenants.beta.users.admin);
  expect((await office.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status: "sent", valid_until: "2099-12-31", description: "Provisional" },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: [{ position: 0, description: "Shaft", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
  })).error).toBeNull();

  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/quotes");
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog", { name: `${ref} quote details` }).getByRole("button", { name: "Mark Accepted" }).click();
  await page.getByRole("button", { name: "Confirm Accepted" }).click();
  const { data: quoteRow } = await adminClient().from("quotes").select("id").eq("quote_ref", ref).eq("organization_id", w.tenants.beta.id).single();
  await expect.poll(async () => ((await adminClient().from("sales_orders").select("id").eq("quote_id", quoteRow!.id)).data ?? []).length).toBe(1);
  const { data: order } = await adminClient().from("sales_orders").select("id, so_number, customer_po, converted_to_job_id").eq("quote_id", quoteRow!.id).single();
  expect(order!.so_number).toMatch(/^SO-\d{4,}$/);
  expect(order!.customer_po).toBeNull();
  expect(order!.converted_to_job_id).toBeTruthy();

  await page.goto("/sales-orders");
  await page.getByRole("button", { name: `Add customer PO to ${order!.so_number}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Add customer PO to ${order!.so_number}`, exact: true });
  await dialog.getByLabel("Customer PO").fill(`PO-P-${tag}`);
  await dialog.getByRole("button", { name: "Save customer PO" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: `PO-P-${tag}` })).toBeVisible();
  const { data: after } = await adminClient().from("sales_orders").select("so_number, customer_po").eq("id", order!.id).single();
  expect(after).toEqual({ so_number: `PO-P-${tag}`, customer_po: `PO-P-${tag}` });
  expect((await adminClient().from("jobs").select("customer_po").eq("id", order!.converted_to_job_id).single()).data?.customer_po).toBe(`PO-P-${tag}`);
});

test("sales order from a quote: switching clears the old value at once, saving waits for the lines, VAT is the quote's, mixed VAT or a rounding difference refused (R2, R3)", async ({ page }) => {
  const tag = w.runId;
  const customer = `Link Co ${tag}`;
  expect((await adminClient().from("customers").insert({ organization_id: w.tenants.beta.id, name: customer })).error).toBeNull();
  const office = await signedInClient(w.tenants.beta.users.admin);
  const quote = async (suffix: string, vatEnabled: boolean, total: number, lines: { quantity: number; unit_price: number; vat_pct: number }[]) => {
    const ref = `QL-${suffix}-${tag.slice(0, 6)}`;
    const { error } = await office.rpc("create_with_lines", {
      p_parent: "quotes",
      p_header: { quote_ref: ref, customer, total_value: total, vat_enabled: vatEnabled, status: "sent", valid_until: "2099-12-31", description: "Link test" },
      p_child: "quote_line_items",
      p_fk: "quote_id",
      p_lines: lines.map((line, position) => ({ position, description: `Part ${position}`, vat_exempt: false, ...line })),
    });
    expect(error).toBeNull();
    const { data: accepted, error: acceptError } = await office.from("quotes").update({ status: "accepted" }).eq("quote_ref", ref).select("id");
    expect(acceptError).toBeNull();
    expect(accepted).toHaveLength(1);
    return ref;
  };
  const reduced = await quote("A", true, 105, [{ quantity: 4, unit_price: 25, vat_pct: 5 }]); // £100 net at 5%
  const noVat = await quote("B", false, 40, [{ quantity: 2, unit_price: 20, vat_pct: 20 }]); // £40 net, VAT off
  const mixed = await quote("C", true, 22.5, [{ quantity: 1, unit_price: 10, vat_pct: 20 }, { quantity: 1, unit_price: 10, vat_pct: 5 }]);
  // Per-line VAT rounding: 1p + 1p on the quote (8p gross); 1p on one 6p order line (7p gross).
  const pennies = await quote("D", true, 0.08, [{ quantity: 1, unit_price: 0.03, vat_pct: 20 }, { quantity: 1, unit_price: 0.03, vat_pct: 20 }]);

  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/sales-orders");
  await page.getByRole("button", { name: /New sales order/ }).first().click();
  const form = page.getByRole("dialog", { name: "New Sales Order" });
  const picker = form.getByRole("combobox").first();
  const value = form.getByPlaceholder("0.00");
  const save = form.getByRole("button", { name: "Save Sales Order" });

  await picker.selectOption({ label: `${reduced} - ${customer}` });
  await expect(value).toHaveValue("100");

  // The next quote's lines are slow: the old value is gone at once and the order can't be saved meanwhile.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/rest/v1/quote_line_items*", async (route) => { await held; await route.continue(); });
  await picker.selectOption({ label: `${noVat} - ${customer}` });
  await expect(value).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(form.getByText("Loading the quote's lines...")).toBeVisible();
  release();
  await expect(value).toHaveValue("40");
  await page.unroute("**/rest/v1/quote_line_items*");
  await expect(save).toBeEnabled();

  // Mixed rates can't be held by one order: refused, not blended.
  await picker.selectOption({ label: `${mixed} - ${customer}` });
  await expect(form.getByText("That quote has lines at different VAT rates.")).toBeVisible();
  await expect(value).toHaveValue("");
  await expect(save).toBeDisabled();

  // The order's rounded VAT and gross must match the accepted quote's: 7p against 8p is refused.
  await picker.selectOption({ label: `${pennies} - ${customer}` });
  await expect(form.getByText(/would come to £0\.07 \(VAT £0\.01\), but the accepted quote is £0\.08 \(VAT £0\.02\)/)).toBeVisible();
  await expect(value).toHaveValue("");
  await expect(save).toBeDisabled();

  // Back to the VAT-off quote and save: the order carries the quote's net value and its VAT setting.
  await picker.selectOption({ label: `${noVat} - ${customer}` });
  await expect(value).toHaveValue("40");
  await form.getByPlaceholder("Customer order number (their PO)").fill(`PO-L-${tag}`);
  await save.click();
  await expect(form).toBeHidden();
  const { data: linked } = await adminClient().from("sales_orders").select("total_value, vat_enabled, quote_ref").eq("so_number", `PO-L-${tag}`).single();
  expect({ value: Number(linked?.total_value), vat: linked?.vat_enabled, quote: linked?.quote_ref }).toEqual({ value: 40, vat: false, quote: noVat });

  // The 5% quote keeps its rate.
  await page.getByRole("button", { name: /New sales order/ }).first().click();
  await picker.selectOption({ label: `${reduced} - ${customer}` });
  await expect(value).toHaveValue("100");
  await form.getByPlaceholder("Customer order number (their PO)").fill(`PO-R-${tag}`);
  await save.click();
  await expect(form).toBeHidden();
  const { data: rated } = await adminClient().from("sales_orders").select("total_value, vat_enabled, vat_pct, vat_exempt").eq("so_number", `PO-R-${tag}`).single();
  expect({ value: Number(rated?.total_value), vat: rated?.vat_enabled, pct: Number(rated?.vat_pct), exempt: rated?.vat_exempt }).toEqual({ value: 100, vat: true, pct: 5, exempt: false });

  // An order with no quote is still entered by hand.
  await page.getByRole("button", { name: /New sales order/ }).first().click();
  await picker.selectOption({ label: `${mixed} - ${customer}` });
  await expect(save).toBeDisabled();
  await picker.selectOption({ index: 0 });
  await form.getByPlaceholder("Customer order number (their PO)").fill(`PO-M-${tag}`);
  await value.fill("12.50");
  await save.click();
  await expect(form).toBeHidden();
  const { data: manual } = await adminClient().from("sales_orders").select("total_value, quote_ref").eq("so_number", `PO-M-${tag}`).single();
  expect({ value: Number(manual?.total_value), quote: manual?.quote_ref }).toEqual({ value: 12.5, quote: null });
});
