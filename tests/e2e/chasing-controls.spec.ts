import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, createSoloTenant } from "../support/fixtures";
import { optionalBackendConfigured } from "../support/optional-backend";
import { signIn, world } from "./helpers";

test.skip(!optionalBackendConfigured(), "No disposable test database configured.");
let org: Awaited<ReturnType<typeof createSoloTenant>>;
let invoiceId: string;
let customerId: string;
let ref: string;

test.beforeEach(async ({ page }) => {
  const tag = randomUUID().slice(0, 8);
  org = await createSoloTenant(world().runId, `chase-ui-${tag}`);
  ref = `INV-UI-${tag}`;
  const db = adminClient();
  const customer = await db.from("customers").insert({ organization_id: org.id, name: `Chase UI ${tag}`, email: `chase.${tag}@example.test` }).select("id,name").single();
  expect(customer.error).toBeNull(); customerId = customer.data!.id;
  const invoice = await db.from("invoices").insert({ organization_id: org.id, invoice_ref: ref, customer: customer.data!.name, status: "sent", subtotal: 100, vat: 20, total: 120, amount_paid: 0, vat_enabled: true, due_date: "2026-01-01" }).select("id").single();
  expect(invoice.error).toBeNull(); invoiceId = invoice.data!.id;
  expect((await db.from("chase_steps").insert({ organization_id: org.id, offset_days: 7, tone: "friendly" })).error).toBeNull();
  await signIn(page, org.admin);
});
async function claimRow() {
  const result = await adminClient().from("invoices").select("payment_claimed_at,amount_paid,status").eq("id", invoiceId).single();
  expect(result.error).toBeNull(); return result.data!;
}
async function draft(page: Page) {
  await page.goto("/invoices");
  await page.getByRole("button", { name: "Chase All Overdue" }).click();
  await expect.poll(async () => (await adminClient().from("chase_sends").select("id").eq("invoice_id", invoiceId)).data?.length).toBe(1);
  await page.goto("/approval");
  await expect(page.getByRole("button", { name: "Approve and send" })).toBeVisible();
}

test("edit chase steps, save, and verify after reload", async ({ page }) => {
  await page.goto("/settings");
  const form = page.getByRole("form", { name: "Payment chasing settings" });
  await form.getByLabel("Days from due date — step 1").fill("10");
  await form.getByLabel("Tone — step 1").selectOption("firm");
  await form.getByRole("button", { name: "Save chase steps" }).click();
  await expect(form.getByRole("status")).toHaveText("Chase steps saved.");
  await page.reload();
  await expect(page.getByLabel("Days from due date — step 1")).toHaveValue("10");
  await expect(page.getByLabel("Tone — step 1")).toHaveValue("firm");
  expect((await adminClient().from("chase_steps").select("offset_days,tone").eq("organization_id", org.id)).data).toEqual([{ offset_days: 10, tone: "firm" }]);
});
test("skip preserves the draft and postpones it", async ({ page }) => {
  await draft(page); await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve and send" })).toHaveCount(0);
  const history = await adminClient().from("email_history").select("status,skipped_until").eq("organization_id", org.id).single();
  expect(history.error).toBeNull(); expect(history.data!.status).toBe("drafted");
  expect(Date.parse(history.data!.skipped_until)).toBeGreaterThan(Date.now());
});
test("pause customer persists and prevents approving its chase draft", async ({ page }) => {
  await draft(page); await page.getByRole("button", { name: "Pause chasing for this customer" }).click();
  await expect.poll(async () => (await adminClient().from("chase_pauses").select("customer_id").eq("organization_id", org.id)).data).toEqual([{ customer_id: customerId }]);
  await expect(page.getByRole("button", { name: "Approve and send" })).toBeEnabled();
  await page.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByText("Chasing is paused for this customer. Resume it first.", { exact: true })).toBeVisible();
  expect((await adminClient().from("chase_sends").select("status").eq("invoice_id", invoiceId)).data).toEqual([{ status: "drafted" }]);
});
test("customer says paid then not received clears only the claim", async ({ page }) => {
  await page.goto(`/invoices?invoice=${invoiceId}`);
  await page.getByRole("button", { name: "Customer says paid" }).click();
  await expect(page.getByText("Payment to confirm", { exact: true })).toBeVisible();
  expect((await claimRow()).amount_paid).toBe(0);
  await page.getByRole("button", { name: "Not received, resume chasing" }).click();
  await expect(page.getByRole("button", { name: "Customer says paid" })).toBeEnabled();
  expect(await claimRow()).toMatchObject({ payment_claimed_at: null, amount_paid: 0, status: "sent" });
});
test("confirm keeps the claim until a receipt is saved; cancelling does not mark paid", async ({ page }) => {
  await page.goto(`/invoices?invoice=${invoiceId}`);
  await page.getByRole("button", { name: "Customer says paid" }).click();
  await page.getByRole("button", { name: "Confirm payment received" }).click();
  let payment = page.getByRole("dialog", { name: `Record a payment on ${ref}` });
  await payment.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await claimRow()).payment_claimed_at).toBeTruthy();
  expect((await claimRow()).amount_paid).toBe(0);
  // Reloading also proves the outstanding claim is stored, not just local UI state.
  await page.reload();
  await page.getByRole("button", { name: "Confirm payment received" }).click();
  payment = page.getByRole("dialog", { name: `Record a payment on ${ref}` });
  await payment.getByLabel("Amount received (£)").fill("120.00");
  await payment.getByRole("button", { name: "Save payment", exact: true }).click();
  await expect.poll(claimRow).toMatchObject({ payment_claimed_at: null, amount_paid: 120, status: "paid" });
  expect((await adminClient().from("invoice_payments").select("amount").eq("invoice_id", invoiceId)).data).toEqual([{ amount: 120 }]);
});
