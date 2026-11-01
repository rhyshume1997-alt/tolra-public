/**
 * Two small flows added with Admin > Data PR1: the due date asked on Mark Accepted reaches the sales order and the job, and the job picker on
 * Create Invoice fills the customer, quote and PO, stores the job link, and lets go of the job when the customer is changed to another.
 * Everything is named from the run id, so runs and tenants stay apart.
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("Mark Accepted asks for a due date: it is the order's delivery date and the job's due date", async ({ page }) => {
  const tag = w.runId;
  const org = w.tenants.alpha.id;
  const customer = `Due Co ${tag}`;
  const ref = `QDUE-${tag}`;
  expect((await adminClient().from("customers").insert({ organization_id: org, name: customer })).error).toBeNull();
  const admin = await signedInClient(w.tenants.alpha.users.admin);
  expect((await admin.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: ref, customer, total_value: 120, vat_enabled: true, status: "sent", valid_until: "2099-12-31", description: "Due date" },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    // 4 x 25 = 100 net, plus 20% VAT = 120: the header total must equal the lines.
    p_lines: [{ position: 0, description: "Collar", quantity: 4, unit_price: 25, vat_pct: 20, vat_exempt: false }],
  })).error).toBeNull();

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/quotes");
  await page.locator('[data-slot="card"]', { hasText: ref }).getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog", { name: `${ref} quote details` }).getByRole("button", { name: "Mark Accepted" }).click();
  const confirm = page.getByRole("dialog", { name: `Mark ${ref} as accepted?` });
  await confirm.getByLabel("Due date").fill("2031-03-14");
  await page.getByRole("button", { name: "Confirm Accepted" }).click();

  const service = adminClient();
  const quote = (await service.from("quotes").select("id").eq("organization_id", org).eq("quote_ref", ref).single()).data!;
  await expect.poll(async () => ((await service.from("sales_orders").select("id").eq("quote_id", quote.id)).data ?? []).length).toBe(1);
  const order = (await service.from("sales_orders").select("id, delivery_date").eq("quote_id", quote.id).single()).data!;
  expect(order.delivery_date).toBe("2031-03-14");
  const jobs = (await service.from("jobs").select("job_no, due_date").eq("converted_from_sales_order_id", order.id)).data!;
  expect(jobs).toHaveLength(1);
  expect(jobs[0].due_date).toBe("2031-03-14");
});

test("Create Invoice: picking a job fills the customer, quote and PO and links the job; another customer lets go of it", async ({ page }) => {
  const tag = w.runId;
  const org = w.tenants.alpha.id;
  const service = adminClient();
  const [one, two] = [`Pick One ${tag} Ltd`, `Pick Two ${tag} Ltd`];
  expect((await service.from("customers").insert([{ organization_id: org, name: one }, { organization_id: org, name: two }])).error).toBeNull();
  const jobOne = (await service.from("jobs").insert({ organization_id: org, job_no: `J-JP1-${tag}`, customer: one, description: "First", quote_ref: `QUO-JP-${tag}`, customer_po: `PO-JP-${tag}` }).select("id, job_no").single()).data!;
  const jobTwo = (await service.from("jobs").insert({ organization_id: org, job_no: `J-JP2-${tag}`, customer: two, description: "Second" }).select("id, job_no").single()).data!;

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/invoices");
  await page.getByRole("button", { name: /New invoice/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create Invoice" });
  const customerSelect = dialog.locator("select[name=customer]");
  const jobSelect = dialog.locator("select[name=job]");
  const quoteInput = dialog.getByPlaceholder("Our quote no. (QUO-0123)");
  const poInput = dialog.getByPlaceholder("Customer PO", { exact: true });

  // The job is searched by its number; picking it fills the three fields from the job.
  await dialog.getByLabel("Search by number or customer").fill(jobOne.job_no);
  await jobSelect.selectOption({ label: `${jobOne.job_no} - ${one}` });
  await expect(customerSelect).toHaveValue(one);
  await expect(quoteInput).toHaveValue(`QUO-JP-${tag}`);
  await expect(poInput).toHaveValue(`PO-JP-${tag}`);

  // Another job: its customer, and the fields it has no value for are cleared, not left from the first job.
  await dialog.getByLabel("Search by number or customer").fill(jobTwo.job_no);
  await jobSelect.selectOption({ label: `${jobTwo.job_no} - ${two}` });
  await expect(customerSelect).toHaveValue(two);
  await expect(quoteInput).toHaveValue("");
  await expect(poInput).toHaveValue("");

  // The customer is changed to someone else: the job is let go of.
  await customerSelect.selectOption({ label: one });
  await expect(jobSelect).toHaveValue("");

  // Pick the first job again and save: the job link is stored with the quote and PO.
  await dialog.getByLabel("Search by number or customer").fill(jobOne.job_no);
  await jobSelect.selectOption({ label: `${jobOne.job_no} - ${one}` });
  await dialog.getByRole("textbox", { name: "Description" }).fill(`Picked job ${tag}`);
  await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("2");
  await dialog.getByRole("spinbutton", { name: "Unit price (ex VAT)" }).fill("40");
  await dialog.getByRole("button", { name: "Save Invoice" }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(async () => (await service.from("invoices").select("job_id, quote_ref, customer_po, customer").eq("organization_id", org).eq("customer", one).eq("description", `Picked job ${tag}`)).data)
    .toEqual([{ job_id: jobOne.id, quote_ref: `QUO-JP-${tag}`, customer_po: `PO-JP-${tag}`, customer: one }]);

  // An invoice saved with no job picked has no job link.
  await page.getByRole("button", { name: /New invoice/ }).first().click();
  await dialog.locator("select[name=customer]").selectOption({ label: two });
  await dialog.getByRole("textbox", { name: "Description" }).fill(`No job ${tag}`);
  await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("1");
  await dialog.getByRole("spinbutton", { name: "Unit price (ex VAT)" }).fill("10");
  await dialog.getByRole("button", { name: "Save Invoice" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await service.from("invoices").select("job_id").eq("organization_id", org).eq("description", `No job ${tag}`)).data).toEqual([{ job_id: null }]);
});
