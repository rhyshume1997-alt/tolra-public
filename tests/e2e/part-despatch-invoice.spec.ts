/**
 * Migration 099 in the browser: a part despatch drafts only what went out; the draft editor shows each line's balance (despatched,
 * on other invoices, the most this draft may bill), refuses more with a clear message (and the database refuses it too), and saves
 * up to it, keeping the line's order-line link. A line taken off a draft is free again, and the editor offers to add it back.
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);

test("part despatch -> draft bills what went out -> the editor holds it to the balance", async ({ page }) => {
  const service = adminClient();
  const org = w.tenants.alpha.id;
  const customer = `Part Despatch ${tag()} Ltd`;
  const so = `PO-PART-${tag()}`;
  const { data: order, error } = await service.from("sales_orders").insert({ organization_id: org, so_number: so, customer_po: so, customer, total_value: 200, vat_enabled: true, vat_pct: 20, status: "open" }).select("id").single();
  expect(error).toBeNull();
  const { data: line } = await service.from("sales_order_lines").insert({ organization_id: org, sales_order_id: order!.id, position: 0, description: "Bracket", quantity: 10, unit_price: 20, vat_pct: 20, vat_exempt: false }).select("id").single();

  // Two parts go out (4, then 6), each sent out by a signed-in person: each drafts what it took.
  const office = await signedInClient(w.tenants.alpha.users.office);
  const today = new Date().toISOString().slice(0, 10);
  const send = async (quantity: number) => {
    const made = await office.rpc("create_delivery_note", { p_order: order!.id, p_job: null, p_ship_date: today, p_tax_date: today, p_ship_via: null, p_notes: null, p_lines: [{ line_id: line!.id, quantity }] });
    expect(made.error).toBeNull();
    expect((await office.from("delivery_notes").update({ status: "despatched" }).eq("id", made.data.id).select("id")).error).toBeNull();
    return (await service.from("delivery_notes").select("invoice_id").eq("id", made.data.id).single()).data!.invoice_id as string;
  };
  const first = await send(4);
  const second = await send(6);
  expect(first).not.toBe(second);
  const lineOf = async (invoice: string) => (await service.from("invoice_line_items").select("quantity, sales_order_line_id").eq("invoice_id", invoice)).data;
  expect(await lineOf(first)).toEqual([{ quantity: 4, sales_order_line_id: line!.id }]);
  expect(await lineOf(second)).toEqual([{ quantity: 6, sales_order_line_id: line!.id }]);

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto(`/invoices?invoice=${first}`);
  const details = page.getByRole("dialog", { name: /invoice details/ });
  await details.getByRole("button", { name: "Edit Draft" }).click();
  const editor = page.getByRole("dialog", { name: `Edit draft invoice for ${customer}` });
  await expect(editor.getByTestId("line-balance-0")).toHaveText("Despatched 10 of 10, 6 on other invoices: up to 4 on this draft.");

  // More than the balance: shown at once, and the save is refused; nothing changes.
  await editor.getByLabel("Line 1 quantity").fill("5");
  const message = 'Line 1: only 4 of "Bracket" can be billed on this draft (10 despatched, 6 on other invoices). The rest is billed when it is despatched.';
  await expect(editor.getByTestId("over-balance")).toHaveText(message);
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(message).last()).toBeVisible();
  expect(await lineOf(first)).toEqual([{ quantity: 4, sales_order_line_id: line!.id }]);

  // Less is saved, and the line keeps its link.
  await editor.getByLabel("Line 1 quantity").fill("3");
  await expect(editor.getByTestId("over-balance")).toHaveCount(0);
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft invoice updated")).toBeVisible();
  await expect.poll(() => lineOf(first)).toEqual([{ quantity: 3, sales_order_line_id: line!.id }]);
  await expect.poll(async () => (await service.from("invoices").select("subtotal, vat, total").eq("id", first).single()).data).toEqual({ subtotal: 60, vat: 12, total: 72 });

  // The database holds the same line even without the screen: a direct write of more is refused.
  const direct = await office.from("invoice_line_items").update({ quantity: 5 }).eq("invoice_id", first).select("id");
  expect(direct.error).toMatchObject({ code: "22023", hint: "over_despatched" });

  // The 1 bracket taken off is free again: it is on the second draft's own order line, so that line's balance shows it, up to 7.
  await page.goto(`/invoices?invoice=${second}`);
  await details.getByRole("button", { name: "Edit Draft" }).click();
  await expect(editor.getByTestId("line-balance-0")).toHaveText("Despatched 10 of 10, 3 on other invoices: up to 7 on this draft.");
  await editor.getByLabel("Line 1 quantity").fill("7");
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft invoice updated")).toBeVisible();
  await expect.poll(() => lineOf(second)).toEqual([{ quantity: 7, sales_order_line_id: line!.id }]);
});

test("a line deleted from a draft is offered back as despatched, not yet invoiced, and added with its order link", async ({ page }) => {
  const service = adminClient();
  const org = w.tenants.alpha.id;
  const customer = `Part Freed ${tag()} Ltd`;
  const so = `PO-FREE-${tag()}`;
  const { data: order } = await service.from("sales_orders").insert({ organization_id: org, so_number: so, customer_po: so, customer, total_value: 230, vat_enabled: true, vat_pct: 20, status: "open" }).select("id").single();
  const { data: made } = await service.from("sales_order_lines").insert([
    { organization_id: org, sales_order_id: order!.id, position: 0, description: "Bracket", quantity: 10, unit_price: 20, vat_pct: 20, vat_exempt: false },
    { organization_id: org, sales_order_id: order!.id, position: 1, description: "Plate", quantity: 2, unit_price: 15, vat_pct: 20, vat_exempt: false },
  ]).select("id, description");
  const id = (d: string) => made!.find((m) => m.description === d)!.id as string;
  const office = await signedInClient(w.tenants.alpha.users.office);
  const today = new Date().toISOString().slice(0, 10);
  const note = await office.rpc("create_delivery_note", { p_order: order!.id, p_job: null, p_ship_date: today, p_tax_date: today, p_ship_via: null, p_notes: null, p_lines: [{ line_id: id("Bracket"), quantity: 4 }, { line_id: id("Plate"), quantity: 2 }] });
  expect(note.error).toBeNull();
  expect((await office.from("delivery_notes").update({ status: "despatched" }).eq("id", note.data.id).select("id")).error).toBeNull();
  const draft = (await service.from("delivery_notes").select("invoice_id").eq("id", note.data.id).single()).data!.invoice_id as string;
  const linesOf = async () => (await service.from("invoice_line_items").select("description, quantity, sales_order_line_id, line_kind").eq("invoice_id", draft).order("position")).data;

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto(`/invoices?invoice=${draft}`);
  const details = page.getByRole("dialog", { name: /invoice details/ });
  await details.getByRole("button", { name: "Edit Draft" }).click();
  const editor = page.getByRole("dialog", { name: `Edit draft invoice for ${customer}` });
  await expect(editor.getByTestId("line-balance-1")).toBeVisible();
  // The plates are taken off (deleted) and the draft saved.
  await editor.getByRole("button", { name: "Remove line 2" }).click();
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft invoice updated")).toBeVisible();
  await expect.poll(linesOf).toEqual([{ description: "Bracket", quantity: 4, sales_order_line_id: id("Bracket"), line_kind: "order" }]);

  // Opened again: the 2 plates are despatched and not invoiced, offered to add; added, they keep their order link.
  await details.getByRole("button", { name: "Edit Draft" }).click();
  const offered = editor.getByTestId("despatched-not-invoiced");
  await expect(offered).toContainText("Plate: 2");
  await offered.getByRole("button", { name: "Add Plate" }).click();
  await expect(editor.getByTestId("line-balance-1")).toHaveText("Despatched 2 of 2, 0 on other invoices: up to 2 on this draft.");
  await editor.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft invoice updated")).toBeVisible();
  await expect.poll(linesOf).toEqual([
    { description: "Bracket", quantity: 4, sales_order_line_id: id("Bracket"), line_kind: "order" },
    { description: "Plate", quantity: 2, sales_order_line_id: id("Plate"), line_kind: "order" },
  ]);
  await expect.poll(async () => (await service.from("invoices").select("subtotal, vat, total").eq("id", draft).single()).data).toEqual({ subtotal: 110, vat: 22, total: 132 });
});
