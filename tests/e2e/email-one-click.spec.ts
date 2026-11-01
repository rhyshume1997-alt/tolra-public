/**
 * E8: provider-agnostic one-click sending, on an issued invoice. The browser suite's server has Resend pointed at the local mock
 * provider and no Microsoft 365 connection, so the e-mail goes out through Resend (the mock records it) and the company's
 * e-mail_history row is 'sent_via_system'. A repeated request with the same idempotency key (the send ledger, migration 106) sends
 * and records nothing new. Workshop and viewer users are refused by the route and never see the invoices page.
 * Synthetic data only (tenant alpha); the world is read inside the tests, never at import.
 */
import { expect, test } from "@playwright/test";

import type { RecordedEmail } from "../support/mock-providers";
import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";
import { E2E_MOCK_PORT } from "./paths";

const w = world();

async function recorded(): Promise<RecordedEmail[]> {
  const response = await fetch(`http://127.0.0.1:${E2E_MOCK_PORT}/__emails`);
  return response.json();
}
const sentTo = async (address: string) => (await recorded()).filter((email) => JSON.stringify(email.body).includes(address));

/** An issued invoice with one line and a customer with an e-mail address on file. */
async function issuedInvoice(label: string) {
  const org = w.tenants.alpha.id;
  const customer = `OneClick ${label} ${w.runId} Ltd`;
  const email = `oneclick.${label}.${w.runId}@example.test`;
  const ref = `INV-OC-${label}-${w.runId}`;
  const service = adminClient();
  expect((await service.from("customers").insert({ organization_id: org, name: customer, email })).error).toBeNull();
  // Lines go on while it is a draft; once issued the lines are locked (019), so issue it last (the same order year-end.spec uses).
  const { data: invoice, error } = await service.from("invoices").insert({ organization_id: org, invoice_ref: null, customer, status: "draft", subtotal: 100, vat: 20, total: 120, vat_enabled: true, due_date: "2099-01-31", description: "Bush" }).select("id").single();
  expect(error).toBeNull();
  expect((await service.from("invoice_line_items").insert({ organization_id: org, invoice_id: invoice!.id, position: 0, description: "Bush", quantity: 1, unit_price: 100, vat_pct: 20 })).error).toBeNull();
  expect((await service.from("invoices").update({ invoice_ref: ref, status: "issued" }).eq("id", invoice!.id)).error).toBeNull();
  return { id: invoice!.id as string, ref, customer, email };
}

const history = async (id: string) => (await adminClient().from("email_history").select("status, to_email, related_to_type").eq("related_to_id", id)).data ?? [];

test("Email now on an issued invoice sends once through the provider and records one sent row", async ({ page }) => {
  const { id, ref, email } = await issuedInvoice("ui");
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog", { name: `${ref} invoice details` }).getByRole("button", { name: "Email now" }).click();

  const dialog = page.getByRole("dialog", { name: "Send by e-mail" });
  await expect(dialog).toBeVisible();
  // Prefilled from the customer on file, with the invoice template's subject.
  await expect(dialog.getByLabel("To", { exact: true })).toHaveValue(email);
  await expect(dialog.getByLabel("Subject")).toHaveValue(new RegExp(ref));
  // No PDF here: this proves the send path, not the PDF build (the PDF's own checks are unit tested).
  await dialog.getByLabel(/^Attach /).uncheck();
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Sent");

  expect(await sentTo(email)).toHaveLength(1);
  await expect.poll(() => history(id)).toEqual([{ status: "sent_via_system", to_email: email, related_to_type: "invoice" }]);
  // The invoice is recorded as sent once the e-mail has gone.
  await expect.poll(async () => Boolean((await adminClient().from("invoices").select("sent_date").eq("id", id).single()).data?.sent_date)).toBe(true);
});

test("a repeated send with the same key is answered from the ledger: one e-mail, one history row", async ({ page, baseURL }) => {
  const { id, email } = await issuedInvoice("ledger");
  await signIn(page, w.tenants.alpha.users.office);
  const key = `e2e-ledger-${w.runId}`;
  const send = () => page.request.post("/api/email/send", {
    headers: { origin: baseURL! },
    data: { kind: "invoice", record_id: id, to: [email], subject: `Ledger ${w.runId}`, text: "Synthetic invoice e-mail.", idempotency_key: key },
  });
  const first = await send();
  expect(first.status()).toBe(200);
  expect((await first.json()).status).toBe("sent");
  const second = await send();
  expect(second.status()).toBe(200);
  expect((await second.json()).status).toBe("sent");

  expect(await sentTo(email)).toHaveLength(1);
  expect(await history(id)).toHaveLength(1);
});

for (const role of ["workshop", "viewer"] as const) {
  test(`${role}: the send route refuses, nothing is recorded or sent, and the invoices page isn't open`, async ({ page, baseURL }) => {
    const { id, email } = await issuedInvoice(role);
    await signIn(page, w.tenants.alpha.users[role]);
    const response = await page.request.post("/api/email/send", {
      headers: { origin: baseURL! },
      data: { kind: "invoice", record_id: id, to: [email], subject: `Refused ${w.runId}`, text: "Synthetic invoice e-mail.", idempotency_key: `e2e-${role}-${w.runId}` },
    });
    expect(response.status()).toBe(403);
    expect(await sentTo(email)).toHaveLength(0);
    expect(await history(id)).toHaveLength(0);

    await page.goto("/invoices");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("button", { name: "Email now" })).toHaveCount(0);
  });
}
