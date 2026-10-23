/**
 * Provider isolation (audit B1): the app server's Resend client is pointed at the local mock, so an e-mail the app
 * really sends is recorded there, and a refused recipient produces no provider call at all.
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

test("job e-mail to the job's customer is delivered to the mock provider only", async ({ page, baseURL }) => {
  const alpha = w.tenants.alpha;
  const customer = `Mail Customer ${w.runId}`;
  const recipient = `buyer.mail.${w.runId}@example.test`;
  const admin = adminClient();
  expect((await admin.from("customers").insert({ organization_id: alpha.id, name: customer, email: recipient })).error).toBeNull();
  const { data: job, error } = await admin.from("jobs").insert({ organization_id: alpha.id, job_no: `J-MAIL-${w.runId}`, customer }).select("id").single();
  expect(error).toBeNull();

  await signIn(page, alpha.users.office);
  const before = (await recorded()).length;
  const send = (to: string) => page.request.post("/api/send-job", {
    headers: { origin: baseURL! },
    data: { job_id: job!.id, recipient_email: to, subject: `Job ${w.runId}`, body: "Synthetic job e-mail." },
  });

  const refused = await send(`stranger.${w.runId}@example.test`);
  expect(refused.status()).toBe(403);
  expect((await recorded()).length).toBe(before);

  const sent = await send(recipient);
  expect(await sent.json()).toEqual({ status: "sent" });
  const emails = await recorded();
  expect(emails.length).toBe(before + 1);
  expect(emails.at(-1)?.body).toMatchObject({ to: recipient, subject: `Job ${w.runId}` });

  const { data: history } = await admin.from("email_history").select("status, to_email").eq("related_to_id", job!.id);
  expect(history).toEqual([{ status: "sent_via_system", to_email: recipient }]);
});

test("a repeated job e-mail request (same key) is sent once; the provider gets the key", async ({ page, baseURL }) => {
  const alpha = w.tenants.alpha;
  const customer = `Retry Customer ${w.runId}`;
  const recipient = `buyer.retry.${w.runId}@example.test`;
  const admin = adminClient();
  expect((await admin.from("customers").insert({ organization_id: alpha.id, name: customer, email: recipient })).error).toBeNull();
  const { data: job } = await admin.from("jobs").insert({ organization_id: alpha.id, job_no: `J-RETRY-${w.runId}`, customer }).select("id").single();

  await signIn(page, alpha.users.admin);
  const before = (await recorded()).length;
  const key = `retry-${w.runId}`.replace(/[^A-Za-z0-9-]/g, "-");
  const send = () => page.request.post("/api/send-job", {
    headers: { origin: baseURL! },
    data: { job_id: job!.id, recipient_email: recipient, subject: `Retry ${w.runId}`, body: "Synthetic.", idempotency_key: key },
  });
  const [first, second] = await Promise.all([send(), send()]);
  const statuses = [first.status(), second.status()].sort();
  // One request sends; the other either reports that send or says it is still in progress. Never two e-mails.
  expect(statuses[0]).toBe(200);
  expect([200, 409]).toContain(statuses[1]);
  expect(await send().then((r) => r.json())).toEqual({ status: "sent" });
  const emails = (await recorded()).slice(before);
  expect(emails).toHaveLength(1);
  expect(emails[0].idempotencyKey).toBe(`job-email/${key}`);
  const { count } = await admin.from("email_history").select("*", { count: "exact", head: true }).eq("related_to_id", job!.id);
  expect(count).toBe(1);
});

