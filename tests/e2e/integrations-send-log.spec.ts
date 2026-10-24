/**
 * Admin > Integrations (migration 084, G22, Xero PR 2): the send log shows each document by Tolra's number as sent, failed with Xero's
 * reason, waiting or not sent, with Retry on the failed one only (Retry is not clicked: it would need the second sign-in step). Office
 * is sent to the dashboard. Rows are put straight into company beta's send log (no Xero, no connection: nothing is sent) and removed again.
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

test("an admin sees the send log's states and Retry on a failed send; office is sent to the dashboard", async ({ page, browser }) => {
  const w = world();
  const beta = w.tenants.beta;
  const ref = (n: string) => `XERO-${w.runId}-${n}`.slice(0, 100);
  const rows = [
    { status: "sent", doc_ref: ref("S"), external_id: randomUUID(), external_number: ref("S"), sent_at: new Date().toISOString() },
    { status: "failed", doc_ref: ref("F"), last_error: "Xero refused it: Account code 200 is archived" },
    { status: "pending", doc_ref: ref("P") },
    { status: "skipped", doc_ref: ref("K"), last_error: "Disconnected before it was sent" },
  ].map((r) => ({ organization_id: beta.id, provider: "xero", doc_type: "invoice", doc_id: randomUUID(), action: "create", ...r }));
  const db = adminClient();
  expect((await db.from("integration_sends").insert(rows)).error).toBeNull();

  try {
    await signIn(page, beta.users.admin);
    await page.goto("/admin/integrations");
    const log = page.getByTestId("send-log");
    const row = (n: string) => log.getByTestId("send-log-row").filter({ hasText: `Invoice ${ref(n)}` });
    await expect(row("S")).toContainText("Sent");
    await expect(row("F")).toContainText("Failed");
    await expect(row("F")).toContainText("Account code 200 is archived");
    await expect(row("F").getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(row("S").getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(row("P")).toContainText("Waiting to send");
    await expect(row("K")).toContainText("Not sent");
    await expect(page.getByText("Not connected")).toBeVisible();

    const officePage = await browser.newPage();
    await signIn(officePage, beta.users.office);
    await officePage.goto("/admin/integrations");
    // The middleware sends a non-admin away from /admin before the page renders (as roles.spec.ts and data-import.spec.ts check).
    await expect(officePage).toHaveURL(/\/dashboard/);
    await officePage.close();
  } finally {
    await db.from("integration_sends").delete().in("doc_ref", rows.map((r) => r.doc_ref));
  }
});
