import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { adminClient, createSoloTenant, signedInClient } from "../../support/fixtures";
import { browserDatabaseConfigured, NO_BROWSER_DATABASE } from "../../support/optional-browser-database";
import { signIn, world } from "../helpers";
import { E2E_MOCK_PORT } from "../paths";
test.skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE);
async function mailFor(address: string) {
  const result = await fetch(`http://127.0.0.1:${E2E_MOCK_PORT}/__emails`);
  return (await result.json() as Array<{ body: { to: unknown; subject: string; text: string } }>).filter(mail => JSON.stringify(mail.body.to).includes(address));
}
async function draft(page: Page, label: string) {
  const tenant = await createSoloTenant(world().runId, `v-${label}`);
  const address = `reviewer-${label}.${world().runId}@example.test`;
  const db = adminClient();
  expect((await db.from("customers").insert({ organization_id: tenant.id, name: "Example Customer A", email: address })).error).toBeNull();
  const invoice = await db.from("invoices").insert({ organization_id: tenant.id, invoice_ref: `REVIEWER-${label}`, customer: "Example Customer A", total: 120, subtotal: 100, vat: 20, amount_paid: 0, status: "sent", due_date: "2026-01-01" }).select("id").single(); expect(invoice.error).toBeNull();
  const subject = `reviewer-${label}: exact subject`;
  const body = "Hello Example Customer A,\n\nPlease check this fake invoice.\n\nThanks,\nTolra Test";
  const history = await db.from("email_history").insert({ organization_id: tenant.id, to_email: address, subject, body, status: "drafted", related_to_type: "invoice", related_to_id: invoice.data!.id }).select("id").single(); expect(history.error).toBeNull();
  expect((await db.from("chase_sends").insert({ organization_id: tenant.id, invoice_id: invoice.data!.id, offset_days: 7, tone: "friendly", status: "drafted", draft_history_id: history.data!.id })).error).toBeNull();
  await signIn(page, tenant.admin);
  return { tenant, address, subject, body, invoiceId: invoice.data!.id, historyId: history.data!.id };
}
const approve = (page: Page, data: { historyId: string; subject: string; body: string }) => page.request.post("/api/chase/approve", { data: { history_id: data.historyId, expected_subject: data.subject, expected_body: data.body } });

test("V-CHASE-EDIT: editing after review cancels approval and the new exact text is sent", async ({ page }) => {
  const data = await draft(page, "edit");
  const changed = `${data.body}\n\nA separately saved edit.`;
  expect((await adminClient().from("email_history").update({ body: changed }).eq("id", data.historyId)).error).toBeNull();
  expect((await approve(page, data)).status()).toBe(409);
  expect(await mailFor(data.address)).toHaveLength(0);
  expect((await approve(page, { ...data, body: changed })).status()).toBe(200);
  const mail = await mailFor(data.address); expect(mail).toHaveLength(1);
  expect(mail[0].body).toMatchObject({ subject: data.subject, text: changed });
});
test("V-CHASE-DOUBLE: two concurrent Sends make exactly one email with the approved text", async ({ page }) => {
  const data = await draft(page, "double");
  const replies = await Promise.all([approve(page, data), approve(page, data)]);
  expect(replies.filter(reply => reply.status() === 200)).toHaveLength(1);
  expect([404, 409]).toContain(replies.find(reply => reply.status() !== 200)!.status());
  const mail = await mailFor(data.address); expect(mail).toHaveLength(1);
  expect(mail[0].body).toMatchObject({ subject: data.subject, text: data.body });
});
test("V-CHASE-UNKNOWN: uncertain delivery stays needs-checking and retries never resend", async ({ page }) => {
  const data = await draft(page, "uncertain");
  expect((await approve(page, data)).status()).toBe(502);
  const row = await adminClient().from("email_history").select("status,subject,body").eq("id", data.historyId).single(); expect(row.error).toBeNull();
  expect(row.data).toEqual({ status: "unknown", subject: data.subject, body: data.body });
  // The "Needs checking" state is shown in the email log (/email), not the approval queue (which lists drafted emails only).
  await page.goto("/email"); await expect(page.locator("body")).toContainText(/needs checking/i);
  await expect(page.getByRole("row").filter({ hasText: data.subject })).toContainText(/needs checking/i);
  for (let click = 0; click < 3; click++) expect((await approve(page, data)).status()).toBe(409);
  const mail = await mailFor(data.address); expect(mail).toHaveLength(1);
  expect(mail[0].body).toMatchObject({ subject: data.subject, text: data.body });
});
test("V-INBOUND: a paid/payment-sent/remittance reply cannot pay the invoice in the real intake procedure", async ({ page }) => {
  const data = await draft(page, "inbound");
  const client = await signedInClient(data.tenant.admin);
  const read = () => adminClient().from("invoices").select("status,amount_paid,paid_at,payment_unverified,payment_claimed_at").eq("id", data.invoiceId).single();
  const before = await read(); expect(before.error).toBeNull();
  for (const text of ["Paid", "Remittance", "Payment sent"]) {
    const received = await client.rpc("record_inbound_email", { p_graph_message_id: randomUUID(), p_internet_message_id: `<${randomUUID()}@example.test>`, p_from_address: data.address, p_from_name: "Example Customer A", p_subject: `Re: REVIEWER-inbound ${text}`, p_received_at: new Date().toISOString(), p_body_preview: text, p_body_text: text });
    expect(received.error).toBeNull(); expect(received.data).toMatchObject({ inserted: true });
  }
  const after = await read(); expect(after.error).toBeNull(); expect(after.data).toEqual(before.data);
  const payments = await adminClient().from("invoice_payments").select("id").eq("invoice_id", data.invoiceId); expect(payments.error).toBeNull(); expect(payments.data).toEqual([]);
  const evidence = await client.from("inbound_emails").select("body_text").eq("organization_id", data.tenant.id).eq("from_address", data.address);
  expect(evidence.error).toBeNull(); expect(evidence.data?.map(row => row.body_text).sort()).toEqual(["Paid", "Payment sent", "Remittance"]);
});
