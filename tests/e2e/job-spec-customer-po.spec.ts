/**
 * Migration 135 (provisional), the whole Customer PO journey: the job sheet names the customer's PO, "Customer PO <n>", never "Sales order".
 *   (a) The PO is entered on the QUOTE only: accepted in the browser, the job's customer_po is the quote's PO and the Job Board's
 *       specification and the printed job sheet show "Customer PO <n>". The fallback itself (an order with no PO whose quote has one,
 *       converted with Convert to Job) takes the quote's PO too.
 *   (b) The order has its own PO (the quote another): the job uses the order's, and still does after a reload of the Job Board and the
 *       printed sheet (never the quote's, never "Sales order").
 *   (c) No PO anywhere: no Customer PO line; the specification reads "Sales order <so_number>." as before and the job's customer_po is empty.
 * Its own company (createSoloTenant), fresh random quote, order and PO numbers on every run.
 */
import { randomInt, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { adminClient, createSoloTenant, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
let solo: Awaited<ReturnType<typeof createSoloTenant>>;

test.beforeAll(async () => {
  solo = await createSoloTenant(w.runId, `jspo-${randomUUID().slice(0, 6)}`);
});

/** Fresh numbers: QUO-<7 digits> (its job is J-<same digits>), and a PO / SO number with the run and a random part. */
const fresh = () => {
  const n = String(randomInt(1_000_000, 9_999_999));
  return { n, quoteRef: `QUO-${n}`, tag: `${w.runId}-${n}` };
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type QuoteLine = { position: number; description: string; quantity: number; unit_price: number; vat_pct: number; vat_exempt: boolean };
const LINES: QuoteLine[] = [{ position: 0, description: "Spacer 20mm", quantity: 4, unit_price: 25, vat_pct: 20, vat_exempt: false }];

/**
 * The quote's total as create_with_lines checks it (030, quote_total doesn't match: net + VAT when vat_enabled and the company is VAT
 * registered, as createSoloTenant's is): each line's net rounded to the penny, its VAT (unless exempt) rounded to the penny, summed.
 * Worked in whole pence (no float money) and sent as a "pounds.pence" string.
 */
function quoteTotal(lines: QuoteLine[]): string {
  let pence = 0;
  for (const line of lines) {
    const net = Math.round(line.quantity * Math.round(line.unit_price * 100));
    pence += net + (line.vat_exempt ? 0 : Math.round((net * line.vat_pct) / 100));
  }
  return `${Math.trunc(pence / 100)}.${String(pence % 100).padStart(2, "0")}`;
}

/** A quote of the solo company with one line, made as its admin through create_with_lines (as the app does). */
async function newQuote(quoteRef: string, customer: string, status: "sent" | "accepted", customerPo: string | null) {
  expect((await adminClient().from("customers").insert({ organization_id: solo.id, name: customer })).error).toBeNull();
  const client = await signedInClient(solo.admin);
  const { error } = await client.rpc("create_with_lines", {
    p_parent: "quotes",
    p_header: { quote_ref: quoteRef, customer, total_value: quoteTotal(LINES), vat_enabled: true, status, valid_until: "2099-12-31", description: "Spacers", customer_po: customerPo },
    p_child: "quote_line_items",
    p_fk: "quote_id",
    p_lines: LINES,
  });
  expect(error).toBeNull();
  const { data, error: readError } = await adminClient().from("quotes").select("id, customer_po").eq("quote_ref", quoteRef).eq("organization_id", solo.id).single();
  expect(readError).toBeNull();
  expect(data!.customer_po).toBe(customerPo);
  return data!.id as string;
}

/**
 * An open sales order for the quote, with or without its own PO, then Convert to Job on Sales Orders; returns the job made.
 * The row is found by the reference Sales Orders shows: the order's own customer PO when it has one (SO Ref follows the PO,
 * migration 058), otherwise its SO number.
 */
async function convertInBrowser(page: Page, quoteId: string, quoteRef: string, customer: string, soNumber: string, orderPo: string | null) {
  const { data: order, error } = await adminClient().from("sales_orders").insert({
    organization_id: solo.id, so_number: soNumber, customer_po: orderPo, customer, quote_id: quoteId, quote_ref: quoteRef, total_value: 100, status: "open", order_date: "2026-10-20",
  }).select("id").single();
  expect(error).toBeNull();
  await signIn(page, solo.admin);
  await page.goto("/sales-orders");
  await page.getByRole("row").filter({ hasText: orderPo ?? soNumber }).getByRole("button", { name: "Convert to Job" }).click();
  await page.waitForURL(/\/jobs\?job=/);
  const jobId = new URL(page.url()).searchParams.get("job")!;
  const { data: jobs } = await adminClient().from("jobs").select("id, job_no, customer_po, specification").eq("converted_from_sales_order_id", order!.id);
  expect(jobs).toHaveLength(1);
  expect(jobs![0].id).toBe(jobId);
  return jobs![0] as { id: string; job_no: string; customer_po: string | null; specification: string };
}

/** The Job Board row's specification and the printed job sheet both say "Customer PO <po>", and neither says "Sales order". */
async function expectCustomerPoShown(page: Page, job: { id: string; job_no: string }, po: string) {
  await page.goto(`/jobs?job=${job.id}`);
  const row = page.getByRole("row").filter({ hasText: job.job_no });
  await expect(row.getByText(`Customer PO ${po}`).filter({ visible: true })).toHaveCount(1);
  await expect(row).not.toContainText("Sales order");
  await page.goto(`/jobs/${job.id}/print`);
  const sheet = page.locator('[data-print-layout="basic"]');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(new RegExp(`Customer PO\\s*${escape(po)}`));
  await expect(sheet).not.toContainText("Sales order");
}

test("(a) PO on the quote only, accepted in the browser: the job's customer_po is the quote's and its sheet says Customer PO", async ({ page }) => {
  test.setTimeout(120_000);
  const { n, quoteRef, tag } = fresh();
  const po = `PO-Q-${tag}`;
  const customer = `Quote PO Co ${tag}`;
  const quoteId = await newQuote(quoteRef, customer, "sent", po);

  await signIn(page, solo.admin);
  await page.goto("/quotes");
  // As tests/e2e/quote-customer-po.spec.ts: the card in the Sent quotes section (Open is the default Show tab).
  await page.getByRole("region", { name: "Sent quotes" }).locator('[data-slot="card"]', { hasText: quoteRef }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${quoteRef} quote details` });
  await details.getByRole("button", { name: "Mark Accepted" }).click();
  const decision = page.getByRole("dialog", { name: `Mark ${quoteRef} as accepted?` });
  await expect(decision.getByLabel("Customer PO (optional)")).toHaveValue(po); // the quote's PO; nothing typed here
  await decision.getByRole("button", { name: "Confirm Accepted" }).click();

  const jobFor = async () => (await adminClient().from("jobs").select("id, job_no, customer_po, specification").eq("quote_id", quoteId).eq("organization_id", solo.id).maybeSingle()).data;
  await expect.poll(async () => (await jobFor())?.customer_po ?? null).toBe(po);
  const job = (await jobFor())!;
  expect(job.job_no).toBe(`J-${n}`);
  expect(job.specification.split("\n")[0]).toBe(`Customer PO ${po}.`);
  expect(job.specification).not.toContain("Sales order");
  await expectCustomerPoShown(page, job, po);
});

test("(a) fallback: an order with no PO whose quote has one converts to a job with the quote's PO", async ({ page }) => {
  test.setTimeout(120_000);
  const { quoteRef, tag } = fresh();
  const po = `PO-Q-${tag}`;
  const soNumber = `SO-E2E-${tag}`;
  const customer = `Fallback PO Co ${tag}`;
  const quoteId = await newQuote(quoteRef, customer, "accepted", po);

  const job = await convertInBrowser(page, quoteId, quoteRef, customer, soNumber, null);
  expect(job.customer_po).toBe(po);
  expect(job.specification.split("\n")[0]).toBe(`Customer PO ${po}.`);
  expect(job.specification).not.toContain("Sales order");
  expect(job.specification).not.toContain(soNumber);
  await expectCustomerPoShown(page, job, po);
});

test("(b) PO on the order: the job uses the order's PO, not the quote's", async ({ page }) => {
  test.setTimeout(120_000);
  const { quoteRef, tag } = fresh();
  const quotePo = `PO-Q-${tag}`;
  const orderPo = `PO-O-${tag}`;
  const soNumber = `SO-E2E-${tag}`;
  const customer = `Order PO Co ${tag}`;
  const quoteId = await newQuote(quoteRef, customer, "accepted", quotePo);

  const job = await convertInBrowser(page, quoteId, quoteRef, customer, soNumber, orderPo);
  expect(job.customer_po).toBe(orderPo);
  expect(job.specification.split("\n")[0]).toBe(`Customer PO ${orderPo}.`);
  expect(job.specification).not.toContain(quotePo);
  expect(job.specification).not.toContain("Sales order");
  await expectCustomerPoShown(page, job, orderPo);
  await expect(page.locator('[data-print-layout="basic"]')).not.toContainText(quotePo);

  // Conflicting POs after a reload: the job keeps the ORDER's PO (data, Job Board, printed sheet); never the quote's, never "Sales order".
  await page.goto(`/jobs?job=${job.id}`);
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: job.job_no });
  await expect(row.getByText(`Customer PO ${orderPo}`).filter({ visible: true })).toHaveCount(1);
  await expect(row).not.toContainText(quotePo);
  await expect(row).not.toContainText("Sales order");
  const { data: again, error: againError } = await adminClient().from("jobs").select("customer_po, specification").eq("id", job.id).single();
  expect(againError).toBeNull();
  expect(again!.customer_po).toBe(orderPo);
  expect(again!.specification.split("\n")[0]).toBe(`Customer PO ${orderPo}.`);
  await page.goto(`/jobs/${job.id}/print`);
  await page.reload();
  const sheet = page.locator('[data-print-layout="basic"]');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(new RegExp(`Customer PO\\s*${escape(orderPo)}`));
  await expect(sheet).not.toContainText(quotePo);
  await expect(sheet).not.toContainText("Sales order");
});

test("(c) no PO anywhere: no Customer PO line, the job's customer_po stays empty", async ({ page }) => {
  test.setTimeout(120_000);
  const { quoteRef, tag } = fresh();
  const soNumber = `SO-E2E-${tag}`;
  const customer = `No PO Co ${tag}`;
  const quoteId = await newQuote(quoteRef, customer, "accepted", null);

  const job = await convertInBrowser(page, quoteId, quoteRef, customer, soNumber, null);
  expect(job.customer_po).toBeNull();
  expect(job.specification.split("\n")[0]).toBe(`Sales order ${soNumber}.`);
  expect(job.specification).not.toContain("Customer PO");

  await page.goto(`/jobs?job=${job.id}`);
  const row = page.getByRole("row").filter({ hasText: job.job_no });
  await expect(row.getByText(`Sales order ${soNumber}`).filter({ visible: true })).toHaveCount(1);
  await expect(row).not.toContainText("Customer PO");
  await page.goto(`/jobs/${job.id}/print`);
  const sheet = page.locator('[data-print-layout="basic"]');
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toContainText(soNumber); // the PO box is empty: the order's number is not put in it
  await expect(sheet).not.toContainText(/Customer PO\s*PO-/);
});
